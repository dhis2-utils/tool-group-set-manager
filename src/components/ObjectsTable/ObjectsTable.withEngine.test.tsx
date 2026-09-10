import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { ObjectsTable } from './ObjectsTable'

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
            call: (_method: string, ...args: unknown[]) =>
                new Promise((resolve) => {
                    mockPending.push({ args, resolve })
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

const lastPending = () => mockPending[mockPending.length - 1]

/** Answers the outstanding request the way EngineStore.objectsFor would. */
const settle = async (label: string, total: number, count = 200) => {
    const pending = lastPending()
    const offset = pending.args[3] as number
    await act(async () => {
        pending.resolve({
            total,
            offset,
            items: Array.from({ length: count }, (_, i) => ({
                index: offset + i,
                id: `${label}-${offset + i}`,
                displayName: `${label} ${offset + i}`,
                level: 4,
                parentId: 'p',
                status: 1,
                groups: [0],
            })),
        })
    })
}

beforeEach(() => {
    mockPending.length = 0
    mockPhase = 'done'
})

it('replaces the rows when the filter changes without scrolling, and still accepts the new filter pages', async () => {
    const { rerender } = render(
        <ObjectsTable set={set} scope={scope} filter={{}} search="" />
    )
    await settle('Old', 1000)
    expect(screen.getByText('Old 0')).toBeInTheDocument()

    // No scrolling first: the new filter's request is for offset 0, exactly
    // the offset the previous filter's result carries.
    rerender(
        <ObjectsTable set={set} scope={scope} filter={{ level: 4 }} search="" />
    )
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

it('keeps the rows and does not duplicate the held page when the engine load phase changes', async () => {
    // The join the two earlier fixes each covered only one half of. The hook
    // re-issues the identical query on every load phase and type change --
    // pressing Reload fires several -- and must keep its data through them
    // (the mask is keyed on the query, not on the phase), while the table
    // must recognise the re-resolved page as one it already holds and not
    // append it again. Covered before only by the hook's own unit test and
    // by the table's hand-rolled fake; this drives both for real.
    const { rerender } = render(
        <ObjectsTable set={set} scope={scope} filter={{}} search="" />
    )
    await settle('Row', 1000)
    expect(screen.getByText('Row 0')).toBeInTheDocument()
    expect(mockPending).toHaveLength(1)

    mockPhase = 'names'
    rerender(<ObjectsTable set={set} scope={scope} filter={{}} search="" />)

    // The same query, re-issued -- and the rows stay on screen throughout.
    expect(mockPending).toHaveLength(2)
    expect(lastPending().args[3]).toBe(0)
    expect(screen.getByText('Row 0')).toBeInTheDocument()

    await settle('Row', 1000)
    expect(screen.getByText('Row 0')).toBeInTheDocument()

    // The page already held was not appended a second time: the search note
    // counts the loaded rows, and "Row" matches every one of them.
    rerender(<ObjectsTable set={set} scope={scope} filter={{}} search="Row" />)
    expect(screen.getByText(/200 rows loaded so far/)).toBeInTheDocument()
    expect(screen.getAllByText('Row 5')).toHaveLength(1)
    expect(screen.getByText(/1,000 objects/)).toBeInTheDocument()
})
