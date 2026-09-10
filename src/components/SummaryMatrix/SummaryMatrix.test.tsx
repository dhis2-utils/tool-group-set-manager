import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { SummaryMatrix } from './SummaryMatrix'

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
            conflict: 12,
            total: 671,
        },
        {
            object: -1,
            row: null,
            perGroup: [0, 0],
            missing: 7,
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
