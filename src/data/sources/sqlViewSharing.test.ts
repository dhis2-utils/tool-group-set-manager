import type { AdminSqlViewRow, RepairTarget } from './sqlViewSharing'
import {
    loadSqlViewSharing,
    repairExistingView,
    repairPatch,
    sameSql,
    saveSqlViewSharing,
    sharingBody,
    sharingMatches,
    sharingPatch,
} from './sqlViewSharing'

const respond = (status: number, body: unknown = {}) =>
    new Response(JSON.stringify(body), { status })

const GROUP = { kind: 'userGroup', userGroupId: 'ug1' } as const
const PUBLIC = { kind: 'public' } as const

describe('loadSqlViewSharing', () => {
    it('reads a missing setting as public, what every view had before the choice existed', async () => {
        await expect(
            loadSqlViewSharing(() => Promise.resolve(respond(404)))
        ).resolves.toEqual(PUBLIC)
    })

    it('reads a stored group choice', async () => {
        await expect(
            loadSqlViewSharing(() =>
                Promise.resolve(
                    respond(200, { kind: 'userGroup', userGroupId: 'ug1' })
                )
            )
        ).resolves.toEqual(GROUP)
    })

    // Defaulting to public on a failed read would let the next repair reopen
    // views an administrator restricted to one group.
    it('throws on any other failure rather than guessing public', async () => {
        await expect(
            loadSqlViewSharing(() => Promise.resolve(respond(500)))
        ).rejects.toThrow(/500/)
    })
})

describe('saveSqlViewSharing', () => {
    it('updates with PUT when the key already exists', async () => {
        const methods: (string | undefined)[] = []
        await saveSqlViewSharing((_path, init) => {
            methods.push(init?.method)
            return Promise.resolve(respond(methods.length === 1 ? 409 : 200))
        }, GROUP)
        expect(methods).toEqual(['POST', 'PUT'])
    })

    it('reports a refused save', async () => {
        await expect(
            saveSqlViewSharing(() => Promise.resolve(respond(403)), GROUP)
        ).rejects.toThrow(/403/)
    })
})

describe('sharingMatches', () => {
    it('public needs data read on the public string', () => {
        expect(sharingMatches(PUBLIC, { public: 'r-r-----' })).toBe(true)
        expect(sharingMatches(PUBLIC, { public: 'r-------' })).toBe(false)
        expect(sharingMatches(PUBLIC, undefined)).toBe(false)
    })

    it('group needs the group to read data, and the public not to', () => {
        const groupRead = {
            userGroups: { ug1: { id: 'ug1', access: 'r-r-----' } },
        }
        expect(
            sharingMatches(GROUP, { public: '--------', ...groupRead })
        ).toBe(true)
        // A public string that also reads data makes the restriction moot.
        expect(
            sharingMatches(GROUP, { public: 'r-r-----', ...groupRead })
        ).toBe(false)
        expect(sharingMatches(GROUP, { public: '--------' })).toBe(false)
    })
})

describe('sharingBody and sharingPatch', () => {
    it('shares with one group and nobody else', () => {
        expect(sharingBody(GROUP)).toEqual({
            public: '--------',
            userGroups: { ug1: { id: 'ug1', access: 'r-r-----' } },
        })
        expect(sharingPatch(GROUP)).toEqual([
            { op: 'replace', path: '/sharing/public', value: '--------' },
            {
                op: 'add',
                path: '/sharing/userGroups',
                value: { ug1: { id: 'ug1', access: 'r-r-----' } },
            },
        ])
    })

    it('public touches only the public string', () => {
        expect(sharingPatch(PUBLIC)).toEqual([
            { op: 'replace', path: '/sharing/public', value: 'r-r-----' },
        ])
    })
})

describe('sameSql', () => {
    it('ignores whitespace and a trailing semicolon', () => {
        expect(sameSql('select  a\n from b;', 'select a from b')).toBe(true)
        expect(sameSql('select a from c', 'select a from b')).toBe(false)
        expect(sameSql(undefined, 'select a from b')).toBe(false)
    })
})

const target: RepairTarget = {
    type: 'VIEW',
    sqlQuery: 'select uid from organisationunit',
    acceptQuery: (sql) => sameSql(sql, 'select uid from organisationunit'),
    sharing: PUBLIC,
}

const view = (patch: Partial<AdminSqlViewRow>): AdminSqlViewRow => ({
    id: 'v1',
    type: 'VIEW',
    sqlQuery: 'select uid from organisationunit',
    sharing: { public: 'r-r-----' },
    access: { data: { read: true } },
    ...patch,
})

describe('repairPatch', () => {
    it('is empty for a view that already matches', () => {
        expect(repairPatch(view({}), target)).toEqual({
            definition: [],
            sharing: [],
        })
    })

    it('sets a hand-edited query back', () => {
        expect(
            repairPatch(view({ sqlQuery: 'select 1' }), target).definition
        ).toEqual([
            {
                op: 'replace',
                path: '/sqlQuery',
                value: 'select uid from organisationunit',
            },
        ])
    })

    // Measured on 2.42.7: a materialised view patched to VIEW will not
    // execute (its database relation survives the drop) and its reads then
    // serve the old materialised rows. A QUERY runs live on every read.
    it('turns a materialised view into a query, not a view', () => {
        expect(
            repairPatch(view({ type: 'MATERIALIZED_VIEW' }), target).definition
        ).toEqual([{ op: 'replace', path: '/type', value: 'QUERY' }])
    })

    it('keeps a QUERY, which the app reads as it is', () => {
        expect(repairPatch(view({ type: 'QUERY' }), target).definition).toEqual(
            []
        )
    })
})

describe('repairExistingView', () => {
    const recorder = (statuses: Record<string, number>) => {
        const calls: string[] = []
        const fetcher = (path: string, init?: RequestInit) => {
            const key = `${init?.method ?? 'GET'} ${path}`
            calls.push(key)
            return Promise.resolve(respond(statuses[key] ?? 200))
        }
        return { calls, fetcher }
    }

    it('patches what differs, then executes', async () => {
        const { calls, fetcher } = recorder({})
        await repairExistingView(
            fetcher,
            view({ sharing: { public: 'r-------' } }),
            target
        )
        expect(calls).toEqual(['PATCH sqlViews/v1', 'POST sqlViews/v1/execute'])
    })

    it('does not execute a query, which has no database view', async () => {
        const { calls, fetcher } = recorder({})
        await repairExistingView(
            fetcher,
            view({ type: 'MATERIALIZED_VIEW' }),
            target
        )
        expect(calls).toEqual(['PATCH sqlViews/v1'])
    })

    it('reports a 403 on the patch as forbidden: another administrator owns it', async () => {
        const { fetcher } = recorder({ 'PATCH sqlViews/v1': 403 })
        await expect(
            repairExistingView(fetcher, view({ sqlQuery: 'x' }), target)
        ).rejects.toMatchObject({ reason: 'forbidden' })
    })

    it('reports a refused definition patch as a conflicting view', async () => {
        const { fetcher } = recorder({ 'PATCH sqlViews/v1': 409 })
        await expect(
            repairExistingView(fetcher, view({ sqlQuery: 'x' }), target)
        ).rejects.toMatchObject({ reason: 'conflicting' })
    })

    it('reports a view that still will not execute after its definition was patched as conflicting', async () => {
        const { fetcher } = recorder({ 'POST sqlViews/v1/execute': 409 })
        await expect(
            repairExistingView(fetcher, view({ sqlQuery: 'x' }), target)
        ).rejects.toMatchObject({ reason: 'conflicting' })
    })

    it('reports a 403 on execute as forbidden', async () => {
        const { fetcher } = recorder({ 'POST sqlViews/v1/execute': 403 })
        await expect(
            repairExistingView(fetcher, view({}), target)
        ).rejects.toMatchObject({ reason: 'forbidden' })
    })
})
