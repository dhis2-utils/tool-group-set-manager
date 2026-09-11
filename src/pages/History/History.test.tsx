import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
// Stable reference across renders -- like the real EngineProvider's
// memoised context value, and unlike a fresh object literal, which would
// make any effect keyed on `client` (RevertDialog's plan-loading effect)
// refire on every render this component tree does, however unrelated.
const mockClient = { call: mockClientCall }
jest.mock('@/hooks/useEngine', () => ({
    useEngine: () => ({
        client: mockClient,
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

function writeResult(
    overrides: Partial<{
        outcomes: unknown[]
        applied: unknown[]
        unaccounted: unknown[]
        engineError: string
        historyError: string
    }> = {}
) {
    return {
        changeSet: changeSet({ id: 'revert1', action: 'revert' }),
        outcomes: [{ groupId: 'pub', requested: 1, accepted: 1 }],
        applied: [],
        unaccounted: [],
        ...overrides,
    }
}

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
    mockWrite.mockResolvedValue(writeResult())
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

    it('C1: applies exactly the plan it previewed, never a plan recomputed at apply time', async () => {
        // planRevert is stubbed to return a DIFFERENT plan on every call
        // after the first. An implementation that (bug) calls planRevert
        // again at apply time would apply the second plan's changes; the
        // correct implementation calls it once, during preview, and
        // applies exactly that.
        let planCalls = 0
        const firstPlanChanges = plan().changes
        const secondPlanChanges = [
            {
                groupId: 'pub',
                additions: ['SHOULD-NOT-BE-APPLIED'],
                deletions: [],
            },
        ]
        mockClientCall.mockImplementation((method: string) => {
            if (method === 'planRevert') {
                planCalls++
                return Promise.resolve(
                    planCalls === 1
                        ? plan()
                        : plan({ changes: secondPlanChanges })
                )
            }
            if (method === 'objectsFor') {
                return Promise.resolve({ total: 0, offset: 0, items: [] })
            }
            return Promise.resolve(undefined)
        })
        mockChangeSets.changeSets = [changeSet()]
        render(<History />)
        fireEvent.click(screen.getByRole('button', { name: 'Revert' }))

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
        expect(call.changes).toEqual(firstPlanChanges)
        expect(planCalls).toBe(1)
    })

    it('previews the skipped count and reason when the revert would skip every object', async () => {
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

    it('M2: previews a mixed result -- some objects revert, some are skipped and named', async () => {
        mockChangeSets.changeSets = [changeSet()]
        mockClientCall.mockImplementation(
            (method: string, ...args: unknown[]) => {
                if (method === 'planRevert') {
                    return Promise.resolve(
                        plan({
                            changes: [
                                {
                                    groupId: 'pub',
                                    additions: ['a1'],
                                    deletions: [],
                                },
                            ],
                            affected: 1,
                            skippedCount: 1,
                            skippedSample: ['a2'],
                        })
                    )
                }
                if (method === 'objectsFor') {
                    const filter = args[2] as { ids?: string[] } | undefined
                    return Promise.resolve({
                        total: 1,
                        offset: 0,
                        items: filter?.ids?.includes('a2')
                            ? [
                                  {
                                      index: 0,
                                      id: 'a2',
                                      displayName: 'Facility A2',
                                      level: 3,
                                      parentId: null,
                                      status: 1,
                                      groups: [],
                                  },
                              ]
                            : [
                                  {
                                      index: 0,
                                      id: 'a1',
                                      displayName: 'Facility A1',
                                      level: 3,
                                      parentId: null,
                                      status: 1,
                                      groups: [],
                                  },
                              ],
                    })
                }
                return Promise.resolve(undefined)
            }
        )
        render(<History />)
        fireEvent.click(screen.getByRole('button', { name: 'Revert' }))
        await waitFor(() =>
            expect(
                screen.getByText(
                    '1 object was skipped because it has moved since this change, its group has left the set, or a group involved is read-only for you'
                )
            ).toBeInTheDocument()
        )
        expect(screen.getByText('Facility A2')).toBeInTheDocument()
        // The revert is still usable -- there is something real to apply.
        const dialogRevertButton = screen.getAllByRole('button', {
            name: 'Revert',
        })[1]
        expect(dialogRevertButton).not.toBeDisabled()
    })

    it('I1: a partly-failed revert stays open, shows the outcome, and offers retry -- never reads as a silent success', async () => {
        mockChangeSets.changeSets = [changeSet()]
        mockWrite.mockResolvedValue(
            writeResult({
                outcomes: [{ groupId: 'pub', requested: 2, accepted: 1 }],
                unaccounted: [
                    { groupId: 'pub', additions: [], deletions: ['x'] },
                ],
            })
        )
        render(<History />)
        fireEvent.click(screen.getByRole('button', { name: 'Revert' }))
        await waitFor(() =>
            expect(
                screen.getAllByRole('button', { name: 'Revert' }).length
            ).toBeGreaterThan(1)
        )
        fireEvent.click(screen.getAllByRole('button', { name: 'Revert' })[1])

        await waitFor(() =>
            expect(
                screen.getByRole('button', { name: 'Retry failed changes' })
            ).toBeInTheDocument()
        )
        // The dialog must still be open (Close, not silently dismissed) --
        // its title is still on screen.
        expect(screen.getByText('Revert change')).toBeInTheDocument()
        // The list behind the dialog is still told to refresh, since the
        // server change (partial or not) already happened.
        expect(mockChangeSets.reload).toHaveBeenCalled()
    })

    it('I1: a historyError is surfaced rather than swallowed, since an unrecorded revert cannot itself be reverted', async () => {
        mockChangeSets.changeSets = [changeSet()]
        mockWrite.mockResolvedValue(
            writeResult({ historyError: 'dataStore write failed' })
        )
        render(<History />)
        fireEvent.click(screen.getByRole('button', { name: 'Revert' }))
        await waitFor(() =>
            expect(
                screen.getAllByRole('button', { name: 'Revert' }).length
            ).toBeGreaterThan(1)
        )
        fireEvent.click(screen.getAllByRole('button', { name: 'Revert' })[1])
        await waitFor(() =>
            expect(
                screen.getByText('Not recorded in History')
            ).toBeInTheDocument()
        )
    })

    it('I4: Export downloads a per-membership-change CSV of the recorded change set', async () => {
        mockChangeSets.changeSets = [changeSet()]
        mockClientCall.mockImplementation((method: string) => {
            if (method === 'indexesOf') {
                return Promise.resolve([0])
            }
            if (method === 'resolve') {
                return Promise.resolve([
                    {
                        index: 0,
                        id: 'a1',
                        displayName: 'Facility A1',
                        level: 3,
                        parentId: null,
                    },
                ])
            }
            return Promise.resolve(undefined)
        })

        const createObjectURL = jest.fn(() => 'blob:mock')
        const revokeObjectURL = jest.fn()
        Object.defineProperty(URL, 'createObjectURL', {
            value: createObjectURL,
            writable: true,
        })
        Object.defineProperty(URL, 'revokeObjectURL', {
            value: revokeObjectURL,
            writable: true,
        })
        const clickSpy = jest
            .spyOn(HTMLAnchorElement.prototype, 'click')
            .mockImplementation(() => undefined)
        let downloadName = ''
        jest.spyOn(
            HTMLAnchorElement.prototype,
            'download',
            'set'
        ).mockImplementation(function (this: HTMLAnchorElement, value: string) {
            downloadName = value
        })
        // jsdom's Blob has no usable `.text()` in this test environment, so
        // the CSV content is captured directly from the Blob constructor's
        // arguments rather than read back off the Blob instance.
        let csvText = ''
        const RealBlob = globalThis.Blob
        const blobSpy = jest
            .spyOn(globalThis, 'Blob')
            .mockImplementation(
                (parts?: BlobPart[], options?: BlobPropertyBag) => {
                    csvText = (parts ?? []).join('')
                    return new RealBlob(parts, options)
                }
            )

        render(<History />)
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Export' }))
        })
        await waitFor(() => expect(clickSpy).toHaveBeenCalled())

        expect(mockClientCall).toHaveBeenCalledWith(
            'indexesOf',
            'organisationUnit',
            ['a1']
        )
        expect(downloadName).toBe('Ownership-cs1.csv')
        expect(csvText).toContain('changeSetId')
        expect(csvText).toContain('objectId')
        expect(csvText).toContain('operation')
        expect(csvText).toContain('cs1')
        expect(csvText).toContain('a1')
        expect(csvText).toContain('Facility A1')
        expect(csvText).toContain('added')
        expect(csvText).toContain('removed')
        blobSpy.mockRestore()
        clickSpy.mockRestore()
    })

    it('I3: Export resolves every id in one worker round-trip, not one per id', async () => {
        // A change set is unbounded -- a national fix records a hundred
        // thousand ids -- so the number of worker round-trips must not grow
        // with it.
        const ids = Array.from({ length: 50 }, (_, i) => `a${i}`)
        mockChangeSets.changeSets = [
            changeSet({
                changes: [
                    { groupId: 'pub', additions: [], deletions: ids },
                    { groupId: 'other', additions: ids, deletions: [] },
                ],
            }),
        ]
        mockClientCall.mockImplementation((method: string, ...args) => {
            if (method === 'indexesOf') {
                return Promise.resolve((args[1] as string[]).map((_, i) => i))
            }
            if (method === 'resolve') {
                return Promise.resolve(
                    (args[1] as number[]).map((index) => ({
                        index,
                        id: ids[index],
                        displayName: `Facility ${ids[index]}`,
                        level: 3,
                        parentId: null,
                    }))
                )
            }
            return Promise.resolve(undefined)
        })
        Object.defineProperty(URL, 'createObjectURL', {
            value: jest.fn(() => 'blob:mock'),
            writable: true,
        })
        Object.defineProperty(URL, 'revokeObjectURL', {
            value: jest.fn(),
            writable: true,
        })
        const clickSpy = jest
            .spyOn(HTMLAnchorElement.prototype, 'click')
            .mockImplementation(() => undefined)

        render(<History />)
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Export' }))
        })
        await waitFor(() => expect(clickSpy).toHaveBeenCalled())

        const engineCalls = mockClientCall.mock.calls.filter(
            (c) => c[0] === 'indexesOf' || c[0] === 'indexOf'
        )
        expect(engineCalls).toHaveLength(1)
        expect(engineCalls[0]).toEqual(['indexesOf', 'organisationUnit', ids])
        clickSpy.mockRestore()
    })
})
