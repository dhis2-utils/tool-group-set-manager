import { act, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { GroupSetDetail } from './GroupSetDetail'

// babel-plugin-jest-hoist only allows a jest.mock() factory to reference
// out-of-scope variables whose names start with "mock" (see the matching
// comment in Dashboard.test.tsx and useEngineQuery.test.tsx).
const mockGroupSets = [
    {
        id: 'own',
        displayName: 'Ownership',
        objectType: 'organisationUnit' as const,
        compulsory: true,
        dataDimension: true,
        canWrite: true,
        groups: [{ id: 'g1', displayName: 'G1', canWrite: true }],
    },
]

jest.mock('@/hooks/useEngine', () => ({
    useEngine: () => ({
        groupSets: mockGroupSets,
        client: null,
        status: null,
    }),
}))
jest.mock('@/hooks/useScope', () => ({
    useScope: () => ({ rootId: 'root1', rootName: 'Root' }),
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

// Simulates `useUserScope`'s roots resolving asynchronously, the way the
// real hook does while its underlying `me` query is in flight: renders with
// no roots first (so `GroupSetDetail`'s `scopeLevel` falls back to 1 and
// seeds `rowLevel` at 2), then -- after a real React state update, not just
// a prop change -- resolves to a root three levels deep. `levels` then
// recomputes to only contain level 4, which no longer contains the
// `rowLevel` (2) seeded before the roots arrived.
let mockResolveRoots: (() => void) | null = null
jest.mock('@/hooks/useUserScope', () => {
    const ReactActual = jest.requireActual('react')
    return {
        useUserScope: () => {
            const [resolved, setResolved] = ReactActual.useState(false)
            mockResolveRoots = () => setResolved(true)
            const roots = resolved
                ? [{ id: 'root1', displayName: 'Root', level: 3 }]
                : []
            return {
                isLoading: !resolved,
                roots,
                authorities: new Set(),
                hasAuthority: () => false,
            }
        },
    }
})

afterEach(() => {
    mockResolveRoots = null
})

it('keeps the row level in sync when late-arriving roots change the available levels, instead of crashing', async () => {
    render(
        <MemoryRouter initialEntries={['/sets/own']}>
            <Routes>
                <Route path="/sets/:setId" element={<GroupSetDetail />} />
            </Routes>
        </MemoryRouter>
    )

    // Before the roots resolve: scopeLevel falls back to 1, rowLevel seeds
    // at 2, and levels (filtered to > 1) include level 2 -- so the selector
    // renders fine and shows "District".
    await waitFor(() =>
        expect(screen.getByText(/District/)).toBeInTheDocument()
    )

    // Now the roots resolve to a level-3 root. `levels` recomputes to
    // levels > 3, i.e. only level 4 -- `rowLevel` (still 2) is no longer
    // among them. Without a fix, @dhis2/ui's SingleSelect throws for this
    // exact mismatch (verified against the same crash in the browser).
    act(() => {
        mockResolveRoots?.()
    })

    await waitFor(() =>
        expect(screen.getByText(/Facility/)).toBeInTheDocument()
    )
    expect(screen.queryByText(/District/)).not.toBeInTheDocument()
})
