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

const fetcher = async (path: string) => {
    if (path.includes('GroupSets?')) {
        return new Response(JSON.stringify(groupSetsBody), { status: 200 })
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
})
