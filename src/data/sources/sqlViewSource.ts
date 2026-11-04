import { parseCsv } from '../csv'
import type { DataSource, Fetcher, Progress } from './DataSource'
import { createMetadataSource } from './metadataSource'
import type { MembershipsPayload, ObjectsPayload } from '@/engine/protocol'
import type { ObjectType } from '@/engine/types'

export interface SqlViewIds {
    orgUnits: string
    /**
     * Null when the names view is absent, unreadable or materialised, which
     * an administrator may well have arranged on purpose: design spec §8a
     * makes removing `GSI_ORGUNIT_NAMES` the remedy for an instance whose
     * organisation unit names are translated, because the metadata API
     * resolves `displayName` against the caller's locale and a SQL view
     * reads the raw `name` column. The other two views keep serving, so
     * that remedy costs names alone rather than the whole fast path -- on a
     * 266k-unit instance the difference is roughly 4 seconds against the
     * 60-70 the metadata path takes.
     */
    orgUnitNames: string | null
    orgUnitMemberships: string
}

/**
 * M4: the SQL view types this app will read, declared once. Both the
 * reader's source selection (`selectSource`) and the Settings status/repair
 * screen (`sqlViewAdmin`) must agree on this: a status page that calls a
 * view "usable" -- or offers to repair it -- when the reader would then
 * refuse it is actively misleading, and a comment asking two copies to stay
 * in step is not a mechanism.
 *
 * It is an allow list rather than a `MATERIALIZED_VIEW` deny list because a
 * response with no `type` at all (a trimmed or older payload) must not slip
 * a materialised view through: the whole point of the check is that stale
 * rows are invisible to the user, so an unknown type is unusable.
 */
export const USABLE_SQL_VIEW_TYPES = ['VIEW', 'QUERY']

/**
 * The one lookup both readers of SQL view status use: `findSqlViews`, which
 * decides whether the app reads through the views at all, and
 * `checkSqlViews`, which tells the Settings page what exists. The two had
 * byte-identical copies of this string kept in step by a comment, which is
 * a poor way to keep two answers to the same question agreeing -- a field
 * dropped from one would have shown the user a view the loader refuses, or
 * the reverse.
 *
 * `sqlQuery` and `sharing` are for Settings, which compares them with the
 * definitions below and with the administrator's sharing choice before it
 * calls a view usable or repairs it.
 */
export function sqlViewLookupPath(codes: readonly string[]): string {
    return `sqlViews?fields=id,code,type,sqlQuery,sharing,access[data[read]]&filter=code:in:[${codes.join(',')}]&paging=false`
}

export const SQL_VIEW_CODES = {
    orgUnits: 'GSI_ORGUNITS',
    orgUnitNames: 'GSI_ORGUNIT_NAMES',
    orgUnitMemberships: 'GSI_ORGUNIT_MEMBERSHIPS',
} as const

/**
 * `type` is pinned on every definition: the app refuses to read a
 * MATERIALIZED_VIEW (see selectSource.ts -- it serves whatever was last
 * written, with no signal of its age), so the creation code a later plan
 * writes must not inherit whatever the server would default to.
 *
 * `cacheStrategy` is pinned for the same reason, one layer further out.
 * Left unset, DHIS2 applies `RESPECT_SYSTEM_SETTING`, which defers to the
 * instance's `keyCacheStrategy` -- `CACHE_TWO_WEEKS` on a stock install.
 * `/api/sqlViews/<id>/data` is then served with `Cache-Control:
 * max-age=1209600, public`, and `max-age` without `must-revalidate` means
 * the browser answers from its own cache without contacting the server at
 * all. The app would keep serving a fortnight-old membership set: a user's
 * own fix vanishes on the next load, and History offers them a Revert that
 * correctly reports "nothing to revert" against data that never moved.
 * Measured and proved in
 * docs/developer/dhis2-behavior.md -- it is what
 * three e2e write/revert flows had been failing on.
 *
 * Pinning this here only covers views *this* version creates. `fetchCsv`
 * below carries the other half, for views an earlier build already made.
 */
export interface SqlViewDefinition {
    code: string
    type: string
    cacheStrategy: string
    name: string
    /**
     * The header row the view must return, in this order: the reader takes
     * columns by position, so a view with the right code and a different
     * query (hand-edited, or made by someone else) is refused rather than
     * read with every unit landing in the wrong column.
     */
    columns: readonly string[]
    sqlQuery: string
}

export const SQL_VIEW_DEFINITIONS: readonly SqlViewDefinition[] = [
    {
        code: SQL_VIEW_CODES.orgUnits,
        type: 'VIEW',
        cacheStrategy: 'NO_CACHE',
        name: 'GSI org unit hierarchy',
        columns: ['uid', 'level', 'parent'],
        sqlQuery:
            'select ou.uid, ou.hierarchylevel as level, p.uid as parent from organisationunit ou left join organisationunit p on p.organisationunitid = ou.parentid',
    },
    {
        code: SQL_VIEW_CODES.orgUnitNames,
        type: 'VIEW',
        cacheStrategy: 'NO_CACHE',
        name: 'GSI org unit names',
        columns: ['uid', 'name'],
        // Returns the raw, untranslated `name` column by design: resolving a
        // caller's locale inside a SQL view is not practical, and this
        // divergence from the metadata source's `displayName` only affects
        // the label shown, never ids, counts or fixes. See design spec
        // section 8a.
        sqlQuery: 'select uid, name from organisationunit',
    },
    {
        code: SQL_VIEW_CODES.orgUnitMemberships,
        type: 'VIEW',
        cacheStrategy: 'NO_CACHE',
        name: 'GSI org unit group memberships',
        columns: ['groupid', 'ouid'],
        sqlQuery:
            'select g.uid as groupid, ou.uid as ouid from orgunitgroupmembers m join orgunitgroup g on g.orgunitgroupid = m.orgunitgroupid join organisationunit ou on ou.organisationunitid = m.organisationunitid where g.orgunitgroupid in (select orgunitgroupid from orgunitgroupsetmembers)',
    },
]

/**
 * Level 0 is impossible in DHIS2 (the root organisation unit sits at level
 * 1), so a level column `Uint8Array.from` cannot make sense of must never
 * be allowed to coerce to 0 through it: `Number('')` is 0, `Number('bad')`
 * is `NaN`, and a typed array truncates `NaN` to 0 on assignment -- either
 * way the malformed row would land as a real, if wrong, level rather than
 * as the parse failure it is. Parsed and validated as plain numbers first,
 * naming the offending row before anything is written into the typed
 * array. `rows` here has already had the header row and any wholly blank
 * lines dropped by `fetchCsv`, so a data row at array index `i` is CSV line
 * `i + 2`: one for the header line, one because the message should count
 * the way a spreadsheet or the SQL view's own CSV export would (from 1,
 * not 0).
 */
function parseLevels(rows: string[][]): Uint8Array {
    const levels = rows.map((r, i) => {
        const n = Number(r[1])
        if (!Number.isInteger(n) || n < 1 || n > 255) {
            throw new Error(
                `Org unit hierarchy view: row ${i + 2} has an invalid level (${JSON.stringify(r[1])})`
            )
        }
        return n
    })
    return Uint8Array.from(levels)
}

/**
 * `cache: 'no-store'` is the half of the caching fix that `cacheStrategy`
 * on the definitions above cannot cover. That pin only applies to views
 * this version creates; an installation whose `GSI_*` views were made by an
 * earlier build still advertises `Cache-Control: max-age=1209600, public`,
 * and an administrator may edit a view's `cacheStrategy` at any time
 * afterwards. Since the whole point of this source is to show the user the
 * server's current state -- including the write they just made -- the app
 * must not depend on a server object it does not re-check to get its own
 * writes back. `no-store` bypasses the browser HTTP cache whatever the view
 * says, at the cost of one real request per load, which is what this source
 * was always meant to be doing.
 */
const columnsOf = (code: string): readonly string[] =>
    SQL_VIEW_DEFINITIONS.find((d) => d.code === code)?.columns ?? []

/**
 * Throws when the header row is not the definition's: `withSourceFallback`
 * in loadAll then switches the load to the metadata API, which is slower
 * but right, instead of reading a hand-edited view's columns as ours.
 */
function checkHeader(
    header: string[] | undefined,
    columns: readonly string[]
): void {
    const actual = (header ?? []).map((h) => h.trim().toLowerCase())
    if (
        actual.length !== columns.length ||
        columns.some((c, i) => actual[i] !== c)
    ) {
        throw new Error(
            `SQL view returned columns ${JSON.stringify(header ?? [])}, expected ${JSON.stringify(columns)}`
        )
    }
}

async function fetchCsv(
    fetcher: Fetcher,
    viewId: string,
    columns: readonly string[]
): Promise<string[][]> {
    const response = await fetcher(`sqlViews/${viewId}/data.csv?paging=false`, {
        cache: 'no-store',
    })
    if (!response.ok) {
        throw new Error(
            `SQL view ${viewId} failed with HTTP ${response.status}`
        )
    }
    const rows = parseCsv(await response.text())
    checkHeader(rows[0], columns)
    return (
        rows
            .slice(1) // drop header
            // A body ending in a blank line parses to a trailing row of one
            // empty field -- a real data row never has an empty first
            // column (every view's first column is an id) -- so this is a
            // phantom, not data to validate or load.
            .filter((r) => !(r.length === 1 && r[0] === ''))
    )
}

export function createSqlViewSource(
    fetcher: Fetcher,
    views: SqlViewIds
): DataSource {
    const metadata = createMetadataSource(fetcher)

    const loadObjects = async (
        type: ObjectType,
        onProgress: (p: Progress) => void
    ): Promise<ObjectsPayload> => {
        if (type !== 'organisationUnit') {
            return metadata.loadObjects(type, onProgress)
        }
        onProgress({ label: 'organisationUnits', done: 0, total: 1 })
        const rows = await fetchCsv(
            fetcher,
            views.orgUnits,
            columnsOf(SQL_VIEW_CODES.orgUnits)
        )
        const payload: ObjectsPayload = {
            objectType: type,
            ids: rows.map((r) => r[0]),
            names: null,
            level: parseLevels(rows),
            parentIds: rows.map((r) => (r[2] === '' ? null : r[2])),
            domainType: null,
            categoryIdsOfOption: null,
        }
        onProgress({ label: 'organisationUnits', done: 1, total: 1 })
        return payload
    }

    const loadNames = async (type: ObjectType) => {
        // `views.orgUnitNames === null` is the §8a remedy in force, not a
        // broken install: names come from the metadata API (translated),
        // everything else still comes from the views (fast).
        if (type !== 'organisationUnit' || views.orgUnitNames === null) {
            return metadata.loadNames(type)
        }
        const rows = await fetchCsv(
            fetcher,
            views.orgUnitNames,
            columnsOf(SQL_VIEW_CODES.orgUnitNames)
        )
        return rows.map((r) => ({ id: r[0], displayName: r[1] }))
    }

    const loadMemberships = async (
        type: ObjectType,
        groupIds: string[],
        onProgress: (p: Progress) => void
    ): Promise<MembershipsPayload> => {
        if (type !== 'organisationUnit') {
            return metadata.loadMemberships(type, groupIds, onProgress)
        }
        onProgress({ label: 'organisationUnitGroups', done: 0, total: 1 })
        const rows = await fetchCsv(
            fetcher,
            views.orgUnitMemberships,
            columnsOf(SQL_VIEW_CODES.orgUnitMemberships)
        )
        const byGroup = new Map<string, string[]>(groupIds.map((g) => [g, []]))
        rows.forEach((r) => byGroup.get(r[0])?.push(r[1]))
        onProgress({ label: 'organisationUnitGroups', done: 1, total: 1 })
        return {
            objectType: type,
            groups: groupIds.map((groupId) => ({
                groupId,
                memberIds: byGroup.get(groupId) ?? [],
            })),
        }
    }

    return {
        kind: 'sqlView',
        nameSource: views.orgUnitNames === null ? 'metadata' : 'sqlView',
        loadObjects,
        loadNames,
        loadMemberships,
    }
}
