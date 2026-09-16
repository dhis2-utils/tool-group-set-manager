import { parseCsv } from '../csv'
import { DataSource, Fetcher, Progress } from './DataSource'
import { createMetadataSource } from './metadataSource'
import { MembershipsPayload, ObjectsPayload } from '@/engine/protocol'
import { ObjectType } from '@/engine/types'

export interface SqlViewIds {
    orgUnits: string
    orgUnitNames: string
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
 */
export function sqlViewLookupPath(codes: readonly string[]): string {
    return `sqlViews?fields=id,code,type,access[data[read]]&filter=code:in:[${codes.join(',')}]&paging=false`
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
 * docs/superpowers/notes/2026-09-plan7-e2e-write-flows.md -- it is what
 * three e2e write/revert flows had been failing on.
 *
 * Pinning this here only covers views *this* version creates. `fetchCsv`
 * below carries the other half, for views an earlier build already made.
 */
export const SQL_VIEW_DEFINITIONS = [
    {
        code: SQL_VIEW_CODES.orgUnits,
        type: 'VIEW',
        cacheStrategy: 'NO_CACHE',
        name: 'GSI org unit hierarchy',
        sqlQuery:
            'select ou.uid, ou.hierarchylevel as level, p.uid as parent from organisationunit ou left join organisationunit p on p.organisationunitid = ou.parentid',
    },
    {
        code: SQL_VIEW_CODES.orgUnitNames,
        type: 'VIEW',
        cacheStrategy: 'NO_CACHE',
        name: 'GSI org unit names',
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
async function fetchCsv(fetcher: Fetcher, viewId: string): Promise<string[][]> {
    const response = await fetcher(`sqlViews/${viewId}/data.csv?paging=false`, {
        cache: 'no-store',
    })
    if (!response.ok) {
        throw new Error(
            `SQL view ${viewId} failed with HTTP ${response.status}`
        )
    }
    const rows = parseCsv(await response.text())
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
        const rows = await fetchCsv(fetcher, views.orgUnits)
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
        if (type !== 'organisationUnit') {
            return metadata.loadNames(type)
        }
        const rows = await fetchCsv(fetcher, views.orgUnitNames)
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
        const rows = await fetchCsv(fetcher, views.orgUnitMemberships)
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

    return { kind: 'sqlView', loadObjects, loadNames, loadMemberships }
}
