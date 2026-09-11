import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { GroupSetDetail } from './GroupSetDetail'

// A lightweight stand-in for the real dialog (which has its own heavy set
// of dependencies, exercised in BulkFixDialog.test.tsx) -- this file only
// needs to pin how GroupSetDetail wires the dialog's callbacks (D4/D5),
// exposed here as two buttons a test can click directly.
jest.mock('@/components/BulkFixDialog/BulkFixDialog', () => ({
    BulkFixDialog: ({
        onClose,
        onApplied,
    }: {
        onClose: () => void
        onApplied: (result: unknown) => void
    }) => (
        <div>
            <button onClick={onClose}>mock-dialog-close</button>
            <button onClick={() => onApplied({})}>mock-dialog-applied</button>
        </div>
    ),
}))

// Same stand-in treatment as BulkFixDialog: this file pins the wiring,
// SetPropertiesDialog.test.tsx pins the dialog's own behaviour.
jest.mock('@/components/SetPropertiesDialog/SetPropertiesDialog', () => ({
    SetPropertiesDialog: ({
        onClose,
        onApplied,
    }: {
        onClose: () => void
        onApplied: () => void
    }) => (
        <div>
            <button onClick={onClose}>mock-properties-close</button>
            <button onClick={onApplied}>mock-properties-applied</button>
        </div>
    ),
}))

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
const mockReload = jest.fn()
const mockEngine: {
    groupSets: typeof mockGroupSets
    client: {
        call: (method: string, ...args: unknown[]) => Promise<unknown>
    } | null
    status: import('@/data/loadAll').LoadStatus | null
    reload: (force: boolean) => Promise<void>
} = {
    groupSets: mockGroupSets,
    client: null,
    status: null,
    reload: mockReload,
}
jest.mock('@/hooks/useEngine', () => ({
    useEngine: () => mockEngine,
}))

// Mutable so a test can flip availability mid-session (m6, review round 1) --
// the same pattern as `mockScope`/`mockGroupSets` below.
const mockIntegrity: { available: boolean } = { available: false }
jest.mock('@/hooks/useIntegrity', () => ({
    useIntegrity: () => ({
        get available() {
            return mockIntegrity.available
        },
        checks: [],
        summaries: {},
        stale: new Set(),
        isRunning: false,
        error: null,
        run: async () => undefined,
        markStale: () => undefined,
        refresh: async () => undefined,
    }),
}))

// A lightweight stand-in, same treatment as BulkFixDialog/SetPropertiesDialog
// above -- this file pins the tab wiring (which tab is selected, whether the
// third Tab button shows), IntegrityTab.test.tsx pins the tab's own content.
jest.mock('./IntegrityTab', () => ({
    IntegrityTab: () => <div>mock-integrity-tab</div>,
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
// Captures the query `useApiDataQuery` was called with, so a test can
// inspect the actual params sent for the organisation unit levels lookup
// rather than only the (unconditionally full) mocked response.
const mockApiDataQueryCalls: { resource: string; params?: unknown }[] = []
jest.mock('@/utils/useApiDataQuery', () => ({
    useApiDataQuery: (options: {
        query: { resource: string; params?: unknown }
    }) => {
        mockApiDataQueryCalls.push(options.query)
        return {
            data: {
                organisationUnitLevels: [
                    { level: 1, displayName: 'National' },
                    { level: 2, displayName: 'District' },
                    { level: 3, displayName: 'Chiefdom' },
                    { level: 4, displayName: 'Facility' },
                ],
            },
            isLoading: false,
        }
    },
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
    mockGroupSets[0].canWrite = true
    mockResolveRoots = null
    mockEngine.client = null
    mockScope.rootId = 'root1'
    mockScope.rootName = 'Root'
    mockScope.rootLevel = null
    mockApiDataQueryCalls.length = 0
    mockReload.mockClear()
    mockIntegrity.available = false
    mockEngine.status = null
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

it('queries organisation unit levels without the deprecated paging=false', async () => {
    // @dhis2/app-service-data's RestAPILink warns "Data queries with
    // paging=false are deprecated" for exactly this resource whenever
    // `params.paging` is `false`. The fix keeps the query paginated but
    // asks for a page comfortably larger than any real level hierarchy, so
    // the full list still comes back in one response -- verified here
    // against the actual query object handed to `useApiDataQuery`, not just
    // its (unconditionally complete) mocked response.
    renderDetail()
    await waitFor(() => expect(mockApiDataQueryCalls.length).toBeGreaterThan(0))
    const levelsQuery = mockApiDataQueryCalls.find(
        (q) => q.resource === 'organisationUnitLevels'
    )
    expect(levelsQuery).toBeDefined()
    const params = levelsQuery?.params as Record<string, unknown> | undefined
    expect(params?.paging).not.toBe(false)
    expect(typeof params?.pageSize).toBe('number')
    expect(params?.pageSize as number).toBeGreaterThanOrEqual(20)
})

describe('bulk fix dialog wiring (D4/D5)', () => {
    it('does not close the dialog when a write applies -- only reloads the engine snapshot', async () => {
        renderDetail()
        fireEvent.click(await screen.findByText('Objects'))
        fireEvent.click(await screen.findByText('Bulk fix…'))

        fireEvent.click(await screen.findByText('mock-dialog-applied'))

        // D4: the dialog must still be up after an apply -- only its own
        // Close/Cancel, wired through onClose, may dismiss it.
        expect(screen.getByText('mock-dialog-applied')).toBeInTheDocument()
        // D5: `set.groups` cannot refresh itself, so applying must trigger
        // a (non-forced) reload of the engine snapshot instead.
        expect(mockReload).toHaveBeenCalledWith(false)
    })

    it('closes the dialog when the dialog itself calls onClose', async () => {
        renderDetail()
        fireEvent.click(await screen.findByText('Objects'))
        fireEvent.click(await screen.findByText('Bulk fix…'))

        fireEvent.click(await screen.findByText('mock-dialog-close'))

        await waitFor(() =>
            expect(
                screen.queryByText('mock-dialog-close')
            ).not.toBeInTheDocument()
        )
    })
})

describe('set properties wiring (I4)', () => {
    it('opens the Set properties dialog from the header and reloads once a change applies', async () => {
        renderDetail()

        fireEvent.click(await screen.findByText('Set properties…'))
        fireEvent.click(await screen.findByText('mock-properties-applied'))

        // The properties decide what counts as a violation on every screen
        // for this set, so the snapshot they are computed from must be
        // re-read -- and, as with the bulk fix dialog, applying must not
        // dismiss the dialog.
        expect(mockReload).toHaveBeenCalledWith(false)
        expect(screen.getByText('mock-properties-applied')).toBeInTheDocument()

        fireEvent.click(screen.getByText('mock-properties-close'))
        await waitFor(() =>
            expect(
                screen.queryByText('mock-properties-close')
            ).not.toBeInTheDocument()
        )
    })

    it('does not offer Set properties on a group set the user cannot write to', async () => {
        mockGroupSets[0].canWrite = false
        renderDetail()

        expect(await screen.findByText('Set properties…')).toBeDisabled()
        fireEvent.click(screen.getByText('Set properties…'))
        expect(screen.queryByText('mock-properties-close')).toBeNull()
    })
})

describe('DHIS2 integrity tab (m6, review round 1)', () => {
    it('shows the tab only when integrity is available, and switches to it', async () => {
        mockIntegrity.available = true
        renderDetail()

        fireEvent.click(await screen.findByText('DHIS2 integrity'))
        expect(
            await screen.findByText('mock-integrity-tab')
        ).toBeInTheDocument()
    })

    it('falls back to Overview, not a TabBar with nothing selected, when availability flips false mid-session', async () => {
        mockIntegrity.available = true
        const view = renderDetail()

        fireEvent.click(await screen.findByText('DHIS2 integrity'))
        await screen.findByText('mock-integrity-tab')

        // Availability revoked mid-session (e.g. a 403 on a later call) --
        // the Tab button disappears on the next render; without the fix,
        // `tab` state itself stayed 'integrity' and the body silently fell
        // through to ObjectsTab while the TabBar showed nothing selected.
        mockIntegrity.available = false
        view.rerender(
            <MemoryRouter initialEntries={['/sets/own']}>
                <Routes>
                    <Route path="/sets/:setId" element={<GroupSetDetail />} />
                </Routes>
            </MemoryRouter>
        )

        await waitFor(() =>
            expect(
                screen.queryByText('mock-integrity-tab')
            ).not.toBeInTheDocument()
        )
        expect(screen.queryByText('DHIS2 integrity')).not.toBeInTheDocument()
        // Landed on Overview content, not a body left over from the
        // Integrity tab with no selected Tab above it.
        expect(await screen.findByText('Rows')).toBeInTheDocument()
    })
})

describe('background reload indicator (Task 7, carried forward from Plan 1)', () => {
    it('says a reload is running and which type it is loading, from the same status the dashboard reads', async () => {
        mockEngine.status = {
            phase: 'objects',
            type: 'organisationUnit',
            progress: null,
            fromCache: {},
            errors: {},
        }
        renderDetail()

        expect(
            await screen.findByText(/Loading organisation units/)
        ).toBeInTheDocument()
    })

    it('says nothing once the load has finished, without the page itself disappearing', async () => {
        mockEngine.status = {
            phase: 'done',
            type: null,
            progress: null,
            fromCache: {},
            errors: {},
        }
        renderDetail()

        // Asserting only "the indicator is absent" cannot tell a finished
        // load apart from the whole page failing to render -- the title
        // and the Overview tab (unrelated to the reload status) must still
        // be there.
        expect(await screen.findByText('Ownership')).toBeInTheDocument()
        expect(screen.getByText('Overview')).toBeInTheDocument()
        expect(screen.queryByText(/Loading/)).not.toBeInTheDocument()
    })

    it('keeps the numbers on screen while a reload runs instead of blanking the page for a loader', async () => {
        mockEngine.status = {
            phase: 'memberships',
            type: 'organisationUnit',
            progress: null,
            fromCache: {},
            errors: {},
        }
        renderDetail()

        // The reload indication and the page's own content are both
        // present at once -- the indicator augments the page, it does not
        // replace it.
        expect(
            await screen.findByText(/Loading group memberships/)
        ).toBeInTheDocument()
        expect(screen.getByText('Ownership')).toBeInTheDocument()
        expect(screen.getByText('Overview')).toBeInTheDocument()
    })
})
