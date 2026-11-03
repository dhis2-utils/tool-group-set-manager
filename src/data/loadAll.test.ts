import { CACHE_TTL_MS, createMemoryCache } from './cache'
import type { LoadStatus } from './loadAll'
import { LoadSuperseded, loadAll } from './loadAll'
import type { DataSource } from './sources/DataSource'
import type { MembershipsPayload, ObjectsPayload } from '@/engine/protocol'
import { EngineStore } from '@/engine/store'
import { defined } from '@/testing/defined'

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
        nameSource: 'metadata',
        loads,
        loadObjects(type) {
            loads.push(`objects:${type}`)
            if (type === 'organisationUnit') {
                return Promise.resolve(ouObjects)
            }
            return Promise.resolve({
                objectType: type,
                ids: [],
                names: [],
                level: null,
                parentIds: null,
                domainType: null,
                categoryIdsOfOption: null,
            })
        },
        loadNames(type) {
            loads.push(`names:${type}`)
            return Promise.resolve([
                { id: 'a', displayName: 'A' },
                { id: 'r', displayName: 'Root' },
            ])
        },
        loadMemberships(type) {
            loads.push(`memberships:${type}`)
            return Promise.resolve(
                type === 'organisationUnit'
                    ? ouMembers
                    : { objectType: type, groups: [] }
            )
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

const fetcher = (path: string) => {
    // Checked before the group check below: "organisationUnitGroupSets?"
    // also starts with "organisationUnitGroups".
    if (path.includes('GroupSets?')) {
        return Promise.resolve(
            new Response(JSON.stringify(groupSetsBody), { status: 200 })
        )
    }
    if (path.includes('Groups?fields=id,lastUpdated')) {
        const resource = path.slice(0, path.indexOf('?'))
        const ids = resource.startsWith('organisationUnit') ? ['pub'] : ['ig1']
        return Promise.resolve(
            new Response(
                JSON.stringify({
                    [resource]: ids.map((id) => ({
                        id,
                        lastUpdated: stamps[id],
                    })),
                }),
                { status: 200 }
            )
        )
    }
    // object totals: organisationUnits has 2, everything else 0
    const total = path.startsWith('organisationUnits') ? 2 : 0
    return Promise.resolve(
        new Response(JSON.stringify({ pager: { total } }), { status: 200 })
    )
}

describe('loadAll', () => {
    it('loads from the source, evaluates, realigns names and fills the cache', async () => {
        const source = fakeSource()
        const cache = createMemoryCache()
        const engine = inlineEngine()
        const statuses: LoadStatus[] = []
        const { groupSets, fellBack } = await loadAll({
            source,
            fetcher,
            cache,
            engine,
            onStatus: (s) => statuses.push(s),
        })

        // This source is 'metadata' from the start -- a server that never
        // had SQL views at all -- so no fallback ever happened, and the
        // flag must say so rather than being inferred from sourceKind
        // (which is also 'metadata' here and would be indistinguishable).
        expect(fellBack).toBe(false)

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

    it('M9d: a superseded load makes no further engine call and writes nothing to the cache', async () => {
        const source = fakeSource()
        const cache = createMemoryCache()
        const engine = inlineEngine()
        let current = true
        // The newer load starts while this one is reading memberships.
        const loadMemberships = source.loadMemberships.bind(source)
        source.loadMemberships = (type, groupIds, onProgress) => {
            current = false
            return loadMemberships(type, groupIds, onProgress)
        }
        await expect(
            loadAll({
                source,
                fetcher,
                cache,
                engine,
                onStatus: () => {},
                isCurrent: () => current,
            })
        ).rejects.toBeInstanceOf(LoadSuperseded)
        expect(engine.calls).toEqual(['setGroupSets'])
        expect(await cache.get('organisationUnit')).toBeUndefined()
    })

    it('M9d: does not cache what it read when the cache was invalidated during the load', async () => {
        const cache = createMemoryCache()
        const engine = inlineEngine()
        const statuses: LoadStatus[] = []
        await loadAll({
            source: fakeSource(),
            fetcher,
            cache,
            engine,
            onStatus: (s) => statuses.push(s),
            mayCache: () => false,
        })
        // The load still finishes and fills the engine ...
        expect(statuses[statuses.length - 1].phase).toBe('done')
        expect(engine.calls).toContain('loadMemberships')
        // ... but what it read may predate the write, so none of it is kept.
        expect(await cache.get('organisationUnit')).toBeUndefined()
        expect(await cache.get('indicator')).toBeUndefined()
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

    it('does not reuse a cache entry older than the TTL, even when every other gate passes', async () => {
        // Every gate that exists today passes here -- same group ids, same
        // object total, same lastUpdated stamps -- because the second load runs
        // against the same fixtures. On 2.41-2.43 that is exactly the state a
        // membership move leaves behind, which is why age has to be a gate of
        // its own.
        const cache = createMemoryCache()
        await loadAll({
            source: fakeSource(),
            fetcher,
            cache,
            engine: inlineEngine(),
            onStatus: () => undefined,
        })

        // Age the entry past the TTL in place, rather than hand-building a
        // CachedType fixture that would drift from the real one.
        const entry = await cache.get('organisationUnit')
        await cache.put('organisationUnit', {
            ...defined(entry),
            savedAt: Date.now() - CACHE_TTL_MS - 1,
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
        ).not.toEqual([])
        expect(status[status.length - 1].fromCache.organisationUnit).toBeFalsy()
    })

    it('reports loadedAt as the time of the server read on a fresh load', async () => {
        const before = Date.now()
        const status: LoadStatus[] = []
        await loadAll({
            source: fakeSource(),
            fetcher,
            cache: createMemoryCache(),
            engine: inlineEngine(),
            onStatus: (s) => status.push(s),
        })
        expect(
            status[status.length - 1].loadedAt.organisationUnit
        ).toBeGreaterThanOrEqual(before)
    })

    it('reports the cached savedAt, not now, when a type is served from cache', async () => {
        // The age the user is shown must be the age of the data, not of the
        // page load -- a cache hit reporting `now` would claim a freshness it
        // does not have, which is the whole defect this feature exists to fix.
        const cache = createMemoryCache()
        await loadAll({
            source: fakeSource(),
            fetcher,
            cache,
            engine: inlineEngine(),
            onStatus: () => undefined,
        })
        // Inside the TTL, so the entry is still reused, but old enough that
        // `now` and `savedAt` cannot be confused.
        const savedAt = Date.now() - 60_000
        const entry = await cache.get('organisationUnit')
        await cache.put('organisationUnit', { ...defined(entry), savedAt })

        const status: LoadStatus[] = []
        await loadAll({
            source: fakeSource(),
            fetcher,
            cache,
            engine: inlineEngine(),
            onStatus: (s) => status.push(s),
        })
        const last = status[status.length - 1]
        expect(last.fromCache.organisationUnit).toBe(true)
        expect(last.loadedAt.organisationUnit).toBe(savedAt)
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
        source.loadObjects = (type) => {
            if (type === 'indicator') {
                return Promise.reject(new Error('nope'))
            }
            return Promise.resolve(
                type === 'organisationUnit'
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
            )
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

    // A names failure happens strictly after objects, memberships and
    // evaluate have already landed successfully: the counts the engine
    // reports are correct, only the display names are missing. That must
    // not read to the user the same way an objects/memberships failure
    // does (which really does leave the type's counts wrong) -- it belongs
    // in its own bucket.
    it('records a names failure as its own kind of failure, not a type-level error, when counts are otherwise good', async () => {
        const source = fakeSource()
        source.loadNames = (type) => {
            if (type === 'organisationUnit') {
                return Promise.reject(new Error('names boom'))
            }
            return Promise.resolve([
                { id: 'a', displayName: 'A' },
                { id: 'r', displayName: 'Root' },
            ])
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
        expect(last.errors.organisationUnit).toBeUndefined()
        expect(last.namesErrors.organisationUnit).toBe('names boom')
        // The counts are unaffected: evaluate already ran against real
        // objects and memberships before names were even attempted.
        const [entry] = engine.store.dashboard({
            objectType: 'organisationUnit',
            rootId: null,
        })
        expect(entry.hasData).toBe(true)
    })

    // M1 (fix round 1): the names-failure fallback (`names = objects.ids`)
    // must never reach the cache. `tryCache` matches on group ids, object
    // total and every group's `lastUpdated` -- none of which a names
    // endpoint hiccup touches -- so a cached entry saved with uids-as-names
    // would be silently reused on every later load, with the type's own
    // `namesErrors` empty on that later run (nothing failed this time) and
    // nothing else in `LoadStatus` recording the substitution. The fix is
    // to skip `cache.put` entirely when this run had a names failure for
    // the type, so the next load has nothing to reuse and goes back to the
    // source for names.
    it('does not cache a names failure, so the next load retries names instead of permanently serving uids (M1)', async () => {
        const cache = createMemoryCache()

        const failingNamesSource = fakeSource()
        failingNamesSource.loadNames = (type) => {
            if (type === 'organisationUnit') {
                return Promise.reject(new Error('names boom'))
            }
            return Promise.resolve([
                { id: 'a', displayName: 'A' },
                { id: 'r', displayName: 'Root' },
            ])
        }
        await loadAll({
            source: failingNamesSource,
            fetcher,
            cache,
            engine: inlineEngine(),
            onStatus: () => undefined,
        })

        // A second, independent load, sharing only the cache. Its source's
        // loadNames works fine -- if the first load's failure had been
        // cached, this second load would reuse it from cache and never
        // call loadNames at all, serving the first load's uids forever.
        const secondSource = fakeSource()
        const secondEngine = inlineEngine()
        await loadAll({
            source: secondSource,
            fetcher,
            cache,
            engine: secondEngine,
            onStatus: () => undefined,
        })

        expect(secondSource.loads).toContain('names:organisationUnit')
        const { items } = secondEngine.store.objectsFor(
            'own',
            { objectType: 'organisationUnit', rootId: null },
            {},
            0,
            10
        )
        const root = items.find((i) => i.id === 'r')
        expect(root?.displayName).toBe('Root')
    })

    it('keeps a type out of the engine entirely when its memberships fail', async () => {
        const source = fakeSource()
        source.loadMemberships = (type) => {
            if (type === 'indicator') {
                return Promise.reject(new Error('memberships boom'))
            }
            return Promise.resolve(
                type === 'organisationUnit'
                    ? ouMembers
                    : { objectType: type, groups: [] }
            )
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
        expect(
            status[status.length - 1].fromCache.organisationUnit
        ).toBeUndefined()
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
        await cache.put('organisationUnit', defined(stored))

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
        const failing = (path: string) => {
            if (path.startsWith('indicatorGroupSets')) {
                return Promise.resolve(new Response('boom', { status: 500 }))
            }
            return Promise.resolve(fetcher(path))
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
            nameSource: 'sqlView',
            loadObjects(type) {
                sqlViewCalls.push(`objects:${type}`)
                if (type === 'organisationUnit') {
                    return Promise.reject(
                        new Error('sql view read failed: HTTP 500')
                    )
                }
                return Promise.resolve({
                    objectType: type,
                    ids: [],
                    names: [],
                    level: null,
                    parentIds: null,
                    domainType: null,
                    categoryIdsOfOption: null,
                })
            },
            loadNames(type) {
                sqlViewCalls.push(`names:${type}`)
                return Promise.resolve([])
            },
            loadMemberships(type) {
                sqlViewCalls.push(`memberships:${type}`)
                return Promise.resolve({ objectType: type, groups: [] })
            },
        }
        const metadataFetcher = (path: string) => {
            if (path.startsWith('organisationUnits?fields=id,level,parent')) {
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            organisationUnits: [
                                { id: 'r', level: 1 },
                                { id: 'a', level: 2, parent: { id: 'r' } },
                            ],
                        }),
                        { status: 200 }
                    )
                )
            }
            if (path.startsWith('organisationUnits?fields=id,displayName')) {
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            organisationUnits: [
                                { id: 'r', displayName: 'Root' },
                                { id: 'a', displayName: 'A' },
                            ],
                        }),
                        { status: 200 }
                    )
                )
            }
            if (
                path.startsWith('organisationUnitGroups/pub/organisationUnits')
            ) {
                return Promise.resolve(
                    new Response(
                        JSON.stringify({ organisationUnits: [{ id: 'a' }] }),
                        { status: 200 }
                    )
                )
            }
            if (path.startsWith('indicators?fields=id,displayName')) {
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            indicators: [{ id: 'i1', displayName: 'Ind1' }],
                        }),
                        { status: 200 }
                    )
                )
            }
            if (path.startsWith('indicatorGroups/ig1/indicators')) {
                return Promise.resolve(
                    new Response(
                        JSON.stringify({ indicators: [{ id: 'i1' }] }),
                        { status: 200 }
                    )
                )
            }
            return Promise.resolve(fetcher(path))
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
        // Distinct from the case above: this server did have a SQL view
        // source that broke mid-load, so the flag must be true here even
        // though sourceKind reads the same ('metadata') in both cases.
        expect(result.fellBack).toBe(true)
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
