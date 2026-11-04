import type { ChangeSet, GroupChange } from './changeSet'
import { invert, sameChanges } from './changeSet'

const base: ChangeSet = {
    id: 'cs1',
    createdAt: '2024-01-01T00:00:00.000Z',
    createdBy: { id: 'u1', displayName: 'A User' },
    objectType: 'organisationUnit',
    groupSetId: 'own',
    groupSetName: 'Ownership',
    action: 'move',
    note: '',
    changes: [],
}

describe('invert', () => {
    it('inverts every group change', () => {
        const changes: GroupChange[] = [
            { groupId: 'a', additions: ['1', '2'], deletions: ['3'] },
            { groupId: 'b', additions: [], deletions: ['4'] },
        ]
        expect(invert({ ...base, changes })).toEqual([
            { groupId: 'a', additions: ['3'], deletions: ['1', '2'] },
            { groupId: 'b', additions: ['4'], deletions: [] },
        ])
    })

    it('inverts an empty change set to an empty list', () => {
        expect(invert({ ...base, changes: [] })).toEqual([])
    })

    it('inverts a move: the same object leaves one group and enters another', () => {
        const changes: GroupChange[] = [
            { groupId: 'source', additions: [], deletions: ['obj1'] },
            { groupId: 'target', additions: ['obj1'], deletions: [] },
        ]
        expect(invert({ ...base, action: 'move', changes })).toEqual([
            { groupId: 'source', additions: ['obj1'], deletions: [] },
            { groupId: 'target', additions: [], deletions: ['obj1'] },
        ])
    })
})

describe('sameChanges', () => {
    const a: GroupChange[] = [
        { groupId: 'g1', additions: ['x', 'y'], deletions: ['z'] },
        { groupId: 'g2', additions: [], deletions: ['w'] },
    ]

    it('is true for the same delta listed in a different order', () => {
        const reordered: GroupChange[] = [
            { groupId: 'g2', additions: [], deletions: ['w'] },
            { groupId: 'g1', additions: ['y', 'x'], deletions: ['z'] },
        ]
        expect(sameChanges(a, reordered)).toBe(true)
    })

    it('is false when one id differs', () => {
        const other: GroupChange[] = [
            { groupId: 'g1', additions: ['x', 'q'], deletions: ['z'] },
            { groupId: 'g2', additions: [], deletions: ['w'] },
        ]
        expect(sameChanges(a, other)).toBe(false)
    })

    it('is false when a group is missing or extra', () => {
        expect(sameChanges(a, a.slice(0, 1))).toBe(false)
        expect(
            sameChanges(a, [
                ...a,
                { groupId: 'g3', additions: ['n'], deletions: [] },
            ])
        ).toBe(false)
    })

    it('is false when an addition became a deletion', () => {
        expect(
            sameChanges(
                [{ groupId: 'g1', additions: ['x'], deletions: [] }],
                [{ groupId: 'g1', additions: [], deletions: ['x'] }]
            )
        ).toBe(false)
    })
})
