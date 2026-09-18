import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { Dashboard } from './Dashboard'

// Mutable, test-controlled overrides for the mocked engine client below.
// Variable names must start with "mock" -- babel-plugin-jest-hoist only
// allows jest.mock() factories to close over out-of-scope variables with
// that prefix, since jest.mock() calls themselves are hoisted above other
// top-level statements in this file.
const mockCallOverrides: {
    dataElementError: string | null
    extraCleanOrgUnitSet: boolean
    worseOrgUnitSets: boolean
    dataElementSets: boolean
    fellBack: boolean
    notLoadedOrgUnitSet: boolean
    manyCleanOrgUnitSets: boolean
    usageSortSets: boolean
    usageDefaultOrderSets: boolean
    sourceKind: 'sqlView' | 'metadata' | null
    nameSource: 'sqlView' | 'metadata' | null
} = {
    dataElementError: null,
    extraCleanOrgUnitSet: false,
    worseOrgUnitSets: false,
    dataElementSets: false,
    fellBack: false,
    notLoadedOrgUnitSet: false,
    manyCleanOrgUnitSets: false,
    usageSortSets: false,
    usageDefaultOrderSets: false,
    sourceKind: 'metadata',
    nameSource: 'metadata',
}

// Task 6: a mutable status, same treatment as mockCallOverrides above -- a
// test overrides `loadedAt` to pin which type's age the freshness indicator
// should be showing. `baseStatus` itself is never referenced inside the
// jest.mock() factory below (only `mockStatus`, which starts with "mock",
// may be), so it exists purely for tests and afterEach to reset from.
const baseStatus = {
    phase: 'done',
    type: null,
    progress: null,
    fromCache: {},
    errors: {},
    namesErrors: {},
    loadedAt: {},
}
let mockStatus: typeof baseStatus & {
    loadedAt: Partial<Record<string, number>>
} = baseStatus

const cleanSet = (id: string, name: string) => ({
    set: {
        id,
        displayName: name,
        objectType: 'organisationUnit',
        compulsory: false,
        dataDimension: false,
        canWrite: true,
        groups: [],
    },
    summary: {
        population: 5,
        ok: 5,
        unassigned: 0,
        missingError: 0,
        missingWarning: 0,
        conflict: 0,
    },
    hasData: true,
})

const notLoadedSet = (id: string, name: string) => ({
    set: {
        id,
        displayName: name,
        objectType: 'organisationUnit',
        compulsory: false,
        dataDimension: false,
        canWrite: true,
        groups: [],
    },
    summary: {
        population: 0,
        ok: 0,
        unassigned: 0,
        missingError: 0,
        missingWarning: 0,
        conflict: 0,
    },
    hasData: false,
})

const brokenSet = (id: string, name: string, conflict: number) => ({
    set: {
        id,
        displayName: name,
        objectType: 'organisationUnit',
        compulsory: true,
        dataDimension: true,
        canWrite: true,
        groups: [],
    },
    summary: {
        population: 5,
        ok: 4,
        unassigned: 0,
        missingError: 1,
        missingWarning: 0,
        conflict,
    },
    hasData: true,
})

const entries = {
    get organisationUnit() {
        // Task 7's usage-sort tests need exact, isolated fixtures rather
        // than the baseline set built up below -- an early return keeps
        // them from having to reason about 'own'/'clean' noise.
        if (mockCallOverrides.usageSortSets) {
            return [
                brokenSet('heavy', 'Heavy usage set', 9),
                brokenSet('light', 'Light usage set', 0),
            ]
        }
        if (mockCallOverrides.usageDefaultOrderSets) {
            return [
                brokenSet('clean', 'Clean order set', 0),
                brokenSet('broken', 'Broken order set', 9),
            ]
        }
        const sets = [
            brokenSet('own', 'Ownership', 0),
            cleanSet('clean', 'Clean set'),
        ]
        if (mockCallOverrides.extraCleanOrgUnitSet) {
            sets.push(cleanSet('clean2', 'Clean set 2'))
        }
        if (mockCallOverrides.worseOrgUnitSets) {
            sets.push(brokenSet('worst', 'Worst set', 40))
            sets.push(brokenSet('middle', 'Middle set', 5))
            sets.push(brokenSet('tied', 'Tied set', 0))
        }
        if (mockCallOverrides.notLoadedOrgUnitSet) {
            sets.push(notLoadedSet('notloaded', 'Not loaded set'))
        }
        if (mockCallOverrides.manyCleanOrgUnitSets) {
            for (let i = 0; i < 1200; i++) {
                sets.push(cleanSet(`bulk${i}`, `Bulk clean ${i}`))
            }
        }
        return sets
    },
    get dataElement() {
        return mockCallOverrides.dataElementSets
            ? [
                  {
                      ...brokenSet('de', 'Element set', 2),
                      set: {
                          ...brokenSet('de', 'Element set', 2).set,
                          objectType: 'dataElement',
                      },
                  },
              ]
            : ([] as unknown[])
    },
    indicator: [] as unknown[],
    categoryOption: [] as unknown[],
}

jest.mock('@/hooks/useEngine', () => ({
    useEngine: () => ({
        client: {
            call: async (
                _m: string,
                scope: { objectType: keyof typeof entries }
            ) => {
                if (
                    scope.objectType === 'dataElement' &&
                    mockCallOverrides.dataElementError
                ) {
                    throw new Error(mockCallOverrides.dataElementError)
                }
                return entries[scope.objectType]
            },
        },
        status: mockStatus,
        groupSets: [],
        get sourceKind() {
            return mockCallOverrides.sourceKind
        },
        get nameSource() {
            return mockCallOverrides.nameSource
        },
        get fellBack() {
            return mockCallOverrides.fellBack
        },
        error: null,
        reload: async () => undefined,
    }),
}))
jest.mock('@/hooks/useIntegrity', () => ({
    useIntegrity: () => ({
        available: false,
        checks: [],
        summaries: {},
        stale: new Set(),
        isRunning: false,
        error: null,
        run: async () => undefined,
        markStale: () => undefined,
        refresh: async () => undefined,
    }),
}))
// R6: Dashboard renders GroupSetCard, which depends on @/hooks/useUsage --
// mocked at module level the same way useIntegrity is above, since none of
// these tests exercise usage and useUsage's real implementation needs a
// DataProvider/QueryClient context this file's shallow render tree doesn't
// have.
//
// Task 7: a jest.fn() rather than a static object, so the usage sort tests
// can swap in 'ready'/'absent' states per test with mockReturnValue while
// every other test keeps the 'absent' baseline Task 6 set up.
const mockUsage = jest.fn()
const defaultUsageState = {
    status: 'absent',
    error: null,
    forSet: () => null,
    refresh: jest.fn(),
}
mockUsage.mockReturnValue(defaultUsageState)
jest.mock('@/hooks/useUsage', () => ({
    useUsage: () => mockUsage(),
}))
jest.mock('@/hooks/useScope', () => ({
    useScope: () => ({
        rootId: 'root',
        rootName: 'Root',
        rootLevel: 1,
        setRoot: () => undefined,
        isReady: true,
    }),
}))
// OrgUnitField (rendered by the FilterBar below) reads its own roots for the
// tree through this hook; none of these tests open the tree modal, so it
// only needs to resolve without hitting the real data engine.
jest.mock('@/hooks/useUserScope', () => ({
    useUserScope: () => ({ roots: [{ id: 'root', displayName: 'Root' }] }),
}))

afterEach(() => {
    sessionStorage.clear()
    mockCallOverrides.dataElementError = null
    mockCallOverrides.extraCleanOrgUnitSet = false
    mockCallOverrides.worseOrgUnitSets = false
    mockCallOverrides.dataElementSets = false
    mockCallOverrides.fellBack = false
    mockCallOverrides.notLoadedOrgUnitSet = false
    mockCallOverrides.manyCleanOrgUnitSets = false
    mockCallOverrides.usageSortSets = false
    mockCallOverrides.usageDefaultOrderSets = false
    mockCallOverrides.sourceKind = 'metadata'
    mockCallOverrides.nameSource = 'metadata'
    mockUsage.mockReturnValue(defaultUsageState)
    mockStatus = baseStatus
})

// Spec 8a: with GSI_ORGUNIT_NAMES removed, the views still serve the
// hierarchy and the memberships while names come from the metadata API --
// and names are the one part of the load a user can see the difference in,
// so the label has to say so rather than claim one source for everything.
it('says names came from the metadata API when only the names view is gone', async () => {
    mockCallOverrides.sourceKind = 'sqlView'
    mockCallOverrides.nameSource = 'metadata'
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    await waitFor(() =>
        expect(screen.getByText('Ownership')).toBeInTheDocument()
    )
    expect(
        screen.getByText(
            'Data loaded from the GSI SQL views, with organisation unit names from the metadata API'
        )
    ).toBeInTheDocument()
})

it('names the views alone when all three are serving', async () => {
    mockCallOverrides.sourceKind = 'sqlView'
    mockCallOverrides.nameSource = 'sqlView'
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    await waitFor(() =>
        expect(screen.getByText('Ownership')).toBeInTheDocument()
    )
    expect(
        screen.getByText('Data loaded from the GSI SQL views')
    ).toBeInTheDocument()
})

it('shows the SQL view repair notice after a real fallback', async () => {
    mockCallOverrides.fellBack = true
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    await waitFor(() =>
        expect(screen.getByText('Ownership')).toBeInTheDocument()
    )
    expect(screen.getByText(/settings/i)).toBeInTheDocument()
})

it('stays silent on a metadata-only server that never fell back', async () => {
    // sourceKind is 'metadata' here too (the mock's baseline), which is
    // exactly the case the nudge must not trigger on -- a server that
    // never had SQL views to begin with, distinguished only by fellBack.
    mockCallOverrides.fellBack = false
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    await waitFor(() =>
        expect(screen.getByText('Ownership')).toBeInTheDocument()
    )
    expect(screen.queryByText(/settings/i)).not.toBeInTheDocument()
})

// Fix round 2 (Important 2): spec 3.6 requires every surface showing a
// count to carry the caveat -- the dashboard cards show a favourites count
// with none anywhere on the page until this fix. One line for the whole
// page, not one per card.
it('shows the indicative-counts caveat once usage data is ready, and not before', async () => {
    mockUsage.mockReturnValue({
        status: 'ready',
        error: null,
        forSet: () => ({ favourites: 0, views12m: 0, byFavouriteType: [] }),
        refresh: jest.fn(),
    })
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    await waitFor(() =>
        expect(screen.getByText('Ownership')).toBeInTheDocument()
    )
    expect(screen.getByText(/Usage counts are indicative/)).toBeInTheDocument()
})

it('shows no indicative-counts caveat when there is no usage data to caveat', async () => {
    mockUsage.mockReturnValue({
        status: 'absent',
        error: null,
        forSet: () => null,
        refresh: jest.fn(),
    })
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    await waitFor(() =>
        expect(screen.getByText('Ownership')).toBeInTheDocument()
    )
    expect(
        screen.queryByText(/Usage counts are indicative/)
    ).not.toBeInTheDocument()
})

it('lists sets with issues and hides clean ones by default', async () => {
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    await waitFor(() =>
        expect(screen.getByText('Ownership')).toBeInTheDocument()
    )
    expect(screen.queryByText('Clean set')).not.toBeInTheDocument()
    expect(screen.getByText('1 set without issues hidden')).toBeInTheDocument()
})

it('pluralises the hidden-sets count for more than one clean set', async () => {
    mockCallOverrides.extraCleanOrgUnitSet = true
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    await waitFor(() =>
        expect(
            screen.getByText('2 sets without issues hidden')
        ).toBeInTheDocument()
    )
})

// Minor 8 (fix round 1): the hidden-sets count is another count the
// dashboard renders, so it must format with the same thousands separator
// as the stat tiles rather than being a straggler.
it('formats the hidden-sets count with a thousands separator', async () => {
    mockCallOverrides.manyCleanOrgUnitSets = true
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    // 1200 bulk clean sets plus the fixture's own always-present clean set.
    await waitFor(() =>
        expect(
            screen.getByText(
                `${(1201).toLocaleString()} sets without issues hidden`
            )
        ).toBeInTheDocument()
    )
})

it('surfaces a per-type engine failure instead of silently hiding the section', async () => {
    mockCallOverrides.dataElementError = 'Unknown organisationUnit root id xyz'
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    await waitFor(() =>
        expect(
            screen.getByText("This type's summary could not be computed")
        ).toBeInTheDocument()
    )
    expect(
        screen.getByText('Unknown organisationUnit root id xyz')
    ).toBeInTheDocument()
})

it('sorts cards worst first, keeping API order among equals (spec 5.1)', async () => {
    mockCallOverrides.worseOrgUnitSets = true
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    await waitFor(() =>
        expect(screen.getByText('Worst set')).toBeInTheDocument()
    )
    const names = screen
        .getAllByRole('button')
        .map((b) => b.textContent ?? '')
        .filter((t) => t.includes('set') || t.includes('Ownership'))
    // 40 conflicts, then 5, then the two with one missing error each in the
    // order the engine returned them.
    expect(names[0]).toContain('Worst set')
    expect(names[1]).toContain('Middle set')
    expect(names[2]).toContain('Ownership')
    expect(names[3]).toContain('Tied set')
})

// A set whose dashboard call has not resolved yet has zero errors -- there
// is nothing to count -- so byWorstFirst's error-count sort put it wherever
// a tie with the clean sets happened to land it, with nothing but the
// card's own "Loading…" text (see GroupSetCard.tsx) telling it apart from a
// set that is genuinely clean. It belongs in its own group instead: a
// number can change under a user with no explanation otherwise (the load
// that hasn't finished yet is exactly the carried-forward "detail page
// shows no indication a reload is running" sibling item).
it('sorts a set with no data yet into its own group, not mixed in among the clean ones', async () => {
    mockCallOverrides.worseOrgUnitSets = true
    mockCallOverrides.notLoadedOrgUnitSet = true
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    await waitFor(() =>
        expect(screen.getByText('Not loaded set')).toBeInTheDocument()
    )
    const names = screen
        .getAllByRole('button')
        .map((b) => b.textContent ?? '')
        .filter((t) => t.includes('set') || t.includes('Ownership'))
    // "Clean set" is filtered out entirely by the default "only sets with
    // issues" view -- it has no issues and hasData is true. "Not loaded
    // set" has no issues either, but shows anyway (the filter always shows
    // !hasData entries); it must not have landed among the (invisible,
    // filtered-out) clean sets by sort order -- it belongs ahead of every
    // loaded set, worst-first-sorted or not.
    expect(names[0]).toContain('Not loaded set')
})

// Minor 9 (fix round 1): the "own group" from the test above must reach
// the user as a visible label, not only as a code comment -- the card's
// "Loading…" text alone does not say why the set is sorted where it is.
it('says why the not-yet-loaded group is separate, as visible text', async () => {
    mockCallOverrides.worseOrgUnitSets = true
    mockCallOverrides.notLoadedOrgUnitSet = true
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    await waitFor(() =>
        expect(screen.getByText('Not loaded set')).toBeInTheDocument()
    )
    expect(screen.getByText(/still loading/i)).toBeInTheDocument()
})

// Manual review 2: the Show choice (and the type and sort choices beside
// it) lived only in component state, so opening a group set and coming back
// reset the dashboard to "Only sets with issues" every time. Leaving the
// page is an unmount; the choice has to come back on the next mount.
it('keeps the Show choice across leaving and returning to the dashboard', async () => {
    const first = render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    await waitFor(() =>
        expect(screen.getByText('Ownership')).toBeInTheDocument()
    )
    await userEvent.click(screen.getByText('Only sets with issues'))
    await userEvent.click(
        document.querySelector('[data-value="all"]') as HTMLElement
    )
    expect(screen.getByText('All sets')).toBeInTheDocument()
    first.unmount()

    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    await waitFor(() =>
        expect(screen.getByText('Ownership')).toBeInTheDocument()
    )
    expect(screen.getByText('All sets')).toBeInTheDocument()
    expect(screen.queryByText('Only sets with issues')).not.toBeInTheDocument()
})

it('filters the sections by object type (spec 5.1)', async () => {
    mockCallOverrides.dataElementSets = true
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    await waitFor(() =>
        expect(screen.getByText('Element set')).toBeInTheDocument()
    )
    expect(screen.getByText('Ownership')).toBeInTheDocument()

    await userEvent.click(screen.getByText('All object types'))
    // The section heading carries the same text as the option, so the option
    // is picked by its value rather than by its label.
    await userEvent.click(
        document.querySelector('[data-value="dataElement"]') as HTMLElement
    )

    await waitFor(() =>
        expect(screen.queryByText('Ownership')).not.toBeInTheDocument()
    )
    expect(screen.getByText('Element set')).toBeInTheDocument()
})

it('says a type has no group sets instead of leaving the content area blank', async () => {
    // `entries.indicator` is `[]` by default in this mock (see `entries`
    // above) -- an object type the engine reports as having settled with
    // no group sets at all, the same shape as the Laos and EHR databases
    // the compatibility campaign found this on. Filtering down to it used
    // to render nothing: no heading, no message, nothing to tell a user
    // apart from a stuck load or a broken app.
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    await waitFor(() =>
        expect(screen.getByText('Ownership')).toBeInTheDocument()
    )

    await userEvent.click(screen.getByText('All object types'))
    await userEvent.click(
        document.querySelector('[data-value="indicator"]') as HTMLElement
    )

    await waitFor(() =>
        expect(
            screen.getByText(
                'There are no group sets of this type on this instance.'
            )
        ).toBeInTheDocument()
    )
    // The heading appears twice once the message is showing: once as the
    // still-rendered selected value of the type dropdown, once as the
    // section heading above the message -- so assert on the section
    // heading element specifically rather than the text generally.
    expect(
        screen.getByRole('heading', { name: 'Indicator group sets' })
    ).toBeInTheDocument()
})

it('says which data source served the numbers (spec 8a)', async () => {
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    await waitFor(() =>
        expect(
            screen.getByText('Data loaded from the metadata API')
        ).toBeInTheDocument()
    )
})

// "a field never moves between pages" (FilterBar.tsx) is the point of the
// shared component; pin the dashboard's own field order so a future change
// has to be deliberate. Anchored full-string matches, not a bare /Data/
// substring: the source-kind note elsewhere on the page ("Data loaded from
// the metadata API") also contains "Data" and would otherwise be picked up
// as a sixth, unwanted match.
it('renders its filter fields in the fixed order', () => {
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    const labels = screen
        .getAllByText(/^(Organisation unit|Object type|Show|Sort by|Data)$/)
        .map((el) => el.textContent)
    expect(labels).toEqual([
        'Organisation unit',
        'Object type',
        'Show',
        'Sort by',
        'Data',
    ])
})

// Fix round 1, Important 1: every field's label goes through FilterBarField
// now, and none of the three SingleSelectFields is passed its own `label`
// prop any more -- so each label string must appear exactly once, not
// twice (once from FilterBarField's span, once from @dhis2-ui/field's own
// Label, which is what reintroduced a second, differently-sized label
// typography into the row last round).
it('gives every field one label, not a second one from its own library control', () => {
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    ;['Organisation unit', 'Object type', 'Show', 'Sort by', 'Data'].forEach(
        (label) => {
            expect(screen.getAllByText(label)).toHaveLength(1)
        }
    )
})

// Fix round 1, Important 1: jsdom cannot measure the resulting pixel
// height, but it can pin the size-prop convention the CSS comment in
// FilterBar.module.css depends on -- every Button in the bar carries no
// size prop (so FilterBar.module.css's `.field > button { height: 32px }`
// is the only thing setting its height) and every SingleSelectField
// carries `dense`. A `small` or `large` Button, or a non-dense select,
// would silently reopen the two-height row this fix closes.
it('keeps one height convention across the bar: no button size prop, every select dense', () => {
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    const bar = screen.getByTestId('filter-bar')
    within(bar)
        .getAllByRole('button')
        .forEach((button) => {
            expect(button).not.toHaveClass('small')
            expect(button).not.toHaveClass('large')
        })
    expect(bar.querySelectorAll('.dense')).toHaveLength(3)
})

// Fix round 1, Important 2: helpText (a documented @dhis2-ui/field prop)
// replaces the earlier <span title> wrapper around the disabled option,
// which depended on undocumented Menu internals. helpText is always
// visible, unlike a hover-only title, and doesn't need the option itself
// wrapped in anything.
// Task 7: this is now the "no usage view installed" case for the sort
// field -- explicitly mocking 'absent' (rather than relying on the mock's
// own baseline) so it keeps guarding this state regardless of what the
// baseline default happens to be. Assertions are unchanged from before
// Task 7: the help text is shown and the option carries the `disabled`
// class.
it('disables the not-yet-available usage sort, with help text explaining why', async () => {
    mockUsage.mockReturnValue({
        status: 'absent',
        error: null,
        forSet: () => null,
        refresh: jest.fn(),
    })
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    await waitFor(() =>
        expect(screen.getByText('Ownership')).toBeInTheDocument()
    )
    expect(
        screen.getByText('Usage data is not installed on this instance')
    ).toBeInTheDocument()

    // The option list isn't mounted until the field is opened (matching
    // this file's existing "filters the sections by object type" test,
    // which opens Object type's select before querying its options the
    // same way).
    await userEvent.click(screen.getByText('Issues'))
    const usageOption = document.querySelector(
        '[data-value="usage"]'
    ) as HTMLElement
    expect(usageOption).toHaveClass('disabled')
})

// Task 7: once a usage view is installed and read, the option stops being
// disabled and the field's helpText disappears -- the flip side of the
// "absent" case just above.
it('enables the usage sort, with no help text, once usage data is ready', async () => {
    mockUsage.mockReturnValue({
        status: 'ready',
        error: null,
        forSet: () => ({ favourites: 0, views12m: 0, byFavouriteType: [] }),
        refresh: jest.fn(),
    })
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    await waitFor(() =>
        expect(screen.getByText('Ownership')).toBeInTheDocument()
    )
    expect(
        screen.queryByText('Usage data is not installed on this instance')
    ).not.toBeInTheDocument()

    await userEvent.click(screen.getByText('Issues'))
    const usageOption = document.querySelector(
        '[data-value="usage"]'
    ) as HTMLElement
    expect(usageOption).not.toHaveClass('disabled')
})

// Fix round 2 (Important 1): 'loading' is true on every fresh dashboard
// load of a perfectly healthy instance, so it must not show the most
// specific ('absent'/'error') wording -- and a transient state should not
// explain itself at all, so neither string appears while the option stays
// disabled.
it('shows no help text for the usage sort while usage is still loading, but keeps the option disabled', async () => {
    mockUsage.mockReturnValue({
        status: 'loading',
        error: null,
        forSet: () => null,
        refresh: jest.fn(),
    })
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    await waitFor(() =>
        expect(screen.getByText('Ownership')).toBeInTheDocument()
    )
    expect(
        screen.queryByText('Usage data is not installed on this instance')
    ).not.toBeInTheDocument()
    expect(
        screen.queryByText('Usage data could not be read on this instance')
    ).not.toBeInTheDocument()

    await userEvent.click(screen.getByText('Issues'))
    const usageOption = document.querySelector(
        '[data-value="usage"]'
    ) as HTMLElement
    expect(usageOption).toHaveClass('disabled')
})

// Fix round 2 (Important 1): 'error' (a view that exists but cannot be
// read) is a different story from 'absent' (no view installed) --
// Settings shows this case as "Usable" and the Usage tab says "could not
// be read", so the dashboard must not tell the user to install a view
// that is already there.
it('shows the "could not be read" wording for an unreadable usage view, never the "not installed" wording', async () => {
    mockUsage.mockReturnValue({
        status: 'error',
        error: 'HTTP 500',
        forSet: () => null,
        refresh: jest.fn(),
    })
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    await waitFor(() =>
        expect(screen.getByText('Ownership')).toBeInTheDocument()
    )
    expect(
        screen.getByText('Usage data could not be read on this instance')
    ).toBeInTheDocument()
    expect(
        screen.queryByText('Usage data is not installed on this instance')
    ).not.toBeInTheDocument()

    await userEvent.click(screen.getByText('Issues'))
    const usageOption = document.querySelector(
        '[data-value="usage"]'
    ) as HTMLElement
    expect(usageOption).toHaveClass('disabled')
})

// Fix round 2 (Important 1): without this, choosing the usage sort and
// then having usage stop being ready (the view removed in Settings, or a
// read starting to error) left the field still displaying "Usage (least
// used first)" as selected while the list had already silently fallen
// back to worst-first -- the field and the actual order disagreeing about
// which sort was in effect.
it('returns the sort field to Issues if usage stops being ready after the usage sort was chosen', async () => {
    mockUsage.mockReturnValue({
        status: 'ready',
        error: null,
        forSet: () => ({ favourites: 0, views12m: 0, byFavouriteType: [] }),
        refresh: jest.fn(),
    })
    const { rerender } = render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    await waitFor(() =>
        expect(screen.getByText('Ownership')).toBeInTheDocument()
    )

    await userEvent.click(screen.getByText('Issues'))
    await userEvent.click(
        document.querySelector('[data-value="usage"]') as HTMLElement
    )
    expect(screen.getByText('Usage (least used first)')).toBeInTheDocument()

    mockUsage.mockReturnValue({
        status: 'absent',
        error: null,
        forSet: () => null,
        refresh: jest.fn(),
    })
    rerender(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText('Issues')).toBeInTheDocument())
    expect(
        screen.queryByText('Usage (least used first)')
    ).not.toBeInTheDocument()
})

// Task 7 / spec 3.5 amendment: the option only answers one question --
// which sets nothing references any more -- so it sorts least-used-first,
// and its label says so rather than making the user try it.
it('sorts the least used set first when the usage sort is chosen', async () => {
    mockCallOverrides.usageSortSets = true
    const usageById: Record<
        string,
        { favourites: number; views12m: number; byFavouriteType: never[] }
    > = {
        heavy: { favourites: 40, views12m: 90, byFavouriteType: [] },
        light: { favourites: 0, views12m: 0, byFavouriteType: [] },
    }
    mockUsage.mockReturnValue({
        status: 'ready',
        error: null,
        forSet: (id: string) =>
            usageById[id] ?? {
                favourites: 0,
                views12m: 0,
                byFavouriteType: [],
            },
        refresh: jest.fn(),
    })
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    await waitFor(() =>
        expect(screen.getByText('Heavy usage set')).toBeInTheDocument()
    )

    await userEvent.click(screen.getByText('Issues'))
    await userEvent.click(
        document.querySelector('[data-value="usage"]') as HTMLElement
    )

    await waitFor(() => {
        const names = screen
            .getAllByRole('button')
            .map((b) => b.textContent ?? '')
            .filter((t) => t.includes('usage set'))
        expect(names[0]).toContain('Light usage set')
        expect(names[1]).toContain('Heavy usage set')
    })
})

// Task 7: choosing the usage sort must not change the default -- a user
// arriving to triage errors still sees the worst set first until they
// deliberately pick "Usage (least used first)".
it('keeps worst-first as the default order', async () => {
    mockCallOverrides.usageDefaultOrderSets = true
    mockUsage.mockReturnValue({
        status: 'ready',
        error: null,
        forSet: () => ({ favourites: 0, views12m: 0, byFavouriteType: [] }),
        refresh: jest.fn(),
    })
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    await waitFor(() =>
        expect(screen.getByText('Broken order set')).toBeInTheDocument()
    )
    const names = screen
        .getAllByRole('button')
        .map((b) => b.textContent ?? '')
        .filter((t) => t.includes('order set'))
    expect(names[0]).toContain('Broken order set')
    expect(names[1]).toContain('Clean order set')
})

describe('metadata freshness indicator (Task 6)', () => {
    it("shows the oldest type's age, never the newest", async () => {
        // A dashboard is only as current as its stalest section; reporting
        // the freshest would overstate the whole page.
        mockStatus = {
            ...baseStatus,
            loadedAt: {
                organisationUnit: Date.now() - 2 * 60_000,
                dataElement: Date.now() - 45 * 60_000,
            },
        }
        render(
            <MemoryRouter>
                <Dashboard />
            </MemoryRouter>
        )
        expect(await screen.findByText(/45 minutes ago/)).toBeInTheDocument()
    })
})
