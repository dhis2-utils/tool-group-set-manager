import { buildSetMembership } from './membership'
import { evaluateSet } from './rules'
import { GroupSetMeta, Status } from './types'

const set = (partial: Partial<GroupSetMeta>): GroupSetMeta => ({
    id: 's',
    displayName: 'S',
    objectType: 'organisationUnit',
    compulsory: false,
    dataDimension: false,
    groups: [],
    canWrite: true,
    ...partial,
})

// objects: 0 in group A, 1 in A and B, 2 in none, 3 in none (outside
// population), 4 in B
const m = buildSetMembership(5, [
    Int32Array.from([0, 1]),
    Int32Array.from([1, 4]),
])
const population = Uint8Array.from([1, 1, 1, 0, 1])

describe('evaluateSet', () => {
    it('conflict is always an error, even for plain sets', () => {
        const s = evaluateSet(set({}), m, population)
        expect(s[1]).toBe(Status.Conflict)
        expect(s[0]).toBe(Status.Ok)
        expect(s[2]).toBe(Status.Ok) // missing, but set is neither compulsory nor a dimension
        expect(s[3]).toBe(Status.NotApplicable)
    })

    it('missing is an error when the set is compulsory', () => {
        const s = evaluateSet(set({ compulsory: true }), m, population)
        expect(s[2]).toBe(Status.MissingError)
        expect(s[3]).toBe(Status.NotApplicable)
    })

    it('missing is a warning when the set is a dimension but not compulsory', () => {
        const s = evaluateSet(set({ dataDimension: true }), m, population)
        expect(s[2]).toBe(Status.MissingWarning)
    })

    it('compulsory wins over data dimension', () => {
        const s = evaluateSet(
            set({ compulsory: true, dataDimension: true }),
            m,
            population
        )
        expect(s[2]).toBe(Status.MissingError)
    })

    // Spec 2026-09-15 §2.1: the rule no longer varies by organisation unit
    // level. An object at level 2 and an object at level 4 with the same
    // membership get the same status, for every kind of set. This is the
    // case the deleted required-levels tests used to own.
    it('does not vary by organisation unit level', () => {
        const deep = buildSetMembership(2, [Int32Array.from([])])
        const s = evaluateSet(
            set({ dataDimension: true }),
            deep,
            Uint8Array.from([1, 1])
        )
        expect(s[0]).toBe(Status.MissingWarning)
        expect(s[1]).toBe(Status.MissingWarning)
    })
})
