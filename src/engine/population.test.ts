import { buildSetMembership } from './membership'
import { populationFor } from './population'
import { DEFAULT_CONFIG, GroupSetMeta } from './types'

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

describe('populationFor', () => {
    it('org units: everything is in the population', () => {
        const m = buildSetMembership(3, [])
        expect(
            Array.from(populationFor(set({}), 3, m, {}, DEFAULT_CONFIG))
        ).toEqual([1, 1, 1])
    })

    it('indicators: everything is in the population', () => {
        const m = buildSetMembership(2, [])
        expect(
            Array.from(
                populationFor(set({ objectType: 'indicator' }), 2, m, {}, DEFAULT_CONFIG)
            )
        ).toEqual([1, 1])
    })

    it('data elements: aggregate only unless includeTracker', () => {
        const m = buildSetMembership(3, [])
        const attrs = { domainType: Uint8Array.from([1, 2, 1]) }
        const de = set({ objectType: 'dataElement' })
        expect(Array.from(populationFor(de, 3, m, attrs, DEFAULT_CONFIG))).toEqual([1, 0, 1])
        expect(
            Array.from(
                populationFor(de, 3, m, attrs, { ...DEFAULT_CONFIG, includeTracker: true })
            )
        ).toEqual([1, 1, 1])
    })

    it('category options: all options of categories touched by the set', () => {
        // options 0,1 in category 0; options 2,3 in category 1; option 4 in category 2
        // set groups contain option 0 and 2 only
        const m = buildSetMembership(5, [Int32Array.from([0]), Int32Array.from([2])])
        const attrs = {
            categoryOfOption: [
                Int32Array.from([0]),
                Int32Array.from([0]),
                Int32Array.from([1]),
                Int32Array.from([1]),
                Int32Array.from([2]),
            ],
        }
        expect(
            Array.from(
                populationFor(set({ objectType: 'categoryOption' }), 5, m, attrs, DEFAULT_CONFIG)
            )
        ).toEqual([1, 1, 1, 1, 0])
    })
})
