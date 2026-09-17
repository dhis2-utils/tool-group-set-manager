# Carried forward from Plan 7: found, recorded, not fixed


> ## Status after Plan 10
>
> **§4 stays records, not work.** `lastupdated-probe.js` never
> committed, `write-shapes.js`'s non-neutral `restore`, and the
> `pg_stat_database` measurement caveat are not defects to fix -- they
> are notes for whoever next needs to measure the same things. Moved
> into `OPEN-ITEMS.md`'s "Records, not work" section verbatim; nothing
> else in this file changed.

> ## Status after the Plan 9 cleanup pass
>
> **Closed:** §1 (the e2e cleanup net — see
> `2026-09-plan5-carry-forward.md` §2); §4's stale Chromium path, which now
> resolves an installed browser instead of naming one; §4's unassociated
> `InputField` labels, which now pass `name`. §4's `agent-gsi-p2-40` Kambia
> conflict is no longer a loose end: the cleanup net deliberately preserves
> it, and says so in code.
>
> **Still open:** §2 and §3 are closed by Plan 8 (noted there). §4's
> uncommitted `lastupdated-probe.js`, the non-neutral `write-shapes.js`
> restore, and the `pg_stat_database` measurement caveat all stand as
> records for a future measurement rather than work items.

Plan 7 (fixing — spec §6 then §5) is complete. All eight tasks landed. This
note records what was found along the way and deliberately left, plus the
items from earlier plans that are still open after it.

Nothing here is a known-broken behaviour except where it says so.

## 1. Still open from Plan 5: the e2e suite has no cleanup net — FIXED (Plan 9)

**Closed.** See `2026-09-plan5-carry-forward.md` §2 for the net and how both
halves were verified. The evidence this section gathered is what shaped it:
because a failure between write and revert is the case that matters, the net
restores against a snapshot rather than a journal of what each test wrote.

**Original entry, kept for provenance:**


`2026-09-plan5-carry-forward.md` §2, and **this plan is the strongest evidence
yet for fixing it**. Task 1 found that the three "failing" write/revert flows
were failing for *two* reasons at once, and the second was the missing cleanup
net: a flow that fails between its write and its revert leaves the shared
instance in exactly the state that fails the *next* run's precondition, so one
failure becomes permanent. That is what hid the real defect — every run was
failing on a precondition and never reaching the symptom under investigation,
for long enough that the carry-forward note recorded the wrong symptom.

It also caused §3's data anomaly on `agent-gsi-p2-40`, which sat unexplained
across two plans and turned out to be one aborted `bulk move` leaving its
three objects behind.

Still not fixed here, for the reason Plan 5 gave: a suite-wide `afterEach`
against shared instances is its own design question (what to revert, how to
know what this run wrote, what to do when cleanup itself fails). But it is no
longer only a tidiness concern — it has now twice cost real investigation time
and once produced a wrong diagnosis in a written note.

## 2. `writes.ts` batch size 5000 is where the measurement stopped, not an optimum

`DEFAULT_BATCH_SIZE` is 5000 because that is the largest of the three sizes
§6.2 named, and it met the budget. **The trend had not turned**: 250 → 1000 →
5000 improved monotonically on both elapsed time and server work per object,
so 10000 might well be better still. It was not measured.

Not pursued because 5000 already meets §6.1's ~60-second budget with room to
spare (~40s at the stated population), and because payload size and request
timeouts become a real consideration somewhere above it that nobody has
probed. Anyone revisiting this should measure rather than assume, and should
measure the failure modes (413, proxy timeout) as well as the timings.

## 3. The metadata import shape is faster and much cheaper, and is not used

This is the deliberate outcome of §6.4, not an oversight, but it is worth
carrying forward because the numbers are striking and someone will ask.

One `POST metadata?importStrategy=UPDATE` wrote 91,892 memberships in **18.2s
using 2 requests and 3.1 rows fetched per object**, against the adopted
batched path's 47.4s, 20 requests and 19.5 rows per object. It is better on
every axis measured.

It is not adopted because its concurrency guard cannot be built on 2.41, 2.42
or 2.43 (`2026-09-plan7-lastupdated-guard.md`), and replacing a whole
collection without one is silent data loss. **If DHIS2 ever bumps a group's
`lastUpdated` on a collection-endpoint membership write again — it did on 2.40
— this decision should be revisited immediately**, because the only thing
standing between the app and a 2.6× faster, 6× cheaper write path is that one
missing signal.

## 4. Smaller things, recorded so they are not rediscovered

- **`lastupdated-probe.js` was not committed.** It lives only in this
  session's scratchpad; its discriminating part is reproduced verbatim in
  `2026-09-plan7-lastupdated-guard.md` §5. The reasoning is that it answers a
  question about DHIS2 versions rather than about this app, and the answer is
  now written down — but if 2.44 needs probing, that note is where to start.
- **`scripts/perf/write-shapes.js`'s `restore` uses the metadata import
  shape**, which is one of the shapes under test. It is not a neutral restore.
  It never falls inside a measured interval (the timer starts after it
  returns), but a future run investigating an import-specific fault must not
  use it to set up.
- **Server cost was measured with `pg_stat_database`, not `docker stats`.**
  The sandbox has no access to the host's Docker daemon. This loses Tomcat's
  own CPU and JVM GC. For the question at hand (collection re-reads) it is
  arguably the better instrument, but a future measurement that cares about
  application-server cost will need another route.
- **The e2e config's pinned Chromium path is stale.**
  `e2e/playwright.config.ts` defaults to
  `/opt/playwright-browsers/chromium-1243/chrome-linux-arm64/chrome`; this
  image ships `chromium-1234` at `chrome-linux/chrome`. Every test fails at
  launch until `PLAYWRIGHT_CHROME_PATH` is exported. The env-var escape hatch
  works and was used for every run in this plan, so nothing is broken — but
  the default is wrong for the current image and the next person will lose the
  same ten minutes. `emis-run.js` already solved this properly, with
  `chromium.executablePath()`; the config should do the same.
- **`InputField`'s label associates with nothing unless `name` is passed.**
  The two new catch-all name fields pass it. `History.tsx`'s "Note for History
  (optional)" and `BulkFixDialog`'s own note field do not, so those labels
  name no control and a screen reader announces an unlabelled text box. Not
  fixed here — out of this plan's scope — but it is a one-word fix per field.
- **`agent-gsi-p2-40` has `Kambia` in both "Western Area" and "Eastern
  Area"**, a real conflict in the Area set. Left alone; see
  `2026-09-plan5-carry-forward.md` §3 for why, and what to check before
  treating it as either damage or seed.

## Still open from earlier plans

- `2026-09-plan5-carry-forward.md` — §1 and §3 are now **answered and fixed**
  (Plan 7 Tasks 1 and 8). §2 (no cleanup net) is still open and is §1 above.
  Its remaining sections stand.
- `2026-09-plan6-carry-forward.md` — **entirely unchanged.** Plan 7 touched
  none of it, as it said it would not. Its §1 ("three things a later plan
  touching this code should fix first") is still the right place to start for
  anyone in `useUsage.ts` or the usage SQL view.
