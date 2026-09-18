import { fetchJson, Fetcher } from './DataSource'
import {
    SQL_VIEW_DEFINITIONS,
    sqlViewLookupPath,
    USABLE_SQL_VIEW_TYPES,
} from './sqlViewSource'

interface SqlViewRow {
    id: string
    code?: string
    type?: string
    access: { data?: { read?: boolean } }
}

export interface SqlViewCheck {
    code: string
    name: string
    /** null when no view with this code exists on the server yet */
    id: string | null
    type: string | undefined
    readable: boolean
    /** exists, is a VIEW/QUERY, and is readable -- selectSource's own bar */
    usable: boolean
}

/**
 * C1: metadata alone (code, type, `access.data.read`) cannot tell an
 * executed view from an orphaned one that was created but never
 * successfully executed -- a failed create-then-execute (see
 * `createOrRepairSqlViews`) or a view someone else created by hand and
 * never ran look identical to a healthy one on every field this endpoint
 * returns. Only an actual read proves the database view exists, so
 * "usable" has to mean "was just read successfully", not "looks right on
 * paper" -- otherwise Settings reports an unreadable view as Usable, and
 * the repair button skips it forever because it already looks fine.
 *
 * `pageSize=1` (rather than `paging=false`, which the real read path in
 * `sqlViewSource.ts` uses) keeps this cheap regardless of how large the
 * underlying view's result set is -- this runs on every Settings page
 * load, for up to three views, and must never itself become the slow
 * metadata-API-scale request this whole feature exists to avoid.
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
 * The current server-side status of the three GSI SQL views, one entry per
 * definition regardless of whether it exists yet. Only reads: the one
 * additional call this makes beyond the metadata lookup is the read probe
 * above, never a create or an execute, so it is safe to call just to render
 * the Settings page.
 */
export async function checkSqlViews(fetcher: Fetcher): Promise<SqlViewCheck[]> {
    const codes = SQL_VIEW_DEFINITIONS.map((d) => d.code)
    const body = await fetchJson<{ sqlViews: SqlViewRow[] }>(
        fetcher,
        sqlViewLookupPath(codes)
    )
    const byCode = new Map(body.sqlViews.map((v) => [v.code, v]))
    return Promise.all(
        SQL_VIEW_DEFINITIONS.map(async (def) => {
            const v = byCode.get(def.code)
            const readable = Boolean(v?.access.data?.read)
            const metadataUsable = Boolean(
                v &&
                readable &&
                v.type !== undefined &&
                USABLE_SQL_VIEW_TYPES.includes(v.type)
            )
            // Only probe when the metadata bar already passes: a view with
            // the wrong code, type or sharing is already known unusable,
            // and there is nothing to gain from also reading its data.
            const usable =
                metadataUsable && v ? await probeReadable(fetcher, v.id) : false
            return {
                code: def.code,
                name: def.name,
                id: v?.id ?? null,
                type: v?.type,
                readable,
                usable,
            }
        })
    )
}

const CREATE_AUTHORITIES = ['ALL', 'F_SQLVIEW_PUBLIC_ADD']

/**
 * D5: whether this user can create SQL views, found out by checking their
 * actual authorities rather than assuming -- `F_SQLVIEW_PUBLIC_ADD` is the
 * authority the server's own sqlView schema names for `CREATE_PUBLIC`
 * (verified against a live 2.43 instance's `/api/schemas/sqlView.json`).
 * Returns null, not false, when the check itself cannot be answered (a
 * network error), so a caller can tell "known no" from "unknown" and avoid
 * asserting something it does not actually know.
 */
export async function canCreateSqlViews(
    fetcher: Fetcher
): Promise<boolean | null> {
    try {
        const me = await fetchJson<{ authorities: string[] }>(
            fetcher,
            'me?fields=authorities'
        )
        return me.authorities.some((a) => CREATE_AUTHORITIES.includes(a))
    } catch {
        return null
    }
}

/**
 * Metadata read *and* data read for every user. `r-------` -- what these
 * views were created with until manual review 2 -- is metadata read alone,
 * and reading a SQL view's rows needs the data-read bit: without it the
 * server answers every read with 409 E4312 ("Current user is not authorised
 * to read data from SQL view"), including for the administrator who
 * created the view a second earlier, unless that user happens to hold ALL.
 * The broker instances' users do, which is how it went unnoticed; the
 * administrator this surfaced for on implement.im (2.41.10) does not.
 */
export const SQL_VIEW_PUBLIC_SHARING = 'r-r-----'

/**
 * Grants the public sharing above on an existing view, as one JSON-patch
 * of `/sharing/public` -- never a whole-object PUT (which would need the
 * full view body) and never the `/api/sharing` endpoint (whose POST
 * replaces user and user-group accesses as well as the public string).
 */
export async function shareViewPublicly(
    fetcher: Fetcher,
    id: string
): Promise<void> {
    const response = await fetcher(`sqlViews/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json-patch+json' },
        body: JSON.stringify([
            {
                op: 'replace',
                path: '/sharing/public',
                value: SQL_VIEW_PUBLIC_SHARING,
            },
        ]),
    })
    if (!response.ok) {
        throw new Error(
            `Failed to share SQL view ${id}: HTTP ${response.status}`
        )
    }
}

export interface CreateOrRepairResult {
    /** codes of views that did not exist and were created and executed */
    created: string[]
    /** codes of views that already existed and were re-shared or re-executed */
    repaired: string[]
    failed: { code: string; message: string }[]
}

async function createView(
    fetcher: Fetcher,
    def: (typeof SQL_VIEW_DEFINITIONS)[number]
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
            // Public read sharing (brief): every user who can use this app
            // must be able to read the view's data, not just its creator --
            // which takes the data-read bit, see SQL_VIEW_PUBLIC_SHARING.
            sharing: { public: SQL_VIEW_PUBLIC_SHARING },
        }),
    })
    if (!response.ok) {
        throw new Error(`Failed to create ${def.code}: HTTP ${response.status}`)
    }
    const body = (await response.json()) as { response: { uid: string } }
    return body.response.uid
}

/**
 * D2: the database view does not exist until this call succeeds. D3: this
 * is also the whole of "repair" -- a second execute on an already-executed
 * view is a safe no-op server-side.
 */
async function executeView(fetcher: Fetcher, id: string): Promise<void> {
    const response = await fetcher(`sqlViews/${id}/execute`, {
        method: 'POST',
    })
    if (!response.ok) {
        throw new Error(
            `Failed to execute SQL view ${id}: HTTP ${response.status}`
        )
    }
}

/**
 * Best-effort: the view was just created by this same call and its execute
 * failed, so there is nothing left to preserve. If the delete itself also
 * fails there is nothing more this function can do about it -- the
 * original execute failure is still what gets reported to the caller, and
 * a later Settings load will find the orphan again (now correctly reported
 * as unusable by `checkSqlViews`'s read probe) rather than an app that
 * silently prefers it.
 */
async function deleteView(fetcher: Fetcher, id: string): Promise<void> {
    await fetcher(`sqlViews/${id}`, { method: 'DELETE' })
}

/**
 * Creates every missing view and repairs every existing-but-unusable one,
 * skipping anything already usable. D2: creating is two calls -- create,
 * then execute -- and a create whose execute then fails is reported as a
 * failure, never as a partial "created".
 *
 * C1: D2 held only at the level of this function's return value -- it
 * correctly reported a failed execute as `failed`, but the view it had just
 * created was left behind on the server, where `findSqlViews` and
 * `checkSqlViews`'s old metadata-only check would both have accepted it
 * (right code, right type, readable) and the app would switch to a source
 * that 500s on every read. Deleting the view when ONLY its own execute
 * fails closes that hole at the source rather than merely reporting it:
 * the server is left exactly as it was before this click, for a view this
 * call itself just created.
 *
 * D3 stands for everything else: an existing view (one this call did not
 * just create) is never deleted, whether its repair-execute succeeds or
 * fails -- deleting something this app did not create on a re-execute
 * failure would be a much larger, unrelated destructive action, not a
 * repair. Its unusable state after a failed repair is now also visible and
 * repair-again-able, thanks to `checkSqlViews`'s read probe.
 */
export async function createOrRepairSqlViews(
    fetcher: Fetcher,
    checks: SqlViewCheck[]
): Promise<CreateOrRepairResult> {
    const created: string[] = []
    const repaired: string[] = []
    const failed: { code: string; message: string }[] = []

    for (const check of checks) {
        if (check.usable) {
            continue
        }
        try {
            if (check.id) {
                // `readable` is `access.data.read` for the current user.
                // Re-executing a view they may not read changes nothing
                // about that, so "repair" first grants the sharing the
                // create path grants, then executes.
                if (!check.readable) {
                    await shareViewPublicly(fetcher, check.id)
                }
                await executeView(fetcher, check.id)
                repaired.push(check.code)
            } else {
                const def = SQL_VIEW_DEFINITIONS.find(
                    (d) => d.code === check.code
                )
                if (!def) {
                    continue
                }
                const id = await createView(fetcher, def)
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
                message: e instanceof Error ? e.message : String(e),
            })
        }
    }

    return { created, repaired, failed }
}
