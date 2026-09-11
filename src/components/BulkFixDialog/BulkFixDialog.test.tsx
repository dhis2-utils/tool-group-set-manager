import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { BulkFixDialog } from './BulkFixDialog'

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
        skipped: string[]
    }> = {}
) => ({
    changes: [],
    affected: 0,
    skipped: [],
    ...overrides,
})

beforeEach(() => {
    jest.clearAllMocks()
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

        mockUseEngineQuery.mockImplementation(
            (method: string, args: unknown[]) => {
                if (method === 'planAssignment') {
                    expect(args[3]).toBe('g1') // Alpha's id, not the catch-all
                    return {
                        data: plan({ affected: 3 }),
                        isLoading: false,
                        error: null,
                    }
                }
                return {
                    data: { total: 0, offset: 0, items: [] },
                    isLoading: false,
                    error: null,
                }
            }
        )

        fireEvent.click(screen.getByRole('button', { name: /next/i }))
        await waitFor(() =>
            expect(mockUseEngineQuery).toHaveBeenCalledWith(
                'planAssignment',
                expect.arrayContaining(['g1']),
                true
            )
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

    it("shows totals equal to the selection's size", async () => {
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
                data: { total: 0, offset: 0, items: [] },
                isLoading: false,
                error: null,
            }
        })
        await goToPreview('Beta', ['a1', 'a2', 'a3'])
        expect(await screen.findByText('3 objects')).toBeInTheDocument()
    })

    it('downloads the full list as CSV', async () => {
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
            {},
            0,
            expect.any(Number)
        )
        clickSpy.mockRestore()
    })
})
