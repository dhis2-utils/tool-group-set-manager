import { buildSetMembership } from './membership'
import { evaluateSet } from './rules'
import { DEFAULT_CONFIG, GroupSetMeta, Status } from './types'

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

// objects: 0 in group A, 1 in A and B, 2 in none, 3 in none (outside population), 4 in B
const m = buildSetMembership(5, [
    Int32Array.from([0, 1]),
    Int32Array.from([1, 4]),
])
const population = Uint8Array.from([1, 1, 1, 0, 1])
const level = Uint8Array.from([3, 3, 3, 2, 2])

describe('evaluateSet', () => {
    it('conflict is always an error, even for plain sets', () => {
        const s = evaluateSet(set({}), m, population, level, DEFAULT_CONFIG)
        expect(s[1]).toBe(Status.Conflict)
        expect(s[0]).toBe(Status.Ok)
        expect(s[2]).toBe(Status.Ok) // missing but set is neither compulsory nor dimension
        expect(s[3]).toBe(Status.NotApplicable)
    })

    it('missing is an error when the set is compulsory', () => {
        const s = evaluateSet(
            set({ compulsory: true }),
            m,
            population,
            level,
            DEFAULT_CONFIG
        )
        expect(s[2]).toBe(Status.MissingError)
        expect(s[3]).toBe(Status.NotApplicable)
    })

    it('missing is a warning when the set is a dimension but not compulsory', () => {
        const s = evaluateSet(
            set({ dataDimension: true }),
            m,
            population,
            level,
            DEFAULT_CONFIG
        )
        expect(s[2]).toBe(Status.MissingWarning)
    })

    it('required levels make missing an error at those levels, and ignore the rest even for a data dimension set', () => {
        // Spec 3.3: required levels on a non-compulsory set make the other
        // levels ignored. A data-dimension set with required levels
        // configured must not fall back to a warning at the levels the
        // config left out -- that would be exactly the noise the admin
        // configured required levels to remove.
        const config = { ...DEFAULT_CONFIG, requiredLevels: { s: [2] } }
        const m2 = buildSetMembership(5, [
            Int32Array.from([0, 1]),
            Int32Array.from([1]),
        ])
        const s = evaluateSet(
            set({ dataDimension: true }),
            m2,
            population,
            level,
            config
        )
        expect(s[4]).toBe(Status.MissingError) // level 2, required
        expect(s[2]).toBe(Status.Ok) // level 3, not required: ignored, not a warning
    })

    it('required levels do not downgrade a compulsory set', () => {
        const config = { ...DEFAULT_CONFIG, requiredLevels: { s: [2] } }
        const s = evaluateSet(
            set({ compulsory: true }),
            m,
            population,
            level,
            config
        )
        expect(s[2]).toBe(Status.MissingError)
    })

    it('works without levels for flat object types', () => {
        const s = evaluateSet(
            set({ objectType: 'dataElement', compulsory: true }),
            m,
            population,
            null,
            DEFAULT_CONFIG
        )
        expect(s[2]).toBe(Status.MissingError)
    })
})
