import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { BulkFixDialog } from './BulkFixDialog'
import { NAME_OWNED_BY_ANOTHER_SET } from '@/data/metadataWrites'
import { EngineStore } from '@/engine/store'
import type { GroupSetMeta } from '@/engine/types'
import { Status } from '@/engine/types'
import { actAndFlush } from '@/testing/actAndFlush'

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
                setCatchAllGroup: () => Promise.resolve(undefined),
                setIncludeTracker: () => Promise.resolve(undefined),
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
const mockReload = jest.fn(() => Promise.resolve(undefined))
// Fix round 1, finding 3: mutable so a test can simulate "no engine client"
// (e.g. the worker was torn down between the preview render and the Apply
// click) -- reset to a real client in the top-level beforeEach below, since
// every other test in the file expects the normal, non-null client.
let mockEngineClient: { call: typeof mockClientCall } | null = {
    call: mockClientCall,
}
jest.mock('@/hooks/useEngine', () => ({
    useEngine: () => ({ client: mockEngineClient, reload: mockReload }),
}))

const mockWrite = jest.fn()
let mockIsWriting = false
jest.mock('@/hooks/useUserScope', () => ({
    useUserScope: () => ({ hasAuthority: () => true }),
}))
jest.mock('@/hooks/useMembershipWrite', () => ({
    useMembershipWrite: () => ({
        write: (...args: unknown[]) => mockWrite(...args),
        isWriting: mockIsWriting,
    }),
}))

// Task 9 / finding M1: the pre-write re-read (`recheckPlan`) calls the real
// fetcher, not `client.call` -- this is the one place in the file that
// needs the raw HTTP layer stubbed, since every other data access goes through the mocked engine
// client or the mocked hooks above.
const mockFetcher = jest.fn()
jest.mock('@/data/fetcher', () => ({
    createFetcher: () => mockFetcher,
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
    mockEngineClient = { call: mockClientCall }
    mockLoadConfig.mockResolvedValue({
        catchAllGroup: {},
        includeTracker: false,
    })
    // Harmless default: nothing outside the Task 9 describe block below
    // exercises a plan large enough to reach the patch route, so this is
    // never actually invoked by those tests -- it exists so a future one
    // that accidentally does cannot fail on an unmocked fetcher instead.
    mockFetcher.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
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
        await actAndFlush(() => {
            fireEvent.click(
                screen.getByRole('button', { name: 'Create group' })
            )
        })
        expect(mockCreateCatchAllGroup).toHaveBeenCalledWith(
            expect.anything(),
            set,
            {
                displayName: 'Unclassified facilities',
                shortName: 'Unclassified',
            }
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
        await actAndFlush(() => {
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
        await actAndFlush(() => {
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
        await actAndFlush(() => {
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
        ).mockImplementation((value: string) => {
            downloadName = value
        })

        await goToPreview('Beta')
        const downloadButton = await screen.findByRole('button', {
            name: /download.*csv/i,
        })
        await actAndFlush(() => {
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
        expect(lastPlan?.changes.some((c) => c.additions.includes('ok1'))).toBe(
            false
        )
        expect(lastPlan?.changes.some((c) => c.deletions.includes('ok1'))).toBe(
            false
        )
        // The violations are still acted on: missing1 is added to the
        // catch-all, and conflict1 (alpha + other already) loses its
        // now-redundant alpha membership.
        const otherChange = lastPlan?.changes.find((c) => c.groupId === 'other')
        expect(otherChange?.additions).toEqual(['missing1'])
        const alphaChange = lastPlan?.changes.find((c) => c.groupId === 'alpha')
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
        expect(lastPlan?.changes.some((c) => c.additions.includes('ok1'))).toBe(
            false
        )
        expect(lastPlan?.changes.some((c) => c.deletions.includes('ok1'))).toBe(
            false
        )
        const otherChange = lastPlan?.changes.find((c) => c.groupId === 'other')
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
        expect(lastPlan?.affected).toBe(0)
        expect(lastPlan?.changes).toEqual([])
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
        const otherChange = lastPlan?.changes.find((c) => c.groupId === 'other')
        expect(otherChange?.additions).toEqual(['missing1'])
        // conflict1 is a real violation too, but it was not in the
        // selection -- a dialog that ignored `selection` would still move
        // it out of alpha here.
        const alphaChange = lastPlan?.changes.find((c) => c.groupId === 'alpha')
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
        await actAndFlush(() => {
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
        await actAndFlush(() => {
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
        await actAndFlush(() => {
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
        await actAndFlush(() => {
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
        await actAndFlush(() => {
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
        await actAndFlush(() => {
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
        await actAndFlush(() => {
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
        await actAndFlush(() => {
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
        await actAndFlush(() => {
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
        await actAndFlush(() => {
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
        await actAndFlush(() => {
            fireEvent.click(createButton)
        })
        await waitFor(() =>
            expect(
                screen.getByText('Other/unknown Ownership')
            ).toBeInTheDocument()
        )
        fireEvent.click(screen.getByRole('button', { name: /next/i }))
        await screen.findByText('+1 / -0')
        await actAndFlush(() => {
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
        await actAndFlush(() => {
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
    it('says there is nothing to apply, and offers no Apply, when the plan is empty (M1)', async () => {
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
        expect(screen.getByText('Nothing to apply')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
        expect(mockWrite).not.toHaveBeenCalled()
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
        mockWrite.mockImplementation(() => new Promise(() => {}))
        await actAndFlush(() => {
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

    // Task 9 (spec 5.1/5.4): the bulk fix's pre-write freshness check. Only
    // a group whose OWN delta exceeds DEFAULT_BATCH_SIZE (5000) takes the
    // patch route and is therefore worth re-reading -- PATCH_CHANGE below
    // is sized to cross that on purpose, so the default fixture for this
    // block genuinely exercises the check rather than skipping it.
    describe('pre-write freshness check', () => {
        const PATCH_CHANGE = [
            {
                groupId: 'g2',
                additions: Array.from({ length: 5001 }, (_, i) => `m${i}`),
                deletions: [],
            },
        ]

        // Fix round 1: a distinct, non-empty change list for the recomputed
        // (44-affected) plan -- the original fixture reused `plan({ affected:
        // 44 })`'s default empty `changes`, which discriminated today only
        // because the previewed changes happened to be non-empty. This pins
        // the actually-important property (the applied changes are the
        // recomputed ones) against a fixture that would fail if `changes`
        // and `affected` ever disagreed again.
        const RECOMPUTED_CHANGE = [
            { groupId: 'g2', additions: ['m0'], deletions: [] },
        ]

        // Extracted from `goToApply` above: render, choose the (preselected)
        // target, and click Next through to the preview, where the "Apply"
        // button lives. Deliberately does not touch `mockUseEngineQuery` or
        // `mockClientCall` -- every test in this block (including this
        // block's own `beforeEach`) owns those, and a helper that reset them
        // here would silently discard whichever scenario the caller just set
        // up.
        async function renderAndReachApply() {
            const rendered = render(
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
            await screen.findByRole('button', { name: /^apply/i })
            // Returned so a test can unmount mid-check; every other caller
            // ignores it.
            return rendered
        }

        beforeEach(() => {
            mockLoadConfig.mockResolvedValue({
                catchAllGroup: { own: 'g2' },
                includeTracker: false,
            })
            // Default scenario: one group's delta crosses the patch
            // threshold, and the recompute agrees with the preview -- the
            // "large fix, nothing actually changed underneath it" case.
            // Individual tests below override either mock to exercise the
            // no-crossing and mismatch scenarios.
            mockUseEngineQuery.mockImplementation((method: string) => {
                if (method === 'planAssignment') {
                    return {
                        data: plan({
                            changes: PATCH_CHANGE,
                            affected: PATCH_CHANGE[0].additions.length,
                        }),
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
            mockClientCall.mockImplementation((method: string) => {
                if (method === 'setGroupMembers') {
                    return Promise.resolve(undefined)
                }
                if (method === 'planAssignment') {
                    return Promise.resolve(
                        plan({
                            changes: PATCH_CHANGE,
                            affected: PATCH_CHANGE[0].additions.length,
                        })
                    )
                }
                return Promise.resolve(undefined)
            })
            mockFetcher.mockResolvedValue({
                ok: true,
                json: () =>
                    Promise.resolve({ organisationUnits: [{ id: 'm0' }] }),
            })
            mockWrite.mockResolvedValue({
                outcomes: [],
                applied: [],
                unaccounted: [],
                changeSet: {} as never,
            })
        })

        it('writes without re-confirmation when the recomputed plan is the same delta in a different order', async () => {
            const reordered = [
                {
                    ...PATCH_CHANGE[0],
                    // oxlint-disable-next-line unicorn/no-array-reverse -- reverses a fresh copy; toReversed() is not in this repo's ES2020 lib
                    additions: [...PATCH_CHANGE[0].additions].reverse(),
                },
            ]
            mockClientCall.mockImplementation((method: string) => {
                if (method === 'planAssignment') {
                    return Promise.resolve(
                        plan({
                            changes: reordered,
                            affected: reordered[0].additions.length,
                        })
                    )
                }
                return Promise.resolve(undefined)
            })
            await renderAndReachApply()
            fireEvent.click(screen.getByRole('button', { name: /^apply/i }))
            await waitFor(() => expect(mockWrite).toHaveBeenCalledTimes(1))
            expect(
                screen.queryByText(
                    'The metadata changed while you were reviewing'
                )
            ).not.toBeInTheDocument()
        })

        it('reads nothing and writes straight through when the plan touches no group', async () => {
            // A plan with no changes makes no assumption about any group,
            // so there is nothing to re-read. Every other plan is checked:
            // see "for a plan below the patch threshold" below.
            mockUseEngineQuery.mockImplementation((method: string) =>
                method === 'planAssignment'
                    ? {
                          data: plan({ affected: 3 }),
                          isLoading: false,
                          error: null,
                      }
                    : {
                          data: { total: 0, offset: 0, items: [] },
                          isLoading: false,
                          error: null,
                      }
            )
            mockClientCall.mockResolvedValue(plan({ affected: 3 }))
            await renderAndReachApply()
            await actAndFlush(() => {
                fireEvent.click(screen.getByRole('button', { name: /Apply/ }))
            })
            expect(mockWrite).toHaveBeenCalled()
            expect(
                screen.queryByText(
                    'The metadata changed while you were reviewing'
                )
            ).not.toBeInTheDocument()
            expect(mockFetcher).not.toHaveBeenCalled()
        })

        // Carried forward from Plan 8: both of these were verified by
        // inspection only. The re-read exists to see what the server holds
        // *now*, so a cached response defeats it entirely and silently --
        // and `paging=false` matters just as much, since a default-paged
        // read would return the first 50 members and the patch built from
        // it would delete every other member of the group.
        it('re-reads members uncached, unpaged, and by id only', async () => {
            await renderAndReachApply()
            await actAndFlush(() => {
                fireEvent.click(screen.getByRole('button', { name: /Apply/ }))
            })
            expect(mockFetcher).toHaveBeenCalledTimes(1)
            const [path, init] = mockFetcher.mock.calls[0]
            expect(path).toBe(
                'organisationUnitGroups/g2/organisationUnits?fields=id&paging=false'
            )
            // Property by property, never `toEqual` on `init` as a whole:
            // it carries the deadline's `AbortSignal`, and a failing
            // object comparison makes Jest deep-copy that for its diff,
            // which walks into jsdom and aborts the worker with an
            // out-of-memory (exit 134) instead of printing a failure.
            expect(init.cache).toBe('no-store')
            // The deadline's controller reaches the read, so a timed-out
            // check actually stops it rather than leaving it running.
            expect(typeof init.signal?.aborted).toBe('boolean')
        })

        // Carried forward from Plan 8: the in-flight guard was set only on
        // the check path, so on a plan needing no check two clicks in one
        // synchronous tick both reached `performWrite` -- one user intent,
        // two writes, two History rows. The patch is idempotent so this
        // never damaged data, which is exactly why it could go unnoticed.
        it('writes once for two clicks in one tick when nothing crosses the patch threshold', async () => {
            mockUseEngineQuery.mockImplementation((method: string) =>
                method === 'planAssignment'
                    ? {
                          data: plan({ affected: 3 }),
                          isLoading: false,
                          error: null,
                      }
                    : {
                          data: { total: 0, offset: 0, items: [] },
                          isLoading: false,
                          error: null,
                      }
            )
            mockClientCall.mockResolvedValue(plan({ affected: 3 }))
            await renderAndReachApply()
            // Both inside one `act`, with no render flush between them --
            // neither click's closure has seen the other's state update.
            await actAndFlush(() => {
                fireEvent.click(screen.getByRole('button', { name: /Apply/ }))
                fireEvent.click(screen.getByRole('button', { name: /Apply/ }))
            })
            expect(mockWrite).toHaveBeenCalledTimes(1)
            expect(mockFetcher).not.toHaveBeenCalled()
        })

        it('blocks and re-confirms when the recomputed plan differs', async () => {
            mockUseEngineQuery.mockImplementation((method: string) =>
                method === 'planAssignment'
                    ? {
                          data: plan({
                              changes: PATCH_CHANGE,
                              affected: 45,
                          }),
                          isLoading: false,
                          error: null,
                      }
                    : {
                          data: { total: 0, offset: 0, items: [] },
                          isLoading: false,
                          error: null,
                      }
            )
            // setGroupMembers resolves, then the recomputed plan comes back
            // smaller.
            mockClientCall.mockImplementation((method: string) =>
                method === 'planAssignment'
                    ? Promise.resolve(
                          plan({ changes: RECOMPUTED_CHANGE, affected: 44 })
                      )
                    : Promise.resolve(undefined)
            )
            await renderAndReachApply()
            await actAndFlush(() => {
                fireEvent.click(screen.getByRole('button', { name: /Apply/ }))
            })
            expect(
                await screen.findByText(
                    'The metadata changed while you were reviewing'
                )
            ).toBeInTheDocument()
            expect(mockWrite).not.toHaveBeenCalled()
        })

        // RECOMPUTED_CHANGE (1 addition) no longer crosses the patch
        // threshold, so re-confirming here writes straight through with no
        // second re-read -- see the next test for the case where the
        // recomputed plan still crosses it and a second re-read is required.
        it('writes the recalculated plan, not the previewed one, after re-confirming', async () => {
            mockUseEngineQuery.mockImplementation((method: string) =>
                method === 'planAssignment'
                    ? {
                          data: plan({
                              changes: PATCH_CHANGE,
                              affected: 45,
                          }),
                          isLoading: false,
                          error: null,
                      }
                    : {
                          data: { total: 0, offset: 0, items: [] },
                          isLoading: false,
                          error: null,
                      }
            )
            mockClientCall.mockImplementation((method: string) =>
                method === 'planAssignment'
                    ? Promise.resolve(
                          plan({ changes: RECOMPUTED_CHANGE, affected: 44 })
                      )
                    : Promise.resolve(undefined)
            )
            await renderAndReachApply()
            await actAndFlush(() => {
                fireEvent.click(screen.getByRole('button', { name: /Apply/ }))
            })
            await screen.findByText(
                'The metadata changed while you were reviewing'
            )
            await actAndFlush(() => {
                fireEvent.click(
                    screen.getByRole('button', { name: 'Apply 44 changes' })
                )
            })
            expect(mockWrite).toHaveBeenCalledWith(
                expect.objectContaining({
                    changes: RECOMPUTED_CHANGE,
                })
            )
        })

        // Fix round 2, finding 1: the property this restores is that a JSON
        // Patch must never be built from membership read before an
        // unbounded user pause. RECOMPUTED_CHANGE above happens to fall
        // under the patch threshold, so it does not exercise the actual
        // repeat re-read; PATCH_CHANGE_STILL_LARGE here stays above it, so
        // the re-confirmation must re-read a *second* time (a fresh
        // `mockFetcher` call, not the map captured before the pause) before
        // writing.
        it('the re-confirmation button re-reads membership again immediately before writing, not the map read before the pause', async () => {
            const PATCH_CHANGE_STILL_LARGE = [
                {
                    groupId: 'g2',
                    additions: Array.from({ length: 5010 }, (_, i) => `n${i}`),
                    deletions: [],
                },
            ]
            mockUseEngineQuery.mockImplementation((method: string) =>
                method === 'planAssignment'
                    ? {
                          data: plan({
                              changes: PATCH_CHANGE,
                              affected: PATCH_CHANGE[0].additions.length,
                          }),
                          isLoading: false,
                          error: null,
                      }
                    : {
                          data: { total: 0, offset: 0, items: [] },
                          isLoading: false,
                          error: null,
                      }
            )
            // Both the initial check and the re-confirmation's own check
            // recompute to the same still-large plan -- the first disagrees
            // with the ORIGINAL preview (PATCH_CHANGE), which is what
            // triggers the re-confirmation notice; the second agrees with
            // what the re-confirmation itself just confirmed
            // (PATCH_CHANGE_STILL_LARGE), which is what lets it write.
            mockClientCall.mockImplementation((method: string) =>
                method === 'planAssignment'
                    ? Promise.resolve(
                          plan({
                              changes: PATCH_CHANGE_STILL_LARGE,
                              affected:
                                  PATCH_CHANGE_STILL_LARGE[0].additions.length,
                          })
                      )
                    : Promise.resolve(undefined)
            )
            mockFetcher.mockResolvedValueOnce({
                ok: true,
                json: () =>
                    Promise.resolve({
                        organisationUnits: [{ id: 'stale-member' }],
                    }),
            })
            mockFetcher.mockResolvedValueOnce({
                ok: true,
                json: () =>
                    Promise.resolve({
                        organisationUnits: [{ id: 'fresh-member' }],
                    }),
            })
            await renderAndReachApply()
            await actAndFlush(() => {
                fireEvent.click(screen.getByRole('button', { name: /Apply/ }))
            })
            await screen.findByText(
                'The metadata changed while you were reviewing'
            )
            expect(mockFetcher).toHaveBeenCalledTimes(1)
            expect(mockWrite).not.toHaveBeenCalled()
            // Simulates the "unbounded user pause" the finding describes --
            // nothing happens here except time; the read above must not be
            // reused when Apply is finally clicked below.
            await actAndFlush(() => {
                fireEvent.click(screen.getByRole('button', { name: /^Apply/ }))
            })
            expect(mockFetcher).toHaveBeenCalledTimes(2)
            expect(mockWrite).toHaveBeenCalledTimes(1)
            const written = mockWrite.mock.calls[0][0]
            expect(written.changes).toEqual(PATCH_CHANGE_STILL_LARGE)
            // The map the write actually used came from the SECOND read
            // (triggered by clicking Apply), not the first (captured before
            // the pause) -- this is the property finding 1 exists to
            // restore.
            expect(written.completeMembers.get('g2')).toEqual(['fresh-member'])
        })

        // Fix round 2, finding 2: Task 9's `checkInFlightRef` guard is
        // shared between `handleApply` and this button (both call the same
        // `runFreshnessCheck`), so the same two-clicks-in-one-tick race it
        // was added for must be closed here too, with no second guard
        // needed.
        it('two clicks on the re-confirmation button in one tick produce one re-read and one write', async () => {
            const PATCH_CHANGE_STILL_LARGE = [
                {
                    groupId: 'g2',
                    additions: Array.from({ length: 5010 }, (_, i) => `n${i}`),
                    deletions: [],
                },
            ]
            mockUseEngineQuery.mockImplementation((method: string) =>
                method === 'planAssignment'
                    ? {
                          data: plan({
                              changes: PATCH_CHANGE,
                              affected: PATCH_CHANGE[0].additions.length,
                          }),
                          isLoading: false,
                          error: null,
                      }
                    : {
                          data: { total: 0, offset: 0, items: [] },
                          isLoading: false,
                          error: null,
                      }
            )
            mockClientCall.mockImplementation((method: string) =>
                method === 'planAssignment'
                    ? Promise.resolve(
                          plan({
                              changes: PATCH_CHANGE_STILL_LARGE,
                              affected:
                                  PATCH_CHANGE_STILL_LARGE[0].additions.length,
                          })
                      )
                    : Promise.resolve(undefined)
            )
            mockFetcher.mockResolvedValueOnce({
                ok: true,
                json: () =>
                    Promise.resolve({ organisationUnits: [{ id: 'm0' }] }),
            })
            let resolveSecondFetch!: (value: unknown) => void
            mockFetcher.mockImplementation(
                () =>
                    new Promise((resolve) => {
                        resolveSecondFetch = resolve
                    })
            )
            await renderAndReachApply()
            await actAndFlush(() => {
                fireEvent.click(screen.getByRole('button', { name: /Apply/ }))
            })
            await screen.findByText(
                'The metadata changed while you were reviewing'
            )
            expect(mockFetcher).toHaveBeenCalledTimes(1)
            // Both clicks inside one `act`, with no render flush between
            // them -- same race as the existing "second click" test above,
            // now against the re-confirmation button instead of the first
            // Apply.
            await actAndFlush(() => {
                fireEvent.click(screen.getByRole('button', { name: /^Apply/ }))
                fireEvent.click(screen.getByRole('button', { name: /^Apply/ }))
            })
            expect(mockFetcher).toHaveBeenCalledTimes(2)
            await actAndFlush(() => {
                resolveSecondFetch({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            organisationUnits: [{ id: 'm1' }],
                        }),
                })
            })
            expect(mockWrite).toHaveBeenCalledTimes(1)
        })

        // Spec §7: "Review changes returns to preview with the recalculated
        // plan".
        it('"Review changes" returns to the preview step with the recalculated plan', async () => {
            mockUseEngineQuery.mockImplementation((method: string) =>
                method === 'planAssignment'
                    ? {
                          data: plan({
                              changes: PATCH_CHANGE,
                              affected: 45,
                          }),
                          isLoading: false,
                          error: null,
                      }
                    : {
                          data: { total: 0, offset: 0, items: [] },
                          isLoading: false,
                          error: null,
                      }
            )
            mockClientCall.mockImplementation((method: string) =>
                method === 'planAssignment'
                    ? Promise.resolve(
                          plan({ changes: RECOMPUTED_CHANGE, affected: 44 })
                      )
                    : Promise.resolve(undefined)
            )
            await renderAndReachApply()
            await actAndFlush(() => {
                fireEvent.click(screen.getByRole('button', { name: /Apply/ }))
            })
            await screen.findByText(
                'The metadata changed while you were reviewing'
            )
            await actAndFlush(() => {
                fireEvent.click(
                    screen.getByRole('button', { name: /Review changes/i })
                )
            })
            // Back at the preview step with the recalculated plan: the
            // re-confirmation notice and its own buttons are gone, the
            // ordinary preview buttons (Back / Apply) are back, and the
            // count shown is the recomputed one (44), never the stale
            // preview (45) -- and critically, nothing was written just by
            // looking at it.
            expect(
                screen.queryByText(
                    'The metadata changed while you were reviewing'
                )
            ).not.toBeInTheDocument()
            expect(screen.getByText('44 objects')).toBeInTheDocument()
            expect(
                screen.getByRole('button', { name: 'Apply' })
            ).toBeInTheDocument()
            expect(mockWrite).not.toHaveBeenCalled()
        })

        it('passes the freshly read membership to the writer', async () => {
            // Task 8's patch route is unreachable without this, by design.
            await renderAndReachApply()
            await actAndFlush(() => {
                fireEvent.click(screen.getByRole('button', { name: /Apply/ }))
            })
            expect(mockWrite).toHaveBeenCalledWith(
                expect.objectContaining({ completeMembers: expect.any(Map) })
            )
        })

        // Fix round 1, finding 1 (first consequence): two clicks landing
        // before React ever re-renders the disabled Apply button must not
        // start two independent checks -- and, downstream, must not produce
        // two writes.
        it('a second click while the freshness check is reading fresh metadata cannot start a second check or write', async () => {
            let resolveFetch!: (value: unknown) => void
            mockFetcher.mockImplementation(
                () =>
                    new Promise((resolve) => {
                        resolveFetch = resolve
                    })
            )
            await renderAndReachApply()
            // Both clicks inside one `act`, with no render flush between
            // them -- exactly the race a plain `checkingFreshness` state
            // check (rather than a ref) would lose, since neither click's
            // closure has seen the other's update yet.
            await actAndFlush(() => {
                fireEvent.click(screen.getByRole('button', { name: /Apply/ }))
                fireEvent.click(screen.getByRole('button', { name: /Apply/ }))
            })
            expect(mockFetcher).toHaveBeenCalledTimes(1)
            await actAndFlush(() => {
                resolveFetch({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            organisationUnits: [{ id: 'm0' }],
                        }),
                })
            })
            expect(mockWrite).toHaveBeenCalledTimes(1)
        })

        // Fix round 1, finding 1 (second consequence): Cancel -- and the
        // modal's own close affordance -- must be disabled for the entire
        // read, not just from some point after it resolves, or the dialog
        // can be dismissed mid-check while the write still lands afterwards.
        it('cannot cancel while the freshness check is reading fresh metadata, and no write follows', async () => {
            const onClose = jest.fn()
            let resolveFetch!: (value: unknown) => void
            mockFetcher.mockImplementation(
                () =>
                    new Promise((resolve) => {
                        resolveFetch = resolve
                    })
            )
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
            await screen.findByRole('button', { name: /^apply/i })
            await actAndFlush(() => {
                fireEvent.click(screen.getByRole('button', { name: /Apply/ }))
            })
            expect(
                screen.getByText(/Checking the metadata is up to date/)
            ).toBeInTheDocument()
            const cancelButton = screen.getByRole('button', {
                name: /^cancel$/i,
            })
            expect(cancelButton).toBeDisabled()
            fireEvent.click(cancelButton)
            expect(onClose).not.toHaveBeenCalled()
            // The modal's own close affordance (Escape/backdrop, exposed
            // here as its close button) is not a plain disabled control --
            // @dhis2/ui's Modal is given a no-op in place of `onClose` while
            // checking, so the button renders normally but does nothing.
            fireEvent.click(
                screen.getByRole('button', { name: /close modal dialog/i })
            )
            expect(onClose).not.toHaveBeenCalled()
            expect(mockWrite).not.toHaveBeenCalled()
            // Let the pending read settle so it cannot leak into another test.
            await actAndFlush(() => {
                resolveFetch({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            organisationUnits: [{ id: 'm0' }],
                        }),
                })
            })
        })

        // Fix round 1, finding 2: the check itself can fail (a non-OK HTTP
        // response from the re-read, here) before anything is written --
        // this must show its own error, distinct from the apply step's "the
        // write may have reached the server" wording, since nothing was
        // written at all.
        it('shows a distinct error, without writing, when the freshness check itself fails', async () => {
            mockFetcher.mockResolvedValue({
                ok: false,
                status: 500,
                json: () => Promise.resolve({}),
            })
            await renderAndReachApply()
            await actAndFlush(() => {
                fireEvent.click(screen.getByRole('button', { name: /Apply/ }))
            })
            expect(
                await screen.findByText('The metadata could not be checked')
            ).toBeInTheDocument()
            expect(
                screen.queryByText(/write may have reached the server/i)
            ).not.toBeInTheDocument()
            expect(mockWrite).not.toHaveBeenCalled()
        })

        // Carried forward from Plan 8, closed here: `checkingFreshness`
        // disables Cancel, Back and the modal's own close affordance, so a
        // check that never settles used to leave the dialog with no way out
        // at all -- a page reload was the only escape. The deadline is the
        // escape hatch, and it has to cover the whole check rather than
        // only the fetch (both `client.call`s hang the same way).
        it('gives up on a freshness check that never settles, re-enabling the dialog without writing', async () => {
            mockFetcher.mockImplementation(() => new Promise(() => {}))
            await renderAndReachApply()
            jest.useFakeTimers()
            try {
                await actAndFlush(() => {
                    fireEvent.click(
                        screen.getByRole('button', { name: /Apply/ })
                    )
                })
                // Mid-check: still locked down, exactly as before.
                expect(
                    screen.getByRole('button', { name: /Cancel/ })
                ).toBeDisabled()

                await actAndFlush(() => {
                    jest.advanceTimersByTime(60_000)
                })

                expect(
                    screen.getByText('Checking the metadata took too long')
                ).toBeInTheDocument()
                // The point of the whole change: the dialog is usable again.
                expect(
                    screen.getByRole('button', { name: /Cancel/ })
                ).toBeEnabled()
                expect(mockWrite).not.toHaveBeenCalled()
            } finally {
                jest.useRealTimers()
            }
        })

        // The generation guard's real job. A timed-out check is already
        // barred from writing by the deadline's own rejection, but nothing
        // stops the abandoned read and the two engine calls behind it from
        // running to completion -- and if the dialog has since unmounted,
        // that continuation would write, and set state, for a dialog that
        // is no longer on screen.
        it('never writes from a check whose dialog has since unmounted', async () => {
            let resolveFetch!: (value: unknown) => void
            mockFetcher.mockImplementation(
                () =>
                    new Promise((resolve) => {
                        resolveFetch = resolve
                    })
            )
            const { unmount } = await renderAndReachApply()
            await actAndFlush(() => {
                fireEvent.click(screen.getByRole('button', { name: /Apply/ }))
            })
            expect(mockFetcher).toHaveBeenCalledTimes(1)

            unmount()

            // The read the dialog is no longer waiting for answers anyway,
            // and the chain behind it is given every chance to run on.
            await actAndFlush(() => {
                resolveFetch({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            organisationUnits: [{ id: 'm0' }],
                        }),
                })
            })
            for (let i = 0; i < 10; i++) {
                // oxlint-disable-next-line no-await-in-loop -- each round lets one more timer tick run, in order
                await act(async () => {
                    await new Promise((r) => {
                        setTimeout(r, 0)
                    })
                })
            }
            expect(mockWrite).not.toHaveBeenCalled()
        })

        // Fix round 1, finding 3: no engine client to push the fresh
        // membership into or recompute against -- must bail the same way
        // `handleDownloadCsv` does for a read-only export, except loudly,
        // since writing the stale plan here would apply the user's
        // unverified decisions to data that was never re-checked.
        it('bails without writing when there is no engine client to check the plan against', async () => {
            mockEngineClient = null
            await renderAndReachApply()
            await actAndFlush(() => {
                fireEvent.click(screen.getByRole('button', { name: /Apply/ }))
            })
            expect(
                await screen.findByText('The metadata could not be checked')
            ).toBeInTheDocument()
            expect(mockWrite).not.toHaveBeenCalled()
            expect(mockFetcher).not.toHaveBeenCalled()
        })

        // Finding M1: a plan of any size is re-checked against the server
        // before it is written, not only one that crosses the patch
        // threshold. The engine never refreshes on its own, so a plan can
        // be hours old by the time Apply is clicked.
        describe('for a plan below the patch threshold', () => {
            // Moves u1 from g1 to g2 (the target).
            const SMALL_MOVE = [
                { groupId: 'g1', additions: [], deletions: ['u1'] },
                { groupId: 'g2', additions: ['u1'], deletions: [] },
            ]
            const idsAskedFor = (path: string) => {
                const match = /id:in:\[([^\]]*)\]/.exec(
                    decodeURIComponent(path)
                )
                return match ? match[1].split(',') : []
            }
            // A fake server: which of the requested ids each group holds.
            const serveMembers = (members: Record<string, string[]>) => {
                mockFetcher.mockImplementation((path: string) => {
                    const groupId = /Groups\/([^/]+)\//.exec(path)?.[1] ?? ''
                    const held = new Set(members[groupId] ?? [])
                    return Promise.resolve({
                        ok: true,
                        json: () =>
                            Promise.resolve({
                                organisationUnits: idsAskedFor(path)
                                    .filter((id) => held.has(id))
                                    .map((id) => ({ id })),
                            }),
                    })
                })
            }

            beforeEach(() => {
                mockUseEngineQuery.mockImplementation((method: string) =>
                    method === 'planAssignment'
                        ? {
                              data: plan({ changes: SMALL_MOVE, affected: 1 }),
                              isLoading: false,
                              error: null,
                          }
                        : {
                              data: { total: 0, offset: 0, items: [] },
                              isLoading: false,
                              error: null,
                          }
                )
            })

            it('re-reads every touched group for exactly the plan objects, and writes when nothing changed', async () => {
                serveMembers({ g1: ['u1'] })
                await renderAndReachApply()
                await actAndFlush(() => {
                    fireEvent.click(
                        screen.getByRole('button', { name: /^apply/i })
                    )
                })

                await waitFor(() => expect(mockWrite).toHaveBeenCalledTimes(1))
                expect(mockWrite).toHaveBeenCalledWith(
                    expect.objectContaining({ changes: SMALL_MOVE })
                )
                const reads = mockFetcher.mock.calls.map(([path, init]) => ({
                    path: decodeURIComponent(path as string),
                    cache: (init as RequestInit).cache,
                }))
                expect(reads).toEqual(
                    expect.arrayContaining([
                        {
                            path: 'organisationUnitGroups/g1/organisationUnits?fields=id&filter=id:in:[u1]&paging=false',
                            cache: 'no-store',
                        },
                        {
                            path: 'organisationUnitGroups/g2/organisationUnits?fields=id&filter=id:in:[u1]&paging=false',
                            cache: 'no-store',
                        },
                    ])
                )
                expect(reads).toHaveLength(2)
                // Nothing drifted, so the engine was not asked to recompute.
                expect(mockClientCall).not.toHaveBeenCalledWith(
                    'planAssignment',
                    expect.anything(),
                    expect.anything(),
                    expect.anything(),
                    expect.anything()
                )
            })

            it('re-confirms instead of writing when another admin already moved the object', async () => {
                // u1 is no longer in g1: someone resolved it meanwhile.
                serveMembers({ g1: [], g2: ['u1'] })
                mockClientCall.mockImplementation((method: string) =>
                    Promise.resolve(
                        method === 'planAssignment'
                            ? plan({ changes: [], affected: 0 })
                            : undefined
                    )
                )
                await renderAndReachApply()
                await actAndFlush(() => {
                    fireEvent.click(
                        screen.getByRole('button', { name: /^apply/i })
                    )
                })

                expect(
                    await screen.findByText(
                        'The metadata changed while you were reviewing'
                    )
                ).toBeInTheDocument()
                expect(mockWrite).not.toHaveBeenCalled()
                // The engine is told what the server holds now, before the
                // plan is recomputed from it.
                expect(mockClientCall).toHaveBeenCalledWith(
                    'applyChangeSet',
                    'organisationUnit',
                    [
                        { groupId: 'g1', additions: [], deletions: ['u1'] },
                        { groupId: 'g2', additions: ['u1'], deletions: [] },
                    ]
                )
                const order = mockClientCall.mock.calls.map((c) => c[0])
                expect(order.indexOf('applyChangeSet')).toBeLessThan(
                    order.indexOf('planAssignment')
                )
            })

            it('notices an object another admin put into a touched group the plan does not change it in', async () => {
                // A second object, u2, only gets added to the target. Someone
                // has since put u2 into g1, which the plan would leave alone,
                // so the write would create a conflict.
                const twoObjects = [
                    { groupId: 'g1', additions: [], deletions: ['u1'] },
                    { groupId: 'g2', additions: ['u1', 'u2'], deletions: [] },
                ]
                mockUseEngineQuery.mockImplementation((method: string) =>
                    method === 'planAssignment'
                        ? {
                              data: plan({ changes: twoObjects, affected: 2 }),
                              isLoading: false,
                              error: null,
                          }
                        : {
                              data: { total: 0, offset: 0, items: [] },
                              isLoading: false,
                              error: null,
                          }
                )
                serveMembers({ g1: ['u1', 'u2'] })
                mockClientCall.mockImplementation((method: string) =>
                    Promise.resolve(
                        method === 'planAssignment'
                            ? plan({
                                  changes: [
                                      {
                                          groupId: 'g1',
                                          additions: [],
                                          deletions: ['u1', 'u2'],
                                      },
                                      {
                                          groupId: 'g2',
                                          additions: ['u1', 'u2'],
                                          deletions: [],
                                      },
                                  ],
                                  affected: 2,
                              })
                            : undefined
                    )
                )
                await renderAndReachApply()
                await actAndFlush(() => {
                    fireEvent.click(
                        screen.getByRole('button', { name: /^apply/i })
                    )
                })

                expect(mockClientCall).toHaveBeenCalledWith(
                    'applyChangeSet',
                    'organisationUnit',
                    [{ groupId: 'g1', additions: ['u2'], deletions: [] }]
                )
                expect(
                    await screen.findByText(
                        'The metadata changed while you were reviewing'
                    )
                ).toBeInTheDocument()
                expect(mockWrite).not.toHaveBeenCalled()
            })

            it('writes nothing when the re-read fails', async () => {
                mockFetcher.mockResolvedValue({ ok: false, status: 500 })
                await renderAndReachApply()
                await actAndFlush(() => {
                    fireEvent.click(
                        screen.getByRole('button', { name: /^apply/i })
                    )
                })
                expect(
                    await screen.findByText('The metadata could not be checked')
                ).toBeInTheDocument()
                expect(mockWrite).not.toHaveBeenCalled()
            })
        })
    })
})
