import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { SummaryMatrix } from './SummaryMatrix'

// This project's Jest config maps every `.css` import (module or not) to
// jest.identity.mock.js, which exports a plain `{}`. Unlike the project's
// real (Vite) build -- which hashes `.numericHeader` to something like
// `_numericHeader_1l7ml_39`, still containing the substring -- Jest gives
// every class name `undefined`, so `styles.numericHeader` would never reach
// the DOM here at all and no test could observe it. Supply the one class
// this file's tests need to see, matching its own name the way the real
// build's hashed name still would.
jest.mock('./SummaryMatrix.module.css', () => ({
    __esModule: true,
    default: { numericHeader: 'numericHeader' },
}))

const result = {
    groups: [
        { id: 'pub', displayName: 'Public', canWrite: true },
        { id: 'priv', displayName: 'Private', canWrite: true },
    ],
    rows: [
        {
            object: 1,
            row: {
                index: 1,
                id: 'A',
                displayName: 'Abaji',
                level: 3,
                parentId: 'r',
            },
            perGroup: [210, 388],
            missing: 61,
            unassigned: 0,
            conflict: 12,
            total: 671,
        },
        {
            object: -1,
            row: null,
            perGroup: [0, 0],
            missing: 7,
            unassigned: 0,
            conflict: 0,
            total: 7,
        },
    ],
}

it('renders group columns, rows, totals and fires onCell', async () => {
    const onCell = jest.fn()
    render(<SummaryMatrix result={result} onCell={onCell} />)
    expect(screen.getByText('Public')).toBeInTheDocument()
    expect(screen.getByText('Abaji')).toBeInTheDocument()
    expect(screen.getByText(/Above the row level/)).toBeInTheDocument()
    // Total row: 210, 388, 68, 12, 678
    expect(screen.getByText('678')).toBeInTheDocument()
    await userEvent.click(screen.getByText('61'))
    expect(onCell).toHaveBeenCalledWith(result.rows[0].row, { kind: 'missing' })
})

it('labels the sole row of a flat (non-hierarchical) object type as the whole population, not as an above-the-row-level leftover', () => {
    const flatResult = {
        groups: [{ id: 'g', displayName: 'Group', canWrite: true }],
        rows: [
            {
                object: -1,
                row: null,
                perGroup: [10],
                missing: 2,
                unassigned: 0,
                conflict: 1,
                total: 13,
            },
        ],
    }
    render(<SummaryMatrix result={flatResult} onCell={jest.fn()} flat />)
    expect(screen.getByText('All objects')).toBeInTheDocument()
    expect(screen.queryByText(/Above the row level/)).not.toBeInTheDocument()
    expect(
        screen.queryByText(/compulsory group set is checked/)
    ).not.toBeInTheDocument()
    // With exactly one data row, a separate totals row underneath is a
    // pure duplicate -- '13' (the row's total) must appear only once.
    expect(screen.getAllByText('13')).toHaveLength(1)
})

it('suppresses the totals row generally whenever there is exactly one data row, not only for flat types', () => {
    const oneRowResult = {
        groups: [{ id: 'g', displayName: 'Group', canWrite: true }],
        rows: [
            {
                object: 1,
                row: {
                    index: 1,
                    id: 'A',
                    displayName: 'Solo',
                    level: 2,
                    parentId: null,
                },
                perGroup: [3],
                missing: 1,
                unassigned: 0,
                conflict: 0,
                total: 4,
            },
        ],
    }
    render(<SummaryMatrix result={oneRowResult} onCell={jest.fn()} />)
    // '4' (the row's total) would appear a second time in a totals row.
    expect(screen.getAllByText('4')).toHaveLength(1)
})

it('does not let the aggregate "above the row level" row be filtered by clicking its cells', () => {
    const onCell = jest.fn()
    render(<SummaryMatrix result={result} onCell={onCell} />)
    const aboveRow = screen
        .getByText('Above the row level')
        .closest('tr') as HTMLTableRowElement
    const valueCells = Array.from(aboveRow.querySelectorAll('td')).slice(1)
    expect(valueCells.length).toBeGreaterThan(0)
    valueCells.forEach((td) => fireEvent.click(td))
    expect(onCell).not.toHaveBeenCalled()
})

it('shows the "no group, not required" column only when the caller asks for it, and filters by it', async () => {
    const permissive = {
        groups: [{ id: 'g', displayName: 'Group', canWrite: true }],
        rows: [
            {
                object: 1,
                row: {
                    index: 1,
                    id: 'A',
                    displayName: 'Abaji',
                    level: 3,
                    parentId: 'r',
                },
                perGroup: [4],
                missing: 0,
                unassigned: 9,
                conflict: 0,
                total: 13,
            },
        ],
    }
    const onCell = jest.fn()
    const { rerender } = render(
        <SummaryMatrix result={permissive} onCell={onCell} />
    )
    // Without the flag the column is not there at all -- for a compulsory or
    // data dimension set it could only ever be zero.
    expect(
        screen.queryByText('No group (not required)')
    ).not.toBeInTheDocument()

    rerender(
        <SummaryMatrix result={permissive} onCell={onCell} showUnassigned />
    )
    expect(screen.getByText('No group (not required)')).toBeInTheDocument()
    await userEvent.click(screen.getByText('9'))
    expect(onCell).toHaveBeenCalledWith(permissive.rows[0].row, {
        kind: 'unassigned',
    })
})

it('lets the caller say why the aggregate row exists instead of assuming a compulsory set', () => {
    const onCell = jest.fn()
    render(
        <SummaryMatrix
            result={result}
            onCell={onCell}
            aboveLevelCaption="Includes organisation units above the District level"
        />
    )
    expect(
        screen.getByText('Includes organisation units above the District level')
    ).toBeInTheDocument()
    expect(
        screen.queryByText(/compulsory group set is checked/)
    ).not.toBeInTheDocument()
})

// @dhis2/ui 10.17.0's DataTableColumnHeader `align` prop is a no-op: it
// emits a rule for a `.label` class the component never renders. Our own
// class on the header is what actually right-aligns it, so the test pins
// the class rather than a computed style jsdom would not resolve anyway.
it('marks every numeric column header as numeric', () => {
    render(<SummaryMatrix result={result} onCell={jest.fn()} />)
    const headers = screen.getAllByRole('columnheader')
    // first column is the row label; every other header is a number
    const [rowLabel, ...numeric] = headers
    expect(rowLabel).not.toHaveClass('numericHeader')
    numeric.forEach((h) => expect(h.className).toMatch(/numericHeader/))
})
