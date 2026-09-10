# Plan 1 performance record: EMIS (266,396 organisation units)

**Answer first: the design's "counts within about 60 seconds" budget holds, but only once the
three `GSI_*` SQL views exist on the instance. Without them, the metadata-only path did not
produce dashboard counts within 640 seconds of the reload that starts loading — over ten times
the budget — in this measurement. The SQL-view path produced counts in 44.4 seconds (about a
quarter of the budget spare), and a warm reload from cache in 4.6 seconds. All three numbers were
taken through a development proxy on a shared, loaded machine — see "How to read these numbers"
below before treating any of them as exact.**

Recommendation for Plan 3: make creating the SQL views the first thing an admin is prompted to
do on the Settings page (see "Why the metadata path is this slow" below for why this is not
optional at this scale).

## How to read these numbers: every figure below runs through a development proxy on a shared box

Every timing in this document was taken with the app running under `d2-app-scripts start`'s
development proxy (`pnpm start --proxy http://dhis2-agent-gsi-emis:8080`), with the measuring
browser, the dev server/proxy process, DHIS2 itself, and its Postgres database all sharing this
sandbox's four CPUs — several of them also fielding other work from this same measurement
session. **A real deployment serves this app from within DHIS2 (no separate dev server or proxy
hop), typically on hardware dedicated to running DHIS2, not a 4-CPU box also running the browser
that's measuring it.** That difference biases every number in this document *slower* than a real
deployment would see — the question is only by how much, and I can bound that from what I
actually measured, not just assert it:

- The one apples-to-apples comparison I have is the dominant metadata-path query
  (`organisationUnits?fields=id,level,parent`, 266,396 rows) measured three ways:
  - **11–21 seconds**: `curl` straight to the DHIS2 instance, no proxy, no browser, machine
    otherwise idle (measured earlier in this project, before this task's load existed).
  - **83.5 seconds**: `curl` straight to the instance again, no proxy, no browser — but with this
    task's own measurement scripts and browser running concurrently on the same box.
  - **167 seconds**: the same query through the browser, through the dev proxy, in an earlier
    isolated attempt (this task's own scripts were the only other load at the time).
  Concurrent load on the shared box alone accounts for roughly **4–8x** of the slowdown (11–21s
  → 83.5s). The remaining gap between a loaded-box `curl` (83.5s) and the loaded-box
  browser-via-proxy figure (167s) is attributable to the proxy hop plus the browser's own cost of
  receiving and JSON-parsing a 16 MB response before the app can even start building its index —
  call it roughly another **2x**, though I only have one measurement at each end, not a clean
  paired comparison, so treat that second multiplier as a looser bound than the first.
- **I did not measure a direct, no-proxy, no-browser baseline for the SQL-view fetches**, so I
  cannot give the 44.4-second figure the same treatment. Given the mechanism above applies
  generally (proxy hop + browser-side parsing cost, on a loaded shared box), the true figure on
  dedicated hardware with no dev proxy in the path is very likely lower than 44.4 s — plausibly by
  a similar multiple to what was seen above, though the SQL-view payloads are individually
  smaller (3.3–8.5 MB each, vs. the metadata path's single 16.25 MB request), so the proxy's
  fixed per-hop overhead matters proportionally more and the multiplier could plausibly be
  smaller too. **This is inference, not a measurement** — the honest statement is that 44.4 s is
  an upper bound taken under adverse conditions, and the real number a production deployment
  would see is probably better, not worse.
- Net direction for the metadata-only path: since concurrent load and the proxy both bias
  measured numbers *slower*, the "over ten times the 60-second budget" finding below is if
  anything conservative in the metadata path's favour, not exaggerated by the sandbox.

## Measured paths

Measured against `dhis2-agent-gsi-emis:8080` (DHIS2 2.41.10, 266,396 organisation units, ~1.1M
group memberships, 7 organisation unit group sets, plus one small data element group set used
as the "flat type" control). Driven with a scripted Playwright session (Chromium, headless),
authenticated via the dev server's own local proxy per the technique documented in the Task 11
report. Network figures are wire bytes from Chrome DevTools Protocol (`encodedDataLength`), not
JSON body size. JS heap is `Performance.getMetrics`' `JSHeapUsedSize` immediately after load, a
single sample with no forced garbage collection (see "Why the heap figures differ" below).

| Path | Wall time to first counts | Total bytes transferred | Longest single request | JS heap after load |
|---|---|---|---|---|
| **Metadata API only** (today's state, no `GSI_*` views) | **did not complete within 640 s** (gave up: 520 s counts budget + 120 s grace) | 0.74 MB transferred before giving up (the ~16 MB organisation-unit payload never finished downloading in-browser) | the unpaged `organisationUnits?fields=id,level,parent` fetch — still in flight after 640 s in-browser; the identical query completed directly via `curl` against the container in 83.5 s under this task's own concurrent load (11–21 s on an idle box; 167 s in an earlier isolated browser-via-proxy attempt) | 11.6 MB (before real data ever arrived) |
| **SQL views present**, fresh IndexedDB (cache cleared) | **44.4 s** (all sections; org unit counts specifically arrive sooner — see below) | 42.7 MB across 108 requests | `GSI_ORGUNIT_NAMES` CSV, 8.5 MB, 30.3 s | 135.4 MB |
| **Warm cache**, views present, reload | **4.6 s** | 26 KB across 102 requests (only small config/session calls; no bulk data refetched) | trivial config call, 0.4 s | 9.7 MB |

Names ("how long names take to arrive after the counts"): on the SQL-view path, the org unit
names view finished essentially together with the "every section has counts" signal (within the
same ~0.3 s polling granularity used to detect both) — well inside the "a further 30 seconds"
allowance, not because names load before counts, but because of how the loader is sequenced (see
"the 44.4 s figure is gated by the slowest type" below). On the warm path there is no separate
names lag at all: names are restored from the cache alongside everything else. The metadata path
never got far enough to observe a names fetch separately — the single objects fetch alone was
still the bottleneck.

**Important caveat on the 44.4 s figure itself: it is gated by the last object type to finish,
not by the organisation unit counts a manager is actually waiting for.** The loader processes
object types one at a time (see "the sequential loader" below); organisation units are loaded
first and their counts become available as soon as their own evaluate() step completes, well
before the 44.4 s mark — the reported 44.4 s is the point at which the *last* type (the small,
unrelated data element group set) also finishes, because it was queued behind the organisation
unit type's own deferred names fetch. A manager watching only the organisation unit cards they
care about would see numbers sooner than 44.4 s. I did not isolate that earlier moment with its
own timestamp in this measurement, so I can only report the two things I did measure directly
(all-sections-done, and the SQL-view network requests' individual durations above) rather than
invent a specific earlier number.

## Does the 60-second budget hold?

**Yes, for the path the design actually depends on** (SQL views present): 44.4 s "all sections
done" against a 60 s budget, and per the note just above, the organisation unit numbers
themselves — the ones a manager opens the app to see — arrive sooner than that. This is also the
more conservative of the two readings, since (per "how to read these numbers" above) the 44.4 s
figure was taken under proxy + shared-CPU conditions that bias it slower than a production
deployment would see.

**No, for the metadata-only path**, which is this instance's state today (no `GSI_*` views
exist on EMIS at rest). The single largest request in that path — fetching all 266,396
organisation units' id/level/parent — took 83–167 seconds by itself depending on concurrent load
and database cache warmth (see the bounds above), and the full metadata path additionally needs 7
more per-group membership fetches and a names fetch of comparable or greater size (the equivalent
SQL-view names fetch alone was 8.5 MB) before dashboard counts can appear at all — structurally
certain from reading `metadataSource.ts`, but **unmeasured**, since those requests were still
queued behind the huge objects fetch and never ran in this measurement. Multiplying the measured
part out, a genuine metadata-only load against this dataset is credibly several minutes, not
about a minute — decisively over budget even after accounting for this sandbox's own bias toward
slower numbers.

## Why the metadata path is this slow

This is the part I can only partly account for from what I actually measured; I've marked which
half is evidence and which is architectural inference.

**Measured**: the two paths return the same logical data — id, hierarchy level, and parent — for
the same 266,396 organisation units, and their payload sizes differ by more than 2x: **16.25 MB**
as JSON from the metadata API versus **6.93 MB** as CSV from the equivalent SQL view. That gap is
fully explained by format alone, no server internals required: DHIS2's metadata API repeats every
field name on every row and nests the parent as its own `{"id": "..."}` object
(`{"id":"BmWTbiMgEai","level":2,"parent":{"id":"AoCaBHBeXTs"}}`, roughly 60–70 bytes/row), while
the SQL view's CSV carries one header row and then three bare comma-separated values per line —
no repeated keys, no nested object. A larger payload costs more to transfer and, separately, more
to `JSON.parse()` client-side into 266,396 individual JS objects before the app's own
`loadObjects()` can even begin building its typed-array index — both real, both measured
indirectly via the byte counts and request durations above, neither requiring any per-group
fan-out (this request has none — it is one request for the whole collection).

**Inference, not measured directly** (I did not profile the DHIS2 server process, only observed
its response times from outside): DHIS2's generic metadata API serves this endpoint through its
normal object framework — Hibernate/JPA entity hydration per row, per-object sharing/ACL
evaluation, and Jackson serialization through that generic framework — even though the requested
fields are just three scalar/reference columns. A raw SQL `select ou.uid, ou.hierarchylevel,
p.uid from organisationunit ou left join organisationunit p on ...` bypasses all of that entirely:
Postgres streams rows straight off a (likely indexed) join with no per-row object construction,
no serialization framework, no ACL check per row. This is the standard, well-documented reason
DHIS2's SQL view escape hatch exists and is fast where the generic metadata API is slow at this
scale — but I want to be explicit that I am inferring this mechanism from general knowledge of
DHIS2's architecture and from the payload-size/timing evidence above, not from a server-side
profile taken in this task. What I did *not* observe, and had previously mis-attributed: the
per-group membership fetches (`organisationUnitGroups/{id}/organisationUnits`, one request per
group) never ran in this measurement — the objects fetch alone consumed the entire 640 s budget
— so the N+1 fan-out pattern is a real, structurally-certain *additional* cost still to come on
top of the 640+ s already spent, not part of what was actually observed to be slow here.

One secondary effect observed but not treated as a defect: the loader processes object types
sequentially (`loadAll.ts`'s `for (const type of OBJECT_TYPES)` loop awaits each type's full
objects → memberships → evaluate → names cycle before starting the next type). Because of this,
a small, unrelated group set (the data element group set, 647 objects) only got to show its own
counts once the *organisation unit* type's names fetch had also finished — even though data
element counts have nothing to do with organisation unit names. This is why "counts" and "names"
landed together in the SQL-view measurement above, and why the 44.4 s figure is gated by the
slowest type rather than by the organisation unit counts a manager is actually waiting for (see
the callout above). It is a real characteristic worth a look in a later plan (letting a type's
deferred names fetch run without blocking the next type's objects fetch), not something this
task's brief authorized fixing.

## Why the heap figures differ: 135.4 MB fresh vs. 9.7 MB warm

Both paths end up holding the same evaluated dataset in the engine, so a 14x difference in
reported JS heap needs an explanation rather than a shrug. My best explanation, and which number
to trust when sizing a deployment:

The fresh SQL-view load's heap sample was taken moments after a burst of allocation that the warm
reload never does at all: parsing three CSV responses totalling ~42 MB of text into hundreds of
thousands of JS strings and arrays (`csv.ts`'s row-splitting), building the `indexOf` `Map` for
266,396 ids, and then — on the same measurement's timeline — `cache.put()` structured-cloning
that same payload to write it into IndexedDB for next time. The warm reload skips all of that: it
restores already-deserialized objects straight from IndexedDB (no CSV text to parse, no
`Map`-building pass over raw rows, no second copy being written back out), so there is far less
transient allocation for the heap sample to catch mid-flight.

**This is inference, not confirmed**: I took one heap sample immediately after each load, with no
forced garbage collection and no second sample taken later to see whether the fresh-load figure
comes down on its own. It is entirely plausible that 135.4 MB is a transient peak — parsing and
serialization garbage the browser's GC would reclaim within seconds if the page just sat idle —
rather than the app's actual resting footprint. I did not verify this, so I'm not asserting it as
fact.

**For sizing a deployment, the warm-cache figure (9.7 MB) is the better number to use.** It
reflects the same evaluated data with none of the transient parse/serialize garbage, and is a
closer approximation of the app's steady-state memory footprint once a manager has the dashboard
open for more than the first few seconds — which, on a repeat visit, is the common case (the
whole point of the cache).

## Recommendation

Per the task brief: since the metadata path exceeds the 60-second budget by a wide margin on
real production-scale data, Plan 3's Settings page should make creating the three `GSI_*` SQL
views the first thing an admin is prompted to do — not an optional optimization buried in
settings, but the difference between a usable dashboard and one that does not finish loading in
any practical sense on an instance this size.
