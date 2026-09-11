import { fetchJson, Fetcher } from './DataSource'
import { SQL_VIEW_DEFINITIONS } from './sqlViewSource'

/**
 * The SQL view types this app will read (see selectSource.ts, whose
 * `USABLE_TYPES` this must stay consistent with -- a status page that calls
 * a view "usable" but which `selectSource` would then refuse would be
 * actively misleading).
 */
const USABLE_TYPES = ['VIEW', 'QUERY']

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
 * The current server-side status of the three GSI SQL views, one entry per
 * definition regardless of whether it exists yet. Read-only: this never
 * creates or executes anything, so it is safe to call just to render the
 * Settings page.
 */
export async function checkSqlViews(fetcher: Fetcher): Promise<SqlViewCheck[]> {
    const codes = SQL_VIEW_DEFINITIONS.map((d) => d.code)
    const body = await fetchJson<{ sqlViews: SqlViewRow[] }>(
        fetcher,
        `sqlViews?fields=id,code,type,access[data[read]]&filter=code:in:[${codes.join(',')}]&paging=false`
    )
    const byCode = new Map(body.sqlViews.map((v) => [v.code, v]))
    return SQL_VIEW_DEFINITIONS.map((def) => {
        const v = byCode.get(def.code)
        const readable = Boolean(v?.access.data?.read)
        const usable = Boolean(
            v &&
            readable &&
            v.type !== undefined &&
            USABLE_TYPES.includes(v.type)
        )
        return {
            code: def.code,
            name: def.name,
            id: v?.id ?? null,
            type: v?.type,
            readable,
            usable,
        }
    })
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

export interface CreateOrRepairResult {
    /** codes of views that did not exist and were created and executed */
    created: string[]
    /** codes of views that already existed and were re-executed */
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
            sqlQuery: def.sqlQuery,
            // Public read sharing (brief): every user who can use this app
            // must be able to read the view's data, not just its creator.
            sharing: { public: 'r-------' },
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
 * Creates every missing view and repairs every existing-but-unusable one,
 * skipping anything already usable. D2: creating is two calls -- create,
 * then execute -- and a create whose execute then fails is reported as a
 * failure, never as a partial "created". D3: an existing view is never
 * deleted and recreated, only re-executed.
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
                await executeView(fetcher, id)
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
