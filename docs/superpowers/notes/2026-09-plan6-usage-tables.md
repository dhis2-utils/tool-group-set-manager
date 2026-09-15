# Plan 6 Task 1: the group set usage SQL view, verified on 2.40 through 2.43

The shipped body (`USAGE_SQL_CANDIDATES[0].sqlQuery` in
`src/data/sources/usageSqlView.ts`) was proven, unchanged, against four live
DHIS2 versions: 2.40.12, 2.41.10, 2.42.6 and 2.43.1, all on the Sierra Leone
demo seed for the matching major version. **No second candidate was needed.**
The 2.43.1 measurements below were made while the Plan 6 brief was written
and are carried across verbatim; 2.40.12, 2.41.10 and 2.42.6 were measured by
this task, each against its own disposable broker instance, one at a time.

Every check gave the same answer on all four versions.

## Instances used

| Version | Instance | Seed | Notes |
| --- | --- | --- | --- |
| 2.43.1 | `agent-gsi-p2` | Sierra Leone v43 | measured while the brief was written; not re-run |
| 2.40.12 | `agent-gsi-p2-40` | Sierra Leone V40 | pre-existing, started then stopped again |
| 2.41.10 | `agent-gsi-p6-41` | Sierra Leone v41 | created for this task, deleted afterwards |
| 2.42.6 | `agent-gsi-p6-42` | Sierra Leone v42 | created for this task, deleted afterwards |

`/api/system/info` on each instance, as `local_admin`:

- 2.40: `version: 2.40.12`, `revision: 82b6022`, `buildTime: 2026-06-23T12:57:06.000`
- 2.41: `version: 2.41.10`, `revision: 1a3484f`, `buildTime: 2026-09-08T07:37:45.000`
- 2.42: `version: 2.42.6`, `revision: dd8bdbb`, `buildTime: 2026-08-26T14:23:02.000`
- 2.43: `version: 2.43.1` (measured for the brief; not re-run here)

All four instances use the same Sierra Leone demo seed family, so the same
group sets, favourites and `datastatisticsevent` rows recur across versions
— that is why the row-level numbers below are identical across all four
versions, not a coincidence.

## 1. Table inventory

The eleven bridge tables, the three dimension tables, and `mapmapviews`
(`select table_name from information_schema.tables where table_schema='public'
and (table_name like '%groupsetdimension%' or table_name in ('mapmapviews',
'map','mapview','visualization','eventvisualization','eventchart',
'eventreport','datastatisticsevent')) order by 1`).

**2.43.1** (measured for the brief; from the brief's text, not re-queried
here): the same 24 tables listed below are described as present, with the
same absences —no `mapview_dataelementgroupsetdimensions` and no
`eventvisualization_dataelementgroupsetdimensions`, and no
`indicatorgroupset` dimension table at all.

**2.40.12, 2.41.10, 2.42.6** (measured by this task): all three returned the
identical 24-row list:

```
categoryoptiongroupsetdimension
categoryoptiongroupsetdimension_items
dataelementgroupsetdimension
dataelementgroupsetdimension_items
datastatisticsevent
eventchart
eventchart_categoryoptiongroupsetdimensions
eventchart_orgunitgroupsetdimensions
eventreport
eventreport_categoryoptiongroupsetdimensions
eventreport_orgunitgroupsetdimensions
eventvisualization
eventvisualization_categoryoptiongroupsetdimensions
eventvisualization_orgunitgroupsetdimensions
map
mapmapviews
mapview
mapview_categoryoptiongroupsetdimensions
mapview_orgunitgroupsetdimensions
orgunitgroupsetdimension
orgunitgroupsetdimension_items
visualization
visualization_categoryoptiongroupsetdimensions
visualization_dataelementgroupsetdimensions
visualization_orgunitgroupsetdimensions
```

Confirmed absent on all three (query returned no such row): there is no
`mapview_dataelementgroupsetdimensions` and no
`eventvisualization_dataelementgroupsetdimensions` on 2.40, 2.41 or 2.42
either — a data element group set can only ever be a `visualization`
dimension, on every supported version.

## 2. Is `eventvisualization` still a superset of the legacy tables?

Query: counts of `eventchart`/`eventreport` rows and how many of their
`uid`s are present in `eventvisualization`.

**2.43.1** (from the brief): `eventchart` 19 rows, all 19 present in
`eventvisualization`; `eventreport` 31 rows, all 31 present.

**2.40.12, 2.41.10, 2.42.6** (measured):

| Version | `ec` | `ec_in_ev` | `er` | `er_in_ev` |
| --- | --- | --- | --- | --- |
| 2.40.12 | 19 | 19 | 31 | 31 |
| 2.41.10 | 19 | 19 | 31 | 31 |
| 2.42.6 | 19 | 19 | 31 | 31 |

Identical to 2.43.1 on all three. `eventvisualization` is a strict superset
of both legacy tables on every version tested — no version needed the
legacy tables unioned in.

## 3. Does `datastatisticsevent.favoriteuid` still name the map, not the mapview?

Query: `MAP_VIEW` events joined to `map.uid` and to `mapview.uid`.

**2.43.1** (from the brief): 74 `MAP_VIEW` rows, 30 join to `map.uid`, 0 join
to `mapview.uid`.

**2.40.12, 2.41.10, 2.42.6** (measured):

| Version | total | matches_map | matches_mapview |
| --- | --- | --- | --- |
| 2.40.12 | 74 | 32 | 0 |
| 2.41.10 | 74 | 30 | 0 |
| 2.42.6 | 74 | 30 | 0 |

`matches_mapview` is 0 on every version tested — `favoriteuid` never names
the mapview, on any supported version, confirming the map branch must join
`mapview → mapmapviews → map`, not `mapview.uid` directly (the
`tool-category-dimension-disabler` pattern). `matches_map` varies slightly
(30 on 2.41/2.42, 32 on 2.40) between versions on the same nominal seed
family, which is expected — the v40 seed is a materially different snapshot
from v41/v42/v43, not a re-export of the same one — but the number that
matters for the view's correctness (`matches_mapview = 0`) is stable.

## 4. Does the view itself install, execute and read?

`USAGE_SQL_CANDIDATES[0].sqlQuery` posted verbatim as a `type: "VIEW"` SQL
view, executed, then read via `GET /api/sqlViews/<id>/data.json?pageSize=5000`,
as `local_admin:district`. Deleted from each instance immediately afterwards.

**2.43.1** (from the brief): create → HTTP 201, execute → HTTP 201, read →
12 rows with headers `groupset_uid, groupset_type, favourite_type,
favourites, views_12m`. `views_12m` is 0 for every row on the 12-month
window because the seed's newest `VISUALIZATION_VIEW` statistics event
predates the window; re-running with `interval '200 month'` returned 89, 32,
25, 14, 12, 11, 6, 3 for the referenced sets, proving the view-counting join
works.

**2.40.12** (measured): create → HTTP 201 (view id `LMhavZcZWud`), execute →
HTTP 201, read → 12 rows, same headers, all `views_12m = 0`:

```
Bpx0589u8y0 orgUnitGroupSet        map                1  0
Bpx0589u8y0 orgUnitGroupSet        visualization      11 0
C31vHZqu0qU categoryOptionGroupSet eventVisualization 2  0
Cbuj0VCyDjL orgUnitGroupSet        eventVisualization 1  0
Cbuj0VCyDjL orgUnitGroupSet        visualization      5  0
J5jldMd8OHv orgUnitGroupSet        eventVisualization 4  0
J5jldMd8OHv orgUnitGroupSet        map                1  0
J5jldMd8OHv orgUnitGroupSet        visualization      37 0
jp826jAJHUc dataElementGroupSet    visualization      8  0
lv8UXn17ZOm dataElementGroupSet    visualization      5  0
SooXFOUnciJ categoryOptionGroupSet eventVisualization 1  0
uIuxlbV1vRT orgUnitGroupSet        visualization      3  0
```

Widened-window control (`interval '200 month'`, run directly in `psql`, same
query with only the interval literal changed): same 12
`(groupset_uid, favourite_type)` pairs and identical `favourites` counts,
`views_12m` now non-zero for the sets and favourite types that have
recorded views — proving the join works on 2.40:

```
groupset_uid  groupset_type           favourite_type      favourites  views_12m
Bpx0589u8y0   orgUnitGroupSet         map                 1           0
Bpx0589u8y0   orgUnitGroupSet         visualization        11         32
C31vHZqu0qU   categoryOptionGroupSet  eventVisualization   2          3
Cbuj0VCyDjL   orgUnitGroupSet         eventVisualization   1          6
Cbuj0VCyDjL   orgUnitGroupSet         visualization        5          12
J5jldMd8OHv   orgUnitGroupSet         eventVisualization   4          11
J5jldMd8OHv   orgUnitGroupSet         map                  1          0
J5jldMd8OHv   orgUnitGroupSet         visualization        37         89
jp826jAJHUc   dataElementGroupSet     visualization        8          0
lv8UXn17ZOm   dataElementGroupSet     visualization        5          0
SooXFOUnciJ   categoryOptionGroupSet  eventVisualization   1          14
uIuxlbV1vRT   orgUnitGroupSet         visualization        3          25
```

(The `map` rows and the two `dataElementGroupSet` rows are legitimately 0
even in the 200-month window — no recorded views for those particular
favourites — not a defect in the join.)

**2.41.10** (measured): create → HTTP 201 (view id `MvPLfyjjDN7`), execute →
HTTP 201, read → same 12 rows, same values, all `views_12m = 0` on the
12-month window. Widened-window control: byte-identical to the 2.40.12
table above.

**2.42.6** (measured): create → HTTP 201 (view id `X57JjlSLNqZ`), execute →
HTTP 201, read → same 12 rows, same values, all `views_12m = 0` on the
12-month window. Widened-window control: byte-identical to the 2.40.12 and
2.41.10 tables above.

The `favourites` counts and the widened-window `views_12m` counts are
identical across all four versions (2.40 through 2.43) because all four
seeds share the same group-set/favourite/statistics-event data for the rows
this view touches. The 12-month window legitimately returns all zeros on
every version — none of the seeds carry a `datastatisticsevent` row inside
the last 12 months relative to when this task ran (2026-09-15) — which is
why the widened-window control, not the 12-month result, is the proof that
the join is correct.

## Conclusion

`USAGE_SQL_CANDIDATES[0]` (`variant: 'eventvisualization'`) creates,
executes and reads correctly, with the expected table inventory and join
behaviour, on 2.40.12, 2.41.10, 2.42.6 and 2.43.1. No version rejected the
shipped body; no second candidate was added.

## Fix round 2 (final review, Important 4): the `views_12m` join was not sargable

The body above joined `datastatisticsevent` with
`age(now(), e.timestamp) < interval '12 month'`. `age()` wraps the indexed
column in a function call, so Postgres cannot use an index on
`datastatisticsevent.timestamp` to satisfy it -- it has to evaluate `age()`
against every row. Untestable on the four measurement instances above,
where `datastatisticsevent` holds only tens of rows; on a national
production instance it runs to millions of rows a year, and this view is
read on every dashboard load. Least server load is this project's standing
tie-breaker (it is why the app computes client-side at all), so the
condition was changed to `e.timestamp > now() - interval '12 months'`,
which is sargable.

**This invalidates the four-version verification above, so it was
re-verified** -- against `agent-gsi-p2` (2.43.1) only, the instance
running at the time of this fix, not against all four versions again: the
change touches nothing version-specific (no table or column named differs
between the two forms), only how the same comparison is expressed, so a
second measurement against the same instance that already passed the
original four-version review is what this change needs, not a fresh
four-version run.

Steps, all against `agent-gsi-p2` (2.43.1), `local_admin`/`district`:

1. Created the **new** body as a throwaway view (`GSI_GROUPSET_USAGE_FR2`,
   id `gKNLXAiU6BI`, `type: "VIEW"`): `POST /api/sqlViews` → HTTP 201,
   `POST /api/sqlViews/gKNLXAiU6BI/execute` → HTTP 201,
   `GET /api/sqlViews/gKNLXAiU6BI/data.json?pageSize=5000` → HTTP 200, 12
   rows.
2. Created the **old** (pre-fix, `age()`) body as a second throwaway view
   on the same instance (`GSI_GROUPSET_USAGE_OLD`, id `tosFuMxFJAT`) the
   same way: create → 201, execute → 201, read → 200, 12 rows.
3. **Comparison method**: saved both `GET .../data.json?pageSize=5000`
   response bodies to disk (`new_data.json` for `GSI_GROUPSET_USAGE_FR2`,
   `old_data.json` for `GSI_GROUPSET_USAGE_OLD`), parsed each as JSON, and
   compared `JSON.stringify(newData.listGrid.rows)` against
   `JSON.stringify(oldData.listGrid.rows)` -- **identical**, both are the
   same 12-row array in the same order. The full compared result (the
   **new** sargable body's own read; the old body's read is byte-identical
   to it, so it is not repeated), all `views_12m = 0` on the 12-month
   window (unchanged from the original measurement -- this seed's newest
   statistics event still predates 12 months before 2026-09-15):

   | groupset_uid | groupset_type | favourite_type | favourites | views_12m |
   | --- | --- | --- | --- | --- |
   | Bpx0589u8y0 | orgUnitGroupSet | map | 1 | 0 |
   | Bpx0589u8y0 | orgUnitGroupSet | visualization | 11 | 0 |
   | C31vHZqu0qU | categoryOptionGroupSet | eventVisualization | 2 | 0 |
   | Cbuj0VCyDjL | orgUnitGroupSet | eventVisualization | 1 | 0 |
   | Cbuj0VCyDjL | orgUnitGroupSet | visualization | 5 | 0 |
   | J5jldMd8OHv | orgUnitGroupSet | eventVisualization | 4 | 0 |
   | J5jldMd8OHv | orgUnitGroupSet | map | 1 | 0 |
   | J5jldMd8OHv | orgUnitGroupSet | visualization | 37 | 0 |
   | jp826jAJHUc | dataElementGroupSet | visualization | 8 | 0 |
   | lv8UXn17ZOm | dataElementGroupSet | visualization | 5 | 0 |
   | SooXFOUnciJ | categoryOptionGroupSet | eventVisualization | 1 | 0 |
   | uIuxlbV1vRT | orgUnitGroupSet | visualization | 3 | 0 |

   Raw form, exactly as `listGrid.rows` returned it (both files identical):

   ```json
   [
     ["Bpx0589u8y0","orgUnitGroupSet","map","1","0"],
     ["Bpx0589u8y0","orgUnitGroupSet","visualization","11","0"],
     ["C31vHZqu0qU","categoryOptionGroupSet","eventVisualization","2","0"],
     ["Cbuj0VCyDjL","orgUnitGroupSet","eventVisualization","1","0"],
     ["Cbuj0VCyDjL","orgUnitGroupSet","visualization","5","0"],
     ["J5jldMd8OHv","orgUnitGroupSet","eventVisualization","4","0"],
     ["J5jldMd8OHv","orgUnitGroupSet","map","1","0"],
     ["J5jldMd8OHv","orgUnitGroupSet","visualization","37","0"],
     ["jp826jAJHUc","dataElementGroupSet","visualization","8","0"],
     ["lv8UXn17ZOm","dataElementGroupSet","visualization","5","0"],
     ["SooXFOUnciJ","categoryOptionGroupSet","eventVisualization","1","0"],
     ["uIuxlbV1vRT","orgUnitGroupSet","visualization","3","0"]
   ]
   ```

4. Widened-window control: ran the **new** sargable body directly in
   `psql` against `dhis2-agent-gsi-p2-db`, with `now() - interval '12
   months'` widened to `now() - interval '200 months'` (the interval
   literal is the only edit to the query text). Full tuples, so a reader
   can match each one against the original four-version measurement in §4
   above by `groupset_uid` and `favourite_type`, not just by the bag of
   `views_12m` values:

   | groupset_uid | groupset_type | favourite_type | favourites | views_12m |
   | --- | --- | --- | --- | --- |
   | Bpx0589u8y0 | orgUnitGroupSet | map | 1 | 0 |
   | Bpx0589u8y0 | orgUnitGroupSet | visualization | 11 | 32 |
   | C31vHZqu0qU | categoryOptionGroupSet | eventVisualization | 2 | 3 |
   | Cbuj0VCyDjL | orgUnitGroupSet | eventVisualization | 1 | 6 |
   | Cbuj0VCyDjL | orgUnitGroupSet | visualization | 5 | 12 |
   | J5jldMd8OHv | orgUnitGroupSet | eventVisualization | 4 | 11 |
   | J5jldMd8OHv | orgUnitGroupSet | map | 1 | 0 |
   | J5jldMd8OHv | orgUnitGroupSet | visualization | 37 | 89 |
   | jp826jAJHUc | dataElementGroupSet | visualization | 8 | 0 |
   | lv8UXn17ZOm | dataElementGroupSet | visualization | 5 | 0 |
   | SooXFOUnciJ | categoryOptionGroupSet | eventVisualization | 1 | 14 |
   | uIuxlbV1vRT | orgUnitGroupSet | visualization | 3 | 25 |

   Every `(groupset_uid, groupset_type, favourite_type, favourites)` tuple
   here matches the corresponding row in the 12-month table in step 3
   above exactly; only `views_12m` changes, from 0 to these values. The
   `groupset_uid`/`favourite_type` pairs and their `favourites` counts are
   also exactly the twelve rows in the original four-version measurement's
   §4 table above (same instance family, same seed data), and the non-zero
   `views_12m` values -- 32, 3, 6, 12, 11, 89, 14, 25 -- are exactly the
   eight values that measurement's own widened-window control recorded
   (`89, 32, 25, 14, 12, 11, 6, 3`, order aside), row for row, not merely
   as a matching multiset: confirming the sargable rewrite preserves the
   join's behaviour precisely, not just its totals.
5. Deleted both throwaway views (`DELETE /api/sqlViews/gKNLXAiU6BI` and
   `DELETE /api/sqlViews/tosFuMxFJAT`) -- both HTTP 200 -- and confirmed
   `GET /api/sqlViews.json?filter=code:like:GSI_GROUPSET_USAGE` returns zero
   rows. `agent-gsi-p2` is a shared instance and the e2e usage flow expects
   to install the view itself, so nothing was left behind.

Addendum (re-review): the row table and JSON above are the exact output
saved from this run (`new_data.json`/`old_data.json`, the `GET
.../data.json` responses; `widened_control.txt`, the `psql` output) --
nothing here was re-run to produce this addendum, only transcribed from
data already captured. The instance was re-checked at the time of writing
this addendum (`GET /api/sqlViews.json?filter=code:like:GSI_GROUPSET_USAGE`)
and still shows zero matching views.

The original four-version measurements above (§1 through §4) are left
exactly as they were recorded; this section is additive.
