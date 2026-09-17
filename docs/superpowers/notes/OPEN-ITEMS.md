# Open items

The single current index of everything known and not fixed. One line per
item, pointing at the note or spec section that holds the reasoning.

Written because the per-plan notes had grown to six files that each said
"still open from earlier plans" about the others, and knowing the real state
meant reading all six and diffing them mentally. That is how the e2e cleanup
net drifted through four plans before anyone closed it.

**Keep this file honest or delete it.** An index that is merely stale is
worse than none, because it is trusted. When an item is closed, strike it
here and in its own note in the same commit.

Covers three kinds of outstanding thing: scope the specs called for and was
never built, verification the specs asked for that has not fully happened,
and defects or gaps found and deliberately left.

Last reconciled: the Plan 9 cleanup pass. Be precise about what that means,
because the difference matters when you pick something up. The Plan 1 and
Plan 5 entries, and the two spec items below, were **re-checked against the
code and the specs** at that point. The Plan 6, 7 and 8 entries are
**inherited from their own notes' triage**, written when that code was
fresh; they were not independently re-verified. Nothing here is known stale
-- but only the first group is known current.

## The plans themselves are all executed

Plans 1 through 7 and the metadata freshness plan
(`docs/superpowers/plans/`) have all been carried out. **The checkboxes in
those files are not a completion signal** -- no plan ever had one ticked,
including the ones long finished, so a file full of `- [ ]` says nothing
either way. Completion lives in each plan's carry-forward note and in git
history. Nothing below is a half-finished plan.

## Specified but not built

One piece of specified scope was never built. It is a deliberate deferral,
not an oversight -- both specs say so -- but nothing else in this file is
scope, so it is easy to forget it exists at all.

- **Organisation unit name translations in the names SQL view** (main spec
  §9's one remaining open item, and §8a's divergence). The SQL view path
  reads the raw `name` column; the metadata API path requests `displayName`,
  which resolves the caller's locale against the object's translations. On an
  instance with translated org unit names the two sources therefore show
  different names for the same unit. Counts, statuses and every fix are
  unaffected -- they key on ids -- and the app states which source it used,
  so a user seeing untranslated names can explain them. The remedy available
  today is to remove the `GSI_ORGUNIT_NAMES` view, which drops only names
  back to the metadata API and keeps the hierarchy and membership views.
  Closing it properly means answering a question first: can a caller's locale
  be resolved inside SQL on 2.40 through 2.43? That is a spike, and only
  becomes a plan if the answer is yes. — main spec §9, §8a; manual-review
  spec §8

## Verification the specs asked for, not fully done

- **The §10 multi-version review.** The manual-review spec scoped one review
  across 2.40 to 2.43 **against different databases**, to run once after
  Plans 4-7 landed rather than four times against a moving target. Where it
  actually stands:
  - The **e2e half is done**: the full suite passes on 2.40.12, 2.41.10,
    2.42.6 and 2.43.1 (`2026-09-plan8-multiversion-brief.md`), which it had
    never done on the two middle versions before.
  - The **"different databases" half is thin**: three of those four runs are
    the same Sierra Leone seed at different versions. EMIS (266,396
    organisation units) is the only genuinely different database, and only
    the freshness feature was exercised there, manually -- `flows.spec.ts`
    is pinned to Sierra Leone data throughout and cannot run against it.
  - The **structured manual review** -- driving the screens the way the
    original manual review did -- has not happened at all.
  - Plan 8 stacked new scope on top after §10 was written, so its sweep
    would now have to cover the freshness feature too.
  - Whether a *second* manual review round is due is not something this repo
    records; the source spec is named `manual-review-1`, which implies a
    cadence the repo cannot see. — manual-review spec §10

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
