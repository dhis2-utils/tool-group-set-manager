import { ObjectType } from '@/engine/types'

export const USAGE_SQL_VIEW_CODE = 'GSI_GROUPSET_USAGE'
export const USAGE_SQL_VIEW_NAME = 'GSI group set usage'

export type UsageGroupSetType =
    | 'orgUnitGroupSet'
    | 'dataElementGroupSet'
    | 'categoryOptionGroupSet'

/**
 * The three kinds of saved analytics object that can carry a group set as a
 * dimension. `eventVisualization` covers event reports, event charts and
 * line lists: `eventchart` and `eventreport` are legacy projections of the
 * same rows (measured on 2.40.12, 2.41.10, 2.42.6 and 2.43.1 -- every one of
 * their uids is present in `eventvisualization`, and their bridge rows add
 * up to its own; `2026-09-plan6-usage-tables.md` §2 and §2b), so reading
 * them as well would double-count every event favourite.
 */
export type FavouriteType = 'visualization' | 'map' | 'eventVisualization'

const GROUP_SET_TYPES: UsageGroupSetType[] = [
    'orgUnitGroupSet',
    'dataElementGroupSet',
    'categoryOptionGroupSet',
]

const FAVOURITE_TYPES: FavouriteType[] = [
    'visualization',
    'map',
    'eventVisualization',
]

export interface UsageSqlCandidate {
    /** identifies which body took, for Settings to report */
    variant: string
    sqlQuery: string
}

/**
 * Spec 3.3: an ordered list, because table names move between versions.
 * Each body is tried in turn until one both creates and executes, and the
 * variant that took is reported in Settings. There is one entry because one
 * body was measured to work on 2.40, 2.41, 2.42 and 2.43 -- see
 * `docs/superpowers/notes/2026-09-plan6-usage-tables.md`. A variant is added
 * only when a live server actually rejects the one above it.
 *
 * On the body itself:
 * - `union` (not `union all`) is what deduplicates a favourite that carries
 *   the same group set in two dimension slots.
 * - the map branch joins `mapview -> mapmapviews -> map` because
 *   `datastatisticsevent.favoriteuid` records the map the user opened, never
 *   the mapview (measured: 0 of 74 MAP_VIEW rows join to `mapview.uid`).
 * - there is deliberately no data element group set branch for maps or event
 *   visualisations: no such bridge table exists on any supported version.
 * - `now() - interval '12 months'` is evaluated per query, so a database
 *   VIEW built from this body never serves a stale 12-month window. Fix
 *   round 2 (Important 4): this replaces an earlier `age(now(), timestamp)
 *   < interval '12 month'` condition, which cannot use an index on
 *   `timestamp` -- fine on the tens of rows every test instance has, not on
 *   a national instance's `datastatisticsevent`, which runs to millions of
 *   rows a year and is read on every dashboard load. `timestamp > now() -
 *   interval '12 months'` is sargable and returns the identical result (see
 *   `docs/superpowers/notes/2026-09-plan6-usage-tables.md`'s fix-round-2
 *   addendum).
 */
export const USAGE_SQL_CANDIDATES: UsageSqlCandidate[] = [
    {
        variant: 'eventvisualization',
        sqlQuery: `with refs as (
    select 'orgUnitGroupSet' as groupset_type, gs.uid as groupset_uid, 'visualization' as favourite_type, f.uid as favourite_uid
    from visualization_orgunitgroupsetdimensions b
    join orgunitgroupsetdimension d on d.orgunitgroupsetdimensionid = b.orgunitgroupsetdimensionid
    join orgunitgroupset gs on gs.orgunitgroupsetid = d.orgunitgroupsetid
    join visualization f on f.visualizationid = b.visualizationid
  union
    select 'orgUnitGroupSet', gs.uid, 'map', f.uid
    from mapview_orgunitgroupsetdimensions b
    join orgunitgroupsetdimension d on d.orgunitgroupsetdimensionid = b.orgunitgroupsetdimensionid
    join orgunitgroupset gs on gs.orgunitgroupsetid = d.orgunitgroupsetid
    join mapmapviews mm on mm.mapviewid = b.mapviewid
    join map f on f.mapid = mm.mapid
  union
    select 'orgUnitGroupSet', gs.uid, 'eventVisualization', f.uid
    from eventvisualization_orgunitgroupsetdimensions b
    join orgunitgroupsetdimension d on d.orgunitgroupsetdimensionid = b.orgunitgroupsetdimensionid
    join orgunitgroupset gs on gs.orgunitgroupsetid = d.orgunitgroupsetid
    join eventvisualization f on f.eventvisualizationid = b.eventvisualizationid
  union
    select 'dataElementGroupSet', gs.uid, 'visualization', f.uid
    from visualization_dataelementgroupsetdimensions b
    join dataelementgroupsetdimension d on d.dataelementgroupsetdimensionid = b.dataelementgroupsetdimensionid
    join dataelementgroupset gs on gs.dataelementgroupsetid = d.dataelementgroupsetid
    join visualization f on f.visualizationid = b.visualizationid
  union
    select 'categoryOptionGroupSet', gs.uid, 'visualization', f.uid
    from visualization_categoryoptiongroupsetdimensions b
    join categoryoptiongroupsetdimension d on d.categoryoptiongroupsetdimensionid = b.categoryoptiongroupsetdimensionid
    join categoryoptiongroupset gs on gs.categoryoptiongroupsetid = d.categoryoptiongroupsetid
    join visualization f on f.visualizationid = b.visualizationid
  union
    select 'categoryOptionGroupSet', gs.uid, 'map', f.uid
    from mapview_categoryoptiongroupsetdimensions b
    join categoryoptiongroupsetdimension d on d.categoryoptiongroupsetdimensionid = b.categoryoptiongroupsetdimensionid
    join categoryoptiongroupset gs on gs.categoryoptiongroupsetid = d.categoryoptiongroupsetid
    join mapmapviews mm on mm.mapviewid = b.mapviewid
    join map f on f.mapid = mm.mapid
  union
    select 'categoryOptionGroupSet', gs.uid, 'eventVisualization', f.uid
    from eventvisualization_categoryoptiongroupsetdimensions b
    join categoryoptiongroupsetdimension d on d.categoryoptiongroupsetdimensionid = b.categoryoptiongroupsetdimensionid
    join categoryoptiongroupset gs on gs.categoryoptiongroupsetid = d.categoryoptiongroupsetid
    join eventvisualization f on f.eventvisualizationid = b.eventvisualizationid
)
select r.groupset_uid,
       r.groupset_type,
       r.favourite_type,
       count(distinct r.favourite_uid) as favourites,
       count(e.eventid) as views_12m
from refs r
left join datastatisticsevent e
  on e.favoriteuid = r.favourite_uid
 and e.timestamp > now() - interval '12 months'
group by r.groupset_uid, r.groupset_type, r.favourite_type
order by r.groupset_uid, r.favourite_type`,
    },
]

export interface UsageRow {
    groupSetId: string
    groupSetType: UsageGroupSetType
    favouriteType: FavouriteType
    favourites: number
    views12m: number
}

export interface UsageListGrid {
    listGrid: { headers: { name: string }[]; rows: unknown[][] }
}

const REQUIRED_COLUMNS = [
    'groupset_uid',
    'groupset_type',
    'favourite_type',
    'favourites',
    'views_12m',
] as const

/**
 * Reads the result by header name rather than by column position, and
 * refuses anything it does not recognise instead of quietly dropping it.
 * The code `GSI_GROUPSET_USAGE` is just a string: a view someone else
 * created under it, or an older variant of this app's own, would otherwise
 * render as a page of confident zeros. A thrown error surfaces as the Usage
 * tab's error state, which tells the user to reinstall the view.
 */
export function parseUsageListGrid(body: UsageListGrid): UsageRow[] {
    const index = new Map(
        body.listGrid.headers.map((h, i) => [h.name, i] as const)
    )
    REQUIRED_COLUMNS.forEach((column) => {
        if (!index.has(column)) {
            throw new Error(
                `The group set usage SQL view is missing the ${column} column`
            )
        }
    })
    // The cast is safe only because every REQUIRED_COLUMNS entry is validated
    // present in `index` immediately above; `at` is never called with anything
    // else.
    const at = (row: unknown[], column: string) =>
        row[index.get(column) as number]
    return body.listGrid.rows.map((row) => {
        const groupSetType = String(at(row, 'groupset_type'))
        const favouriteType = String(at(row, 'favourite_type'))
        if (!GROUP_SET_TYPES.includes(groupSetType as UsageGroupSetType)) {
            throw new Error(
                `The group set usage SQL view returned an unknown group set type ${groupSetType}`
            )
        }
        if (!FAVOURITE_TYPES.includes(favouriteType as FavouriteType)) {
            throw new Error(
                `The group set usage SQL view returned an unknown favourite type ${favouriteType}`
            )
        }
        return {
            groupSetId: String(at(row, 'groupset_uid')),
            groupSetType: groupSetType as UsageGroupSetType,
            favouriteType: favouriteType as FavouriteType,
            favourites: Number(at(row, 'favourites')),
            views12m: Number(at(row, 'views_12m')),
        }
    })
}

export interface FavouriteTypeUsage {
    favouriteType: FavouriteType
    favourites: number
}

export interface SetUsage {
    favourites: number
    views12m: number
    /** largest first; only types with at least one favourite appear */
    byFavouriteType: FavouriteTypeUsage[]
}

/**
 * A favourite belongs to exactly one favourite type and appears at most once
 * per (group set, type) row, so summing the rows is a true total rather than
 * an over-count.
 */
export function usageByGroupSet(rows: UsageRow[]): Map<string, SetUsage> {
    const byId = new Map<string, SetUsage>()
    rows.forEach((row) => {
        const existing = byId.get(row.groupSetId) ?? {
            favourites: 0,
            views12m: 0,
            byFavouriteType: [],
        }
        existing.favourites += row.favourites
        existing.views12m += row.views12m
        existing.byFavouriteType.push({
            favouriteType: row.favouriteType,
            favourites: row.favourites,
        })
        byId.set(row.groupSetId, existing)
    })
    byId.forEach((usage) => {
        usage.byFavouriteType.sort((a, b) => b.favourites - a.favourites)
    })
    return byId
}

/**
 * The object types whose group sets can be analytics dimensions. Written
 * as an allow list, not "not indicator": `ObjectType` is a closed union
 * today, and a fifth member added later must fail here loudly rather than
 * silently count as having usage. Indicator group sets are excluded because
 * there is no `indicatorgroupsetdimension` table on any supported version
 * (measured on 2.43.1).
 */
const USAGE_OBJECT_TYPES: ReadonlyArray<ObjectType> = [
    'organisationUnit',
    'dataElement',
    'categoryOption',
]

export function usageApplies(objectType: ObjectType): boolean {
    return USAGE_OBJECT_TYPES.includes(objectType)
}
