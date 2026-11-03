import { render, screen } from '@testing-library/react'
import React from 'react'
import { OverviewTab } from './OverviewTab'

// babel-plugin-jest-hoist only allows a jest.mock() factory to reference
// out-of-scope variables whose names start with "mock" (see the matching
// comment in Dashboard.test.tsx).
const mockUseEngineQuery = jest.fn()
jest.mock('@/hooks/useEngineQuery', () => ({
    useEngineQuery: (...args: unknown[]) => mockUseEngineQuery(...args),
}))

const set = {
    id: 'own',
    displayName: 'Ownership',
    objectType: 'organisationUnit' as const,
    compulsory: true,
    dataDimension: true,
    canWrite: true,
    groups: [{ id: 'a', displayName: 'Public', canWrite: true }],
}
const scope = { objectType: 'organisationUnit' as const, rootId: 'r' }
const result = {
    groups: [{ id: 'a', displayName: 'Public', canWrite: true }],
    rows: [
        {
            object: 1,
            row: {
                index: 1,
                id: 'A',
                displayName: 'Bo',
                level: 2,
                parentId: 'r',
            },
            perGroup: [12],
            missing: 3,
            unassigned: 0,
            conflict: 1,
            total: 16,
        },
    ],
}

const renderTab = () =>
    render(
        <OverviewTab
            set={set}
            scope={scope}
            rowLevel={2}
            onCell={() => undefined}
        />
    )

test('keeps the matrix on screen while the same query is re-run during a load', () => {
    // `useEngineQuery` re-runs on every engine load phase and type change,
    // flagging isLoading while keeping the data for those same arguments.
    // Checking isLoading first would swap the whole matrix for a spinner on
    // each of those, several times per load.
    mockUseEngineQuery.mockReturnValue({
        data: result,
        isLoading: true,
        error: null,
    })
    renderTab()
    expect(screen.getByText('Bo')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
})

test('shows the loader, not stale numbers, when the arguments change', () => {
    // The hook masks a result belonging to different arguments, so a scope
    // or row level change arrives here as "no data yet".
    mockUseEngineQuery.mockReturnValue({
        data: undefined,
        isLoading: true,
        error: null,
    })
    const { container } = renderTab()
    expect(screen.queryByText('Bo')).not.toBeInTheDocument()
    expect(
        container.querySelector('[data-test="dhis2-uicore-circularloader"]')
    ).toBeInTheDocument()
})
