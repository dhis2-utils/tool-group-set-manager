import { fireEvent, render, screen } from '@testing-library/react'
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
        unassigned: 0,
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

it('pluralises the read-only-groups count for more than one group', () => {
    const entryWithManyReadOnly = {
        ...entry,
        set: {
            ...entry.set,
            groups: [
                { id: 'a', displayName: 'A', canWrite: false },
                { id: 'b', displayName: 'B', canWrite: false },
                { id: 'c', displayName: 'C', canWrite: false },
            ],
        },
    }
    render(
        <GroupSetCard entry={entryWithManyReadOnly} onOpen={() => undefined} />
    )
    expect(screen.getByText('3 groups read-only for you')).toBeInTheDocument()
})

it('uses the singular group count for exactly one group', () => {
    const entryWithOneGroup = {
        ...entry,
        set: {
            ...entry.set,
            groups: [{ id: 'a', displayName: 'A', canWrite: true }],
        },
    }
    render(<GroupSetCard entry={entryWithOneGroup} onOpen={() => undefined} />)
    expect(screen.getByText('1 group')).toBeInTheDocument()
})

it('pluralises the group count tag for more than one group', () => {
    render(<GroupSetCard entry={entry} onOpen={() => undefined} />)
    expect(screen.getByText('2 groups')).toBeInTheDocument()
})

it('shows a configuration-gap message instead of all-clean stats when a set has no groups', () => {
    const entryWithNoGroups = {
        ...entry,
        set: { ...entry.set, groups: [] },
    }
    render(<GroupSetCard entry={entryWithNoGroups} onOpen={() => undefined} />)
    expect(
        screen.getByText('This group set has no groups configured')
    ).toBeInTheDocument()
    expect(screen.queryByText('Conflicts')).not.toBeInTheDocument()
    expect(screen.queryByText('OK')).not.toBeInTheDocument()
})

it('can be activated with the Space key', () => {
    const onOpen = jest.fn()
    render(<GroupSetCard entry={entry} onOpen={onOpen} />)
    fireEvent.keyDown(screen.getByRole('button'), { key: ' ' })
    expect(onOpen).toHaveBeenCalled()
})

it('shows the "no group, not required" count only for a set where being in no group is allowed', () => {
    // The card, the matrix column and the drill-down all key on the same
    // condition. A compulsory or data dimension set can never have one of
    // these, so the stat would be a permanent zero there.
    const permissive = {
        ...entry,
        set: { ...entry.set, compulsory: false, dataDimension: false },
        summary: {
            population: 100,
            ok: 30,
            unassigned: 70,
            missingError: 0,
            missingWarning: 0,
            conflict: 0,
        },
    }
    const { rerender } = render(
        <GroupSetCard entry={permissive} onOpen={() => undefined} />
    )
    expect(screen.getByText('No group (not required)')).toBeInTheDocument()
    expect(screen.getByText('70')).toBeInTheDocument()

    rerender(<GroupSetCard entry={entry} onOpen={() => undefined} />)
    expect(
        screen.queryByText('No group (not required)')
    ).not.toBeInTheDocument()
})
