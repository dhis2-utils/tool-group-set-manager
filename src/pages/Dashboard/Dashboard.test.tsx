import { render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { Dashboard } from './Dashboard'

const entries = {
    organisationUnit: [
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
        {
            set: {
                id: 'clean',
                displayName: 'Clean set',
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
        },
    ],
    dataElement: [],
    indicator: [],
    categoryOption: [],
}

jest.mock('@/hooks/useEngine', () => ({
    useEngine: () => ({
        client: {
            call: async (
                _m: string,
                scope: { objectType: keyof typeof entries }
            ) => entries[scope.objectType],
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
    expect(screen.getByText(/1 .*without issues/)).toBeInTheDocument()
})
