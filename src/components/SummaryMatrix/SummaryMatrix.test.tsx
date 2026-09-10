import { render, screen } from '@testing-library/react'
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
})
