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

Last reconciled: Plan 10, 2026-09-17, every entry re-checked against the
code.

## The plans themselves are all executed

Plans 1 through 7, the metadata freshness plan and Plan 10
(`docs/superpowers/plans/`) have all been carried out. **The checkboxes in
those files are not a completion signal** -- no plan ever had one ticked,
including the ones long finished, so a file full of `- [ ]` says nothing
either way. Completion lives in each plan's carry-forward note and in git
history. Nothing below is a half-finished plan.

## Open

Plan 10's multi-version review (manual-review spec §10) drove the app
through 2.40.12, 2.41.10, 2.42.6 and 2.43.1, each against its own,
differently shaped database, and found four things the app or its specs
get wrong. None is a small, test-covered fix, so none was fixed on this
branch. Full checklist and evidence:
`docs/superpowers/notes/2026-09-plan10-multiversion-review.md`.

- **No breadcrumb back from an Overview drill-down (check 11).** The
  manual-review spec §4.3 says explicitly that "the bar's breadcrumb is
  the way back" after a row-label click moves the scope and level down a
  level. There is none: `grep -rn breadcrumb src/` finds nothing, run
  independently on all four legs. The only way back is reopening the
  organisation unit tree modal and reselecting the parent. Identical on
  every version and database (A 2.40.12, B 2.41.10 EMIS, C 2.42.6, D
  2.43.1). Needs an actual breadcrumb component wired to the bar's
  scope/level state, not a one-line patch. — multi-version review, check
  11.
- **Removing `GSI_ORGUNIT_NAMES` drops the whole SQL view path, not only
  names (check 27).** Design spec §8a's remedy for translated names --
  "remove the names view, keep hierarchy and memberships on SQL" -- is
  false as shipped, measured false on all four legs (A, B, C, D). The
  dashboard's source label reads "Data loaded from the metadata API" and
  the request trace shows zero `/api/sqlViews/<id>/data*` calls for any
  of the three views once the names view is gone.
  `src/data/sources/selectSource.ts`'s `findSqlViews` looks up all three
  view codes and returns `null` unless every one of `orgUnits`,
  `orgUnitNames` and `orgUnitMemberships` resolves; `null` sends
  `selectSource` to `createMetadataSource` wholesale, with no partial
  composition of "two views from SQL, one from the API." On leg B (EMIS,
  266,396 org units) this turns a roughly 4-second SQL-view load into
  the 60-70-second metadata-API path FR §4.1 itself measures at that
  scale. Spec §8a has already been corrected to state this plainly
  (commit `5611385`); building the actual fix -- a composed source that
  serves two views from SQL and one field from the metadata API -- is
  real, untested scope, not done here. — multi-version review, check 27;
  main spec §8a.
- **Settings offers no way to clear a catch-all mapping once set.** Every
  leg (A, B, C, D) that set a catch-all group mapping for a group set had
  to delete the `config-catch-all` dataStore key through the API
  directly to restore the instance to its pre-review state; the Settings
  select has no "none" option. Needs a real clear/unset UI affordance
  plus a decision about what "no mapping" should mean the next time the
  app reads it. — multi-version review, check 26 finding.
- **No cancellable window on Apply for the common, no-drift case (check
  22).** The freshness spec §5's check 22 describes a pre-write metadata
  check with `Cancel` disabled during and enabled after, implying a safe
  pause before any write. On a quiet database with no concurrent editor
  the re-check always finds the plan unchanged, and
  `BulkFixDialog.tsx`'s `runFreshnessCheck` calls `performWrite(...)`
  synchronously in that branch, before `checkingFreshness` is ever set
  back to `false` -- there is no rendered frame where `Cancel` is
  enabled and the write has not already started. The immediate-write
  behaviour on the no-drift path is intentional and correct (spec
  2026-09-16 §5.1 step 4); check 22 as worded promises a window that
  does not exist there. Only leg B (EMIS) could exercise this at all --
  it is the only database large enough to cross the 5,000-id batch
  threshold. Leg B's first, literal attempt found no window and wrote
  for real (+55,097 to a Geo-Political Zone group), then reverted
  cleanly through the app's own History, verified against the API both
  ways. Needs either a spec correction describing the two paths
  separately, or a genuine UI pause added to the no-drift case. —
  multi-version review, "No cancellable window on Apply (check 22)".
- **`@dhis2/ui`'s `DataTableColumnHeader` `align` prop is a silent
  no-op, and the upstream report is not yet filed.** Confirmed present
  in the latest published `@dhis2/ui` (10.17.0, this app's installed
  version) and on the package's master branch
  (`20e343fc9e34570dcd8678ddb449d48c5b62a140`). A ready-to-paste GitHub
  issue is drafted at
  `docs/superpowers/notes/2026-09-dhis2-ui-align-issue.md`; the
  sandbox's read-only token cannot file it, so it is awaiting filing by
  the maintainer from the host. Once filed, put the URL in that note and
  close this item.

## Accepted, with reasons

- Organisation unit name translations on the SQL view path --
  maintainer decision 2026-09-17: an admin tool, so it is not critical;
  not worth a locale-aware view. Remedy and a buildable design, if the
  decision is ever reversed, are recorded in main spec §8a (and its
  cost is now stated correctly there -- see the Open section above).
- `GroupSetCard`'s real `<button>` inside `div[role="button"]` --
  least-bad option for a tag that must navigate elsewhere; the keyboard
  seam this created was fixed in Plan 6.
- `planColumns` computed twice per Overview render -- both memoised on
  their own inputs.
- Settings' invalidation propagating -- pinned at unit level by the
  shared `USAGE_QUERY_PREFIX` test and live by the e2e usage flow; a
  unit test through a mocked query layer would prove nothing.
- `writeMemberships` keeps `batchSize` as a test seam -- the duplicated
  predicate is gone (Plan 10 Task 2) and `useMembershipWrite.test.tsx`
  fails if production ever passes one.

## Records, not work

- plan7 §4: `lastupdated-probe.js` never committed (its discriminating
  part is in `2026-09-plan7-lastupdated-guard.md` §5); `write-shapes.js`'s
  restore uses the import shape; server cost was measured with
  `pg_stat_database`, missing Tomcat CPU.

## Closed in Plan 10

- The `sqlViewData` app-wide key-prefix claim in `useUsage.ts`'s
  `refresh()`. — c8ae408, "Namespace the usage query keys and let
  Settings refresh them without reading"
- A failed object-page fetch replaced loaded rows with an error and
  offered no retry (`ObjectsTable.tsx`). — 0724bc7, "Keep loaded object
  rows when a page fails, and offer to try again"
- An unmount during an in-flight load was not cancelled
  (`useEngine.tsx`'s `generationRef`). — 631297d, "Abandon an in-flight
  metadata load when the engine provider unmounts"
- The bridge-row claim in `usageSqlView.ts` was only measured on
  2.43.1. — 2c8d6fb, "Measure the legacy bridge-row claim on every
  supported version"
- No test covered `onProgress` across a mixed patch-plus-batch write. —
  6388a54, "Pin write progress across a mixed patch-and-batch change
  list"
- `removeUsageView`'s success path, `checkUsageView`'s one-request
  short-circuit, and `UsageTab`'s `'loading'` state were untested. —
  fd68d15, "Cover the usage view removal, the check short-circuit and
  the loading tab"
- The latent `'0 objects'` locator collision in `e2e/flows.spec.ts`. —
  64c6c6a, "Scope the empty-search count locator to the objects table"
- `BulkFixDialog.tsx`'s ~1100 lines, noted by three plans in a row. —
  d4bd68a "Move the bulk fix dialog's constants into their own module",
  b94bc0c "Extract catch-all group creation from the bulk fix dialog",
  abfd007 "Extract the bulk fix dialog's apply step", df59c6f "Extract
  the bulk fix dialog's preview step", 48dd6aa "Extract the bulk fix
  dialog's action step"
- `MetadataFreshness`'s 30-second tick ran even while it rendered
  nothing (`loadedAt` null). — 67afa54, "Tick the freshness indicator
  only while it shows an age"
- The plan comparison was an order-sensitive `JSON.stringify`. —
  c218e0c, "Compare recomputed plans by content, and read group members
  outside the dialog"
- Settings mounted `useUsage()` solely for `refresh()`, paying a full
  lookup and an up-to-5000-row read it never displayed. — c8ae408,
  "Namespace the usage query keys and let Settings refresh them without
  reading"
- Computed-but-unconsumed usage fields (`UsageViewCheck.readable` and
  `.type`, `InstallUsageResult.id`, `FavouriteTypeUsage.views12m`),
  `usageApplies` written as "not indicator" rather than an allow-list,
  and `GroupSetCard.module.css`'s `.usage`/`.meta` CSS duplication. —
  b2a2e3a, "Drop the usage fields nothing reads, and allow-list the
  types usage applies to"
- The Settings usage section duplicated the SQL views section's
  four-state check/busy/error machine. — 25798e0, "Run both Settings
  admin sections on one check-and-act state machine"
- A test named for level-invariance that could not demonstrate it, and
  contiguous-level fixtures that could not distinguish
  `find(l => l.level > current)` from `+1`. — 4ac188c, "Name two tests
  for what they show, and cover a hierarchy with a missing level"
- `GroupsPanel` kept its filter term when collapsed. — d96596f, "Clear
  the groups filter when the panel collapses"

## Closed earlier, so nobody re-opens them

- Plan 3's four items — all superseded or fixed; see that file's status block.
- The e2e cleanup net (plan5 §2), open through four plans — Plan 9.
- JSON Patch rejection behaviour proven, and the freshness check given a
  deadline (plan8 §1) — Plan 9.
- Plan 8's `patchChange` key-order gap is **obsolete**: it described a field
  read the JSON Patch switch removed.
