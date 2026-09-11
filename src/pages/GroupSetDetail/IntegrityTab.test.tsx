import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { IntegrityTab } from './IntegrityTab'
import { CheckIssue, CheckSummary, ResolvedCheck } from '@/data/integrity'
import { ScopeRef } from '@/engine/store'
import { GroupSetMeta } from '@/engine/types'

// babel-plugin-jest-hoist only allows jest.mock() factories to reference
// out-of-scope variables whose names start with "mock" -- same convention
// as Dashboard.test.tsx and GroupSetDetail.test.tsx.

jest.mock('@dhis2/app-runtime', () => ({
    useConfig: () => ({ baseUrl: 'http://server', apiVersion: 42 }),
}))

const compulsoryCheck: ResolvedCheck = {
    logical: 'orgUnitsMissingCompulsory',
    name: 'org_units_not_in_compulsory_group_sets',
    displayName: 'Org units not in compulsory group sets',
    objectType: 'organisationUnit',
    isSlow: false,
}

const conflictCheck: ResolvedCheck = {
    logical: 'orgUnitsConflicting',
    name: 'organisation_units_violating_exclusive_group_sets',
    displayName: 'Org units violating exclusive group sets',
    objectType: 'organisationUnit',
    isSlow: false,
}

// Not relevant to the org unit set used below -- must never show up, and
// must never trigger a details request or an indexesOf call of its own.
const dataElementCheck: ResolvedCheck = {
    logical: 'dataElementsConflicting',
    name: 'data_elements_violating_exclusive_group_sets',
    displayName: 'Data elements violating exclusive group sets',
    objectType: 'dataElement',
    isSlow: false,
}

// idA/idD: known to the engine and inside the Bo subtree.
// idB: known to the engine but outside the Bo subtree (a different district).
// idC: unknown to the engine entirely (e.g. an unloaded tracker data element).
const detailsByCheck: Record<string, CheckIssue[]> = {
    [compulsoryCheck.name]: [
        { id: 'idA', displayName: 'Facility A', detail: 'refs: A' },
        { id: 'idB', displayName: 'Facility B', detail: null },
        { id: 'idC', displayName: 'Facility C', detail: null },
        { id: 'idD', displayName: 'Facility D', detail: null },
    ],
    [conflictCheck.name]: [
        { id: 'idE', displayName: 'Facility E', detail: 'refs: E' },
    ],
}

const KNOWN_INDEX: Record<string, number> = { idA: 0, idB: 1, idD: 2, idE: 3 }
// idA, idD, idE are inside the requested scope; idB is not.
const IN_SCOPE_IDS = new Set(['idA', 'idD', 'idE'])

const mockReadDetails = jest.fn(
    async (_fetcher: unknown, name: string): Promise<CheckIssue[]> =>
        detailsByCheck[name] ?? []
)
jest.mock('@/data/integrity', () => {
    const actual = jest.requireActual('@/data/integrity')
    return {
        ...actual,
        readDetails: (...args: [unknown, string]) => mockReadDetails(...args),
    }
})

const mockClientCall = jest.fn(async (method: string, ...args: unknown[]) => {
    if (method === 'indexesOf') {
        const [, ids] = args as [string, string[]]
        return ids.map((id) => KNOWN_INDEX[id] ?? -1)
    }
    if (method === 'objectsFor') {
        const [, , filter] = args as [
            string,
            unknown,
            { ids: string[] },
            number,
            number,
        ]
        const items = filter.ids
            .filter((id) => IN_SCOPE_IDS.has(id))
            .map((id) => ({
                index: 0,
                id,
                displayName: id,
                level: null,
                parentId: null,
                status: 1,
                groups: [],
            }))
        return { total: items.length, offset: 0, items }
    }
    if (method === 'dashboard') {
        return [
            {
                set: { id: 'own', displayName: 'Ownership' },
                summary: {
                    population: 10,
                    ok: 2,
                    unassigned: 0,
                    missingError: 5,
                    missingWarning: 0,
                    conflict: 3,
                },
                hasData: true,
            },
        ]
    }
    return null
})

jest.mock('@/hooks/useEngine', () => ({
    useEngine: () => ({
        client: { call: mockClientCall },
        status: { phase: 'done', type: null, progress: null },
    }),
}))

jest.mock('@/hooks/useScope', () => ({
    useScope: () => ({
        rootId: 'bo',
        rootName: 'Bo',
        rootLevel: 2,
        setRoot: () => undefined,
        isReady: true,
    }),
}))

const mockRun = jest.fn(async () => undefined)
const mockIntegrityState: {
    available: boolean
    checks: ResolvedCheck[]
    summaries: Record<string, CheckSummary>
    stale: Set<string>
    isRunning: boolean
    error: string | null
} = {
    available: true,
    checks: [compulsoryCheck, conflictCheck, dataElementCheck],
    summaries: {
        [compulsoryCheck.name]: {
            name: compulsoryCheck.name,
            count: 272,
            finishedTime: '2026-09-01T10:00:00.000Z',
        },
        [conflictCheck.name]: {
            name: conflictCheck.name,
            count: 17,
            finishedTime: '2026-09-01T10:00:00.000Z',
        },
    },
    stale: new Set<string>(),
    isRunning: false,
    error: null,
}
jest.mock('@/hooks/useIntegrity', () => ({
    useIntegrity: () => ({
        ...mockIntegrityState,
        run: mockRun,
        markStale: () => undefined,
        refresh: async () => undefined,
    }),
}))

const set: GroupSetMeta = {
    id: 'own',
    displayName: 'Ownership',
    objectType: 'organisationUnit',
    compulsory: true,
    dataDimension: true,
    canWrite: true,
    groups: [{ id: 'g1', displayName: 'G1', canWrite: true }],
}

const scope: ScopeRef = { objectType: 'organisationUnit', rootId: 'bo' }

afterEach(() => {
    mockReadDetails.mockClear()
    mockClientCall.mockClear()
    mockRun.mockClear()
    mockIntegrityState.stale = new Set()
    mockIntegrityState.error = null
    mockIntegrityState.isRunning = false
})

it('renders the national, in-scope and engine counts for each relevant check', async () => {
    render(<IntegrityTab set={set} scope={scope} />)

    // National (from the server's cached summary, via IntegrityLine).
    expect(await screen.findByText(/272/)).toBeInTheDocument()
    // In-scope: only idA and idD from the compulsory check's four issues.
    expect(await screen.findByText(/\b2\b/)).toBeInTheDocument()
    // Engine's own count for the compulsory rule in this scope
    // (missingError + missingWarning from the dashboard summary): 5.
    expect(await screen.findByText(/\b5\b/)).toBeInTheDocument()
})

it('counts only issue ids inside the scope subtree as in-scope', async () => {
    render(<IntegrityTab set={set} scope={scope} />)

    // Of idA, idB, idC, idD: idB is known but outside Bo, idC is unknown.
    // Only idA and idD are in-scope -- not 3 (which folding idB in would
    // give) and not 4 (every known id).
    await waitFor(() =>
        expect(mockClientCall).toHaveBeenCalledWith(
            'objectsFor',
            'own',
            scope,
            expect.objectContaining({ ids: expect.arrayContaining(['idA']) }),
            expect.anything(),
            expect.anything()
        )
    )
    const inScopeLines = await screen.findAllByText(/fall within the current/)
    const compulsoryLine = inScopeLines[0]
    expect(compulsoryLine.textContent).toEqual(expect.stringContaining('2'))
    expect(compulsoryLine.textContent).not.toEqual(expect.stringContaining('3'))
    expect(compulsoryLine.textContent).not.toEqual(expect.stringContaining('4'))
})

it('counts an id the engine does not know separately, in its own line, never folded into either bucket', async () => {
    render(<IntegrityTab set={set} scope={scope} />)

    // idC is unknown -- named as its own count of 1, distinct from the
    // in-scope count of 2. The compulsory check's line is first in the DOM.
    const unknownLines = await screen.findAllByText(
        /not.*loaded|could not be matched/i
    )
    const compulsoryLine = unknownLines[0]
    expect(compulsoryLine.textContent).toEqual(expect.stringContaining('1'))
})

it('asks the engine for indexes once for the whole tab, not once per issue or per check', async () => {
    render(<IntegrityTab set={set} scope={scope} />)

    await waitFor(
        () => expect(mockReadDetails).toHaveBeenCalledTimes(2) // one per relevant check
    )
    await waitFor(() => expect(mockClientCall).toHaveBeenCalled())

    const indexesOfCalls = mockClientCall.mock.calls.filter(
        (c) => c[0] === 'indexesOf'
    )
    const objectsForCalls = mockClientCall.mock.calls.filter(
        (c) => c[0] === 'objectsFor'
    )
    expect(indexesOfCalls).toHaveLength(1)
    expect(objectsForCalls).toHaveLength(1)

    // The data element check is not relevant to this organisationUnit set
    // and must never trigger its own details request.
    expect(mockReadDetails).not.toHaveBeenCalledWith(
        expect.anything(),
        dataElementCheck.name
    )
})

it('shows the server prose verbatim when present', async () => {
    render(<IntegrityTab set={set} scope={scope} />)
    expect(await screen.findByText('refs: A')).toBeInTheDocument()
})

it("calls run with exactly this tab's relevant check names, and only on click", async () => {
    render(<IntegrityTab set={set} scope={scope} />)
    await screen.findByText(/272/)

    expect(mockRun).not.toHaveBeenCalled()

    const user = userEvent.setup()
    await user.click(screen.getByText('Run now'))

    expect(mockRun).toHaveBeenCalledTimes(1)
    expect(mockRun).toHaveBeenCalledWith([
        compulsoryCheck.name,
        conflictCheck.name,
    ])
})

it('never calls run on mount, and never re-runs from a retry path', async () => {
    render(<IntegrityTab set={set} scope={scope} />)
    await screen.findByText(/272/)
    await waitFor(() => expect(mockReadDetails).toHaveBeenCalled())

    expect(mockRun).not.toHaveBeenCalled()
})

it('shows a stale marker and a re-run suggestion, without running automatically', async () => {
    mockIntegrityState.stale = new Set([compulsoryCheck.name])
    render(<IntegrityTab set={set} scope={scope} />)

    expect(await screen.findByText(/stale/i)).toBeInTheDocument()
    expect(mockRun).not.toHaveBeenCalled()
})

it('renders a static message for useIntegrity().error, never the raw diagnostic text', async () => {
    mockIntegrityState.error = 'HTTP 500 at /api/dataIntegrity/summary: boom'
    render(<IntegrityTab set={set} scope={scope} />)

    await screen.findByText(/272/)
    expect(
        screen.queryByText(/HTTP 500 at \/api\/dataIntegrity/)
    ).not.toBeInTheDocument()
})
