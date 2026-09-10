import { DataSource, fetchJson, Fetcher } from './DataSource'
import { createMetadataSource } from './metadataSource'
import {
    createSqlViewSource,
    SQL_VIEW_CODES,
    SqlViewIds,
} from './sqlViewSource'

interface SqlViewRow {
    id: string
    code?: string
    /** VIEW, MATERIALIZED_VIEW or QUERY */
    type?: string
    access: { data?: { read?: boolean } }
}

/**
 * The SQL view types this app will read. A MATERIALIZED_VIEW returns
 * whatever rows were written the last time someone executed it, with nothing
 * in the response to say how old they are, so reading the org unit hierarchy
 * or group memberships from one would mean confident counts from arbitrarily
 * old data -- worse than being slow. Executing it first was the alternative,
 * but that needs the SQL view execute authority (which a plain reader does
 * not have) and can cost the server a full refresh on every app start, so
 * the app declines the view and falls back to the metadata API, which is
 * always current.
 *
 * This is an allow list rather than a MATERIALIZED_VIEW deny list because a
 * response with no `type` at all (a trimmed or older payload) must not slip
 * a materialised view through: the whole point of the check is that stale
 * rows are invisible to the user, so an unknown type is unusable.
 */
const USABLE_TYPES = ['VIEW', 'QUERY']

export async function findSqlViews(
    fetcher: Fetcher
): Promise<SqlViewIds | null> {
    const codes = Object.values(SQL_VIEW_CODES)
    const body = await fetchJson<{ sqlViews: SqlViewRow[] }>(
        fetcher,
        `sqlViews?fields=id,code,type,access[data[read]]&filter=code:in:[${codes.join(',')}]&paging=false`
    )
    const byCode = new Map(body.sqlViews.map((v) => [v.code, v]))
    const pick = (code: string) => {
        const v = byCode.get(code)
        if (
            !v ||
            !v.access.data?.read ||
            v.type === undefined ||
            !USABLE_TYPES.includes(v.type)
        ) {
            return null
        }
        return v.id
    }
    const orgUnits = pick(SQL_VIEW_CODES.orgUnits)
    const orgUnitNames = pick(SQL_VIEW_CODES.orgUnitNames)
    const orgUnitMemberships = pick(SQL_VIEW_CODES.orgUnitMemberships)
    if (orgUnits && orgUnitNames && orgUnitMemberships) {
        return { orgUnits, orgUnitNames, orgUnitMemberships }
    }
    return null
}

export async function selectSource(
    fetcher: Fetcher
): Promise<{ source: DataSource; sqlViews: SqlViewIds | null }> {
    let sqlViews: SqlViewIds | null = null
    try {
        sqlViews = await findSqlViews(fetcher)
    } catch {
        sqlViews = null // a failing lookup must never block the metadata path
    }
    return sqlViews
        ? { source: createSqlViewSource(fetcher, sqlViews), sqlViews }
        : { source: createMetadataSource(fetcher), sqlViews: null }
}
