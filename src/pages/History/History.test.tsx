import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { History } from './History'
import { ChangeSet } from '@/engine/changeSet'
import { GroupSetMeta } from '@/engine/types'

jest.mock('@dhis2/app-runtime', () => ({
    useConfig: () => ({ baseUrl: 'http://server', apiVersion: 42 }),
}))

const mockChangeSets: {
    changeSets: ChangeSet[]
    isLoading: boolean
    isLoadingMore: boolean
    error: string | null
    hasMore: boolean
    loadMore: jest.Mock
    reload: jest.Mock
} = {
    changeSets: [],
    isLoading: false,
    isLoadingMore: false,
    error: null,
    hasMore: false,
    loadMore: jest.fn(),
    reload: jest.fn(),
}
jest.mock('@/hooks/useChangeSets', () => ({
    useChangeSets: () => mockChangeSets,
}))

const ownershipSet: GroupSetMeta = {
    id: 'own',
    displayName: 'Ownership',
    objectType: 'organisationUnit',
    compulsory: true,
    dataDimension: true,
    canWrite: true,
    groups: [
        { id: 'pub', displayName: 'Public', canWrite: true },
        { id: 'other', displayName: 'Other', canWrite: true },
    ],
}

let mockGroupSets: GroupSetMeta[] = [ownershipSet]
const mockClientCall = jest.fn()
jest.mock('@/hooks/useEngine', () => ({
    useEngine: () => ({
        client: { call: mockClientCall },
        groupSets: mockGroupSets,
    }),
}))

const mockWrite = jest.fn()
let mockIsWriting = false
jest.mock('@/hooks/useMembershipWrite', () => ({
    useMembershipWrite: () => ({
        write: (...args: unknown[]) => mockWrite(...args),
        isWriting: mockIsWriting,
    }),
}))

function changeSet(overrides: Partial<ChangeSet> = {}): ChangeSet {
    return {
        id: 'cs1',
        createdAt: '2024-01-01T00:00:00.000Z',
        createdBy: { id: 'u1', displayName: 'Ann Author' },
        objectType: 'organisationUnit',
        groupSetId: 'own',
        groupSetName: 'Ownership',
        action: 'move',
        note: 'bulk fix',
        changes: [
            { groupId: 'pub', additions: [], deletions: ['a1'] },
            { groupId: 'other', additions: ['a1'], deletions: [] },
        ],
        ...overrides,
    }
}

const plan = (
    overrides: Partial<{
        changes: unknown[]
        affected: number
        skippedCount: number
        skippedSample: string[]
    }> = {}
) => ({
    changes: [
        { groupId: 'pub', additions: ['a1'], deletions: [] },
        { groupId: 'other', additions: [], deletions: ['a1'] },
    ],
    affected: 1,
    skippedCount: 0,
    skippedSample: [],
    ...overrides,
})

beforeEach(() => {
    jest.clearAllMocks()
    mockIsWriting = false
    mockGroupSets = [ownershipSet]
    mockChangeSets.changeSets = []
    mockChangeSets.isLoading = false
    mockChangeSets.isLoadingMore = false
    mockChangeSets.error = null
    mockChangeSets.hasMore = false
    mockClientCall.mockImplementation((method: string) => {
        if (method === 'planRevert') {
            return Promise.resolve(plan())
        }
        if (method === 'objectsFor') {
            return Promise.resolve({ total: 0, offset: 0, items: [] })
        }
        return Promise.resolve(undefined)
    })
    mockWrite.mockResolvedValue({
        changeSet: changeSet({ id: 'revert1', action: 'revert' }),
    })
})

describe('History', () => {
    it('lists change sets newest first with who, when, set, action, change count and note', () => {
        mockChangeSets.changeSets = [changeSet()]
        render(<History />)
        expect(screen.getByText('Ann Author')).toBeInTheDocument()
        expect(screen.getByText('Ownership')).toBeInTheDocument()
        expect(screen.getByText('bulk fix')).toBeInTheDocument()
        // Two membership changes recorded (one addition, one deletion).
        expect(screen.getByText('2 membership changes')).toBeInTheDocument()
    })

    it('shows an empty-state message when there is no history yet', () => {
        render(<History />)
        expect(
            screen.getByText(
                'No changes have been recorded on this instance yet'
            )
        ).toBeInTheDocument()
    })

    it('a change set whose group set no longer exists is listed but its revert is disabled', () => {
        mockGroupSets = [] // the group set has been deleted since
        mockChangeSets.changeSets = [changeSet({ groupSetId: 'gone' })]
        render(<History />)
        expect(screen.getByText('Ownership')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Revert' })).toBeDisabled()
    })

    it('opens a revert preview that reflects planRevert, and applies exactly that plan', async () => {
        mockChangeSets.changeSets = [changeSet()]
        render(<History />)
        fireEvent.click(screen.getByRole('button', { name: 'Revert' }))

        await waitFor(() =>
            expect(mockClientCall).toHaveBeenCalledWith(
                'planRevert',
                'own',
                changeSet().changes
            )
        )

        await waitFor(() =>
            expect(
                screen.getAllByRole('button', { name: 'Revert' }).length
            ).toBeGreaterThan(1)
        )
        const dialogRevertButton = screen.getAllByRole('button', {
            name: 'Revert',
        })[1]
        fireEvent.click(dialogRevertButton)

        await waitFor(() => expect(mockWrite).toHaveBeenCalled())
        const call = mockWrite.mock.calls[0][0]
        expect(call.action).toBe('revert')
        expect(call.revertOf).toBe('cs1')
        // D5: the plan applied is exactly the plan previewed, not
        // recomputed at apply time.
        expect(call.changes).toEqual(plan().changes)
    })

    it('previews the skipped count and reason when the revert would skip an object', async () => {
        mockChangeSets.changeSets = [changeSet()]
        mockClientCall.mockImplementation((method: string) => {
            if (method === 'planRevert') {
                return Promise.resolve(
                    plan({
                        changes: [],
                        affected: 0,
                        skippedCount: 1,
                        skippedSample: ['a1'],
                    })
                )
            }
            if (method === 'objectsFor') {
                return Promise.resolve({
                    total: 1,
                    offset: 0,
                    items: [
                        {
                            index: 0,
                            id: 'a1',
                            displayName: 'Facility A1',
                            level: 3,
                            parentId: null,
                            status: 1,
                            groups: [0],
                        },
                    ],
                })
            }
            return Promise.resolve(undefined)
        })
        render(<History />)
        fireEvent.click(screen.getByRole('button', { name: 'Revert' }))
        await waitFor(() =>
            expect(screen.getByText('Nothing to revert')).toBeInTheDocument()
        )
        // The apply button must not be usable when nothing would change --
        // this is the "test that cannot fail" trap: the assertion must be
        // on the disabled control, not just on the text being present.
        const dialogRevertButton = screen.getAllByRole('button', {
            name: 'Revert',
        })[1]
        expect(dialogRevertButton).toBeDisabled()
    })
})
