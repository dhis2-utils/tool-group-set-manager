import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { GroupSetCard } from './GroupSetCard'

const entry = {
    set: {
        id: 'own',
        displayName: 'Ownership',
        objectType: 'organisationUnit' as const,
        compulsory: true,
        dataDimension: true,
        canWrite: true,
        groups: [
            { id: 'a', displayName: 'A', canWrite: true },
            { id: 'b', displayName: 'B', canWrite: false },
        ],
    },
    summary: {
        population: 100,
        ok: 80,
        missingError: 12,
        missingWarning: 0,
        conflict: 8,
    },
    hasData: true,
}

it('shows name, properties, counts and a lock when some groups are read-only', async () => {
    const onOpen = jest.fn()
    render(<GroupSetCard entry={entry} onOpen={onOpen} />)
    expect(screen.getByText('Ownership')).toBeInTheDocument()
    expect(screen.getByText('Compulsory')).toBeInTheDocument()
    expect(screen.getByText('Data dimension')).toBeInTheDocument()
    expect(screen.getByText('8')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText(/1 group read-only/)).toBeInTheDocument()
    await userEvent.click(screen.getByText('Ownership'))
    expect(onOpen).toHaveBeenCalled()
})

it('shows a loading state when the type has no data yet', () => {
    render(
        <GroupSetCard
            entry={{ ...entry, hasData: false }}
            onOpen={() => undefined}
        />
    )
    expect(screen.getByText(/Loading/)).toBeInTheDocument()
})
