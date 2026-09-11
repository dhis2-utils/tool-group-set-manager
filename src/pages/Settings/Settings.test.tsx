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
const mockEngine = {
    groupSets: mockGroupSets,
    client: null as { call: jest.Mock } | null,
    reload: mockReload,
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

const mockClearCache = jest.fn(async () => undefined)
jest.mock('@/data/cache', () => ({
    openCache: () => ({ clear: mockClearCache }),
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

    it('offers to create the missing views when the user has the authority, and reports what was created', async () => {
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
})

describe('required levels', () => {
    it('saves the selected levels for an org unit group set and takes effect without a reload', async () => {
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
        // D1: no reload call is needed for the change to take effect -- the
        // hook itself pushes the new config into the engine.
        expect(mockReload).not.toHaveBeenCalled()
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
