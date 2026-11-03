import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { History } from './History'
import type { ChangeSet } from '@/engine/changeSet'
import type { GroupSetMeta } from '@/engine/types'
import { actAndFlush } from '@/testing/actAndFlush'

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
// True in every test but the two that specifically exercise the
// still-loading tri-state: most of this file's tests set up `mockGroupSets`
// as if the engine has already finished its first load.
let mockGroupSetsLoaded = true
let mockEngineError: string | null = null
const mockClientCall = jest.fn()
// Stable reference across renders -- like the real EngineProvider's
// memoised context value, and unlike a fresh object literal, which would
// make any effect keyed on `client` (RevertDialog's plan-loading effect)
// refire on every render this component tree does, however unrelated.
const mockClient = { call: mockClientCall }
const mockReload = jest.fn(() => Promise.resolve(undefined))
jest.mock('@/hooks/useEngine', () => ({
    useEngine: () => ({
        client: mockClient,
        reload: mockReload,
        groupSets: mockGroupSets,
        groupSetsLoaded: mockGroupSetsLoaded,
        error: mockEngineError,
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

// Finding M1: the revert dialog re-reads the touched groups before writing.
// A fake server answering `filter=id:in:[…]` reads from `mockServer`, which
// each test can change; the default agrees with `plan()` below (a1 is in
// "other" and not in "pub"), so nothing has drifted.
let mockServer: Record<string, string[]> = {}
let mockSetProperties = { compulsory: false, dataDimension: true }
const mockFetcher = jest.fn((path: string) => {
    if (path.startsWith('organisationUnitGroupSets/')) {
        return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(mockSetProperties),
        } as unknown as Response)
    }
    const groupId = /Groups\/([^/]+)\//.exec(path)?.[1] ?? ''
    const asked =
        /id:in:\[([^\]]*)\]/.exec(decodeURIComponent(path))?.[1].split(',') ??
        []
    const held = new Set(mockServer[groupId] ?? [])
    return Promise.resolve(
        // jsdom has no `Response`; this is the part of one the reader uses.
        {
            ok: true,
            status: 200,
            json: () =>
                Promise.resolve({
                    organisationUnits: asked
                        .filter((id) => held.has(id))
                        .map((id) => ({ id })),
                }),
        } as unknown as Response
    )
})
jest.mock('@/data/fetcher', () => ({
    createFetcher: () => mockFetcher,
}))

const mockPropertiesWrite = jest.fn()
jest.mock('@/hooks/useSetPropertiesWrite', () => ({
    useSetPropertiesWrite: () => ({
        write: (...args: unknown[]) => mockPropertiesWrite(...args),
        isWriting: false,
    }),
}))

function changeSet(overrides: Partial<ChangeSet> = {}): ChangeSet {
    return {
        id: 'cs1',
        // Inside the 24-hour revert window.
        createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
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
    mockServer = { other: ['a1'] }
    mockSetProperties = { compulsory: false, dataDimension: true }
    mockPropertiesWrite.mockResolvedValue({ changeSet: {} })
    mockIsWriting = false
    mockGroupSets = [ownershipSet]
    mockGroupSetsLoaded = true
    mockEngineError = null
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

    it('a change set older than 24 hours is listed and exportable, but cannot be reverted', () => {
        mockChangeSets.changeSets = [
            changeSet({
                createdAt: new Date(
                    Date.now() - 25 * 60 * 60 * 1000
                ).toISOString(),
            }),
        ]
        render(<History />)
        expect(screen.getByText('Ownership')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled()
        expect(
            screen.queryByRole('button', { name: 'Revert' })
        ).not.toBeInTheDocument()
        expect(
            screen.getByText('Can no longer be reverted (older than 24 hours)')
        ).toBeInTheDocument()
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
        mockGroupSetsLoaded = true // ...and group sets have finished loading
        mockChangeSets.changeSets = [changeSet({ groupSetId: 'gone' })]
        render(<History />)
        expect(screen.getByText('Ownership')).toBeInTheDocument()
        // M12: the reason is visible text, not a tooltip on a disabled
        // button that only a mouse can reach.
        expect(
            screen.queryByRole('button', { name: 'Revert' })
        ).not.toBeInTheDocument()
        expect(
            screen.getByText(
                'This group set no longer exists, so this change cannot be reverted from here'
            )
        ).toBeInTheDocument()
    })

    // The engine has not finished loading, so nothing is known about which
    // group sets exist. "No longer exists" is a claim, and it must not be
    // made on the strength of an array that is empty only because it is
    // unfilled.
    it('does not claim a group set is missing while group sets are still loading', async () => {
        mockGroupSets = []
        mockGroupSetsLoaded = false
        mockChangeSets.changeSets = [changeSet({ groupSetId: 'own' })]
        render(<History />)

        await waitFor(() =>
            expect(screen.getByText('Ownership')).toBeInTheDocument()
        )
        expect(
            screen.queryByText(
                'This group set no longer exists, so this change cannot be reverted from here'
            )
        ).not.toBeInTheDocument()
        // Still waits rather than offering a working Revert.
        expect(screen.getByRole('button', { name: 'Revert' })).toBeDisabled()
    })

    // F1: an errored engine load must not look like "still loading" forever
    // -- the user needs to be told why Revert never becomes available.
    it('tells the user group sets failed to load, rather than waiting forever', async () => {
        mockGroupSets = []
        mockGroupSetsLoaded = false
        mockEngineError = 'Network error'
        mockChangeSets.changeSets = [changeSet({ groupSetId: 'own' })]
        render(<History />)

        await waitFor(() =>
            expect(screen.getByText('Ownership')).toBeInTheDocument()
        )
        expect(
            screen.getByText('Could not load group sets')
        ).toBeInTheDocument()
        expect(screen.getByText('Network error')).toBeInTheDocument()
        expect(
            screen.queryByText(
                'This group set no longer exists, so this change cannot be reverted from here'
            )
        ).not.toBeInTheDocument()
        expect(
            screen.getByText(
                'Group set information could not be loaded, so this change cannot be reverted from here'
            )
        ).toBeInTheDocument()
        expect(
            screen.queryByRole('button', { name: 'Revert' })
        ).not.toBeInTheDocument()
    })

    it('claims it once group sets have loaded and it is genuinely absent', async () => {
        mockGroupSets = []
        mockGroupSetsLoaded = true
        mockChangeSets.changeSets = [changeSet({ groupSetId: 'own' })]
        render(<History />)

        expect(
            await screen.findByText(
                'This group set no longer exists, so this change cannot be reverted from here'
            )
        ).toBeInTheDocument()
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

        // The dialog's own Revert, enabled once its preview has loaded.
        await waitFor(() =>
            expect(
                screen.getAllByRole('button', { name: 'Revert' })[1]
            ).toBeEnabled()
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
        // The dialog's own Revert, enabled once its preview has loaded.
        await waitFor(() =>
            expect(
                screen.getAllByRole('button', { name: 'Revert' })[1]
            ).toBeEnabled()
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
        // The dialog's own Revert, enabled once its preview has loaded.
        await waitFor(() =>
            expect(
                screen.getAllByRole('button', { name: 'Revert' })[1]
            ).toBeEnabled()
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
        ).mockImplementation((value: string) => {
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
        await actAndFlush(() => {
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
        await actAndFlush(() => {
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

describe('History: interrupted writes (M3)', () => {
    it('shows a pending change set as interrupted, with how much was confirmed, and still offers to revert it', () => {
        mockChangeSets.changeSets = [
            changeSet({
                status: 'pending',
                planned: 3,
                changes: [
                    { groupId: 'other', additions: ['a1'], deletions: [] },
                ],
            }),
        ]
        render(<History />)
        expect(
            screen.getByText(
                'Interrupted or still running, 1 of 3 changes confirmed'
            )
        ).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Revert' })).toBeEnabled()
    })

    it('says in words why a pending change set with nothing confirmed cannot be reverted', () => {
        mockChangeSets.changeSets = [
            changeSet({ status: 'pending', planned: 2, changes: [] }),
        ]
        render(<History />)
        expect(
            screen.getByText(
                'Nothing was confirmed before this change stopped, so there is nothing to revert'
            )
        ).toBeInTheDocument()
        expect(
            screen.queryByRole('button', { name: 'Revert' })
        ).not.toBeInTheDocument()
    })
})

describe('History: revert re-checks the server first (M1)', () => {
    it('recomputes and re-confirms instead of writing when the objects changed since the page loaded', async () => {
        // a1 is no longer in "other": someone moved it meanwhile.
        mockServer = { other: [] }
        mockChangeSets.changeSets = [changeSet()]
        render(<History />)
        fireEvent.click(screen.getByRole('button', { name: 'Revert' }))
        await waitFor(() =>
            expect(
                screen.getAllByRole('button', { name: 'Revert' })[1]
            ).toBeEnabled()
        )
        await actAndFlush(() => {
            fireEvent.click(
                screen.getAllByRole('button', { name: 'Revert' })[1]
            )
        })

        expect(
            await screen.findByText(
                'The metadata changed while you were reviewing'
            )
        ).toBeInTheDocument()
        expect(mockWrite).not.toHaveBeenCalled()
        expect(mockClientCall).toHaveBeenCalledWith(
            'applyChangeSet',
            'organisationUnit',
            [{ groupId: 'other', additions: [], deletions: ['a1'] }]
        )
        const planCalls = mockClientCall.mock.calls.filter(
            ([method]) => method === 'planRevert'
        )
        expect(planCalls).toHaveLength(2)

        // Clicking again, with nothing further changed, writes.
        mockServer = { other: ['a1'] }
        await actAndFlush(() => {
            fireEvent.click(
                screen.getAllByRole('button', { name: 'Revert' })[1]
            )
        })
        await waitFor(() => expect(mockWrite).toHaveBeenCalledTimes(1))
    })

    it('writes nothing when the re-read fails', async () => {
        mockFetcher.mockResolvedValueOnce({
            ok: false,
            status: 500,
        } as unknown as Response)
        mockChangeSets.changeSets = [changeSet()]
        render(<History />)
        fireEvent.click(screen.getByRole('button', { name: 'Revert' }))
        await waitFor(() =>
            expect(
                screen.getAllByRole('button', { name: 'Revert' })[1]
            ).toBeEnabled()
        )
        await actAndFlush(() => {
            fireEvent.click(
                screen.getAllByRole('button', { name: 'Revert' })[1]
            )
        })
        expect(
            await screen.findByText('The metadata could not be checked')
        ).toBeInTheDocument()
        expect(mockWrite).not.toHaveBeenCalled()
    })
})

describe('History: group set property changes (M11)', () => {
    const propertiesChange = (overrides: Partial<ChangeSet> = {}) =>
        changeSet({
            id: 'props1',
            action: 'properties',
            note: '',
            changes: [],
            properties: {
                before: { compulsory: true },
                after: { compulsory: false },
            },
            ...overrides,
        })

    it('lists the change with what it changed', () => {
        mockChangeSets.changeSets = [propertiesChange()]
        render(<History />)
        expect(
            screen.getByText('Changed group set properties')
        ).toBeInTheDocument()
        expect(screen.getByText('Compulsory turned off')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Revert' })).toBeEnabled()
    })

    it('reverts by restoring the previous value, recorded as a revert of it', async () => {
        mockChangeSets.changeSets = [propertiesChange()]
        render(<History />)
        fireEvent.click(screen.getByRole('button', { name: 'Revert' }))
        expect(
            await screen.findByText('Compulsory turned on')
        ).toBeInTheDocument()
        await actAndFlush(() => {
            fireEvent.click(
                screen.getAllByRole('button', { name: 'Revert' })[1]
            )
        })

        await waitFor(() => expect(mockPropertiesWrite).toHaveBeenCalled())
        expect(mockPropertiesWrite.mock.calls[0][0]).toMatchObject({
            before: { compulsory: false },
            after: { compulsory: true },
            action: 'revert',
            revertOf: 'props1',
        })
        expect(
            await screen.findByText('The group set was updated on the server.')
        ).toBeInTheDocument()
        expect(mockChangeSets.reload).toHaveBeenCalled()
        expect(mockReload).toHaveBeenCalledWith(false)
    })

    it('leaves a property alone that someone has changed again since', async () => {
        // The server no longer holds the value the change set wrote.
        mockSetProperties = { compulsory: true, dataDimension: true }
        mockChangeSets.changeSets = [propertiesChange()]
        render(<History />)
        fireEvent.click(screen.getByRole('button', { name: 'Revert' }))
        expect(
            await screen.findByText(
                'Compulsory has been changed again since, so it is left as it is'
            )
        ).toBeInTheDocument()
        expect(screen.getByText('Nothing to revert')).toBeInTheDocument()
        expect(
            screen.getAllByRole('button', { name: 'Revert' })[1]
        ).toBeDisabled()
    })

    it('exports a property change as one row per property', async () => {
        mockChangeSets.changeSets = [propertiesChange()]
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
        await actAndFlush(() => {
            fireEvent.click(screen.getByRole('button', { name: 'Export' }))
        })
        await waitFor(() => expect(clickSpy).toHaveBeenCalled())

        expect(csvText).toContain('property')
        expect(csvText).toMatch(/props1.*changed,compulsory,true,false/)
        blobSpy.mockRestore()
        clickSpy.mockRestore()
    })
})
