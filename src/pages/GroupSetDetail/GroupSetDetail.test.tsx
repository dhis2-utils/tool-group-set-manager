import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { GroupSetDetail } from './GroupSetDetail'
import { ObjectType } from '@/engine/types'

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
const mockGroupSets: {
    id: string
    displayName: string
    objectType: ObjectType
    compulsory: boolean
    dataDimension: boolean
    canWrite: boolean
    groups: { id: string; displayName: string; canWrite: boolean }[]
}[] = [
    {
        id: 'own',
        displayName: 'Ownership',
        objectType: 'organisationUnit',
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
// Task 6: a spy rather than a stateful mock -- GroupSetDetail's own
// `setRowLevel` (real React state) is what the drill-down test observes
// through the Rows field re-rendering; this only pins what `setRoot` is
// called with.
const mockSetRoot = jest.fn()
jest.mock('@/hooks/useScope', () => ({
    useScope: () => ({ ...mockScope, setRoot: mockSetRoot }),
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
//
// The bar now renders `OrgUnitField`, which calls this same hook, so
// `useUserScope` runs more than once per render of the page (once for
// `GroupSetDetail` itself, once for `OrgUnitField`). Keeping "resolved" in
// a plain per-call `useState` would let whichever instance rendered last
// own `mockResolveRoots`, silently detaching it from the other -- so the
// resolved flag lives here, outside React, with every mounted instance
// subscribed to force its own re-render when it flips.
let mockResolvedRoots = false
const mockRootsSubscribers = new Set<() => void>()
let mockResolveRoots: (() => void) | null = null
jest.mock('@/hooks/useUserScope', () => {
    const ReactActual = jest.requireActual('react')
    return {
        useUserScope: () => {
            const [, forceRender] = ReactActual.useReducer(
                (c: number) => c + 1,
                0
            )
            ReactActual.useEffect(() => {
                mockRootsSubscribers.add(forceRender)
                return () => {
                    mockRootsSubscribers.delete(forceRender)
                }
            }, [forceRender])
            mockResolveRoots = () => {
                mockResolvedRoots = true
                mockRootsSubscribers.forEach((fn) => fn())
            }
            const roots = mockResolvedRoots
                ? [{ id: 'root1', displayName: 'Root', level: 3 }]
                : []
            return {
                isLoading: !mockResolvedRoots,
                roots,
                authorities: new Set(),
                hasAuthority: () => false,
            }
        },
    }
})

afterEach(() => {
    mockGroupSets[0].canWrite = true
    mockGroupSets[0].objectType = 'organisationUnit'
    mockResolveRoots = null
    mockResolvedRoots = false
    mockRootsSubscribers.clear()
    mockEngine.client = null
    mockScope.rootId = 'root1'
    mockScope.rootName = 'Root'
    mockScope.rootLevel = null
    mockApiDataQueryCalls.length = 0
    mockReload.mockClear()
    mockSetRoot.mockClear()
    mockIntegrity.available = false
    mockEngine.status = null
})

const renderDetail = (overrides: Partial<(typeof mockGroupSets)[0]> = {}) => {
    Object.assign(mockGroupSets[0], overrides)
    return render(
        <MemoryRouter initialEntries={['/sets/own']}>
            <Routes>
                <Route path="/sets/:setId" element={<GroupSetDetail />} />
            </Routes>
        </MemoryRouter>
    )
}

// Spec 2026-09-15 §4.1: the organisation unit is reachable without leaving
// the group set you are working in -- that was the review's complaint.
it('shows the organisation unit field on the group set page', async () => {
    renderDetail({ objectType: 'organisationUnit' })
    expect(await screen.findByText('Organisation unit')).toBeInTheDocument()
})

// A data element group set has no organisation unit scope, and a control
// that changes nothing on screen is worse than no control.
it('hides the organisation unit field for a non-hierarchical type', async () => {
    renderDetail({ objectType: 'dataElement' })
    await screen.findByText('Overview')
    expect(screen.queryByText('Organisation unit')).not.toBeInTheDocument()
})

// The bar shows the organisation unit, so the header tag that repeated it
// is gone.
it('does not repeat the organisation unit as a header tag', async () => {
    renderDetail({ objectType: 'organisationUnit' })
    await screen.findByText('Overview')
    expect(screen.queryByText(/^Scope \(/)).not.toBeInTheDocument()
})

// Task 5: the header tag used to join every group name with " · ", which
// overflows on an EMIS-scale set and reads as a list of things one object
// is in when an object is in exactly one of them. It is now a count chip;
// the distribution itself lives in the Overview tab's GroupsPanel instead.
it('shows a group count chip in the header instead of the group names', async () => {
    renderDetail({
        objectType: 'organisationUnit',
        groups: [
            { id: 'g1', displayName: 'Alpha', canWrite: true },
            { id: 'g2', displayName: 'Bravo', canWrite: true },
            { id: 'g3', displayName: 'Charlie', canWrite: true },
            { id: 'g4', displayName: 'Delta', canWrite: true },
        ],
    })
    await screen.findByText('Overview')
    expect(screen.getByText('4 groups')).toBeInTheDocument()
    expect(
        screen.queryByText('Alpha · Bravo · Charlie · Delta')
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
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

describe('DHIS2 integrity check header button (Task 7)', () => {
    // The complaint this task fixes: the feature was reachable only by
    // noticing a tab. The button is a second way in, not a second way to
    // run the checks -- it only switches to the tab that already owns
    // running them (see the m6 describe block above for that tab-state
    // wiring).
    it('offers the integrity check from the header when it is available', async () => {
        mockIntegrity.available = true
        renderDetail()

        const button = await screen.findByRole('button', {
            name: 'Run DHIS2 integrity checks',
        })
        fireEvent.click(button)
        // it takes the user to the tab that runs them
        expect(
            await screen.findByRole('tab', { selected: true })
        ).toHaveTextContent('DHIS2 integrity')
    })

    it('offers nothing when the user may not read integrity results', async () => {
        mockIntegrity.available = false
        renderDetail()

        await screen.findByText('Overview')
        expect(
            screen.queryByRole('button', {
                name: 'Run DHIS2 integrity checks',
            })
        ).not.toBeInTheDocument()
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
            namesErrors: {},
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
            namesErrors: {},
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
            namesErrors: {},
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

describe('drilling into a matrix row (Task 6)', () => {
    // The review's complaint: "rows should be clickable to drill down --
    // this was intended in v1 but does not appear to work for orgunits,
    // only groups." Numeric cells already opened the Objects tab; the row
    // label itself did nothing.
    it('drills into a row, moving the scope and the row level down together', async () => {
        // A level known up front (rather than the null default) so the
        // matrix can render immediately, with no `levelOf` round trip.
        mockScope.rootLevel = 1
        mockEngine.client = {
            call: async (method: string) => {
                if (method === 'matrixFor') {
                    return {
                        groups: [
                            { id: 'g1', displayName: 'G1', canWrite: true },
                        ],
                        rows: [
                            {
                                object: 1,
                                row: {
                                    index: 1,
                                    id: 'ou-badjia',
                                    displayName: 'Badjia',
                                    level: 2,
                                    parentId: 'root1',
                                },
                                perGroup: [5],
                                missing: 0,
                                unassigned: 0,
                                conflict: 0,
                                total: 5,
                            },
                        ],
                    }
                }
                return null
            },
        }
        renderDetail({ objectType: 'organisationUnit' })

        // Seeded at scopeLevel (1) + 1 -- the fixture's own level list
        // (National=1, District=2, Chiefdom=3, Facility=4) -- so the row
        // level starts at District (2), matching the fixture row above.
        expect(await screen.findByText('District (level 2)')).toBeInTheDocument()

        fireEvent.click(await screen.findByRole('button', { name: 'Badjia' }))

        // The row's own level -- the current row level, per decision 1 --
        // not the row's `level` field (2, coincidentally the same value
        // here) and not re-derived from any path.
        expect(mockSetRoot).toHaveBeenCalledWith('ou-badjia', 'Badjia', 2)
        // The Rows field follows the scope one level deeper.
        expect(
            await screen.findByText('Chiefdom (level 3)')
        ).toBeInTheDocument()
        expect(screen.queryByText('District (level 2)')).not.toBeInTheDocument()
    })

    it('does not offer drilling on the deepest available row level', async () => {
        // A scope rooted at the Chiefdom level (3) leaves only Facility (4)
        // in the fixture's level list -- the row level seeds there, at
        // scopeLevel + 1, with nothing below it to drill into.
        mockScope.rootId = 'chiefdom-deep-in-the-tree'
        mockScope.rootLevel = 3
        mockEngine.client = {
            call: async (method: string) => {
                if (method === 'matrixFor') {
                    return {
                        groups: [
                            { id: 'g1', displayName: 'G1', canWrite: true },
                        ],
                        rows: [
                            {
                                object: 1,
                                row: {
                                    index: 1,
                                    id: 'ou-facility',
                                    displayName: 'Some Facility',
                                    level: 4,
                                    parentId: 'chiefdom-deep-in-the-tree',
                                },
                                perGroup: [5],
                                missing: 0,
                                unassigned: 0,
                                conflict: 0,
                                total: 5,
                            },
                        ],
                    }
                }
                return null
            },
        }
        renderDetail({ objectType: 'organisationUnit' })

        expect(
            await screen.findByText('Facility (level 4)')
        ).toBeInTheDocument()
        expect(await screen.findByText('Some Facility')).toBeInTheDocument()
        expect(
            screen.queryByRole('button', { name: 'Some Facility' })
        ).not.toBeInTheDocument()
    })

    it('does not offer drilling for a non-hierarchical object type', async () => {
        mockScope.rootLevel = 1
        mockEngine.client = {
            call: async (method: string) => {
                if (method === 'matrixFor') {
                    return {
                        groups: [
                            { id: 'g1', displayName: 'G1', canWrite: true },
                        ],
                        rows: [
                            {
                                object: -1,
                                row: null,
                                perGroup: [5],
                                missing: 0,
                                unassigned: 0,
                                conflict: 0,
                                total: 5,
                            },
                        ],
                    }
                }
                return null
            },
        }
        renderDetail({ objectType: 'dataElement' })
        expect(await screen.findByText('All objects')).toBeInTheDocument()
        expect(
            screen.queryByRole('button', { name: 'All objects' })
        ).not.toBeInTheDocument()
    })
})
