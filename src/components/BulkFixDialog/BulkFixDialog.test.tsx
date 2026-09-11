import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { BulkFixDialog } from './BulkFixDialog'
import { EngineStore } from '@/engine/store'
import { GroupSetMeta, Status } from '@/engine/types'

jest.mock('@dhis2/app-runtime', () => ({
    useConfig: () => ({ baseUrl: 'http://server', apiVersion: 42 }),
}))

const mockLoadConfig = jest.fn()
jest.mock('@/data/datastore', () => ({
    loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}))

const mockCreateCatchAllGroup = jest.fn()
jest.mock('@/data/metadataWrites', () => ({
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
jest.mock('@/hooks/useEngine', () => ({
    useEngine: () => ({ client: { call: mockClientCall } }),
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
        requiredLevels: {},
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
            requiredLevels: {},
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
            await screen.findByRole('button', {
                name: /create.*other\/unknown/i,
            })
        ).toBeInTheDocument()
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
            name: /create.*other\/unknown/i,
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

    it('choosing "assign all to one group" changes the computed plan accordingly', async () => {
        mockLoadConfig.mockResolvedValue({
            requiredLevels: {},
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
            requiredLevels: {},
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

    async function goToApply(onApplied = jest.fn()) {
        mockLoadConfig.mockResolvedValue({
            requiredLevels: {},
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
        await screen.findByText('+2 / -0')
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

    it('reports progress per batch while a write is in flight', async () => {
        let resolveWrite!: (value: unknown) => void
        mockIsWriting = true
        mockWrite.mockImplementation(
            (input: { onProgress?: (d: number, t: number) => void }) => {
                input.onProgress?.(1, 2)
                return new Promise((resolve) => {
                    resolveWrite = resolve
                })
            }
        )
        const applyButton = await goToApply()
        fireEvent.click(applyButton)
        await waitFor(() =>
            expect(screen.getByText(/1 of 2/)).toBeInTheDocument()
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
        expect(betaText.textContent).toMatch(/fewer/i)
        expect(betaText.textContent).toMatch(/re-read/i)
        expect(betaText.textContent?.toLowerCase()).not.toMatch(/success/)
    })

    it('a failed batch offers a retry that sends only what failed', async () => {
        mockWrite.mockResolvedValueOnce({
            outcomes: [
                { groupId: 'g2', requested: 2, accepted: 0, error: 'HTTP 500' },
            ],
            applied: [],
            unaccounted: [
                { groupId: 'g2', additions: ['a1', 'a2'], deletions: [] },
            ],
            changeSet: {} as never,
        })
        const applyButton = await goToApply()
        await act(async () => {
            fireEvent.click(applyButton)
        })
        const retryButton = await screen.findByRole('button', {
            name: /retry/i,
        })
        mockWrite.mockResolvedValueOnce({
            outcomes: [{ groupId: 'g2', requested: 2, accepted: 2 }],
            applied: [
                { groupId: 'g2', additions: ['a1', 'a2'], deletions: [] },
            ],
            unaccounted: [],
            changeSet: {} as never,
        })
        await act(async () => {
            fireEvent.click(retryButton)
        })
        expect(mockWrite).toHaveBeenLastCalledWith(
            expect.objectContaining({
                changes: [
                    { groupId: 'g2', additions: ['a1', 'a2'], deletions: [] },
                ],
            })
        )
    })

    it('cannot be dismissed mid-write in a way that loses the result (D4)', async () => {
        const onClose = jest.fn()
        mockLoadConfig.mockResolvedValue({
            requiredLevels: {},
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

        const cancelButton = screen.queryByRole('button', { name: /^cancel$/i })
        if (cancelButton) {
            expect(cancelButton).toBeDisabled()
            fireEvent.click(cancelButton)
        }
        expect(onClose).not.toHaveBeenCalled()
    })
})
