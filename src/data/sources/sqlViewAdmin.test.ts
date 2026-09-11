import {
    canCreateSqlViews,
    checkSqlViews,
    createOrRepairSqlViews,
    SqlViewCheck,
} from './sqlViewAdmin'
import { SQL_VIEW_CODES } from './sqlViewSource'

const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status })

describe('checkSqlViews', () => {
    it('reports each of the three views as missing when the server has none', async () => {
        const fetcher = async () => jsonResponse({ sqlViews: [] })
        const checks = await checkSqlViews(fetcher)
        expect(checks).toHaveLength(3)
        expect(checks.every((c) => c.id === null && !c.usable)).toBe(true)
    })

    it('reports a view as usable only when its code, type and read access all check out', async () => {
        const fetcher = async () =>
            jsonResponse({
                sqlViews: [
                    {
                        id: 'v1',
                        code: SQL_VIEW_CODES.orgUnits,
                        type: 'VIEW',
                        access: { data: { read: true } },
                    },
                ],
            })
        const checks = await checkSqlViews(fetcher)
        const orgUnits = checks.find((c) => c.code === SQL_VIEW_CODES.orgUnits)
        expect(orgUnits?.usable).toBe(true)
        expect(orgUnits?.id).toBe('v1')
    })

    it('reports an existing view with no read access as not usable', async () => {
        const fetcher = async () =>
            jsonResponse({
                sqlViews: [
                    {
                        id: 'v1',
                        code: SQL_VIEW_CODES.orgUnits,
                        type: 'VIEW',
                        access: { data: { read: false } },
                    },
                ],
            })
        const checks = await checkSqlViews(fetcher)
        const orgUnits = checks.find((c) => c.code === SQL_VIEW_CODES.orgUnits)
        expect(orgUnits?.id).toBe('v1')
        expect(orgUnits?.usable).toBe(false)
    })

    it('reports a materialized view as not usable', async () => {
        const fetcher = async () =>
            jsonResponse({
                sqlViews: [
                    {
                        id: 'v1',
                        code: SQL_VIEW_CODES.orgUnits,
                        type: 'MATERIALIZED_VIEW',
                        access: { data: { read: true } },
                    },
                ],
            })
        const checks = await checkSqlViews(fetcher)
        const orgUnits = checks.find((c) => c.code === SQL_VIEW_CODES.orgUnits)
        expect(orgUnits?.usable).toBe(false)
    })

    // C1: metadata alone cannot tell an executed view from an orphaned one
    // (a failed create-then-execute, or a view someone else created and
    // never ran) -- both pass every metadata field checked above.
    it('treats a metadata-eligible view as not usable when its data cannot actually be read (an orphaned, never-executed view)', async () => {
        const fetcher = async (path: string) => {
            if (path.startsWith('sqlViews?')) {
                return jsonResponse({
                    sqlViews: [
                        {
                            id: 'v1',
                            code: SQL_VIEW_CODES.orgUnits,
                            type: 'VIEW',
                            access: { data: { read: true } },
                        },
                    ],
                })
            }
            if (path.includes('/data.csv')) {
                return new Response('<html>500</html>', { status: 500 })
            }
            throw new Error(`unexpected call ${path}`)
        }
        const checks = await checkSqlViews(fetcher)
        const orgUnits = checks.find((c) => c.code === SQL_VIEW_CODES.orgUnits)
        expect(orgUnits?.id).toBe('v1')
        expect(orgUnits?.usable).toBe(false)
    })

    it('treats a metadata-eligible view as usable when its data can actually be read', async () => {
        const fetcher = async (path: string) => {
            if (path.startsWith('sqlViews?')) {
                return jsonResponse({
                    sqlViews: [
                        {
                            id: 'v1',
                            code: SQL_VIEW_CODES.orgUnits,
                            type: 'VIEW',
                            access: { data: { read: true } },
                        },
                    ],
                })
            }
            if (path.includes('/data.csv')) {
                return new Response('uid\nabc', { status: 200 })
            }
            throw new Error(`unexpected call ${path}`)
        }
        const checks = await checkSqlViews(fetcher)
        const orgUnits = checks.find((c) => c.code === SQL_VIEW_CODES.orgUnits)
        expect(orgUnits?.usable).toBe(true)
    })

    it('does not probe a view that already fails the metadata bar', async () => {
        const calls: string[] = []
        const fetcher = async (path: string) => {
            calls.push(path)
            if (path.startsWith('sqlViews?')) {
                return jsonResponse({
                    sqlViews: [
                        {
                            id: 'v1',
                            code: SQL_VIEW_CODES.orgUnits,
                            type: 'MATERIALIZED_VIEW',
                            access: { data: { read: true } },
                        },
                    ],
                })
            }
            throw new Error(`unexpected call ${path}`)
        }
        const checks = await checkSqlViews(fetcher)
        expect(
            checks.find((c) => c.code === SQL_VIEW_CODES.orgUnits)?.usable
        ).toBe(false)
        expect(calls.some((p) => p.includes('/data.csv'))).toBe(false)
    })
})

describe('canCreateSqlViews', () => {
    it('returns true for a superuser (ALL authority)', async () => {
        const fetcher = async () => jsonResponse({ authorities: ['ALL'] })
        expect(await canCreateSqlViews(fetcher)).toBe(true)
    })

    it('returns true for a user with the specific SQL view create authority', async () => {
        const fetcher = async () =>
            jsonResponse({ authorities: ['F_SQLVIEW_PUBLIC_ADD'] })
        expect(await canCreateSqlViews(fetcher)).toBe(true)
    })

    it('returns false for a user with neither authority', async () => {
        const fetcher = async () =>
            jsonResponse({ authorities: ['F_SOMETHING_ELSE'] })
        expect(await canCreateSqlViews(fetcher)).toBe(false)
    })

    it('returns null (unknown) when the authority check itself fails', async () => {
        const fetcher = async () => {
            throw new Error('network down')
        }
        expect(await canCreateSqlViews(fetcher)).toBeNull()
    })
})

describe('createOrRepairSqlViews', () => {
    const missingChecks = (): SqlViewCheck[] => [
        {
            code: SQL_VIEW_CODES.orgUnits,
            name: 'a',
            id: null,
            type: undefined,
            readable: false,
            usable: false,
        },
        {
            code: SQL_VIEW_CODES.orgUnitNames,
            name: 'b',
            id: null,
            type: undefined,
            readable: false,
            usable: false,
        },
        {
            code: SQL_VIEW_CODES.orgUnitMemberships,
            name: 'c',
            id: null,
            type: undefined,
            readable: false,
            usable: false,
        },
    ]

    it('skips a view that is already usable', async () => {
        const calls: string[] = []
        const fetcher = async (path: string) => {
            calls.push(path)
            return jsonResponse({})
        }
        const checks: SqlViewCheck[] = [
            {
                code: SQL_VIEW_CODES.orgUnits,
                name: 'a',
                id: 'v1',
                type: 'VIEW',
                readable: true,
                usable: true,
            },
        ]
        const result = await createOrRepairSqlViews(fetcher, checks)
        expect(calls).toEqual([])
        expect(result).toEqual({ created: [], repaired: [], failed: [] })
    })

    it('creates then executes a missing view, in that order, and reports it as created', async () => {
        const calls: { path: string; method?: string }[] = []
        const fetcher = async (path: string, init?: RequestInit) => {
            calls.push({ path, method: init?.method })
            if (init?.method === 'POST' && path === 'sqlViews') {
                return jsonResponse({ response: { uid: 'newId1' } }, 201)
            }
            if (init?.method === 'POST' && path === 'sqlViews/newId1/execute') {
                return jsonResponse({ status: 'OK' }, 201)
            }
            throw new Error(`unexpected call ${path}`)
        }
        const result = await createOrRepairSqlViews(fetcher, [
            missingChecks()[0],
        ])
        expect(calls.map((c) => c.path)).toEqual([
            'sqlViews',
            'sqlViews/newId1/execute',
        ])
        expect(result).toEqual({
            created: [SQL_VIEW_CODES.orgUnits],
            repaired: [],
            failed: [],
        })
    })

    it('treats a failed execute as a failed creation, not a partial success', async () => {
        const fetcher = async (path: string, init?: RequestInit) => {
            if (init?.method === 'POST' && path === 'sqlViews') {
                return jsonResponse({ response: { uid: 'newId1' } }, 201)
            }
            if (init?.method === 'POST' && path === 'sqlViews/newId1/execute') {
                return new Response('<html>500</html>', { status: 500 })
            }
            throw new Error(`unexpected call ${path}`)
        }
        const result = await createOrRepairSqlViews(fetcher, [
            missingChecks()[0],
        ])
        expect(result.created).toEqual([])
        expect(result.failed).toHaveLength(1)
        expect(result.failed[0].code).toBe(SQL_VIEW_CODES.orgUnits)
    })

    // C1: a failed execute must not leave the just-created view behind for
    // findSqlViews/checkSqlViews to later accept as usable.
    it('deletes a view it just created when its execute then fails, restoring the pre-click state', async () => {
        const calls: { path: string; method?: string }[] = []
        const fetcher = async (path: string, init?: RequestInit) => {
            calls.push({ path, method: init?.method })
            if (init?.method === 'POST' && path === 'sqlViews') {
                return jsonResponse({ response: { uid: 'newId1' } }, 201)
            }
            if (init?.method === 'POST' && path === 'sqlViews/newId1/execute') {
                return new Response('<html>500</html>', { status: 500 })
            }
            if (init?.method === 'DELETE' && path === 'sqlViews/newId1') {
                return new Response('', { status: 200 })
            }
            throw new Error(`unexpected call ${path}`)
        }
        const result = await createOrRepairSqlViews(fetcher, [
            missingChecks()[0],
        ])
        expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
            'POST sqlViews',
            'POST sqlViews/newId1/execute',
            'DELETE sqlViews/newId1',
        ])
        expect(result.created).toEqual([])
        expect(result.failed).toHaveLength(1)
    })

    // D3: repair never deletes -- a re-execute failure on a view this call
    // did not create must leave that view exactly as it was, not remove it.
    it('does not delete an existing view when its repair re-execute fails', async () => {
        const calls: { path: string; method?: string }[] = []
        const fetcher = async (path: string, init?: RequestInit) => {
            calls.push({ path, method: init?.method })
            if (
                init?.method === 'POST' &&
                path === 'sqlViews/existingId/execute'
            ) {
                return new Response('<html>500</html>', { status: 500 })
            }
            throw new Error(`unexpected call ${path}`)
        }
        const check: SqlViewCheck = {
            code: SQL_VIEW_CODES.orgUnits,
            name: 'a',
            id: 'existingId',
            type: 'VIEW',
            readable: false,
            usable: false,
        }
        const result = await createOrRepairSqlViews(fetcher, [check])
        expect(calls).toEqual([
            { path: 'sqlViews/existingId/execute', method: 'POST' },
        ])
        expect(result.repaired).toEqual([])
        expect(result.failed).toHaveLength(1)
    })

    it('repairs an existing-but-unusable view by re-executing it, never re-creating', async () => {
        const calls: { path: string; method?: string }[] = []
        const fetcher = async (path: string, init?: RequestInit) => {
            calls.push({ path, method: init?.method })
            if (
                init?.method === 'POST' &&
                path === 'sqlViews/existingId/execute'
            ) {
                return jsonResponse({ status: 'OK' }, 201)
            }
            throw new Error(`unexpected call ${path}`)
        }
        const check: SqlViewCheck = {
            code: SQL_VIEW_CODES.orgUnits,
            name: 'a',
            id: 'existingId',
            type: 'VIEW',
            readable: false,
            usable: false,
        }
        const result = await createOrRepairSqlViews(fetcher, [check])
        expect(calls).toEqual([
            { path: 'sqlViews/existingId/execute', method: 'POST' },
        ])
        expect(result).toEqual({
            created: [],
            repaired: [SQL_VIEW_CODES.orgUnits],
            failed: [],
        })
    })
})
