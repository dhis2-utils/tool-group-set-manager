# Plan 1 performance record: EMIS (266,396 organisation units)

**Answer first: the design's "counts within about 60 seconds" budget holds, but only once the
three `GSI_*` SQL views exist on the instance. Without them, the metadata-only path did not
produce dashboard counts within 640 seconds of the reload that starts loading — over ten times
the budget — in this measurement. The SQL-view path produced counts in 44.4 seconds (about a
quarter of the budget spare), and a warm reload from cache in 4.6 seconds.**

Recommendation for Plan 3: make creating the SQL views the first thing an admin is prompted to
do on the Settings page (see "Metadata path" below for why this is not optional at this scale).

## Measured paths

Measured against `dhis2-agent-gsi-emis:8080` (DHIS2 2.41.10, 266,396 organisation units, ~1.1M
group memberships, 7 organisation unit group sets, plus one small data element group set used
as the "flat type" control). Driven with a scripted Playwright session (Chromium, headless),
authenticated via the dev server's own local proxy per the technique documented in the Task 11
report. Network figures are wire bytes from Chrome DevTools Protocol (`encodedDataLength`), not
JSON body size. JS heap is `Performance.getMetrics`' `JSHeapUsedSize` immediately after load.

| Path | Wall time to first counts | Total bytes transferred | Longest single request | JS heap after load |
|---|---|---|---|---|
| **Metadata API only** (today's state, no `GSI_*` views) | **did not complete within 640 s** (gave up: 520 s counts budget + 120 s grace) | 0.74 MB transferred before giving up (the ~16 MB organisation-unit payload never finished downloading in-browser) | the unpaged `organisationUnits?fields=id,level,parent` fetch — still in flight after 640 s in-browser; the identical query completed directly via `curl` against the container in 83.5 s (with this measurement's own load competing for the sandbox's 4 CPUs), and in an earlier isolated attempt at 167 s via the dev proxy | 11.6 MB (before real data ever arrived) |
| **SQL views present**, fresh IndexedDB (cache cleared) | **44.4 s** | 42.7 MB across 108 requests | `GSI_ORGUNIT_NAMES` CSV, 8.5 MB, 30.3 s | 135.4 MB |
| **Warm cache**, views present, reload | **4.6 s** | 26 KB across 102 requests (only small config/session calls; no bulk data refetched) | `systemSettings/applicationTitle`, 0.4 s | 9.7 MB |

Names ("how long names take to arrive after the counts"): on the SQL-view path, the org unit
names view finished essentially together with the counts (within the same ~0.3 s polling
granularity used to detect both) — well inside the "a further 30 seconds" allowance, not because
names load before counts, but because of how the loader is sequenced (see note below). On the
warm path there is no separate names lag at all: names are restored from the cache alongside
everything else. The metadata path never got far enough to observe a names fetch separately —
the single objects fetch alone was still the bottleneck.

## Does the 60-second budget hold?

**Yes, for the path the design actually depends on** (SQL views present): 44.4 s, roughly 26%
of the 60 s budget still in hand on a shared, resource-constrained sandbox (4 CPUs, running the
DHIS2 instance, its Postgres database, the dev server, and the measuring browser all at once).
On a normal single-purpose server this would very likely be faster still.

**No, for the metadata-only path**, which is this instance's state today (no `GSI_*` views
exist on EMIS at rest). The single largest request in that path — fetching all 266,396
organisation units' id/level/parent — took 83–167 seconds by itself depending on database cache
warmth and concurrent load, and the full metadata path additionally needs 7 more
per-group membership fetches and a names fetch of comparable or greater size (the equivalent
SQL-view names fetch alone was 8.5 MB) before dashboard counts can appear at all. Multiplying
those out, a genuine metadata-only load against this dataset is credibly several minutes, not
about a minute — decisively over budget, independent of the sandbox's own resource contention
(which if anything under-states how bad the direct-to-DHIS2-without-SQL-views case would be on
a shared production server under real user load).

## Why this happens, and what it implies

The app's data layer already anticipated this: `metadataSource.ts` has a code comment noting
that including names in the org unit fetch "on 266K org units add[s] 15 MB and 20+ seconds," and
the whole SQL-view code path exists specifically so a bulk id/level/parent/name/membership
extract can be done as three flat SQL queries instead of the metadata API's N+1 pattern (one
request per group, full JSON serialization overhead per row). This measurement confirms that
design assumption was correct and, on real production-scale data, is not optional — the metadata
path alone blows through the stated budget by an order of magnitude before a single group set's
numbers can render.

One secondary effect observed but not treated as a defect: the loader processes object types
sequentially (`loadAll.ts`'s `for (const type of OBJECT_TYPES)` loop awaits each type's full
objects → memberships → evaluate → names cycle before starting the next type). Because of this,
a small, unrelated group set (the data element group set, 647 objects) only got to show its own
counts once the *organisation unit* type's names fetch had also finished — even though data
element counts have nothing to do with organisation unit names. This is why "counts" and
"names" landed together in the SQL-view measurement above, rather than counts appearing sooner.
It is a real characteristic worth a look in a later plan (letting a type's deferred names fetch
run without blocking the next type's objects fetch), not something this task's brief authorized
fixing.

## Recommendation

Per the task brief: since the metadata path exceeds the 60-second budget by a wide margin on
real production-scale data, Plan 3's Settings page should make creating the three `GSI_*` SQL
views the first thing an admin is prompted to do — not an optional optimization buried in
settings, but the difference between a usable dashboard and one that does not finish loading in
any practical sense on an instance this size.
