import { fetchJson, Fetcher } from './DataSource'
import { sqlViewLookupPath, USABLE_SQL_VIEW_TYPES } from './sqlViewSource'
import {
    USAGE_SQL_CANDIDATES,
    USAGE_SQL_VIEW_CODE,
    USAGE_SQL_VIEW_NAME,
    UsageSqlCandidate,
} from './usageSqlView'

interface SqlViewRow {
    id: string
    code?: string
    type?: string
    access: { data?: { read?: boolean } }
}

export interface UsageViewCheck {
    id: string | null
    type: string | undefined
    readable: boolean
    /** exists, is a VIEW/QUERY, and a real read of its data just succeeded */
    usable: boolean
}

/** Cheap regardless of how many group sets the instance has. */
const probePath = (id: string) => `sqlViews/${id}/data.json?pageSize=1`

async function probeReadable(fetcher: Fetcher, id: string): Promise<boolean> {
    try {
        const response = await fetcher(probePath(id))
        return response.ok
    } catch {
        return false
    }
}

/**
 * Same bar as `checkSqlViews` applies to the three GSI_* views, and for the
 * same reason (C1 there): metadata alone cannot tell an executed view from
 * one that was created and never successfully executed, so "usable" has to
 * mean "was just read", not "looks right on paper".
 */
export async function checkUsageView(
    fetcher: Fetcher
): Promise<UsageViewCheck> {
    const body = await fetchJson<{ sqlViews: SqlViewRow[] }>(
        fetcher,
        sqlViewLookupPath([USAGE_SQL_VIEW_CODE])
    )
    const view = body.sqlViews.find((v) => v.code === USAGE_SQL_VIEW_CODE)
    const readable = Boolean(view?.access.data?.read)
    const metadataUsable = Boolean(
        view &&
            readable &&
            view.type !== undefined &&
            USABLE_SQL_VIEW_TYPES.includes(view.type)
    )
    return {
        id: view?.id ?? null,
        type: view?.type,
        readable,
        usable:
            metadataUsable && view
                ? await probeReadable(fetcher, view.id)
                : false,
    }
}

export interface InstallUsageResult {
    installed: boolean
    /** which candidate body took; null when none did */
    variant: string | null
    id: string | null
    failures: { variant: string; message: string }[]
}

async function createView(
    fetcher: Fetcher,
    candidate: UsageSqlCandidate
): Promise<string> {
    const response = await fetcher('sqlViews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: USAGE_SQL_VIEW_NAME,
            code: USAGE_SQL_VIEW_CODE,
            // Never MATERIALIZED_VIEW: it would serve arbitrarily old counts
            // with nothing in the response to say how old (spec 3.4).
            type: 'VIEW',
            // The same guarantee, one layer further out. Pinning `type`
            // stops the *database* serving stale counts; left unset,
            // `cacheStrategy` defaults to RESPECT_SYSTEM_SETTING and the
            // *browser* serves them instead, for as long as the instance's
            // `keyCacheStrategy` says -- a fortnight on a stock install,
            // with nothing in the response to say how old either. Same
            // omission, same consequence, as the GSI_* views had; see
            // docs/superpowers/notes/2026-09-plan7-e2e-write-flows.md.
            cacheStrategy: 'NO_CACHE',
            sqlQuery: candidate.sqlQuery,
            sharing: { public: 'r-------' },
        }),
    })
    if (!response.ok) {
        throw new Error(
            `Could not create the usage SQL view — HTTP ${response.status}`
        )
    }
    const body = (await response.json()) as { response: { uid: string } }
    return body.response.uid
}

async function executeView(fetcher: Fetcher, id: string): Promise<void> {
    const response = await fetcher(`sqlViews/${id}/execute`, { method: 'POST' })
    if (!response.ok) {
        throw new Error(
            `Could not execute the usage SQL view — HTTP ${response.status}`
        )
    }
}

async function readOrThrow(fetcher: Fetcher, id: string): Promise<void> {
    const response = await fetcher(probePath(id))
    if (!response.ok) {
        throw new Error(
            `The usage SQL view was created but cannot be read — HTTP ${response.status}`
        )
    }
}

/**
 * Spec 3.3: the candidates are tried in order until one both creates and
 * executes -- and here, also reads, for the same reason `checkUsageView`
 * probes: a body that creates and executes but 500s on read is not an
 * install. A candidate that fails at any of those three steps has the view
 * it just created deleted again, so the next candidate starts from a server
 * in the state it found -- and so a failed install never leaves an orphan
 * behind that a later `checkUsageView` would have to reason about.
 *
 * An **existing** view (one this call did not create) is never deleted, the
 * same rule `createOrRepairSqlViews` follows: re-executing it is the repair,
 * and deleting someone else's object on a failed repair would be a much
 * larger action than the one the button offers.
 */
export async function installUsageView(
    fetcher: Fetcher,
    check: UsageViewCheck,
    candidates: UsageSqlCandidate[] = USAGE_SQL_CANDIDATES
): Promise<InstallUsageResult> {
    const failures: { variant: string; message: string }[] = []

    if (check.id) {
        try {
            await executeView(fetcher, check.id)
            await readOrThrow(fetcher, check.id)
            return {
                installed: true,
                variant: null,
                id: check.id,
                failures,
            }
        } catch (e) {
            return {
                installed: false,
                variant: null,
                id: check.id,
                failures: [
                    {
                        variant: 'existing',
                        message: e instanceof Error ? e.message : String(e),
                    },
                ],
            }
        }
    }

    for (const candidate of candidates) {
        let id: string | null = null
        try {
            id = await createView(fetcher, candidate)
            await executeView(fetcher, id)
            await readOrThrow(fetcher, id)
            return { installed: true, variant: candidate.variant, id, failures }
        } catch (e) {
            if (id) {
                await fetcher(`sqlViews/${id}`, { method: 'DELETE' }).catch(
                    () => undefined
                )
            }
            failures.push({
                variant: candidate.variant,
                message: e instanceof Error ? e.message : String(e),
            })
        }
    }

    return { installed: false, variant: null, id: null, failures }
}

export async function removeUsageView(
    fetcher: Fetcher,
    id: string
): Promise<void> {
    const response = await fetcher(`sqlViews/${id}`, { method: 'DELETE' })
    if (!response.ok) {
        throw new Error(
            `Could not remove the usage SQL view — HTTP ${response.status}`
        )
    }
}
