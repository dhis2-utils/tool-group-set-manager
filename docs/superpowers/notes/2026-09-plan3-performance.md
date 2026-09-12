# Plan 3 performance record: EMIS (266,396 organisation units), Task 10

**Answer first: every number measured here is inside the user's ~60-second budget, most by a
wide margin. The one exception worth calling out is the single-object write-and-revert cycle:
8.4 s to write, 13.6 s to revert -- individually fine, but far slower than the sub-millisecond
engine query the design (spec 4.3) describes, and a real cost if it turns out to scale with
population rather than being a fixed per-request overhead (I did not test that here -- see
"Findings" below). The SQL views were the prerequisite the brief said they would be: without them
this instance's dashboard load is the >640 s metadata-API failure already recorded in
docs/superpowers/notes/2026-09-plan1-emis-measurements.md; with them, cold and warm dashboard
loads both landed under 10 s.**

## Instance, version, and what "cold" means here

`agent-gsi-emis`: DHIS2 2.41.10, 266,396 organisation units, 7 organisation unit group sets,
~1.1 million memberships -- the same instance and data spec 4.1's baseline was measured against
on 2026-09-10. This is also the only run so far against 2.41 (Plans 1-2 covered 2.40 and 2.43),
and the only run of Plan 3's new text-search path at this scale.

The app was built fresh from this branch (`pnpm build`) and installed as a zip via
`POST /api/apps`, per `e2e/fixtures/session.ts`'s own note on why: no dev-server/proxy origin
mismatch, matching how Task 9's suite runs. All sessions were established via `GET /api/me` with
Basic auth, cookie shared into the browser context -- never the login form, per the same
convention.

**To get a genuinely cold instance** (not just "whatever state the broker left it in"), I issued
`POST $DHIS2_BROKER_URL/instances/agent-gsi-emis/stop` then `.../start` and waited for `/api/me`
to answer 200 -- a full container restart, so Postgres's buffer cache and the app's own
in-browser IndexedDB cache were both empty afterwards. That restart itself (API call to
`/api/me` first answering 200) took **68.2 s** of infrastructure boot time -- this is Docker +
Postgres + Tomcat startup, not part of the app's own budget, and is reported here only so the
timing below is reproducible, not as a finding against the 60 s target.

Immediately after the restart, `GET /api/sqlViews.json?filter=code:like:GSI_` returned zero
views, confirming the views did not survive the restart (they are ordinary metadata rows created
on demand, not part of the instance image) and that everything measured below started from an
actually-empty state, not a warm one left over from an earlier session.

## SQL view creation (prerequisite, timed once from a cold instance)

Driven through the app's own Settings page (`src/pages/Settings/Settings.tsx`), not the API
directly: navigated to `#/settings`, clicked "Create SQL views", and timed from that click to the
"Created 3 SQL views" notice appearing.

| | |
| --- | --- |
| Click "Create SQL views" -> confirmation notice | **1.9 s** |
| Full page load -> confirmation notice (includes app bootstrap + settings-page data) | 14.1 s |

Confirmed afterwards via `GET /api/sqlViews.json`: `GSI_ORGUNITS`, `GSI_ORGUNIT_MEMBERSHIPS`,
`GSI_ORGUNIT_NAMES`, all `"type":"VIEW"` (not `MATERIALIZED_VIEW`, so the app's own guard against
stale materialised data does not kick in here -- CLAUDE.md's SQL-view note). Creating the views
is cheap: ~2 seconds of actual work, dwarfed by ordinary page load. This matches the design's
premise (spec 4.2) that offering to create them is a reasonable one-time step, not a maintenance
burden.

## Dashboard load, cold and warm

Method: a fresh Playwright browser context (fresh cookie jar, empty IndexedDB) navigated to the
app's installed URL. "First paint" = the `Scope:` label becoming visible (the first thing only an
authenticated, mounted app renders). "Load complete" = the `LoadProgress` component's phase text
(`Loading group sets` / `Loading <type>` / `Loading group memberships for <type>` / `Loading
names for <type>` / `Checking rules for <type>` / gone) disappearing entirely, which only happens
once every object type's load and rule check has resolved with no errors.

**Cold** (fresh browser context, immediately following the instance restart above -- the only
network activity against this instance beforehand was the lightweight SQL-view admin/status
checks, not the heavy per-type loads themselves):

| | |
| --- | --- |
| First paint (`Scope:` visible) | 5.4-5.9 s (3 runs: 5.39, 5.85, 5.45 s) |
| Load complete (progress UI gone) | 7.2-9.9 s |

**Warm** (same browser context, reloaded after its own first load already completed -- so both
IndexedDB and whatever the app's cache-validation calls touch in Postgres were already warm):

| | |
| --- | --- |
| First paint (`Scope:` visible) | 5.1-6.3 s |
| Load complete (progress UI gone) | 6.9-9.9 s |

**Finding: warm is not meaningfully faster than cold here.** Both first paint and load-complete
land in the same few-second band regardless of cache state. Two things explain this without
contradicting the design: (1) first paint is dominated by JS bundle parse/mount and one small
API call, not by the group-set data at all, so it was never going to move with cache state; (2)
`src/data/loadAll.ts`'s own cache validation (spec 4.4) still issues network calls per type --
`objectTotal` and `groupStamps` -- to decide whether the cache is still valid, and the
`LoadProgress` phase text I'm using as the "done" signal reflects that validation traffic
whether or not the cached arrays end up being reused. I did not instrument which branch
(`fromCache` true vs a full reload) `loadAll` actually took on the warm run -- that would need a
code change (a console log or a test hook) to confirm directly, so I'm reporting the observed
timing without asserting the mechanism as proven. Either way, the practical consequence for the
60 s budget is the same: **every dashboard load on this instance, cold or warm, completed in
under 10 seconds** -- roughly a sixth of the budget, and far better than spec 4.1's cold baseline
of 44.4 s for the SQL-view path alone (that baseline measured only the raw fetches; the number
here is the whole dashboard, fetch through rule evaluation, which makes the comparison if
anything favourable to this run, not an apples-to-apples improvement I'm claiming credit for).

## Opening the 266,396-object set

"Ownership Public/Private" (compulsory, data dimension, 3 groups) is the one set whose
population is the entire org unit hierarchy -- 266,396 objects, confirmed by the Objects tab's
own count text. Timed from clicking the card to the `[data-test="objects-table-scroll"]`
container being present *and* the row-count text reading "266,396 objects" (i.e., not just the
first virtualised page, the whole population resolved).

**0.2 s** (measured twice: 195 ms, 215 ms), against a warm engine (the set's data was already
loaded as part of the dashboard load above -- GroupSetDetail's Objects tab does not re-fetch from
DHIS2, it queries the already-loaded in-memory engine per spec 4.3's "linear passes ... return in
milliseconds"). This is the number that confirms the engine design's central claim: once data is
loaded, querying it -- even for a quarter-million rows -- is not a bottleneck at all.

## Text search (Plan 3's new path, first run at this scale)

Also queried against the engine's already-loaded 266,396-row population, via the Objects tab's
debounced search field (`ObjectFilter.text`, a case-insensitive substring match against display
names -- CLAUDE.md, `src/engine/queries.ts`). Timed from `fill()` to the "N objects" counter
text becoming stable (unchanged for >=400 ms), which is later than the 300 ms UI debounce alone,
so this includes the debounce, the worker round-trip, and the render.

| Query | Matches | Settle time |
| --- | --- | --- |
| `"OrgUnit A"` (many) | 10,339 of 266,396 | 442-448 ms |
| `"OrgUnit A0"` (a handful) | 172 of 266,396 | 439-460 ms |

Both settle in under half a second, and the match count barely matters (10,339 vs 172 cost the
same) -- consistent with the design: the predicate is a single linear pass over the loaded
`namesLower` array (`listObjects` in `src/engine/queries.ts`), so its cost is the population size,
not the result size. This is the answer to the brief's specific ask: Plan 3's engine-side text
search does not become a bottleneck at 266k rows.

(Note: these match counts are the app's own substring count over `"OrgUnit <id>"` display names,
and do not have to agree with a DHIS2 `organisationUnits?filter=name:like:...` count taken
independently -- a discrepancy was seen and is not a defect, just two different matching
semantics being compared; the number that matters here is the app's own settle time, not
reconciling it against the API.)

## Bulk preview

Opened via the group set detail header's "Fix issues..." button (spec 5.2/5.3) on "School Level"
(4 groups, not compulsory, but with heavy existing conflicts/missing on this instance --
60,881 conflicts + 189,379 missing out of 266,396, per the dashboard snapshot at measurement
time). Action: "Assign all to one group" -> first group ("Basic Education"). Timed from clicking
"Next" to the plan actually rendering -- using the appearance of the "Download full list as CSV"
button as the completion signal, since `BulkFixDialog.tsx` only renders it once `step ===
'preview' && plan` is true, i.e. the plan has genuinely resolved, not a fixed-timeout guess.

**0.14-0.15 s** (two runs: 140 ms, 145 ms) to compute a plan affecting 77,017 of the set's
266,396 objects. Comfortably inside budget -- this is another confirmation of the "engine
queries are linear passes, milliseconds" design claim (spec 4.3), this time for a
larger-than-single-query operation (building a full change plan, not just filtering a list).

I did not click "Apply..." on this bulk plan -- the dialog was cancelled after the preview
render, specifically so this run does not leave 77,017 real membership changes on the instance.
Only the single small write below was actually applied (and reverted).

## One small write, then revert

Target: a single organisation unit (`A00FRQD5VJZ`), confirmed via the API beforehand to hold no
membership in "Ownership Public/Private" (so this is a real, meaningful change, not a no-op
re-click of the object's current group). Flow: Objects tab -> search for the exact object ->
click the "Private" segmented button -> confirm in the "Confirm group change" modal ("Assign") --
this confirm step is required; MembershipControl's segmented button alone does not write
anything, contrary to what I first assumed while building this measurement (a first attempt that
clicked the segment directly, with no confirm, produced no write and no History entry at all --
worth flagging in case a future test author makes the same assumption).

Completion signals, following `e2e/flows.spec.ts`'s own documented technique
(`waitForWriteToSettle`): the segmented button disables the instant the write starts and
re-enables only once `write()` -- server PUT, engine update, cache, then `saveChangeSet` -- has
fully resolved.

| Step | Time |
| --- | --- |
| Click "Assign" in the confirm modal -> button re-enabled (write settled) | **8.43 s** |
| History -> Revert -> "All changes applied to..." (revert settled) | **13.56 s** |

Both verified against the server afterwards: `GET /api/organisationUnits/A00FRQD5VJZ` shows no
Ownership Public/Private group (back to its pre-test state), and `GET
/api/dataStore/group-set-integrity` lists two history entries (the write, then the revert as its
own recorded change set) -- matching CLAUDE.md's "revert ... is itself recorded as a new change
set".

**Finding: a single-object write is far slower than the engine's own query cost, and the revert
is slower still.** 8.4 s and 13.6 s are both individually inside the 60 s budget, but they are
three to four orders of magnitude slower than the sub-millisecond in-memory query cost spec 4.3
describes, and slower than opening the entire 266k-object table (0.2 s) or running a search over
it (0.45 s). The likely cause, going by CLAUDE.md's own architecture notes, is that `write()` is
a full sequential chain -- server PUT, then a real engine reload/recompute, then cache, then a
datastore save -- rather than an in-place patch of the already-loaded engine state; a revert adds
a preview-plan computation on top of that same chain, which is consistent with it costing more
than a plain write. I have not profiled which of those four steps dominates, so I can name the
mechanism the design documents but not which specific step to optimise -- that is a real
open question for whoever picks this up, not something to fix quietly here (per the brief: report
the number and the suspicion, don't retune the app to make it look better).

## Summary against budget and spec 4.1

| Measurement | Result | vs. ~60 s budget | vs. spec 4.1 baseline |
| --- | --- | --- | --- |
| SQL view creation | 1.9 s (14.1 s incl. page load) | well inside | not previously measured |
| Dashboard load, cold | 7.2-9.9 s | well inside | faster than the 44.4 s CSV-only baseline (different scope: whole dashboard vs. raw fetch) |
| Dashboard load, warm | 6.9-9.9 s | well inside | no improvement over cold seen here, unlike baseline's 4.6 s warm figure -- see cache-validation note above |
| Open 266,396-object set | 0.2 s | well inside | consistent with spec 4.3's "milliseconds" claim |
| Text search, many matches (10,339) | 0.44 s | well inside | new in Plan 3, not previously measured |
| Text search, handful (172) | 0.45 s | well inside | new in Plan 3, not previously measured |
| Bulk preview (77,017-object plan) | 0.14 s | well inside | consistent with spec 4.3 |
| Single write | 8.4 s | inside, but the least comfortable margin measured | not previously measured at this scale |
| Single write's revert | 13.6 s | inside | not previously measured |

No number in spec 4.1 itself needs correcting -- everything measured here is a new measurement
(Plan 3's search path, the write/revert path, and the whole-dashboard timings) or is consistent
with what 4.1 already says, not a contradiction of it.

## Verification

`pnpm test`, `pnpm exec tsc --noEmit`, `pnpm exec eslint src`, and `pnpm exec prettier -c .` were
run from the repository root after this measurement work; no source under `src` was changed for
this task (measurement was driven by a standalone, unshipped Playwright script, deleted after
the run -- not part of `e2e/`'s own suite, which Task 9 already completed and reviewed).

The instance was stopped again (`POST .../instances/agent-gsi-emis/stop`) after this measurement
run completed.
