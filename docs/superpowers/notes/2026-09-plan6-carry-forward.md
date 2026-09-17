# Carried forward from Plan 6: found, recorded, not fixed


> ## Status after the Plan 9 cleanup pass
>
> **Closed:** §1's `useUsage` `error`/`status` asymmetry (`error` is now
> derived behind the same `view` guard); §1's `views_12m` wording, by moving
> the wording rather than the SQL — the Usage tab now says "recorded uses"
> rather than "views", because the view is installed by code and a changed
> query would silently leave every existing install reporting old numbers
> under new wording; §4's missing `byLeastUsed` comment; §4's
> `parseUsageListGrid` `at()` comment.
>
> **Still open:** §1's `sqlViewData` key-prefix claim (correct today, a trap
> for whoever adds a second SQL-view-backed query), §2's bridge-row evidence
> gap, §3's test gaps, and the remainder of §4. §5 and §7 are records, not
> work items.

Plan 6 (group set usage, spec §3) is complete. Every item below was found
during it by a task review or the final whole-branch review, confirmed, and
deliberately left — each was triaged as not worth blocking handover for. The
final review's own triage is reproduced faithfully: where it judged something
"can stand", that judgement is recorded with its reasoning rather than
silently inherited.

Nothing here is a known-broken behaviour. They are latent risks, evidence
gaps and small inconsistencies.

## 1. Three things a later plan touching this code should fix first

These are the ones with teeth — each is a trap laid for the *next* person
rather than a wart on this one.

- **`invalidateQueries({ queryKey: ['sqlViewData'] })` claims an app-wide key
  prefix for one feature.** `src/hooks/useUsage.ts`'s `refresh()` invalidates
  every query whose key starts with `sqlViewData`. Nothing else in `src/` uses
  that prefix today (checked), so it is correct now — and wrong the moment a
  second SQL-view-backed query is added, because this one will invalidate it
  too. Anyone adding such a query must either namespace it or narrow this.

- **`useUsage`'s `error` is derived without the `view` guard that `status`
  applies.** `status` treats "no view found" as `'absent'` ahead of any read
  error, but `error` goes straight to `lookup.isError || read.isError`. So a
  read that errored while a view existed can leave a non-null `error` on a
  state that later reports `'absent'`. Harmless today because every consumer
  reads `error` only when `status === 'error'`; a consumer that surfaces
  `error` unconditionally would show a stale message. (The original trigger —
  `refresh()` firing `read.refetch()` against a stale key — is gone, replaced
  by invalidation in Plan 6's final fix wave; the derivation asymmetry is what
  remains.)

- **`views_12m` counts every `datastatisticsevent` row for a favourite's uid,
  not only view events.** There is no `eventtype` filter. This matches spec
  §3.2's own column definition ("rows in `datastatisticsevent` for those
  favourites"), so it is not a defect against the spec — but the Usage tab
  words it as "views in the last 12 months", which is a slightly stronger
  claim than the query makes. Either add the filter (`EVENT_CHART_VIEW`,
  `MAP_VIEW`, `VISUALIZATION_VIEW`, `EVENT_REPORT_VIEW`) or soften the wording;
  do not leave the two disagreeing indefinitely.

## 2. An evidence gap in the SQL's strongest claim

`src/data/sources/usageSqlView.ts`'s comment states that the legacy
`eventchart` / `eventreport` bridge rows "add up to" `eventvisualization`'s,
measured on 2.43.1. `docs/superpowers/notes/2026-09-plan6-usage-tables.md`
records the **uid superset** measurement on all four versions (every
`eventchart`/`eventreport` uid is present in `eventvisualization`) but not the
bridge-row comparison itself.

The distinction matters: if a legacy event chart's group-set dimension rows
lived **only** in `eventchart_orgunitgroupsetdimensions` and not in
`eventvisualization_orgunitgroupsetdimensions`, that reference would be
silently **missed** by the shipped query, and the uid-superset check would not
catch it. The bridge-row counts were in fact compared on 2.43.1 while the plan
was written (4 + 1 = 5), and that is what the comment is describing — it was
simply never written into the note, and never re-checked on 2.40/2.41/2.42.

Low risk, cheap to close: one query per version comparing the bridge row
counts, appended to the notes file.

## 3. Test gaps

None of these is a failing test; each is a place where a passing suite would
not notice a regression.

- **`removeUsageView` has no success-path test** (`usageAdmin.test.ts` covers
  only the 403 rejection). The e2e flow exercises the whole delete-and-recheck
  path, so this is covered end to end but not in units.
- **No test pins the "an unusable view costs one request, not two"
  short-circuit** in `checkUsageView` — the code correctly skips the read probe
  when the metadata bar already fails, and nothing would fail if that were
  removed.
- **`UsageTab`'s `'loading'` status and its defensive null-`forSet` branch are
  untested.** The second is provably unreachable given `useUsage`'s
  `byId`/`status` coupling.
- **The Settings unit tests prove `refresh()` is *called* at the right times,
  not that the invalidation propagates.** That claim is carried by the e2e
  flow instead. Worth knowing before trusting the unit suite alone on a
  cache-behaviour change.

## 4. Smaller things, recorded so they are not rediscovered

- **`byLeastUsed`'s indicator-vs-applicable partition is unreachable today.**
  `src/pages/Dashboard/Dashboard.tsx` renders one section per `ObjectType` and
  never sorts a mixed-type array, so `applicable(a) !== applicable(b)` cannot
  hold. The final review's advice was to keep the branch and add a comment
  saying it is defensive rather than reachable — **the comment was not added**,
  so the next reader will spend the same minutes working this out.
- **A real `<button>` is nested inside the card's `div[role="button"]`**
  (`GroupSetCard.tsx`). Some assistive technology treats a `role="button"`
  widget as a leaf. The *keyboard* seam this created was fixed in Plan 6's
  final wave (the inner button now stops keydown propagation, so Space no
  longer navigates to Overview instead of Usage); the nesting itself stands,
  judged the least-bad option for a tag that must navigate somewhere other
  than its own card.
- **Settings mounts `useUsage()` solely to get `refresh()`** — a full
  subscription, so opening Settings issues the lookup *and* an up-to-5000-row
  read of data Settings never displays. `useQueryClient()` plus the two
  `invalidateQueries` calls would avoid the fetch at the cost of duplicating
  the keys.
- **`handleInstallUsage` / `handleRemoveUsage` re-check in a `finally`** (fixed
  in the final wave), but `usage.refresh()` — the cross-component cache bust —
  stays success-only. That is deliberate and correct; noted so it is not
  "fixed" into the `finally` by someone tidying.
- **Computed but never consumed:** `UsageViewCheck.readable` and `.type`,
  `InstallUsageResult.id`, `UsageRow.groupSetType`, and
  `FavouriteTypeUsage.views12m`. `groupSetType` earns its keep as a validation
  guard in the parser; the others are asserted in tests and read by no
  production code, which reads as if something consumes them.
- **`usageApplies` is written as "not indicator"** rather than an allow-list of
  the three covered types. Correct only because `ObjectType` is a closed
  four-member union; a fifth member would silently default to `true`.
- **`parseUsageListGrid`'s `at()` helper uses an unsafe index cast**, safe only
  because `REQUIRED_COLUMNS` is validated immediately above it. Wants a
  one-line comment saying so.
- **The usage section duplicates the SQL views section's four-state
  check/busy/error machine** in `Settings.tsx` rather than sharing a hook. The
  duplication itself was judged acceptable; note that the *incomplete*
  duplication was a real defect (the no-authority branches were missing and
  were fixed in the final wave), which is the argument for extracting it if
  the file is touched again.
- **The "is this view metadata usable" predicate is duplicated** between
  `useUsage` and `checkUsageView`. Sharing it was rejected deliberately:
  `checkUsageView` additionally probes readability and `useUsage` deliberately
  does not (see below), and a shared helper would obscure that difference.
- **`GroupSetCard.module.css`'s `.usage` duplicates `.meta`'s `font-size` and
  `color`** rather than sharing them.

## 5. A design divergence that is deliberate — do not "harmonise" it

`checkUsageView` (`usageAdmin.ts`) probes the view with a real read before
calling it usable. `useUsage` does **not** — it filters on `type` and
`access.data.read`, then reads the data query.

This is intended. A view whose metadata passes but whose read fails must
surface in the app as **an error**, not as **absent**: telling a user to
install a view that already exists is worse than telling them it is broken.
Settings, whose whole job is deciding whether to offer an install, is the one
place that needs the probe.

The lesson that came with it, from Plan 6's final review: this rule was
written down for **two** call sites when there were **three**, and the third —
the dashboard's sort `helpText` — is the one that got it wrong, telling users
of a perfectly healthy instance that usage was "not installed" during every
load. That was fixed. When a rule like this is recorded, enumerate every call
site it binds.

## 6. Spec amendments Plan 6 made

Both are written into `docs/superpowers/specs/2026-09-15-manual-review-1-design.md`;
recorded here so they are not mistaken for drift.

- **§3.2's row shape.** "One row per group set" with four columns cannot also
  carry §3.5's breakdown by favourite type. The view returns one row per
  (group set, favourite type) that has at least one referencing favourite; a
  group set absent from the result has no referencing favourite, which is
  exactly the "Appears unused" case.
- **§3.5's sort direction.** The option is labelled `Usage (least used first)`,
  because the only thing the sort is for — §3.5's own "a user pruning dead sets
  can invert it" — works in one direction only.

## 7. A correction to the reference app, worth reporting upstream

`github.com/dhis2/tool-category-dimension-disabler` joins
`datastatisticsevent.favoriteuid` to `mapview.uid`. It never matches:
statistics record the **map** the user opened, not the mapview. Measured on
2.43.1 — of 74 `MAP_VIEW` rows, 30 join to `map.uid` and **0** to
`mapview.uid`. That app's map view counts have therefore always been zero.

This app goes `mapview → mapmapviews → map` instead.

## Still open from earlier plans

`docs/superpowers/notes/2026-09-plan5-carry-forward.md` remains current, with
two updates noted in it: its §2 (no cleanup net in the e2e suite) and its §5
(a latent locator collision, whose line number has moved).
