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
 * A MATERIALIZED_VIEW returns whatever rows were written the last time
 * someone executed it, with nothing in the response to say how old they are.
 * Reading org unit hierarchy and group memberships from one would let the app
 * report confident counts from arbitrarily old data, which is worse than
 * being slow. Executing it first was the alternative, but that needs the SQL
 * view execute authority (which a plain reader does not have) and can cost
 * the server a full refresh on every app start, so the app declines the view
 * and falls back to the metadata API, which is always current.
 */
const MATERIALIZED = 'MATERIALIZED_VIEW'

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
        if (!v || !v.access.data?.read || v.type === MATERIALIZED) {
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
