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
    it('reads the shared document first and merges one set into it, preserving other sets', async () => {
        // The document holds every group set's levels together, so saving
        // one set's levels must not erase another's -- exercised here by
        // asserting the written body actually contains both entries.
        const writes: unknown[] = []
        const fetcher = async (path: string, init?: RequestInit) => {
            const method = init?.method ?? 'GET'
            if (method === 'GET') {
                return json({ other: [1] })
            }
            writes.push(JSON.parse(init?.body as string))
            return json({}, 200)
        }
        await saveRequiredLevels(fetcher, 'own', [2, 3])
        expect(writes).toEqual([{ other: [1], own: [2, 3] }])
    })

    it('saveRequiredLevels writes directly when no document exists yet', async () => {
        const writes: unknown[] = []
        const fetcher = async (path: string, init?: RequestInit) => {
            const method = init?.method ?? 'GET'
            if (method === 'GET') {
                return notFound()
            }
            writes.push(JSON.parse(init?.body as string))
            return json({}, 200)
        }
        await saveRequiredLevels(fetcher, 'own', [2, 3])
        expect(writes).toEqual([{ own: [2, 3] }])
    })

    it('saveRequiredLevels rethrows a non-404 failure reading the current document, rather than treating it as absent', async () => {
        // Swallowing this the way loadConfig does would let the write that
        // follows erase every other group set's saved levels.
        const writes: unknown[] = []
        const fetcher = async (path: string, init?: RequestInit) => {
            const method = init?.method ?? 'GET'
            if (method === 'GET') {
                return new Response('forbidden', { status: 403 })
            }
            writes.push(JSON.parse(init?.body as string))
            return json({}, 200)
        }
        await expect(
            saveRequiredLevels(fetcher, 'own', [2, 3])
        ).rejects.toThrow()
        expect(writes).toEqual([])
    })

    it('saveCatchAllGroup writes the group id under the set id when no document exists yet', async () => {
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

    it('saveCatchAllGroup merges into the shared document, preserving other sets', async () => {
        const writes: unknown[] = []
        const fetcher = async (path: string, init?: RequestInit) => {
            const method = init?.method ?? 'GET'
            if (method === 'GET') {
                return json({ other: 'other-group' })
            }
            writes.push(JSON.parse(init?.body as string))
            return json({}, 200)
        }
        await saveCatchAllGroup(fetcher, 'own', 'catch-all-group')
        expect(writes).toEqual([
            { other: 'other-group', own: 'catch-all-group' },
        ])
    })

    it('saveCatchAllGroup rethrows a non-404 failure reading the current document, rather than treating it as absent', async () => {
        const writes: unknown[] = []
        const fetcher = async (path: string, init?: RequestInit) => {
            const method = init?.method ?? 'GET'
            if (method === 'GET') {
                return new Response('server error', { status: 500 })
            }
            writes.push(JSON.parse(init?.body as string))
            return json({}, 200)
        }
        await expect(
            saveCatchAllGroup(fetcher, 'own', 'catch-all-group')
        ).rejects.toThrow()
        expect(writes).toEqual([])
    })
})

describe('listChangeSets', () => {
    it('returns an empty list when the namespace does not exist yet', async () => {
        const fetcher = async () => notFound()
        expect(await listChangeSets(fetcher)).toEqual({
            changeSets: [],
            hasMore: false,
        })
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
        expect(result.changeSets.map((c) => c.id)).toEqual(['cs2', 'cs1'])
        expect(result.hasMore).toBe(false)
    })

    it('pages: fetches only the requested window of documents, and reports whether more remain', async () => {
        const ids = Array.from({ length: 5 }, (_, i) => `cs${i}`)
        const requested: string[] = []
        const fetcher = async (path: string) => {
            if (path.endsWith(`/${NAMESPACE}`)) {
                return json(ids.map((id) => `history-${id}`))
            }
            const match = /history-(cs\d)$/.exec(path)
            if (match) {
                requested.push(match[1])
                return json(changeSet(match[1], '2024-01-01T00:00:00.000Z'))
            }
            return notFound()
        }
        // Keys sort newest-first as cs4, cs3, cs2, cs1, cs0.
        const page = await listChangeSets(fetcher, { offset: 0, limit: 2 })
        expect(page.changeSets.map((c) => c.id)).toEqual(['cs4', 'cs3'])
        expect(page.hasMore).toBe(true)
        expect(requested.sort()).toEqual(['cs3', 'cs4'])

        const lastPage = await listChangeSets(fetcher, { offset: 4, limit: 2 })
        expect(lastPage.changeSets.map((c) => c.id)).toEqual(['cs0'])
        expect(lastPage.hasMore).toBe(false)
    })

    it('breaks a tie on createdAt deterministically by id, regardless of the order keys were listed in', async () => {
        // A plain "a.createdAt < b.createdAt ? 1 : -1" gives both a<b and
        // b<a as true when the timestamps are equal: an inconsistent
        // comparator, not merely an arbitrary one, whose result for a tie
        // then depends on the order the namespace happened to list its
        // keys in -- and so can differ between renders. A proper
        // comparator with an id tiebreak gives the same order regardless.
        const sameInstant = '2024-01-01T00:00:00.000Z'
        const first = changeSet('cs1', sameInstant)
        const second = changeSet('cs2', sameInstant)
        const fetcherWithKeyOrder =
            (keys: string[]) => async (path: string) => {
                if (path.endsWith(`/${NAMESPACE}`)) {
                    return json(keys)
                }
                if (path.endsWith('history-cs1')) {
                    return json(first)
                }
                if (path.endsWith('history-cs2')) {
                    return json(second)
                }
                return notFound()
            }
        const a = await listChangeSets(
            fetcherWithKeyOrder(['history-cs1', 'history-cs2'])
        )
        const b = await listChangeSets(
            fetcherWithKeyOrder(['history-cs2', 'history-cs1'])
        )
        expect(a.changeSets.map((c) => c.id)).toEqual(
            b.changeSets.map((c) => c.id)
        )
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
    it('writes and deletes a probe key to confirm write access, rather than inferring it from a read', async () => {
        const calls: string[] = []
        const fetcher = async (path: string, init?: RequestInit) => {
            calls.push(init?.method ?? 'GET')
            return json({}, 200)
        }
        await expect(canWriteDataStore(fetcher)).resolves.toBe(true)
        expect(calls).toEqual(['POST', 'DELETE'])
    })

    it('reports no write access when the probe write is forbidden, rather than throwing', async () => {
        const fetcher = async (path: string, init?: RequestInit) => {
            const method = init?.method ?? 'GET'
            if (method === 'POST') {
                return new Response('forbidden', { status: 403 })
            }
            return json({}, 200)
        }
        await expect(canWriteDataStore(fetcher)).resolves.toBe(false)
    })

    it('reports write access even when the probe key already existed (POST 409, falls back to PUT)', async () => {
        const fetcher = async (path: string, init?: RequestInit) => {
            const method = init?.method ?? 'GET'
            if (method === 'POST') {
                return new Response('{}', { status: 409 })
            }
            return json({}, 200)
        }
        await expect(canWriteDataStore(fetcher)).resolves.toBe(true)
    })

    it('reports write access even when the best-effort cleanup delete fails', async () => {
        const fetcher = async (path: string, init?: RequestInit) => {
            if ((init?.method ?? 'GET') === 'DELETE') {
                throw new Error('network down')
            }
            return json({}, 200)
        }
        await expect(canWriteDataStore(fetcher)).resolves.toBe(true)
    })

    it('reports no write access rather than throwing on a network failure during the write', async () => {
        const fetcher = async (path: string, init?: RequestInit) => {
            if ((init?.method ?? 'GET') === 'POST') {
                throw new Error('network down')
            }
            return json({}, 200)
        }
        await expect(canWriteDataStore(fetcher)).resolves.toBe(false)
    })
})
