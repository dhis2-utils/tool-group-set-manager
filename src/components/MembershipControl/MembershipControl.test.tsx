import { render, screen } from '@testing-library/react'
import React from 'react'
import { MembershipControl } from './MembershipControl'

const groups = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
        id: `g${i}`,
        displayName: `Group ${i}`,
        canWrite: true,
    }))

it('renders a segmented control for up to five groups and marks conflicts', () => {
    render(
        <MembershipControl
            groups={groups(3)}
            current={[0, 2]}
            disabled
            onChange={() => undefined}
        />
    )
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(3)
    expect(buttons[0]).toHaveAttribute('data-state', 'conflict')
    expect(buttons[1]).toHaveAttribute('data-state', 'none')
    expect(buttons[2]).toHaveAttribute('data-state', 'conflict')
})

it('marks the single current group as selected', () => {
    render(
        <MembershipControl
            groups={groups(2)}
            current={[1]}
            disabled
            onChange={() => undefined}
        />
    )
    expect(screen.getAllByRole('button')[1]).toHaveAttribute(
        'data-state',
        'selected'
    )
})

it('renders a dropdown for more than five groups', () => {
    render(
        <MembershipControl
            groups={groups(6)}
            current={[]}
            disabled
            onChange={() => undefined}
        />
    )
    expect(
        screen.queryAllByRole('button').filter((b) => b.dataset.state)
    ).toHaveLength(0)
    expect(screen.getByText(/choose group/i)).toBeInTheDocument()
})
