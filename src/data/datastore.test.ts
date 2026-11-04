import {
    clearCatchAllGroup,
    listChangeSets,
    loadConfig,
    NAMESPACE,
    saveCatchAllGroup,
    saveChangeSet,
    saveIncludeTracker,
} from './datastore'
import type { ChangeSet } from '@/engine/changeSet'

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
        const fetcher = () => Promise.resolve(notFound())
        expect(await loadConfig(fetcher)).toEqual({
            catchAllGroup: {},
            includeTracker: false,
        })
    })

    it('merges a present config document over the defaults', async () => {
        const fetcher = (path: string) => {
            if (path.endsWith('config-catch-all')) {
                return Promise.resolve(json({ own: 'catch-all-group' }))
            }
            if (path.endsWith('config-general')) {
                return Promise.resolve(json({ includeTracker: true }))
            }
            return Promise.resolve(notFound())
        }
        expect(await loadConfig(fetcher)).toEqual({
            catchAllGroup: { own: 'catch-all-group' },
            includeTracker: true,
        })
    })

    it('never throws into a caller that is only reading configuration', async () => {
        const fetcher = () => {
            return Promise.reject(new Error('network down'))
        }
        await expect(loadConfig(fetcher)).resolves.toEqual({
            catchAllGroup: {},
            includeTracker: false,
        })
    })

    // Spec 2026-09-15 §2.3: the dataStore document survives on instances that
    // already have one, but the app neither reads it nor writes it. Deleting a
    // user's stored data as a side effect of an upgrade is worse than leaving
    // orphaned keys, and leaving them keeps a downgrade working.
    it('never requests the required-levels document', async () => {
        const fetcher = jest.fn().mockResolvedValue(notFound())
        await loadConfig(fetcher as never)
        const requested = fetcher.mock.calls.map((c) => String(c[0]))
        expect(
            requested.some((u) => u.includes('config-required-levels'))
        ).toBe(false)
    })
})

describe('saveIncludeTracker', () => {
    it('creates a key that does not exist and updates one that does', async () => {
        const calls: { method: string; path: string }[] = []
        const fetcher = (path: string, init?: RequestInit) => {
            const method = init?.method ?? 'GET'
            calls.push({ method, path })
            if (method === 'POST' && path.endsWith('config-general')) {
                return Promise.resolve(new Response('{}', { status: 409 }))
            }
            return Promise.resolve(new Response('{}', { status: 200 }))
        }
        await saveIncludeTracker(fetcher, true)
        expect(calls.map((c) => c.method)).toEqual(['POST', 'PUT'])
    })

    it('creates directly when the key does not exist yet', async () => {
        const calls: string[] = []
        const fetcher = (path: string, init?: RequestInit) => {
            calls.push(init?.method ?? 'GET')
            return Promise.resolve(new Response('{}', { status: 200 }))
        }
        await saveIncludeTracker(fetcher, false)
        expect(calls).toEqual(['POST'])
    })
})

describe('catch-all group configuration', () => {
    const recordingFetcher = (
        documents: Record<string, unknown>,
        overrides: Partial<Record<string, Response>> = {}
    ) => {
        const writes: { method: string; path: string; body: unknown }[] = []
        const fetcher = (path: string, init?: RequestInit) => {
            const method = init?.method ?? 'GET'
            const key = path.slice(`dataStore/${NAMESPACE}/`.length)
            const override = overrides[`${method} ${key}`]
            if (override) {
                return Promise.resolve(override)
            }
            if (method === 'GET') {
                if (path === `dataStore/${NAMESPACE}`) {
                    return Promise.resolve(json(Object.keys(documents)))
                }
                return Promise.resolve(
                    key in documents ? json(documents[key]) : notFound()
                )
            }
            writes.push({
                method,
                path: key,
                body: init?.body ? JSON.parse(init.body as string) : undefined,
            })
            return Promise.resolve(json({}, 200))
        }
        return { fetcher, writes }
    }

    it('saves one set under its own key, never reading or writing the shared document', async () => {
        const { fetcher, writes } = recordingFetcher({
            'config-catch-all': { other: 'other-group' },
        })
        await saveCatchAllGroup(fetcher, 'own', 'catch-all-group')
        expect(writes).toEqual([
            {
                method: 'POST',
                path: 'config-catch-all-own',
                body: { groupId: 'catch-all-group' },
            },
        ])
    })

    it('two sets saved at the same moment both survive, since neither rewrites a shared document', async () => {
        const store: Record<string, unknown> = {}
        const fetcher = (path: string, init?: RequestInit) => {
            const method = init?.method ?? 'GET'
            const key = path.slice(`dataStore/${NAMESPACE}/`.length)
            if (method === 'GET') {
                if (path === `dataStore/${NAMESPACE}`) {
                    return Promise.resolve(json(Object.keys(store)))
                }
                return Promise.resolve(
                    key in store ? json(store[key]) : notFound()
                )
            }
            store[key] = JSON.parse(init?.body as string)
            return Promise.resolve(json({}, 200))
        }
        await Promise.all([
            saveCatchAllGroup(fetcher, 'own', 'g-own'),
            saveCatchAllGroup(fetcher, 'type', 'g-type'),
        ])
        expect((await loadConfig(fetcher)).catchAllGroup).toEqual({
            own: 'g-own',
            type: 'g-type',
        })
    })

    it('reads the shared document an earlier version wrote, with per-set keys winning over it', async () => {
        const { fetcher } = recordingFetcher({
            'config-catch-all': { own: 'old', other: 'other-group' },
            'config-catch-all-own': { groupId: 'new' },
            'config-catch-all-cleared': { groupId: null },
        })
        expect((await loadConfig(fetcher)).catchAllGroup).toEqual({
            own: 'new',
            other: 'other-group',
        })
    })

    it('a tombstone hides the shared document entry it overrides', async () => {
        const { fetcher } = recordingFetcher({
            'config-catch-all': { own: 'old' },
            'config-catch-all-own': { groupId: null },
        })
        expect((await loadConfig(fetcher)).catchAllGroup).toEqual({})
    })

    it('clearing a set the shared document names writes a tombstone, leaving the shared document alone', async () => {
        const { fetcher, writes } = recordingFetcher({
            'config-catch-all': { own: 'old', other: 'other-group' },
        })
        await clearCatchAllGroup(fetcher, 'own')
        expect(writes).toEqual([
            {
                method: 'POST',
                path: 'config-catch-all-own',
                body: { groupId: null },
            },
        ])
    })

    it('clearing a set the shared document does not name deletes its key', async () => {
        const { fetcher, writes } = recordingFetcher({
            'config-catch-all-own': { groupId: 'g' },
        })
        await clearCatchAllGroup(fetcher, 'own')
        expect(writes).toEqual([
            { method: 'DELETE', path: 'config-catch-all-own', body: undefined },
        ])
    })

    it('clearing a set that has no key at all succeeds', async () => {
        const { fetcher } = recordingFetcher(
            {},
            { 'DELETE config-catch-all-own': notFound() }
        )
        await expect(
            clearCatchAllGroup(fetcher, 'own')
        ).resolves.toBeUndefined()
    })

    it('clearing rethrows a non-404 failure reading the shared document, rather than skipping the tombstone', async () => {
        const { fetcher, writes } = recordingFetcher(
            {},
            {
                'GET config-catch-all': new Response('server error', {
                    status: 500,
                }),
            }
        )
        await expect(clearCatchAllGroup(fetcher, 'own')).rejects.toThrow()
        expect(writes).toEqual([])
    })
})

describe('listChangeSets', () => {
    it('returns an empty list when the namespace does not exist yet', async () => {
        const fetcher = () => Promise.resolve(notFound())
        expect(await listChangeSets(fetcher)).toEqual({
            changeSets: [],
            hasMore: false,
        })
    })

    it('returns change sets newest first', async () => {
        const older = changeSet('cs1', '2024-01-01T00:00:00.000Z')
        const newer = changeSet('cs2', '2024-06-01T00:00:00.000Z')
        const fetcher = (path: string) => {
            if (path.endsWith(`/${NAMESPACE}`)) {
                return Promise.resolve(
                    json(['history-cs1', 'config-general', 'history-cs2'])
                )
            }
            if (path.endsWith('history-cs1')) {
                return Promise.resolve(json(older))
            }
            if (path.endsWith('history-cs2')) {
                return Promise.resolve(json(newer))
            }
            return Promise.resolve(notFound())
        }
        const result = await listChangeSets(fetcher)
        expect(result.changeSets.map((c) => c.id)).toEqual(['cs2', 'cs1'])
        expect(result.hasMore).toBe(false)
    })

    it('pages: fetches only the requested window of documents, and reports whether more remain', async () => {
        const ids = Array.from({ length: 5 }, (_, i) => `cs${i}`)
        const requested: string[] = []
        const fetcher = (path: string) => {
            if (path.endsWith(`/${NAMESPACE}`)) {
                return Promise.resolve(json(ids.map((id) => `history-${id}`)))
            }
            const match = /history-(cs\d)$/.exec(path)
            if (match) {
                requested.push(match[1])
                return Promise.resolve(
                    json(changeSet(match[1], '2024-01-01T00:00:00.000Z'))
                )
            }
            return Promise.resolve(notFound())
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
        const fetcherWithKeyOrder = (keys: string[]) => (path: string) => {
            if (path.endsWith(`/${NAMESPACE}`)) {
                return Promise.resolve(json(keys))
            }
            if (path.endsWith('history-cs1')) {
                return Promise.resolve(json(first))
            }
            if (path.endsWith('history-cs2')) {
                return Promise.resolve(json(second))
            }
            return Promise.resolve(notFound())
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
        const fetcher = (path: string, init?: RequestInit) => {
            const method = init?.method ?? 'GET'
            calls.push({
                method,
                path,
                body: init?.body ? JSON.parse(init.body as string) : undefined,
            })
            return Promise.resolve(json({}, 200))
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
