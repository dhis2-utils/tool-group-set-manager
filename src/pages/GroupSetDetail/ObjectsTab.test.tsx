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
jest.mock('@/components/ObjectsTable/ObjectsTable', () => ({
    ObjectsTable: (props: unknown) => {
        mockObjectsTable(props)
        return null
    },
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
    jest.useFakeTimers()
})

afterEach(() => {
    jest.useRealTimers()
})

it('shows the pending value in the input immediately, before the debounce fires', () => {
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

it('debounces rapid typing into a single filter update, 300ms after the last keystroke', () => {
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

it('clearing the query restores the unfiltered filter', () => {
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

it('does not call onFilter on mount, or after any render where the search input still matches the current filter', () => {
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

it('applies the debounced search on top of whichever filter is current when it fires, not a stale one', () => {
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
