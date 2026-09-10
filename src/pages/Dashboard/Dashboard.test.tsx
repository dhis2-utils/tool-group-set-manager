import { render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { Dashboard } from './Dashboard'

// Mutable, test-controlled overrides for the mocked engine client below.
// Variable names must start with "mock" -- babel-plugin-jest-hoist only
// allows jest.mock() factories to close over out-of-scope variables with
// that prefix, since jest.mock() calls themselves are hoisted above other
// top-level statements in this file.
const mockCallOverrides: {
    dataElementError: string | null
    extraCleanOrgUnitSet: boolean
} = {
    dataElementError: null,
    extraCleanOrgUnitSet: false,
}

const cleanSet = (id: string, name: string) => ({
    set: {
        id,
        displayName: name,
        objectType: 'organisationUnit',
        compulsory: false,
        dataDimension: false,
        canWrite: true,
        groups: [],
    },
    summary: {
        population: 5,
        ok: 5,
        missingError: 0,
        missingWarning: 0,
        conflict: 0,
    },
    hasData: true,
})

const entries = {
    get organisationUnit() {
        const sets = [
            {
                set: {
                    id: 'own',
                    displayName: 'Ownership',
                    objectType: 'organisationUnit',
                    compulsory: true,
                    dataDimension: true,
                    canWrite: true,
                    groups: [],
                },
                summary: {
                    population: 5,
                    ok: 4,
                    missingError: 1,
                    missingWarning: 0,
                    conflict: 0,
                },
                hasData: true,
            },
            cleanSet('clean', 'Clean set'),
        ]
        if (mockCallOverrides.extraCleanOrgUnitSet) {
            sets.push(cleanSet('clean2', 'Clean set 2'))
        }
        return sets
    },
    dataElement: [] as unknown[],
    indicator: [] as unknown[],
    categoryOption: [] as unknown[],
}

jest.mock('@/hooks/useEngine', () => ({
    useEngine: () => ({
        client: {
            call: async (
                _m: string,
                scope: { objectType: keyof typeof entries }
            ) => {
                if (
                    scope.objectType === 'dataElement' &&
                    mockCallOverrides.dataElementError
                ) {
                    throw new Error(mockCallOverrides.dataElementError)
                }
                return entries[scope.objectType]
            },
        },
        status: {
            phase: 'done',
            type: null,
            progress: null,
            fromCache: {},
            errors: {},
        },
        groupSets: [],
        sourceKind: 'metadata',
        error: null,
        reload: async () => undefined,
    }),
}))
jest.mock('@/hooks/useScope', () => ({
    useScope: () => ({
        rootId: 'root',
        rootName: 'Root',
        setRoot: () => undefined,
        isReady: true,
    }),
}))
jest.mock('@/components/ScopeSelector/ScopeSelector', () => ({
    ScopeSelector: () => <div>scope</div>,
}))

afterEach(() => {
    mockCallOverrides.dataElementError = null
    mockCallOverrides.extraCleanOrgUnitSet = false
})

it('lists sets with issues and hides clean ones by default', async () => {
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    await waitFor(() =>
        expect(screen.getByText('Ownership')).toBeInTheDocument()
    )
    expect(screen.queryByText('Clean set')).not.toBeInTheDocument()
    expect(screen.getByText('1 set without issues hidden')).toBeInTheDocument()
})

it('pluralises the hidden-sets count for more than one clean set', async () => {
    mockCallOverrides.extraCleanOrgUnitSet = true
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    await waitFor(() =>
        expect(
            screen.getByText('2 sets without issues hidden')
        ).toBeInTheDocument()
    )
})

it('surfaces a per-type engine failure instead of silently hiding the section', async () => {
    mockCallOverrides.dataElementError = 'Unknown organisationUnit root id xyz'
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    await waitFor(() =>
        expect(
            screen.getByText("This type's summary could not be computed")
        ).toBeInTheDocument()
    )
    expect(
        screen.getByText('Unknown organisationUnit root id xyz')
    ).toBeInTheDocument()
})
