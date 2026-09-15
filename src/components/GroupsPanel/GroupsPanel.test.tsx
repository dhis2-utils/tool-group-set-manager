import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { GroupsPanel } from './GroupsPanel'
import { ColumnPlan, GroupTotal } from '@/components/SummaryMatrix/columnPlan'

const group = (index: number, total: number): GroupTotal => ({
    index,
    group: {
        id: `g${index}`,
        displayName: `Group ${index}`,
        canWrite: true,
    },
    total,
})

// Nine groups, descending totals -- one more than MAX_GROUP_COLUMNS (8), so
// the ninth is the one this file uses to pin the collapsed/expanded
// boundary.
const ranked = Array.from({ length: 9 }, (_, i) => group(i, 900 - i * 100))

const plan: ColumnPlan = {
    shown: ranked.slice(0, 8),
    other: ranked.slice(8),
    ranked,
}

it('shows the eight biggest groups with their counts, and not the ninth', () => {
    render(<GroupsPanel plan={plan} total={4500} />)
    expect(screen.getByText('Group 0')).toBeInTheDocument()
    expect(screen.getByText('Group 7')).toBeInTheDocument()
    expect(screen.queryByText('Group 8')).not.toBeInTheDocument()
})

it('renders the counts passed in rather than recomputing them', () => {
    render(<GroupsPanel plan={plan} total={4500} />)
    // group(0, 900) -- the count shown must be the one on the plan, not a
    // sum this component derives from `total` or from the other groups.
    expect(screen.getByText('900 objects')).toBeInTheDocument()
    expect(screen.queryByText('1 object')).not.toBeInTheDocument()
})

it('reveals the ninth group once Show all is activated', async () => {
    render(<GroupsPanel plan={plan} total={4500} />)
    expect(screen.queryByText('Group 8')).not.toBeInTheDocument()
    await userEvent.click(screen.getByText('Show all 9 groups'))
    expect(screen.getByText('Group 8')).toBeInTheDocument()
})

it('narrows the expanded list by name through the filter input', async () => {
    render(<GroupsPanel plan={plan} total={4500} />)
    await userEvent.click(screen.getByText('Show all 9 groups'))
    expect(screen.getByText('Group 8')).toBeInTheDocument()
    await userEvent.type(
        screen.getByPlaceholderText('Filter groups by name'),
        'Group 3'
    )
    expect(screen.getByText('Group 3')).toBeInTheDocument()
    expect(screen.queryByText('Group 8')).not.toBeInTheDocument()
    expect(screen.queryByText('Group 0')).not.toBeInTheDocument()
})

it('explains a filter that matches nothing, then restores the full list once cleared', async () => {
    render(<GroupsPanel plan={plan} total={4500} />)
    await userEvent.click(screen.getByText('Show all 9 groups'))
    const input = screen.getByPlaceholderText('Filter groups by name')
    await userEvent.type(input, 'zzz')
    expect(screen.getByText('No groups match "zzz"')).toBeInTheDocument()
    expect(screen.queryByText('Group 0')).not.toBeInTheDocument()
    await userEvent.clear(input)
    expect(
        screen.queryByText('No groups match "zzz"')
    ).not.toBeInTheDocument()
    expect(screen.getByText('Group 0')).toBeInTheDocument()
    expect(screen.getByText('Group 8')).toBeInTheDocument()
})

it('does not offer Show all or a filter for a set with eight or fewer groups', () => {
    const smallPlan: ColumnPlan = {
        shown: ranked.slice(0, 3),
        other: [],
        ranked: ranked.slice(0, 3),
    }
    render(<GroupsPanel plan={smallPlan} total={2400} />)
    expect(screen.queryByText(/Show all/)).not.toBeInTheDocument()
    expect(
        screen.queryByPlaceholderText('Filter groups by name')
    ).not.toBeInTheDocument()
})
