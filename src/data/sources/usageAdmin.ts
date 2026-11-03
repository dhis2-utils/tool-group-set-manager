import type { Fetcher } from './DataSource'
import { fetchJson } from './DataSource'
import type { SqlViewStatus } from './sqlViewAdmin'
import { viewStatus } from './sqlViewAdmin'
import type {
    AdminSqlViewRow,
    RepairTarget,
    SqlViewFailureReason,
    SqlViewSharing,
} from './sqlViewSharing'
import {
    createError,
    executeView,
    failureMessage,
    failureReason,
    repairExistingView,
    sameSql,
    sharingBody,
    SqlViewActionError,
} from './sqlViewSharing'
import { sqlViewLookupPath } from './sqlViewSource'
import type { UsageSqlCandidate } from './usageSqlView'
import {
    USAGE_SQL_CANDIDATES,
    USAGE_SQL_VIEW_CODE,
    USAGE_SQL_VIEW_NAME,
} from './usageSqlView'

export interface UsageViewCheck {
    id: string | null
    /** see `SqlViewStatus` */
    status: SqlViewStatus
    /** `status === 'usable'` */
    usable: boolean
    /** the server's row, for repair; null when missing */
    view: AdminSqlViewRow | null
}

/** Never MATERIALIZED_VIEW: it would serve arbitrarily old counts (spec 3.4). */
const USAGE_VIEW_TYPE = 'VIEW'

/**
 * What an existing usage view is repaired back to. Any candidate body is
 * acceptable; one that matches none is set to the first.
 */
function usageTarget(
    sharing: SqlViewSharing,
    candidates: UsageSqlCandidate[] = USAGE_SQL_CANDIDATES
): RepairTarget {
    return {
        type: USAGE_VIEW_TYPE,
        sqlQuery: candidates[0]?.sqlQuery ?? '',
        acceptQuery: (sql) => candidates.some((c) => sameSql(sql, c.sqlQuery)),
        sharing,
    }
}

/**
 * Same bar as `checkSqlViews` applies to the three GSI_* views: type, query
 * and sharing judged on the view itself, and a real read when the current
 * user may read it.
 */
export async function checkUsageView(
    fetcher: Fetcher,
    sharing: SqlViewSharing
): Promise<UsageViewCheck> {
    const body = await fetchJson<{ sqlViews: AdminSqlViewRow[] }>(
        fetcher,
        sqlViewLookupPath([USAGE_SQL_VIEW_CODE])
    )
    const view = body.sqlViews.find((v) => v.code === USAGE_SQL_VIEW_CODE)
    const status = await viewStatus(fetcher, view, usageTarget(sharing))
    return {
        id: view?.id ?? null,
        status,
        usable: status === 'usable',
        view: view ?? null,
    }
}

export interface UsageInstallFailure {
    variant: string
    reason: SqlViewFailureReason
    message: string
}

export interface InstallUsageResult {
    installed: boolean
    /** which candidate body took; null when none did */
    variant: string | null
    failures: UsageInstallFailure[]
}

async function createView(
    fetcher: Fetcher,
    candidate: UsageSqlCandidate,
    sharing: SqlViewSharing
): Promise<string> {
    const response = await fetcher('sqlViews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: USAGE_SQL_VIEW_NAME,
            code: USAGE_SQL_VIEW_CODE,
            type: USAGE_VIEW_TYPE,
            // The same guarantee, one layer further out. Pinning `type`
            // stops the *database* serving stale counts; left unset,
            // `cacheStrategy` defaults to RESPECT_SYSTEM_SETTING and the
            // *browser* serves them instead, for as long as the instance's
            // `keyCacheStrategy` says -- a fortnight on a stock install,
            // with nothing in the response to say how old either. Same
            // omission, same consequence, as the GSI_* views had; see
            // docs/developer/dhis2-behavior.md.
            cacheStrategy: 'NO_CACHE',
            sqlQuery: candidate.sqlQuery,
            // Data read, not metadata read alone, for everyone or for the
            // chosen user group: see `SqlViewSharing`.
            sharing: sharingBody(sharing),
        }),
    })
    if (!response.ok) {
        throw await createError(
            response,
            `Could not create the usage SQL view — HTTP ${response.status}`
        )
    }
    const body = (await response.json()) as { response: { uid: string } }
    return body.response.uid
}

/** Cheap regardless of how many group sets the instance has. */
const probePath = (id: string) => `sqlViews/${id}/data.json?pageSize=1`

async function readOrThrow(fetcher: Fetcher, id: string): Promise<void> {
    const response = await fetcher(probePath(id))
    if (!response.ok) {
        // The server's own reason, when it gives one: a bare "HTTP 409"
        // said nothing about *why* a view that had just been created and
        // executed could not be read (manual review 2, where the answer
        // was sharing).
        const reason = await response
            .json()
            .then((body: { message?: unknown }) =>
                typeof body.message === 'string' ? body.message : null
            )
            .catch(() => null)
        throw new Error(
            `The usage SQL view was created but cannot be read — HTTP ${response.status}` +
                (reason ? ` (${reason})` : '')
        )
    }
}

/**
 * Whether this user can read the view's rows once installed: with group
 * sharing an administrator outside the group cannot, and a failed read then
 * says nothing about whether the install worked.
 */
async function canReadData(fetcher: Fetcher, id: string): Promise<boolean> {
    try {
        const view = await fetchJson<{
            access?: { data?: { read?: boolean } }
        }>(fetcher, `sqlViews/${id}?fields=access[data[read]]`)
        // Only a plain "no" skips the read: an answer missing the field
        // must not quietly skip the check that the install worked.
        return view.access?.data?.read !== false
    } catch {
        return true
    }
}

/**
 * Spec 3.3: the candidates are tried in order until one creates, executes
 * and (when this user may read it) reads. A candidate that fails at any step
 * has the view it just created deleted again, so the next candidate starts
 * from a server in the state it found.
 *
 * An **existing** view (one this call did not create) is never deleted, the
 * same rule `createOrRepairSqlViews` follows: its type, query and sharing
 * are patched back where they differ, then it is executed.
 */
export async function installUsageView(
    fetcher: Fetcher,
    check: UsageViewCheck,
    options: { sharing: SqlViewSharing; candidates?: UsageSqlCandidate[] }
): Promise<InstallUsageResult> {
    const { sharing, candidates = USAGE_SQL_CANDIDATES } = options
    const failures: UsageInstallFailure[] = []

    if (check.view) {
        try {
            await repairExistingView(
                fetcher,
                check.view,
                usageTarget(sharing, candidates)
            )
            if (await canReadData(fetcher, check.view.id)) {
                await readOrThrow(fetcher, check.view.id)
            }
            return { installed: true, variant: null, failures }
        } catch (e) {
            return {
                installed: false,
                variant: null,
                failures: [
                    {
                        variant: 'existing',
                        reason: failureReason(e),
                        message: failureMessage(e),
                    },
                ],
            }
        }
    }

    /* oxlint-disable no-await-in-loop -- candidates are tried in order and the first that works ends the loop */
    for (const candidate of candidates) {
        let id: string | null = null
        try {
            id = await createView(fetcher, candidate, sharing)
            await executeView(fetcher, id)
            if (await canReadData(fetcher, id)) {
                await readOrThrow(fetcher, id)
            }
            return { installed: true, variant: candidate.variant, failures }
        } catch (e) {
            if (id) {
                await fetcher(`sqlViews/${id}`, { method: 'DELETE' }).catch(
                    () => undefined
                )
            }
            failures.push({
                variant: candidate.variant,
                reason: failureReason(e),
                message: failureMessage(e),
            })
        }
    }
    /* oxlint-enable no-await-in-loop */

    return { installed: false, variant: null, failures }
}

/**
 * A 403 here almost always means another administrator owns the view; the
 * error carries that reason so Settings can say so.
 */
export async function removeUsageView(
    fetcher: Fetcher,
    id: string
): Promise<void> {
    const response = await fetcher(`sqlViews/${id}`, { method: 'DELETE' })
    if (!response.ok) {
        throw new SqlViewActionError(
            response.status === 403 ? 'forbidden' : 'other',
            `Could not remove the usage SQL view — HTTP ${response.status}`
        )
    }
}
