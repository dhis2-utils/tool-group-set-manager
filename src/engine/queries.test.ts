import { buildHierarchy } from './hierarchy'
import { buildSetMembership } from './membership'
import { listObjects, matrix, summarize } from './queries'
import { Status } from './types'

// 0 root(1) -> 1 A(2) -> 3,4 (3) ; 0 -> 2 B(2) -> 5 (3)
const h = buildHierarchy(
    Int32Array.from([-1, 0, 0, 1, 1, 2]),
    Uint8Array.from([1, 2, 2, 3, 3, 3])
)
// groups: G0 = {3}, G1 = {4, 5}, and 4 also in G0 -> conflict
const m = buildSetMembership(6, [
    Int32Array.from([3, 4]),
    Int32Array.from([4, 5]),
])
// status computed as a compulsory set would: 0,1,2 missing (error), 3 ok, 4 conflict, 5 ok
const status = Uint8Array.from([
    Status.MissingError,
    Status.MissingError,
    Status.MissingError,
    Status.Ok,
    Status.Conflict,
    Status.Ok,
])

describe('summarize', () => {
    it('counts within the scope subtree', () => {
        expect(summarize(status, m, h, 0)).toEqual({
            population: 6,
            ok: 2,
            unassigned: 0,
            missingError: 3,
            missingWarning: 0,
            conflict: 1,
        })
        expect(summarize(status, m, h, 1)).toEqual({
            population: 3,
            ok: 1,
            unassigned: 0,
            missingError: 1,
            missingWarning: 0,
            conflict: 1,
        })
    })

    it('ignores NotApplicable objects', () => {
        const s = Uint8Array.from([Status.NotApplicable, Status.Ok])
        expect(
            summarize(s, buildSetMembership(2, []), null, -1).population
        ).toBe(1)
    })

    it('counts a NoGroup object as unassigned, not as ok', () => {
        // A set that is neither compulsory nor a data dimension: rules.ts
        // gives its group-less objects Status.NoGroup (spec 3.2). Folding
        // those into `ok` would let a card claim every object is
        // categorised when none of them is.
        const permissive = Uint8Array.from([
            Status.NoGroup, // 0: no group, allowed
            Status.NoGroup, // 1: no group, allowed
            Status.NoGroup, // 2: no group, allowed
            Status.Ok, // 3: in G0
            Status.Conflict,
            Status.Ok, // 5: in G1
        ])
        expect(summarize(permissive, m, h, 0)).toEqual({
            population: 6,
            ok: 2,
            unassigned: 3,
            missingError: 0,
            missingWarning: 0,
            conflict: 1,
        })
    })
})

describe('matrix', () => {
    it('one row per org unit at the row level, plus an "above" row', () => {
        const rows = matrix(status, m, h, 0, 2, 2)
        expect(rows).toEqual([
            {
                object: 1,
                perGroup: [1, 0],
                missing: 1,
                unassigned: 0,
                conflict: 1,
                total: 3,
            },
            {
                object: 2,
                perGroup: [0, 1],
                missing: 1,
                unassigned: 0,
                conflict: 0,
                total: 2,
            },
            {
                object: -1,
                perGroup: [0, 0],
                missing: 1,
                unassigned: 0,
                conflict: 0,
                total: 1,
            },
        ])
    })

    // For a flat type, `EngineStore.scopeRoot` always returns -1 -- it
    // checks `!t.hierarchy` before `scope.rootId` (see store.ts), so no
    // caller can ever make a real scopeRoot reach here for a flat type.
    // This proves the flat branch's own half: whatever scopeRoot value
    // *would* arrive, the flat branch ignores it and returns the same
    // result, so the omission is provably harmless rather than merely
    // untested.
    it('ignores scopeRoot for a flat type (h === null), which is harmless: a flat type never has a real scopeRoot to ignore', () => {
        const flatMembership = buildSetMembership(6, [
            Int32Array.from([3, 4]),
            Int32Array.from([4, 5]),
        ])
        const withNoRoot = matrix(status, flatMembership, null, -1, 2, 2)
        const withBogusRoot = matrix(status, flatMembership, null, 4, 2, 2)
        expect(withBogusRoot).toEqual(withNoRoot)
    })

    it('flat types produce a single row', () => {
        const rows = matrix(status, m, null, -1, 0, 2)
        expect(rows).toEqual([
            {
                object: -1,
                perGroup: [1, 1],
                missing: 3,
                unassigned: 0,
                conflict: 1,
                total: 6,
            },
        ])
    })

    it('buckets a NoGroup object as unassigned, not missing', () => {
        // The bug this replaced: the Missing column was keyed on membership,
        // so a non-compulsory, non-data-dimension set reported Missing N in
        // the matrix while the card reported Missing 0 -- and clicking the
        // cell, which filters by status, listed nothing at all.
        const permissive = Uint8Array.from([
            Status.NoGroup,
            Status.NoGroup,
            Status.NoGroup,
            Status.Ok,
            Status.Conflict,
            Status.Ok,
        ])
        const rows = matrix(permissive, m, null, -1, 0, 2)
        expect(rows).toEqual([
            {
                object: -1,
                perGroup: [1, 1],
                missing: 0,
                unassigned: 3,
                conflict: 1,
                total: 6,
            },
        ])
        // Every bucket still sums to the total.
        const r = rows[0]
        expect(
            r.perGroup.reduce((a, b) => a + b, 0) +
                r.missing +
                r.unassigned +
                r.conflict
        ).toBe(r.total)
    })

    it('still counts a warning-level missing object as missing', () => {
        // A data dimension set that is not compulsory: group-less objects are
        // MissingWarning, which belongs in Missing, not in the new bucket.
        const warned = Uint8Array.from([
            Status.MissingWarning,
            Status.MissingWarning,
            Status.MissingWarning,
            Status.Ok,
            Status.Conflict,
            Status.Ok,
        ])
        const rows = matrix(warned, m, null, -1, 0, 2)
        expect(rows[0].missing).toBe(3)
        expect(rows[0].unassigned).toBe(0)
    })
})

describe('listObjects', () => {
    it('returns indexes in the scope in depth-first order', () => {
        expect([...listObjects(status, m, h, 0, {})]).toEqual([
            0, 1, 3, 4, 2, 5,
        ])
    })

    it('filters by status, level, group and ancestor', () => {
        expect([
            ...listObjects(status, m, h, 0, { statuses: [Status.Conflict] }),
        ]).toEqual([4])
        expect([...listObjects(status, m, h, 0, { level: 2 })]).toEqual([1, 2])
        expect([...listObjects(status, m, h, 0, { group: 1 })]).toEqual([5])
        expect([...listObjects(status, m, h, 0, { group: -1 })]).toEqual([
            0, 1, 2,
        ])
        expect([...listObjects(status, m, h, 0, { ancestor: 2 })]).toEqual([
            2, 5,
        ])
    })

    it('lists exactly the objects the "no group, not required" column counts', () => {
        // The filter the matrix's new column drills into: status Ok *and* no
        // group. Status alone would also list every object that is in a
        // group; group alone would also list the missing ones on a set where
        // being in no group is an error.
        const permissive = Uint8Array.from([
            Status.Ok,
            Status.Ok,
            Status.Ok,
            Status.Ok,
            Status.Conflict,
            Status.Ok,
        ])
        expect([
            ...listObjects(permissive, m, h, 0, {
                group: -1,
                statuses: [Status.Ok],
            }),
        ]).toEqual([0, 1, 2])
    })

    it('works for flat types', () => {
        expect([
            ...listObjects(status, m, null, -1, { statuses: [Status.Ok] }),
        ]).toEqual([3, 5])
    })

    // No existing test combined two *object* filters (as opposed to status
    // plus one other, already covered above) in a single call -- level and
    // group together, which only object 4 (level 3, group 1) satisfies.
    it('combines a level filter and a group filter in the same call', () => {
        // Object 4 is at level 3 but is the conflicting object (in both
        // G0 and G1), so its `groupOf` is the conflict marker (-2), not 1
        // -- only object 5 is at level 3 *and* genuinely in group 1.
        expect([
            ...listObjects(status, m, h, 0, {
                level: 3,
                group: 1,
            }),
        ]).toEqual([5])
        // Same two predicates, but no object at level 2 is in group 1, so
        // the combination (as opposed to either alone) excludes everything.
        expect([
            ...listObjects(status, m, h, 0, {
                level: 2,
                group: 1,
            }),
        ]).toEqual([])
    })

    // A flat type (no hierarchy: dataElement, indicator, categoryOption)
    // has no levels and no ancestors at all -- `level`/`ancestor` are
    // hierarchy-only concepts a caller for a flat type should never pass.
    // Final review (M2): an intermediate version of this code silently
    // *ignored* the predicate for a flat type (treating it as "this
    // predicate cannot apply here"), which is safe for a read-only list but
    // is exactly wrong for `listObjects`' other caller, `planAssignment` --
    // the population a bulk fix *writes*. There, a stale `level`/`ancestor`
    // filter carried over from switching types would silently widen the
    // write population from empty to everything, which is the worse of the
    // two failures on a write path (the same reasoning this file already
    // applies to `ids`/`text` two rules below: "matches nothing" beats
    // "silently returns everything"). The honest third option -- neither
    // silently excluding everything nor silently ignoring the predicate --
    // is to throw: this is a caller error (no UI path passes either
    // predicate for a flat type today), and a caller error on a write path
    // should fail loudly, not resolve to a population by accident.
    it('throws when a level or ancestor filter is given for a flat type, rather than silently excluding everything or ignoring the predicate', () => {
        expect(() => listObjects(status, m, null, -1, { level: 3 })).toThrow(
            /flat type/i
        )
        expect(() => listObjects(status, m, null, -1, { ancestor: 1 })).toThrow(
            /flat type/i
        )
    })

    it('filters by an id predicate, combined with other filters', () => {
        const ids = ['root', 'A', 'B', 'a1', 'a2', 'b1']
        expect([
            ...listObjects(status, m, h, 0, { ids: ['a1', 'b1'] }, ids),
        ]).toEqual([3, 5])
        // Combined with a status filter that excludes one of the ids.
        expect([
            ...listObjects(
                status,
                m,
                h,
                0,
                {
                    ids: ['a1', 'a2'],
                    statuses: [Status.Ok],
                },
                ids
            ),
        ]).toEqual([3])
    })

    it('matches nothing when filter.ids is given but the id array is not', () => {
        // A caller that asks for the `ids` predicate but forgets to pass
        // the type's id array gets an empty result, not the predicate
        // silently ignored (which would return the whole population).
        expect([...listObjects(status, m, h, 0, { ids: ['a1'] })]).toEqual([])
    })
})

describe('listObjects text predicate', () => {
    // Object 3's name has "School" in the middle, on purpose: a naive
    // prefix-only match would pass while a real substring match is needed.
    const names = [
        'Root',
        'Alpha',
        'Beta',
        'Alpha School A1',
        'Alpha A2',
        'Beta One',
    ]
    const namesLower = names.map((n) => n.toLowerCase())

    it('matches a substring in the middle of a name', () => {
        expect([
            ...listObjects(
                status,
                m,
                h,
                0,
                { text: 'school' },
                undefined,
                namesLower
            ),
        ]).toEqual([3])
    })

    it('matches case-insensitively in both directions', () => {
        expect([
            ...listObjects(
                status,
                m,
                h,
                0,
                { text: 'SCHOOL' },
                undefined,
                namesLower
            ),
        ]).toEqual([3])
        const upperNames = names.map((n) => n.toUpperCase())
        const upperLower = upperNames.map((n) => n.toLowerCase())
        expect([
            ...listObjects(
                status,
                m,
                h,
                0,
                { text: 'school' },
                undefined,
                upperLower
            ),
        ]).toEqual([3])
    })

    it('trims the query before matching', () => {
        expect([
            ...listObjects(
                status,
                m,
                h,
                0,
                { text: '  school  ' },
                undefined,
                namesLower
            ),
        ]).toEqual([3])
    })

    it('treats an empty or whitespace-only query as no filter', () => {
        const all = [...listObjects(status, m, h, 0, {})]
        expect([
            ...listObjects(
                status,
                m,
                h,
                0,
                { text: '' },
                undefined,
                namesLower
            ),
        ]).toEqual(all)
        expect([
            ...listObjects(
                status,
                m,
                h,
                0,
                { text: '   ' },
                undefined,
                namesLower
            ),
        ]).toEqual(all)
    })

    it('matches nothing when names are not loaded, not everything', () => {
        // The worse failure mode: a type whose names have not loaded yet
        // must not read a search as "everything matches".
        expect([
            ...listObjects(status, m, h, 0, { text: 'alpha' }, undefined, null),
        ]).toEqual([])
        expect([
            ...listObjects(
                status,
                m,
                h,
                0,
                { text: 'alpha' },
                undefined,
                undefined
            ),
        ]).toEqual([])
    })

    it('composes with a status filter, narrowing rather than replacing it', () => {
        // Objects 1 (Alpha) and 3 (Alpha School A1) both match "alpha", but
        // only 3 has Status.Ok; 1 is MissingError.
        expect([
            ...listObjects(
                status,
                m,
                h,
                0,
                {
                    text: 'alpha',
                    statuses: [Status.Ok],
                },
                undefined,
                namesLower
            ),
        ]).toEqual([3])
    })

    it('composes with an ancestor filter, narrowing rather than replacing it', () => {
        // "Alpha" matches objects 1, 3, 4; restricting to the subtree
        // rooted at B (object 2) leaves none of them, even though "Beta"
        // (object 2, 5) is under B and matches nothing on its own here.
        expect([
            ...listObjects(
                status,
                m,
                h,
                0,
                {
                    text: 'alpha',
                    ancestor: 2,
                },
                undefined,
                namesLower
            ),
        ]).toEqual([])
        expect([
            ...listObjects(
                status,
                m,
                h,
                0,
                {
                    text: 'beta',
                    ancestor: 2,
                },
                undefined,
                namesLower
            ),
        ]).toEqual([2, 5])
    })

    it('composes with a level filter, narrowing rather than replacing it', () => {
        // "Alpha" matches objects 1 (level 2), 3 and 4 (level 3); the level
        // filter alone would also admit object 2 (Beta, level 3).
        expect([
            ...listObjects(
                status,
                m,
                h,
                0,
                {
                    text: 'alpha',
                    level: 3,
                },
                undefined,
                namesLower
            ),
        ]).toEqual([3, 4])
    })

    it('composes with a group filter, narrowing rather than replacing it', () => {
        // "Alpha" matches objects 1, 3, 4; group -1 ("no group") alone
        // matches 0, 1, 2 (see the "filters by status, level, group and
        // ancestor" test above). Neither predicate alone gives the
        // intersection: only object 1 is both "alpha" and in no group.
        expect([
            ...listObjects(
                status,
                m,
                h,
                0,
                {
                    text: 'alpha',
                    group: -1,
                },
                undefined,
                namesLower
            ),
        ]).toEqual([1])
    })

    it('composes with an ids filter, narrowing rather than replacing it', () => {
        // "Alpha" matches objects 1, 3, 4; restricting ids to 'A' and 'b1'
        // (objects 1 and 5) leaves only their intersection, object 1.
        const idsArr = ['root', 'A', 'B', 'a1', 'a2', 'b1']
        expect([
            ...listObjects(
                status,
                m,
                h,
                0,
                {
                    text: 'alpha',
                    ids: ['A', 'b1'],
                },
                idsArr,
                namesLower
            ),
        ]).toEqual([1])
    })
})

describe('forEachInScope corruption handling', () => {
    it('visits every object at most once in a whole-forest scan, even with an unreachable parent cycle', () => {
        // Node 0 is a real root; nodes 1 and 2 point at each other and are
        // never reached by the depth-first walk (see hierarchy.test.ts's
        // "does not report unreachable (cyclic) nodes" case). A whole-forest
        // scan (scopeRoot -1) must not revisit byOrder's unassigned tail
        // slots as if they were object 0.
        const corrupted = buildHierarchy(
            Int32Array.from([-1, 2, 1]),
            Uint8Array.from([1, 2, 2])
        )
        const cm = buildSetMembership(3, [])
        const cstatus = Uint8Array.from([Status.Ok, Status.Ok, Status.Ok])
        const result = [...listObjects(cstatus, cm, corrupted, -1, {})]
        // Object 0 (the only reachable node) appears at most once; the
        // unreachable nodes 1 and 2 have no valid order position and are
        // not visited.
        expect(result).toEqual([0])
    })
})
