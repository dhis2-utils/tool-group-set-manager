import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { ObjectsTable } from './ObjectsTable'
import { actAndFlush } from '@/testing/actAndFlush'

/**
 * Unlike ObjectsTable.test.tsx, this file deliberately does NOT mock
 * `useEngineQuery`: the failure it covers lived in the seam between the two.
 * The hook kept the previous arguments' resolved result while it loaded the
 * new ones, so a filter change with no scrolling handed the table the old
 * filter's page 0 against its own freshly reset (also offset 0) list -- the
 * old rows were folded in under the new filter's label, and because the
 * loaded row count then no longer equalled the offset, the real response for
 * the new filter was rejected for good. Only the component and the real hook
 * running together show that.
 */
interface Pending {
    method: string
    args: unknown[]
    resolve: (result: unknown) => void
}
const mockPending: Pending[] = []
// Read at render time, so mutating it and re-rendering is exactly what an
// engine load phase change looks like to the hook.
let mockPhase = 'done'
jest.mock('@/hooks/useEngine', () => ({
    useEngine: () => ({
        client: {
            call: (method: string, ...args: unknown[]) =>
                new Promise((resolve) => {
                    mockPending.push({ method, args, resolve })
                }),
        },
        status: {
            phase: mockPhase,
            type: null,
            progress: null,
            fromCache: {},
            errors: {},
        },
    }),
}))

// The membership write path is exercised end to end in ObjectsTable.test.tsx
// (which mocks useEngineQuery instead of useEngine, so it can control page
// loading independently of the write). This file's own concern is that the
// interactive control keeps working once the *real* useEngineQuery/paging
// machinery is in play alongside it -- so useMembershipWrite is mocked here,
// same as an engine-level dependency the write flow would otherwise need
// (useConfig, react-query's QueryClientProvider, writeMemberships,
// saveChangeSet) purely to satisfy import chains unrelated to paging.
const mockWrite = jest.fn()
jest.mock('@/hooks/useMembershipWrite', () => ({
    useMembershipWrite: () => ({ write: mockWrite, isWriting: false }),
}))

const set = {
    id: 'own',
    displayName: 'Ownership',
    objectType: 'organisationUnit' as const,
    compulsory: true,
    dataDimension: true,
    canWrite: true,
    groups: [
        { id: 'a', displayName: 'Public', canWrite: true },
        { id: 'b', displayName: 'Private', canWrite: true },
    ],
}
const scope = { objectType: 'organisationUnit' as const, rootId: 'r' }

// jsdom reports zero for both, which would leave the virtualizer with
// nothing in range; 600px is the height `.scroll` is fixed at in the CSS.
// See the fuller comment in ObjectsTable.test.tsx.
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    value: 600,
})
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    value: 800,
})

const lastPendingFor = (method: string) => {
    // oxlint-disable-next-line unicorn/no-array-reverse -- reverses a fresh copy; findLast() is not in this repo's ES2020 lib
    const pending = [...mockPending].reverse().find((p) => p.method === method)
    if (!pending) {
        throw new Error(`no pending ${method} request`)
    }
    return pending
}
const lastPending = () => lastPendingFor('objectsFor')

/**
 * Answers the outstanding `objectsFor` request the way `EngineStore` would,
 * then also answers the `resolveParents` request that page's own rows
 * bring with them (D1) -- the component's append effect (ObjectsTable.tsx)
 * waits for both to land before showing the page at all, so a caller that
 * settled only the first would never see its rows either.
 */
const settle = async (label: string, total: number, count = 200) => {
    const pending = lastPendingFor('objectsFor')
    const offset = pending.args[3] as number
    const items = Array.from({ length: count }, (_, i) => ({
        index: offset + i,
        id: `${label}-${offset + i}`,
        displayName: `${label} ${offset + i}`,
        level: 4,
        parentId: 'p',
        status: 1,
        groups: [0],
    }))
    await actAndFlush(() => {
        pending.resolve({ total, offset, items })
    })
    await actAndFlush(() => {
        lastPendingFor('resolveParents').resolve(items.map(() => null))
    })
}

beforeEach(() => {
    mockPending.length = 0
    mockPhase = 'done'
    mockWrite.mockReset()
    mockWrite.mockResolvedValue({
        outcomes: [],
        applied: [],
        unaccounted: [],
        changeSet: {} as never,
    })
})

test('replaces the rows when the filter changes without scrolling, and still accepts the new filter pages', async () => {
    const { rerender } = render(
        <ObjectsTable set={set} scope={scope} filter={{}} />
    )
    await settle('Old', 1000)
    expect(screen.getByText('Old 0')).toBeInTheDocument()

    // No scrolling first: the new filter's request is for offset 0, exactly
    // the offset the previous filter's result carries.
    rerender(<ObjectsTable set={set} scope={scope} filter={{ level: 4 }} />)
    expect(screen.queryByText('Old 0')).not.toBeInTheDocument()
    expect(lastPending().args[3]).toBe(0)

    await settle('New', 500)
    expect(screen.getByText('New 0')).toBeInTheDocument()
    expect(screen.queryByText('Old 0')).not.toBeInTheDocument()
    expect(screen.getByText(/500 objects/)).toBeInTheDocument()

    // And the list is not wedged: the next page for the new filter is asked
    // for and accepted.
    const scrollEl = screen.getByTestId('objects-table-scroll')
    act(() => {
        scrollEl.scrollTop = 6000
        fireEvent.scroll(scrollEl)
    })
    await waitFor(() => expect(lastPending().args[3]).toBe(200))
    await settle('New', 500)
    act(() => {
        scrollEl.scrollTop = 13000
        fireEvent.scroll(scrollEl)
    })
    await waitFor(() => expect(screen.getByText('New 380')).toBeInTheDocument())
})

test('keeps the rows and does not duplicate the held page when the engine load phase changes', async () => {
    // The join the two earlier fixes each covered only one half of. The hook
    // re-issues the identical query on every load phase and type change --
    // pressing Reload fires several -- and must keep its data through them
    // (the mask is keyed on the query, not on the phase), while the table
    // must recognise the re-resolved page as one it already holds and not
    // append it again. Covered before only by the hook's own unit test and
    // by the table's hand-rolled fake; this drives both for real.
    const { rerender } = render(
        <ObjectsTable set={set} scope={scope} filter={{}} />
    )
    await settle('Row', 1000)
    expect(screen.getByText('Row 0')).toBeInTheDocument()
    expect(mockPending.filter((p) => p.method === 'objectsFor')).toHaveLength(1)

    mockPhase = 'names'
    rerender(<ObjectsTable set={set} scope={scope} filter={{}} />)

    // The same query, re-issued -- and the rows stay on screen throughout.
    expect(mockPending.filter((p) => p.method === 'objectsFor')).toHaveLength(2)
    expect(lastPending().args[3]).toBe(0)
    expect(screen.getByText('Row 0')).toBeInTheDocument()

    await settle('Row', 1000)
    expect(screen.getByText('Row 0')).toBeInTheDocument()

    // The page already held was not appended a second time: exactly one
    // "Row 5" on screen, and the total is still the engine's real total.
    rerender(<ObjectsTable set={set} scope={scope} filter={{}} />)
    expect(screen.getAllByText('Row 5')).toHaveLength(1)
    expect(screen.getByText(/1,000 objects/)).toBeInTheDocument()
})

test('sends filter.text to the real engine and renders a match beyond the first page (M1)', async () => {
    // Review round 1, Major-1: the flagship "whole population" claim in
    // ObjectsTable.test.tsx runs against a hand-rolled fake that this same
    // branch edited to make that test pass. This drives the identical claim
    // through the real `useEngineQuery`/`useEngine` pair instead, so the
    // claim rests on production behaviour rather than on the fake.
    const { rerender } = render(
        <ObjectsTable set={set} scope={scope} filter={{}} />
    )
    await settle('Old', 100000)
    expect(screen.getByText('Old 0')).toBeInTheDocument()

    rerender(
        <ObjectsTable set={set} scope={scope} filter={{ text: 'beyond' }} />
    )
    expect(screen.queryByText('Old 0')).not.toBeInTheDocument()
    expect(lastPending().args[2]).toMatchObject({ text: 'beyond' })
    expect(lastPending().args[3]).toBe(0)

    // The engine's own answer: one row at object index 50000 -- never part
    // of any page this table had loaded before the search term arrived.
    const matchItems = [
        {
            index: 50000,
            id: 'far0',
            displayName: 'Beyond Match',
            level: 4,
            parentId: 'p',
            status: 1,
            groups: [0],
        },
    ]
    const pending = lastPendingFor('objectsFor')
    await actAndFlush(() => {
        pending.resolve({ total: 1, offset: 0, items: matchItems })
    })
    await actAndFlush(() => {
        lastPendingFor('resolveParents').resolve(matchItems.map(() => null))
    })
    expect(screen.getByText('Beyond Match')).toBeInTheDocument()
    expect(screen.getByText(/1 object\b/)).toBeInTheDocument()
})

test('assigns a row loaded through the real paging pipeline, confirming before it calls the write hook', async () => {
    render(<ObjectsTable set={set} scope={scope} filter={{}} />)
    await settle('Row', 1000)
    expect(screen.getByText('Row 0')).toBeInTheDocument()

    // Every loaded row starts in group 0 ("Public") only -- see `settle`.
    // Choosing group 1 ("Private") for the first row is a real move: one
    // deletion from Public, one addition to Private.
    const firstRowButtons = screen.getAllByRole('button', { name: 'Private' })
    fireEvent.click(firstRowButtons[0])
    expect(screen.getByText('Confirm group change')).toBeInTheDocument()
    expect(mockWrite).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Assign'))
    await waitFor(() => expect(mockWrite).toHaveBeenCalledTimes(1))
    expect(mockWrite.mock.calls[0][0]).toMatchObject({
        set,
        action: 'assign',
        targetGroupId: 'b',
        changes: [
            { groupId: 'a', additions: [], deletions: ['Row-0'] },
            { groupId: 'b', additions: ['Row-0'], deletions: [] },
        ],
    })
})
