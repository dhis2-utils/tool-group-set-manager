import { GroupChange } from './changeSet'
import { EngineStore } from './store'
import { GroupSetMeta, Status } from './types'

const indicatorSet: GroupSetMeta = {
    id: 'ind',
    displayName: 'Indicator Set',
    objectType: 'indicator',
    compulsory: true,
    dataDimension: true,
    canWrite: true,
    groups: [{ id: 'g1', displayName: 'G1', canWrite: true }],
}

const ownership: GroupSetMeta = {
    id: 'own',
    displayName: 'Ownership',
    objectType: 'organisationUnit',
    compulsory: true,
    dataDimension: true,
    canWrite: true,
    groups: [
        { id: 'pub', displayName: 'Public', canWrite: true },
        { id: 'priv', displayName: 'Private', canWrite: true },
    ],
}

function loadedStore(): EngineStore {
    const store = new EngineStore()
    store.loadObjects({
        objectType: 'organisationUnit',
        ids: ['root', 'A', 'B', 'a1', 'a2', 'b1'],
        names: ['Root', 'A', 'B', 'a1', 'a2', 'b1'],
        level: Uint8Array.from([1, 2, 2, 3, 3, 3]),
        parentIds: [null, 'root', 'root', 'A', 'A', 'B'],
        domainType: null,
        categoryIdsOfOption: null,
    })
    store.setGroupSets([ownership])
    store.loadMemberships({
        objectType: 'organisationUnit',
        groups: [
            { groupId: 'pub', memberIds: ['a1', 'a2', 'unknown-id'] },
            { groupId: 'priv', memberIds: ['a2', 'b1'] },
        ],
    })
    store.evaluate()
    return store
}

/** A flat (no hierarchy) object type, to exercise the "no root requested" scan-everything path. */
function flatIndicatorStore(): EngineStore {
    const store = new EngineStore()
    store.loadObjects({
        objectType: 'indicator',
        ids: ['i1', 'i2'],
        names: ['I1', 'I2'],
        level: null,
        parentIds: null,
        domainType: null,
        categoryIdsOfOption: null,
    })
    store.setGroupSets([indicatorSet])
    store.loadMemberships({
        objectType: 'indicator',
        groups: [{ groupId: 'g1', memberIds: ['i1'] }],
    })
    store.evaluate()
    return store
}

describe('EngineStore', () => {
    it('produces dashboard summaries for the scope', () => {
        const store = loadedStore()
        const [entry] = store.dashboard({
            objectType: 'organisationUnit',
            rootId: 'A',
        })
        expect(entry.set.id).toBe('own')
        expect(entry.summary).toEqual({
            population: 3,
            ok: 1,
            unassigned: 0,
            missingError: 1,
            missingWarning: 0,
            conflict: 1,
        })
    })

    it('ignores member ids that are not loaded objects', () => {
        const store = loadedStore()
        const [entry] = store.dashboard({
            objectType: 'organisationUnit',
            rootId: null,
        })
        expect(entry.summary.population).toBe(6)
    })

    it('returns a matrix with resolved row objects', () => {
        const store = loadedStore()
        const result = store.matrixFor(
            'own',
            { objectType: 'organisationUnit', rootId: 'root' },
            2
        )
        expect(result.groups.map((g) => g.id)).toEqual(['pub', 'priv'])
        expect(result.rows[0].row?.displayName).toBe('A')
        expect(result.rows[0].perGroup).toEqual([1, 0])
        expect(result.rows[0].conflict).toBe(1)
        expect(result.rows[2].row).toBeNull()
    })

    it('pages object lists and includes status and groups', () => {
        const store = loadedStore()
        const page = store.objectsFor(
            'own',
            { objectType: 'organisationUnit', rootId: 'root' },
            { statuses: [Status.Conflict, Status.Ok] },
            0,
            10
        )
        expect(page.total).toBe(3)
        expect(page.items.map((i) => i.id)).toEqual(['a1', 'a2', 'b1'])
        expect(page.items[1].status).toBe(Status.Conflict)
        expect(page.items[1].groups).toEqual([0, 1])
        expect(page.items[0].parentId).toBe('A')
    })

    it('serves a later page as its own slice, without the rows before it', () => {
        // What the objects table relies on to page by offset instead of
        // re-requesting every row it already has with a bigger limit.
        const store = loadedStore()
        const scope = {
            objectType: 'organisationUnit' as const,
            rootId: 'root',
        }
        const first = store.objectsFor('own', scope, {}, 0, 2)
        const second = store.objectsFor('own', scope, {}, 2, 2)
        expect(first.total).toBe(6)
        expect(second.total).toBe(6)
        expect(first.items).toHaveLength(2)
        expect(second.items).toHaveLength(2)
        expect(second.items.map((i) => i.id)).toEqual(
            store
                .objectsFor('own', scope, {}, 0, 4)
                .items.slice(2)
                .map((i) => i.id)
        )
    })

    it('resolves the level of one object by id', () => {
        const store = loadedStore()
        expect(store.levelOf('organisationUnit', 'a1')).toBe(3)
        expect(store.levelOf('organisationUnit', 'A')).toBe(2)
        // Unknown id, and a type with no hierarchy at all.
        expect(store.levelOf('organisationUnit', 'nope')).toBeNull()
        expect(store.levelOf('indicator', 'a1')).toBeNull()
    })

    it('reports hasData false for sets whose type is not loaded', () => {
        const store = new EngineStore()
        store.setGroupSets([{ ...ownership, id: 'x', objectType: 'indicator' }])
        const [entry] = store.dashboard({
            objectType: 'indicator',
            rootId: null,
        })
        expect(entry.hasData).toBe(false)
    })

    it('setNames fills names after the fact', () => {
        const store = loadedStore()
        store.setNames('organisationUnit', ['R', 'AA', 'BB', 'x', 'y', 'z'])
        expect(store.resolve('organisationUnit', [1])[0].displayName).toBe('AA')
    })

    it('scans everything when the root id is null for a flat object type', () => {
        const store = flatIndicatorStore()
        const [entry] = store.dashboard({
            objectType: 'indicator',
            rootId: null,
        })
        expect(entry.hasData).toBe(true)
        expect(entry.summary.population).toBe(2)
    })

    it('dashboard throws for an unknown scope root id rather than scanning everything', () => {
        const store = loadedStore()
        expect(() =>
            store.dashboard({ objectType: 'organisationUnit', rootId: 'nope' })
        ).toThrow(/organisationUnit/)
        expect(() =>
            store.dashboard({ objectType: 'organisationUnit', rootId: 'nope' })
        ).toThrow(/nope/)
    })

    it('matrixFor throws for an unknown scope root id rather than scanning everything', () => {
        const store = loadedStore()
        expect(() =>
            store.matrixFor(
                'own',
                { objectType: 'organisationUnit', rootId: 'nope' },
                2
            )
        ).toThrow(/organisationUnit/)
        expect(() =>
            store.matrixFor(
                'own',
                { objectType: 'organisationUnit', rootId: 'nope' },
                2
            )
        ).toThrow(/nope/)
    })

    it('objectsFor throws for an unknown scope root id rather than scanning everything', () => {
        const store = loadedStore()
        expect(() =>
            store.objectsFor(
                'own',
                { objectType: 'organisationUnit', rootId: 'nope' },
                {},
                0,
                10
            )
        ).toThrow(/organisationUnit/)
        expect(() =>
            store.objectsFor(
                'own',
                { objectType: 'organisationUnit', rootId: 'nope' },
                {},
                0,
                10
            )
        ).toThrow(/nope/)
    })

    it('keeps membership per group set when one group belongs to two group sets', () => {
        // Mirrors the real EMIS instance: "Private", "JSS" and "SSS" each sit
        // in two group sets, so membership must be resolved per set, not per
        // group.
        const store = new EngineStore()
        store.loadObjects({
            objectType: 'organisationUnit',
            ids: ['root', 'a1', 'a2'],
            names: ['Root', 'a1', 'a2'],
            level: Uint8Array.from([1, 2, 2]),
            parentIds: [null, 'root', 'root'],
            domainType: null,
            categoryIdsOfOption: null,
        })
        const setA: GroupSetMeta = {
            id: 'setA',
            displayName: 'Set A',
            objectType: 'organisationUnit',
            compulsory: true,
            dataDimension: true,
            canWrite: true,
            groups: [
                { id: 'shared', displayName: 'Shared', canWrite: true },
                { id: 'onlyA', displayName: 'Only A', canWrite: true },
            ],
        }
        const setB: GroupSetMeta = {
            id: 'setB',
            displayName: 'Set B',
            objectType: 'organisationUnit',
            compulsory: true,
            dataDimension: true,
            canWrite: true,
            groups: [{ id: 'shared', displayName: 'Shared', canWrite: true }],
        }
        store.setGroupSets([setA, setB])
        store.loadMemberships({
            objectType: 'organisationUnit',
            groups: [
                // a1 is in "shared" and "onlyA" -> conflict in set A, but
                // "shared" is the only group of set B, so a1 is fine there.
                { groupId: 'shared', memberIds: ['a1', 'a2'] },
                { groupId: 'onlyA', memberIds: ['a1'] },
            ],
        })
        store.evaluate()

        const a1 = store.indexOf('organisationUnit', 'a1')
        const a2 = store.indexOf('organisationUnit', 'a2')

        const pageA = store.objectsFor(
            'setA',
            { objectType: 'organisationUnit', rootId: null },
            {},
            0,
            10
        )
        const pageB = store.objectsFor(
            'setB',
            { objectType: 'organisationUnit', rootId: null },
            {},
            0,
            10
        )

        const statusA = new Map(pageA.items.map((i) => [i.index, i.status]))
        const statusB = new Map(pageB.items.map((i) => [i.index, i.status]))

        expect(statusA.get(a1)).toBe(Status.Conflict)
        expect(statusA.get(a2)).toBe(Status.Ok)
        expect(statusB.get(a1)).toBe(Status.Ok)
        expect(statusB.get(a2)).toBe(Status.Ok)
    })

    it('dropType removes a type and its evaluated sets without touching other types', () => {
        const store = loadedStore()
        store.setGroupSets([ownership, indicatorSet])
        store.loadObjects({
            objectType: 'indicator',
            ids: ['i1', 'i2'],
            names: ['I1', 'I2'],
            level: null,
            parentIds: null,
            domainType: null,
            categoryIdsOfOption: null,
        })
        store.loadMemberships({
            objectType: 'indicator',
            groups: [{ groupId: 'g1', memberIds: ['i1'] }],
        })
        store.evaluate()

        expect(
            store.dashboard({ objectType: 'organisationUnit', rootId: null })[0]
                .hasData
        ).toBe(true)
        expect(
            store.dashboard({ objectType: 'indicator', rootId: null })[0]
                .hasData
        ).toBe(true)

        store.dropType('organisationUnit')

        const ouEntry = store.dashboard({
            objectType: 'organisationUnit',
            rootId: null,
        })[0]
        expect(ouEntry.hasData).toBe(false)
        expect(ouEntry.summary).toEqual({
            population: 0,
            ok: 0,
            unassigned: 0,
            missingError: 0,
            missingWarning: 0,
            conflict: 0,
        })
        // The unrelated indicator type and its set are untouched.
        expect(
            store.dashboard({ objectType: 'indicator', rootId: null })[0]
                .hasData
        ).toBe(true)
        // matrixFor/objectsFor on the dropped set's id must not find stale
        // state that references a type no longer present.
        expect(() =>
            store.matrixFor(
                'own',
                { objectType: 'organisationUnit', rootId: null },
                2
            )
        ).toThrow(/Unknown or unevaluated group set/)
    })

    it('re-evaluates when the config changes, without being asked twice', () => {
        // A non-compulsory, data-dimension set: with no required levels,
        // every missing object is a warning. Configuring a required level
        // must be visible immediately, without a caller having to remember
        // to call evaluate() itself -- that caller is exactly what Plan 2
        // introduces (the Settings page, the tracker toggle).
        const nonCompulsory: GroupSetMeta = {
            id: 'nc',
            displayName: 'Non-compulsory dimension',
            objectType: 'organisationUnit',
            compulsory: false,
            dataDimension: true,
            canWrite: true,
            groups: [{ id: 'pub', displayName: 'Public', canWrite: true }],
        }
        const store = new EngineStore()
        store.loadObjects({
            objectType: 'organisationUnit',
            ids: ['root', 'a1'],
            names: ['Root', 'A1'],
            level: Uint8Array.from([1, 2]),
            parentIds: [null, 'root'],
            domainType: null,
            categoryIdsOfOption: null,
        })
        store.setGroupSets([nonCompulsory])
        store.loadMemberships({
            objectType: 'organisationUnit',
            groups: [{ groupId: 'pub', memberIds: [] }],
        })
        store.evaluate()

        const before = store.dashboard({
            objectType: 'organisationUnit',
            rootId: null,
        })
        expect(before[0].summary).toEqual({
            population: 2,
            ok: 0,
            unassigned: 0,
            missingError: 0,
            missingWarning: 2,
            conflict: 0,
        })

        store.setConfig({ requiredLevels: { nc: [2] }, includeTracker: false })

        const after = store.dashboard({
            objectType: 'organisationUnit',
            rootId: null,
        })
        expect(after[0].summary).not.toEqual(before[0].summary)
    })

    it('resolveParents resolves the parent ref of each given object', () => {
        const store = loadedStore()
        const a1 = store.indexOf('organisationUnit', 'a1')
        const a2 = store.indexOf('organisationUnit', 'a2')
        const b1 = store.indexOf('organisationUnit', 'b1')
        const root = store.indexOf('organisationUnit', 'root')

        const parents = store.resolveParents('organisationUnit', [
            a1,
            a2,
            b1,
            root,
        ])
        expect(parents.map((p) => p?.displayName ?? null)).toEqual([
            'A',
            'A',
            'B',
            null, // root has no parent
        ])
    })

    it('resolveParents returns null for every object of a flat type', () => {
        const store = flatIndicatorStore()
        const parents = store.resolveParents('indicator', [0, 1])
        expect(parents).toEqual([null, null])
    })

    it('resolveParents returns null for every index when the type is not loaded', () => {
        const store = new EngineStore()
        expect(store.resolveParents('organisationUnit', [0, 1])).toEqual([
            null,
            null,
        ])
    })

    it('resolveParents returns null for an out-of-range index', () => {
        // A page request built from a stale total, or a race with a reload
        // that shrank the type, can hand back an index past the end of the
        // loaded array. It must degrade to null rather than throw or return
        // a garbage ref.
        const store = loadedStore()
        expect(store.resolveParents('organisationUnit', [999])).toEqual([null])
    })

    it('applyChangeSet moves an object between groups and is reflected without a reload', () => {
        const store = loadedStore()
        // b1 starts in priv only (Ok). Move it: out of priv, into pub,
        // where it now joins a1 -- giving pub two members and priv none.
        store.applyChangeSet('organisationUnit', [
            { groupId: 'priv', additions: [], deletions: ['b1'] },
            { groupId: 'pub', additions: ['b1'], deletions: [] },
        ])
        const page = store.objectsFor(
            'own',
            { objectType: 'organisationUnit', rootId: null },
            {},
            0,
            10
        )
        const b1 = page.items.find((i) => i.id === 'b1')
        expect(b1?.status).toBe(Status.Ok)
        expect(b1?.groups).toEqual([0]) // pub only, no longer priv
        const a2 = page.items.find((i) => i.id === 'a2')
        // a2 was already in both groups (Conflict) and is untouched.
        expect(a2?.status).toBe(Status.Conflict)
    })

    it('applyChangeSet ignores object ids the engine does not know', () => {
        const store = loadedStore()
        // A change set restored from the dataStore weeks later may name an
        // object that has since been deleted. Applying it must not throw,
        // and must not affect the dashboard.
        const before = store.dashboard({
            objectType: 'organisationUnit',
            rootId: null,
        })[0].summary
        expect(() =>
            store.applyChangeSet('organisationUnit', [
                {
                    groupId: 'pub',
                    additions: ['deleted-object'],
                    deletions: [],
                },
            ])
        ).not.toThrow()
        const after = store.dashboard({
            objectType: 'organisationUnit',
            rootId: null,
        })[0].summary
        expect(after).toEqual(before)
    })

    it('applyChangeSet ignores group ids that belong to no loaded set', () => {
        const store = loadedStore()
        // A change set may name a group that has since been removed from
        // its set. Applying it must not throw, and must not fabricate a
        // group nobody loaded.
        const before = store.dashboard({
            objectType: 'organisationUnit',
            rootId: null,
        })[0].summary
        expect(() =>
            store.applyChangeSet('organisationUnit', [
                { groupId: 'removed-group', additions: ['a1'], deletions: [] },
            ])
        ).not.toThrow()
        const after = store.dashboard({
            objectType: 'organisationUnit',
            rootId: null,
        })[0].summary
        expect(after).toEqual(before)
    })

    it('applyChangeSet is idempotent: applying the same change twice matches applying it once', () => {
        const changes: GroupChange[] = [
            { groupId: 'priv', additions: [], deletions: ['b1'] },
            { groupId: 'pub', additions: ['b1'], deletions: [] },
        ]
        const store = loadedStore()
        store.applyChangeSet('organisationUnit', changes)
        const once = store.dashboard({
            objectType: 'organisationUnit',
            rootId: null,
        })[0].summary

        store.applyChangeSet('organisationUnit', changes)
        const twice = store.dashboard({
            objectType: 'organisationUnit',
            rootId: null,
        })[0].summary

        expect(twice).toEqual(once)
    })

    it('applyChangeSet on a type with nothing loaded is a no-op, not a throw', () => {
        const store = new EngineStore()
        expect(() =>
            store.applyChangeSet('organisationUnit', [
                { groupId: 'pub', additions: ['a1'], deletions: [] },
            ])
        ).not.toThrow()
    })
})
