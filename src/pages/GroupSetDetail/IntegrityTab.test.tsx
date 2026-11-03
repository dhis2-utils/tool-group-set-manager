import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { IntegrityTab } from './IntegrityTab'
import type { CheckIssue, CheckSummary, ResolvedCheck } from '@/data/integrity'
import type { ScopeRef } from '@/engine/store'
import type { GroupSetMeta } from '@/engine/types'

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
// must never be part of the batched details request.
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

// M3 (review round 1): `readDetails` now takes an array of check names and
// returns a map keyed by name, in one call -- this mock mirrors that
// widened shape so the batching itself is exercised, not bypassed.
//
// C1 residual (final re-review): `readDetails` was widened again to
// distinguish a check the server has never computed details for
// (`{ finishedTime: null, issues: null }`) from one it computed and found
// nothing for (`{ finishedTime: <time>, issues: [] }`). `detailsByCheck`
// holding no entry for a name is this mock's stand-in for "never computed"
// -- a name deliberately deleted from it for one test, then restored.
const DETAILS_FINISHED_TIME = '2026-09-01T09:00:00.000Z'
const mockReadDetails = jest.fn(
    (
        _fetcher: unknown,
        names: string[]
    ): Promise<
        Record<
            string,
            { finishedTime: string | null; issues: CheckIssue[] | null }
        >
    > => {
        const result: Record<
            string,
            { finishedTime: string | null; issues: CheckIssue[] | null }
        > = {}
        names.forEach((name) => {
            result[name] =
                name in detailsByCheck
                    ? {
                          finishedTime: DETAILS_FINISHED_TIME,
                          issues: detailsByCheck[name],
                      }
                    : { finishedTime: null, issues: null }
        })
        return Promise.resolve(result)
    }
)
jest.mock('@/data/integrity', () => {
    const actual = jest.requireActual('@/data/integrity')
    return {
        ...actual,
        readDetails: (...args: [unknown, string[]]) => mockReadDetails(...args),
    }
})

// m1 (final review): lets one test push the engine (missingError) count up
// to a thousands-scale value without disturbing every other test's fixture.
let mockMissingErrorOverride: number | null = null
let mockMissingWarning = 0

const mockClientCall = jest.fn((method: string, ...args: unknown[]) => {
    if (method === 'indexesOf') {
        const [, ids] = args as [string, string[]]
        return Promise.resolve(ids.map((id) => KNOWN_INDEX[id] ?? -1))
    }
    if (method === 'objectsFor') {
        const filter = (
            args as [string, unknown, { ids: string[] }, number, number]
        )[2]
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
        return Promise.resolve({ total: items.length, offset: 0, items })
    }
    if (method === 'dashboard') {
        return Promise.resolve([
            {
                set: { id: 'own', displayName: 'Ownership' },
                summary: {
                    population: 10,
                    ok: 2,
                    unassigned: 0,
                    missingError: mockMissingErrorOverride ?? 5,
                    missingWarning: mockMissingWarning,
                    conflict: 3,
                },
                hasData: true,
            },
        ])
    }
    return Promise.resolve(null)
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

const mockRun = jest.fn(() => Promise.resolve(undefined))
const mockIntegrityState: {
    available: boolean
    checks: ResolvedCheck[]
    summaries: Record<string, CheckSummary>
    stale: Set<string>
    isRunning: boolean
    error: string | null
    timedOut: boolean
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
    timedOut: false,
}
jest.mock('@/hooks/useIntegrity', () => ({
    useIntegrity: () => ({
        ...mockIntegrityState,
        run: mockRun,
        markStale: () => undefined,
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
    mockIntegrityState.summaries = {
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
    }
    mockMissingErrorOverride = null
    mockMissingWarning = 0
    mockIntegrityState.timedOut = false
})

// M8: the "missing a compulsory group set" check is about compulsory sets
// only; on any other set it would compare units missing some other set.
test('does not show the missing-compulsory check on a set that is not compulsory', async () => {
    render(<IntegrityTab set={{ ...set, compulsory: false }} scope={scope} />)
    expect(await screen.findByText(conflictCheck.displayName)).toBeVisible()
    expect(
        screen.queryByText(compulsoryCheck.displayName)
    ).not.toBeInTheDocument()
})

test('compares the missing-compulsory check with errors only, not warnings', async () => {
    mockMissingWarning = 7
    render(<IntegrityTab set={set} scope={scope} />)
    const engineLines = await screen.findAllByText(
        /failing the Ownership rule alone/
    )
    expect(engineLines[0].textContent).toEqual(expect.stringContaining('5'))
    expect(engineLines[0].textContent).not.toEqual(
        expect.stringContaining('12')
    )
})

// L4: a run that gave up polling gets its own message, not "try again".
test('says the server may still be running a check that timed out', async () => {
    mockIntegrityState.timedOut = true
    render(<IntegrityTab set={set} scope={scope} />)
    expect(
        await screen.findByText(/may still be running the check/)
    ).toBeInTheDocument()
    expect(
        screen.queryByText(/something went wrong reading/i)
    ).not.toBeInTheDocument()
})

test('renders the national, in-scope and engine counts for each relevant check', async () => {
    render(<IntegrityTab set={set} scope={scope} />)

    // National (from the server's cached summary, via IntegrityLine).
    expect(await screen.findByText(/272/)).toBeInTheDocument()
    // In-scope: only idA and idD from the compulsory check's four issues.
    expect(await screen.findByText(/\b2\b/)).toBeInTheDocument()
    // Engine's own count for the compulsory rule in this scope
    // (missingError + missingWarning from the dashboard summary): 5.
    expect(await screen.findByText(/\b5\b/)).toBeInTheDocument()
})

test('counts only issue ids inside the scope subtree as in-scope', async () => {
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

test('counts an id the engine does not know separately, in its own line, never folded into either bucket', async () => {
    render(<IntegrityTab set={set} scope={scope} />)

    // idC is unknown -- named as its own count of 1, distinct from the
    // in-scope count of 2. The compulsory check's line is first in the DOM.
    const unknownLines = await screen.findAllByText(
        /not.*loaded|could not be matched/i
    )
    const compulsoryLine = unknownLines[0]
    expect(compulsoryLine.textContent).toEqual(expect.stringContaining('1'))
})

// m1 (review round 1): a check with zero unknown ids must not render the
// unknown line at all -- the conflict check's only issue (idE) is known and
// in scope, so its panel has nothing to report there.
test('does not render the unknown-objects line for a check with no unknown ids', async () => {
    render(<IntegrityTab set={set} scope={scope} />)

    await screen.findByText('refs: E') // conflict check's panel has rendered
    const unknownLines = await screen.findAllByText(/could not be matched/i)
    // Only the compulsory check's line (1 unknown) -- not a second, "0",
    // line for the conflict check.
    expect(unknownLines).toHaveLength(1)
})

// M3 (review round 1): the brief requires one details request for the whole
// tab, batched across every relevant check sharing an object type -- not one
// per check. This replaces the round-1 test that pinned the deviation
// (`toHaveBeenCalledTimes(2) // one per relevant check`).
test('reads details once for the whole tab, in one call naming every relevant check, not once per check', async () => {
    render(<IntegrityTab set={set} scope={scope} />)

    await waitFor(() => expect(mockReadDetails).toHaveBeenCalledTimes(1))
    expect(mockReadDetails).toHaveBeenCalledWith(expect.anything(), [
        compulsoryCheck.name,
        conflictCheck.name,
    ])

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
    // and must never be named in the batched request.
    expect(mockReadDetails).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining([dataElementCheck.name])
    )
})

// m1 (final review): every other count-rendering site on the branch
// thousands-formats -- Task 8 item 4's sweep missed this file (and
// IntegrityLine.tsx, fixed alongside it).
test('thousands-formats the unknown and engine counts', async () => {
    const originalIssues = detailsByCheck[compulsoryCheck.name]
    // None of these ids are in KNOWN_INDEX, so all 1234 count as unknown.
    detailsByCheck[compulsoryCheck.name] = Array.from(
        { length: 1234 },
        (_, i) => ({
            id: `unknown${i}`,
            displayName: `Unknown ${i}`,
            detail: null,
        })
    )
    mockMissingErrorOverride = 12340 // + missingWarning 0 = 12,340

    try {
        render(<IntegrityTab set={set} scope={scope} />)
        expect(await screen.findByText(/1,234\b/)).toBeInTheDocument()
        expect(await screen.findByText(/12,340\b/)).toBeInTheDocument()
    } finally {
        detailsByCheck[compulsoryCheck.name] = originalIssues
    }
})

test('shows the server prose verbatim when present, and excludes an out-of-scope issue from the list', async () => {
    render(<IntegrityTab set={set} scope={scope} />)
    expect(await screen.findByText('refs: A')).toBeInTheDocument()
    // idB (Facility B) is known but outside Bo -- present in the server's
    // issue list, but must not be rendered (m4).
    await screen.findByText('Facility D')
    expect(screen.queryByText('Facility B')).not.toBeInTheDocument()
})

test("calls run with exactly this tab's relevant check names, and only on click", async () => {
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

// C1 (final review): a summary-only run never populates the details cache
// the tab's in-scope count, unknown count and issue list are read from
// (fixed in useIntegrity.tsx). The other half of the fix belongs here: even
// once the server's details cache is filled, the tab must actually re-read
// it after "Run now" resolves -- its details effect is keyed on
// `checkNamesKey`/`scope`/`set` only, none of which change just because a
// run finished, so without this the freshly-populated cache is never
// picked up without a remount.
test('re-reads details after "Run now" resolves, not only on mount', async () => {
    render(<IntegrityTab set={set} scope={scope} />)
    await screen.findByText(/272/)
    await waitFor(() => expect(mockReadDetails).toHaveBeenCalledTimes(1))

    const user = userEvent.setup()
    await user.click(screen.getByText('Run now'))

    await waitFor(() => expect(mockReadDetails).toHaveBeenCalledTimes(2))
})

test('never calls run on mount, and never re-runs from a retry path', async () => {
    render(<IntegrityTab set={set} scope={scope} />)
    await screen.findByText(/272/)
    await waitFor(() => expect(mockReadDetails).toHaveBeenCalled())

    expect(mockRun).not.toHaveBeenCalled()
})

test('shows a stale marker and a re-run suggestion, without running automatically', async () => {
    mockIntegrityState.stale = new Set([compulsoryCheck.name])
    render(<IntegrityTab set={set} scope={scope} />)

    expect(await screen.findByText(/stale/i)).toBeInTheDocument()
    expect(mockRun).not.toHaveBeenCalled()
})

test('renders a static message for useIntegrity().error, never the raw diagnostic text', async () => {
    mockIntegrityState.error = 'HTTP 500 at /api/dataIntegrity/summary: boom'
    render(<IntegrityTab set={set} scope={scope} />)

    await screen.findByText(/272/)
    expect(
        screen.queryByText(/HTTP 500 at \/api\/dataIntegrity/)
    ).not.toBeInTheDocument()
})

// M1 (review round 1): the engine line must name its own population (this
// set) and must not claim to be "the source of truth" for a number that
// counts something narrower than the DHIS2 figure above it.
test('names this set in the engine count line, and does not call it the source of truth', async () => {
    render(<IntegrityTab set={set} scope={scope} />)

    const engineLines = await screen.findAllByText(
        /failing the Ownership rule alone/
    )
    // Both checks belong to this same set, so both name it -- the
    // compulsory check's line (first in the DOM) carries the 5.
    expect(engineLines[0].textContent).toEqual(expect.stringContaining('5'))
    expect(screen.queryByText(/source of truth/i)).not.toBeInTheDocument()
})

// M2 (review round 1), narrowed after round 2's n1/n2: when the in-scope and
// engine counts disagree (2 vs 5 for the compulsory check here), the tab
// must say something -- but the app cannot actually know which figure is
// newer (there is no engine-load timestamp anywhere in the app), so the
// sentence must state only the two facts it does hold -- when DHIS2 ran the
// check, and that the app's figure reflects this session's own load --
// without ranking them. This pins the exact claim, not merely the presence
// of some "more recent" phrase: round 1's test asserted only
// `/more recent/i` matched something, which both a correct and an inverted
// comparison satisfied equally (re-review mutation 6).
test("states when DHIS2 ran the check and that the app's figure reflects this session, without ranking the two", async () => {
    render(<IntegrityTab set={set} scope={scope} />)

    const expectedTime = new Date('2026-09-01T10:00:00.000Z').toLocaleString()
    const recencyLines = await screen.findAllByText(
        new RegExp(
            `DHIS2 last ran this check at ${expectedTime.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
        )
    )
    expect(recencyLines.length).toBeGreaterThan(0)
    recencyLines.forEach((line) => {
        expect(line.textContent).toEqual(
            expect.stringContaining("this app's figure above reflects")
        )
        // Neither branch of the old, wrongly-confident wording survives.
        expect(line.textContent).not.toEqual(
            expect.stringContaining('is the more recent')
        )
        expect(line.textContent).not.toEqual(
            expect.stringContaining('may be the more recent')
        )
    })
})

// m5 (review round 1): before a check's own summary has been read, none of
// its numbers -- or its issue list -- should render; a bare list of names
// with no national count, no in-scope count and no run time is worse than
// nothing.
test("does not render a check's issue list before its summary has been read", async () => {
    // Drop the compulsory check's summary only -- the conflict check's stays,
    // so this isolates the gating rather than testing "nothing renders".
    mockIntegrityState.summaries = {
        [conflictCheck.name]: mockIntegrityState.summaries[conflictCheck.name],
    }
    render(<IntegrityTab set={set} scope={scope} />)

    await screen.findByText('refs: E') // the conflict check's panel is fine
    expect(screen.queryByText('Facility A')).not.toBeInTheDocument()
    expect(screen.queryByText('Facility D')).not.toBeInTheDocument()
})

// C1 residual (final re-review): a check whose details DHIS2 has never
// computed must say so, not render "Of those, 0 objects fall within the
// current scope" as though 0 were a real measurement against the national
// count -- that was the original bug, reached again through a server this
// app has never told to compute details for (which was this very
// instance's own state before the fix, per the live-verified finding).
test('says DHIS2 has not computed the issue list yet, rather than rendering an in-scope count of 0, for a check the details endpoint omits entirely', async () => {
    const originalIssues = detailsByCheck[compulsoryCheck.name]
    delete detailsByCheck[compulsoryCheck.name]

    try {
        render(<IntegrityTab set={set} scope={scope} />)

        await screen.findByText(/272/) // the national summary still renders
        expect(
            await screen.findByText(
                /has not computed the issue list for this check yet/
            )
        ).toBeInTheDocument()
        // The false zero must not appear anywhere in this check's panel.
        expect(
            screen.queryByText(/Of those, 0 objects/)
        ).not.toBeInTheDocument()
    } finally {
        detailsByCheck[compulsoryCheck.name] = originalIssues
    }
})
