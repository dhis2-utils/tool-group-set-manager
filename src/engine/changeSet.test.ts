import { ChangeSet, GroupChange, invert } from './changeSet'

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
})
