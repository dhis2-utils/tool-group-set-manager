import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { BulkFixDialog } from './BulkFixDialog'
import { NAME_OWNED_BY_ANOTHER_SET } from '@/data/metadataWrites'
import { EngineStore } from '@/engine/store'
import { GroupSetMeta, Status } from '@/engine/types'

jest.mock('@dhis2/app-runtime', () => ({
    useConfig: () => ({ baseUrl: 'http://server', apiVersion: 42 }),
}))

// Named mockLoadConfig for continuity with the rest of this file's setup
// (every test still configures it with mockResolvedValue), but it now
// backs useGsiConfig() rather than a direct datastore.loadConfig() call --
// D1 moved BulkFixDialog onto the shared hook, which loads config the same
// asynchronous way and only then reports isLoaded.
const mockLoadConfig = jest.fn()
jest.mock('@/hooks/useGsiConfig', () => {
    const ReactLib = jest.requireActual('react')
    return {
        useGsiConfig: () => {
            const [config, setConfig] = ReactLib.useState({
                catchAllGroup: {},
                includeTracker: false,
            })
            const [isLoaded, setIsLoaded] = ReactLib.useState(false)
            ReactLib.useEffect(() => {
                let cancelled = false
                mockLoadConfig().then((loaded: unknown) => {
                    if (!cancelled) {
                        setConfig(loaded)
                        setIsLoaded(true)
                    }
                })
                return () => {
                    cancelled = true
                }
            }, [])
            return {
                config,
                isLoaded,
                setCatchAllGroup: async () => undefined,
                setIncludeTracker: async () => undefined,
            }
        },
    }
})

const mockCreateCatchAllGroup = jest.fn()
jest.mock('@/data/metadataWrites', () => ({
    // Only the writing half is stubbed. `generateCatchAllNames` is pure and
    // is the single source of the name rule the dialog must prefill with --
    // a stub here would let the dialog and the data layer disagree about
    // what the default name is without any test noticing.
    ...jest.requireActual('@/data/metadataWrites'),
    createCatchAllGroup: (...args: unknown[]) =>
        mockCreateCatchAllGroup(...args),
}))

// babel-plugin-jest-hoist requires an out-of-scope reference used inside a
// jest.mock factory to start with "mock" -- see the matching comment in
// ObjectsTable.test.tsx.
const mockUseEngineQuery = jest.fn()
jest.mock('@/hooks/useEngineQuery', () => ({
    useEngineQuery: (...args: unknown[]) => mockUseEngineQuery(...args),
}))

const mockClientCall = jest.fn()
const mockReload = jest.fn(async () => undefined)
jest.mock('@/hooks/useEngine', () => ({
    useEngine: () => ({ client: { call: mockClientCall }, reload: mockReload }),
}))

const mockWrite = jest.fn()
let mockIsWriting = false
jest.mock('@/hooks/useMembershipWrite', () => ({
    useMembershipWrite: () => ({
        write: (...args: unknown[]) => mockWrite(...args),
        isWriting: mockIsWriting,
    }),
}))

const VIOLATION_STATUSES = [
    Status.MissingError,
    Status.MissingWarning,
    Status.Conflict,
]

const set = {
    id: 'own',
    displayName: 'Ownership',
    objectType: 'organisationUnit' as const,
    compulsory: true,
    dataDimension: true,
    canWrite: true,
    groups: [
        { id: 'g1', displayName: 'Alpha', canWrite: true },
        { id: 'g2', displayName: 'Beta', canWrite: true },
    ],
}

const setWithCatchAllName = {
    ...set,
    groups: [
        { id: 'g1', displayName: 'Alpha', canWrite: true },
        { id: 'g2', displayName: 'Other/unknown Ownership', canWrite: true },
    ],
}

const scope = { objectType: 'organisationUnit' as const, rootId: null }

const plan = (
    overrides: Partial<{
        changes: unknown[]
        affected: number
        skippedCount: number
        skippedSample: string[]
    }> = {}
) => ({
    changes: [],
    affected: 0,
    skippedCount: 0,
    skippedSample: [],
    ...overrides,
})

beforeEach(() => {
    jest.clearAllMocks()
    mockIsWriting = false
    mockLoadConfig.mockResolvedValue({
        catchAllGroup: {},
        includeTracker: false,
    })
    mockUseEngineQuery.mockImplementation((method: string) => {
        if (method === 'planAssignment') {
            return { data: plan(), isLoading: false, error: null }
        }
        if (method === 'objectsFor') {
            return {
                data: { total: 0, offset: 0, items: [] },
                isLoading: false,
                error: null,
            }
        }
        return { data: undefined, isLoading: false, error: null }
    })
})

describe('BulkFixDialog action step', () => {
    it('preselects the catch-all target from the recorded configuration', async () => {
        mockLoadConfig.mockResolvedValue({
            catchAllGroup: { own: 'g2' },
            includeTracker: false,
        })
        render(
            <BulkFixDialog
                set={set}
                scope={scope}
                filter={{}}
                onClose={jest.fn()}
                onApplied={jest.fn()}
            />
        )
        await waitFor(() =>
            expect(screen.getByText('Beta')).toBeInTheDocument()
        )
    })

    it('preselects a group whose name suggests it is a catch-all, when nothing is configured', async () => {
        render(
            <BulkFixDialog
                set={setWithCatchAllName}
                scope={scope}
                filter={{}}
                onClose={jest.fn()}
                onApplied={jest.fn()}
            />
        )
        await waitFor(() =>
            expect(
                screen.getByText('Other/unknown Ownership')
            ).toBeInTheDocument()
        )
    })

    it('preselects nothing and offers to create a catch-all group when the set has no candidate', async () => {
        render(
            <BulkFixDialog
                set={set}
                scope={scope}
                filter={{}}
                onClose={jest.fn()}
                onApplied={jest.fn()}
            />
        )
        await waitFor(() => expect(mockLoadConfig).toHaveBeenCalled())
        expect(
            await screen.findByRole('button', { name: 'Create group' })
        ).toBeInTheDocument()
    })

    // Spec 5.2 (Plan 7 Task 7): the name is the user's to choose, and what
    // they start from must be exactly what the server would otherwise have
    // generated -- so leaving the fields alone is the old behaviour.
    it('prefills both name fields with the generated names', async () => {
        render(
            <BulkFixDialog
                set={set}
                scope={scope}
                filter={{}}
                onClose={jest.fn()}
                onApplied={jest.fn()}
            />
        )
        expect(await screen.findByLabelText('Group name')).toHaveValue(
            'Other/unknown Ownership'
        )
        expect(screen.getByLabelText('Short name')).toHaveValue(
            'Other/unknown Ownership'
        )
    })

    it('passes edited names through to the create call', async () => {
        mockCreateCatchAllGroup.mockResolvedValue({
            id: 'created-id',
            displayName: 'Unclassified facilities',
        })
        render(
            <BulkFixDialog
                set={set}
                scope={scope}
                filter={{}}
                onClose={jest.fn()}
                onApplied={jest.fn()}
            />
        )
        fireEvent.change(await screen.findByLabelText('Group name'), {
            target: { value: 'Unclassified facilities' },
        })
        fireEvent.change(screen.getByLabelText('Short name'), {
            target: { value: 'Unclassified' },
        })
        await act(async () => {
            fireEvent.click(
                screen.getByRole('button', { name: 'Create group' })
            )
        })
        expect(mockCreateCatchAllGroup).toHaveBeenCalledWith(
            expect.anything(),
            set,
            { displayName: 'Unclassified facilities', shortName: 'Unclassified' }
        )
    })

    // Caught before the request, not after a 409 whose body this module
    // would then have to translate.
    it('refuses a short name over 50 characters before any request is made', async () => {
        render(
            <BulkFixDialog
                set={set}
                scope={scope}
                filter={{}}
                onClose={jest.fn()}
                onApplied={jest.fn()}
            />
        )
        fireEvent.change(await screen.findByLabelText('Short name'), {
            target: { value: 'x'.repeat(51) },
        })
        expect(
            screen.getByRole('button', { name: 'Create group' })
        ).toBeDisabled()
        expect(
            screen.getByText('A short name can be at most 50 characters')
        ).toBeInTheDocument()
        expect(mockCreateCatchAllGroup).not.toHaveBeenCalled()
    })

    it('refuses an empty name before any request is made', async () => {
        render(
            <BulkFixDialog
                set={set}
                scope={scope}
                filter={{}}
                onClose={jest.fn()}
                onApplied={jest.fn()}
            />
        )
        fireEvent.change(await screen.findByLabelText('Group name'), {
            target: { value: '   ' },
        })
        expect(
            screen.getByRole('button', { name: 'Create group' })
        ).toBeDisabled()
        expect(mockCreateCatchAllGroup).not.toHaveBeenCalled()
    })

    // The data layer throws a locale-neutral sentinel; this dialog is where
    // it becomes a sentence the user can act on.
    it('renders the cross-set name conflict as a translated sentence, not the raw token', async () => {
        mockCreateCatchAllGroup.mockRejectedValue(
            new Error(NAME_OWNED_BY_ANOTHER_SET)
        )
        render(
            <BulkFixDialog
                set={set}
                scope={scope}
                filter={{}}
                onClose={jest.fn()}
                onApplied={jest.fn()}
            />
        )
        const createButton = await screen.findByRole('button', {
            name: 'Create group',
        })
        await act(async () => {
            fireEvent.click(createButton)
        })
        expect(
            await screen.findByText(
                'A group with this name already belongs to a different group set. Choose another name — one group must not be shared between two sets.'
            )
        ).toBeInTheDocument()
        expect(
            screen.queryByText(NAME_OWNED_BY_ANOTHER_SET)
        ).not.toBeInTheDocument()
    })

    it('creating the catch-all group selects it as the target', async () => {
        mockCreateCatchAllGroup.mockResolvedValue({
            id: 'created-id',
            displayName: 'Other/unknown Ownership',
        })
        render(
            <BulkFixDialog
                set={set}
                scope={scope}
                filter={{}}
                onClose={jest.fn()}
                onApplied={jest.fn()}
            />
        )
        const createButton = await screen.findByRole('button', {
            name: 'Create group',
        })
        await act(async () => {
            fireEvent.click(createButton)
        })
        await waitFor(() =>
            expect(
                screen.getByText('Other/unknown Ownership')
            ).toBeInTheDocument()
        )
    })

    it('reloads the engine snapshot after creating the catch-all group (I7) -- otherwise the new group stays unknown to planAssignment for the rest of the session', async () => {
        mockCreateCatchAllGroup.mockResolvedValue({
            id: 'created-id',
            displayName: 'Other/unknown Ownership',
        })
        render(
            <BulkFixDialog
                set={set}
                scope={scope}
                filter={{}}
                onClose={jest.fn()}
                onApplied={jest.fn()}
            />
        )
        const createButton = await screen.findByRole('button', {
            name: 'Create group',
        })
        await act(async () => {
            fireEvent.click(createButton)
        })
        await waitFor(() => expect(mockReload).toHaveBeenCalledWith(false))
    })

    it('choosing "assign all to one group" changes the computed plan accordingly', async () => {
        mockLoadConfig.mockResolvedValue({
            catchAllGroup: { own: 'g2' },
            includeTracker: false,
        })
        render(
            <BulkFixDialog
                set={set}
                scope={scope}
                filter={{}}
                onClose={jest.fn()}
                onApplied={jest.fn()}
            />
        )
        await waitFor(() =>
            expect(screen.getByText('Beta')).toBeInTheDocument()
        )

        fireEvent.click(screen.getByLabelText(/assign all to one group/i))
        // Switching to "assign all" must not keep the catch-all's
        // preselected target: nothing is chosen until the user picks one.
        expect(screen.getByRole('button', { name: /next/i })).toBeDisabled()

        // Pick Alpha as the single target for "assign all".
        fireEvent.click(screen.getByText(/choose group|choose target group/i))
        fireEvent.click(screen.getByText('Alpha'))

        fireEvent.click(screen.getByRole('button', { name: /next/i }))
        // The assertion is made where a miss fails loudly (a `waitFor`
        // matcher), not inside a mock factory that could silently never
        // run again if the call shape changed underneath it.
        await waitFor(() =>
            expect(mockUseEngineQuery).toHaveBeenCalledWith(
                'planAssignment',
                expect.arrayContaining(['g1']), // Alpha's id, not the catch-all
                true
            )
        )
        // "assign all" keeps the full filter it was opened with -- no
        // forced violation-only restriction (that is "move to catch-all"
        // only, see the Critical-fix describe block below).
        expect(mockUseEngineQuery).toHaveBeenCalledWith(
            'planAssignment',
            ['own', scope, {}, 'g1'],
            true
        )
    })
})

describe('BulkFixDialog preview step', () => {
    async function goToPreview(targetLabel: string, selection?: string[]) {
        mockLoadConfig.mockResolvedValue({
            catchAllGroup: { own: 'g2' },
            includeTracker: false,
        })
        render(
            <BulkFixDialog
                set={set}
                scope={scope}
                filter={{}}
                selection={selection}
                onClose={jest.fn()}
                onApplied={jest.fn()}
            />
        )
        await waitFor(() =>
            expect(screen.getByText(targetLabel)).toBeInTheDocument()
        )
        fireEvent.click(screen.getByRole('button', { name: /next/i }))
    }

    it("shows a headline count equal to the plan's own affected count (I1)", async () => {
        mockUseEngineQuery.mockImplementation((method: string) => {
            if (method === 'planAssignment') {
                return {
                    data: plan({
                        changes: [
                            {
                                groupId: 'g2',
                                additions: ['a1', 'a2', 'a3'],
                                deletions: [],
                            },
                        ],
                        affected: 3,
                    }),
                    isLoading: false,
                    error: null,
                }
            }
            return {
                data: { total: 3, offset: 0, items: [] },
                isLoading: false,
                error: null,
            }
        })
        await goToPreview('Beta', ['a1', 'a2', 'a3'])
        expect(await screen.findByText('3 objects')).toBeInTheDocument()
    })

    it("does not show the population total as the headline when it exceeds the plan's affected count (I1)", async () => {
        mockUseEngineQuery.mockImplementation((method: string) => {
            if (method === 'planAssignment') {
                return {
                    data: plan({
                        changes: [
                            { groupId: 'g2', additions: ['a1'], deletions: [] },
                        ],
                        affected: 1,
                    }),
                    isLoading: false,
                    error: null,
                }
            }
            return {
                data: { total: 10, offset: 0, items: [] },
                isLoading: false,
                error: null,
            }
        })
        await goToPreview('Beta')
        expect(await screen.findByText('1 object')).toBeInTheDocument()
        expect(
            screen.getByText(/10 objects match this view/)
        ).toBeInTheDocument()
    })

    it("passes planAssignment's own changes into ChangeSetPreview (I2)", async () => {
        mockUseEngineQuery.mockImplementation((method: string) => {
            if (method === 'planAssignment') {
                return {
                    data: plan({
                        changes: [
                            {
                                groupId: 'g2',
                                additions: ['a1', 'a2', 'a3', 'a4'],
                                deletions: [],
                            },
                        ],
                        affected: 4,
                    }),
                    isLoading: false,
                    error: null,
                }
            }
            return {
                data: { total: 4, offset: 0, items: [] },
                isLoading: false,
                error: null,
            }
        })
        await goToPreview('Beta')
        // A stub that ignored `planAssignment` entirely would never render
        // this -- it comes straight from `plan.changes[0]`.
        expect(await screen.findByText('+4 / -0')).toBeInTheDocument()
    })

    // m3 (final review): Task 6 moved `text` into the `ObjectFilter` that
    // `ObjectsTab` owns and `BulkFixDialog` reads its population from, but
    // the move-to-catch-all notice still said only "whatever filter this
    // was opened with" -- true of status/level/group/ancestor, which are
    // visible as dropdown selections on the Objects tab the user just came
    // from, but the search box's value is not shown anywhere in this
    // dialog. Nothing wrong is written (the preview enumerates every
    // affected object either way), but the label was silently wrong about
    // what "this view" means.
    it('names the active search term in the move-to-catch-all notice when a text filter is in play', async () => {
        mockLoadConfig.mockResolvedValue({
            catchAllGroup: { own: 'g2' },
            includeTracker: false,
        })
        mockUseEngineQuery.mockImplementation((method: string) => {
            if (method === 'planAssignment') {
                return {
                    data: plan({ affected: 0 }),
                    isLoading: false,
                    error: null,
                }
            }
            return {
                data: { total: 0, offset: 0, items: [] },
                isLoading: false,
                error: null,
            }
        })
        render(
            <BulkFixDialog
                set={set}
                scope={scope}
                filter={{ text: 'Bo' }}
                onClose={jest.fn()}
                onApplied={jest.fn()}
            />
        )
        await waitFor(() =>
            expect(screen.getByText('Beta')).toBeInTheDocument()
        )
        fireEvent.click(screen.getByRole('button', { name: /next/i }))

        expect(
            await screen.findByText(/matching the search term Bo/)
        ).toBeInTheDocument()
    })

    it('says the notice applies to whatever filter this was opened with when there is no text filter', async () => {
        mockUseEngineQuery.mockImplementation((method: string) => {
            if (method === 'planAssignment') {
                return {
                    data: plan({ affected: 0 }),
                    isLoading: false,
                    error: null,
                }
            }
            return {
                data: { total: 0, offset: 0, items: [] },
                isLoading: false,
                error: null,
            }
        })
        await goToPreview('Beta')
        expect(
            screen.getByText(/whatever filter this was opened with/)
        ).toBeInTheDocument()
        expect(screen.queryByText(/search term/)).not.toBeInTheDocument()
    })

    it('downloads the full list as CSV, sanitising the group set name for the filename (M8)', async () => {
        mockUseEngineQuery.mockImplementation((method: string) => {
            if (method === 'planAssignment') {
                return {
                    data: plan({ affected: 0 }),
                    isLoading: false,
                    error: null,
                }
            }
            return {
                data: { total: 0, offset: 0, items: [] },
                isLoading: false,
                error: null,
            }
        })
        mockClientCall.mockResolvedValue({
            total: 1,
            offset: 0,
            items: [
                {
                    index: 0,
                    id: 'a1',
                    displayName: 'A1',
                    level: 3,
                    parentId: null,
                    status: 1,
                    groups: [0],
                },
            ],
        })
        const createObjectURL = jest.fn(() => 'blob:mock')
        const revokeObjectURL = jest.fn()
        // jsdom has no real Blob URL support; substitute both statics so the
        // download path can run end to end without touching the network.
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

        await goToPreview('Beta')
        const downloadButton = await screen.findByRole('button', {
            name: /download.*csv/i,
        })
        await act(async () => {
            fireEvent.click(downloadButton)
        })

        await waitFor(() => expect(clickSpy).toHaveBeenCalled())
        expect(mockClientCall).toHaveBeenCalledWith(
            'objectsFor',
            'own',
            scope,
            // Default action is "move to catch-all": the population is
            // restricted to violation statuses regardless of the `{}`
            // filter the dialog was opened with (the Critical fix).
            { statuses: VIOLATION_STATUSES },
            0,
            expect.any(Number)
        )
        expect(downloadName).toBe('Ownership.csv')
        clickSpy.mockRestore()
    })

    it('builds the After lookup once for the whole export, not once per row (I2)', async () => {
        // The cost of the CSV must not grow with population x changed ids:
        // on the 200k-org-unit instance this app targets, a per-row
        // `Array.includes` over the change's id arrays is ~99 s of blocking
        // main-thread work. Counting the scans is what pins that -- a
        // prepared lookup scans each change's arrays a fixed number of
        // times regardless of how many rows the export pages through.
        let includesCalls = 0
        const counted = (ids: string[]): string[] => {
            const arr = [...ids]
            Object.defineProperty(arr, 'includes', {
                value: (...args: [string]) => {
                    includesCalls += 1
                    return Array.prototype.includes.apply(arr, args)
                },
            })
            return arr
        }
        const changes = [
            {
                groupId: 'g2',
                additions: counted(['a1', 'a2', 'a3']),
                deletions: counted(['a4']),
            },
        ]
        mockUseEngineQuery.mockImplementation((method: string) => {
            if (method === 'planAssignment') {
                return {
                    data: plan({ changes, affected: 3 }),
                    isLoading: false,
                    error: null,
                }
            }
            return {
                data: { total: 0, offset: 0, items: [] },
                isLoading: false,
                error: null,
            }
        })
        const rows = Array.from({ length: 20 }, (_, i) => ({
            index: i,
            id: `a${i}`,
            displayName: `A${i}`,
            level: 3,
            parentId: null,
            status: 1,
            groups: [0],
        }))
        mockClientCall.mockResolvedValue({ total: 20, offset: 0, items: rows })
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

        await goToPreview('Beta')
        includesCalls = 0
        await act(async () => {
            fireEvent.click(
                await screen.findByRole('button', { name: /download.*csv/i })
            )
        })
        await waitFor(() => expect(clickSpy).toHaveBeenCalled())

        // One change, twenty rows: a per-row scan would be 40.
        expect(includesCalls).toBeLessThanOrEqual(2)
        clickSpy.mockRestore()
    })
})

describe('BulkFixDialog Critical fix: move-to-catch-all never touches a correctly categorised object', () => {
    function buildRealStore(): { store: EngineStore; testSet: GroupSetMeta } {
        const testSet: GroupSetMeta = {
            id: 'own',
            displayName: 'Ownership',
            objectType: 'organisationUnit',
            compulsory: true,
            dataDimension: true,
            canWrite: true,
            groups: [
                { id: 'alpha', displayName: 'Alpha', canWrite: true },
                {
                    id: 'other',
                    displayName: 'Other/unknown Ownership',
                    canWrite: true,
                },
            ],
        }
        const store = new EngineStore()
        store.loadObjects({
            objectType: 'organisationUnit',
            ids: ['ok1', 'missing1', 'conflict1'],
            names: ['OK1', 'Missing1', 'Conflict1'],
            level: null,
            parentIds: null,
            domainType: null,
            categoryIdsOfOption: null,
        })
        store.setGroupSets([testSet])
        store.loadMemberships({
            objectType: 'organisationUnit',
            groups: [
                { groupId: 'alpha', memberIds: ['ok1', 'conflict1'] },
                { groupId: 'other', memberIds: ['conflict1'] },
            ],
        })
        store.evaluate()
        return { store, testSet }
    }

    it('opening over a filter matching both OK and violating objects, and choosing move-to-catch-all, never touches the OK object', async () => {
        const { store, testSet } = buildRealStore()
        let lastPlan: ReturnType<EngineStore['planAssignment']> | undefined
        let lastPlanFilter: unknown
        let lastObjectsForFilter: unknown
        mockUseEngineQuery.mockImplementation(
            (method: string, args: unknown[], enabled?: boolean) => {
                if (!enabled) {
                    return { data: undefined, isLoading: false, error: null }
                }
                if (method === 'planAssignment') {
                    const result = store.planAssignment(
                        args[0] as string,
                        args[1] as Parameters<EngineStore['planAssignment']>[1],
                        args[2] as Parameters<EngineStore['planAssignment']>[2],
                        args[3] as string
                    )
                    lastPlan = result
                    lastPlanFilter = args[2] as Parameters<
                        EngineStore['planAssignment']
                    >[2]
                    return { data: result, isLoading: false, error: null }
                }
                if (method === 'objectsFor') {
                    const result = store.objectsFor(
                        args[0] as string,
                        args[1] as Parameters<EngineStore['objectsFor']>[1],
                        args[2] as Parameters<EngineStore['objectsFor']>[2],
                        args[3] as number,
                        args[4] as number
                    )
                    lastObjectsForFilter = args[2] as Parameters<
                        EngineStore['objectsFor']
                    >[2]
                    return { data: result, isLoading: false, error: null }
                }
                return { data: undefined, isLoading: false, error: null }
            }
        )
        // No name match ("Other/unknown Ownership" matches, so it is
        // preselected) and no configured mapping -- default action is
        // already "move to catch-all".
        render(
            <BulkFixDialog
                set={testSet}
                scope={scope}
                // A filter matching everything: OK, missing and conflict.
                filter={{}}
                onClose={jest.fn()}
                onApplied={jest.fn()}
            />
        )
        await waitFor(() =>
            expect(
                screen.getByText('Other/unknown Ownership')
            ).toBeInTheDocument()
        )
        fireEvent.click(screen.getByRole('button', { name: /next/i }))

        await waitFor(() => expect(lastPlan).toBeDefined())
        expect(lastPlan!.changes.some((c) => c.additions.includes('ok1'))).toBe(
            false
        )
        expect(lastPlan!.changes.some((c) => c.deletions.includes('ok1'))).toBe(
            false
        )
        // The violations are still acted on: missing1 is added to the
        // catch-all, and conflict1 (alpha + other already) loses its
        // now-redundant alpha membership.
        const otherChange = lastPlan!.changes.find((c) => c.groupId === 'other')
        expect(otherChange?.additions).toEqual(['missing1'])
        const alphaChange = lastPlan!.changes.find((c) => c.groupId === 'alpha')
        expect(alphaChange?.deletions).toEqual(['conflict1'])
        // I5: the plan and the sample read the very same population
        // definition -- not just equivalent filters computed twice.
        expect(lastObjectsForFilter).toBeDefined()
        expect(lastPlanFilter).toEqual(lastObjectsForFilter)
    })

    it('a selection containing both a violating and a correctly categorised object never touches the correct one (fix round 2)', async () => {
        // Fix round 2's own regression case: before this round,
        // `planAssignment` took `selection` as a separate parameter that
        // *replaced* the filter outright, so the forced violation-only
        // restriction below never applied to a selection at all -- this
        // failed against the pre-fix `store.ts` (the OK object was pulled
        // out of `alpha` and into `other`). It passes now because
        // `selection` is folded into `filter.ids`, which narrows the
        // filter instead of bypassing it.
        const { store, testSet } = buildRealStore()
        let lastPlan: ReturnType<EngineStore['planAssignment']> | undefined
        mockUseEngineQuery.mockImplementation(
            (method: string, args: unknown[], enabled?: boolean) => {
                if (!enabled) {
                    return { data: undefined, isLoading: false, error: null }
                }
                if (method === 'planAssignment') {
                    const result = store.planAssignment(
                        args[0] as string,
                        args[1] as Parameters<EngineStore['planAssignment']>[1],
                        args[2] as Parameters<EngineStore['planAssignment']>[2],
                        args[3] as string
                    )
                    lastPlan = result
                    return { data: result, isLoading: false, error: null }
                }
                if (method === 'objectsFor') {
                    const result = store.objectsFor(
                        args[0] as string,
                        args[1] as Parameters<EngineStore['objectsFor']>[1],
                        args[2] as Parameters<EngineStore['objectsFor']>[2],
                        args[3] as number,
                        args[4] as number
                    )
                    return { data: result, isLoading: false, error: null }
                }
                return { data: undefined, isLoading: false, error: null }
            }
        )
        render(
            <BulkFixDialog
                set={testSet}
                scope={scope}
                filter={{}}
                selection={['ok1', 'missing1']}
                onClose={jest.fn()}
                onApplied={jest.fn()}
            />
        )
        await waitFor(() =>
            expect(
                screen.getByText('Other/unknown Ownership')
            ).toBeInTheDocument()
        )
        fireEvent.click(screen.getByRole('button', { name: /next/i }))

        await waitFor(() => expect(lastPlan).toBeDefined())
        expect(lastPlan!.changes.some((c) => c.additions.includes('ok1'))).toBe(
            false
        )
        expect(lastPlan!.changes.some((c) => c.deletions.includes('ok1'))).toBe(
            false
        )
        const otherChange = lastPlan!.changes.find((c) => c.groupId === 'other')
        expect(otherChange?.additions).toEqual(['missing1'])
    })

    it('a selection and a filter that disagree narrow to their intersection, and the plan/sample agree on it', async () => {
        // `alpha`'s only members are ok1 and conflict1; the selection below
        // additionally names missing1, which is not in alpha at all. The
        // intersection of "in alpha" and "{ok1, missing1}" is just ok1 --
        // and since move-to-catch-all also forces violation statuses only,
        // and ok1 is not a violation, the true population is empty.
        const { store, testSet } = buildRealStore()
        let lastPlan: ReturnType<EngineStore['planAssignment']> | undefined
        let lastSampleTotal: number | undefined
        mockUseEngineQuery.mockImplementation(
            (method: string, args: unknown[], enabled?: boolean) => {
                if (!enabled) {
                    return { data: undefined, isLoading: false, error: null }
                }
                if (method === 'planAssignment') {
                    const result = store.planAssignment(
                        args[0] as string,
                        args[1] as Parameters<EngineStore['planAssignment']>[1],
                        args[2] as Parameters<EngineStore['planAssignment']>[2],
                        args[3] as string
                    )
                    lastPlan = result
                    return { data: result, isLoading: false, error: null }
                }
                if (method === 'objectsFor') {
                    const result = store.objectsFor(
                        args[0] as string,
                        args[1] as Parameters<EngineStore['objectsFor']>[1],
                        args[2] as Parameters<EngineStore['objectsFor']>[2],
                        args[3] as number,
                        args[4] as number
                    )
                    lastSampleTotal = result.total
                    return { data: result, isLoading: false, error: null }
                }
                return { data: undefined, isLoading: false, error: null }
            }
        )
        render(
            <BulkFixDialog
                set={testSet}
                scope={scope}
                filter={{ group: 0 }} // Alpha only: ok1, conflict1
                selection={['ok1', 'missing1']}
                onClose={jest.fn()}
                onApplied={jest.fn()}
            />
        )
        await waitFor(() =>
            expect(
                screen.getByText('Other/unknown Ownership')
            ).toBeInTheDocument()
        )
        fireEvent.click(screen.getByRole('button', { name: /next/i }))

        await waitFor(() => expect(lastPlan).toBeDefined())
        expect(lastPlan!.affected).toBe(0)
        expect(lastPlan!.changes).toEqual([])
        expect(lastSampleTotal).toBe(0)
    })

    it('a selection narrows the plan to just the selected ids, not every violation (guards against dropping the narrowing entirely)', async () => {
        // Regression guard for the carried-forward review note: if the
        // dialog stopped folding `selection` into `populationFilter.ids`
        // altogether, this test's population would be every violation
        // (missing1 AND conflict1) instead of just the selected missing1,
        // and the assertion on `alphaChange` below would fail -- unlike the
        // other selection tests above, this one does not rely on the
        // selected ids also being the only violations, so a dialog that
        // silently ignored `selection` cannot pass it by accident.
        const { store, testSet } = buildRealStore()
        let lastPlan: ReturnType<EngineStore['planAssignment']> | undefined
        mockUseEngineQuery.mockImplementation(
            (method: string, args: unknown[], enabled?: boolean) => {
                if (!enabled) {
                    return { data: undefined, isLoading: false, error: null }
                }
                if (method === 'planAssignment') {
                    const result = store.planAssignment(
                        args[0] as string,
                        args[1] as Parameters<EngineStore['planAssignment']>[1],
                        args[2] as Parameters<EngineStore['planAssignment']>[2],
                        args[3] as string
                    )
                    lastPlan = result
                    return { data: result, isLoading: false, error: null }
                }
                if (method === 'objectsFor') {
                    const result = store.objectsFor(
                        args[0] as string,
                        args[1] as Parameters<EngineStore['objectsFor']>[1],
                        args[2] as Parameters<EngineStore['objectsFor']>[2],
                        args[3] as number,
                        args[4] as number
                    )
                    return { data: result, isLoading: false, error: null }
                }
                return { data: undefined, isLoading: false, error: null }
            }
        )
        render(
            <BulkFixDialog
                set={testSet}
                scope={scope}
                filter={{}}
                selection={['missing1']}
                onClose={jest.fn()}
                onApplied={jest.fn()}
            />
        )
        await waitFor(() =>
            expect(
                screen.getByText('Other/unknown Ownership')
            ).toBeInTheDocument()
        )
        fireEvent.click(screen.getByRole('button', { name: /next/i }))

        await waitFor(() => expect(lastPlan).toBeDefined())
        const otherChange = lastPlan!.changes.find((c) => c.groupId === 'other')
        expect(otherChange?.additions).toEqual(['missing1'])
        // conflict1 is a real violation too, but it was not in the
        // selection -- a dialog that ignored `selection` would still move
        // it out of alpha here.
        const alphaChange = lastPlan!.changes.find((c) => c.groupId === 'alpha')
        expect(alphaChange).toBeUndefined()
    })
})

describe('BulkFixDialog apply step', () => {
    const setForApply: GroupSetMeta = {
        id: 'own',
        displayName: 'Ownership',
        objectType: 'organisationUnit',
        compulsory: true,
        dataDimension: true,
        canWrite: true,
        groups: [
            { id: 'g1', displayName: 'Alpha', canWrite: true },
            { id: 'g2', displayName: 'Beta', canWrite: true },
        ],
    }

    const changes = [{ groupId: 'g2', additions: ['a1', 'a2'], deletions: [] }]

    async function goToApply(
        onApplied = jest.fn(),
        planChanges: typeof changes = changes
    ) {
        mockLoadConfig.mockResolvedValue({
            catchAllGroup: { own: 'g2' },
            includeTracker: false,
        })
        mockUseEngineQuery.mockImplementation((method: string) => {
            if (method === 'planAssignment') {
                return {
                    data: plan({ changes: planChanges, affected: 2 }),
                    isLoading: false,
                    error: null,
                }
            }
            return {
                data: { total: 2, offset: 0, items: [] },
                isLoading: false,
                error: null,
            }
        })
        render(
            <BulkFixDialog
                set={setForApply}
                scope={scope}
                filter={{}}
                onClose={jest.fn()}
                onApplied={onApplied}
            />
        )
        await waitFor(() =>
            expect(screen.getByText('Beta')).toBeInTheDocument()
        )
        fireEvent.click(screen.getByRole('button', { name: /next/i }))
        const additions = planChanges.reduce(
            (n, c) => n + c.additions.length,
            0
        )
        const deletions = planChanges.reduce(
            (n, c) => n + c.deletions.length,
            0
        )
        await screen.findByText(`+${additions} / -${deletions}`)
        return screen.getByRole('button', { name: /^apply/i })
    }

    it('applying calls the write hook with exactly the change the preview showed', async () => {
        mockWrite.mockResolvedValue({
            outcomes: [{ groupId: 'g2', requested: 2, accepted: 2 }],
            applied: changes,
            unaccounted: [],
            changeSet: {} as never,
        })
        const applyButton = await goToApply()
        await act(async () => {
            fireEvent.click(applyButton)
        })
        expect(mockWrite).toHaveBeenCalledWith(
            expect.objectContaining({
                set: setForApply,
                changes,
                targetGroupId: 'g2',
            })
        )
    })

    // Fix round 1, I3: the previous version of this test used the same
    // mocked `plan` object for every `planAssignment` call, so a dialog
    // that recomputed the plan at apply time (bypassing the snapshot the
    // preview actually rendered) would still pass -- the recompute would
    // just return the identical object. Here the mock's own return value
    // changes to a second, different plan *before* Apply is clicked but
    // *without* an intervening render (nothing between the switch and the
    // click causes React to re-render) -- simulating a background
    // `planAssignment` requery landing right after the preview was shown.
    // `handleApply`'s closure was created on the last committed render, so
    // it can only see this second plan if something reads fresh data at
    // click time instead of using the `plan` already in scope.
    it("applies the plan the preview actually rendered, not a plan recomputed later (I3 -- guards against the vacuous 'same object every call' mock)", async () => {
        const changesA = [
            { groupId: 'g2', additions: ['a1', 'a2'], deletions: [] },
        ]
        const changesB = [{ groupId: 'g1', additions: ['zzz'], deletions: [] }]
        let currentChanges: typeof changesA | typeof changesB = changesA
        mockLoadConfig.mockResolvedValue({
            catchAllGroup: { own: 'g2' },
            includeTracker: false,
        })
        mockUseEngineQuery.mockImplementation((method: string) => {
            if (method === 'planAssignment') {
                return {
                    data: plan({ changes: currentChanges, affected: 2 }),
                    isLoading: false,
                    error: null,
                }
            }
            return {
                data: { total: 2, offset: 0, items: [] },
                isLoading: false,
                error: null,
            }
        })
        mockWrite.mockResolvedValue({
            outcomes: [{ groupId: 'g2', requested: 2, accepted: 2 }],
            applied: changesA,
            unaccounted: [],
            changeSet: {} as never,
        })
        render(
            <BulkFixDialog
                set={setForApply}
                scope={scope}
                filter={{}}
                onClose={jest.fn()}
                onApplied={jest.fn()}
            />
        )
        await waitFor(() =>
            expect(screen.getByText('Beta')).toBeInTheDocument()
        )
        fireEvent.click(screen.getByRole('button', { name: /next/i }))
        // Confirms the screen genuinely rendered plan A before the switch.
        await screen.findByText('+2 / -0')

        currentChanges = changesB
        const applyButton = screen.getByRole('button', { name: /^apply/i })
        await act(async () => {
            fireEvent.click(applyButton)
        })

        expect(mockWrite).toHaveBeenCalledWith(
            expect.objectContaining({ changes: changesA })
        )
        expect(mockWrite).not.toHaveBeenCalledWith(
            expect.objectContaining({ changes: changesB })
        )
    })

    it('reports progress per batch while a write is in flight', async () => {
        let resolveWrite!: (value: unknown) => void
        mockIsWriting = true
        mockWrite.mockImplementation(
            (input: { onProgress?: (d: number, t: number) => void }) => {
                // Four-figure batch counts on purpose: this is also the
                // only place the progress line's thousands separators are
                // exercised, and 1/2 would pass whether or not they are
                // applied (task 8, minor 8).
                input.onProgress?.(1200, 2400)
                return new Promise((resolve) => {
                    resolveWrite = resolve
                })
            }
        )
        const applyButton = await goToApply()
        fireEvent.click(applyButton)
        await waitFor(() =>
            expect(screen.getByText(/1,200 of 2,400/)).toBeInTheDocument()
        )
        mockIsWriting = false
        await act(async () => {
            resolveWrite({
                outcomes: [{ groupId: 'g2', requested: 2, accepted: 2 }],
                applied: changes,
                unaccounted: [],
                changeSet: {} as never,
            })
        })
    })

    it('lists a fully applied group and a partially accepted group with distinct wording, never calling the partial one a success', async () => {
        mockWrite.mockResolvedValue({
            outcomes: [
                { groupId: 'g1', requested: 5, accepted: 5 },
                { groupId: 'g2', requested: 3, accepted: 2 },
            ],
            applied: [{ groupId: 'g1', additions: [], deletions: [] }],
            unaccounted: [{ groupId: 'g2', additions: ['a1'], deletions: [] }],
            changeSet: {} as never,
        })
        const applyButton = await goToApply()
        await act(async () => {
            fireEvent.click(applyButton)
        })
        await waitFor(() =>
            expect(screen.getByText(/Alpha/)).toBeInTheDocument()
        )
        expect(
            screen.getByText(/All changes applied to Alpha/)
        ).toBeInTheDocument()
        const betaText = screen.getByText(/Beta/)
        expect(betaText.textContent).toMatch(/fewer|accepted/i)
        expect(betaText.textContent).toMatch(/re-read/i)
        expect(betaText.textContent?.toLowerCase()).not.toMatch(/success/)
    })

    // Fix round 1, Critical (C1): the previous `aggregateOutcomes` summed
    // `requested`/`accepted` across a group's batches and classified on the
    // sums. A group split into an over-reporting batch (1010/1000 -- the
    // server can report MORE than was sent, see `acceptedCount`'s doc
    // comment in writes.ts) and a short batch (990/1000) sums to 2000/2000
    // and would render "All changes applied" while BOTH batches actually
    // sit in `unaccounted`. Classification must be per batch.
    it('never reports "All changes applied" when a group\'s batches disagree, even if their over/under counts sum to a perfect total (Critical C1)', async () => {
        mockWrite.mockResolvedValue({
            outcomes: [
                { groupId: 'g2', requested: 1000, accepted: 1010 },
                { groupId: 'g2', requested: 1000, accepted: 990 },
            ],
            applied: [],
            unaccounted: [
                { groupId: 'g2', additions: [], deletions: [] },
                { groupId: 'g2', additions: [], deletions: [] },
            ],
            changeSet: {} as never,
        })
        const applyButton = await goToApply()
        await act(async () => {
            fireEvent.click(applyButton)
        })
        await waitFor(() =>
            expect(screen.getByText(/Beta/)).toBeInTheDocument()
        )
        expect(
            screen.queryByText(/All changes applied to Beta/)
        ).not.toBeInTheDocument()
        // Retry must still be offered -- both batches are unaccounted.
        expect(
            screen.getByRole('button', { name: /retry/i })
        ).toBeInTheDocument()
    })

    // Fix round 1, I1: a group can have some batches confirmed in full and
    // others not (one errored, say) -- part of its change is real and
    // permanent, so it must not be reported as simply "failed".
    it('says a group has partially landed, not "failed", when some of its batches were confirmed and one errored', async () => {
        mockWrite.mockResolvedValue({
            outcomes: [
                { groupId: 'g2', requested: 500, accepted: 500 },
                {
                    groupId: 'g2',
                    requested: 500,
                    accepted: 0,
                    error: 'HTTP 500',
                },
            ],
            applied: [],
            unaccounted: [{ groupId: 'g2', additions: [], deletions: [] }],
            changeSet: {} as never,
        })
        const applyButton = await goToApply()
        await act(async () => {
            fireEvent.click(applyButton)
        })
        const betaText = await screen.findByText(/Beta/)
        expect(betaText.textContent?.toLowerCase()).not.toMatch(/failed/)
        expect(betaText.textContent).toMatch(/500 of 1000|re-read/i)
    })

    it('a failed batch offers a retry that sends only what failed', async () => {
        mockWrite.mockResolvedValueOnce({
            outcomes: [{ groupId: 'g2', requested: 3, accepted: 2 }],
            applied: [],
            // Fix round 1, I2: strictly a SUBSET of the plan's changes
            // (a1,a2,a3) -- the previous fixture was deep-equal to the
            // plan's own `changes`, so a retry that (wrongly) resent the
            // whole original plan would pass this test unchanged.
            unaccounted: [{ groupId: 'g2', additions: ['a3'], deletions: [] }],
            changeSet: {} as never,
        })
        const applyButton = await goToApply(undefined, [
            { groupId: 'g2', additions: ['a1', 'a2', 'a3'], deletions: [] },
        ])
        await act(async () => {
            fireEvent.click(applyButton)
        })
        const retryButton = await screen.findByRole('button', {
            name: /retry/i,
        })
        mockWrite.mockResolvedValueOnce({
            outcomes: [{ groupId: 'g2', requested: 1, accepted: 1 }],
            applied: [{ groupId: 'g2', additions: ['a3'], deletions: [] }],
            unaccounted: [],
            changeSet: {} as never,
        })
        await act(async () => {
            fireEvent.click(retryButton)
        })
        expect(mockWrite).toHaveBeenLastCalledWith(
            expect.objectContaining({
                changes: [{ groupId: 'g2', additions: ['a3'], deletions: [] }],
            })
        )
        const lastCallChanges = mockWrite.mock.calls[
            mockWrite.mock.calls.length - 1
        ][0].changes as { additions: string[] }[]
        expect(lastCallChanges.some((c) => c.additions.includes('a1'))).toBe(
            false
        )
        expect(lastCallChanges.some((c) => c.additions.includes('a2'))).toBe(
            false
        )
    })

    // Fix round 1, I5: a retry's result must not erase the earlier write's
    // outcomes for groups it did not retry -- only the group(s) it actually
    // reported on should be replaced.
    it('keeps an earlier fully-applied group visible on the panel after a retry that only concerns a different group', async () => {
        mockWrite.mockResolvedValueOnce({
            outcomes: [
                { groupId: 'g1', requested: 1, accepted: 1 },
                { groupId: 'g2', requested: 1, accepted: 0, error: 'HTTP 500' },
            ],
            applied: [{ groupId: 'g1', additions: [], deletions: [] }],
            unaccounted: [{ groupId: 'g2', additions: ['a1'], deletions: [] }],
            changeSet: {} as never,
        })
        const applyButton = await goToApply()
        await act(async () => {
            fireEvent.click(applyButton)
        })
        await screen.findByText(/All changes applied to Alpha/)

        const retryButton = screen.getByRole('button', { name: /retry/i })
        mockWrite.mockResolvedValueOnce({
            outcomes: [{ groupId: 'g2', requested: 1, accepted: 1 }],
            applied: [{ groupId: 'g2', additions: ['a1'], deletions: [] }],
            unaccounted: [],
            changeSet: {} as never,
        })
        await act(async () => {
            fireEvent.click(retryButton)
        })

        // Alpha's earlier, real success must still be on the panel.
        expect(
            screen.getByText(/All changes applied to Alpha/)
        ).toBeInTheDocument()
        expect(
            screen.getByText(/All changes applied to Beta/)
        ).toBeInTheDocument()
    })

    // Fix round 1, I6: a freshly created catch-all group is not yet part of
    // `set.groups` (see the comment on `createdGroup`) -- the result panel
    // must name it properly, the same way `targetOptions` already does,
    // rather than falling back to the raw UID.
    it('names a freshly created catch-all group by its display name in the result panel, not its raw id', async () => {
        mockCreateCatchAllGroup.mockResolvedValue({
            id: 'created-id',
            displayName: 'Other/unknown Ownership',
        })
        mockLoadConfig.mockResolvedValue({
            catchAllGroup: {},
            includeTracker: false,
        })
        mockUseEngineQuery.mockImplementation((method: string) => {
            if (method === 'planAssignment') {
                return {
                    data: plan({
                        changes: [
                            {
                                groupId: 'created-id',
                                additions: ['a1'],
                                deletions: [],
                            },
                        ],
                        affected: 1,
                    }),
                    isLoading: false,
                    error: null,
                }
            }
            return {
                data: { total: 1, offset: 0, items: [] },
                isLoading: false,
                error: null,
            }
        })
        mockWrite.mockResolvedValue({
            outcomes: [{ groupId: 'created-id', requested: 1, accepted: 1 }],
            applied: [
                { groupId: 'created-id', additions: ['a1'], deletions: [] },
            ],
            unaccounted: [],
            changeSet: {} as never,
        })
        render(
            <BulkFixDialog
                set={setForApply}
                scope={scope}
                filter={{}}
                onClose={jest.fn()}
                onApplied={jest.fn()}
            />
        )
        const createButton = await screen.findByRole('button', {
            name: 'Create group',
        })
        await act(async () => {
            fireEvent.click(createButton)
        })
        await waitFor(() =>
            expect(
                screen.getByText('Other/unknown Ownership')
            ).toBeInTheDocument()
        )
        fireEvent.click(screen.getByRole('button', { name: /next/i }))
        await screen.findByText('+1 / -0')
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /^apply/i }))
        })
        await waitFor(() =>
            expect(
                screen.getByText(/All changes applied to Other\/unknown/)
            ).toBeInTheDocument()
        )
        expect(screen.queryByText(/created-id/)).not.toBeInTheDocument()
    })

    // Fix round 1, I4: `write()` can reject (cache invalidation runs after
    // the server change, uncaught, in useMembershipWrite) -- without
    // handling this, the apply step renders a blank panel even though the
    // server write may well have succeeded.
    it('shows an error rather than a blank panel when write() rejects (I4)', async () => {
        mockWrite.mockRejectedValueOnce(new Error('indexedDB blew up'))
        const applyButton = await goToApply()
        await act(async () => {
            fireEvent.click(applyButton)
        })
        expect(
            await screen.findByText(/could not confirm/i)
        ).toBeInTheDocument()
        // The user must still be able to leave the dialog.
        expect(
            screen.getByRole('button', { name: /^close$/i })
        ).toBeInTheDocument()
    })

    // Fix round 1, M1: an empty plan produces no batches (writeMemberships
    // never calls onProgress for one either) -- the panel must say so
    // explicitly rather than rendering nothing.
    it('shows an explicit notice when there is nothing to apply (M1)', async () => {
        mockUseEngineQuery.mockImplementation((method: string) => {
            if (method === 'planAssignment') {
                return {
                    data: plan({ changes: [], affected: 0 }),
                    isLoading: false,
                    error: null,
                }
            }
            return {
                data: { total: 0, offset: 0, items: [] },
                isLoading: false,
                error: null,
            }
        })
        mockLoadConfig.mockResolvedValue({
            catchAllGroup: { own: 'g2' },
            includeTracker: false,
        })
        mockWrite.mockResolvedValue({
            outcomes: [],
            applied: [],
            unaccounted: [],
            changeSet: {} as never,
        })
        render(
            <BulkFixDialog
                set={setForApply}
                scope={scope}
                filter={{}}
                onClose={jest.fn()}
                onApplied={jest.fn()}
            />
        )
        await waitFor(() =>
            expect(screen.getByText('Beta')).toBeInTheDocument()
        )
        fireEvent.click(screen.getByRole('button', { name: /next/i }))
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /^apply/i }))
        })
        expect(await screen.findByText(/nothing to apply/i)).toBeInTheDocument()
    })

    it('cannot be dismissed mid-write in a way that loses the result (D4)', async () => {
        const onClose = jest.fn()
        mockLoadConfig.mockResolvedValue({
            catchAllGroup: { own: 'g2' },
            includeTracker: false,
        })
        mockUseEngineQuery.mockImplementation((method: string) => {
            if (method === 'planAssignment') {
                return {
                    data: plan({ changes, affected: 2 }),
                    isLoading: false,
                    error: null,
                }
            }
            return {
                data: { total: 2, offset: 0, items: [] },
                isLoading: false,
                error: null,
            }
        })
        mockIsWriting = true
        render(
            <BulkFixDialog
                set={setForApply}
                scope={scope}
                filter={{}}
                onClose={onClose}
                onApplied={jest.fn()}
            />
        )
        await waitFor(() =>
            expect(screen.getByText('Beta')).toBeInTheDocument()
        )
        fireEvent.click(screen.getByRole('button', { name: /next/i }))
        await screen.findByText('+2 / -0')
        mockWrite.mockImplementation(() => new Promise(() => undefined))
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /^apply/i }))
        })

        // Fix round 1, M3: asserted unconditionally -- the previous version
        // wrapped this in `if (cancelButton)`, so renaming the button would
        // have made the whole check pass vacuously.
        const cancelButton = screen.getByRole('button', { name: /^cancel$/i })
        expect(cancelButton).toBeDisabled()
        fireEvent.click(cancelButton)
        expect(onClose).not.toHaveBeenCalled()

        // Fix round 1, M3: the other half of what the implementation
        // blocks -- the Modal's own close affordance (Escape/backdrop,
        // exposed here as its close button), not just this dialog's own
        // Cancel button.
        fireEvent.click(
            screen.getByRole('button', { name: /close modal dialog/i })
        )
        expect(onClose).not.toHaveBeenCalled()
    })
})
