import { Fetcher } from './DataSource'
import { checkUsageView, installUsageView, removeUsageView } from './usageAdmin'
import { USAGE_SQL_CANDIDATES } from './usageSqlView'

const ok = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response
const created = (uid: string) =>
    ({
        ok: true,
        status: 201,
        json: async () => ({ response: { uid } }),
    }) as unknown as Response
const failed = (status: number) =>
    ({ ok: false, status, json: async () => ({}) }) as unknown as Response

describe('checkUsageView', () => {
    it('reports id null when no view carries the code', async () => {
        const fetcher = jest.fn(async () =>
            ok({ sqlViews: [] })
        ) as unknown as Fetcher
        await expect(checkUsageView(fetcher)).resolves.toEqual({
            id: null,
            type: undefined,
            readable: false,
            usable: false,
        })
    })

    it('refuses a materialised view, which would serve arbitrarily old counts', async () => {
        const fetcher = jest.fn(async () =>
            ok({
                sqlViews: [
                    {
                        id: 'v1',
                        code: 'GSI_GROUPSET_USAGE',
                        type: 'MATERIALIZED_VIEW',
                        access: { data: { read: true } },
                    },
                ],
            })
        ) as unknown as Fetcher
        const check = await checkUsageView(fetcher)
        expect(check).toMatchObject({ id: 'v1', usable: false })
    })

    it('is usable only once a real read of its data succeeds', async () => {
        const calls: string[] = []
        const fetcher = jest.fn(async (path: string) => {
            calls.push(path)
            if (path.startsWith('sqlViews?')) {
                return ok({
                    sqlViews: [
                        {
                            id: 'v1',
                            code: 'GSI_GROUPSET_USAGE',
                            type: 'VIEW',
                            access: { data: { read: true } },
                        },
                    ],
                })
            }
            return ok({ listGrid: { headers: [], rows: [] } })
        }) as unknown as Fetcher
        await expect(checkUsageView(fetcher)).resolves.toMatchObject({
            usable: true,
        })
        expect(calls[1]).toBe('sqlViews/v1/data.json?pageSize=1')
    })

    it('is not usable when the read probe fails, however healthy the metadata looks', async () => {
        const fetcher = jest.fn(async (path: string) =>
            path.startsWith('sqlViews?')
                ? ok({
                      sqlViews: [
                          {
                              id: 'v1',
                              code: 'GSI_GROUPSET_USAGE',
                              type: 'VIEW',
                              access: { data: { read: true } },
                          },
                      ],
                  })
                : failed(500)
        ) as unknown as Fetcher
        await expect(checkUsageView(fetcher)).resolves.toMatchObject({
            id: 'v1',
            readable: true,
            usable: false,
        })
    })
})

describe('installUsageView', () => {
    it('creates, executes and reads the first candidate, and reports its variant', async () => {
        const calls: { path: string; method?: string }[] = []
        const fetcher = jest.fn(async (path: string, init?: RequestInit) => {
            calls.push({ path, method: init?.method })
            if (path === 'sqlViews' && init?.method === 'POST') {
                return created('new1')
            }
            return ok({ listGrid: { headers: [], rows: [] } })
        }) as unknown as Fetcher
        const result = await installUsageView(fetcher, {
            id: null,
            type: undefined,
            readable: false,
            usable: false,
        })
        expect(result).toMatchObject({
            installed: true,
            variant: USAGE_SQL_CANDIDATES[0].variant,
            id: 'new1',
            failures: [],
        })
        expect(calls.map((c) => c.path)).toEqual([
            'sqlViews',
            'sqlViews/new1/execute',
            'sqlViews/new1/data.json?pageSize=1',
        ])
    })

    // Plan 7 Task 1: the same gap the GSI_* views had. Refusing
    // MATERIALIZED_VIEW (above) stops the *database* serving stale counts;
    // without this, the *browser* serves them instead -- for as long as the
    // instance's keyCacheStrategy says, a fortnight on a stock install.
    it('creates the view with NO_CACHE, so the browser cannot serve stale counts', async () => {
        let body: Record<string, unknown> | undefined
        const fetcher = jest.fn(async (path: string, init?: RequestInit) => {
            if (path === 'sqlViews' && init?.method === 'POST') {
                body = JSON.parse(String(init.body)) as Record<string, unknown>
                return created('new1')
            }
            return ok({ listGrid: { headers: [], rows: [] } })
        }) as unknown as Fetcher
        await installUsageView(fetcher, {
            id: null,
            type: undefined,
            readable: false,
            usable: false,
        })
        expect(body).toMatchObject({ cacheStrategy: 'NO_CACHE' })
    })

    it('deletes the view it just created when that view will not execute, then tries the next candidate', async () => {
        const calls: string[] = []
        let createCount = 0
        const fetcher = jest.fn(async (path: string, init?: RequestInit) => {
            calls.push(`${init?.method ?? 'GET'} ${path}`)
            if (path === 'sqlViews' && init?.method === 'POST') {
                createCount += 1
                return created(`new${createCount}`)
            }
            if (path === 'sqlViews/new1/execute') {
                return failed(409)
            }
            return ok({ listGrid: { headers: [], rows: [] } })
        }) as unknown as Fetcher
        const candidates = [
            { variant: 'first', sqlQuery: 'with a as (select 1) select 1' },
            { variant: 'second', sqlQuery: 'with b as (select 1) select 1' },
        ]
        const result = await installUsageView(
            fetcher,
            { id: null, type: undefined, readable: false, usable: false },
            candidates
        )
        expect(calls).toContain('DELETE sqlViews/new1')
        expect(result).toMatchObject({ installed: true, variant: 'second' })
        expect(result.failures).toHaveLength(1)
        expect(result.failures[0].variant).toBe('first')
    })

    it('reports every candidate failing rather than claiming a partial install', async () => {
        const fetcher = jest.fn(async (path: string, init?: RequestInit) =>
            path === 'sqlViews' && init?.method === 'POST'
                ? failed(409)
                : ok({})
        ) as unknown as Fetcher
        const result = await installUsageView(fetcher, {
            id: null,
            type: undefined,
            readable: false,
            usable: false,
        })
        expect(result.installed).toBe(false)
        expect(result.id).toBeNull()
        expect(result.failures).toHaveLength(USAGE_SQL_CANDIDATES.length)
    })

    it('re-executes an existing but unusable view instead of creating a second one', async () => {
        const calls: string[] = []
        const fetcher = jest.fn(async (path: string, init?: RequestInit) => {
            calls.push(`${init?.method ?? 'GET'} ${path}`)
            return ok({ listGrid: { headers: [], rows: [] } })
        }) as unknown as Fetcher
        const result = await installUsageView(fetcher, {
            id: 'old1',
            type: 'VIEW',
            readable: true,
            usable: false,
        })
        expect(calls).toEqual([
            'POST sqlViews/old1/execute',
            'GET sqlViews/old1/data.json?pageSize=1',
        ])
        expect(result).toMatchObject({ installed: true, id: 'old1' })
    })
})

describe('removeUsageView', () => {
    it('deletes by id and reports a refusal', async () => {
        const fetcher = jest.fn(async () => failed(403)) as unknown as Fetcher
        await expect(removeUsageView(fetcher, 'v1')).rejects.toThrow(/403/)
    })
})
