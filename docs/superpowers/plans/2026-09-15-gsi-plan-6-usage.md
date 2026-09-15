# GSI Plan 6: Group Set Usage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a user deciding whether a group set is worth fixing — or safe to stop treating as a data dimension — a count of the saved analytics favourites that reference it and how often those were viewed, on the dashboard and on a Usage tab, always worded as indicative rather than proof.

**Architecture:** One new SQL view, `GSI_GROUPSET_USAGE`, returning one row per (group set, favourite type) that has at least one referencing favourite. It lives in its own definition list with its own install/remove path, deliberately **not** in `SQL_VIEW_DEFINITIONS`, so an absent or broken usage view never pushes `selectSource` into the metadata-API fallback for the whole app. A pure parser turns the view's `listGrid` into rows; a pure aggregator turns rows into per-set totals; a `useUsage` hook fetches once (TanStack Query dedupes it across the dashboard and the group set page) and every surface reads from it.

**Tech Stack:** TypeScript, React 18, @dhis2/ui 10.17.0, @dhis2/app-runtime, TanStack Query v4, Jest + @testing-library/react, Playwright for e2e, Vite via the DHIS2 App Platform, pnpm, PostgreSQL (the SQL view body).

**Spec:** `docs/superpowers/specs/2026-09-15-manual-review-1-design.md` — this plan implements §3 in full. §2, §4 and §7 landed in Plans 4 and 5; §5 and §6 (fixing, bulk write performance) are Plan 7. This plan amends §3.2 and §3.5 in two places, both recorded in Task 1 and Task 7 and both to be written back into the spec as part of those tasks.

## Global Constraints

- Supported DHIS2 versions: **2.40 and newer**.
- `src/engine` is pure TypeScript with typed arrays, runs in a Web Worker, imports nothing from React or DHIS2. **This plan adds nothing to `src/engine`** — usage is server-side data about metadata, not a computed property of the object population.
- Every user-facing string goes through a single, **argument-free** `i18n.t('…')` call. Any second argument makes the call invisible to this project's i18next-scanner, so it never reaches `i18n/en.pot`.
- **A sentence is translated whole.** Never join translated fragments around a value; put a `{name}` placeholder inside the one complete string and fill it with `interpolate()` from `src/utils/interpolate.ts`. Single braces, never `{{…}}`.
- **No colon inside an `i18n.t()` string** — the scanner reads it as a namespace separator and drops the key.
- Counts are two complete strings chosen on `count === 1`, with the number in a `{count}` placeholder.
- Data fetching goes through `useApiDataQuery` (TanStack Query v4), never `useDataQuery` directly. The one exception this plan keeps is the **admin** path (`src/data/sources/usageAdmin.ts`), which uses `createFetcher` exactly as `sqlViewAdmin.ts` already does — it issues POST/DELETE and reads a probe response's status code, none of which the data engine expresses.
- Jest maps every `.css` import to an empty object, so a component's own CSS-module class names are `undefined` in tests. To assert on one, add a **scoped** `jest.mock('./Thing.module.css', () => ({ … }))` in that test file (`src/components/SummaryMatrix/SummaryMatrix.test.tsx` is the pattern). Otherwise do not assert on module classes.
- Run `pnpm exec d2-app-scripts i18n extract` after adding or changing any string; commit `i18n/en.pot` and check the output for scanner warnings.
- Gates before every commit: `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm exec eslint src`.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` and **never** a `Claude-Session:` or session-URL trailer.
- Live instances are broker instances named `agent-*`. Keep **one running at a time** (two booting concurrently starve each other). Credentials `local_admin` / `district` — the Sierra Leone seed's own `admin` lacks `ALL` and cannot read SQL view data (measured in Plan 4).

---

## File Structure

| File | Responsibility after this plan |
| --- | --- |
| `src/data/sources/usageSqlView.ts` | **New.** The view's code, name, ordered candidate SQL bodies, row type, `parseUsageListGrid`, `usageByGroupSet`, `usageApplies`. Pure — no network, no React |
| `src/data/sources/usageAdmin.ts` | **New.** `checkUsageView`, `installUsageView` (try candidates in order), `removeUsageView`. Network only |
| `src/hooks/useUsage.ts` | **New.** Looks the view up by code, reads it, aggregates it; one `UsageState` for every surface |
| `src/utils/favouriteTypeLabels.ts` | **New.** The three favourite types' translated labels, in one place |
| `src/pages/Settings/Settings.tsx` | Gains a "Group set usage" section — status, install, which variant took, remove |
| `src/pages/GroupSetDetail/UsageTab.tsx` | **New.** The Usage tab |
| `src/pages/GroupSetDetail/GroupSetDetail.tsx` | Gains the Usage tab; seeds its initial tab from router state so a card can link straight to it |
| `src/components/GroupSetCard/GroupSetCard.tsx` | Gains the usage figure and the "Appears unused" tag |
| `src/pages/Dashboard/Dashboard.tsx` | The `Sort by` field's `Usage` option becomes real |
| `e2e/flows.spec.ts` | Gains an install → read → remove usage flow |
| `docs/superpowers/notes/2026-09-plan6-usage-tables.md` | **New.** The per-version table inventory and measurements behind the SQL |

**Dependency order:** Task 1 → Task 2 → Task 3; Task 1 → Task 4 → Tasks 5, 6, 7; Task 8 needs Tasks 3 and 5. Tasks 5, 6 and 7 are independent of each other.

---

### Task 1: The usage SQL view — verified table inventory, definition, parser, aggregator

**Files:**

- Create: `src/data/sources/usageSqlView.ts`, `src/data/sources/usageSqlView.test.ts`
- Create: `docs/superpowers/notes/2026-09-plan6-usage-tables.md`
- Modify: `docs/superpowers/specs/2026-09-15-manual-review-1-design.md` §3.2 (row shape) and §9

**Interfaces:**

- Consumes: nothing.
- Produces, for Tasks 2 and 4:
  - `USAGE_SQL_VIEW_CODE: 'GSI_GROUPSET_USAGE'`, `USAGE_SQL_VIEW_NAME: 'GSI group set usage'`
  - `type UsageGroupSetType = 'orgUnitGroupSet' | 'dataElementGroupSet' | 'categoryOptionGroupSet'`
  - `type FavouriteType = 'visualization' | 'map' | 'eventVisualization'`
  - `interface UsageSqlCandidate { variant: string; sqlQuery: string }` and `USAGE_SQL_CANDIDATES: UsageSqlCandidate[]`
  - `interface UsageRow { groupSetId: string; groupSetType: UsageGroupSetType; favouriteType: FavouriteType; favourites: number; views12m: number }`
  - `interface UsageListGrid { listGrid: { headers: { name: string }[]; rows: unknown[][] } }`
  - `parseUsageListGrid: (body: UsageListGrid) => UsageRow[]`
  - `interface FavouriteTypeUsage { favouriteType: FavouriteType; favourites: number; views12m: number }`
  - `interface SetUsage { favourites: number; views12m: number; byFavouriteType: FavouriteTypeUsage[] }`
  - `usageByGroupSet: (rows: UsageRow[]) => Map<string, SetUsage>`
  - `usageApplies: (objectType: ObjectType) => boolean`

**What is already measured, and what this task still has to measure.**

The 2.43 leg was done while this plan was written, against `agent-gsi-p2`
(DHIS2 **2.43.1**, Sierra Leone v43 seed), by querying its database directly
and then by creating, executing and reading the real SQL view through the
API. Everything below is a live measurement, not a reading of the DHIS2
source:

- The group-set dimension link tables are `orgunitgroupsetdimension`,
  `dataelementgroupsetdimension`, `categoryoptiongroupsetdimension`, each
  keyed by `<name>id` and carrying `<groupset>id`.
- Eleven bridge tables exist:
  `visualization_orgunitgroupsetdimensions`,
  `visualization_dataelementgroupsetdimensions`,
  `visualization_categoryoptiongroupsetdimensions`,
  `mapview_orgunitgroupsetdimensions`,
  `mapview_categoryoptiongroupsetdimensions`,
  `eventvisualization_orgunitgroupsetdimensions`,
  `eventvisualization_categoryoptiongroupsetdimensions`,
  `eventchart_orgunitgroupsetdimensions`,
  `eventchart_categoryoptiongroupsetdimensions`,
  `eventreport_orgunitgroupsetdimensions`,
  `eventreport_categoryoptiongroupsetdimensions`.
  **There is no `mapview_dataelementgroupsetdimensions` and no
  `eventvisualization_dataelementgroupsetdimensions`** — a data element group
  set can only be a dimension of a `visualization`. `indicatorgroupset` has no
  dimension table at all, which is the measured basis for spec §3.2's claim
  that indicator group sets never appear.
- `eventchart` (19 rows) and `eventreport` (31 rows) are legacy projections of
  the same rows as `eventvisualization` (50 rows): every one of the 19 and 31
  `uid`s is present in `eventvisualization`, and the bridge row counts add up
  the same way (4 + 1 = 5). **So the query reads `eventvisualization` only**;
  including the legacy tables as well would count each event favourite twice
  unless deduplicated, and buys nothing.
- `datastatisticsevent.favoriteuid` names the **favourite the user opened**,
  which for a map is the `map`, not the `mapview`: of 74 `MAP_VIEW` rows, 30
  join to `map.uid` and **0** join to `mapview.uid`. The
  `tool-category-dimension-disabler` app that spec §3.2 models this on joins
  to `mapview.uid` and therefore never matches a single view — that is a bug
  in the reference app, not a pattern to copy. `VISUALIZATION_VIEW` joins to
  `visualization.uid` (650 of 1513) and `EVENT_REPORT_VIEW` /
  `EVENT_CHART_VIEW` to `eventvisualization.uid` (187 of 451, 41 of 60).
  The map branch therefore goes `mapview → mapmapviews → map`.
- The view installs and reads: `POST /api/sqlViews` with `type: "VIEW"` →
  HTTP 201, `POST /api/sqlViews/<id>/execute` → HTTP 201,
  `GET /api/sqlViews/<id>/data.json?pageSize=5000` → the 12 expected rows with
  headers `groupset_uid, groupset_type, favourite_type, favourites,
  views_12m`. `pageSize` is honoured (`pageSize=3` returned exactly 3 rows),
  which is why the read below uses an explicit page size with a truncation
  guard rather than `paging=false` (the app runtime warns on `paging=false`).
- The Sierra Leone v43 seed's `datastatisticsevent` rows are old — the newest
  `VISUALIZATION_VIEW` is 2025-03-26 — so **`views_12m` is legitimately 0 for
  every set on this seed**. Re-running the same query with a 200-month window
  returns 89, 32, 25, 14, 12, 11, 6, 3 for the referenced sets, which is what
  proves the view-counting join works. Any later check of `views_12m` must
  use that widened-window control rather than reading 0 as a defect.

**Spec amendment made by this task.** §3.2 says the view returns "one row per
group set" with four columns, while §3.5 requires the Usage tab to break
favourites down by favourite type. Those cannot both be true of the same
result. The view therefore returns **one row per (group set, favourite type)
that has at least one referencing favourite**, with a `favourite_type` column;
a group set absent from the result has no referencing favourite, which is
exactly the "Appears unused" case. A cross join of every set against every
favourite type was rejected because it emits rows for combinations that cannot
exist — a data element group set on a map — and a reader cannot tell those from
a real zero. Write this into §3.2, together with the measured table inventory
above, and mark §9's second bullet accordingly.

**Why the candidate list has one entry to start.** Spec §3.3 requires an
**ordered list** of candidate bodies because table names move between
versions. This task ships the list with the one body proven on 2.43 and adds a
second entry only if a 2.40, 2.41 or 2.42 instance actually rejects it. Do not
invent a variant for a version you have not run.

- [ ] **Step 1: Write the failing tests for the parser and the aggregator**

Create `src/data/sources/usageSqlView.test.ts`:

```ts
import {
    parseUsageListGrid,
    USAGE_SQL_CANDIDATES,
    usageApplies,
    usageByGroupSet,
    UsageListGrid,
} from './usageSqlView'

const grid = (rows: unknown[][]): UsageListGrid => ({
    listGrid: {
        headers: [
            { name: 'groupset_uid' },
            { name: 'groupset_type' },
            { name: 'favourite_type' },
            { name: 'favourites' },
            { name: 'views_12m' },
        ],
        rows,
    },
})

describe('parseUsageListGrid', () => {
    it('reads columns by header name, not by position', () => {
        const reordered: UsageListGrid = {
            listGrid: {
                headers: [
                    { name: 'views_12m' },
                    { name: 'favourites' },
                    { name: 'favourite_type' },
                    { name: 'groupset_type' },
                    { name: 'groupset_uid' },
                ],
                rows: [[7, 3, 'map', 'orgUnitGroupSet', 'abc']],
            },
        }
        expect(parseUsageListGrid(reordered)).toEqual([
            {
                groupSetId: 'abc',
                groupSetType: 'orgUnitGroupSet',
                favouriteType: 'map',
                favourites: 3,
                views12m: 7,
            },
        ])
    })

    it('parses counts that arrive as strings', () => {
        // The listGrid types every column java.lang.String on 2.43.
        expect(
            parseUsageListGrid(
                grid([['abc', 'orgUnitGroupSet', 'visualization', '37', '89']])
            )[0]
        ).toMatchObject({ favourites: 37, views12m: 89 })
    })

    it('returns an empty array for a view with no rows', () => {
        expect(parseUsageListGrid(grid([]))).toEqual([])
    })

    it('rejects a result missing a column this app needs', () => {
        const missing: UsageListGrid = {
            listGrid: {
                headers: [{ name: 'groupset_uid' }, { name: 'favourites' }],
                rows: [['abc', 1]],
            },
        }
        expect(() => parseUsageListGrid(missing)).toThrow(/favourite_type/)
    })

    it('rejects an unrecognised favourite type rather than dropping the row', () => {
        expect(() =>
            parseUsageListGrid(
                grid([['abc', 'orgUnitGroupSet', 'dashboard', '1', '0']])
            )
        ).toThrow(/dashboard/)
    })

    it('rejects an unrecognised group set type', () => {
        expect(() =>
            parseUsageListGrid(
                grid([['abc', 'indicatorGroupSet', 'visualization', '1', '0']])
            )
        ).toThrow(/indicatorGroupSet/)
    })
})

describe('usageByGroupSet', () => {
    const rows = parseUsageListGrid(
        grid([
            ['a', 'orgUnitGroupSet', 'visualization', '37', '89'],
            ['a', 'orgUnitGroupSet', 'map', '1', '0'],
            ['a', 'orgUnitGroupSet', 'eventVisualization', '4', '11'],
            ['b', 'dataElementGroupSet', 'visualization', '8', '0'],
        ])
    )

    it('sums favourites and views across favourite types', () => {
        const byId = usageByGroupSet(rows)
        expect(byId.get('a')).toMatchObject({ favourites: 42, views12m: 100 })
        expect(byId.get('b')).toMatchObject({ favourites: 8, views12m: 0 })
    })

    it('orders the breakdown by favourites, largest first', () => {
        expect(
            usageByGroupSet(rows)
                .get('a')
                ?.byFavouriteType.map((f) => f.favouriteType)
        ).toEqual(['visualization', 'eventVisualization', 'map'])
    })

    it('has no entry for a group set no favourite references', () => {
        expect(usageByGroupSet(rows).has('c')).toBe(false)
    })
})

describe('usageApplies', () => {
    it('is false for indicators, which are not an analytics dimension', () => {
        expect(usageApplies('indicator')).toBe(false)
    })

    it('is true for the three types the view covers', () => {
        expect(usageApplies('organisationUnit')).toBe(true)
        expect(usageApplies('dataElement')).toBe(true)
        expect(usageApplies('categoryOption')).toBe(true)
    })
})

describe('USAGE_SQL_CANDIDATES', () => {
    it('has at least one candidate and every body is a bare select', () => {
        expect(USAGE_SQL_CANDIDATES.length).toBeGreaterThan(0)
        USAGE_SQL_CANDIDATES.forEach((c) => {
            // DHIS2 refuses a SQL view body containing a statement
            // separator; a trailing semicolon from a copy-paste out of psql
            // is the easy way to ship one by accident.
            expect(c.sqlQuery).not.toContain(';')
            expect(c.sqlQuery.trim().toLowerCase().startsWith('with')).toBe(
                true
            )
        })
    })

    it('gives every candidate a distinct variant name', () => {
        const names = USAGE_SQL_CANDIDATES.map((c) => c.variant)
        expect(new Set(names).size).toBe(names.length)
    })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- usageSqlView`
Expected: FAIL — `Cannot find module './usageSqlView'`.

- [ ] **Step 3: Write `usageSqlView.ts`**

Create `src/data/sources/usageSqlView.ts`. The SQL body below is the one
measured against 2.43.1 above — copy it exactly:

```ts
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
 * same rows (measured on 2.43.1 -- every one of their uids is present in
 * `eventvisualization`, and their bridge rows add up to its own), so reading
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
 * - `age(now(), timestamp)` is evaluated per query, so a database VIEW built
 *   from this body never serves a stale 12-month window.
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
 and age(now(), e.timestamp) < interval '12 month'
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
    const at = (row: unknown[], column: string) => row[index.get(column) as number]
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
    views12m: number
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
            views12m: row.views12m,
        })
        byId.set(row.groupSetId, existing)
    })
    byId.forEach((usage) => {
        usage.byFavouriteType.sort((a, b) => b.favourites - a.favourites)
    })
    return byId
}

/**
 * Indicator group sets are not analytics dimensions -- there is no
 * `indicatorgroupsetdimension` table on any supported version (measured on
 * 2.43.1) -- so they can never appear in the view's result. Surfaces ask
 * this rather than rendering a zero that reads as a finding.
 */
export function usageApplies(objectType: ObjectType): boolean {
    return objectType !== 'indicator'
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- usageSqlView`
Expected: PASS, all cases.

- [ ] **Step 5: Verify the body on 2.40, 2.41 and 2.42 against live instances**

One instance at a time (two booting concurrently starve each other). The
2.43 leg is already measured — do not re-run it.

```bash
B="$DHIS2_BROKER_URL"; H="Authorization: Bearer $DHIS2_BROKER_TOKEN"; CT="Content-Type: application/json"
# 2.40 already exists as agent-gsi-p2-40; start it rather than creating another.
curl -s -X POST -H "$H" $B/instances/agent-gsi-p2-40/start
# 2.41 and 2.42 need creating, from the matching Sierra Leone seeds:
curl -s -X POST -H "$H" -H "$CT" -d '{"name":"agent-gsi-p6-41","version":"41","seed":"dhis2-db-sierra-leone_v41.sql.gz","label":"GSI Plan 6: usage SQL view cross-version check (olav)"}' $B/instances
curl -s -X POST -H "$H" -H "$CT" -d '{"name":"agent-gsi-p6-42","version":"42","seed":"dhis2-db-sierra-leone_v42.sql.gz","label":"GSI Plan 6: usage SQL view cross-version check (olav)"}' $B/instances
```

For each instance, run these four checks and record every answer in the note:

1. **Table inventory** — the eleven bridge tables, the three dimension tables
   and `mapmapviews` either exist or do not:

   ```bash
   PGPASSWORD=dhis psql -h dhis2-<name>-db -U dhis -d dhis2 -t -c \
     "select table_name from information_schema.tables where table_schema='public' and (table_name like '%groupsetdimension%' or table_name in ('mapmapviews','map','mapview','visualization','eventvisualization','eventchart','eventreport','datastatisticsevent')) order by 1;"
   ```

2. **Is `eventvisualization` still a superset of the legacy tables?**

   ```bash
   PGPASSWORD=dhis psql -h dhis2-<name>-db -U dhis -d dhis2 -c \
     "select (select count(*) from eventchart) as ec, (select count(*) from eventchart ec join eventvisualization ev on ev.uid=ec.uid) as ec_in_ev, (select count(*) from eventreport) as er, (select count(*) from eventreport er join eventvisualization ev on ev.uid=er.uid) as er_in_ev;"
   ```

   If `ec_in_ev < ec` or `er_in_ev < er` on any version, that version needs a
   second candidate that unions the legacy tables in as well (`union`, not
   `union all`, keeps the dedupe correct where both are present). Add it as a
   **second** entry in `USAGE_SQL_CANDIDATES`, after the one above.

3. **Does `datastatisticsevent.favoriteuid` still name the map, not the
   mapview?**

   ```bash
   PGPASSWORD=dhis psql -h dhis2-<name>-db -U dhis -d dhis2 -c \
     "select count(*) total, count(m.uid) matches_map, count(mv.uid) matches_mapview from datastatisticsevent e left join map m on m.uid=e.favoriteuid left join mapview mv on mv.uid=e.favoriteuid where e.eventtype='MAP_VIEW';"
   ```

4. **The view itself installs, executes and reads.** Post the exact
   `USAGE_SQL_CANDIDATES[0].sqlQuery`:

   ```bash
   # create (expect HTTP 201), execute (expect HTTP 201), read
   curl -s -u local_admin:district "http://dhis2-<name>:8080/api/sqlViews/<id>/data.json?pageSize=5000"
   ```

   Then re-run the same body in psql with `interval '12 month'` replaced by
   `interval '200 month'` and record both results — a seed whose statistics
   are older than 12 months returns `views_12m = 0` legitimately, and the
   widened window is the control that proves the join works. Delete the view
   from each instance afterwards; these are shared instances.

- [ ] **Step 6: Write the note**

Create `docs/superpowers/notes/2026-09-plan6-usage-tables.md` recording, per
version (2.40.x, 2.41.x, 2.42.x, 2.43.1): the exact DHIS2 version from
`/api/system/info`, the table inventory, the three measurements above, the row
counts the view returned, and the widened-window control. State plainly which
versions the shipped candidate was proven on and which (if any) needed a
second. Carry the 2.43.1 measurements quoted in this task across verbatim.

- [ ] **Step 7: Amend the spec**

In `docs/superpowers/specs/2026-09-15-manual-review-1-design.md`:

- §3.2: replace the four-column table with the five-column, one-row-per
  (group set, favourite type) shape, and say that a group set with no
  referencing favourite has no row. Add the measured table inventory and the
  `mapmapviews`/`map` correction, noting that the reference app's own map join
  is wrong.
- §3.3: record which versions the shipped candidate was proven on.
- §9: add a bullet noting §3.2 was amended here.

- [ ] **Step 8: Stop or delete the instances and commit**

Stop `agent-gsi-p2-40`, and delete `agent-gsi-p6-41` and `agent-gsi-p6-42`
(they were created for this task alone).

```bash
git add src/data/sources/usageSqlView.ts src/data/sources/usageSqlView.test.ts \
        docs/superpowers/notes/2026-09-plan6-usage-tables.md \
        docs/superpowers/specs/2026-09-15-manual-review-1-design.md
git commit -m "Define the group set usage SQL view, proven on 2.40 to 2.43"
```

---

### Task 2: Install, check and remove the usage view

**Files:**

- Create: `src/data/sources/usageAdmin.ts`, `src/data/sources/usageAdmin.test.ts`

**Interfaces:**

- Consumes: `USAGE_SQL_VIEW_CODE`, `USAGE_SQL_VIEW_NAME`, `USAGE_SQL_CANDIDATES` from Task 1; `Fetcher` and `fetchJson` from `src/data/sources/DataSource.ts`; `sqlViewLookupPath` and `USABLE_SQL_VIEW_TYPES` from `src/data/sources/sqlViewSource.ts`; `canCreateSqlViews` from `src/data/sources/sqlViewAdmin.ts` (reused unchanged — it asks about the user, not about a particular view).
- Produces, for Tasks 3 and 8:
  - `interface UsageViewCheck { id: string | null; type: string | undefined; readable: boolean; usable: boolean }`
  - `checkUsageView: (fetcher: Fetcher) => Promise<UsageViewCheck>`
  - `interface InstallUsageResult { installed: boolean; variant: string | null; id: string | null; failures: { variant: string; message: string }[] }`
  - `installUsageView: (fetcher: Fetcher, check: UsageViewCheck) => Promise<InstallUsageResult>`
  - `removeUsageView: (fetcher: Fetcher, id: string) => Promise<void>`

**Why this is not `createOrRepairSqlViews`:** spec §3.4. The three `GSI_*`
views have a metadata-API fallback, so `createOrRepairSqlViews` can treat them
as one all-or-nothing group. This one has none — the metadata API cannot count
dimension references — and an absent usage view must mean "no usage column",
never "the whole app drops to the slow path". Keeping the two install paths
separate is what makes that structural rather than a comment.

- [ ] **Step 1: Write the failing tests**

Create `src/data/sources/usageAdmin.test.ts`:

```ts
import {
    checkUsageView,
    installUsageView,
    removeUsageView,
} from './usageAdmin'
import { USAGE_SQL_CANDIDATES } from './usageSqlView'
import { Fetcher } from './DataSource'

const ok = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response
const created = (uid: string) =>
    ({
        ok: true,
        status: 201,
        json: async () => ({ response: { uid } }),
    }) as unknown as Response
const failed = (status: number) =>
    ({ ok: false, status, json: async () => ({}) }) as unknown as Response

describe('checkUsageView', () => {
    it('reports id null when no view carries the code', async () => {
        const fetcher = jest.fn(async () =>
            ok({ sqlViews: [] })
        ) as unknown as Fetcher
        await expect(checkUsageView(fetcher)).resolves.toEqual({
            id: null,
            type: undefined,
            readable: false,
            usable: false,
        })
    })

    it('refuses a materialised view, which would serve arbitrarily old counts', async () => {
        const fetcher = jest.fn(async () =>
            ok({
                sqlViews: [
                    {
                        id: 'v1',
                        code: 'GSI_GROUPSET_USAGE',
                        type: 'MATERIALIZED_VIEW',
                        access: { data: { read: true } },
                    },
                ],
            })
        ) as unknown as Fetcher
        const check = await checkUsageView(fetcher)
        expect(check).toMatchObject({ id: 'v1', usable: false })
    })

    it('is usable only once a real read of its data succeeds', async () => {
        const calls: string[] = []
        const fetcher = jest.fn(async (path: string) => {
            calls.push(path)
            if (path.startsWith('sqlViews?')) {
                return ok({
                    sqlViews: [
                        {
                            id: 'v1',
                            code: 'GSI_GROUPSET_USAGE',
                            type: 'VIEW',
                            access: { data: { read: true } },
                        },
                    ],
                })
            }
            return ok({ listGrid: { headers: [], rows: [] } })
        }) as unknown as Fetcher
        await expect(checkUsageView(fetcher)).resolves.toMatchObject({
            usable: true,
        })
        expect(calls[1]).toBe('sqlViews/v1/data.json?pageSize=1')
    })

    it('is not usable when the read probe fails, however healthy the metadata looks', async () => {
        const fetcher = jest.fn(async (path: string) =>
            path.startsWith('sqlViews?')
                ? ok({
                      sqlViews: [
                          {
                              id: 'v1',
                              code: 'GSI_GROUPSET_USAGE',
                              type: 'VIEW',
                              access: { data: { read: true } },
                          },
                      ],
                  })
                : failed(500)
        ) as unknown as Fetcher
        await expect(checkUsageView(fetcher)).resolves.toMatchObject({
            id: 'v1',
            readable: true,
            usable: false,
        })
    })
})

describe('installUsageView', () => {
    it('creates, executes and reads the first candidate, and reports its variant', async () => {
        const calls: { path: string; method?: string }[] = []
        const fetcher = jest.fn(async (path: string, init?: RequestInit) => {
            calls.push({ path, method: init?.method })
            if (path === 'sqlViews' && init?.method === 'POST') {
                return created('new1')
            }
            return ok({ listGrid: { headers: [], rows: [] } })
        }) as unknown as Fetcher
        const result = await installUsageView(fetcher, {
            id: null,
            type: undefined,
            readable: false,
            usable: false,
        })
        expect(result).toMatchObject({
            installed: true,
            variant: USAGE_SQL_CANDIDATES[0].variant,
            id: 'new1',
            failures: [],
        })
        expect(calls.map((c) => c.path)).toEqual([
            'sqlViews',
            'sqlViews/new1/execute',
            'sqlViews/new1/data.json?pageSize=1',
        ])
    })

    it('deletes the view it just created when that view will not execute, then tries the next candidate', async () => {
        const calls: string[] = []
        let createCount = 0
        const fetcher = jest.fn(async (path: string, init?: RequestInit) => {
            calls.push(`${init?.method ?? 'GET'} ${path}`)
            if (path === 'sqlViews' && init?.method === 'POST') {
                createCount += 1
                return created(`new${createCount}`)
            }
            if (path === 'sqlViews/new1/execute') {
                return failed(409)
            }
            return ok({ listGrid: { headers: [], rows: [] } })
        }) as unknown as Fetcher
        const candidates = [
            { variant: 'first', sqlQuery: 'with a as (select 1) select 1' },
            { variant: 'second', sqlQuery: 'with b as (select 1) select 1' },
        ]
        const result = await installUsageView(
            fetcher,
            { id: null, type: undefined, readable: false, usable: false },
            candidates
        )
        expect(calls).toContain('DELETE sqlViews/new1')
        expect(result).toMatchObject({ installed: true, variant: 'second' })
        expect(result.failures).toHaveLength(1)
        expect(result.failures[0].variant).toBe('first')
    })

    it('reports every candidate failing rather than claiming a partial install', async () => {
        const fetcher = jest.fn(async (path: string, init?: RequestInit) =>
            path === 'sqlViews' && init?.method === 'POST'
                ? failed(409)
                : ok({})
        ) as unknown as Fetcher
        const result = await installUsageView(fetcher, {
            id: null,
            type: undefined,
            readable: false,
            usable: false,
        })
        expect(result.installed).toBe(false)
        expect(result.id).toBeNull()
        expect(result.failures).toHaveLength(USAGE_SQL_CANDIDATES.length)
    })

    it('re-executes an existing but unusable view instead of creating a second one', async () => {
        const calls: string[] = []
        const fetcher = jest.fn(async (path: string, init?: RequestInit) => {
            calls.push(`${init?.method ?? 'GET'} ${path}`)
            return ok({ listGrid: { headers: [], rows: [] } })
        }) as unknown as Fetcher
        const result = await installUsageView(fetcher, {
            id: 'old1',
            type: 'VIEW',
            readable: true,
            usable: false,
        })
        expect(calls).toEqual([
            'POST sqlViews/old1/execute',
            'GET sqlViews/old1/data.json?pageSize=1',
        ])
        expect(result).toMatchObject({ installed: true, id: 'old1' })
    })
})

describe('removeUsageView', () => {
    it('deletes by id and reports a refusal', async () => {
        const fetcher = jest.fn(async () => failed(403)) as unknown as Fetcher
        await expect(removeUsageView(fetcher, 'v1')).rejects.toThrow(/403/)
    })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- usageAdmin`
Expected: FAIL — `Cannot find module './usageAdmin'`.

- [ ] **Step 3: Write `usageAdmin.ts`**

```ts
import { fetchJson, Fetcher } from './DataSource'
import { sqlViewLookupPath, USABLE_SQL_VIEW_TYPES } from './sqlViewSource'
import {
    USAGE_SQL_CANDIDATES,
    USAGE_SQL_VIEW_CODE,
    USAGE_SQL_VIEW_NAME,
    UsageSqlCandidate,
} from './usageSqlView'

interface SqlViewRow {
    id: string
    code?: string
    type?: string
    access: { data?: { read?: boolean } }
}

export interface UsageViewCheck {
    id: string | null
    type: string | undefined
    readable: boolean
    /** exists, is a VIEW/QUERY, and a real read of its data just succeeded */
    usable: boolean
}

/** Cheap regardless of how many group sets the instance has. */
const probePath = (id: string) => `sqlViews/${id}/data.json?pageSize=1`

async function probeReadable(fetcher: Fetcher, id: string): Promise<boolean> {
    try {
        const response = await fetcher(probePath(id))
        return response.ok
    } catch {
        return false
    }
}

/**
 * Same bar as `checkSqlViews` applies to the three GSI_* views, and for the
 * same reason (C1 there): metadata alone cannot tell an executed view from
 * one that was created and never successfully executed, so "usable" has to
 * mean "was just read", not "looks right on paper".
 */
export async function checkUsageView(
    fetcher: Fetcher
): Promise<UsageViewCheck> {
    const body = await fetchJson<{ sqlViews: SqlViewRow[] }>(
        fetcher,
        sqlViewLookupPath([USAGE_SQL_VIEW_CODE])
    )
    const view = body.sqlViews.find((v) => v.code === USAGE_SQL_VIEW_CODE)
    const readable = Boolean(view?.access.data?.read)
    const metadataUsable = Boolean(
        view &&
            readable &&
            view.type !== undefined &&
            USABLE_SQL_VIEW_TYPES.includes(view.type)
    )
    return {
        id: view?.id ?? null,
        type: view?.type,
        readable,
        usable:
            metadataUsable && view
                ? await probeReadable(fetcher, view.id)
                : false,
    }
}

export interface InstallUsageResult {
    installed: boolean
    /** which candidate body took; null when none did */
    variant: string | null
    id: string | null
    failures: { variant: string; message: string }[]
}

async function createView(
    fetcher: Fetcher,
    candidate: UsageSqlCandidate
): Promise<string> {
    const response = await fetcher('sqlViews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: USAGE_SQL_VIEW_NAME,
            code: USAGE_SQL_VIEW_CODE,
            // Never MATERIALIZED_VIEW: it would serve arbitrarily old counts
            // with nothing in the response to say how old (spec 3.4).
            type: 'VIEW',
            sqlQuery: candidate.sqlQuery,
            sharing: { public: 'r-------' },
        }),
    })
    if (!response.ok) {
        throw new Error(
            `Could not create the usage SQL view — HTTP ${response.status}`
        )
    }
    const body = (await response.json()) as { response: { uid: string } }
    return body.response.uid
}

async function executeView(fetcher: Fetcher, id: string): Promise<void> {
    const response = await fetcher(`sqlViews/${id}/execute`, { method: 'POST' })
    if (!response.ok) {
        throw new Error(
            `Could not execute the usage SQL view — HTTP ${response.status}`
        )
    }
}

async function readOrThrow(fetcher: Fetcher, id: string): Promise<void> {
    const response = await fetcher(probePath(id))
    if (!response.ok) {
        throw new Error(
            `The usage SQL view was created but cannot be read — HTTP ${response.status}`
        )
    }
}

/**
 * Spec 3.3: the candidates are tried in order until one both creates and
 * executes -- and here, also reads, for the same reason `checkUsageView`
 * probes: a body that creates and executes but 500s on read is not an
 * install. A candidate that fails at any of those three steps has the view
 * it just created deleted again, so the next candidate starts from a server
 * in the state it found -- and so a failed install never leaves an orphan
 * behind that a later `checkUsageView` would have to reason about.
 *
 * An **existing** view (one this call did not create) is never deleted, the
 * same rule `createOrRepairSqlViews` follows: re-executing it is the repair,
 * and deleting someone else's object on a failed repair would be a much
 * larger action than the one the button offers.
 */
export async function installUsageView(
    fetcher: Fetcher,
    check: UsageViewCheck,
    candidates: UsageSqlCandidate[] = USAGE_SQL_CANDIDATES
): Promise<InstallUsageResult> {
    const failures: { variant: string; message: string }[] = []

    if (check.id) {
        try {
            await executeView(fetcher, check.id)
            await readOrThrow(fetcher, check.id)
            return {
                installed: true,
                variant: null,
                id: check.id,
                failures,
            }
        } catch (e) {
            return {
                installed: false,
                variant: null,
                id: check.id,
                failures: [
                    {
                        variant: 'existing',
                        message: e instanceof Error ? e.message : String(e),
                    },
                ],
            }
        }
    }

    for (const candidate of candidates) {
        let id: string | null = null
        try {
            id = await createView(fetcher, candidate)
            await executeView(fetcher, id)
            await readOrThrow(fetcher, id)
            return { installed: true, variant: candidate.variant, id, failures }
        } catch (e) {
            if (id) {
                await fetcher(`sqlViews/${id}`, { method: 'DELETE' }).catch(
                    () => undefined
                )
            }
            failures.push({
                variant: candidate.variant,
                message: e instanceof Error ? e.message : String(e),
            })
        }
    }

    return { installed: false, variant: null, id: null, failures }
}

export async function removeUsageView(
    fetcher: Fetcher,
    id: string
): Promise<void> {
    const response = await fetcher(`sqlViews/${id}`, { method: 'DELETE' })
    if (!response.ok) {
        throw new Error(
            `Could not remove the usage SQL view — HTTP ${response.status}`
        )
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- usageAdmin`
Expected: PASS.

- [ ] **Step 5: Run the gates and commit**

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src
git add src/data/sources/usageAdmin.ts src/data/sources/usageAdmin.test.ts
git commit -m "Install, check and remove the group set usage SQL view"
```

---

### Task 3: The "Group set usage" section in Settings

**Files:**

- Modify: `src/pages/Settings/Settings.tsx`, `src/pages/Settings/Settings.module.css`
- Test: `src/pages/Settings/Settings.test.tsx`

**Interfaces:**

- Consumes: `checkUsageView`, `installUsageView`, `removeUsageView`, `UsageViewCheck`, `InstallUsageResult` from Task 2; `canCreateSqlViews` from `sqlViewAdmin.ts`; `createFetcher` from `src/data/fetcher.ts`.
- Produces: nothing other tasks import.

**Why a separate section rather than a fourth row in the SQL views list:** the
existing section's headline claim is "the app is reading organisation unit
data through the fast SQL view path", and its button creates or repairs all
three together. The usage view changes neither of those. Folding it in would
make "SQL views are set up" mean two different things depending on which of
four rows the reader looks at.

- [ ] **Step 1: Write the failing tests**

Add to `src/pages/Settings/Settings.test.tsx` (keep the file's existing mocks;
add a mock for the usage admin module alongside them):

```tsx
jest.mock('@/data/sources/usageAdmin', () => ({
    checkUsageView: jest.fn(),
    installUsageView: jest.fn(),
    removeUsageView: jest.fn(),
}))

import {
    checkUsageView,
    installUsageView,
    removeUsageView,
} from '@/data/sources/usageAdmin'

const mockCheckUsage = checkUsageView as jest.MockedFunction<
    typeof checkUsageView
>
const mockInstallUsage = installUsageView as jest.MockedFunction<
    typeof installUsageView
>
const mockRemoveUsage = removeUsageView as jest.MockedFunction<
    typeof removeUsageView
>

describe('Settings — group set usage', () => {
    beforeEach(() => {
        mockCheckUsage.mockResolvedValue({
            id: null,
            type: undefined,
            readable: false,
            usable: false,
        })
        mockInstallUsage.mockResolvedValue({
            installed: true,
            variant: 'eventvisualization',
            id: 'new1',
            failures: [],
        })
        mockRemoveUsage.mockResolvedValue(undefined)
    })

    it('offers to install the view when it is missing and the user may create SQL views', async () => {
        renderSettings({ canManage: true })
        expect(
            await screen.findByRole('button', {
                name: 'Install usage SQL view',
            })
        ).toBeInTheDocument()
    })

    it('does not offer the button to a user who cannot create SQL views', async () => {
        renderSettings({ canManage: false })
        expect(await screen.findByText('Group set usage')).toBeInTheDocument()
        expect(
            screen.queryByRole('button', { name: 'Install usage SQL view' })
        ).not.toBeInTheDocument()
    })

    it('says which query variant took', async () => {
        renderSettings({ canManage: true })
        fireEvent.click(
            await screen.findByRole('button', {
                name: 'Install usage SQL view',
            })
        )
        expect(
            await screen.findByText(
                'Installed using the eventvisualization query variant'
            )
        ).toBeInTheDocument()
    })

    it('names every candidate that failed when none could be installed', async () => {
        mockInstallUsage.mockResolvedValue({
            installed: false,
            variant: null,
            id: null,
            failures: [
                { variant: 'eventvisualization', message: 'HTTP 409' },
            ],
        })
        renderSettings({ canManage: true })
        fireEvent.click(
            await screen.findByRole('button', {
                name: 'Install usage SQL view',
            })
        )
        expect(
            await screen.findByText(
                'The eventvisualization query variant could not be installed — HTTP 409'
            )
        ).toBeInTheDocument()
    })

    it('offers removal once the view is usable, and removes it', async () => {
        mockCheckUsage.mockResolvedValue({
            id: 'v1',
            type: 'VIEW',
            readable: true,
            usable: true,
        })
        renderSettings({ canManage: true })
        fireEvent.click(
            await screen.findByRole('button', { name: 'Remove usage SQL view' })
        )
        await waitFor(() => expect(mockRemoveUsage).toHaveBeenCalledWith(
            expect.anything(),
            'v1'
        ))
    })
})
```

`renderSettings` is the existing helper in this file; extend it so the
`canManage` flag it already controls for `canCreateSqlViews` is reused here
(the same authority governs both — creating a SQL view is creating a SQL
view). If the file has no such helper yet, add one wrapping the existing
render plus its provider mocks, and move the existing tests onto it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- Settings`
Expected: FAIL — "Unable to find an element with the text: Group set usage".

- [ ] **Step 3: Implement the section**

In `Settings.tsx`, add alongside the existing state:

```tsx
const [usageCheck, setUsageCheck] = useState<UsageViewCheck | null>(null)
const [usageBusy, setUsageBusy] = useState(false)
const [usageResult, setUsageResult] = useState<InstallUsageResult | null>(null)
const [usageError, setUsageError] = useState<string | null>(null)

const refreshUsage = useCallback(async () => {
    try {
        setUsageCheck(await checkUsageView(fetcher))
        setUsageError(null)
    } catch (e) {
        setUsageCheck(null)
        setUsageError(e instanceof Error ? e.message : String(e))
    }
}, [fetcher])

useEffect(() => {
    void refreshUsage()
}, [refreshUsage])
```

and the section itself, after the SQL views section:

```tsx
<div className={styles.section}>
    <h2 className={styles.heading}>{i18n.t('Group set usage')}</h2>
    <p className={styles.note}>
        {i18n.t(
            'An optional SQL view that counts the saved favourites referencing each group set, and how often they were viewed in the last 12 months. Without it the app works exactly as before, only with no usage figures.'
        )}
    </p>
    {usageError ? (
        <NoticeBox error title={i18n.t('Could not check the usage SQL view')}>
            {usageError}
        </NoticeBox>
    ) : (
        <>
            <div className={styles.viewRow}>
                <span className={styles.viewName}>
                    {i18n.t('Group set usage view')}
                </span>
                {usageCheck?.usable ? (
                    <Tag positive>{i18n.t('Usable')}</Tag>
                ) : usageCheck?.id ? (
                    <Tag neutral>{i18n.t('Not usable yet')}</Tag>
                ) : (
                    <Tag negative>{i18n.t('Missing')}</Tag>
                )}
            </div>
            {usageCheck && !usageCheck.usable && canManage === true && (
                <Button
                    onClick={handleInstallUsage}
                    disabled={usageBusy}
                    loading={usageBusy}
                >
                    {i18n.t('Install usage SQL view')}
                </Button>
            )}
            {usageCheck?.usable && canManage === true && (
                <Button
                    secondary
                    onClick={handleRemoveUsage}
                    disabled={usageBusy}
                    loading={usageBusy}
                >
                    {i18n.t('Remove usage SQL view')}
                </Button>
            )}
            {usageResult?.installed && (
                <NoticeBox valid title={i18n.t('Usage data is installed')}>
                    {/* `variant` is null when an existing view was repaired
                        rather than created -- there is no candidate body to
                        name in that case, but the install still succeeded
                        and must say so. */}
                    {usageResult.variant
                        ? interpolate(
                              i18n.t(
                                  'Installed using the {variant} query variant'
                              ),
                              { variant: usageResult.variant }
                          )
                        : i18n.t(
                              'The existing usage SQL view was repaired and can now be read.'
                          )}
                </NoticeBox>
            )}
            {usageResult && !usageResult.installed && (
                <NoticeBox
                    error
                    title={i18n.t('The usage SQL view could not be installed')}
                >
                    {usageResult.failures.map((f) => (
                        <div key={f.variant}>
                            {interpolate(
                                i18n.t(
                                    'The {variant} query variant could not be installed — {message}'
                                ),
                                { variant: f.variant, message: f.message }
                            )}
                        </div>
                    ))}
                </NoticeBox>
            )}
        </>
    )}
</div>
```

with the two handlers:

```tsx
const handleInstallUsage = async () => {
    if (!usageCheck) {
        return
    }
    setUsageBusy(true)
    setUsageError(null)
    try {
        const result = await installUsageView(fetcher, usageCheck)
        setUsageResult(result)
        await refreshUsage()
    } catch (e) {
        setUsageError(e instanceof Error ? e.message : String(e))
    } finally {
        setUsageBusy(false)
    }
}

const handleRemoveUsage = async () => {
    if (!usageCheck?.id) {
        return
    }
    setUsageBusy(true)
    setUsageError(null)
    try {
        await removeUsageView(fetcher, usageCheck.id)
        // The install report belongs to a view that no longer exists.
        setUsageResult(null)
        await refreshUsage()
    } catch (e) {
        setUsageError(e instanceof Error ? e.message : String(e))
    } finally {
        setUsageBusy(false)
    }
}
```

Add `.note` to `Settings.module.css` if it is not already there (small,
`var(--colors-grey700)`, margin below).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- Settings`
Expected: PASS.

- [ ] **Step 5: Extract strings, run the gates, commit**

```bash
pnpm exec d2-app-scripts i18n extract
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src
git add src/pages/Settings i18n/en.pot
git commit -m "Install and remove the usage SQL view from Settings"
```

---

### Task 4: `useUsage` — read the view and aggregate it

**Files:**

- Create: `src/hooks/useUsage.ts`, `src/hooks/useUsage.test.tsx`

**Interfaces:**

- Consumes: `parseUsageListGrid`, `usageByGroupSet`, `SetUsage`, `UsageListGrid`, `USAGE_SQL_VIEW_CODE` from Task 1; `useApiDataQuery` from `src/utils/useApiDataQuery.ts`.
- Produces, for Tasks 5, 6 and 7:
  - `type UsageStatus = 'loading' | 'absent' | 'ready' | 'error'`
  - `interface UsageState { status: UsageStatus; error: string | null; forSet: (groupSetId: string) => SetUsage | null; refresh: () => void }`
  - `useUsage: () => UsageState`

**Why a plain hook and not a provider:** TanStack Query already dedupes by
`queryKey` across components, so the dashboard's cards and the group set page
share one request without a context. `useIntegrity` needs a provider because
it owns mutable session state (a poll in flight, the stale set); this hook
owns none.

**`forSet` returns `null` versus a zero `SetUsage`:** `null` means "no answer
yet, or no usage data on this server" — a caller must render nothing. A set
that the view simply does not mention gets a real zero `SetUsage`, which is
what "Appears unused" is built on. Collapsing the two would put that tag on
every card of an instance with no usage view installed.

- [ ] **Step 1: Write the failing tests**

Create `src/hooks/useUsage.test.tsx`:

```tsx
import { renderHook, waitFor } from '@testing-library/react'
import React from 'react'
import { useUsage } from './useUsage'

const mockQuery = jest.fn()
jest.mock('@/utils/useApiDataQuery', () => ({
    useApiDataQuery: (args: unknown) => mockQuery(args),
}))

const lookup = (sqlViews: unknown[]) => ({
    data: { sqlViews },
    isLoading: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
})

const data = (rows: unknown[][]) => ({
    data: {
        listGrid: {
            headers: [
                { name: 'groupset_uid' },
                { name: 'groupset_type' },
                { name: 'favourite_type' },
                { name: 'favourites' },
                { name: 'views_12m' },
            ],
            rows,
        },
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
})

const pending = {
    data: undefined,
    isLoading: true,
    isError: false,
    error: null,
    refetch: jest.fn(),
}

describe('useUsage', () => {
    beforeEach(() => mockQuery.mockReset())

    it('is absent when no view carries the usage code', async () => {
        mockQuery.mockReturnValueOnce(lookup([])).mockReturnValueOnce(pending)
        const { result } = renderHook(() => useUsage())
        await waitFor(() => expect(result.current.status).toBe('absent'))
        expect(result.current.forSet('a')).toBeNull()
    })

    it('is absent when the only view with that code is a materialised view', async () => {
        mockQuery
            .mockReturnValueOnce(
                lookup([
                    {
                        id: 'v1',
                        code: 'GSI_GROUPSET_USAGE',
                        type: 'MATERIALIZED_VIEW',
                        access: { data: { read: true } },
                    },
                ])
            )
            .mockReturnValueOnce(pending)
        const { result } = renderHook(() => useUsage())
        await waitFor(() => expect(result.current.status).toBe('absent'))
    })

    it('aggregates the rows per group set once both queries resolve', async () => {
        mockQuery
            .mockReturnValueOnce(
                lookup([
                    {
                        id: 'v1',
                        code: 'GSI_GROUPSET_USAGE',
                        type: 'VIEW',
                        access: { data: { read: true } },
                    },
                ])
            )
            .mockReturnValueOnce(
                data([
                    ['a', 'orgUnitGroupSet', 'visualization', '37', '89'],
                    ['a', 'orgUnitGroupSet', 'map', '1', '0'],
                ])
            )
        const { result } = renderHook(() => useUsage())
        await waitFor(() => expect(result.current.status).toBe('ready'))
        expect(result.current.forSet('a')).toMatchObject({
            favourites: 38,
            views12m: 89,
        })
    })

    it('answers zero, not null, for a set the view does not mention', async () => {
        mockQuery
            .mockReturnValueOnce(
                lookup([
                    {
                        id: 'v1',
                        code: 'GSI_GROUPSET_USAGE',
                        type: 'VIEW',
                        access: { data: { read: true } },
                    },
                ])
            )
            .mockReturnValueOnce(data([]))
        const { result } = renderHook(() => useUsage())
        await waitFor(() => expect(result.current.status).toBe('ready'))
        expect(result.current.forSet('nobody')).toEqual({
            favourites: 0,
            views12m: 0,
            byFavouriteType: [],
        })
    })

    it('reports a result it cannot parse as an error, not as zero usage', async () => {
        mockQuery
            .mockReturnValueOnce(
                lookup([
                    {
                        id: 'v1',
                        code: 'GSI_GROUPSET_USAGE',
                        type: 'VIEW',
                        access: { data: { read: true } },
                    },
                ])
            )
            .mockReturnValueOnce({
                data: { listGrid: { headers: [{ name: 'nope' }], rows: [] } },
                isLoading: false,
                isError: false,
                error: null,
                refetch: jest.fn(),
            })
        const { result } = renderHook(() => useUsage())
        await waitFor(() => expect(result.current.status).toBe('error'))
        expect(result.current.error).toMatch(/groupset_uid/)
        expect(result.current.forSet('a')).toBeNull()
    })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- useUsage`
Expected: FAIL — `Cannot find module './useUsage'`.

- [ ] **Step 3: Write `useUsage.ts`**

```ts
import { useCallback, useMemo } from 'react'
import {
    parseUsageListGrid,
    SetUsage,
    usageByGroupSet,
    UsageListGrid,
    USAGE_SQL_VIEW_CODE,
} from '@/data/sources/usageSqlView'
import { USABLE_SQL_VIEW_TYPES } from '@/data/sources/sqlViewSource'
import { useApiDataQuery } from '@/utils/useApiDataQuery'

export type UsageStatus = 'loading' | 'absent' | 'ready' | 'error'

export interface UsageState {
    status: UsageStatus
    error: string | null
    /** null whenever status is not 'ready' -- see the plan's note on this */
    forSet: (groupSetId: string) => SetUsage | null
    refresh: () => void
}

interface LookupResponse {
    sqlViews: {
        id: string
        code?: string
        type?: string
        access: { data?: { read?: boolean } }
    }[]
}

const EMPTY: SetUsage = { favourites: 0, views12m: 0, byFavouriteType: [] }

/**
 * An explicit page size rather than `paging=false`: the app runtime warns on
 * the latter, and the row count here is bounded by three times the number of
 * group sets on the instance. `PAGE_SIZE` is two orders of magnitude above
 * any real instance, and a result that reaches it is treated as truncated
 * rather than reported as if it were complete.
 */
const PAGE_SIZE = 5000

export function useUsage(): UsageState {
    const lookup = useApiDataQuery<LookupResponse>({
        queryKey: ['sqlViews', USAGE_SQL_VIEW_CODE],
        query: {
            resource: 'sqlViews',
            params: {
                fields: 'id,code,type,access[data[read]]',
                filter: `code:eq:${USAGE_SQL_VIEW_CODE}`,
            },
        },
        staleTime: Infinity,
    })

    const view = lookup.data?.sqlViews.find(
        (v) =>
            v.code === USAGE_SQL_VIEW_CODE &&
            v.access.data?.read === true &&
            v.type !== undefined &&
            USABLE_SQL_VIEW_TYPES.includes(v.type)
    )

    const read = useApiDataQuery<UsageListGrid>({
        queryKey: ['sqlViewData', view?.id ?? 'none'],
        query: {
            resource: `sqlViews/${view?.id ?? 'none'}/data`,
            params: { pageSize: PAGE_SIZE },
        },
        enabled: Boolean(view),
        staleTime: 5 * 60 * 1000,
    })

    const parsed = useMemo(() => {
        if (!read.data) {
            return null
        }
        try {
            const rows = parseUsageListGrid(read.data)
            if (rows.length >= PAGE_SIZE) {
                throw new Error(
                    'The group set usage SQL view returned a truncated result'
                )
            }
            return { byId: usageByGroupSet(rows), error: null as string | null }
        } catch (e) {
            return {
                byId: null,
                error: e instanceof Error ? e.message : String(e),
            }
        }
    }, [read.data])

    const status: UsageStatus = lookup.isError
        ? 'error'
        : lookup.isLoading
          ? 'loading'
          : !view
            ? 'absent'
            : read.isError || parsed?.error
              ? 'error'
              : parsed?.byId
                ? 'ready'
                : 'loading'

    const error =
        parsed?.error ??
        (lookup.isError || read.isError
            ? ((lookup.error ?? read.error) as Error | null)?.message ?? null
            : null)

    const byId = status === 'ready' ? parsed?.byId ?? null : null

    const forSet = useCallback(
        (groupSetId: string) => (byId ? byId.get(groupSetId) ?? EMPTY : null),
        [byId]
    )

    const refresh = useCallback(() => {
        void lookup.refetch()
        void read.refetch()
    }, [lookup, read])

    return { status, error, forSet, refresh }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- useUsage`
Expected: PASS.

- [ ] **Step 5: Run the gates and commit**

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src
git add src/hooks/useUsage.ts src/hooks/useUsage.test.tsx
git commit -m "Read the usage SQL view and aggregate it per group set"
```

---

### Task 5: The Usage tab

**Files:**

- Create: `src/pages/GroupSetDetail/UsageTab.tsx`, `src/pages/GroupSetDetail/UsageTab.test.tsx`
- Create: `src/utils/favouriteTypeLabels.ts`
- Modify: `src/pages/GroupSetDetail/GroupSetDetail.tsx` (add the tab; seed the initial tab from router state)
- Test: `src/pages/GroupSetDetail/GroupSetDetail.test.tsx`

**Interfaces:**

- Consumes: `useUsage` and `UsageState` from Task 4; `usageApplies`, `FavouriteType`, `SetUsage` from Task 1; `GroupSetMeta` from `src/engine/types.ts`.
- Produces, for Task 6:
  - `favouriteTypeLabel: (type: FavouriteType) => string` from `src/utils/favouriteTypeLabels.ts`
  - `UsageTab: (props: { set: GroupSetMeta }) => JSX.Element`
  - `GroupSetDetail` accepts an initial tab through router state: `navigate('/sets/<id>', { state: { tab: 'usage' } })`.

**The caveat is not decoration (spec §3.6).** Every surface that shows a count
carries it, and no surface words a zero as certainty. The tab is where the
full sentence lives; the card carries the short form.

- [ ] **Step 1: Write the failing tests**

Create `src/pages/GroupSetDetail/UsageTab.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import React from 'react'
import { UsageTab } from './UsageTab'
import { GroupSetMeta } from '@/engine/types'

const mockUsage = jest.fn()
jest.mock('@/hooks/useUsage', () => ({ useUsage: () => mockUsage() }))

const set = (over: Partial<GroupSetMeta> = {}): GroupSetMeta => ({
    id: 'a',
    displayName: 'Facility type',
    objectType: 'organisationUnit',
    compulsory: false,
    dataDimension: true,
    groups: [],
    canWrite: true,
    ...over,
})

const ready = (usage: unknown) => ({
    status: 'ready',
    error: null,
    forSet: () => usage,
    refresh: jest.fn(),
})

describe('UsageTab', () => {
    it('shows the favourite and view counts', () => {
        mockUsage.mockReturnValue(
            ready({
                favourites: 42,
                views12m: 100,
                byFavouriteType: [
                    { favouriteType: 'visualization', favourites: 37, views12m: 89 },
                    { favouriteType: 'eventVisualization', favourites: 4, views12m: 11 },
                    { favouriteType: 'map', favourites: 1, views12m: 0 },
                ],
            })
        )
        render(<UsageTab set={set()} />)
        expect(
            screen.getByText('42 favourites reference this group set')
        ).toBeInTheDocument()
        expect(
            screen.getByText('100 views in the last 12 months')
        ).toBeInTheDocument()
    })

    it('breaks the favourites down by favourite type', () => {
        mockUsage.mockReturnValue(
            ready({
                favourites: 38,
                views12m: 89,
                byFavouriteType: [
                    { favouriteType: 'visualization', favourites: 37, views12m: 89 },
                    { favouriteType: 'map', favourites: 1, views12m: 0 },
                ],
            })
        )
        render(<UsageTab set={set()} />)
        expect(screen.getByText('Charts and pivot tables')).toBeInTheDocument()
        expect(screen.getByText('Maps')).toBeInTheDocument()
    })

    it('always carries the caveat, so no count reads as proof', () => {
        mockUsage.mockReturnValue(
            ready({ favourites: 0, views12m: 0, byFavouriteType: [] })
        )
        render(<UsageTab set={set()} />)
        expect(
            screen.getByText(/leaves no favourite behind/)
        ).toBeInTheDocument()
    })

    it('words zero as "nothing on this instance references it", never as unused', () => {
        mockUsage.mockReturnValue(
            ready({ favourites: 0, views12m: 0, byFavouriteType: [] })
        )
        render(<UsageTab set={set()} />)
        expect(
            screen.getByText('No saved favourite references this group set')
        ).toBeInTheDocument()
    })

    it('says indicator group sets are not analytics dimensions instead of showing a zero', () => {
        mockUsage.mockReturnValue(
            ready({ favourites: 0, views12m: 0, byFavouriteType: [] })
        )
        render(<UsageTab set={set({ objectType: 'indicator' })} />)
        expect(
            screen.getByText(
                'Indicator group sets are not analytics dimensions, so there is no usage data for them.'
            )
        ).toBeInTheDocument()
        expect(
            screen.queryByText('No saved favourite references this group set')
        ).not.toBeInTheDocument()
    })

    it('prompts for the install when this instance has no usage view', () => {
        mockUsage.mockReturnValue({
            status: 'absent',
            error: null,
            forSet: () => null,
            refresh: jest.fn(),
        })
        render(<UsageTab set={set()} />)
        expect(
            screen.getByText('Usage data is not installed on this instance')
        ).toBeInTheDocument()
    })

    it('shows the error rather than an empty page when the view cannot be read', () => {
        mockUsage.mockReturnValue({
            status: 'error',
            error: 'HTTP 500',
            forSet: () => null,
            refresh: jest.fn(),
        })
        render(<UsageTab set={set()} />)
        expect(screen.getByText('HTTP 500')).toBeInTheDocument()
    })
})
```

Add to `src/pages/GroupSetDetail/GroupSetDetail.test.tsx`:

```tsx
// Same treatment this file already gives IntegrityTab: this test is about
// which tab GroupSetDetail opens on, and UsageTab.test.tsx pins the tab's
// own content.
jest.mock('./UsageTab', () => ({
    UsageTab: () => <div>mock-usage-tab</div>,
}))

it('opens on the Usage tab when the router state asks for it', async () => {
    renderDetail({
        initialEntries: [{ pathname: '/sets/a', state: { tab: 'usage' } }],
    })
    expect(await screen.findByText('mock-usage-tab')).toBeInTheDocument()
})

it('still opens on Overview when there is no router state', async () => {
    renderDetail()
    expect(screen.queryByText('mock-usage-tab')).not.toBeInTheDocument()
})
```

extending that file's existing render helper with an `initialEntries` option
passed straight to its `MemoryRouter`. Query the tab buttons with
`findByText`, not `getByRole('tab')` — `@dhis2/ui`'s `Tab` renders a plain
button, which is why every existing test in this file does the same.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- UsageTab GroupSetDetail`
Expected: FAIL — `Cannot find module './UsageTab'`.

- [ ] **Step 3: Write `favouriteTypeLabels.ts`**

```ts
import i18n from '@dhis2/d2-i18n'
import { FavouriteType } from '@/data/sources/usageSqlView'

/**
 * DHIS2's own object names are not what a user of this app recognises: a
 * `visualization` is what they made in Data Visualizer (a chart or a pivot
 * table), and an `eventVisualization` is what they made in Line Listing or
 * the older Event Reports and Event Charts apps. Each label is one complete,
 * argument-free string.
 */
export function favouriteTypeLabel(type: FavouriteType): string {
    switch (type) {
        case 'visualization':
            return i18n.t('Charts and pivot tables')
        case 'map':
            return i18n.t('Maps')
        case 'eventVisualization':
            return i18n.t('Event reports and line lists')
    }
}
```

- [ ] **Step 4: Write `UsageTab.tsx`**

```tsx
import i18n from '@dhis2/d2-i18n'
import { CircularLoader, NoticeBox } from '@dhis2/ui'
import React from 'react'
import { Link } from 'react-router-dom'
import styles from './GroupSetDetail.module.css'
import { usageApplies } from '@/data/sources/usageSqlView'
import { GroupSetMeta } from '@/engine/types'
import { useUsage } from '@/hooks/useUsage'
import { favouriteTypeLabel } from '@/utils/favouriteTypeLabels'
import { interpolate } from '@/utils/interpolate'

const favouritesLabel = (count: number) =>
    count === 1
        ? i18n.t('1 favourite references this group set')
        : interpolate(i18n.t('{count} favourites reference this group set'), {
              count: count.toLocaleString(),
          })

const viewsLabel = (count: number) =>
    count === 1
        ? i18n.t('1 view in the last 12 months')
        : interpolate(i18n.t('{count} views in the last 12 months'), {
              count: count.toLocaleString(),
          })

const typeFavouritesLabel = (count: number) =>
    count === 1
        ? i18n.t('1 favourite')
        : interpolate(i18n.t('{count} favourites'), {
              count: count.toLocaleString(),
          })

export const UsageTab = ({ set }: { set: GroupSetMeta }) => {
    const usage = useUsage()

    if (!usageApplies(set.objectType)) {
        // Spec 3.2: there is no indicatorgroupsetdimension table on any
        // supported version, so a zero here would be a fact about DHIS2's
        // data model presented as a finding about this group set.
        return (
            <NoticeBox title={i18n.t('Usage')}>
                {i18n.t(
                    'Indicator group sets are not analytics dimensions, so there is no usage data for them.'
                )}
            </NoticeBox>
        )
    }

    if (usage.status === 'loading') {
        return <CircularLoader small />
    }

    if (usage.status === 'absent') {
        return (
            <NoticeBox
                title={i18n.t('Usage data is not installed on this instance')}
            >
                <p>
                    {i18n.t(
                        'Usage counts come from an optional SQL view that an administrator installs once.'
                    )}
                </p>
                <Link to="/settings">
                    {i18n.t('Go to Settings to install it')}
                </Link>
            </NoticeBox>
        )
    }

    if (usage.status === 'error') {
        return (
            <NoticeBox error title={i18n.t('Usage data could not be read')}>
                {usage.error}
            </NoticeBox>
        )
    }

    const setUsage = usage.forSet(set.id)
    if (!setUsage) {
        return <CircularLoader small />
    }

    return (
        <div className={styles.usage}>
            <p className={styles.usageHeadline}>
                {setUsage.favourites === 0
                    ? i18n.t('No saved favourite references this group set')
                    : favouritesLabel(setUsage.favourites)}
            </p>
            <p>{viewsLabel(setUsage.views12m)}</p>
            {setUsage.byFavouriteType.length > 0 && (
                <ul className={styles.usageBreakdown}>
                    {setUsage.byFavouriteType.map((row) => (
                        <li key={row.favouriteType}>
                            <span>{favouriteTypeLabel(row.favouriteType)}</span>
                            <span>{typeFavouritesLabel(row.favourites)}</span>
                        </li>
                    ))}
                </ul>
            )}
            {/* Spec 3.6, on every surface that shows a count. */}
            <NoticeBox title={i18n.t('These counts are indicative')}>
                {i18n.t(
                    'They cover saved favourites and their recorded views. An ad-hoc analytics request, an external client or an API consumer leaves no favourite behind, so a count of zero means nothing on this instance references the group set — not that nothing uses it.'
                )}
            </NoticeBox>
        </div>
    )
}
```

Add `.usage`, `.usageHeadline` and `.usageBreakdown` to
`GroupSetDetail.module.css` (a column flex with `gap: var(--spacers-dp16)`;
the headline one step larger than body text; the breakdown a plain list whose
`li` is a two-column flex row with `justify-content: space-between`).

- [ ] **Step 5: Wire the tab into `GroupSetDetail.tsx`**

- Widen `DetailTab` to `'overview' | 'objects' | 'usage' | 'integrity'`.
- Seed the state from router state, so a card can link straight in:

  ```tsx
  const location = useLocation()
  const initialTab = (location.state as { tab?: DetailTab } | null)?.tab
  const [tab, setTab] = useState<DetailTab>(initialTab ?? 'overview')
  ```

- Add the `Tab` between Objects and DHIS2 integrity, and the branch in the
  body ternary, before the `ObjectsTab` fallback:

  ```tsx
  ) : tab === 'usage' ? (
      <UsageTab set={set} />
  ```

  The Usage tab is shown for every set, including indicator group sets — the
  tab's own body is what explains that there is nothing to show, which is
  what spec §3.5 asks for.

- The `FilterBar` on this page renders the organisation unit field for
  organisation unit sets on every tab, and that stays: usage is instance-wide,
  but the field is the one control the review asked to be reachable without
  leaving the set.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test -- UsageTab GroupSetDetail`
Expected: PASS.

- [ ] **Step 7: Extract strings, run the gates, commit**

```bash
pnpm exec d2-app-scripts i18n extract
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src
git add src/pages/GroupSetDetail src/utils/favouriteTypeLabels.ts i18n/en.pot
git commit -m "Add the Usage tab to the group set page"
```

---

### Task 6: The dashboard card's usage figure and "Appears unused" tag

**Files:**

- Modify: `src/components/GroupSetCard/GroupSetCard.tsx`, `src/components/GroupSetCard/GroupSetCard.module.css`
- Modify: `src/pages/Dashboard/Dashboard.tsx` (pass the new callback)
- Test: `src/components/GroupSetCard/GroupSetCard.test.tsx`

**Interfaces:**

- Consumes: `useUsage` from Task 4; `usageApplies` from Task 1.
- Produces: `GroupSetCard` gains one prop, `onOpenUsage: () => void`, which `Dashboard` implements as `navigate('/sets/' + entry.set.id, { state: { tab: 'usage' } })`.

- [ ] **Step 1: Write the failing tests**

Add to `src/components/GroupSetCard/GroupSetCard.test.tsx` (this file already
mocks `useIntegrity`; add the same treatment for `useUsage`):

```tsx
const mockUsage = jest.fn()
jest.mock('@/hooks/useUsage', () => ({ useUsage: () => mockUsage() }))

const readyUsage = (usage: unknown) => ({
    status: 'ready',
    error: null,
    forSet: () => usage,
    refresh: jest.fn(),
})

describe('GroupSetCard — usage', () => {
    it('shows the favourite count', () => {
        mockUsage.mockReturnValue(
            readyUsage({ favourites: 42, views12m: 100, byFavouriteType: [] })
        )
        renderCard()
        expect(screen.getByText('42 favourites')).toBeInTheDocument()
    })

    it('tags a set no favourite references, and the tag opens its Usage tab', () => {
        const onOpenUsage = jest.fn()
        mockUsage.mockReturnValue(
            readyUsage({ favourites: 0, views12m: 0, byFavouriteType: [] })
        )
        renderCard({ onOpenUsage })
        fireEvent.click(screen.getByRole('button', { name: 'Appears unused' }))
        expect(onOpenUsage).toHaveBeenCalled()
    })

    it('shows nothing about usage when this instance has no usage view', () => {
        mockUsage.mockReturnValue({
            status: 'absent',
            error: null,
            forSet: () => null,
            refresh: jest.fn(),
        })
        renderCard()
        expect(screen.queryByText('Appears unused')).not.toBeInTheDocument()
        expect(screen.queryByText(/favourites/)).not.toBeInTheDocument()
    })

    it('shows nothing about usage on an indicator group set', () => {
        mockUsage.mockReturnValue(
            readyUsage({ favourites: 0, views12m: 0, byFavouriteType: [] })
        )
        renderCard({ set: { objectType: 'indicator' } })
        expect(screen.queryByText('Appears unused')).not.toBeInTheDocument()
    })
})
```

`renderCard` is this file's existing helper; extend it to take an
`onOpenUsage` and a partial `set` override if it does not already.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- GroupSetCard`
Expected: FAIL — "Unable to find an element with the text: 42 favourites".

- [ ] **Step 3: Implement the card changes**

In `GroupSetCard.tsx`:

```tsx
const usage = useUsage()
// Only a set whose type can be an analytics dimension, on an instance that
// actually has the usage view, shows anything here. Everything else renders
// nothing at all -- not a dash, not a zero (the same rule the integrity line
// above already follows).
const setUsage =
    usage.status === 'ready' && usageApplies(set.objectType)
        ? usage.forSet(set.id)
        : null
```

and, in the meta area below the stats:

```tsx
{setUsage && (
    <div className={styles.usage}>
        <span>{cardFavouritesLabel(setUsage.favourites)}</span>
        {setUsage.favourites === 0 && (
            <button
                type="button"
                className={styles.unusedTag}
                onClick={(e) => {
                    // The whole card is itself a button; without this the
                    // card's own onOpen would fire too and land the user on
                    // the Overview tab instead.
                    e.stopPropagation()
                    onOpenUsage()
                }}
            >
                {i18n.t('Appears unused')}
            </button>
        )}
    </div>
)}
```

with

```tsx
const cardFavouritesLabel = (count: number) =>
    count === 1
        ? i18n.t('1 favourite')
        : interpolate(i18n.t('{count} favourites'), {
              count: count.toLocaleString(),
          })
```

Style `.unusedTag` as a `@dhis2/ui` warning tag would look (`--colors-yellow050`
background, `--colors-yellow800` text, small radius) but keep it a real
`<button>`: it is the one thing on the card that navigates somewhere other
than the card's own target, so it has to be reachable by keyboard
independently.

In `Dashboard.tsx`, pass it at both `GroupSetCard` call sites:

```tsx
onOpenUsage={() =>
    navigate(`/sets/${entry.set.id}`, { state: { tab: 'usage' } })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- GroupSetCard Dashboard`
Expected: PASS.

- [ ] **Step 5: Extract strings, run the gates, commit**

```bash
pnpm exec d2-app-scripts i18n extract
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src
git add src/components/GroupSetCard src/pages/Dashboard i18n/en.pot
git commit -m "Show usage on the dashboard cards, and tag the unreferenced ones"
```

---

### Task 7: Sorting the dashboard by usage

**Files:**

- Modify: `src/pages/Dashboard/Dashboard.tsx`
- Test: `src/pages/Dashboard/Dashboard.test.tsx`
- Modify: `docs/superpowers/specs/2026-09-15-manual-review-1-design.md` §3.5

**Interfaces:**

- Consumes: `useUsage` from Task 4; `usageApplies` from Task 1.
- Produces: nothing other tasks import.

**Spec amendment made by this task.** §3.5 names the option `Usage` without
saying which end it sorts from. The reason the option exists — §3.5's own "a
user pruning dead sets can invert it" — only works least-used-first, so the
option is labelled **`Usage (least used first)`**, which says what it does
rather than making the user try it. Write that into §3.5.

Plan 5 left the option rendered but `disabled`, with the field carrying
`helpText` explaining why. Both go away when usage is ready; both stay exactly
as they are when it is not — an instance with no usage view installed should
still see that the sort exists and why it cannot be used.

- [ ] **Step 1: Write the failing tests**

Add to `src/pages/Dashboard/Dashboard.test.tsx`:

```tsx
it('leaves the usage sort disabled, and says why, when no usage view is installed', async () => {
    mockUsage.mockReturnValue({
        status: 'absent',
        error: null,
        forSet: () => null,
        refresh: jest.fn(),
    })
    renderDashboard()
    expect(
        await screen.findByText('Usage data is not installed on this instance')
    ).toBeInTheDocument()
})

it('sorts the least used set first when the usage sort is chosen', async () => {
    mockUsage.mockReturnValue({
        status: 'ready',
        error: null,
        forSet: (id: string) =>
            ({
                heavy: { favourites: 40, views12m: 90, byFavouriteType: [] },
                light: { favourites: 0, views12m: 0, byFavouriteType: [] },
            })[id] ?? { favourites: 0, views12m: 0, byFavouriteType: [] },
        refresh: jest.fn(),
    })
    renderDashboard({
        entries: [
            entry('heavy', { conflict: 9 }),
            entry('light', { conflict: 0 }),
        ],
    })
    fireEvent.click(await screen.findByText('Issues'))
    fireEvent.click(await screen.findByText('Usage (least used first)'))
    const names = screen.getAllByTestId('dhis2-uicore-card')
    expect(names[0]).toHaveTextContent('light')
})

it('keeps worst-first as the default order', async () => {
    mockUsage.mockReturnValue({
        status: 'ready',
        error: null,
        forSet: () => ({ favourites: 0, views12m: 0, byFavouriteType: [] }),
        refresh: jest.fn(),
    })
    renderDashboard({
        entries: [
            entry('clean', { conflict: 0 }),
            entry('broken', { conflict: 9 }),
        ],
    })
    const names = await screen.findAllByTestId('dhis2-uicore-card')
    expect(names[0]).toHaveTextContent('broken')
})
```

reusing this file's existing `renderDashboard`/`entry` helpers and adding the
`useUsage` mock next to its existing ones.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- Dashboard`
Expected: FAIL — the `Usage (least used first)` option does not exist.

- [ ] **Step 3: Implement the sort**

```tsx
type SortKey = 'issues' | 'usage'
const [sortKey, setSortKey] = useState<SortKey>('issues')
const usage = useUsage()
const usageSortable = usage.status === 'ready'

/**
 * Least used first, because that is the question this sort answers -- which
 * sets nothing references any more. A set whose type can never be an
 * analytics dimension (indicators) has no usage to compare, so it sorts
 * after every set that does rather than tying at zero with the genuinely
 * unreferenced ones.
 */
const byLeastUsed = (a: DashboardEntry, b: DashboardEntry) => {
    const applicable = (e: DashboardEntry) => usageApplies(e.set.objectType)
    if (applicable(a) !== applicable(b)) {
        return applicable(a) ? -1 : 1
    }
    if (!applicable(a)) {
        return 0
    }
    const ua = usage.forSet(a.set.id)
    const ub = usage.forSet(b.set.id)
    return (
        (ua?.favourites ?? 0) - (ub?.favourites ?? 0) ||
        (ua?.views12m ?? 0) - (ub?.views12m ?? 0)
    )
}
```

and in the field:

```tsx
<FilterBarField label={i18n.t('Sort by')}>
    <SingleSelectField
        dense
        selected={sortKey}
        onChange={({ selected }) => setSortKey(selected as SortKey)}
        helpText={
            usageSortable
                ? undefined
                : i18n.t('Usage data is not installed on this instance')
        }
    >
        <SingleSelectOption value="issues" label={i18n.t('Issues')} />
        <SingleSelectOption
            value="usage"
            label={i18n.t('Usage (least used first)')}
            disabled={!usageSortable}
        />
    </SingleSelectField>
</FilterBarField>
```

In the per-type render, replace `.sort(byWorstFirst)` with
`.sort(sortKey === 'usage' && usageSortable ? byLeastUsed : byWorstFirst)`.

`byWorstFirst`'s not-yet-loaded grouping stays: the `notYetLoaded` / `loaded`
split below the sort reads `hasData`, not the comparator, so a set still
loading keeps its own labelled group under either sort.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- Dashboard`
Expected: PASS.

- [ ] **Step 5: Amend §3.5, extract strings, run the gates, commit**

```bash
pnpm exec d2-app-scripts i18n extract
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src
git add src/pages/Dashboard i18n/en.pot docs/superpowers/specs/2026-09-15-manual-review-1-design.md
git commit -m "Sort the dashboard by usage, least used first"
```

---

### Task 8: End-to-end coverage for the usage flow

**Files:**

- Modify: `e2e/flows.spec.ts`

**Interfaces:**

- Consumes: `appRoot`, `CREDENTIALS`, `APP_PATH` from `e2e/fixtures/session.ts`, unchanged.
- Produces: nothing other tasks import.

**Why this flow writes, and how it cleans up.** Installing the view is the
only way to reach the surfaces this plan adds, so the flow installs it and
then removes it through the app's own Settings button — the same
write-then-revert shape the existing write flows use.
`docs/superpowers/notes/2026-09-plan5-carry-forward.md` §2 records that this
suite has no `afterEach` net; this flow does not fix that (it is its own
design question) but it must not make it worse, so the removal is the last
step of the same test and the test asserts the view is gone.

- [ ] **Step 1: Write the failing flow**

Add to `e2e/flows.spec.ts`:

```ts
test('usage — install the view, read a count, remove it again', async ({
    page,
}) => {
    const root = await openApp(page)

    await root.getByRole('link', { name: 'Settings' }).click()
    await expect(root.getByText('Group set usage')).toBeVisible()

    const install = root.getByRole('button', {
        name: 'Install usage SQL view',
    })
    await expect(install).toBeVisible()
    await install.click()
    await expect(root.getByText('Usage data is installed')).toBeVisible({
        timeout: 30_000,
    })

    // The view is instance-wide, so any set of an applicable type will do;
    // the Sierra Leone seed's own org unit group sets are referenced by
    // dozens of favourites (measured: 37 visualizations on one of them).
    await root.getByRole('link', { name: 'Dashboard' }).click()
    await root.getByRole('button', { name: /Facility Type/ }).first().click()
    await root.getByRole('tab', { name: 'Usage' }).click()
    await expect(
        root.getByText(/references this group set|No saved favourite/)
    ).toBeVisible()
    await expect(root.getByText(/in the last 12 months/)).toBeVisible()
    await expect(root.getByText(/leaves no favourite behind/)).toBeVisible()

    await root.getByRole('link', { name: 'Settings' }).click()
    const remove = root.getByRole('button', { name: 'Remove usage SQL view' })
    await expect(remove).toBeVisible()
    await remove.click()
    await expect(install).toBeVisible({ timeout: 30_000 })
})
```

`openApp` is this file's existing helper (log in, `page.goto(APP_PATH)`,
`appRoot`). If the group set name in the seed differs from `Facility Type`,
use whichever organisation unit group set the dashboard actually lists —
do not add a fixture.

- [ ] **Step 2: Run it against both live instances**

```bash
# one instance at a time
pnpm exec playwright test --config e2e/playwright.config.ts -g "usage"
```

Run it against the 2.43 and the 2.40 instance the suite already targets.
Expected: PASS on both. A failure that is really the app's is a defect to fix
here; a failure that is the instance's (a missing group set, a stopped
instance) is a fixture problem to fix in the test.

- [ ] **Step 3: Commit**

```bash
git add e2e/flows.spec.ts
git commit -m "Cover installing, reading and removing the usage view end to end"
```

---

## What this plan deliberately does not do

- **It adds nothing to `src/engine`.** Usage is a fact about metadata
  references on the server, not a property of the object population the
  engine computes, and routing it through the worker would buy nothing.
- **It offers no one-click delete or disable on the strength of a zero**
  (spec §3.6). The existing `Set properties…` dialog already lets a user turn
  off `dataDimension` deliberately; usage is the basis for that decision, not
  a shortcut past it.
- **It does not reconcile usage with the DHIS2 integrity overlay.** They
  answer different questions and their staleness models differ.
- **It does not touch the items carried forward in
  `docs/superpowers/notes/2026-09-plan5-carry-forward.md`** — the three
  failing e2e write/revert flows, the missing cleanup net, the
  `agent-gsi-p2-40` data anomaly, the `@dhis2/ui` `align` bug, or the latent
  locator collision. Those stay carried forward; Task 8 only avoids adding to
  them.

## Self-review

- **Spec §3.1** (why) — motivates the whole plan; no task of its own.
- **§3.2** (the view) — Task 1, with the row-shape amendment recorded there.
- **§3.3** (version differences) — Task 1 steps 5–7.
- **§3.4** (installation, own definition list, no fallback, `type: 'VIEW'`,
  remove button) — Tasks 2 and 3.
- **§3.5** (Usage tab, dashboard card, sort control, "Appears unused" tag) —
  Tasks 5, 6 and 7, with the sort-direction amendment recorded in Task 7.
- **§3.6** (indicative, not proof) — Task 5 asserts the caveat renders and that
  zero is never worded as certainty; Task 6 keeps the card silent rather than
  showing a zero where usage does not apply.
- **§10** (verification) — Task 8 adds the e2e flow; the four-version review
  still runs once after Plan 7.
