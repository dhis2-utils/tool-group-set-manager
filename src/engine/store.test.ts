import { GroupChange } from './changeSet'
import * as rules from './rules'
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

    it('objectsFor filters by text, trimmed and case-insensitively on both sides', () => {
        const store = loadedStore()
        const scope = { objectType: 'organisationUnit' as const, rootId: null }
        // Names deliberately mixed-case and differing from the query's case
        // on the name side, not just the query side: the store fixture
        // used elsewhere here (['Root','A','B','a1','a2','b1']) already
        // matches lowercase, which would pass even if the store forgot to
        // lowercase the *name* column and only lowercased the query.
        store.setNames('organisationUnit', [
            'Root',
            'Alpha',
            'Beta',
            'Alpha School A1',
            'Alpha A2',
            'Beta One',
        ])
        const page = store.objectsFor(
            'own',
            scope,
            { text: '  SCHOOL  ' },
            0,
            10
        )
        expect(page.items.map((i) => i.id)).toEqual(['a1'])
    })

    it('objectsFor with a text filter matches nothing for a type with no names loaded', () => {
        const store = new EngineStore()
        store.loadObjects({
            objectType: 'organisationUnit',
            ids: ['root', 'A', 'B', 'a1', 'a2', 'b1'],
            names: null,
            level: Uint8Array.from([1, 2, 2, 3, 3, 3]),
            parentIds: [null, 'root', 'root', 'A', 'A', 'B'],
            domainType: null,
            categoryIdsOfOption: null,
        })
        store.setGroupSets([ownership])
        store.loadMemberships({
            objectType: 'organisationUnit',
            groups: [
                { groupId: 'pub', memberIds: ['a1', 'a2'] },
                { groupId: 'priv', memberIds: ['a2', 'b1'] },
            ],
        })
        store.evaluate()
        const page = store.objectsFor(
            'own',
            { objectType: 'organisationUnit', rootId: null },
            { text: 'a1' },
            0,
            10
        )
        expect(page.items).toEqual([])
    })

    it('rebuilds the search index after setNames replaces the names', () => {
        // The case a cached lowercase array would fail: search, replace
        // the names, search again, and the second search must reflect the
        // new names -- not the stale index from before setNames.
        const store = loadedStore()
        const scope = { objectType: 'organisationUnit' as const, rootId: null }
        const before = store.objectsFor('own', scope, { text: 'a1' }, 0, 10)
        expect(before.items.map((i) => i.id)).toEqual(['a1'])

        store.setNames('organisationUnit', [
            'Root',
            'A',
            'B',
            'renamed',
            'a2',
            'b1',
        ])

        const afterOld = store.objectsFor('own', scope, { text: 'a1' }, 0, 10)
        expect(afterOld.items).toEqual([])
        const afterNew = store.objectsFor(
            'own',
            scope,
            { text: 'renamed' },
            0,
            10
        )
        expect(afterNew.items.map((i) => i.id)).toEqual(['a1'])
    })

    describe('the lowercase search index is built once and rebuilt only when names change', () => {
        // These assert the *count* of index builds rather than a wall-clock
        // budget: the property this design exists to guarantee is "built
        // once per names change, not once per call", and a count is exact,
        // instant and machine-independent where a timing budget over the
        // same code path would be a race (see perf.test.ts's history: a
        // 950ms budget here flaked in both directions on a slower or busier
        // machine and was removed in favour of this). The store keeps the
        // exact `names`/`p.names` array reference it is given, so spying on
        // that array's own `.map` -- the index builder's only caller --
        // observes the store's private build count without any production
        // API change.
        const scope = { objectType: 'organisationUnit' as const, rootId: null }

        it('builds once after setNames and reuses it across further searches', () => {
            const store = loadedStore()
            const names = [
                'Root',
                'Alpha',
                'Beta',
                'Alpha School A1',
                'Alpha A2',
                'Beta One',
            ]
            // These rebuild counts spy on `map` because the lowercase index
            // builder is its only caller. That couples them to one way of
            // writing the builder: rewritten as a `for` loop, the spy would
            // never fire and these tests would fail rather than pass
            // silently, so the coupling costs a false alarm on a refactor,
            // never a missed regression. Counting the rebuilds is still
            // right -- the alternative that was tried first, timing 20
            // searches, had 1.12x of headroom and would have flaked in both
            // directions (ruling P3-R10).
            const build = jest.spyOn(names, 'map')
            store.setNames('organisationUnit', names)
            store.objectsFor('own', scope, { text: 'alpha' }, 0, 10)
            store.objectsFor('own', scope, { text: 'school' }, 0, 10)
            store.objectsFor('own', scope, { text: 'beta' }, 0, 10)
            expect(build).toHaveBeenCalledTimes(1)
        })

        it('rebuilds exactly once after a further setNames replaces the names', () => {
            const store = loadedStore()
            // Build the initial index (unspied) so its cost isn't counted.
            store.objectsFor('own', scope, { text: 'a1' }, 0, 10)

            const renamed = ['Root', 'Renamed', 'B', 'x', 'y', 'z']
            const rebuild = jest.spyOn(renamed, 'map')
            store.setNames('organisationUnit', renamed)
            store.objectsFor('own', scope, { text: 'renamed' }, 0, 10)
            store.objectsFor('own', scope, { text: 'renamed' }, 0, 10)
            expect(rebuild).toHaveBeenCalledTimes(1)
        })

        it('builds once after loadObjects and reuses it across further searches', () => {
            const store = new EngineStore()
            const names = ['Root', 'A', 'B', 'a1', 'a2', 'b1']
            const build = jest.spyOn(names, 'map')
            store.loadObjects({
                objectType: 'organisationUnit',
                ids: ['root', 'A', 'B', 'a1', 'a2', 'b1'],
                names,
                level: Uint8Array.from([1, 2, 2, 3, 3, 3]),
                parentIds: [null, 'root', 'root', 'A', 'A', 'B'],
                domainType: null,
                categoryIdsOfOption: null,
            })
            store.setGroupSets([ownership])
            store.loadMemberships({
                objectType: 'organisationUnit',
                groups: [
                    { groupId: 'pub', memberIds: ['a1', 'a2'] },
                    { groupId: 'priv', memberIds: ['a2', 'b1'] },
                ],
            })
            store.evaluate()

            store.objectsFor('own', scope, { text: 'a1' }, 0, 10)
            store.objectsFor('own', scope, { text: 'a2' }, 0, 10)
            expect(build).toHaveBeenCalledTimes(1)
        })

        it('rebuilds exactly once after loadObjects reloads with new names', () => {
            const store = loadedStore()
            // Build the initial index (unspied) so its cost isn't counted.
            store.objectsFor('own', scope, { text: 'a1' }, 0, 10)

            const reloadedNames = ['Root', 'A', 'B', 'renamed', 'a2', 'b1']
            const rebuild = jest.spyOn(reloadedNames, 'map')
            store.loadObjects({
                objectType: 'organisationUnit',
                ids: ['root', 'A', 'B', 'a1', 'a2', 'b1'],
                names: reloadedNames,
                level: Uint8Array.from([1, 2, 2, 3, 3, 3]),
                parentIds: [null, 'root', 'root', 'A', 'A', 'B'],
                domainType: null,
                categoryIdsOfOption: null,
            })
            store.evaluate()

            store.objectsFor('own', scope, { text: 'renamed' }, 0, 10)
            store.objectsFor('own', scope, { text: 'renamed' }, 0, 10)
            expect(rebuild).toHaveBeenCalledTimes(1)
        })

        it('rebuilds exactly once after dropType followed by loadObjects', () => {
            const store = loadedStore()
            // Build the initial index (unspied) so its cost isn't counted.
            store.objectsFor('own', scope, { text: 'a1' }, 0, 10)

            store.dropType('organisationUnit')

            const freshNames = ['Root', 'A', 'B', 'renamed', 'a2', 'b1']
            const build = jest.spyOn(freshNames, 'map')
            store.loadObjects({
                objectType: 'organisationUnit',
                ids: ['root', 'A', 'B', 'a1', 'a2', 'b1'],
                names: freshNames,
                level: Uint8Array.from([1, 2, 2, 3, 3, 3]),
                parentIds: [null, 'root', 'root', 'A', 'A', 'B'],
                domainType: null,
                categoryIdsOfOption: null,
            })
            store.setGroupSets([ownership])
            store.loadMemberships({
                objectType: 'organisationUnit',
                groups: [
                    { groupId: 'pub', memberIds: ['a1', 'a2'] },
                    { groupId: 'priv', memberIds: ['a2', 'b1'] },
                ],
            })
            store.evaluate()

            store.objectsFor('own', scope, { text: 'renamed' }, 0, 10)
            store.objectsFor('own', scope, { text: 'renamed' }, 0, 10)
            expect(build).toHaveBeenCalledTimes(1)
        })
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

    // P3-R6 / item 7: the matrix's flat branch (queries.ts) never consults
    // scopeRoot. That is provably harmless rather than merely untested,
    // because `scopeRoot` (private, below) checks `!t.hierarchy` before
    // `scope.rootId` -- a flat type forces it to -1 regardless of what the
    // caller asked for, and never even looks the id up. Proven here from
    // the outside: a rootId no indicator object could ever match still
    // does not throw and still returns the whole population, because it
    // is never resolved against the (nonexistent) hierarchy at all.
    it('forces scopeRoot to -1 for a flat type regardless of rootId, so matrixFor never throws on an unresolvable one', () => {
        const store = flatIndicatorStore()
        const result = store.matrixFor(
            'ind',
            { objectType: 'indicator', rootId: 'not-a-real-anything' },
            0
        )
        expect(result.rows[0].total).toBe(2)
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

    it('setConfig re-evaluates immediately when includeTracker changes', () => {
        // includeTracker is the one surviving config knob (Plan 4 removed
        // required levels): it decides whether tracker data elements are in
        // the population at all (populationFor). Observe the contract on
        // the thing includeTracker actually changes -- the population/
        // status of a tracker element -- not through a spy on an internal
        // method.
        const compulsory: GroupSetMeta = {
            id: 'de',
            displayName: 'DE Set',
            objectType: 'dataElement',
            compulsory: true,
            dataDimension: false,
            canWrite: true,
            groups: [{ id: 'g1', displayName: 'G1', canWrite: true }],
        }
        const store = new EngineStore()
        store.loadObjects({
            objectType: 'dataElement',
            ids: ['agg', 'trk'],
            names: ['Aggregate', 'Tracker'],
            level: null,
            parentIds: null,
            domainType: Uint8Array.from([1, 2]), // 1 aggregate, 2 tracker
            categoryIdsOfOption: null,
        })
        store.setGroupSets([compulsory])
        store.loadMemberships({
            objectType: 'dataElement',
            groups: [{ groupId: 'g1', memberIds: [] }],
        })
        store.evaluate()

        const before = store.dashboard({
            objectType: 'dataElement',
            rootId: null,
        })
        // Tracker element is out of the population by default: only the
        // aggregate element is counted, and it is missing from the
        // compulsory set.
        expect(before[0].summary).toEqual({
            population: 1,
            ok: 0,
            unassigned: 0,
            missingError: 1,
            missingWarning: 0,
            conflict: 0,
        })

        store.setConfig({ includeTracker: true })

        const after = store.dashboard({
            objectType: 'dataElement',
            rootId: null,
        })
        // The tracker element now enters the population and is also
        // missing -- with no explicit evaluate() call in between.
        expect(after[0].summary).toEqual({
            population: 2,
            ok: 0,
            unassigned: 0,
            missingError: 2,
            missingWarning: 0,
            conflict: 0,
        })
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
        const scope = { objectType: 'organisationUnit' as const, rootId: null }
        const groupsOfB1 = () =>
            store
                .objectsFor('own', scope, {}, 0, 10)
                .items.find((i) => i.id === 'b1')?.groups

        // Capture a baseline that actually moves under this change (b1's own
        // group membership, not the dashboard's status counts -- moving b1
        // from priv to pub leaves it "Ok" either way, so the aggregate
        // summary alone cannot tell a real apply from a no-op).
        const before = groupsOfB1()
        store.applyChangeSet('organisationUnit', changes)
        const once = store.dashboard({
            objectType: 'organisationUnit',
            rootId: null,
        })[0].summary
        const onceGroups = groupsOfB1()
        expect(onceGroups).not.toEqual(before)

        store.applyChangeSet('organisationUnit', changes)
        const twice = store.dashboard({
            objectType: 'organisationUnit',
            rootId: null,
        })[0].summary
        // The summary alone is blind to this change (see above), so pin the
        // group membership itself too: a broken applyChangeSet that swapped
        // b1 back to priv on the second call would still match on summary.
        expect(groupsOfB1()).toEqual(onceGroups)

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

describe('EngineStore.setGroupMembers', () => {
    const scope = { objectType: 'organisationUnit' as const, rootId: null }

    it("replaces a group's membership absolutely rather than merging", () => {
        const store = loadedStore()
        // pub starts as ['a1', 'a2', 'unknown-id']; priv starts as
        // ['a2', 'b1']. A merge implementation would still show a1/a2 in
        // pub afterwards (and b1 would conflict, being in both groups); a
        // replace leaves pub with exactly b1, alone in its own group.
        store.setGroupMembers('organisationUnit', [
            { groupId: 'pub', memberIds: ['b1'] },
            { groupId: 'priv', memberIds: [] },
        ])
        const result = store.objectsFor('own', scope, { group: 0 }, 0, 100)
        expect(result.items.map((i) => i.id)).toEqual(['b1'])
    })

    it('ignores ids the type has never loaded, as applyChangeSet does', () => {
        const store = loadedStore()
        store.setGroupMembers('organisationUnit', [
            { groupId: 'pub', memberIds: ['a1', 'nosuchobject'] },
        ])
        const result = store.objectsFor('own', scope, { group: 0 }, 0, 100)
        expect(result.items.map((i) => i.id)).toEqual(['a1'])
    })

    it('ignores a group the type has never loaded', () => {
        const store = loadedStore()
        expect(() =>
            store.setGroupMembers('organisationUnit', [
                { groupId: 'nosuchgroup', memberIds: ['a1'] },
            ])
        ).not.toThrow()
    })

    it('re-evaluates status for the set it touched', () => {
        // Emptying a group's membership must be reflected by objectsFor,
        // which reads the cached evaluated state rather than
        // membersByGroup directly -- proving evaluateOne ran, not just
        // that membersByGroup changed.
        const store = loadedStore()
        store.setGroupMembers('organisationUnit', [
            { groupId: 'pub', memberIds: [] },
        ])
        const result = store.objectsFor('own', scope, { group: 0 }, 0, 100)
        expect(result.total).toBe(0)
    })
})

describe('EngineStore.planAssignment', () => {
    const scope = { objectType: 'organisationUnit' as const, rootId: null }

    function storeWithGroups(pubWritable: boolean, privWritable: boolean) {
        const set: GroupSetMeta = {
            ...ownership,
            groups: [
                { id: 'pub', displayName: 'Public', canWrite: pubWritable },
                { id: 'priv', displayName: 'Private', canWrite: privWritable },
            ],
        }
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
        store.setGroupSets([set])
        store.loadMemberships({
            objectType: 'organisationUnit',
            groups: [
                { groupId: 'pub', memberIds: ['a1', 'a2'] },
                { groupId: 'priv', memberIds: ['a2', 'b1'] },
            ],
        })
        store.evaluate()
        return store
    }

    it('filter.ids narrows the filter rather than replacing it: a correctly categorised id in the list is still excluded by statuses (fix round 2)', () => {
        // Fix round 2's regression case, at the engine level: before this
        // round `planAssignment` took a separate `selection` parameter
        // that replaced the filter outright, so a caller that forced
        // `statuses` to violations-only (as BulkFixDialog does for "move
        // to catch-all") got that restriction silently bypassed whenever
        // a selection was also given. `ids` is a *predicate* alongside
        // `statuses`, so both apply together.
        const store = storeWithGroups(true, true)
        // a1 is Status.Ok (sole member of pub); a2 is Status.Conflict (in
        // both pub and priv). Both ids are requested, but only a
        // violation (a2) is in scope once `statuses` is combined in.
        const plan = store.planAssignment(
            'own',
            scope,
            { ids: ['a1', 'a2'], statuses: [Status.Conflict] },
            'pub'
        )
        expect(plan.changes.some((c) => c.additions.includes('a1'))).toBe(false)
        expect(plan.changes.some((c) => c.deletions.includes('a1'))).toBe(false)
        // a2 is still acted on: it already holds pub, so it only needs
        // its now-redundant priv membership removed.
        const privChange = plan.changes.find((c) => c.groupId === 'priv')
        expect(privChange?.deletions).toEqual(['a2'])
        expect(plan.affected).toBe(1)
    })

    it('moves everyone to the target, deleting from other groups they hold', () => {
        const store = storeWithGroups(true, true)
        const plan = store.planAssignment('own', scope, { level: 3 }, 'pub')
        // a1 is already the sole member of pub: no change contributed.
        // a2 is in pub+priv already: needs only a deletion from priv.
        // b1 is in priv only: needs an addition to pub and a deletion from priv.
        expect(plan.affected).toBe(2)
        expect(plan.skippedCount).toBe(0)
        expect(plan.skippedSample).toEqual([])
        const pubChange = plan.changes.find((c) => c.groupId === 'pub')
        const privChange = plan.changes.find((c) => c.groupId === 'priv')
        expect(pubChange?.additions.sort()).toEqual(['b1'])
        expect(pubChange?.deletions ?? []).toEqual([])
        expect(privChange?.deletions.sort()).toEqual(['a2', 'b1'])
        expect(privChange?.additions ?? []).toEqual([])
    })

    it('an object already the sole member of the target contributes no change', () => {
        const store = storeWithGroups(true, true)
        const plan = store.planAssignment('own', scope, { ids: ['a1'] }, 'pub')
        expect(plan.affected).toBe(0)
        expect(plan.changes).toEqual([])
        expect(plan.skippedCount).toBe(0)
        expect(plan.skippedSample).toEqual([])
    })

    it('skips an object that would need a deletion from a read-only group', () => {
        const store = storeWithGroups(true, false)
        const plan = store.planAssignment('own', scope, { level: 3 }, 'pub')
        // a2 and b1 both need a deletion from priv, which is read-only.
        expect(plan.skippedCount).toBe(2)
        expect(plan.skippedSample.slice().sort()).toEqual(['a2', 'b1'])
        expect(plan.affected).toBe(0)
        expect(plan.changes).toEqual([])
    })

    it('skips an object that would need an addition to a read-only target', () => {
        const store = storeWithGroups(false, true)
        const plan = store.planAssignment('own', scope, { level: 3 }, 'pub')
        // a1 needs no change (already sole member of pub) regardless of
        // pub being read-only. a2 is already in pub too, so it only needs
        // a deletion from priv, which is writable -- not blocked by pub's
        // read-only status. b1 needs an addition to the read-only pub, so
        // it is skipped.
        expect(plan.skippedCount).toBe(1)
        expect(plan.skippedSample).toEqual(['b1'])
        expect(plan.affected).toBe(1)
        const privChange = plan.changes.find((c) => c.groupId === 'priv')
        expect(privChange?.deletions).toEqual(['a2'])
        expect(plan.changes.find((c) => c.groupId === 'pub')).toBeUndefined()
    })

    it('restricts the plan to filter.ids, an explicit list of object ids', () => {
        const store = storeWithGroups(true, true)
        const plan = store.planAssignment('own', scope, { ids: ['b1'] }, 'pub')
        expect(plan.affected).toBe(1)
        expect(plan.skippedCount).toBe(0)
        expect(plan.skippedSample).toEqual([])
        const pubChange = plan.changes.find((c) => c.groupId === 'pub')
        const privChange = plan.changes.find((c) => c.groupId === 'priv')
        expect(pubChange?.additions).toEqual(['b1'])
        expect(privChange?.deletions).toEqual(['b1'])
    })

    it('throws for an unknown target group id', () => {
        const store = storeWithGroups(true, true)
        expect(() => store.planAssignment('own', scope, {}, 'nope')).toThrow()
    })

    it('a filter.ids list with repeated ids is not double-counted', () => {
        // Fix round 2: `planAssignment` no longer has a separate
        // `selection` parameter to dedupe -- `filter.ids` goes through
        // `listObjects`, which visits every object in scope at most once
        // regardless of how many times its id is repeated in the filter.
        const store = storeWithGroups(true, true)
        const plan = store.planAssignment(
            'own',
            scope,
            { ids: ['b1', 'b1', 'b1'] },
            'pub'
        )
        expect(plan.affected).toBe(1)
    })

    it('caps the returned skipped sample without undercounting skippedCount', () => {
        const set: GroupSetMeta = {
            ...ownership,
            groups: [
                { id: 'pub', displayName: 'Public', canWrite: true },
                { id: 'priv', displayName: 'Private', canWrite: false },
            ],
        }
        const ids = Array.from({ length: 60 }, (_, i) => `o${i}`)
        const store = new EngineStore()
        store.loadObjects({
            objectType: 'organisationUnit',
            ids,
            names: ids,
            level: null,
            parentIds: null,
            domainType: null,
            categoryIdsOfOption: null,
        })
        store.setGroupSets([set])
        store.loadMemberships({
            objectType: 'organisationUnit',
            groups: [
                { groupId: 'pub', memberIds: [] },
                { groupId: 'priv', memberIds: ids },
            ],
        })
        store.evaluate()
        const plan = store.planAssignment(
            'own',
            { objectType: 'organisationUnit', rootId: null },
            {},
            'pub'
        )
        // Every one of the 60 objects needs a deletion from the read-only
        // priv group, so all 60 are skipped -- but only up to the sample
        // limit comes back as ids.
        expect(plan.skippedCount).toBe(60)
        expect(plan.skippedSample).toHaveLength(50)
        expect(plan.changes).toEqual([])
        expect(plan.affected).toBe(0)
    })
})

describe('EngineStore.planRevert', () => {
    function revertStore() {
        const set: GroupSetMeta = {
            ...ownership,
            groups: [
                { id: 'pub', displayName: 'Public', canWrite: true },
                { id: 'priv', displayName: 'Private', canWrite: true },
                { id: 'other', displayName: 'Other', canWrite: true },
            ],
        }
        const s = new EngineStore()
        s.loadObjects({
            objectType: 'organisationUnit',
            ids: ['root', 'A', 'a1', 'a2', 'a3'],
            names: ['Root', 'A', 'a1', 'a2', 'a3'],
            level: Uint8Array.from([1, 2, 3, 3, 3]),
            parentIds: [null, 'root', 'A', 'A', 'A'],
            domainType: null,
            categoryIdsOfOption: null,
        })
        s.setGroupSets([set])
        return s
    }

    it('reverts an untouched move: both legs still hold', () => {
        const s = revertStore()
        s.loadMemberships({
            objectType: 'organisationUnit',
            groups: [
                { groupId: 'pub', memberIds: [] },
                { groupId: 'priv', memberIds: [] },
                // Left exactly where the original move (pub -> other) put
                // it, untouched since.
                { groupId: 'other', memberIds: ['a1'] },
            ],
        })
        s.evaluate()
        const changes: GroupChange[] = [
            { groupId: 'pub', additions: [], deletions: ['a1'] },
            { groupId: 'other', additions: ['a1'], deletions: [] },
        ]
        const plan = s.planRevert('own', changes)
        expect(plan.skippedCount).toBe(0)
        expect(plan.affected).toBe(1)
        expect(
            plan.changes.find((c) => c.groupId === 'pub')?.additions
        ).toEqual(['a1'])
        expect(
            plan.changes.find((c) => c.groupId === 'other')?.deletions
        ).toEqual(['a1'])
    })

    it("skips an object reassigned since -- reverting must not undo a later deliberate decision (D1's facility example)", () => {
        const s = revertStore()
        s.loadMemberships({
            objectType: 'organisationUnit',
            groups: [
                // Moved back to pub by hand after the bulk move to other.
                { groupId: 'pub', memberIds: ['a1'] },
                { groupId: 'priv', memberIds: [] },
                { groupId: 'other', memberIds: [] },
            ],
        })
        s.evaluate()
        const changes: GroupChange[] = [
            { groupId: 'pub', additions: [], deletions: ['a1'] },
            { groupId: 'other', additions: ['a1'], deletions: [] },
        ]
        const plan = s.planRevert('own', changes)
        expect(plan.skippedCount).toBe(1)
        expect(plan.skippedSample).toEqual(['a1'])
        expect(plan.affected).toBe(0)
        expect(plan.changes).toEqual([])
    })

    it('judges an object as a whole: one broken leg skips the entire object, not just that leg', () => {
        const s = revertStore()
        s.loadMemberships({
            objectType: 'organisationUnit',
            groups: [
                // a2 was moved pub -> priv; someone has since removed it
                // from priv too (without putting it back in pub). The pub
                // leg alone ("currently not in pub") would pass, but the
                // priv leg ("currently in priv") fails, and that must
                // block the whole object rather than only re-adding it to
                // pub and leaving it in neither group as some half-revert.
                { groupId: 'pub', memberIds: [] },
                { groupId: 'priv', memberIds: [] },
                { groupId: 'other', memberIds: [] },
            ],
        })
        s.evaluate()
        const changes: GroupChange[] = [
            { groupId: 'pub', additions: [], deletions: ['a2'] },
            { groupId: 'priv', additions: ['a2'], deletions: [] },
        ]
        const plan = s.planRevert('own', changes)
        expect(plan.skippedCount).toBe(1)
        expect(plan.affected).toBe(0)
        expect(plan.changes).toEqual([])
    })

    it('skips ids the engine no longer knows about (the object was deleted since)', () => {
        const s = revertStore()
        s.loadMemberships({
            objectType: 'organisationUnit',
            groups: [
                { groupId: 'pub', memberIds: [] },
                { groupId: 'priv', memberIds: [] },
                { groupId: 'other', memberIds: [] },
            ],
        })
        s.evaluate()
        const changes: GroupChange[] = [
            { groupId: 'pub', additions: [], deletions: ['gone'] },
            { groupId: 'other', additions: ['gone'], deletions: [] },
        ]
        const plan = s.planRevert('own', changes)
        expect(plan.skippedCount).toBe(1)
        expect(plan.skippedSample).toEqual(['gone'])
        expect(plan.changes).toEqual([])
    })

    it('I2: skips an object when a touched group is read-only, the same as planAssignment', () => {
        const set: GroupSetMeta = {
            ...ownership,
            groups: [
                { id: 'pub', displayName: 'Public', canWrite: true },
                { id: 'priv', displayName: 'Private', canWrite: false },
                { id: 'other', displayName: 'Other', canWrite: true },
            ],
        }
        const s = new EngineStore()
        s.loadObjects({
            objectType: 'organisationUnit',
            ids: ['root', 'A', 'a1'],
            names: ['Root', 'A', 'a1'],
            level: Uint8Array.from([1, 2, 3]),
            parentIds: [null, 'root', 'A'],
            domainType: null,
            categoryIdsOfOption: null,
        })
        s.setGroupSets([set])
        s.loadMemberships({
            objectType: 'organisationUnit',
            groups: [
                // a1 currently sits where the original move (priv -> pub)
                // left it, untouched -- but priv is read-only, so this
                // caller must not be offered a revert into it.
                { groupId: 'pub', memberIds: ['a1'] },
                { groupId: 'priv', memberIds: [] },
                { groupId: 'other', memberIds: [] },
            ],
        })
        s.evaluate()
        const changes: GroupChange[] = [
            { groupId: 'priv', additions: [], deletions: ['a1'] },
            { groupId: 'pub', additions: ['a1'], deletions: [] },
        ]
        const plan = s.planRevert('own', changes)
        expect(plan.skippedCount).toBe(1)
        expect(plan.skippedSample).toEqual(['a1'])
        expect(plan.changes).toEqual([])
        expect(plan.affected).toBe(0)
    })

    it('I3: skips an object whose original deletion was from a group since removed from the set, rather than emitting an addition to it', () => {
        // The set now holds only pub+other -- priv (the group the original
        // change deleted 'a1' from) has been removed from it since.
        const set: GroupSetMeta = {
            ...ownership,
            groups: [
                { id: 'pub', displayName: 'Public', canWrite: true },
                { id: 'other', displayName: 'Other', canWrite: true },
            ],
        }
        const s = new EngineStore()
        s.loadObjects({
            objectType: 'organisationUnit',
            ids: ['root', 'A', 'a1'],
            names: ['Root', 'A', 'a1'],
            level: Uint8Array.from([1, 2, 3]),
            parentIds: [null, 'root', 'A'],
            domainType: null,
            categoryIdsOfOption: null,
        })
        s.setGroupSets([set])
        s.loadMemberships({
            objectType: 'organisationUnit',
            groups: [
                { groupId: 'pub', memberIds: [] },
                { groupId: 'other', memberIds: [] },
            ],
        })
        s.evaluate()
        // The recorded change set still names the now-gone 'priv' group
        // (a deletion-only 'assign' change set is the live exposure -- see
        // I3).
        const changes: GroupChange[] = [
            { groupId: 'priv', additions: [], deletions: ['a1'] },
        ]
        const plan = s.planRevert('own', changes)
        expect(plan.skippedCount).toBe(1)
        expect(plan.skippedSample).toEqual(['a1'])
        // Must not emit an addition to a group no longer in the set.
        expect(plan.changes).toEqual([])
        expect(plan.affected).toBe(0)
    })
})

describe('EngineStore.indexesOf', () => {
    it('resolves many ids in one call, in order, with -1 for unknown ids', () => {
        const store = loadedStore()

        expect(
            store.indexesOf('organisationUnit', ['a2', 'nope', 'root'])
        ).toEqual([
            store.indexOf('organisationUnit', 'a2'),
            -1,
            store.indexOf('organisationUnit', 'root'),
        ])
    })

    it('returns -1 for every id of a type that is not loaded', () => {
        const store = loadedStore()

        expect(store.indexesOf('indicator', ['i1', 'i2'])).toEqual([-1, -1])
    })
})

describe('EngineStore.applyChangeSet re-evaluation (M5)', () => {
    /**
     * On a 266k-org-unit instance with seven sets, re-evaluating every set
     * of the type for one inline row assignment is a full rebuild per
     * click. A change can only affect the sets that contain one of the
     * groups it names, so only those are rebuilt.
     */
    function twoSetStore(): EngineStore {
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
        store.setGroupSets([
            {
                id: 'setA',
                displayName: 'Set A',
                objectType: 'organisationUnit',
                compulsory: true,
                dataDimension: true,
                canWrite: true,
                groups: [
                    { id: 'a1g', displayName: 'A1', canWrite: true },
                    { id: 'a2g', displayName: 'A2', canWrite: true },
                ],
            },
            {
                id: 'setB',
                displayName: 'Set B',
                objectType: 'organisationUnit',
                compulsory: true,
                dataDimension: true,
                canWrite: true,
                groups: [{ id: 'b1g', displayName: 'B1', canWrite: true }],
            },
        ])
        store.loadMemberships({
            objectType: 'organisationUnit',
            groups: [
                { groupId: 'a1g', memberIds: ['a1'] },
                { groupId: 'a2g', memberIds: ['a2'] },
                { groupId: 'b1g', memberIds: ['a1', 'a2'] },
            ],
        })
        store.evaluate()
        return store
    }

    it('re-evaluates only the sets whose groups the change named', () => {
        const store = twoSetStore()
        const spy = jest.spyOn(rules, 'evaluateSet')

        store.applyChangeSet('organisationUnit', [
            { groupId: 'a1g', additions: [], deletions: ['a1'] },
            { groupId: 'a2g', additions: ['a1'], deletions: [] },
        ])

        expect(spy.mock.calls.map((c) => c[0].id)).toEqual(['setA'])
        spy.mockRestore()
    })

    it('still applies the change to the set it named', () => {
        const store = twoSetStore()
        store.applyChangeSet('organisationUnit', [
            { groupId: 'a1g', additions: [], deletions: ['a1'] },
            { groupId: 'a2g', additions: ['a1'], deletions: [] },
        ])

        const page = store.objectsFor(
            'setA',
            { objectType: 'organisationUnit', rootId: null },
            { group: 1 },
            0,
            10
        )
        expect(page.items.map((i) => i.id).sort()).toEqual(['a1', 'a2'])
    })

    it('leaves a set the change did not name untouched and still queryable', () => {
        const store = twoSetStore()
        store.applyChangeSet('organisationUnit', [
            { groupId: 'a1g', additions: [], deletions: ['a1'] },
        ])

        const page = store.objectsFor(
            'setB',
            { objectType: 'organisationUnit', rootId: null },
            { group: 0 },
            0,
            10
        )
        expect(page.items.map((i) => i.id).sort()).toEqual(['a1', 'a2'])
    })
})
