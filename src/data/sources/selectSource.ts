import type { DataSource, Fetcher } from './DataSource'
import { fetchJson } from './DataSource'
import { createMetadataSource } from './metadataSource'
import type { SqlViewIds } from './sqlViewSource'
import {
    createSqlViewSource,
    SQL_VIEW_CODES,
    sqlViewLookupPath,
    USABLE_SQL_VIEW_TYPES,
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
 * someone executed it, with nothing in the response to say how old they
 * are, so reading the org unit hierarchy or group memberships from one
 * would mean confident counts from arbitrarily old data -- worse than being
 * slow. Executing it first was the alternative, but that needs the SQL view
 * execute authority (which a plain reader does not have) and can cost the
 * server a full refresh on every app start, so the app declines the view
 * and falls back to the metadata API, which is always current. The list
 * itself lives in `sqlViewSource` (M4), shared with Settings' own status
 * and repair screen.
 *
 * The names view is the one exception to "all or nothing". The hierarchy
 * and the membership views are what make this path worth having -- they
 * are the large reads, and neither carries anything a locale could change.
 * Names do: the view returns the raw `name` column while the metadata API
 * returns `displayName` resolved against the caller's locale, so design
 * spec §8a makes removing `GSI_ORGUNIT_NAMES` the supported way to get
 * translated names back. Until 2026-09-17 that remedy did not work -- this
 * function required all three views, so removing one sent the hierarchy
 * and the memberships to the metadata API as well, which the Plan 10
 * multi-version review measured on all four supported versions
 * (docs/developer/dhis2-behavior.md, check 27). A missing names
 * view now leaves the other two serving and reports names as coming from
 * the metadata API, which the dashboard says out loud.
 */

export async function findSqlViews(
    fetcher: Fetcher
): Promise<SqlViewIds | null> {
    const codes = Object.values(SQL_VIEW_CODES)
    const body = await fetchJson<{ sqlViews: SqlViewRow[] }>(
        fetcher,
        sqlViewLookupPath(codes)
    )
    const byCode = new Map(body.sqlViews.map((v) => [v.code, v]))
    const pick = (code: string) => {
        const v = byCode.get(code)
        if (
            !v ||
            !v.access.data?.read ||
            v.type === undefined ||
            !USABLE_SQL_VIEW_TYPES.includes(v.type)
        ) {
            return null
        }
        return v.id
    }
    const orgUnits = pick(SQL_VIEW_CODES.orgUnits)
    const orgUnitNames = pick(SQL_VIEW_CODES.orgUnitNames)
    const orgUnitMemberships = pick(SQL_VIEW_CODES.orgUnitMemberships)
    if (orgUnits && orgUnitMemberships) {
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
