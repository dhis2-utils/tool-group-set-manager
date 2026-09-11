import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { Settings } from './Settings'

jest.mock('@dhis2/app-runtime', () => ({
    useConfig: () => ({ baseUrl: 'http://localhost:8080', apiVersion: 41 }),
}))

const mockGroupSets = [
    {
        id: 'own',
        displayName: 'Ownership',
        objectType: 'organisationUnit' as const,
        compulsory: true,
        dataDimension: true,
        canWrite: true,
        groups: [
            { id: 'g1', displayName: 'Group one', canWrite: true },
            { id: 'g2', displayName: 'Group two', canWrite: true },
        ],
    },
]

const mockReload = jest.fn()
const mockClearCache = jest.fn(async () => undefined)
const mockEngine = {
    groupSets: mockGroupSets,
    client: null as { call: jest.Mock } | null,
    reload: mockReload,
    clearCache: mockClearCache,
}
jest.mock('@/hooks/useEngine', () => ({
    useEngine: () => mockEngine,
}))

const mockSetRequiredLevels = jest.fn(async () => undefined)
const mockSetCatchAllGroup = jest.fn(async () => undefined)
const mockSetIncludeTracker = jest.fn(async () => undefined)
const mockGsiConfig: {
    config: {
        requiredLevels: Record<string, number[]>
        catchAllGroup: Record<string, string>
        includeTracker: boolean
    }
    isLoaded: boolean
    setRequiredLevels: typeof mockSetRequiredLevels
    setCatchAllGroup: typeof mockSetCatchAllGroup
    setIncludeTracker: typeof mockSetIncludeTracker
} = {
    config: { requiredLevels: {}, catchAllGroup: {}, includeTracker: false },
    isLoaded: true,
    setRequiredLevels: mockSetRequiredLevels,
    setCatchAllGroup: mockSetCatchAllGroup,
    setIncludeTracker: mockSetIncludeTracker,
}
jest.mock('@/hooks/useGsiConfig', () => ({
    useGsiConfig: () => mockGsiConfig,
}))

jest.mock('@/utils/useApiDataQuery', () => ({
    useApiDataQuery: () => ({
        data: {
            organisationUnitLevels: [
                { level: 1, displayName: 'National' },
                { level: 2, displayName: 'District' },
                { level: 3, displayName: 'Chiefdom' },
                { level: 4, displayName: 'Facility' },
            ],
        },
        isLoading: false,
    }),
}))

const mockCheckSqlViews = jest.fn()
const mockCanCreateSqlViews = jest.fn()
const mockCreateOrRepairSqlViews = jest.fn()
jest.mock('@/data/sources/sqlViewAdmin', () => ({
    checkSqlViews: (...args: unknown[]) => mockCheckSqlViews(...args),
    canCreateSqlViews: (...args: unknown[]) => mockCanCreateSqlViews(...args),
    createOrRepairSqlViews: (...args: unknown[]) =>
        mockCreateOrRepairSqlViews(...args),
}))

const usableCheck = (code: string, name: string) => ({
    code,
    name,
    id: `id-${code}`,
    type: 'VIEW',
    readable: true,
    usable: true,
})
const missingCheck = (code: string, name: string) => ({
    code,
    name,
    id: null,
    type: undefined,
    readable: false,
    usable: false,
})

const ALL_USABLE = [
    usableCheck('GSI_ORGUNITS', 'GSI org unit hierarchy'),
    usableCheck('GSI_ORGUNIT_NAMES', 'GSI org unit names'),
    usableCheck('GSI_ORGUNIT_MEMBERSHIPS', 'GSI org unit group memberships'),
]
const ALL_MISSING = [
    missingCheck('GSI_ORGUNITS', 'GSI org unit hierarchy'),
    missingCheck('GSI_ORGUNIT_NAMES', 'GSI org unit names'),
    missingCheck('GSI_ORGUNIT_MEMBERSHIPS', 'GSI org unit group memberships'),
]

beforeEach(() => {
    mockReload.mockClear()
    mockSetRequiredLevels.mockClear()
    mockSetCatchAllGroup.mockClear()
    mockSetIncludeTracker.mockClear()
    mockClearCache.mockClear()
    mockCheckSqlViews.mockReset()
    mockCanCreateSqlViews.mockReset()
    mockCreateOrRepairSqlViews.mockReset()
    mockGsiConfig.config = {
        requiredLevels: {},
        catchAllGroup: {},
        includeTracker: false,
    }
})

describe('SQL view status', () => {
    it('shows each view and whether it is usable', async () => {
        mockCheckSqlViews.mockResolvedValue(ALL_USABLE)
        mockCanCreateSqlViews.mockResolvedValue(true)
        render(<Settings />)
        await waitFor(() =>
            expect(
                screen.getByText('GSI org unit hierarchy')
            ).toBeInTheDocument()
        )
        expect(screen.getByText('GSI org unit names')).toBeInTheDocument()
        expect(
            screen.getByText('GSI org unit group memberships')
        ).toBeInTheDocument()
        // All three usable: no create/repair button offered.
        expect(
            screen.queryByRole('button', { name: /create/i })
        ).not.toBeInTheDocument()
    })

    it('offers to create the missing views when the user has the authority, reports what was created, and reloads onto the new source (I2)', async () => {
        mockCheckSqlViews.mockResolvedValue(ALL_MISSING)
        mockCanCreateSqlViews.mockResolvedValue(true)
        mockCreateOrRepairSqlViews.mockResolvedValue({
            created: [
                'GSI_ORGUNITS',
                'GSI_ORGUNIT_NAMES',
                'GSI_ORGUNIT_MEMBERSHIPS',
            ],
            repaired: [],
            failed: [],
        })
        render(<Settings />)
        const button = await screen.findByRole('button', {
            name: /create sql views/i,
        })
        mockCheckSqlViews.mockResolvedValue(ALL_USABLE)
        await act(async () => {
            fireEvent.click(button)
        })
        expect(mockCreateOrRepairSqlViews).toHaveBeenCalledWith(
            expect.anything(),
            ALL_MISSING
        )
        await waitFor(() =>
            expect(screen.getByText(/created 3 sql views/i)).toBeInTheDocument()
        )
        // I2: without this, the app would stay on the metadata API until a
        // manual reload -- on the instance that motivates this feature, the
        // button would appear to do nothing.
        expect(mockReload).toHaveBeenCalledWith(true)
    })

    it('reports which view failed and why, not just a count (M2)', async () => {
        mockCheckSqlViews.mockResolvedValue(ALL_MISSING)
        mockCanCreateSqlViews.mockResolvedValue(true)
        mockCreateOrRepairSqlViews.mockResolvedValue({
            created: ['GSI_ORGUNITS', 'GSI_ORGUNIT_NAMES'],
            repaired: [],
            failed: [
                {
                    code: 'GSI_ORGUNIT_MEMBERSHIPS',
                    message: 'HTTP 500 executing view',
                },
            ],
        })
        render(<Settings />)
        const button = await screen.findByRole('button', {
            name: /create sql views/i,
        })
        await act(async () => {
            fireEvent.click(button)
        })
        expect(screen.getByText(/GSI_ORGUNIT_MEMBERSHIPS/)).toBeInTheDocument()
        expect(screen.getByText(/HTTP 500 executing view/)).toBeInTheDocument()
        // A partial failure is not a reason to reload if nothing was
        // created or repaired -- but here two of three were, so it should.
        expect(mockReload).toHaveBeenCalledWith(true)
    })

    it('does not reload when nothing was created or repaired', async () => {
        mockCheckSqlViews.mockResolvedValue(ALL_MISSING)
        mockCanCreateSqlViews.mockResolvedValue(true)
        mockCreateOrRepairSqlViews.mockResolvedValue({
            created: [],
            repaired: [],
            failed: [
                { code: 'GSI_ORGUNITS', message: 'boom' },
                { code: 'GSI_ORGUNIT_NAMES', message: 'boom' },
                { code: 'GSI_ORGUNIT_MEMBERSHIPS', message: 'boom' },
            ],
        })
        render(<Settings />)
        const button = await screen.findByRole('button', {
            name: /create sql views/i,
        })
        await act(async () => {
            fireEvent.click(button)
        })
        expect(mockReload).not.toHaveBeenCalled()
    })

    it('shows the status and an explanation, never a create button, for a user without the authority', async () => {
        mockCheckSqlViews.mockResolvedValue(ALL_MISSING)
        mockCanCreateSqlViews.mockResolvedValue(false)
        render(<Settings />)
        await waitFor(() =>
            expect(
                screen.getByText('GSI org unit hierarchy')
            ).toBeInTheDocument()
        )
        expect(
            screen.queryByRole('button', { name: /create sql views/i })
        ).not.toBeInTheDocument()
        expect(
            screen.getByText(/do not have the required authority/i)
        ).toBeInTheDocument()
    })

    // M1
    it('shows an explanation, never a create button, when it could not determine authority', async () => {
        mockCheckSqlViews.mockResolvedValue(ALL_MISSING)
        mockCanCreateSqlViews.mockResolvedValue(null)
        render(<Settings />)
        await waitFor(() =>
            expect(
                screen.getByText('GSI org unit hierarchy')
            ).toBeInTheDocument()
        )
        expect(
            screen.queryByRole('button', { name: /create sql views/i })
        ).not.toBeInTheDocument()
        expect(
            screen.getByText(/could not determine whether you can create/i)
        ).toBeInTheDocument()
    })

    // I1
    it('shows an explicit error and a retry option, never an endless spinner, when the status check itself fails', async () => {
        mockCheckSqlViews.mockRejectedValue(new Error('HTTP 500'))
        mockCanCreateSqlViews.mockResolvedValue(true)
        render(<Settings />)
        await waitFor(() =>
            expect(
                screen.getByText(/could not check sql view status/i)
            ).toBeInTheDocument()
        )
        expect(screen.getByText('HTTP 500')).toBeInTheDocument()
        expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()

        // Retrying re-runs the same, safe (read-only) status check.
        mockCheckSqlViews.mockResolvedValue(ALL_USABLE)
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /try again/i }))
        })
        await waitFor(() =>
            expect(
                screen.getByText('GSI org unit hierarchy')
            ).toBeInTheDocument()
        )
    })
})

describe('required levels', () => {
    // M3: this pins that Settings calls setRequiredLevels correctly and
    // never calls reload itself over this -- NOT that the change takes
    // effect without a reload, which is a claim about useGsiConfig's own
    // wiring and is pinned there (useGsiConfig.test.tsx), independent of
    // this component's mocked version of the hook.
    it('saves the selected levels for an org unit group set, and never calls reload itself', async () => {
        mockCheckSqlViews.mockResolvedValue(ALL_USABLE)
        mockCanCreateSqlViews.mockResolvedValue(true)
        render(<Settings />)
        const placeholder = await screen.findByText('Choose required levels')
        await act(async () => {
            fireEvent.click(placeholder)
        })
        const option = await screen.findByText('District')
        await act(async () => {
            fireEvent.click(option)
        })
        await waitFor(() =>
            expect(mockSetRequiredLevels).toHaveBeenCalledWith('own', [2])
        )
        expect(mockReload).not.toHaveBeenCalled()
    })

    // I3
    it('reports a save failure rather than discarding it silently', async () => {
        mockCheckSqlViews.mockResolvedValue(ALL_USABLE)
        mockCanCreateSqlViews.mockResolvedValue(true)
        mockSetRequiredLevels.mockRejectedValueOnce(new Error('HTTP 403'))
        render(<Settings />)
        const placeholder = await screen.findByText('Choose required levels')
        await act(async () => {
            fireEvent.click(placeholder)
        })
        const option = await screen.findByText('District')
        await act(async () => {
            fireEvent.click(option)
        })
        await waitFor(() =>
            expect(
                screen.getByText(/could not save required levels/i)
            ).toBeInTheDocument()
        )
        expect(screen.getByText('HTTP 403')).toBeInTheDocument()
    })
})

describe('catch-all mapping', () => {
    it('can be set to any group of the set', async () => {
        mockCheckSqlViews.mockResolvedValue(ALL_USABLE)
        mockCanCreateSqlViews.mockResolvedValue(true)
        render(<Settings />)
        const placeholder = await screen.findByText('Choose catch-all group')
        await act(async () => {
            fireEvent.click(placeholder)
        })
        const option = await screen.findByText('Group two')
        await act(async () => {
            fireEvent.click(option)
        })
        await waitFor(() =>
            expect(mockSetCatchAllGroup).toHaveBeenCalledWith('own', 'g2')
        )
    })

    // I3
    it('reports a save failure rather than discarding it silently', async () => {
        mockCheckSqlViews.mockResolvedValue(ALL_USABLE)
        mockCanCreateSqlViews.mockResolvedValue(true)
        mockSetCatchAllGroup.mockRejectedValueOnce(new Error('HTTP 403'))
        render(<Settings />)
        const placeholder = await screen.findByText('Choose catch-all group')
        await act(async () => {
            fireEvent.click(placeholder)
        })
        const option = await screen.findByText('Group two')
        await act(async () => {
            fireEvent.click(option)
        })
        await waitFor(() =>
            expect(
                screen.getByText(/could not save the catch-all group/i)
            ).toBeInTheDocument()
        )
    })
})

describe('tracker toggle', () => {
    // I3
    it('reports a save failure rather than discarding it silently', async () => {
        mockCheckSqlViews.mockResolvedValue(ALL_USABLE)
        mockCanCreateSqlViews.mockResolvedValue(true)
        mockSetIncludeTracker.mockRejectedValueOnce(new Error('HTTP 403'))
        render(<Settings />)
        const checkbox = await screen.findByLabelText(
            /include tracker attributes/i
        )
        await act(async () => {
            fireEvent.click(checkbox)
        })
        await waitFor(() =>
            expect(
                screen.getByText(/could not save the tracker data setting/i)
            ).toBeInTheDocument()
        )
    })
})

describe('clear cache', () => {
    it('clears the cache and reloads', async () => {
        mockCheckSqlViews.mockResolvedValue(ALL_USABLE)
        mockCanCreateSqlViews.mockResolvedValue(true)
        render(<Settings />)
        const button = await screen.findByRole('button', {
            name: /clear cache/i,
        })
        await act(async () => {
            fireEvent.click(button)
        })
        expect(mockClearCache).toHaveBeenCalledTimes(1)
        expect(mockReload).toHaveBeenCalledWith(true)
    })
})
