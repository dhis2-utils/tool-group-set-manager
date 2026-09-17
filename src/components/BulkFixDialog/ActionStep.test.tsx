import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { ActionStep } from './ActionStep'

const catchAll = {
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
const base = {
    action: 'moveToCatchAll' as const,
    onAction: jest.fn(),
    configLoaded: true,
    targetGroupId: '',
    onTargetChange: jest.fn(),
    targetGroups: [{ id: 'g1', displayName: 'Group one' }],
    showCreateOffer: false,
    catchAll,
}

it('labels the target as the catch-all group or the target group by action', () => {
    const { rerender } = render(<ActionStep {...base} />)
    expect(screen.getByText('Catch-all group')).toBeInTheDocument()
    rerender(<ActionStep {...base} action="assignAll" />)
    expect(screen.getByText('Target group')).toBeInTheDocument()
})

it('offers to create a group only when asked to', () => {
    const { rerender } = render(<ActionStep {...base} />)
    expect(
        screen.queryByRole('button', { name: 'Create group' })
    ).not.toBeInTheDocument()
    rerender(<ActionStep {...base} showCreateOffer />)
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
    expect(catchAll.create).toHaveBeenCalledTimes(1)
})

it('shows the create error as its own notice', () => {
    render(
        <ActionStep
            {...base}
            showCreateOffer
            catchAll={{ ...catchAll, error: 'HTTP 409' }}
        />
    )
    expect(screen.getByText('Could not create the group')).toBeInTheDocument()
})
