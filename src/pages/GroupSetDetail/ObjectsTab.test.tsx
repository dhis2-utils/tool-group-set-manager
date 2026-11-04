import { act, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { ObjectsTab } from './ObjectsTab'
import { Status } from '@/engine/types'

// ObjectsTable itself is covered by its own test file; here it is stubbed
// out to a component that just reports the `filter` it was given, so these
// tests can assert on what ObjectsTab actually sends down -- in particular,
// how and when `filter.text` changes -- without needing to drive the real
// engine query machinery.
const mockObjectsTable = jest.fn()
// One call per *mount* of the stub (not per render): what the reload test
// below counts, since a remount is how ObjectsTab drops the table's rows.
const mockObjectsTableMount = jest.fn()
jest.mock('@/components/ObjectsTable/ObjectsTable', () => {
    // babel-plugin-jest-hoist forbids a factory from closing over anything
    // not prefixed `mock`, the imported `React` included.
    // oxlint-disable-next-line typescript/consistent-type-imports -- the jest.mock factory may not close over imports, so the module type is named inline
    const { useEffect } = jest.requireActual<typeof import('react')>('react')
    return {
        ObjectsTable: (props: unknown) => {
            mockObjectsTable(props)
            useEffect(() => {
                mockObjectsTableMount()
            }, [])
            return null
        },
    }
})

// Only `status.loadedAt` is read; mutable so a test can move the stamp the
// way a completed reload of this type does.
const mockLoadedAt: { organisationUnit?: number } = {}
jest.mock('@/hooks/useEngine', () => ({
    useEngine: () => ({ status: { loadedAt: mockLoadedAt } }),
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

const lastFilterSent = () =>
    mockObjectsTable.mock.calls[mockObjectsTable.mock.calls.length - 1][0]
        .filter

beforeEach(() => {
    mockObjectsTable.mockReset()
    mockObjectsTableMount.mockReset()
    delete mockLoadedAt.organisationUnit
    jest.useFakeTimers()
})

afterEach(() => {
    jest.useRealTimers()
})

test('shows the pending value in the input immediately, before the debounce fires', () => {
    render(
        <ObjectsTab
            set={set}
            scope={scope}
            filter={{}}
            onFilter={jest.fn()}
            levels={[]}
            onBulkFix={jest.fn()}
        />
    )
    fireEvent.change(screen.getByRole('textbox'), {
        target: { value: 'clinic' },
    })
    expect(screen.getByRole('textbox')).toHaveValue('clinic')
    // Nothing has reached the filter yet -- the table is still on the
    // filter it was first rendered with.
    expect(lastFilterSent()).toEqual({})
})

test('debounces rapid typing into a single filter update, 300ms after the last keystroke', () => {
    const onFilter = jest.fn()
    render(
        <ObjectsTab
            set={set}
            scope={scope}
            filter={{}}
            onFilter={onFilter}
            levels={[]}
            onBulkFix={jest.fn()}
        />
    )
    const input = screen.getByRole('textbox')

    fireEvent.change(input, { target: { value: 'c' } })
    act(() => {
        jest.advanceTimersByTime(100)
    })
    fireEvent.change(input, { target: { value: 'cl' } })
    act(() => {
        jest.advanceTimersByTime(100)
    })
    fireEvent.change(input, { target: { value: 'cli' } })

    // Still well under 300ms since the last keystroke: nothing has fired.
    act(() => {
        jest.advanceTimersByTime(200)
    })
    expect(onFilter).not.toHaveBeenCalled()

    // 300ms after the *last* keystroke, exactly one update reaches the
    // filter, carrying only the final value -- not one call per keystroke.
    act(() => {
        jest.advanceTimersByTime(100)
    })
    expect(onFilter).toHaveBeenCalledTimes(1)
    expect(onFilter).toHaveBeenCalledWith({ text: 'cli' })
})

test('clearing the query restores the unfiltered filter', () => {
    const onFilter = jest.fn()
    render(
        <ObjectsTab
            set={set}
            scope={scope}
            filter={{ text: 'clinic' }}
            onFilter={onFilter}
            levels={[]}
            onBulkFix={jest.fn()}
        />
    )
    fireEvent.change(screen.getByRole('textbox'), {
        target: { value: '' },
    })
    act(() => {
        jest.advanceTimersByTime(300)
    })
    expect(onFilter).toHaveBeenCalledWith({ text: undefined })
})

test('does not call onFilter on mount, or after any render where the search input still matches the current filter', () => {
    // m1: the debounce effect used to fire unconditionally 300ms after
    // every render, including the very first -- a filter update the user
    // never asked for, on every visit to the Objects tab. Harmless only by
    // coincidence (`JSON.stringify` drops the `undefined` it produced), so
    // it must not happen at all.
    const onFilter = jest.fn()
    render(
        <ObjectsTab
            set={set}
            scope={scope}
            filter={{ text: 'clinic' }}
            onFilter={onFilter}
            levels={[]}
            onBulkFix={jest.fn()}
        />
    )
    act(() => {
        jest.advanceTimersByTime(300)
    })
    expect(onFilter).not.toHaveBeenCalled()
})

test('applies the debounced search on top of whichever filter is current when it fires, not a stale one', () => {
    const onFilter = jest.fn()
    const { rerender } = render(
        <ObjectsTab
            set={set}
            scope={scope}
            filter={{}}
            onFilter={onFilter}
            levels={[]}
            onBulkFix={jest.fn()}
        />
    )
    fireEvent.change(screen.getByRole('textbox'), {
        target: { value: 'clinic' },
    })
    // Another control changes the filter (e.g. a status pick) while the
    // debounce is still outstanding.
    rerender(
        <ObjectsTab
            set={set}
            scope={scope}
            filter={{ statuses: [Status.Conflict] }}
            onFilter={onFilter}
            levels={[]}
            onBulkFix={jest.fn()}
        />
    )
    act(() => {
        jest.advanceTimersByTime(300)
    })
    expect(onFilter).toHaveBeenCalledWith({
        statuses: [Status.Conflict],
        text: 'clinic',
    })
})

// Manual review 2: after a bulk fix (or the filter bar's Refresh) the
// engine holds new memberships and the table kept showing the old ones --
// see the comment on `loadedAt` in ObjectsTab.tsx for why the table cannot
// notice on its own. A reload that actually refilled this type moves its
// load stamp; the table is remounted on it, and on nothing else.
describe('reload of this type', () => {
    const renderTab = () =>
        render(
            <ObjectsTab
                set={set}
                scope={scope}
                filter={{}}
                onFilter={jest.fn()}
                levels={[]}
                onBulkFix={jest.fn()}
            />
        )

    it('remounts the table when the load stamp for this type moves', () => {
        mockLoadedAt.organisationUnit = 1_000
        const { rerender } = renderTab()
        expect(mockObjectsTableMount).toHaveBeenCalledTimes(1)

        mockLoadedAt.organisationUnit = 2_000
        rerender(
            <ObjectsTab
                set={set}
                scope={scope}
                filter={{}}
                onFilter={jest.fn()}
                levels={[]}
                onBulkFix={jest.fn()}
            />
        )
        expect(mockObjectsTableMount).toHaveBeenCalledTimes(2)
    })

    it('keeps the table mounted across a render where the stamp did not move', () => {
        mockLoadedAt.organisationUnit = 1_000
        const { rerender } = renderTab()
        rerender(
            <ObjectsTab
                set={set}
                scope={scope}
                filter={{ level: 4 }}
                onFilter={jest.fn()}
                levels={[]}
                onBulkFix={jest.fn()}
            />
        )
        expect(mockObjectsTableMount).toHaveBeenCalledTimes(1)
        expect(lastFilterSent()).toEqual({ level: 4 })
    })
})
