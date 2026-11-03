import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { ActionStep } from './ActionStep'

// Rebuilt fresh for every test (not a module-level fixture shared across
// them): the `jest.fn()`s inside must not carry call counts from one test
// into the next, or a `toHaveBeenCalledTimes` assertion only passes by
// luck of how many tests before it happened to click.
let catchAll: {
    names: { displayName: string; shortName: string }
    setNames: jest.Mock
    nameTooLong: boolean
    namesValid: boolean
    creating: boolean
    error: string | null
    createdGroup: { id: string; displayName: string } | null
    create: jest.Mock
}
let base: {
    action: 'moveToCatchAll'
    onAction: jest.Mock
    configLoaded: boolean
    targetGroupId: string
    onTargetChange: jest.Mock
    targetGroups: { id: string; displayName: string }[]
    showCreateOffer: boolean
    catchAll: typeof catchAll
}

beforeEach(() => {
    catchAll = {
        names: {
            displayName: 'Other/unknown Ownership',
            shortName: 'Other Ownership',
        },
        setNames: jest.fn(),
        nameTooLong: false,
        namesValid: true,
        creating: false,
        error: null,
        createdGroup: null,
        create: jest.fn(),
    }
    base = {
        action: 'moveToCatchAll',
        onAction: jest.fn(),
        configLoaded: true,
        targetGroupId: '',
        onTargetChange: jest.fn(),
        targetGroups: [{ id: 'g1', displayName: 'Group one' }],
        showCreateOffer: false,
        catchAll,
    }
})

test('labels the target as the catch-all group or the target group by action', () => {
    const { rerender } = render(<ActionStep {...base} />)
    expect(screen.getByText('Catch-all group')).toBeInTheDocument()
    rerender(<ActionStep {...base} action="assignAll" />)
    expect(screen.getByText('Target group')).toBeInTheDocument()
})

test('offers to create a group only when asked to', () => {
    const { rerender } = render(<ActionStep {...base} />)
    expect(
        screen.queryByRole('button', { name: 'Create group' })
    ).not.toBeInTheDocument()
    rerender(<ActionStep {...base} showCreateOffer />)
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
    expect(catchAll.create).toHaveBeenCalledTimes(1)
})

test('shows the create error as its own notice', () => {
    render(
        <ActionStep
            {...base}
            showCreateOffer
            catchAll={{ ...catchAll, error: 'HTTP 409' }}
        />
    )
    expect(screen.getByText('Could not create the group')).toBeInTheDocument()
})
