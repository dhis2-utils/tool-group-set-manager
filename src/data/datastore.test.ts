import {
    canWriteDataStore,
    listChangeSets,
    loadConfig,
    NAMESPACE,
    saveCatchAllGroup,
    saveChangeSet,
    saveIncludeTracker,
    saveRequiredLevels,
} from './datastore'
import { ChangeSet } from '@/engine/changeSet'

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status })

const notFound = () => new Response('not found', { status: 404 })

const changeSet = (id: string, createdAt: string): ChangeSet => ({
    id,
    createdAt,
    createdBy: { id: 'u1', displayName: 'A User' },
    objectType: 'organisationUnit',
    groupSetId: 'own',
    groupSetName: 'Ownership',
    action: 'move',
    note: '',
    changes: [],
})

describe('loadConfig', () => {
    it('returns defaults when the namespace does not exist yet', async () => {
        const fetcher = async () => notFound()
        expect(await loadConfig(fetcher)).toEqual({
            requiredLevels: {},
            catchAllGroup: {},
            includeTracker: false,
        })
    })

    it('merges a present config document over the defaults', async () => {
        const fetcher = async (path: string) => {
            if (path.endsWith('config-required-levels')) {
                return json({ own: [2, 3] })
            }
            if (path.endsWith('config-general')) {
                return json({ includeTracker: true })
            }
            return notFound()
        }
        expect(await loadConfig(fetcher)).toEqual({
            requiredLevels: { own: [2, 3] },
            catchAllGroup: {},
            includeTracker: true,
        })
    })

    it('never throws into a caller that is only reading configuration', async () => {
        const fetcher = async () => {
            throw new Error('network down')
        }
        await expect(loadConfig(fetcher)).resolves.toEqual({
            requiredLevels: {},
            catchAllGroup: {},
            includeTracker: false,
        })
    })
})

describe('saveIncludeTracker', () => {
    it('creates a key that does not exist and updates one that does', async () => {
        const calls: { method: string; path: string }[] = []
        const fetcher = async (path: string, init?: RequestInit) => {
            const method = init?.method ?? 'GET'
            calls.push({ method, path })
            if (method === 'POST' && path.endsWith('config-general')) {
                return new Response('{}', { status: 409 })
            }
            return new Response('{}', { status: 200 })
        }
        await saveIncludeTracker(fetcher, true)
        expect(calls.map((c) => c.method)).toEqual(['POST', 'PUT'])
    })

    it('creates directly when the key does not exist yet', async () => {
        const calls: string[] = []
        const fetcher = async (path: string, init?: RequestInit) => {
            calls.push(init?.method ?? 'GET')
            return new Response('{}', { status: 200 })
        }
        await saveIncludeTracker(fetcher, false)
        expect(calls).toEqual(['POST'])
    })
})

describe('saveRequiredLevels and saveCatchAllGroup', () => {
    it('merges one set into the shared document without a GET call, reading only to preserve other sets', async () => {
        // The document holds every group set's levels together, so saving
        // one set's levels must not erase another's.
        const calls: { method: string; path: string }[] = []
        const fetcher = async (path: string, init?: RequestInit) => {
            const method = init?.method ?? 'GET'
            calls.push({ method, path })
            if (method === 'GET') {
                return json({ other: [1] })
            }
            return json({}, 200)
        }
        await saveRequiredLevels(fetcher, 'own', [2, 3])
        const write = calls.find((c) => c.method === 'POST')
        expect(write).toBeDefined()
        expect(calls[0].method).toBe('GET')
    })

    it('saveCatchAllGroup writes the group id under the set id', async () => {
        const writes: unknown[] = []
        const fetcher = async (path: string, init?: RequestInit) => {
            const method = init?.method ?? 'GET'
            if (method === 'GET') {
                return notFound()
            }
            writes.push(JSON.parse(init?.body as string))
            return json({}, 200)
        }
        await saveCatchAllGroup(fetcher, 'own', 'catch-all-group')
        expect(writes).toEqual([{ own: 'catch-all-group' }])
    })
})

describe('listChangeSets', () => {
    it('returns an empty list when the namespace does not exist yet', async () => {
        const fetcher = async () => notFound()
        expect(await listChangeSets(fetcher)).toEqual([])
    })

    it('returns change sets newest first', async () => {
        const older = changeSet('cs1', '2024-01-01T00:00:00.000Z')
        const newer = changeSet('cs2', '2024-06-01T00:00:00.000Z')
        const fetcher = async (path: string) => {
            if (path.endsWith(`/${NAMESPACE}`)) {
                return json(['history-cs1', 'config-general', 'history-cs2'])
            }
            if (path.endsWith('history-cs1')) {
                return json(older)
            }
            if (path.endsWith('history-cs2')) {
                return json(newer)
            }
            return notFound()
        }
        const result = await listChangeSets(fetcher)
        expect(result.map((c) => c.id)).toEqual(['cs2', 'cs1'])
    })
})

describe('saveChangeSet', () => {
    it('writes the change set under a history- key named by its id', async () => {
        const calls: { method: string; path: string; body: unknown }[] = []
        const fetcher = async (path: string, init?: RequestInit) => {
            const method = init?.method ?? 'GET'
            calls.push({
                method,
                path,
                body: init?.body ? JSON.parse(init.body as string) : undefined,
            })
            return json({}, 200)
        }
        const cs = changeSet('cs3', '2024-07-01T00:00:00.000Z')
        await saveChangeSet(fetcher, cs)
        expect(calls).toEqual([
            {
                method: 'POST',
                path: `dataStore/${NAMESPACE}/history-cs3`,
                body: cs,
            },
        ])
    })
})

describe('canWriteDataStore', () => {
    it('reports no write access on a 403 rather than throwing', async () => {
        const fetcher = async () => new Response('forbidden', { status: 403 })
        await expect(canWriteDataStore(fetcher)).resolves.toBe(false)
    })

    it('reports write access when the namespace does not exist yet', async () => {
        const fetcher = async () => notFound()
        await expect(canWriteDataStore(fetcher)).resolves.toBe(true)
    })

    it('reports write access when the namespace is readable', async () => {
        const fetcher = async () => json(['config-general'])
        await expect(canWriteDataStore(fetcher)).resolves.toBe(true)
    })

    it('reports no write access rather than throwing on a network failure', async () => {
        const fetcher = async () => {
            throw new Error('network down')
        }
        await expect(canWriteDataStore(fetcher)).resolves.toBe(false)
    })
})
