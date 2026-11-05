import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { GroupSetCard } from './GroupSetCard'
import type { ObjectType } from '@/engine/types'

// Mutable, test-controlled override -- see Dashboard.test.tsx's comment on
// why this must be prefixed "mock" (babel-plugin-jest-hoist).

const mockUsage = jest.fn()
jest.mock('@/hooks/useUsage', () => ({ useUsage: () => mockUsage() }))

const readyUsage = (usage: unknown) => ({
    status: 'ready',
    error: null,
    forSet: () => usage,
    refresh: jest.fn(),
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
        loadError?: string
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
            loadError={overrides.loadError}
        />
    )

test('shows name, properties, counts and a lock when some groups are read-only', async () => {
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
test('formats large stat counts with the same thousands separator as the rest of the dashboard', () => {
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

test('shows a loading state when the type has no data yet', () => {
    renderCard({ entry: { ...entry, hasData: false } })
    expect(screen.getByText(/Loading/)).toBeInTheDocument()
})

test('pluralises the read-only-groups count for more than one group', () => {
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

test('uses the singular group count for exactly one group', () => {
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

test('pluralises the group count tag for more than one group', () => {
    renderCard()
    expect(screen.getByText('2 groups')).toBeInTheDocument()
})

// Minor 8 (fix round 1): item 4 was about count formatting being
// consistent everywhere, not just the stat tiles -- these two labels are
// small in practice, but the fix should not leave stragglers.
test('formats the group count and read-only count with the same thousands separator as the stat tiles', () => {
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

test('shows a configuration-gap message instead of all-clean stats when a set has no groups', () => {
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

test('M12: the set name is a real button that opens the set from the keyboard, once', async () => {
    const onOpen = jest.fn()
    renderCard({ onOpen })
    const name = screen.getByRole('button', { name: 'Ownership' })
    name.focus()
    await userEvent.keyboard('{Enter}')
    await userEvent.keyboard(' ')
    expect(onOpen).toHaveBeenCalledTimes(2)
})

test('M12: no button is nested inside another control', () => {
    mockUsage.mockReturnValue(
        readyUsage({ favourites: 0, views12m: 0, byFavouriteType: [] })
    )
    const { container } = renderCard()
    expect(container.querySelector('[role="button"]')).toBeNull()
    expect(container.querySelectorAll('button button')).toHaveLength(0)
})

test('the rest of the card still opens the set on a mouse click', () => {
    const onOpen = jest.fn()
    renderCard({ onOpen })
    fireEvent.click(screen.getByText('Compulsory'))
    expect(onOpen).toHaveBeenCalledTimes(1)
})

test('M9b: a set of a type that failed to load says so instead of loading forever', () => {
    renderCard({
        entry: { ...entry, hasData: false },
        loadError: 'organisationUnits request failed',
    })
    expect(
        screen.getByText('This group set could not be loaded')
    ).toBeInTheDocument()
    expect(screen.queryByText(/Loading/)).not.toBeInTheDocument()
})

test('M9b: a set with no groups says so even before any data, rather than loading forever', () => {
    renderCard({
        entry: { ...entry, hasData: false, set: { ...entry.set, groups: [] } },
    })
    expect(
        screen.getByText('This group set has no groups configured')
    ).toBeInTheDocument()
    expect(screen.queryByText(/Loading/)).not.toBeInTheDocument()
})

test('counts every object in no group once, as "No group", whatever the set requires', () => {
    // One name for one thing: a compulsory set used to say "Missing", a
    // data dimension "Not set", and a set with neither property showed both
    // "Missing 0" and "No group". Only the colour says how serious it is.
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
    expect(screen.getAllByText('No group')).toHaveLength(1)
    expect(screen.getByText('70')).toBeInTheDocument()
    expect(screen.queryByText('Missing')).not.toBeInTheDocument()

    const compulsory = {
        ...entry,
        summary: { ...permissive.summary, unassigned: 0, missingError: 70 },
    }
    rerender(
        <GroupSetCard
            entry={compulsory}
            onOpen={() => undefined}
            onOpenUsage={() => undefined}
        />
    )
    expect(screen.getAllByText('No group')).toHaveLength(1)
    expect(screen.getByText('70')).toBeInTheDocument()
    expect(screen.queryByText('Missing')).not.toBeInTheDocument()
})

describe('GroupSetCard — usage', () => {
    it('shows the favourite count', () => {
        mockUsage.mockReturnValue(
            readyUsage({ favourites: 42, views12m: 100, byFavouriteType: [] })
        )
        renderCard()
        expect(screen.getByText('Used in 42 favourites')).toBeInTheDocument()
    })

    it('tags a set no favourite references, and the tag opens its Usage tab', () => {
        const onOpen = jest.fn()
        const onOpenUsage = jest.fn()
        mockUsage.mockReturnValue(
            readyUsage({ favourites: 0, views12m: 0, byFavouriteType: [] })
        )
        renderCard({ onOpen, onOpenUsage })
        fireEvent.click(screen.getByRole('button', { name: 'Appears unused' }))
        expect(onOpenUsage).toHaveBeenCalled()
        // The card has its own (mouse) click handler wired to `onOpen` --
        // without the
        // tag's own `stopPropagation()`, this click would bubble and open
        // Overview as well as (really, instead of, since it fires second)
        // Usage. Deleting that call must fail this assertion.
        expect(onOpen).not.toHaveBeenCalled()
    })

    // A keyboard activation of the tag must open Usage and nothing else.
    // The card used to be a role="button" with its own key handler, which
    // swallowed or doubled the tag's activation. `userEvent` (unlike
    // `fireEvent.keyDown`) simulates a real browser's click-on-Enter/Space
    // for a native `<button>`, which is what actually exercises the seam.
    it('activates only the Usage tab, not Overview, when "Appears unused" is reached by Space', async () => {
        const onOpen = jest.fn()
        const onOpenUsage = jest.fn()
        mockUsage.mockReturnValue(
            readyUsage({ favourites: 0, views12m: 0, byFavouriteType: [] })
        )
        renderCard({ onOpen, onOpenUsage })
        const tag = screen.getByRole('button', { name: 'Appears unused' })
        tag.focus()
        await userEvent.keyboard(' ')
        expect(onOpenUsage).toHaveBeenCalledTimes(1)
        expect(onOpen).not.toHaveBeenCalled()
    })

    it('activates only the Usage tab, not Overview, when "Appears unused" is reached by Enter', async () => {
        const onOpen = jest.fn()
        const onOpenUsage = jest.fn()
        mockUsage.mockReturnValue(
            readyUsage({ favourites: 0, views12m: 0, byFavouriteType: [] })
        )
        renderCard({ onOpen, onOpenUsage })
        const tag = screen.getByRole('button', { name: 'Appears unused' })
        tag.focus()
        await userEvent.keyboard('{Enter}')
        expect(onOpenUsage).toHaveBeenCalledTimes(1)
        expect(onOpen).not.toHaveBeenCalled()
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
