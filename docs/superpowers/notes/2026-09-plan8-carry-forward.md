# Carried forward from the metadata freshness work: found, recorded, not fixed

The metadata freshness branch (spec
`2026-09-16-metadata-freshness-design.md`) is complete. Every item below was
found during it by a task review or the final whole-branch review, confirmed,
and deliberately left. The final review triaged all of them; nothing here
blocks merge.

Nothing in this list is a known-broken behaviour except where it says so.

## 1. The two with teeth

- **No failing JSON Patch was ever observed, so `response.ok` is an unproven
  success signal.** The measurement that adopted JSON Patch
  (`2026-09-plan8-json-patch.md`) only ever induced *successful* patches — no
  bad member id, no insufficient authority — so the status code DHIS2 returns
  on a *rejected* members patch is recorded nowhere. `response.ok` is correct
  on all available evidence and matches `setGroupSetProperties` on the same
  endpoint family, and this is not a regression (the metadata import it
  replaced gave no protection against silently dropped ids either).

  But a false success is not only a misreport: `useMembershipWrite` writes a
  History row for it, and a later Revert would act on changes that never
  landed. **One verify-style run against an invalid member id closes this, and
  it should happen before this path is pointed at national-scale data.**

- **A hung re-read leaves the bulk fix modal genuinely unclosable.** The
  fetcher sets no timeout or abort, and `checkingFreshness` disables Cancel,
  Back and the modal's own close affordance for the duration — which is the
  correct fix for the double-write and cancel-during-read defects it was added
  for, but leaves no escape hatch if the request never settles. No data is at
  risk (nothing has been written) and a page reload recovers.

  When adding the timeout: an `AbortController` on the fetch alone is **not
  enough**. `client.call('setGroupMembers')` and `client.call('planAssignment')`
  sit inside the same `try` and hang the same way.

## 2. Test gaps

None of these is a failing test; each is a place a passing suite would not
notice a regression.

- **`FilterBar`'s `status` prop has no unit test.** It is the one shared,
  two-consumer file this work changed, and `MetadataFreshness.test.tsx`
  renders the component standalone rather than inside `FilterBar`, so nothing
  exercises the two together. The e2e flow does assert the indicator inside
  `[data-test="filter-bar"]` and ran 9/9 on both supported versions, so the
  integration is covered where it counts — but not in units.
- **No test covers `onProgress` across a mixed patch-plus-batch write.** Each
  route's accounting is tested alone.
- **Nothing asserts `cache: 'no-store'` or the re-read URL shape** in
  `readPatchRouteGroups`; both verified by inspection only.
- **The key-order protection in `patchChange` is unpinned** — no test returns
  a members key from the field read. Correct in code, untested.

## 3. Smaller things, recorded so they are not rediscovered

- **`e2e/playwright.config.ts` pins a Chromium build that no longer exists in
  the sandbox image.** It defaults to
  `/opt/playwright-browsers/chromium-1243/chrome-linux-arm64/chrome`; the
  image ships `chromium-1234` at `chrome-linux/chrome`. Every test fails at
  launch until `PLAYWRIGHT_CHROME_PATH` is exported, which every run in this
  work did. `scripts/perf/emis-run.js` already solves this properly with
  `chromium.executablePath()`; the config should do the same.
- **Two clicks in one synchronous tick can still double-call `performWrite` on
  a sub-threshold plan.** `checkInFlightRef` is set only after the
  `needsCheck === false` early return. Strictly better than before (the
  re-confirmation button previously had no guard at all), and the patch itself
  is idempotent, so the cost is duplicate History rows rather than data
  damage.
- **`freshLabel`'s hour and day branches are unreachable at a ten-minute
  TTL**, symmetric to `staleLabel`'s sub-minute branches. Both are kept so the
  function stays total if the TTL is lowered. The *test* file documents the
  asymmetry; the source does not.
- **`BulkFixDialog.tsx` is ~1100 lines.** The freshness check sits coherently
  beside `performWrite`/`handleRetry`, but this is the second plan in a row to
  note the size. Worth extracting if touched again.
- **`MetadataFreshness`'s 30-second tick runs even while `loadedAt` is null**,
  ticking a component that renders nothing. Inherent to hook ordering.
- **`JSON.stringify(changes)` equality in the freshness check is
  order-sensitive**, so a reordered but equivalent plan triggers a spurious
  re-confirmation. Fails safe.
- **The patch response body is never consumed** (matching
  `setGroupSetProperties`), so `rawError` can no longer carry a server
  explanation for a failed large write — only `HTTP <status>`.
- **`writeMemberships` still takes `batchSize` as a parameter** while
  `BulkFixDialog` hardcodes `DEFAULT_BATCH_SIZE` in its own copy of the route
  predicate. They agree only because `useMembershipWrite` passes the constant
  explicitly. Both sides now carry a comment naming the coupling; a future
  caller passing a different `batchSize` would silently change which groups
  are re-read for freshness, and **no test would fail**.
- **`e2e/flows.spec.ts`'s Refresh locator is unscoped** (three uses). Harmless
  today — "Refresh" is the only button with that accessible name in `src/` —
  but the age-text assertions beside it *are* scoped.

## 4. An incidental finding about the test instances

Plan 7 Task 2's measurement script used a four-field `REPLACE` payload against
`POST /api/metadata`, so that run probably nulled `description`, `symbol`,
`color`, `attributeValues` and `translations` on `agent-gsi-emis`'s
"Basic Education" group. Harmless on a disposable instance; recorded so it is
not later mistaken for app damage.

## Still open from earlier plans

- `2026-09-plan7-carry-forward.md` — **§2 is now closed**: batch size 5000 is
  no longer the write path for large changes, so "where the measurement
  stopped, not an optimum" no longer applies above the threshold. **§3 is
  also closed**: the metadata import it described as faster-but-unusable was
  measured, adopted, and then replaced by JSON Patch. §1 (the e2e suite's
  missing cleanup net) and §4 stand.
- `2026-09-plan6-carry-forward.md` — **entirely unchanged.** This work touched
  none of it.
- `2026-09-plan5-carry-forward.md` — §2 (no cleanup net) still open, and it
  remains the item with the most demonstrated cost across plans.
