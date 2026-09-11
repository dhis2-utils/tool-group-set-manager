import { fetchJson, Fetcher } from './sources/DataSource'
import { ObjectType } from '@/engine/types'

/** The app's six logical checks, named for what they mean rather than for
 *  what any one server calls them. */
export type LogicalCheck =
    | 'orgUnitsMissingCompulsory'
    | 'orgUnitsConflicting'
    | 'dataElementsConflicting'
    | 'indicatorsConflicting'
    | 'categoryOptionsConflicting'
    | 'categoryOptionGroupSetsIncomplete'

export interface ResolvedCheck {
    logical: LogicalCheck
    /** the name this server uses, which is the key for every later call */
    name: string
    displayName: string
    objectType: ObjectType | null
    isSlow: boolean
}

export interface CheckSummary {
    name: string
    count: number
    /** ISO string from the server, or null when the check has never run */
    finishedTime: string | null
}

export interface CheckIssue {
    id: string
    displayName: string
    /** the server's prose, verbatim and unparsed, or null when absent */
    detail: string | null
}

/**
 * The object type each logical check concerns, or null for the one check
 * that concerns no object type the app loads (category option group sets).
 * This is what `resolveChecks` derives `objectType` from -- never from the
 * payload's `issuesIdType`, which is inconsistent across both versions and
 * checks (measured values include `organisationUnits`, `dataElements`,
 * `indicators`, `categories`, `categoryOptionGroupSets` and, on 2.40,
 * `data_elements_aggregate` for a check about data elements).
 */
const OBJECT_TYPE_OF: Record<LogicalCheck, ObjectType | null> = {
    orgUnitsMissingCompulsory: 'organisationUnit',
    orgUnitsConflicting: 'organisationUnit',
    dataElementsConflicting: 'dataElement',
    indicatorsConflicting: 'indicator',
    categoryOptionsConflicting: 'categoryOption',
    categoryOptionGroupSetsIncomplete: null,
}

/**
 * Candidate names per logical check, in preference order. The first
 * candidate present in the server's check list wins; a logical check with
 * no candidate present is omitted from `resolveChecks`' result entirely.
 *
 * Matching is on `name` only, never on `code`. Finding 1 measures why the
 * code is not a safe key: the code `OUVEGS` names the fast SQL check on
 * 2.43 and a different, slow, programmatic check on 2.40, so a code match
 * silently picks the wrong check on the older version. This is exactly the
 * "simplification" a later reader will otherwise make -- don't.
 */
const CANDIDATES: Record<LogicalCheck, readonly string[]> = {
    orgUnitsMissingCompulsory: [
        'org_units_not_in_compulsory_group_sets',
        'orgunits_compulsory_group_count',
    ],
    orgUnitsConflicting: [
        'organisation_units_violating_exclusive_group_sets',
        'orgunit_group_sets_excess_groups',
    ],
    dataElementsConflicting: [
        'data_elements_violating_exclusive_group_sets',
        'data_elements_excess_groupset_membership',
    ],
    indicatorsConflicting: ['indicators_violating_exclusive_group_sets'],
    categoryOptionsConflicting: ['category_options_excess_groupset_membership'],
    categoryOptionGroupSetsIncomplete: [
        'category_option_group_sets_incomplete',
    ],
}

const LOGICAL_ORDER: LogicalCheck[] = [
    'orgUnitsMissingCompulsory',
    'orgUnitsConflicting',
    'dataElementsConflicting',
    'indicatorsConflicting',
    'categoryOptionsConflicting',
    'categoryOptionGroupSetsIncomplete',
]

interface DataIntegrityCheckRow {
    name: string
    code: string
    displayName: string
    isSlow: boolean
}

/**
 * The checks this server actually runs, resolved from the app's six logical
 * checks by name. Never hard-codes a check name or code as *the* key --
 * resolution is by candidate list, at runtime, so this works unmodified
 * from 2.40 through 2.43 and whatever comes after.
 */
export async function resolveChecks(
    fetcher: Fetcher
): Promise<ResolvedCheck[]> {
    // This endpoint returns a bare array, not a wrapped collection -- unlike
    // most metadata list endpoints.
    const rows = await fetchJson<DataIntegrityCheckRow[]>(
        fetcher,
        'dataIntegrity?fields=name,code,displayName,isSlow&paging=false'
    )
    const byName = new Map(rows.map((c) => [c.name, c]))
    const resolved: ResolvedCheck[] = []
    for (const logical of LOGICAL_ORDER) {
        const candidates = CANDIDATES[logical]
        const match = candidates
            .map((name) => byName.get(name))
            .find((row): row is DataIntegrityCheckRow => row !== undefined)
        if (!match) {
            continue
        }
        resolved.push({
            logical,
            name: match.name,
            displayName: match.displayName,
            objectType: OBJECT_TYPE_OF[logical],
            isSlow: match.isSlow,
        })
    }
    return resolved
}

interface SummaryRow {
    count?: number
    finishedTime?: string
}

/**
 * Reads cached summary counts for the given check names, never triggering a
 * run. `timeout=0` -- never anything higher -- because this is a blocking
 * wait on the server side (finding 2): the whole point of reading with
 * timeout=0 is that a user's page load must never block on this.
 */
export async function readSummaries(
    fetcher: Fetcher,
    names: string[]
): Promise<CheckSummary[]> {
    const body = await fetchJson<Record<string, SummaryRow>>(
        fetcher,
        `dataIntegrity/summary?checks=${names.join(',')}&timeout=0`
    )
    return names.map((name) => {
        const row = body[name]
        return {
            name,
            count: row?.count ?? 0,
            finishedTime: row?.finishedTime ?? null,
        }
    })
}

interface DetailIssueRow {
    id: string
    name: string
    refs?: string[]
    comment?: string
}

interface DetailCheckRow {
    issues?: DetailIssueRow[]
}

/**
 * Reads cached issue details for one check. The details payload has no
 * `displayName` -- this is the one place the project's displayName rule
 * bends, and `name` is read into it instead.
 */
export async function readDetails(
    fetcher: Fetcher,
    name: string
): Promise<CheckIssue[]> {
    const body = await fetchJson<Record<string, DetailCheckRow>>(
        fetcher,
        `dataIntegrity/details?checks=${name}&timeout=0`
    )
    const rows = body[name]?.issues ?? []
    return rows.map((row) => ({
        id: row.id,
        displayName: row.name,
        detail: row.refs ? row.refs.join(' ') : (row.comment ?? null),
    }))
}

/**
 * Starts a run of the given checks and returns once the job is accepted --
 * it never reads the job id, because the app polls the summary endpoint,
 * not the job, to learn when the run has finished (finding 2).
 */
export async function startRun(
    fetcher: Fetcher,
    names: string[],
    kind: 'summary' | 'details'
): Promise<void> {
    const response = await fetcher(
        `dataIntegrity/${kind}?checks=${names.join(',')}`,
        { method: 'POST' }
    )
    if (!response.ok) {
        throw new Error(
            `Failed to start dataIntegrity/${kind}: HTTP ${response.status}`
        )
    }
}
