import { act, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { MembershipControl } from './MembershipControl'

const groups = (n: number, unwritable: number[] = []) =>
    Array.from({ length: n }, (_, i) => ({
        id: `g${i}`,
        displayName: `Group ${i}`,
        canWrite: !unwritable.includes(i),
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

it('names the conflicting groups next to a disabled dropdown for more than five groups', () => {
    render(
        <MembershipControl
            groups={groups(6)}
            current={[1, 4]}
            disabled
            onChange={() => undefined}
        />
    )
    // The dropdown itself is disabled and so cannot be opened to reveal
    // which groups collide -- the names must be readable outside it.
    expect(screen.getByText(/Group 1/)).toBeInTheDocument()
    expect(screen.getByText(/Group 4/)).toBeInTheDocument()
})

it('calls onChange with the clicked group position when enabled', () => {
    const onChange = jest.fn()
    render(
        <MembershipControl
            groups={groups(3)}
            current={[0, 2]}
            disabled={false}
            onChange={onChange}
        />
    )
    fireEvent.click(screen.getAllByRole('button')[1])
    expect(onChange).toHaveBeenCalledWith(1)
})

it('names the reason a disabled segmented control cannot be used', () => {
    render(
        <MembershipControl
            groups={groups(3)}
            current={[0, 2]}
            disabled
            disabledReason="Group 0 is read-only for you"
            onChange={() => undefined}
        />
    )
    expect(screen.getAllByRole('button')[0]).toHaveAttribute(
        'title',
        'Group 0 is read-only for you'
    )
})

it('names the reason a disabled dropdown control cannot be used', () => {
    render(
        <MembershipControl
            groups={groups(6)}
            current={[1, 4]}
            disabled
            disabledReason="Group 1 is read-only for you"
            onChange={() => undefined}
        />
    )
    expect(
        screen.getByTitle('Group 1 is read-only for you')
    ).toBeInTheDocument()
})

it('disables only the read-only option in the segmented control, leaving the rest clickable (I1)', () => {
    const onChange = jest.fn()
    render(
        <MembershipControl
            groups={groups(3, [1])}
            current={[0]}
            disabled={false}
            onChange={onChange}
        />
    )
    const buttons = screen.getAllByRole('button')
    expect(buttons[0]).not.toBeDisabled()
    expect(buttons[1]).toBeDisabled()
    expect(buttons[1]).toHaveAttribute('title', 'Group 1 is read-only for you')
    expect(buttons[2]).not.toBeDisabled()

    fireEvent.click(buttons[2])
    expect(onChange).toHaveBeenCalledWith(2)
})

it('disables the corresponding option in the dropdown for a read-only target group (I1)', () => {
    render(
        <MembershipControl
            groups={groups(6, [2])}
            current={[0]}
            disabled={false}
            onChange={() => undefined}
        />
    )
    act(() => {
        fireEvent.click(screen.getByTestId('dhis2-uicore-select-input'))
    })
    const option = screen
        .getAllByTestId('dhis2-uicore-singleselectoption')
        .find((el) => el.textContent === 'Group 2 (read-only for you)')
    expect(option).toBeDefined()
    expect(option?.className).toMatch(/disabled/)
})
