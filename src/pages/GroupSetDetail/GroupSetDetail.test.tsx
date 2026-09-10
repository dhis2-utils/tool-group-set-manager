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

// Mutable so a test can put the engine behind the level lookup, or take it
// away again. `call` is all `useEngineQuery` needs of a client.
const mockEngine: {
    groupSets: typeof mockGroupSets
    client: {
        call: (method: string, ...args: unknown[]) => Promise<unknown>
    } | null
    status: null
} = {
    groupSets: mockGroupSets,
    client: null,
    status: null,
}
jest.mock('@/hooks/useEngine', () => ({
    useEngine: () => mockEngine,
}))

const mockScope: {
    rootId: string
    rootName: string
    rootLevel: number | null
} = {
    rootId: 'root1',
    rootName: 'Root',
    rootLevel: null,
}
jest.mock('@/hooks/useScope', () => ({
    useScope: () => mockScope,
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
    mockEngine.client = null
    mockScope.rootId = 'root1'
    mockScope.rootName = 'Root'
    mockScope.rootLevel = null
})

const renderDetail = () =>
    render(
        <MemoryRouter initialEntries={['/sets/own']}>
            <Routes>
                <Route path="/sets/:setId" element={<GroupSetDetail />} />
            </Routes>
        </MemoryRouter>
    )

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

it('offers only levels below the scope when the scope carries its own level', async () => {
    // A scope chosen through the org unit tree is not among the user's roots,
    // so its level can only come from the selection itself. Without it the
    // scope read as level 1: the row level list offered levels above the
    // scope, the default row level was wrong, and the matrix keyed rows on
    // org units outside the scope entirely.
    mockScope.rootId = 'chiefdom-deep-in-the-tree'
    mockScope.rootLevel = 3
    renderDetail()
    await waitFor(() =>
        expect(screen.getByText(/Facility/)).toBeInTheDocument()
    )
    expect(screen.queryByText(/District/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Chiefdom/)).not.toBeInTheDocument()
})

it('falls back to the engine for the level of a scope stored without one', async () => {
    mockScope.rootId = 'chiefdom-deep-in-the-tree'
    mockScope.rootLevel = null
    const calls: unknown[][] = []
    mockEngine.client = {
        call: async (method: string, ...args: unknown[]) => {
            calls.push([method, ...args])
            return method === 'levelOf' ? 3 : null
        },
    }
    renderDetail()
    await waitFor(() =>
        expect(screen.getByText(/Facility/)).toBeInTheDocument()
    )
    expect(screen.queryByText(/District/)).not.toBeInTheDocument()
    expect(calls).toContainEqual([
        'levelOf',
        'organisationUnit',
        'chiefdom-deep-in-the-tree',
    ])
})
