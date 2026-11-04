import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { GroupsPanel } from './GroupsPanel'
import type {
    ColumnPlan,
    GroupTotal,
} from '@/components/SummaryMatrix/columnPlan'

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

test('shows the eight biggest groups with their counts, and not the ninth', () => {
    render(<GroupsPanel plan={plan} total={4500} />)
    expect(screen.getByText('Group 0')).toBeInTheDocument()
    expect(screen.getByText('Group 7')).toBeInTheDocument()
    expect(screen.queryByText('Group 8')).not.toBeInTheDocument()
})

test('renders the counts passed in rather than recomputing them', () => {
    render(<GroupsPanel plan={plan} total={4500} />)
    // group(0, 900) -- the count shown must be the one on the plan, not a
    // sum this component derives from `total` or from the other groups.
    expect(
        screen.getByText('900 objects only in this group')
    ).toBeInTheDocument()
    expect(
        screen.queryByText('1 object only in this group')
    ).not.toBeInTheDocument()
})

test('reveals the ninth group once Show all is activated', async () => {
    render(<GroupsPanel plan={plan} total={4500} />)
    expect(screen.queryByText('Group 8')).not.toBeInTheDocument()
    await userEvent.click(screen.getByText('Show all 9 groups'))
    expect(screen.getByText('Group 8')).toBeInTheDocument()
})

test('narrows the expanded list by name through the filter input', async () => {
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

test('explains a filter that matches nothing, then restores the full list once cleared', async () => {
    render(<GroupsPanel plan={plan} total={4500} />)
    await userEvent.click(screen.getByText('Show all 9 groups'))
    const input = screen.getByPlaceholderText('Filter groups by name')
    await userEvent.type(input, 'zzz')
    expect(screen.getByText('No groups match "zzz"')).toBeInTheDocument()
    expect(screen.queryByText('Group 0')).not.toBeInTheDocument()
    await userEvent.clear(input)
    expect(screen.queryByText('No groups match "zzz"')).not.toBeInTheDocument()
    expect(screen.getByText('Group 0')).toBeInTheDocument()
    expect(screen.getByText('Group 8')).toBeInTheDocument()
})

test('does not offer Show all or a filter for a set with eight or fewer groups', () => {
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

test('forgets the filter term when collapsed, so re-expanding shows every group again', async () => {
    render(<GroupsPanel plan={plan} total={4500} />)
    await userEvent.click(screen.getByText('Show all 9 groups'))
    await userEvent.type(
        screen.getByPlaceholderText('Filter groups by name'),
        'Group 3'
    )
    expect(screen.queryByText('Group 8')).not.toBeInTheDocument()
    await userEvent.click(screen.getByText('Show fewer groups'))
    await userEvent.click(screen.getByText('Show all 9 groups'))
    expect(screen.getByPlaceholderText('Filter groups by name')).toHaveValue('')
    expect(screen.getByText('Group 8')).toBeInTheDocument()
})
