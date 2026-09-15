import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { GroupSetCard } from './GroupSetCard'
import { ObjectType } from '@/engine/types'

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

const mockUsage = jest.fn()
jest.mock('@/hooks/useUsage', () => ({ useUsage: () => mockUsage() }))

const readyUsage = (usage: unknown) => ({
    status: 'ready',
    error: null,
    forSet: () => usage,
    refresh: jest.fn(),
})

afterEach(() => {
    mockIntegrity.available = false
    mockIntegrity.checks = []
    mockIntegrity.summaries = {}
    mockIntegrity.stale = new Set()
})

beforeEach(() => {
    // Baseline: no usage view on this instance, so none of the tests below
    // that do not care about usage see any usage-related text -- only the
    // "GroupSetCard — usage" describe block overrides this per test.
    mockUsage.mockReturnValue({
        status: 'absent',
        error: null,
        forSet: () => null,
        refresh: jest.fn(),
    })
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

/**
 * `entry` above is this file's one fixture; most tests only need to swap in
 * a different `entry` altogether (a different summary, group list, or
 * `hasData`) or tweak one field of its `set`. `onOpen` and `onOpenUsage`
 * default to fresh jest.fn()s so a test that doesn't care about either can
 * omit them entirely.
 */
const renderCard = (
    overrides: {
        entry?: typeof entry
        set?: Partial<Omit<(typeof entry)['set'], 'objectType'>> & {
            objectType?: ObjectType
        }
        onOpen?: () => void
        onOpenUsage?: () => void
    } = {}
) =>
    render(
        <GroupSetCard
            entry={
                overrides.entry ?? {
                    ...entry,
                    set: { ...entry.set, ...(overrides.set ?? {}) },
                }
            }
            onOpen={overrides.onOpen ?? jest.fn()}
            onOpenUsage={overrides.onOpenUsage ?? jest.fn()}
        />
    )

it('shows name, properties, counts and a lock when some groups are read-only', async () => {
    const onOpen = jest.fn()
    renderCard({ onOpen })
    expect(screen.getByText('Ownership')).toBeInTheDocument()
    expect(screen.getByText('Compulsory')).toBeInTheDocument()
    expect(screen.getByText('Data dimension')).toBeInTheDocument()
    expect(screen.getByText('8')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText(/1 group read-only/)).toBeInTheDocument()
    await userEvent.click(screen.getByText('Ownership'))
    expect(onOpen).toHaveBeenCalled()
})

// Every other count on the dashboard (SummaryMatrix's `fmt`, ObjectsTable,
// BulkFixDialog, History, ChangeSetPreview) goes through `.toLocaleString()`
// so a large population reads with a thousands separator; this card's
// stat tiles rendered the raw number instead, so the same instance showed
// "12000" here and "12,000" everywhere else.
it('formats large stat counts with the same thousands separator as the rest of the dashboard', () => {
    const bigEntry = {
        ...entry,
        summary: {
            population: 21000,
            ok: 8000,
            unassigned: 0,
            missingError: 12000,
            missingWarning: 0,
            conflict: 1000,
        },
    }
    renderCard({ entry: bigEntry })
    expect(screen.getByText((1000).toLocaleString())).toBeInTheDocument()
    expect(screen.getByText((12000).toLocaleString())).toBeInTheDocument()
    expect(screen.getByText((8000).toLocaleString())).toBeInTheDocument()
    expect(screen.queryByText('12000')).not.toBeInTheDocument()
})

it('shows a loading state when the type has no data yet', () => {
    renderCard({ entry: { ...entry, hasData: false } })
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
    renderCard({ entry: entryWithManyReadOnly })
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
    renderCard({ entry: entryWithOneGroup })
    expect(screen.getByText('1 group')).toBeInTheDocument()
})

it('pluralises the group count tag for more than one group', () => {
    renderCard()
    expect(screen.getByText('2 groups')).toBeInTheDocument()
})

// Minor 8 (fix round 1): item 4 was about count formatting being
// consistent everywhere, not just the stat tiles -- these two labels are
// small in practice, but the fix should not leave stragglers.
it('formats the group count and read-only count with the same thousands separator as the stat tiles', () => {
    const manyGroups = Array.from({ length: 1200 }, (_, i) => ({
        id: `g${i}`,
        displayName: `G${i}`,
        canWrite: i === 0,
    }))
    const entryWithManyGroups = {
        ...entry,
        set: { ...entry.set, groups: manyGroups },
    }
    renderCard({ entry: entryWithManyGroups })
    expect(
        screen.getByText((1200).toLocaleString() + ' groups')
    ).toBeInTheDocument()
    expect(
        screen.getByText((1199).toLocaleString() + ' groups read-only for you')
    ).toBeInTheDocument()
})

it('shows a configuration-gap message instead of all-clean stats when a set has no groups', () => {
    const entryWithNoGroups = {
        ...entry,
        set: { ...entry.set, groups: [] },
    }
    renderCard({ entry: entryWithNoGroups })
    expect(
        screen.getByText('This group set has no groups configured')
    ).toBeInTheDocument()
    expect(screen.queryByText('Conflicts')).not.toBeInTheDocument()
    expect(screen.queryByText('OK')).not.toBeInTheDocument()
})

it('can be activated with the Space key', () => {
    const onOpen = jest.fn()
    renderCard({ onOpen })
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
    const { rerender } = renderCard({ entry: permissive })
    expect(screen.getByText('No group (not required)')).toBeInTheDocument()
    expect(screen.getByText('70')).toBeInTheDocument()

    rerender(
        <GroupSetCard
            entry={entry}
            onOpen={() => undefined}
            onOpenUsage={() => undefined}
        />
    )
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
    renderCard()
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
    renderCard()
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
    renderCard()
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
    renderCard()
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
    renderCard({ entry: nonCompulsory })
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
    renderCard()
    expect(screen.getByText('Ownership')).toBeInTheDocument()
    expect(screen.queryByText(/17/)).not.toBeInTheDocument()
})

describe('GroupSetCard — usage', () => {
    it('shows the favourite count', () => {
        mockUsage.mockReturnValue(
            readyUsage({ favourites: 42, views12m: 100, byFavouriteType: [] })
        )
        renderCard()
        expect(screen.getByText('42 favourites')).toBeInTheDocument()
    })

    it('tags a set no favourite references, and the tag opens its Usage tab', () => {
        const onOpenUsage = jest.fn()
        mockUsage.mockReturnValue(
            readyUsage({ favourites: 0, views12m: 0, byFavouriteType: [] })
        )
        renderCard({ onOpenUsage })
        fireEvent.click(screen.getByRole('button', { name: 'Appears unused' }))
        expect(onOpenUsage).toHaveBeenCalled()
    })

    it('shows nothing about usage when this instance has no usage view', () => {
        mockUsage.mockReturnValue({
            status: 'absent',
            error: null,
            forSet: () => null,
            refresh: jest.fn(),
        })
        renderCard()
        expect(screen.queryByText('Appears unused')).not.toBeInTheDocument()
        expect(screen.queryByText(/favourites/)).not.toBeInTheDocument()
    })

    it('shows nothing about usage on an indicator group set', () => {
        mockUsage.mockReturnValue(
            readyUsage({ favourites: 0, views12m: 0, byFavouriteType: [] })
        )
        renderCard({ set: { objectType: 'indicator' } })
        expect(screen.queryByText('Appears unused')).not.toBeInTheDocument()
    })
})
