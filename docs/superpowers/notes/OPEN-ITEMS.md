# Open items

The single current index of everything known and not fixed. One line per
item, pointing at the carry-forward note that holds the reasoning.

Written because the per-plan notes had grown to six files that each said
"still open from earlier plans" about the others, and knowing the real state
meant reading all six and diffing them mentally. That is how the e2e cleanup
net drifted through four plans before anyone closed it.

**Keep this file honest or delete it.** An index that is merely stale is
worse than none, because it is trusted. When an item is closed, strike it
here and in its own note in the same commit.

Last reconciled against the code: the Plan 9 cleanup pass. Every item below
was verified present at that point, not merely inherited from an older note.

## With teeth

These are traps for the next person rather than warts on the current code.

- **`writeMemberships` takes `batchSize` while `BulkFixDialog` hardcodes
  `DEFAULT_BATCH_SIZE`** in its own copy of the route predicate. They agree
  only because `useMembershipWrite` passes the constant explicitly. A caller
  passing a different `batchSize` would silently change which groups get
  re-read for freshness, **and no test would fail.** — plan8 §3
- **`invalidateQueries({ queryKey: ['sqlViewData'] })` claims an app-wide key
  prefix for one feature** (`useUsage.ts`). Correct today because nothing
  else uses that prefix; wrong the moment a second SQL-view-backed query is
  added. — plan6 §1
- **A failed object-page fetch replaces the loaded rows with an error and
  offers no retry** (`ObjectsTable.tsx`). Distinct from the deliberate
  no-retry-on-write decision recorded beside it. — plan1
- **An unmount during an in-flight load is not cancelled**: `generationRef`
  is bumped per `reload` call but never on unmount, so the continuation sets
  state after teardown (`useEngine.tsx`). — plan1

## Evidence gaps

- **The bridge-row claim was only measured on 2.43.1.** `usageSqlView.ts`
  states that the legacy `eventchart`/`eventreport` rows add up to
  `eventvisualization`'s; the note records the uid-superset check on all four
  versions but not the row-count comparison, which would catch a different
  failure. One query per version closes it. — plan6 §2
- **`@dhis2/ui`'s `DataTableColumnHeader` silently ignores its own `align`
  prop** (10.17.0). Worked around here with a canary test; **not yet reported
  upstream**, and it affects every app that passes the prop. — plan5 §4

## Test gaps

No failing tests — places a passing suite would not notice a regression.

- `onProgress` across a mixed patch-plus-batch write; each route is tested
  alone. — plan8 §2
- `removeUsageView`'s success path; `checkUsageView`'s one-request
  short-circuit; `UsageTab`'s `'loading'` state; Settings' invalidation
  actually propagating (unit tests prove `refresh()` is called, not that it
  works). — plan6 §3
- The latent `'0 objects'` locator collision in `e2e/flows.spec.ts` — search
  for the locator, it has drifted three times. — plan5 §5

## Smaller, recorded so they are not rediscovered

- `BulkFixDialog.tsx` is ~1100 lines; the third plan in a row to note it. — plan8 §3
- `MetadataFreshness`'s 30-second tick runs even while it renders nothing. — plan8 §3
- The plan comparison is an order-sensitive `JSON.stringify`, so a reordered
  but equivalent plan triggers a spurious re-confirmation. Fails safe. — plan8 §3
- Settings mounts `useUsage()` only for `refresh()`, paying a full lookup and
  read it never displays; plus the rest of plan6 §4 (unconsumed computed
  fields, `usageApplies` written as "not indicator", the duplicated
  four-state machine, a CSS duplication, a real `<button>` nested inside a
  `div[role="button"]`). — plan6 §4
- Two tests whose names overpromise what they exercise; contiguous level
  fixtures that cannot distinguish `find(l => l.level > current)` from `+1`;
  `GroupsPanel` keeps its filter term when collapsed; `planColumns` computed
  twice per Overview render. — plan5 §6
- `lastupdated-probe.js` was never committed (its discriminating part is
  reproduced in the note); `write-shapes.js`'s `restore` uses one of the
  shapes under test, so it must not set up an import-specific investigation;
  server cost was measured with `pg_stat_database`, which misses Tomcat's own
  CPU. — plan7 §4

## Closed, so nobody re-opens them

- Plan 3's four items — all superseded or fixed; see that file's status block.
- The e2e cleanup net (plan5 §2), open through four plans — Plan 9.
- JSON Patch rejection behaviour proven, and the freshness check given a
  deadline (plan8 §1) — Plan 9.
- Plan 8's `patchChange` key-order gap is **obsolete**: it described a field
  read the JSON Patch switch removed.
