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
    access: { data?: { read?: boolean } }
}

export async function findSqlViews(
    fetcher: Fetcher
): Promise<SqlViewIds | null> {
    const codes = Object.values(SQL_VIEW_CODES)
    const body = await fetchJson<{ sqlViews: SqlViewRow[] }>(
        fetcher,
        `sqlViews?fields=id,code,access[data[read]]&filter=code:in:[${codes.join(',')}]&paging=false`
    )
    const byCode = new Map(body.sqlViews.map((v) => [v.code, v]))
    const pick = (code: string) => {
        const v = byCode.get(code)
        return v && v.access.data?.read ? v.id : null
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
