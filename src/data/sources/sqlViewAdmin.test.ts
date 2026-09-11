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
