# Plan 3 performance record: EMIS (266,396 organisation units), Task 10

**Answer first: the cache genuinely hits at EMIS scale. A warm dashboard reload does zero
`sqlViews/*/data.csv` fetches and completes in ~5.1 s, against ~5.3-9.3 s cold (fix round 1
corrected this from an earlier, wrong "warm is no faster than cold" claim -- see "Dashboard
load" below). The single-object write (8.4-10.1 s) and its revert (13.6 s) are overwhelmingly
DHIS2's own collection-update endpoint cost, not this app's client code -- a raw `curl` POST
against the same server, with no app in the loop at all, costs 6.0-8.7 s by itself. And the
biggest open budget risk is the one nobody had measured until this round: applying (not just
previewing) a bulk fix over a large population. Extrapolated from real per-batch measurements
(below), the 77,017-object "School Level" plan used elsewhere in this note would cost roughly
**8-12 minutes** to apply -- 8-12x over the ~60 s budget, and that figure is itself a floor, not
a midpoint (see "Bulk preview vs. bulk apply" below for why). The SQL views remain the necessary
prerequisite: without them this instance's dashboard load is the >640 s metadata-API failure
already recorded in `docs/superpowers/notes/2026-09-plan1-emis-measurements.md`.**

*Revision note: this is fix round 2 of this document. Fix round 1 (after
`.superpowers/sdd/2026-09-11-gsi-plan-3-integrity-search-e2e/task-10-review.md`) corrected the
warm-dashboard number, the write-latency mechanism, and the "views did not survive the restart"
claim, and added the bulk-apply extrapolation. The re-review
(`.superpowers/sdd/2026-09-11-gsi-plan-3-integrity-search-e2e/task-10-re-review.md`) confirmed
all of that and found one more defect of the same shape, one level down: the bulk-apply batch
table mislabelled two single-id measurements as 1000-id ones, and the causal claim built on top
of it ("cost tracks group size, not batch size") wasn't actually established by the data. Fix
round 2, below, relabels the table, corrects the claim to a stated hypothesis, and notes that
8-12 minutes is a floor because Basic Education grows during its own batches.*

## Instance, version, and hardware

`agent-gsi-emis`: DHIS2 2.41.10, 266,396 organisation units, 7 organisation unit group sets,
~1.1 million memberships -- the same instance and data spec 4.1's baseline was measured against
on 2026-09-10. This is also the only run so far against 2.41 (Plans 1-2 covered 2.40 and 2.43),
and the only run of Plan 3's new text-search path at this scale.

The app was built from commit `0cc012b4c5646d489cca3915afc185b5dbe4541e` on `plan-3-integrity`
(`pnpm build`) and installed as a zip via `POST /api/apps`, per `e2e/fixtures/session.ts`'s own
note on why: no dev-server/proxy origin mismatch, matching how Task 9's suite runs. All sessions
were established via `GET /api/me` with Basic auth, cookie shared into the browser context --
never the login form, per the same convention.

*(That commit predates this document's own fix rounds -- `0cc012b` is the original Task 10 run
that installed and measured the app; nothing under `src/` changed in either fix round, so the
app actually answering requests on the instance is still that same build, even though this note
has since moved on to `14dd5b2` and now this commit. Re-installing on a fresh `pnpm build` from
either later commit would measure identical app code.)*

Measuring machine: an aarch64 Linux sandbox (Docker container, "Linux ... 6.12.76-linuxkit
aarch64"), 4 CPUs, ~8 GB RAM, Chromium 151.0.7922.34 (Playwright 1.63.0's own bundled build) run
headless. This is not dedicated DHIS2 server hardware and not a clean network path -- see
`docs/superpowers/notes/2026-09-plan1-emis-measurements.md`'s own caveat about what a shared,
proxied sandbox does to timings, which applies here too, though this run did not go through a dev
proxy (the app was installed and served by DHIS2 itself, not `d2-app-scripts start`).

**The driver script is kept in the repository** at `scripts/perf/emis-run.js` (not deleted after
the run, unlike the ad hoc script used for the rest of this note -- see the m4 minor in the
review this addresses) so a future run is a re-run, not a re-implementation. It currently covers
only the dashboard cold/warm measurement; the set-open, search, bulk-preview/apply and write
measurements below were still done with a throwaway script, for lack of time to fold everything
into the kept one in this round.

**To get a genuinely cold instance**, I issued `POST $DHIS2_BROKER_URL/instances/agent-gsi-emis/stop`
then `.../start` and waited for `/api/me` to answer 200 -- a full container restart, emptying
Postgres's buffer cache and the app's own in-browser IndexedDB cache. This round did that restart
twice: once at the start of the fix-round work (during which several other measurements were
taken first, so its "cold" dashboard numbers below are honestly only cold-browser, not
cold-Postgres -- see the caveat under "Dashboard load"), and once more immediately before the
final dashboard cold/warm run reported here, specifically so that number is unambiguously cold on
both axes. Both restarts took ~64-68 s of infrastructure boot time (Docker + Postgres + Tomcat) --
not part of the app's own budget, reported only for reproducibility.

**Correction (M3 in the review): the SQL views do survive a restart.** The first version of this
note claimed the opposite -- that a stop/start cycle removed them, and inferred from that "they
are ordinary metadata rows, not part of the instance image". The reasoning about *why* was right
but the observation was wrong: the views are ordinary rows in the instance's own Postgres and
persist across stop/start exactly like any other metadata. What actually happened the first time
around is that the views had simply never been created on this instance yet when I restarted it,
which produces the same zero-views reading as "removed by the restart" would, for a different
reason. Verified directly this round: restarted the instance, and `GET
/api/sqlViews.json?filter=code:like:GSI_` returned all three views (`GSI_ORGUNITS`,
`GSI_ORGUNIT_MEMBERSHIPS`, `GSI_ORGUNIT_NAMES`, all `type: VIEW`) immediately, with no
re-creation step.

## SQL view creation (prerequisite, timed once from a cold instance in the original run)

Driven through the app's own Settings page (`src/pages/Settings/Settings.tsx`), not the API
directly: navigated to `#/settings`, clicked "Create SQL views", and timed from that click to the
"Created 3 SQL views" notice appearing. This part was not re-verified this round (it is not
re-verifiable without dropping the views, which would have meant leaving the instance without
them for whoever uses it next, so I left them in place per the review's own note on this).

| | |
| --- | --- |
| Click "Create SQL views" -> confirmation notice | **1.9 s** |
| Full page load -> confirmation notice (includes app bootstrap + settings-page data) | 14.1 s |

Creating the views is cheap: ~2 seconds of actual work, dwarfed by ordinary page load. This
matches the design's premise (spec 4.2) that offering to create them is a reasonable one-time
step, not a maintenance burden.

**Units of work behind the SQL-view fetches** (addressing m2 in the review -- these are new,
direct `curl` measurements against the same instance, no proxy, no browser, so they are not
biased by anything the app or a browser adds on top):

| View | Payload | Rows | `curl` time |
| --- | --- | --- | --- |
| `GSI_ORGUNITS` | 6.93 MB | 266,397 | 1.01 s |
| `GSI_ORGUNIT_MEMBERSHIPS` | 26.36 MB | 1,098,185 | 2.51 s |
| `GSI_ORGUNIT_NAMES` | 8.52 MB | 266,397 | 0.50 s |

These three add up to ~4.0 s of raw fetch time with no proxy and no browser -- for comparison,
spec 4.1's own SQL-view figures (6.9 MB/2.0 s and 26 MB/3.5 s for org units and memberships) are
close in payload size and same order of magnitude in time, gathered the same way. The app's own
in-browser load (below) takes longer than this sum because it also parses each CSV into typed
arrays, builds the engine's indexes, and runs rule evaluation -- work this curl-only figure
deliberately excludes.

## Dashboard load, cold and warm

**Correction (M1 in the review): the original "warm is not meaningfully faster than cold" finding
was wrong, and it was wrong because of a bad completion signal.** The corrected numbers:

| | First paint | Load complete | `sqlViews/*/data.csv` requests |
| --- | --- | --- | --- |
| **Cold** (fresh browser context + instance just restarted) | 5.34 s | **9.29 s** | 3 (all three CSVs fetched) |
| **Warm** (same context, reloaded; 4 consecutive reloads) | 5.08-5.12 s | **5.08-5.12 s** (== first paint every time) | **0** every time |

On a warm reload the app fetches none of the three CSV payloads at all, confirmed directly by
counting network requests matching `sqlViews/{id}/data.csv` -- not inferred from timing. The
whole load is over by first paint; there is no additional "load complete" time to measure because
nothing further happens. This is a genuine, repeatable cache hit at 266k-row scale on 2.41.10, not
an artifact -- four consecutive reloads all landed at ~5.1 s with zero CSV fetches, and a separate
"prime" load in a brand-new context (necessarily a real fetch, since that context had never loaded
anything) took 6.8-8.1 s with all three CSVs fetched, matching the cold figures above.

### What went wrong the first time, and how this was fixed

The original note used "the `LoadProgress` phase text has disappeared" as its completion signal.
On a warm reload the progress text can render for zero observable time (spec 4.4: cached data is
used immediately), so "the text is absent" cannot tell "already finished" apart from "never
started" -- exactly the defect class this branch's reviews keep finding in test form. The result
was a warm figure (6.9-9.9 s) that was actually timing something else -- most likely the mount, or
a second load that was itself not as warm as assumed.

Fixing this took two attempts, both worth recording because both are the same defect class in a
different disguise:

1. **First fix attempt: count `sqlViews/*/data.csv` network requests directly, and declare
   "settled" once the network has been quiet for a fixed window.** This over-corrected the other
   way. Direct instrumentation of request start times on a **cold** load showed the three CSV
   fetches do not happen back-to-back: request 2 (memberships, the 26 MB payload) finished, and
   request 3 (names) did not start until **~4.1 s later** -- real client-side processing time in
   between, not idle network. Any quiet-window threshold short enough to catch a genuine warm
   no-op quickly (I tried 600 ms, then 1.5 s) also misfired on this gap, reporting "settled"
   immediately after first paint on a run that was independently confirmed (by raw request
   logging) to still have one CSV fetch left to make. Playwright's own
   `waitForLoadState('networkidle')` has the identical failure mode for the identical reason,
   confirmed by trying it too.
2. **The fix that held up: use both signals together, in the two regimes each one is actually
   reliable for.** Watch the `LoadProgress` phase text with no fixed quiet window, but only ever
   treat its disappearance as completion *after* it has been seen present at least once -- correct
   and sufficient on a cold load, which shows real, multi-second phases with no risk of being
   missed between 100 ms polls. For the case that text handles badly -- a load finishing faster
   than the poll interval -- fall back on the network ground truth: once a generous grace period
   (3 s) has passed since first paint with the phase text never once observed *and* zero CSV
   fetches counted, that is a genuine, instant cache hit, and first paint is the completion time.

This is implemented in `scripts/perf/emis-run.js` (`loadAndWatchNetwork`), kept in the repository
specifically so this reasoning doesn't have to be reconstructed from scratch next time.

### What this means for the budget

Both cold and warm are comfortably inside the ~60 s budget (9.3 s and 5.1 s respectively), and
the warm figure is a real, meaningful improvement over cold -- unlike the previous version of this
note claimed. It does not match spec 4.1's own warm figure of 4.6 s exactly, but it is the same
order of magnitude and the same finding: a cache hit here means skipping the SQL-view fetches
entirely, not merely revalidating them cheaply.

*(Caveat on "cold": the very first restart this fix round did was followed by several other
measurements -- text search, bulk batches, a raw write -- before the dashboard was re-measured, so
that instance's Postgres was no longer buffer-cache-cold by the time of that particular reading.
The 9.29 s cold figure above is from a **second, dedicated restart** done immediately before that
specific run, with nothing else touching the instance in between -- genuinely cold on both
Postgres and the browser. This distinction is the m1 minor from the review; it is called out
explicitly here rather than left for a reader to guess at.)*

## Opening the 266,396-object set

"Ownership Public/Private" (compulsory, data dimension, 3 groups) is the one set whose
population is the entire org unit hierarchy -- 266,396 objects, confirmed by the Objects tab's
own count text. Timed from clicking the card to the `[data-test="objects-table-scroll"]`
container being present *and* the row-count text reading "266,396 objects" (i.e., not just the
first virtualised page, the whole population resolved).

**0.2 s** (three measurements across two rounds: 195 ms, 215 ms, 201 ms -- the third figure is the
review's own independent re-measurement, which reproduced to within 6 ms), against a warm engine
(the set's data was already loaded as part of the dashboard load above -- GroupSetDetail's Objects
tab does not re-fetch from DHIS2, it queries the already-loaded in-memory engine per spec 4.3's
"linear passes ... return in milliseconds"). This is the number that confirms the engine design's
central claim: once data is loaded, querying it -- even for a quarter-million rows -- is not a
bottleneck at all.

## Text search (Plan 3's new path, first run at this scale)

Also queried against the engine's already-loaded 266,396-row population, via the Objects tab's
debounced search field (`ObjectFilter.text`, a case-insensitive substring match against display
names -- CLAUDE.md, `src/engine/queries.ts`). Timed from `fill()` to the "N objects" counter
text becoming stable (unchanged for >=400 ms), which is later than the 300 ms UI debounce alone,
so this includes the debounce, the worker round-trip, and the render.

| Query | Matches | Settle time |
| --- | --- | --- |
| `"OrgUnit A"` (many) | 10,339 of 266,396 | 442-448 ms (review's re-measurement: 417 ms) |
| `"OrgUnit A0"` (a handful) | 172 of 266,396 | 439-460 ms (review's re-measurement: 429 ms) |

Both settle in under half a second, and the match count barely matters (10,339 vs 172 cost the
same) -- consistent with the design: the predicate is a single linear pass over the loaded
`namesLower` array (`listObjects` in `src/engine/queries.ts`), so its cost is the population size,
not the result size. This is the answer to the brief's specific ask: Plan 3's engine-side text
search does not become a bottleneck at 266k rows. Both match counts reproduced exactly on
independent re-measurement.

## Bulk preview (fast) vs. bulk apply (the actual budget risk)

Opened via the group set detail header's "Fix issues..." button (spec 5.2/5.3) on "School Level"
(4 groups, not compulsory, but with heavy existing conflicts/missing on this instance --
60,881 conflicts + 189,379 missing out of 266,396, per the dashboard snapshot at measurement
time). Action: "Assign all to one group" -> "Basic Education". The resulting plan: **77,017**
objects affected -- Basic Education +60,968 / JSS -15,620 / Others -567 / SSS -37 (read directly
off the dialog's own per-group summary).

**Preview: 0.14-0.15 s** (two runs: 140 ms, 145 ms), timed from clicking "Next" to the plan
rendering -- using the appearance of the "Download full list as CSV" button as the completion
signal, since `BulkFixDialog.tsx` only renders it once `step === 'preview' && plan` is true, i.e.
the plan has genuinely resolved, not a fixed-timeout guess. This is another confirmation of the
"engine queries are linear passes, milliseconds" design claim (spec 4.3), this time for a
larger-than-single-query operation (building a full change plan, not just filtering a list).

**Apply was not run for real against this plan** -- doing so would leave 77,017 real membership
changes on a shared instance that must stay usable for other work, reversible only through one
more `write()` chain of a similar size. Per the brief's own allowance ("measure enough batches to
extrapolate honestly"), the cost was instead measured directly at the unit the apply path actually
works in -- `writeMemberships` in `src/data/writes.ts` splits every group's change into batches of
`batchSize = 1000` ids and sends them **sequentially**, one `POST
{endpoint.groups}/{groupId}/{endpoint.members}` per batch, awaited one at a time (no
concurrency) -- so total apply time is the straightforward sum of each batch's server-side cost.

**Batch cost, measured directly against the live server with `curl` (no app, no browser, so this
isolates the server-side cost the app's own apply path would pay per request).** *(Fix round 2
correction: two of the four rows below were originally labelled "1000 ids" when they were in
fact single-id writes -- digit-for-digit the review's own single-id measurements, reused here
without checking what they had actually sent. Every row is now labelled with what it actually
measured; the 1000-id Private figures are the review's own re-measurement, attributed as such.)*

| Group (current size) | Operation | Batch size | Time |
| --- | --- | --- | --- |
| Basic Education (91,892 members) | add | 1000 ids | 6.02 s, 5.99 s |
| Basic Education (91,892 members) | delete the same ids back out | 1000 ids | 6.78 s, 5.63 s |
| Private (136,538 members) | delete | 1000 ids | 5.99 s, 7.63 s *(review's re-measurement)* |
| Private (136,538 members) | add the same ids back | 1000 ids | 9.07 s, 6.92 s *(review's re-measurement)* |
| Private (136,538 members) | delete | 1 id | 7.29 s, 6.98 s *(review's original measurement, mislabelled as 1000 ids in the previous version of this note)* |
| Private (136,538 members) | add the same id back | 1 id | 7.13 s, 7.27 s *(review's original measurement, mislabelled as 1000 ids in the previous version of this note)* |

Every one of these writes was reverted immediately afterward (the inverse operation on the same
ids), and the affected groups' member counts were confirmed back at their original values via the
API before moving on -- `O1hqU8q6iea` (Basic Education) reads 91,892 members both before and after.

**What the corrected table actually establishes, and what it does not:**

- **Batch-size independence, on one group:** on Private, a 1-id write (6.98-7.29 s) and a
  1000-id write (5.99-9.07 s) cost about the same. This is the comparison that matters for the
  extrapolation below -- it is what licenses treating "cost per batch" as roughly constant
  regardless of how many ids are in it, and it is now an honest same-group comparison, not one
  confounded with a group-size difference.
- **Group-size scaling is a hypothesis, not a measured fact here** (fix round 2 correction: the
  previous version of this note stated "the cost tracks the group's current size, not the
  batch's" as an established finding and an "operating assumption" for future readers. It isn't
  established by this data: Private's observed range (5.99-9.07 s) and Basic Education's
  (5.63-6.78 s) overlap, on small sample counts (6 and 4 measurements respectively), so this note
  cannot say the larger group is genuinely slower per batch -- only that both land in the same
  6-9 s neighbourhood. A Hibernate collection-materialisation cost that scales with the target
  group's existing size is a plausible mechanism and would explain a difference this small a
  sample could easily miss, but it is a hypothesis for someone to test with a controlled
  same-batch-size, many-group comparison, not something to build on as established.

**Extrapolating the School Level plan from these batch costs** (79 batches, computed from
`writeMemberships`'s own sequential, 1000-id-per-group batching in `src/data/writes.ts` -- no
concurrency, one `POST` per batch, awaited in order):

- Basic Education: 60,968 additions -> `ceil(60968 / 1000)` = **61 batches**
- JSS: 15,620 deletions -> **16 batches**
- Others: 567 deletions -> **1 batch**
- SSS: 37 deletions -> **1 batch**
- **Total: 79 batches**, sent sequentially with no retry or overlap in the ordinary case.

At 6-9 s per batch (the full range actually measured across every row of the corrected table
above, 1-id and 1000-id alike), 79 batches extrapolate to **474-711 s -- roughly 8 to 12
minutes**, against the ~60 s budget.

**8-12 minutes is a floor, not a midpoint.** The 6 s figure that anchors the low end of that
range was measured against Basic Education at its *starting* size, 91,892 members. Basic
Education's own 61 batches in this plan are all additions to itself, so by the last of those 61
batches the group holds roughly 91,892 + 60,968 = **152,860** members -- if the group-size-scaling
hypothesis above is even partly right, the later batches in this plan cost more than the 6 s
measured at the smaller, starting size, not the same. Nothing measured here quantifies how much
more, so this note does not attempt a corrected midpoint -- but a reader should treat 8-12
minutes as the fastest this plausibly goes, not the middle of the real range.

Even taking only the Basic Education additions alone (61 batches at the low end of the range,
~6 s each) is already **~366 s, over 6x the budget by itself**, before any of the other three
groups' batches are even counted, and before any growth-during-the-run effect.

**This is the real, previously unnamed budget risk in the app.** The preview step (0.14 s) gives
no hint of this cost at all, because it only computes the plan; every second of the actual apply
time is server round trips the preview never makes. A bulk fix over a small number of objects
would stay well inside budget regardless of mechanism -- the cost here is specific to this
instance's unusually large groups (tens to hundreds of thousands of members each), which is
exactly the scale this task exists to check. What this note can say with confidence: cost is
roughly (batch count) x (6-9 s), where batch count comes straight from `writeMemberships`'s own
1000-ids-per-group splitting: `ceil(additions / 1000) + ceil(deletions / 1000)` per group,
summed across every group the plan touches. Whether the *target* group's existing size pushes
that per-batch figure higher still is a real, plausible hypothesis (see above) that this note's
data does not confirm -- whoever picks this up should budget a bulk apply against a large group
using the 6-9 s range as a starting point, verify it against the specific group in question
before relying on it, and treat 8-12 minutes for this plan as a floor rather than a promise, per
the growth-during-the-run point above. There is nothing to fix quietly here per the brief, only a
number -- and its uncertainty -- to report, which this section now does.

## One small write, then revert

Target: a single organisation unit (`A00FRQD5VJZ`), confirmed via the API beforehand to hold no
membership in "Ownership Public/Private" (so this is a real, meaningful change, not a no-op
re-click of the object's current group). Flow: Objects tab -> search for the exact object ->
click the "Private" segmented button -> confirm in the "Confirm group change" modal ("Assign") --
this confirm step is required; `MembershipControl`'s segmented button alone does not write
anything, contrary to what I first assumed while building this measurement (a first attempt that
clicked the segment directly, with no confirm, produced no write and no History entry at all --
worth flagging in case a future test author makes the same assumption).

Completion signals, following `e2e/flows.spec.ts`'s own documented technique
(`waitForWriteToSettle`): the segmented button disables the instant the write starts and
re-enables only once `write()` has fully resolved.

| Step | Time |
| --- | --- |
| Click "Assign" in the confirm modal -> button re-enabled (write settled) | **8.43 s** (review's re-measurement of the same object/group: 10.09 s) |
| History -> Revert -> "All changes applied to..." (revert settled) | **13.56 s** |

Both verified against the server afterwards: `GET /api/organisationUnits/A00FRQD5VJZ` shows no
Ownership Public/Private group (back to its pre-test state), and `GET
/api/dataStore/group-set-integrity` lists two history entries (the write, then the revert as its
own recorded change set) -- matching CLAUDE.md's "revert ... is itself recorded as a new change
set".

**Correction (M2 in the review): the mechanism named for this cost was wrong, and it pointed at
the wrong code.** The original note attributed the 8.4 s to the app's own client chain --
speculating that `write()` does "a full sequential chain -- server PUT, then a real engine
reload/recompute, then cache, then a datastore save -- rather than an in-place patch". That is not
what the code does (`useMembershipWrite.write()` calls `client.call('applyChangeSet', ...)`, an
in-place engine patch, then one IndexedDB `invalidateType` delete and `saveChangeSet` -- no reload,
no recompute of the 266k population), and it is not where the time goes. Measured directly with
`curl`, entirely outside the app, against the same object and the same target group
(`organisationUnitGroups/RYChRe8PgA6/organisationUnits`, one addition): **8.73 s and 8.70 s** for
the raw server POST alone. The review's own network trace of the in-app write shows the server
response landing, then the change-set history `PUT` completing well under a second later.

So the dominant term in both the 8.4-10.1 s write and the 13.6 s revert is **DHIS2's own
collection-update endpoint working against a very large group's membership collection**, not
anything this app's client code does. This is consistent with, and now explained by, the bulk-
apply extrapolation above: single writes and bulk-apply batches pay the same per-request server
cost, because they go through the same endpoint. A reader following up on this finding should look
at the server-side cost of `POST .../organisationUnitGroups/{id}/organisationUnits` against a
large group, not at `useMembershipWrite` or anything else in this app's own write path.

## Summary against budget and spec 4.1

| Measurement | Result | vs. ~60 s budget | vs. spec 4.1 baseline |
| --- | --- | --- | --- |
| SQL view creation | 1.9 s (14.1 s incl. page load) | well inside | not previously measured |
| SQL-view raw fetches (curl, no app) | 1.01 s / 2.51 s / 0.50 s (org units / memberships / names) | well inside | consistent with 4.1's 2.0 s / 3.5 s figures |
| Dashboard load, cold | 9.29 s (dedicated cold run) | well inside | slower than 4.1's 44.4 s baseline is not a valid comparison (different scope: whole dashboard vs. raw fetch only) -- but well inside budget either way |
| Dashboard load, warm | **5.08-5.12 s, zero data fetches** | well inside | close to 4.1's 4.6 s warm figure, same finding: warm skips the fetch entirely |
| Open 266,396-object set | 0.2 s | well inside | consistent with spec 4.3's "milliseconds" claim |
| Text search, many matches (10,339) | 0.44 s | well inside | new in Plan 3, not previously measured |
| Text search, handful (172) | 0.45 s | well inside | new in Plan 3, not previously measured |
| Bulk preview (77,017-object plan) | 0.14 s | well inside | consistent with spec 4.3 |
| **Bulk apply of that same plan (extrapolated from measured batch costs, not run in full)** | **~8-12 minutes floor (79 batches x 6-9 s; likely more, since the target group grows during its own batches)** | **8-12x+ OVER budget** | not previously measured; this is the finding this round adds |
| Single write | 8.4-10.1 s | inside, but the dominant cost is server-side, not the app (see above) | not previously measured at this scale |
| Single write's revert | 13.6 s | inside, same server-side cost applies | not previously measured |

No number in spec 4.1 itself needs correcting; the app's own SQL-view fetch times are consistent
with it. The finding this round adds is the bulk-apply extrapolation, which spec 4.1 has no
corresponding figure for at all.

## Verification

`pnpm test`, `pnpm exec tsc --noEmit`, `pnpm exec eslint src`, and `pnpm exec prettier -c .` were
run from the repository root after this measurement work (both the original run and this fix
round); all four clean both times. `scripts/perf/emis-run.js` is the one piece of measurement code
now kept in the repository (see the review's m4); everything else (the set-open/search/bulk/write
driver) remains an unshipped, throwaway script for lack of time to fold it in this round.

The instance was stopped again (`POST .../instances/agent-gsi-emis/stop`) after this fix round's
measurement work completed, and its state was confirmed clean first: `O1hqU8q6iea` (Basic
Education) back at 91,892 members, `A00FRQD5VJZ` still in no Ownership Public/Private group, and
`GET /api/dataStore/group-set-integrity` still listing exactly the two history entries from the
original run (the write and its revert) -- nothing this round's `curl`-driven batch tests did
(all reverted directly, outside the app, since they were never applied through it) left a trace
in the app's own history.
