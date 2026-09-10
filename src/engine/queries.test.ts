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
const m = buildSetMembership(6, [Int32Array.from([3, 4]), Int32Array.from([4, 5])])
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
        expect(summarize(status, h, 0)).toEqual({
            population: 6,
            ok: 2,
            missingError: 3,
            missingWarning: 0,
            conflict: 1,
        })
        expect(summarize(status, h, 1)).toEqual({
            population: 3,
            ok: 1,
            missingError: 1,
            missingWarning: 0,
            conflict: 1,
        })
    })

    it('ignores NotApplicable objects', () => {
        const s = Uint8Array.from([Status.NotApplicable, Status.Ok])
        expect(summarize(s, null, -1).population).toBe(1)
    })
})

describe('matrix', () => {
    it('one row per org unit at the row level, plus an "above" row', () => {
        const rows = matrix(status, m, h, 0, 2, 2)
        expect(rows).toEqual([
            { object: 1, perGroup: [1, 0], missing: 1, conflict: 1, total: 3 },
            { object: 2, perGroup: [0, 1], missing: 1, conflict: 0, total: 2 },
            { object: -1, perGroup: [0, 0], missing: 1, conflict: 0, total: 1 },
        ])
    })

    it('flat types produce a single row', () => {
        const rows = matrix(status, m, null, -1, 0, 2)
        expect(rows).toEqual([
            { object: -1, perGroup: [1, 1], missing: 3, conflict: 1, total: 6 },
        ])
    })
})

describe('listObjects', () => {
    it('returns indexes in the scope in depth-first order', () => {
        expect(Array.from(listObjects(status, m, h, 0, {}))).toEqual([0, 1, 3, 4, 2, 5])
    })
    it('filters by status, level, group and ancestor', () => {
        expect(Array.from(listObjects(status, m, h, 0, { statuses: [Status.Conflict] }))).toEqual([4])
        expect(Array.from(listObjects(status, m, h, 0, { level: 2 }))).toEqual([1, 2])
        expect(Array.from(listObjects(status, m, h, 0, { group: 1 }))).toEqual([5])
        expect(Array.from(listObjects(status, m, h, 0, { group: -1 }))).toEqual([0, 1, 2])
        expect(Array.from(listObjects(status, m, h, 0, { ancestor: 2 }))).toEqual([2, 5])
    })
    it('works for flat types', () => {
        expect(Array.from(listObjects(status, m, null, -1, { statuses: [Status.Ok] }))).toEqual([3, 5])
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
        const result = Array.from(listObjects(cstatus, cm, corrupted, -1, {}))
        // Object 0 (the only reachable node) appears at most once; the
        // unreachable nodes 1 and 2 have no valid order position and are
        // not visited.
        expect(result).toEqual([0])
    })
})
