import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { GroupSetCard } from './GroupSetCard'

// Mutable, test-controlled override -- see Dashboard.test.tsx's comment on
// why this must be prefixed "mock" (babel-plugin-jest-hoist).
const mockIntegrity: {
    available: boolean
    checks: unknown[]
    summaries: Record<string, unknown>
    stale: Set<string>
} = {
    available: false,
    checks: [],
    summaries: {},
    stale: new Set(),
}
jest.mock('@/hooks/useIntegrity', () => ({
    useIntegrity: () => mockIntegrity,
}))

afterEach(() => {
    mockIntegrity.available = false
    mockIntegrity.checks = []
    mockIntegrity.summaries = {}
    mockIntegrity.stale = new Set()
})

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

it('renders nothing from the integrity overlay when the user does not have it available', () => {
    mockIntegrity.available = false
    mockIntegrity.checks = [
        {
            logical: 'orgUnitsMissingCompulsory',
            name: 'org_units_not_in_compulsory_group_sets',
            displayName: 'x',
            objectType: 'organisationUnit',
            isSlow: false,
        },
    ]
    mockIntegrity.summaries = {
        org_units_not_in_compulsory_group_sets: {
            name: 'org_units_not_in_compulsory_group_sets',
            count: 42,
            finishedTime: '2026-09-01T10:00:00.000Z',
        },
    }
    render(<GroupSetCard entry={entry} onOpen={() => undefined} />)
    // Distinguishes "the overlay rendered nothing" from "the card rendered
    // nothing": the card's own stats are still there, but the count that
    // only the integrity overlay would ever show (42) must not appear
    // anywhere -- a mutation that always suppresses the overlay would still
    // pass a test that only checked for an absent generic wrapper element.
    expect(screen.getByText('Ownership')).toBeInTheDocument()
    expect(screen.queryByText(/42/)).not.toBeInTheDocument()
    expect(screen.queryByText(/has not been run/i)).not.toBeInTheDocument()
})

it('shows the integrity result for an admin with a resolved check for this type', () => {
    mockIntegrity.available = true
    mockIntegrity.checks = [
        {
            logical: 'orgUnitsMissingCompulsory',
            name: 'org_units_not_in_compulsory_group_sets',
            displayName: 'x',
            objectType: 'organisationUnit',
            isSlow: false,
        },
    ]
    mockIntegrity.summaries = {
        org_units_not_in_compulsory_group_sets: {
            name: 'org_units_not_in_compulsory_group_sets',
            count: 42,
            finishedTime: '2026-09-01T10:00:00.000Z',
        },
    }
    render(<GroupSetCard entry={entry} onOpen={() => undefined} />)
    expect(screen.getByText(/42/)).toBeInTheDocument()
})

it('renders nothing from the overlay when available but the only resolved check is for a different object type', () => {
    mockIntegrity.available = true
    mockIntegrity.checks = [
        {
            logical: 'indicatorsConflicting',
            name: 'indicators_violating_exclusive_group_sets',
            displayName: 'x',
            objectType: 'indicator',
            isSlow: false,
        },
    ]
    // A real, distinctive summary -- not `{}` -- so this test cannot pass
    // merely because the summary lookup came back empty. If the objectType
    // filter were dropped (e.g. `checks[0]` instead of a real match), this
    // count would leak onto an organisationUnit card and this assertion
    // would catch it.
    mockIntegrity.summaries = {
        indicators_violating_exclusive_group_sets: {
            name: 'indicators_violating_exclusive_group_sets',
            count: 99,
            finishedTime: '2026-09-01T10:00:00.000Z',
        },
    }
    render(<GroupSetCard entry={entry} onOpen={() => undefined} />)
    expect(screen.getByText('Ownership')).toBeInTheDocument()
    expect(screen.queryByText(/99/)).not.toBeInTheDocument()
    expect(screen.queryByText(/has not been run/i)).not.toBeInTheDocument()
})

it('picks the compulsory check for a compulsory set, not the conflicting check for the same object type', () => {
    // P3-R5 (review round 1, M1/M2): selection must read the set's own
    // `compulsory` flag, not just take the first (or any) check whose
    // objectType matches -- both checks below match organisationUnit, and a
    // selection rule that ignored `compulsory` (e.g. `checks[0]`) would show
    // whichever came first regardless of which the set actually is.
    mockIntegrity.available = true
    mockIntegrity.checks = [
        {
            logical: 'orgUnitsConflicting',
            name: 'organisation_units_violating_exclusive_group_sets',
            displayName: 'conflict check',
            objectType: 'organisationUnit',
            isSlow: false,
        },
        {
            logical: 'orgUnitsMissingCompulsory',
            name: 'org_units_not_in_compulsory_group_sets',
            displayName: 'compulsory check',
            objectType: 'organisationUnit',
            isSlow: false,
        },
    ]
    mockIntegrity.summaries = {
        organisation_units_violating_exclusive_group_sets: {
            name: 'organisation_units_violating_exclusive_group_sets',
            count: 17,
            finishedTime: '2026-09-01T10:00:00.000Z',
        },
        org_units_not_in_compulsory_group_sets: {
            name: 'org_units_not_in_compulsory_group_sets',
            count: 272,
            finishedTime: '2026-09-01T10:00:00.000Z',
        },
    }
    // `entry.set.compulsory` is true.
    render(<GroupSetCard entry={entry} onOpen={() => undefined} />)
    expect(screen.getByText(/272/)).toBeInTheDocument()
    expect(screen.queryByText(/17\b/)).not.toBeInTheDocument()
})

it('picks the conflicting check for a non-compulsory set, not the compulsory check', () => {
    mockIntegrity.available = true
    mockIntegrity.checks = [
        {
            logical: 'orgUnitsConflicting',
            name: 'organisation_units_violating_exclusive_group_sets',
            displayName: 'conflict check',
            objectType: 'organisationUnit',
            isSlow: false,
        },
        {
            logical: 'orgUnitsMissingCompulsory',
            name: 'org_units_not_in_compulsory_group_sets',
            displayName: 'compulsory check',
            objectType: 'organisationUnit',
            isSlow: false,
        },
    ]
    mockIntegrity.summaries = {
        organisation_units_violating_exclusive_group_sets: {
            name: 'organisation_units_violating_exclusive_group_sets',
            count: 17,
            finishedTime: '2026-09-01T10:00:00.000Z',
        },
        org_units_not_in_compulsory_group_sets: {
            name: 'org_units_not_in_compulsory_group_sets',
            count: 272,
            finishedTime: '2026-09-01T10:00:00.000Z',
        },
    }
    const nonCompulsory = { ...entry, set: { ...entry.set, compulsory: false } }
    render(<GroupSetCard entry={nonCompulsory} onOpen={() => undefined} />)
    expect(screen.getByText(/17/)).toBeInTheDocument()
    expect(screen.queryByText(/272/)).not.toBeInTheDocument()
})

it('renders nothing when the set is compulsory but no compulsory check resolved on this server', () => {
    // Only the conflicting check resolved -- a compulsory set must not fall
    // back to showing a check for a rule it does not enforce.
    mockIntegrity.available = true
    mockIntegrity.checks = [
        {
            logical: 'orgUnitsConflicting',
            name: 'organisation_units_violating_exclusive_group_sets',
            displayName: 'conflict check',
            objectType: 'organisationUnit',
            isSlow: false,
        },
    ]
    mockIntegrity.summaries = {
        organisation_units_violating_exclusive_group_sets: {
            name: 'organisation_units_violating_exclusive_group_sets',
            count: 17,
            finishedTime: '2026-09-01T10:00:00.000Z',
        },
    }
    render(<GroupSetCard entry={entry} onOpen={() => undefined} />)
    expect(screen.getByText('Ownership')).toBeInTheDocument()
    expect(screen.queryByText(/17/)).not.toBeInTheDocument()
})
