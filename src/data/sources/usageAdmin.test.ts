import type { SqlViewSharing } from './sqlViewSharing'
import type { UsageViewCheck } from './usageAdmin'
import { checkUsageView, installUsageView, removeUsageView } from './usageAdmin'
import { USAGE_SQL_CANDIDATES, USAGE_SQL_VIEW_CODE } from './usageSqlView'

const respond = (status: number, body: unknown = {}) =>
    new Response(JSON.stringify(body), { status })

const PUBLIC: SqlViewSharing = { kind: 'public' }
const GROUP: SqlViewSharing = { kind: 'userGroup', userGroupId: 'ug1' }

const healthy = {
    id: 'v1',
    code: USAGE_SQL_VIEW_CODE,
    type: 'VIEW',
    sqlQuery: USAGE_SQL_CANDIDATES[0].sqlQuery,
    sharing: { public: 'r-r-----' },
    access: { data: { read: true } },
}

const MISSING: UsageViewCheck = {
    id: null,
    status: 'missing',
    usable: false,
    view: null,
}

/** Records every call as "METHOD path"; answers from `answer`, else 200 {}. */
const recorder = (
    answer: (key: string, init?: RequestInit) => Response | undefined = () =>
        undefined
) => {
    const calls: string[] = []
    const bodies: unknown[] = []
    const fetcher = (path: string, init?: RequestInit) => {
        const key = `${init?.method ?? 'GET'} ${path}`
        calls.push(key)
        if (init?.body) {
            bodies.push(JSON.parse(String(init.body)))
        }
        return Promise.resolve(answer(key, init) ?? respond(200))
    }
    return { calls, bodies, fetcher }
}

const createdAs =
    (uid: string) =>
    (key: string): Response | undefined =>
        key === 'POST sqlViews'
            ? respond(201, { response: { uid } })
            : undefined

describe('checkUsageView', () => {
    it('reports a missing view', async () => {
        const { fetcher } = recorder(() => respond(200, { sqlViews: [] }))
        await expect(checkUsageView(fetcher, PUBLIC)).resolves.toEqual(MISSING)
    })

    it('refuses a materialised view without reading it', async () => {
        const { calls, fetcher } = recorder((key) =>
            key.startsWith('GET sqlViews?')
                ? respond(200, {
                      sqlViews: [{ ...healthy, type: 'MATERIALIZED_VIEW' }],
                  })
                : undefined
        )
        const check = await checkUsageView(fetcher, PUBLIC)
        expect(check).toMatchObject({ id: 'v1', status: 'needsRepair' })
        expect(calls).toHaveLength(1)
    })

    it('is usable once a real read of its data succeeds', async () => {
        const { fetcher } = recorder((key) =>
            key.startsWith('GET sqlViews?')
                ? respond(200, { sqlViews: [healthy] })
                : undefined
        )
        await expect(checkUsageView(fetcher, PUBLIC)).resolves.toMatchObject({
            status: 'usable',
            usable: true,
        })
    })

    it('is not usable when the read fails, however healthy the metadata looks', async () => {
        const { fetcher } = recorder((key) =>
            key.startsWith('GET sqlViews?')
                ? respond(200, { sqlViews: [healthy] })
                : respond(500)
        )
        await expect(checkUsageView(fetcher, PUBLIC)).resolves.toMatchObject({
            status: 'needsRepair',
        })
    })

    it('judges the sharing against the choice, not this user’s own access', async () => {
        const { fetcher } = recorder((key) =>
            key.startsWith('GET sqlViews?')
                ? respond(200, { sqlViews: [healthy] })
                : undefined
        )
        await expect(checkUsageView(fetcher, GROUP)).resolves.toMatchObject({
            status: 'needsRepair',
        })
    })
})

describe('installUsageView', () => {
    it('creates, executes and reads the first candidate, with NO_CACHE and public data read', async () => {
        const { calls, bodies, fetcher } = recorder(createdAs('new1'))
        const result = await installUsageView(fetcher, MISSING, {
            sharing: PUBLIC,
        })
        expect(result).toMatchObject({
            installed: true,
            variant: USAGE_SQL_CANDIDATES[0].variant,
            failures: [],
        })
        expect(calls).toEqual([
            'POST sqlViews',
            'POST sqlViews/new1/execute',
            'GET sqlViews/new1?fields=access[data[read]]',
            'GET sqlViews/new1/data.json?pageSize=1',
        ])
        expect(bodies[0]).toMatchObject({
            type: 'VIEW',
            cacheStrategy: 'NO_CACHE',
            sharing: { public: 'r-r-----' },
        })
    })

    it('creates the view shared with only the chosen group', async () => {
        const { bodies, fetcher } = recorder(createdAs('new1'))
        await installUsageView(fetcher, MISSING, { sharing: GROUP })
        expect(bodies[0]).toMatchObject({
            sharing: {
                public: '--------',
                userGroups: { ug1: { id: 'ug1', access: 'r-r-----' } },
            },
        })
    })

    // An administrator outside the chosen group cannot read the rows, and
    // that says nothing about whether the install worked.
    it('does not read back a view this user may not read', async () => {
        const { calls, fetcher } = recorder(
            (key) =>
                createdAs('new1')(key) ??
                (key === 'GET sqlViews/new1?fields=access[data[read]]'
                    ? respond(200, { access: { data: { read: false } } })
                    : undefined)
        )
        const result = await installUsageView(fetcher, MISSING, {
            sharing: GROUP,
        })
        expect(result.installed).toBe(true)
        expect(calls).not.toContain('GET sqlViews/new1/data.json?pageSize=1')
    })

    it('deletes the view it just created when it will not execute, then tries the next candidate', async () => {
        let createCount = 0
        const { calls, fetcher } = recorder((key) => {
            if (key === 'POST sqlViews') {
                createCount += 1
                return respond(201, { response: { uid: `new${createCount}` } })
            }
            return key === 'POST sqlViews/new1/execute'
                ? respond(409)
                : undefined
        })
        const result = await installUsageView(fetcher, MISSING, {
            sharing: PUBLIC,
            candidates: [
                { variant: 'first', sqlQuery: 'select 1' },
                { variant: 'second', sqlQuery: 'select 2' },
            ],
        })
        expect(calls).toContain('DELETE sqlViews/new1')
        expect(result).toMatchObject({ installed: true, variant: 'second' })
        expect(result.failures.map((f) => f.variant)).toEqual(['first'])
    })

    it('reports every candidate failing rather than claiming a partial install', async () => {
        const { fetcher } = recorder((key) =>
            key === 'POST sqlViews' ? respond(409) : undefined
        )
        const result = await installUsageView(fetcher, MISSING, {
            sharing: PUBLIC,
        })
        expect(result.installed).toBe(false)
        expect(result.failures).toHaveLength(USAGE_SQL_CANDIDATES.length)
    })

    it('names the server reason when the read probe is refused, not just the status', async () => {
        const { fetcher } = recorder(
            (key) =>
                createdAs('new1')(key) ??
                (key === 'GET sqlViews/new1/data.json?pageSize=1'
                    ? respond(409, {
                          message:
                              'Current user is not authorised to read data from SQL view: `new1`',
                      })
                    : undefined)
        )
        const result = await installUsageView(fetcher, MISSING, {
            sharing: PUBLIC,
        })
        expect(result.installed).toBe(false)
        expect(result.failures[0].message).toBe(
            'The usage SQL view was created but cannot be read — HTTP 409 (Current user is not authorised to read data from SQL view: `new1`)'
        )
    })

    it('patches an existing view’s type, query and sharing back instead of creating a second one', async () => {
        const view = {
            ...healthy,
            type: 'MATERIALIZED_VIEW',
            sqlQuery: 'select 1',
            sharing: { public: 'r-------' },
        }
        const { calls, bodies, fetcher } = recorder()
        const result = await installUsageView(
            fetcher,
            { id: 'v1', status: 'needsRepair', usable: false, view },
            { sharing: PUBLIC }
        )
        expect(result).toMatchObject({ installed: true, variant: null })
        // A materialised view becomes a QUERY, which has nothing to execute.
        expect(calls).toEqual([
            'PATCH sqlViews/v1',
            'GET sqlViews/v1?fields=access[data[read]]',
            'GET sqlViews/v1/data.json?pageSize=1',
        ])
        expect(bodies[0]).toEqual([
            { op: 'replace', path: '/type', value: 'QUERY' },
            {
                op: 'replace',
                path: '/sqlQuery',
                value: USAGE_SQL_CANDIDATES[0].sqlQuery,
            },
            { op: 'replace', path: '/sharing/public', value: 'r-r-----' },
        ])
    })

    it('reports an existing view another administrator owns as forbidden', async () => {
        const { fetcher } = recorder((key) =>
            key === 'PATCH sqlViews/v1' ? respond(403) : undefined
        )
        const result = await installUsageView(
            fetcher,
            {
                id: 'v1',
                status: 'needsRepair',
                usable: false,
                view: { ...healthy, sharing: { public: 'r-------' } },
            },
            { sharing: PUBLIC }
        )
        expect(result.installed).toBe(false)
        expect(result.failures).toEqual([
            expect.objectContaining({
                variant: 'existing',
                reason: 'forbidden',
            }),
        ])
    })
})

describe('removeUsageView', () => {
    it('reports a 403 as forbidden', async () => {
        await expect(
            removeUsageView(() => Promise.resolve(respond(403)), 'v1')
        ).rejects.toMatchObject({ reason: 'forbidden' })
    })

    it('deletes the view by id and resolves when the server accepts', async () => {
        const { calls, fetcher } = recorder()
        await expect(removeUsageView(fetcher, 'v1')).resolves.toBeUndefined()
        expect(calls).toEqual(['DELETE sqlViews/v1'])
    })
})
