import { createMemoryCache } from './cache'
import { loadAll, LoadStatus } from './loadAll'
import { DataSource } from './sources/DataSource'
import { MembershipsPayload, ObjectsPayload } from '@/engine/protocol'
import { EngineStore } from '@/engine/store'

/** Engine client that runs the real store synchronously, no worker. */
function inlineEngine() {
    const store = new EngineStore()
    return {
        calls: [] as string[],
        store,
        call<T>(method: string, ...args: unknown[]): Promise<T> {
            this.calls.push(method)
            const fn = (
                store as unknown as Record<string, (...a: unknown[]) => unknown>
            )[method]
            return Promise.resolve(fn.apply(store, args) as T)
        },
        terminate() {},
    }
}

const ouObjects: ObjectsPayload = {
    objectType: 'organisationUnit',
    ids: ['r', 'a'],
    names: null,
    level: Uint8Array.from([1, 2]),
    parentIds: [null, 'r'],
    domainType: null,
    categoryIdsOfOption: null,
}
const ouMembers: MembershipsPayload = {
    objectType: 'organisationUnit',
    groups: [{ groupId: 'pub', memberIds: ['a'] }],
}

function fakeSource(): DataSource & { loads: string[] } {
    const loads: string[] = []
    return {
        kind: 'metadata',
        loads,
        async loadObjects(type) {
            loads.push(`objects:${type}`)
            if (type === 'organisationUnit') {
                return ouObjects
            }
            return {
                objectType: type,
                ids: [],
                names: [],
                level: null,
                parentIds: null,
                domainType: null,
                categoryIdsOfOption: null,
            }
        },
        async loadNames(type) {
            loads.push(`names:${type}`)
            return [
                { id: 'a', displayName: 'A' },
                { id: 'r', displayName: 'Root' },
            ]
        },
        async loadMemberships(type) {
            loads.push(`memberships:${type}`)
            return type === 'organisationUnit'
                ? ouMembers
                : { objectType: type, groups: [] }
        },
    }
}

const groupSetsBody = {
    organisationUnitGroupSets: [
        {
            id: 'own',
            displayName: 'Ownership',
            compulsory: true,
            dataDimension: true,
            access: { write: true },
            organisationUnitGroups: [
                { id: 'pub', displayName: 'Public', access: { write: true } },
            ],
        },
    ],
    dataElementGroupSets: [],
    // An indicator set with a group is needed so the indicator type is actually
    // loaded; types without group sets are skipped before any request is made.
    indicatorGroupSets: [
        {
            id: 'igs',
            displayName: 'IGS',
            compulsory: false,
            access: { write: false },
            indicatorGroups: [
                { id: 'ig1', displayName: 'IG1', access: { write: false } },
            ],
        },
    ],
    categoryOptionGroupSets: [],
}

// The `lastUpdated` stamps the server reports for each group, mutable so a
// test can simulate someone moving an object between groups (which updates
// both groups and nothing else the loader looks at).
const stamps: Record<string, string> = {
    pub: '2026-09-01T10:00:00.000',
    ig1: '2026-09-01T10:00:00.000',
}

const fetcher = async (path: string) => {
    // Checked before the group check below: "organisationUnitGroupSets?"
    // also starts with "organisationUnitGroups".
    if (path.includes('GroupSets?')) {
        return new Response(JSON.stringify(groupSetsBody), { status: 200 })
    }
    if (path.includes('Groups?fields=id,lastUpdated')) {
        const resource = path.slice(0, path.indexOf('?'))
        const ids = resource.startsWith('organisationUnit') ? ['pub'] : ['ig1']
        return new Response(
            JSON.stringify({
                [resource]: ids.map((id) => ({ id, lastUpdated: stamps[id] })),
            }),
            { status: 200 }
        )
    }
    // object totals: organisationUnits has 2, everything else 0
    const total = path.startsWith('organisationUnits') ? 2 : 0
    return new Response(JSON.stringify({ pager: { total } }), { status: 200 })
}

describe('loadAll', () => {
    it('loads from the source, evaluates, realigns names and fills the cache', async () => {
        const source = fakeSource()
        const cache = createMemoryCache()
        const engine = inlineEngine()
        const statuses: LoadStatus[] = []
        const { groupSets } = await loadAll({
            source,
            fetcher,
            cache,
            engine,
            onStatus: (s) => statuses.push(s),
        })

        // The indicator group set ('igs') is also returned: loadGroupSets
        // (already tested, unmodified) legitimately includes it since the
        // fixture gives it a group, and loadAll returns every loaded group
        // set unfiltered -- the caller decides what to do with each.
        expect(groupSets.map((s) => s.id)).toEqual(['own', 'igs'])
        expect(source.loads).toContain('objects:organisationUnit')
        expect(source.loads).toContain('names:organisationUnit')
        expect(engine.calls).toContain('evaluate')
        expect(
            engine.store
                .resolve('organisationUnit', [0, 1])
                .map((r) => r.displayName)
        ).toEqual(['Root', 'A'])
        expect((await cache.get('organisationUnit'))?.names).toEqual([
            'Root',
            'A',
        ])
        expect(statuses[statuses.length - 1].phase).toBe('done')
    })

    it('reuses the cache when group ids and totals match', async () => {
        const source = fakeSource()
        const cache = createMemoryCache()
        await loadAll({
            source,
            fetcher,
            cache,
            engine: inlineEngine(),
            onStatus: () => undefined,
        })
        const second = fakeSource()
        const status: LoadStatus[] = []
        await loadAll({
            source: second,
            fetcher,
            cache,
            engine: inlineEngine(),
            onStatus: (s) => status.push(s),
        })
        expect(
            second.loads.filter((l) => l.endsWith('organisationUnit'))
        ).toEqual([])
        expect(status[status.length - 1].fromCache.organisationUnit).toBe(true)
        // The indicator type has a group set too, so it is loaded (not
        // skipped) on the first run and reused from the cache on the
        // second, exactly like organisation units.
        expect(status[status.length - 1].fromCache.indicator).toBe(true)
        expect(second.loads.filter((l) => l.endsWith('indicator'))).toEqual([])
        // A cache hit reports a coherent phase of its own rather than
        // whatever the previously emitted status happened to leave behind
        // (organisation units are the first type in the loop, so before the
        // fix this would still read 'groupSets').
        const ouStatus = status.find(
            (s) => s.type === 'organisationUnit' && s.fromCache.organisationUnit
        )
        expect(ouStatus?.phase).toBe('evaluate')
    })

    it('bypasses a populated cache when forceRefresh is set', async () => {
        const source = fakeSource()
        const cache = createMemoryCache()
        await loadAll({
            source,
            fetcher,
            cache,
            engine: inlineEngine(),
            onStatus: () => undefined,
        })
        const second = fakeSource()
        const status: LoadStatus[] = []
        await loadAll({
            source: second,
            fetcher,
            cache,
            engine: inlineEngine(),
            forceRefresh: true,
            onStatus: (s) => status.push(s),
        })
        expect(second.loads).toContain('objects:organisationUnit')
        expect(second.loads).toContain('objects:indicator')
        expect(status[status.length - 1].fromCache).toEqual({})
    })

    it('records an error for a failing type and still loads the others', async () => {
        const source = fakeSource()
        source.loadObjects = async (type) => {
            if (type === 'indicator') {
                throw new Error('nope')
            }
            return type === 'organisationUnit'
                ? ouObjects
                : {
                      objectType: type,
                      ids: [],
                      names: [],
                      level: null,
                      parentIds: null,
                      domainType: null,
                      categoryIdsOfOption: null,
                  }
        }
        const status: LoadStatus[] = []
        await loadAll({
            source,
            fetcher,
            cache: createMemoryCache(),
            engine: inlineEngine(),
            onStatus: (s) => status.push(s),
        })
        const last = status[status.length - 1]
        expect(last.errors.indicator).toBe('nope')
        expect(last.errors.organisationUnit).toBeUndefined()
    })

    it('keeps a type out of the engine entirely when its memberships fail', async () => {
        const source = fakeSource()
        source.loadMemberships = async (type) => {
            if (type === 'indicator') {
                throw new Error('memberships boom')
            }
            return type === 'organisationUnit'
                ? ouMembers
                : { objectType: type, groups: [] }
        }
        const engine = inlineEngine()
        const status: LoadStatus[] = []
        await loadAll({
            source,
            fetcher,
            cache: createMemoryCache(),
            engine,
            onStatus: (s) => status.push(s),
        })
        const last = status[status.length - 1]
        expect(last.errors.indicator).toBe('memberships boom')
        expect(last.errors.organisationUnit).toBeUndefined()

        // The objects payload was resolved before memberships failed, but
        // must never have reached the engine: a half-loaded type (objects
        // with no membership data) would evaluate as every object missing
        // from every group, which reads as a real integrity failure rather
        // than a failed request.
        expect(engine.store.resolve('indicator', [0])).toEqual([])
        const entries = engine.store.dashboard({
            objectType: 'indicator',
            rootId: null,
        })
        expect(entries).toHaveLength(1)
        expect(entries[0].hasData).toBe(false)
        expect(entries[0].summary).toEqual({
            population: 0,
            ok: 0,
            unassigned: 0,
            missingError: 0,
            missingWarning: 0,
            conflict: 0,
        })
    })

    it('reloads a type when a group has been updated since it was cached', async () => {
        // The case the cache used to be blind to: moving an object from
        // Public to Private changes neither the group id list nor the object
        // total, so the stale memberships were reused for good and the app
        // kept insisting on problems the user had already fixed.
        const cache = createMemoryCache()
        await loadAll({
            source: fakeSource(),
            fetcher,
            cache,
            engine: inlineEngine(),
            onStatus: () => undefined,
        })
        expect((await cache.get('organisationUnit'))?.groupLastUpdated).toEqual(
            { pub: '2026-09-01T10:00:00.000' }
        )

        stamps.pub = '2026-09-10T08:30:00.000'
        const second = fakeSource()
        const status: LoadStatus[] = []
        await loadAll({
            source: second,
            fetcher,
            cache,
            engine: inlineEngine(),
            onStatus: (s) => status.push(s),
        })
        expect(second.loads).toContain('objects:organisationUnit')
        expect(second.loads).toContain('memberships:organisationUnit')
        expect(status[status.length - 1].fromCache.organisationUnit).toBe(
            undefined
        )
        // The unchanged type is still served from the cache: one changed
        // group set does not throw away everything.
        expect(second.loads.filter((l) => l.endsWith('indicator'))).toEqual([])
        stamps.pub = '2026-09-01T10:00:00.000'
    })

    it('reloads rather than trusts a cache entry stored without group stamps', async () => {
        const cache = createMemoryCache()
        await loadAll({
            source: fakeSource(),
            fetcher,
            cache,
            engine: inlineEngine(),
            onStatus: () => undefined,
        })
        const stored = await cache.get('organisationUnit')
        // An entry written by a build from before stamps were stored.
        delete (stored as { groupLastUpdated?: unknown }).groupLastUpdated
        await cache.put('organisationUnit', stored!)

        const second = fakeSource()
        await loadAll({
            source: second,
            fetcher,
            cache,
            engine: inlineEngine(),
            onStatus: () => undefined,
        })
        expect(second.loads).toContain('objects:organisationUnit')
    })

    it('leaves no half-loaded type when a cached reuse fails part way', async () => {
        // Populate the cache for both types first.
        const cache = createMemoryCache()
        await loadAll({
            source: fakeSource(),
            fetcher,
            cache,
            engine: inlineEngine(),
            onStatus: () => undefined,
        })

        // Second run reuses the cache (nothing changed server-side), but the
        // engine's loadMemberships call fails partway through the reuse --
        // e.g. the worker crashed. loadObjects for this type has already
        // landed by then; without a rollback the engine would hold objects
        // with no membership data, which reads as every object missing from
        // every group -- indistinguishable from a real integrity failure.
        const engine = inlineEngine()
        const original = engine.call.bind(engine)
        engine.call = ((method: string, ...args: unknown[]) =>
            method === 'loadMemberships'
                ? Promise.reject(new Error('worker died'))
                : original(method, ...args)) as typeof engine.call

        const status: LoadStatus[] = []
        await loadAll({
            source: fakeSource(),
            fetcher,
            cache,
            engine,
            onStatus: (s) => status.push(s),
        })

        const last = status[status.length - 1]
        expect(last.errors.organisationUnit).toMatch(/worker died/)
        const [entry] = engine.store.dashboard({
            objectType: 'organisationUnit',
            rootId: null,
        })
        expect(entry.hasData).toBe(false)
        expect(engine.store.resolve('organisationUnit', [0])).toEqual([])
    })

    it('leaves no half-loaded type when a fresh load succeeds at the source but the engine call fails part way', async () => {
        // No cache populated: this goes through the fresh-load branch.
        // Resolving both source fetches before calling the engine (the
        // existing "Commit to the engine only once both payloads are in
        // hand" comment) protects against a *fetch* failure -- it does
        // nothing if the engine call itself fails (e.g. the worker
        // crashed) between loadObjects landing and loadMemberships
        // landing, which is exactly what this test simulates.
        const engine = inlineEngine()
        const original = engine.call.bind(engine)
        engine.call = ((method: string, ...args: unknown[]) =>
            method === 'loadMemberships'
                ? Promise.reject(new Error('worker died'))
                : original(method, ...args)) as typeof engine.call

        const status: LoadStatus[] = []
        await loadAll({
            source: fakeSource(),
            fetcher,
            cache: createMemoryCache(),
            engine,
            onStatus: (s) => status.push(s),
        })

        const last = status[status.length - 1]
        expect(last.errors.organisationUnit).toMatch(/worker died/)
        const [entry] = engine.store.dashboard({
            objectType: 'organisationUnit',
            rootId: null,
        })
        expect(entry.hasData).toBe(false)
        expect(engine.store.resolve('organisationUnit', [0])).toEqual([])
    })

    it('reports the original failure even when the rollback itself fails', async () => {
        // If the engine is dead enough that loadMemberships fails, dropType
        // might fail too. The user needs to see why the load actually
        // failed, not a second error about the failed cleanup attempt.
        const engine = inlineEngine()
        const original = engine.call.bind(engine)
        engine.call = ((method: string, ...args: unknown[]) => {
            if (method === 'loadMemberships') {
                return Promise.reject(new Error('worker died'))
            }
            if (method === 'dropType') {
                return Promise.reject(new Error('rollback also failed'))
            }
            return original(method, ...args)
        }) as typeof engine.call

        const status: LoadStatus[] = []
        await loadAll({
            source: fakeSource(),
            fetcher,
            cache: createMemoryCache(),
            engine,
            onStatus: (s) => status.push(s),
        })

        const last = status[status.length - 1]
        expect(last.errors.organisationUnit).toBe('worker died')
    })

    it('records a type whose group sets could not be read and loads the rest', async () => {
        const failing = async (path: string) => {
            if (path.startsWith('indicatorGroupSets')) {
                return new Response('boom', { status: 500 })
            }
            return fetcher(path)
        }
        const source = fakeSource()
        const status: LoadStatus[] = []
        const { groupSets } = await loadAll({
            source,
            fetcher: failing,
            cache: createMemoryCache(),
            engine: inlineEngine(),
            onStatus: (s) => status.push(s),
        })
        expect(groupSets.map((s) => s.id)).toEqual(['own'])
        const last = status[status.length - 1]
        expect(last.errors.indicator).toMatch(/500/)
        expect(last.phase).toBe('done')
        expect(source.loads).toContain('objects:organisationUnit')
    })

    // D4: a SQL view source that fails its first real read must degrade to
    // the metadata source for the rest of that load, not report a broken
    // app -- and it must not retry the SQL view source again afterwards
    // (the whole point is one fallback, not a wrapper around every read).
    it('D4: falls back to the metadata source when the sql view source fails its first read', async () => {
        const sqlViewCalls: string[] = []
        const failingSqlSource: DataSource = {
            kind: 'sqlView',
            async loadObjects(type) {
                sqlViewCalls.push(`objects:${type}`)
                if (type === 'organisationUnit') {
                    throw new Error('sql view read failed: HTTP 500')
                }
                return {
                    objectType: type,
                    ids: [],
                    names: [],
                    level: null,
                    parentIds: null,
                    domainType: null,
                    categoryIdsOfOption: null,
                }
            },
            async loadNames(type) {
                sqlViewCalls.push(`names:${type}`)
                return []
            },
            async loadMemberships(type) {
                sqlViewCalls.push(`memberships:${type}`)
                return { objectType: type, groups: [] }
            },
        }
        const metadataFetcher = async (path: string) => {
            if (path.startsWith('organisationUnits?fields=id,level,parent')) {
                return new Response(
                    JSON.stringify({
                        organisationUnits: [
                            { id: 'r', level: 1 },
                            { id: 'a', level: 2, parent: { id: 'r' } },
                        ],
                    }),
                    { status: 200 }
                )
            }
            if (path.startsWith('organisationUnits?fields=id,displayName')) {
                return new Response(
                    JSON.stringify({
                        organisationUnits: [
                            { id: 'r', displayName: 'Root' },
                            { id: 'a', displayName: 'A' },
                        ],
                    }),
                    { status: 200 }
                )
            }
            if (
                path.startsWith('organisationUnitGroups/pub/organisationUnits')
            ) {
                return new Response(
                    JSON.stringify({ organisationUnits: [{ id: 'a' }] }),
                    { status: 200 }
                )
            }
            if (path.startsWith('indicators?fields=id,displayName')) {
                return new Response(
                    JSON.stringify({
                        indicators: [{ id: 'i1', displayName: 'Ind1' }],
                    }),
                    { status: 200 }
                )
            }
            if (path.startsWith('indicatorGroups/ig1/indicators')) {
                return new Response(
                    JSON.stringify({ indicators: [{ id: 'i1' }] }),
                    { status: 200 }
                )
            }
            return fetcher(path)
        }
        const engine = inlineEngine()
        const status: LoadStatus[] = []
        const result = await loadAll({
            source: failingSqlSource,
            fetcher: metadataFetcher,
            cache: createMemoryCache(),
            engine,
            onStatus: (s) => status.push(s),
        })

        // The load completed (no fatal error for organisationUnit) and the
        // engine actually holds the org units the metadata fallback served.
        expect(
            status[status.length - 1].errors.organisationUnit
        ).toBeUndefined()
        expect(status[status.length - 1].phase).toBe('done')
        expect(
            engine.store.resolve('organisationUnit', [0, 1]).map((r) => r.id)
        ).toEqual(['r', 'a'])
        // The app must end up reporting the source it actually used, not the
        // one it merely started with.
        expect(result.sourceKind).toBe('metadata')
        // Exactly one attempt against the broken SQL view source for
        // organisationUnit objects -- a retry wrapper around every read
        // would show up here as more than one.
        expect(
            sqlViewCalls.filter((c) => c === 'objects:organisationUnit')
        ).toHaveLength(1)
        // Once fallen back, later types must go straight to the metadata
        // source rather than trying (and failing) the SQL view source too.
        expect(sqlViewCalls).not.toContain('objects:indicator')
        expect(sqlViewCalls).not.toContain('memberships:organisationUnit')
    })
})
