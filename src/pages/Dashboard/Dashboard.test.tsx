import { render, screen, waitFor } from '@testing-library/react'
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
} = {
    dataElementError: null,
    extraCleanOrgUnitSet: false,
    worseOrgUnitSets: false,
    dataElementSets: false,
}

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
        status: {
            phase: 'done',
            type: null,
            progress: null,
            fromCache: {},
            errors: {},
        },
        groupSets: [],
        sourceKind: 'metadata',
        error: null,
        reload: async () => undefined,
    }),
}))
jest.mock('@/hooks/useScope', () => ({
    useScope: () => ({
        rootId: 'root',
        rootName: 'Root',
        setRoot: () => undefined,
        isReady: true,
    }),
}))
jest.mock('@/components/ScopeSelector/ScopeSelector', () => ({
    ScopeSelector: () => <div>scope</div>,
}))

afterEach(() => {
    mockCallOverrides.dataElementError = null
    mockCallOverrides.extraCleanOrgUnitSet = false
    mockCallOverrides.worseOrgUnitSets = false
    mockCallOverrides.dataElementSets = false
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
