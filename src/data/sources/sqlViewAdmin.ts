import type { Fetcher } from './DataSource'
import { fetchJson } from './DataSource'
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
    sharingMatches,
    typeUsable,
} from './sqlViewSharing'
import type { SqlViewDefinition } from './sqlViewSource'
import { SQL_VIEW_DEFINITIONS, sqlViewLookupPath } from './sqlViewSource'

/**
 * - `missing`: no view with this code exists, or the current user cannot
 *   see it.
 * - `needsRepair`: it exists, but its type, query or sharing is not the
 *   app's, or the current user can read it and a real read just failed.
 * - `notSharedWithYou`: type, query and sharing are right, but the current
 *   user may not read the rows (group sharing, and they are not in the
 *   group). The app reads through the metadata API for them; the view may
 *   well be fine for everyone in the group.
 * - `usable`: everything checks out and a real read just succeeded.
 */
export type SqlViewStatus =
    | 'missing'
    | 'needsRepair'
    | 'notSharedWithYou'
    | 'usable'

export interface SqlViewCheck {
    code: string
    name: string
    /** null when no view with this code exists (or is visible) yet */
    id: string | null
    type: string | undefined
    status: SqlViewStatus
    /** `status === 'usable'`, kept as a flag for the many readers that only ask that */
    usable: boolean
    /** the server's row, for repair to compare against; null when missing */
    view: AdminSqlViewRow | null
}

/**
 * C1: metadata alone cannot tell an executed view from an orphaned one that
 * was created but never successfully executed, so "usable" also needs a
 * real read. `pageSize=1` keeps this cheap however large the view is: this
 * runs on every Settings page load.
 */
async function probeReadable(fetcher: Fetcher, id: string): Promise<boolean> {
    try {
        const response = await fetcher(`sqlViews/${id}/data.csv?pageSize=1`)
        return response.ok
    } catch {
        return false
    }
}

/**
 * Judges a view on its own type, query and sharing, then reads it when the
 * current user may. Shared with the usage view's check.
 */
export async function viewStatus(
    fetcher: Fetcher,
    view: AdminSqlViewRow | undefined,
    target: RepairTarget
): Promise<SqlViewStatus> {
    if (!view) {
        return 'missing'
    }
    const definitionOk =
        typeUsable(view.type) && target.acceptQuery(view.sqlQuery)
    if (!definitionOk || !sharingMatches(target.sharing, view.sharing)) {
        return 'needsRepair'
    }
    if (!view.access.data?.read) {
        return 'notSharedWithYou'
    }
    return (await probeReadable(fetcher, view.id)) ? 'usable' : 'needsRepair'
}

/**
 * The current server-side status of the three GSI SQL views, one entry per
 * definition whether it exists or not. Only reads: never a create, patch or
 * execute, so it is safe to call just to render the Settings page.
 */
export async function checkSqlViews(
    fetcher: Fetcher,
    sharing: SqlViewSharing
): Promise<SqlViewCheck[]> {
    const codes = SQL_VIEW_DEFINITIONS.map((d) => d.code)
    const body = await fetchJson<{ sqlViews: AdminSqlViewRow[] }>(
        fetcher,
        sqlViewLookupPath(codes)
    )
    const byCode = new Map(body.sqlViews.map((v) => [v.code, v]))
    return Promise.all(
        SQL_VIEW_DEFINITIONS.map(async (def) => {
            const view = byCode.get(def.code)
            const status = await viewStatus(
                fetcher,
                view,
                repairTarget(def, sharing)
            )
            return {
                code: def.code,
                name: def.name,
                id: view?.id ?? null,
                type: view?.type,
                status,
                usable: status === 'usable',
                view: view ?? null,
            }
        })
    )
}

export interface SqlViewAuthorities {
    /** `F_SQLVIEW_PUBLIC_ADD`: create (and so repair) the views */
    create: boolean
    /** `F_SQLVIEW_DELETE`: remove the usage view */
    remove: boolean
}

/**
 * D5: whether this user can create and delete SQL views, from their actual
 * authorities. `F_SQLVIEW_PUBLIC_ADD` and `F_SQLVIEW_DELETE` are the
 * authorities the server's own sqlView schema names for `CREATE_PUBLIC`
 * and `DELETE`. Returns null, not false, when the check itself cannot be
 * answered (a network error), so a caller can tell "known no" from
 * "unknown".
 */
export async function sqlViewAuthorities(
    fetcher: Fetcher
): Promise<SqlViewAuthorities | null> {
    try {
        const me = await fetchJson<{ authorities: string[] }>(
            fetcher,
            'me?fields=authorities'
        )
        const has = (authority: string) =>
            me.authorities.includes('ALL') || me.authorities.includes(authority)
        return {
            create: has('F_SQLVIEW_PUBLIC_ADD'),
            remove: has('F_SQLVIEW_DELETE'),
        }
    } catch {
        return null
    }
}

export interface SqlViewFailure {
    code: string
    reason: SqlViewFailureReason
    message: string
}

export interface CreateOrRepairResult {
    /** codes of views that did not exist and were created and executed */
    created: string[]
    /** codes of views that already existed and were patched or re-executed */
    repaired: string[]
    failed: SqlViewFailure[]
}

async function createView(
    fetcher: Fetcher,
    def: SqlViewDefinition,
    sharing: SqlViewSharing
): Promise<string> {
    const response = await fetcher('sqlViews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: def.name,
            code: def.code,
            type: def.type,
            // Pinned, never left to the server's default: see
            // SQL_VIEW_DEFINITIONS' own doc comment. Unset, DHIS2 applies
            // RESPECT_SYSTEM_SETTING and the instance's keyCacheStrategy
            // decides how long a browser may serve this view's data without
            // asking again -- a fortnight on a stock install.
            cacheStrategy: def.cacheStrategy,
            sqlQuery: def.sqlQuery,
            // Data read, not just metadata read, for everyone or for the
            // chosen user group: see `SqlViewSharing`.
            sharing: sharingBody(sharing),
        }),
    })
    if (!response.ok) {
        throw await createError(
            response,
            `Failed to create ${def.code}: HTTP ${response.status}`
        )
    }
    const body = (await response.json()) as { response: { uid: string } }
    return body.response.uid
}

/**
 * Best-effort: the view was just created by this same call and its execute
 * failed, so there is nothing left to preserve.
 */
async function deleteView(fetcher: Fetcher, id: string): Promise<void> {
    await fetcher(`sqlViews/${id}`, { method: 'DELETE' })
}

/** What an existing GSI view is repaired back to. */
export function repairTarget(
    def: SqlViewDefinition,
    sharing: SqlViewSharing
): RepairTarget {
    return {
        type: def.type,
        sqlQuery: def.sqlQuery,
        acceptQuery: (sql) => sameSql(sql, def.sqlQuery),
        sharing,
    }
}

/**
 * Creates every missing view and repairs every existing one that needs it.
 * D2: creating is two calls -- create, then execute -- and a create whose
 * execute then fails is deleted again and reported as a failure, never as
 * a partial "created".
 *
 * Repair patches an existing view's type, query and sharing back to the
 * definition and the administrator's sharing choice where they differ, then
 * executes it. It used to only re-execute, so a view switched to
 * MATERIALIZED_VIEW was reported "Repaired" and stayed unusable. An
 * existing view is never deleted: it may be someone else's. When it cannot
 * be set back, the failure says why (`SqlViewFailureReason`) so Settings
 * can tell the administrator what to do.
 */
export async function createOrRepairSqlViews(
    fetcher: Fetcher,
    checks: SqlViewCheck[],
    sharing: SqlViewSharing
): Promise<CreateOrRepairResult> {
    const created: string[] = []
    const repaired: string[] = []
    const failed: SqlViewFailure[] = []

    /* oxlint-disable no-await-in-loop -- one view at a time: a view that fails to execute is deleted before the next is created */
    for (const check of checks) {
        const def = SQL_VIEW_DEFINITIONS.find((d) => d.code === check.code)
        if (!def || check.status === 'usable') {
            continue
        }
        // Right definition and sharing, and only this user cannot read it:
        // there is nothing to repair, and nothing this user could verify.
        if (check.status === 'notSharedWithYou') {
            continue
        }
        try {
            if (check.view) {
                await repairExistingView(
                    fetcher,
                    check.view,
                    repairTarget(def, sharing)
                )
                repaired.push(check.code)
            } else {
                const id = await createView(fetcher, def, sharing)
                try {
                    await executeView(fetcher, id)
                } catch (executeError) {
                    await deleteView(fetcher, id).catch(() => undefined)
                    throw executeError
                }
                created.push(check.code)
            }
        } catch (e) {
            failed.push({
                code: check.code,
                reason: failureReason(e),
                message: failureMessage(e),
            })
        }
    }
    /* oxlint-enable no-await-in-loop */

    return { created, repaired, failed }
}
