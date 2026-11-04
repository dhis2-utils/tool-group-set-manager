import type { SqlViewCheck } from './sqlViewAdmin'
import {
    checkSqlViews,
    createOrRepairSqlViews,
    sqlViewAuthorities,
} from './sqlViewAdmin'
import type { AdminSqlViewRow, SqlViewSharing } from './sqlViewSharing'
import { SQL_VIEW_CODES, SQL_VIEW_DEFINITIONS } from './sqlViewSource'

const respond = (status: number, body: unknown = {}) =>
    new Response(JSON.stringify(body), { status })

const PUBLIC: SqlViewSharing = { kind: 'public' }
const GROUP: SqlViewSharing = { kind: 'userGroup', userGroupId: 'ug1' }

const defOf = (code: string) => {
    const def = SQL_VIEW_DEFINITIONS.find((d) => d.code === code)
    if (!def) {
        throw new Error(code)
    }
    return def
}

/** A view exactly as the app creates it, unless overridden. */
const row = (
    code: string,
    patch: Partial<AdminSqlViewRow> = {}
): AdminSqlViewRow => ({
    id: `id-${code}`,
    code,
    type: 'VIEW',
    sqlQuery: defOf(code).sqlQuery,
    sharing: { public: 'r-r-----' },
    access: { data: { read: true } },
    ...patch,
})

interface Call {
    method: string
    path: string
    body?: unknown
}

/**
 * A fake server: the lookup returns `views`, every read probe answers
 * `probe`, and other calls answer from `statuses` (default 200, and a uid
 * for a create).
 */
const server = ({
    views,
    probe = 200,
    statuses = {},
}: {
    views: AdminSqlViewRow[]
    probe?: number
    statuses?: Record<string, number>
}) => {
    const calls: Call[] = []
    // What a POST to /api/sharing set, answered back on the read-back.
    let sharingWritten: Record<string, unknown> | undefined
    const fetcher = (path: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        calls.push({
            method,
            path,
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
        })
        const key = `${method} ${path}`
        if (key in statuses) {
            return Promise.resolve(respond(statuses[key]))
        }
        if (path.startsWith('sqlViews?')) {
            return Promise.resolve(respond(200, { sqlViews: views }))
        }
        if (key.startsWith('GET sharing?')) {
            return Promise.resolve(
                respond(200, { object: { publicAccess: 'r-------' } })
            )
        }
        if (key.startsWith('POST sharing?')) {
            sharingWritten = (
                JSON.parse(String(init?.body)) as {
                    object: Record<string, unknown>
                }
            ).object
            return Promise.resolve(respond(200))
        }
        if (path.endsWith('?fields=sharing')) {
            const w = sharingWritten as {
                publicAccess?: string
                userGroupAccesses?: { id: string; access: string }[]
            }
            return Promise.resolve(
                respond(200, {
                    sharing: {
                        public: w?.publicAccess,
                        userGroups: Object.fromEntries(
                            (w?.userGroupAccesses ?? []).map((g) => [g.id, g])
                        ),
                    },
                })
            )
        }
        if (path.includes('/data.csv')) {
            return Promise.resolve(respond(probe))
        }
        if (key === 'POST sqlViews') {
            const body = JSON.parse(String(init?.body)) as { code: string }
            return Promise.resolve(
                respond(201, { response: { uid: `new-${body.code}` } })
            )
        }
        return Promise.resolve(respond(200))
    }
    return { calls, fetcher }
}

const ORGUNITS = SQL_VIEW_CODES.orgUnits
const statusOf = (checks: SqlViewCheck[], code: string) =>
    checks.find((c) => c.code === code)?.status

describe('checkSqlViews', () => {
    it('reports each of the three views as missing when the server has none', async () => {
        const { fetcher } = server({ views: [] })
        const checks = await checkSqlViews(fetcher, PUBLIC)
        expect(checks.map((c) => c.status)).toEqual([
            'missing',
            'missing',
            'missing',
        ])
    })

    it('asks the server for the query and the sharing too', async () => {
        const { calls, fetcher } = server({ views: [] })
        await checkSqlViews(fetcher, PUBLIC)
        expect(calls[0].path).toContain('sqlQuery')
        expect(calls[0].path).toContain('sharing')
    })

    it('is usable when type, query and sharing match and a real read succeeds', async () => {
        const { fetcher } = server({ views: [row(ORGUNITS)] })
        const checks = await checkSqlViews(fetcher, PUBLIC)
        expect(statusOf(checks, ORGUNITS)).toBe('usable')
        expect(checks.find((c) => c.code === ORGUNITS)?.usable).toBe(true)
    })

    // C1: metadata alone cannot tell an executed view from an orphaned one.
    it('needs repair when everything looks right but the read fails', async () => {
        const { fetcher } = server({ views: [row(ORGUNITS)], probe: 500 })
        expect(statusOf(await checkSqlViews(fetcher, PUBLIC), ORGUNITS)).toBe(
            'needsRepair'
        )
    })

    it('needs repair when materialised, without reading it', async () => {
        const { calls, fetcher } = server({
            views: [row(ORGUNITS, { type: 'MATERIALIZED_VIEW' })],
        })
        expect(statusOf(await checkSqlViews(fetcher, PUBLIC), ORGUNITS)).toBe(
            'needsRepair'
        )
        expect(calls.some((c) => c.path.includes('/data.csv'))).toBe(false)
    })

    it('needs repair when its query was changed', async () => {
        const { fetcher } = server({
            views: [row(ORGUNITS, { sqlQuery: 'select 1' })],
        })
        expect(statusOf(await checkSqlViews(fetcher, PUBLIC), ORGUNITS)).toBe(
            'needsRepair'
        )
    })

    // M7: a superuser reads every view whatever its sharing says, so the
    // current user's access is no measure of whether others can read it.
    it('needs repair when the sharing gives others no data read, even though this user can read it', async () => {
        const { fetcher } = server({
            views: [row(ORGUNITS, { sharing: { public: 'r-------' } })],
        })
        expect(statusOf(await checkSqlViews(fetcher, PUBLIC), ORGUNITS)).toBe(
            'needsRepair'
        )
    })

    it('needs repair when it is public but the choice is one user group', async () => {
        const { fetcher } = server({ views: [row(ORGUNITS)] })
        expect(statusOf(await checkSqlViews(fetcher, GROUP), ORGUNITS)).toBe(
            'needsRepair'
        )
    })

    it('says "not shared with you" when the sharing is the chosen group and this user is not in it', async () => {
        const { calls, fetcher } = server({
            views: [
                row(ORGUNITS, {
                    sharing: {
                        public: '--------',
                        userGroups: { ug1: { id: 'ug1', access: 'r-r-----' } },
                    },
                    access: { data: { read: false } },
                }),
            ],
        })
        expect(statusOf(await checkSqlViews(fetcher, GROUP), ORGUNITS)).toBe(
            'notSharedWithYou'
        )
        expect(calls.some((c) => c.path.includes('/data.csv'))).toBe(false)
    })
})

describe('sqlViewAuthorities', () => {
    const me = (authorities: string[]) => () =>
        Promise.resolve(respond(200, { authorities }))

    it('grants both to a superuser', async () => {
        await expect(sqlViewAuthorities(me(['ALL']))).resolves.toEqual({
            create: true,
            remove: true,
        })
    })

    it('reads create and delete separately', async () => {
        await expect(
            sqlViewAuthorities(me(['F_SQLVIEW_PUBLIC_ADD']))
        ).resolves.toEqual({ create: true, remove: false })
        await expect(
            sqlViewAuthorities(me(['F_SQLVIEW_DELETE']))
        ).resolves.toEqual({ create: false, remove: true })
    })

    it('returns null (unknown) when the check itself fails', async () => {
        await expect(
            sqlViewAuthorities(() => Promise.reject(new Error('offline')))
        ).resolves.toBeNull()
    })
})

const checksFor = (
    views: AdminSqlViewRow[],
    sharing: SqlViewSharing = PUBLIC,
    probe = 200
) => checkSqlViews(server({ views, probe }).fetcher, sharing)

describe('createOrRepairSqlViews', () => {
    it('skips views that are already usable', async () => {
        const views = SQL_VIEW_DEFINITIONS.map((d) => row(d.code))
        const checks = await checksFor(views)
        const { calls, fetcher } = server({ views })
        const result = await createOrRepairSqlViews(fetcher, checks, PUBLIC)
        expect(result).toEqual({ created: [], repaired: [], failed: [] })
        expect(calls).toEqual([])
    })

    it('creates then executes a missing view with NO_CACHE and public data read', async () => {
        const checks = await checksFor([])
        const { calls, fetcher } = server({ views: [] })
        const result = await createOrRepairSqlViews(fetcher, checks, PUBLIC)
        expect(result.created).toHaveLength(3)
        expect(calls[0]).toMatchObject({
            method: 'POST',
            path: 'sqlViews',
            body: {
                code: ORGUNITS,
                type: 'VIEW',
                cacheStrategy: 'NO_CACHE',
                sharing: { public: 'r-r-----' },
            },
        })
        expect(calls[1]).toMatchObject({
            method: 'POST',
            path: `sqlViews/new-${ORGUNITS}/execute`,
        })
    })

    it('creates a view shared with only the chosen group', async () => {
        const checks = await checksFor([], GROUP)
        const { calls, fetcher } = server({ views: [] })
        await createOrRepairSqlViews(fetcher, checks, GROUP)
        expect(calls[0].body).toMatchObject({
            sharing: {
                public: '--------',
                userGroups: { ug1: { id: 'ug1', access: 'r-r-----' } },
            },
        })
    })

    it('deletes a view it just created when its execute then fails', async () => {
        const checks = await checksFor([])
        const { calls, fetcher } = server({
            views: [],
            statuses: { [`POST sqlViews/new-${ORGUNITS}/execute`]: 500 },
        })
        const result = await createOrRepairSqlViews(fetcher, checks, PUBLIC)
        expect(result.failed.map((f) => f.code)).toEqual([ORGUNITS])
        expect(result.created).not.toContain(ORGUNITS)
        expect(calls).toContainEqual(
            expect.objectContaining({
                method: 'DELETE',
                path: `sqlViews/new-${ORGUNITS}`,
            })
        )
    })

    it('says a create refused for a duplicate code is a view hidden from this user', async () => {
        const checks = await checksFor([])
        const fetcher = (path: string, init?: RequestInit) =>
            Promise.resolve(
                init?.method === 'POST' && path === 'sqlViews'
                    ? respond(409, {
                          response: { errorReports: [{ errorCode: 'E5003' }] },
                      })
                    : respond(200)
            )
        const result = await createOrRepairSqlViews(fetcher, checks, PUBLIC)
        expect(result.failed.map((f) => f.reason)).toEqual([
            'hiddenDuplicate',
            'hiddenDuplicate',
            'hiddenDuplicate',
        ])
    })

    // M7: it used to only re-execute, and report a materialised view as
    // "Repaired" while it stayed unusable.
    it('patches a materialised view back to a readable type before reporting it repaired', async () => {
        const views = [row(ORGUNITS, { type: 'MATERIALIZED_VIEW' })]
        const checks = (await checksFor(views)).filter(
            (c) => c.code === ORGUNITS
        )
        const { calls, fetcher } = server({ views })
        const result = await createOrRepairSqlViews(fetcher, checks, PUBLIC)
        expect(result.repaired).toEqual([ORGUNITS])
        expect(calls).toEqual([
            {
                method: 'PATCH',
                path: `sqlViews/id-${ORGUNITS}`,
                body: [{ op: 'replace', path: '/type', value: 'QUERY' }],
            },
        ])
    })

    it('patches a changed query and the sharing back, then executes, never re-creating', async () => {
        const views = [
            row(ORGUNITS, {
                sqlQuery: 'select 1',
                sharing: { public: 'r-------' },
            }),
        ]
        const checks = (await checksFor(views)).filter(
            (c) => c.code === ORGUNITS
        )
        const { calls, fetcher } = server({ views })
        const result = await createOrRepairSqlViews(fetcher, checks, PUBLIC)
        expect(result.repaired).toEqual([ORGUNITS])
        expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
            `PATCH sqlViews/id-${ORGUNITS}`,
            `GET sharing?type=sqlView&id=id-${ORGUNITS}`,
            `POST sharing?type=sqlView&id=id-${ORGUNITS}`,
            `GET sqlViews/id-${ORGUNITS}?fields=sharing`,
            `POST sqlViews/id-${ORGUNITS}/execute`,
        ])
        expect(calls[0].body).toEqual([
            {
                op: 'replace',
                path: '/sqlQuery',
                value: defOf(ORGUNITS).sqlQuery,
            },
        ])
        expect(calls[2].body).toEqual({ object: { publicAccess: 'r-r-----' } })
    })

    it('re-executes an unreadable view whose metadata is right, without patching it', async () => {
        const views = [row(ORGUNITS)]
        const checks = (await checksFor(views, PUBLIC, 500)).filter(
            (c) => c.code === ORGUNITS
        )
        const { calls, fetcher } = server({ views })
        await createOrRepairSqlViews(fetcher, checks, PUBLIC)
        expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
            `POST sqlViews/id-${ORGUNITS}/execute`,
        ])
    })

    it('reports a view another administrator owns as forbidden, and never deletes it', async () => {
        const views = [row(ORGUNITS, { sharing: { public: 'r-------' } })]
        const checks = (await checksFor(views)).filter(
            (c) => c.code === ORGUNITS
        )
        const { calls, fetcher } = server({
            views,
            statuses: {
                [`GET sharing?type=sqlView&id=id-${ORGUNITS}`]: 403,
            },
        })
        const result = await createOrRepairSqlViews(fetcher, checks, PUBLIC)
        expect(result.failed).toEqual([
            expect.objectContaining({ code: ORGUNITS, reason: 'forbidden' }),
        ])
        expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
        expect(calls.some((c) => c.path.endsWith('/execute'))).toBe(false)
    })

    it('leaves a view that is right but not shared with this user alone', async () => {
        const views = [
            row(ORGUNITS, {
                sharing: {
                    public: '--------',
                    userGroups: { ug1: { id: 'ug1', access: 'r-r-----' } },
                },
                access: { data: { read: false } },
            }),
        ]
        const checks = (await checksFor(views, GROUP)).filter(
            (c) => c.code === ORGUNITS
        )
        const { calls, fetcher } = server({ views })
        const result = await createOrRepairSqlViews(fetcher, checks, GROUP)
        expect(result).toEqual({ created: [], repaired: [], failed: [] })
        expect(calls).toEqual([])
    })
})
