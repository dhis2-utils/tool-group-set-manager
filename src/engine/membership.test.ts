import { buildSetMembership, groupsOf } from './membership'

describe('buildSetMembership', () => {
    // 6 objects; group 0 = {0,1,4}, group 1 = {1,2}, group 2 = {}
    const m = buildSetMembership(6, [
        Int32Array.from([4, 0, 1]),
        Int32Array.from([2, 1]),
        Int32Array.from([]),
    ])

    it('counts memberships per object', () => {
        expect(Array.from(m.memberCount)).toEqual([1, 2, 1, 0, 1, 0])
    })

    it('resolves the single group, -1 for none and -2 for conflicts', () => {
        expect(Array.from(m.groupOf)).toEqual([0, -2, 1, -1, 0, -1])
    })

    it('stores sorted member lists', () => {
        expect(Array.from(m.groupMembers[0])).toEqual([0, 1, 4])
    })

    it('lists all groups of a conflicting object', () => {
        expect(groupsOf(m, 1)).toEqual([0, 1])
        expect(groupsOf(m, 3)).toEqual([])
        expect(groupsOf(m, 4)).toEqual([0])
    })

    it('saturates memberCount at 255 without wrapping', () => {
        const groups = Array.from({ length: 300 }, () => Int32Array.from([0]))
        const big = buildSetMembership(1, groups)
        expect(big.memberCount[0]).toBe(255)
        expect(big.groupOf[0]).toBe(-2)
    })

    it('does not treat a duplicate member id within one group as a conflict', () => {
        const dup = buildSetMembership(3, [Int32Array.from([0, 0, 1])])
        expect(dup.memberCount[0]).toBe(1)
        expect(dup.groupOf[0]).toBe(0)
    })
})
