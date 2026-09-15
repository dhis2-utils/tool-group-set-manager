# Manual review 1: design

Date: 2026-09-15
Status: approved in conversation, pending review of this document

Supersedes parts of `2026-09-10-group-set-integrity-tool-design.md`, which is
edited where this document contradicts it (see §9). Origin:
`docs/MANUAL_REVIEW_1.md` (the reviewer's notes) plus the defects and open
items already recorded in `docs/superpowers/notes/2026-09-plan3-carry-forward.md`
and §9 of the original spec.

## 1. What this covers

Sixteen items in three groups:

- **Repair.** Four defects found during Plan 3 and deliberately left unfixed,
  plus the regression-coverage gap recorded alongside them.
- **Simplification.** Remove the per-set "required levels" setting, which
  made the app's central rule harder to explain than the rule itself.
- **New capability and rework.** Group set usage data; one organisation unit
  control instead of two concepts; a bulk fix that acts on what the user can
  see; and the layout fixes the reviewer asked for.

## 2. Rules and configuration

### 2.1 The rule

`evaluateSet` (`src/engine/rules.ts`) loses its `level` and `config`
parameters and reduces to four branches:

| Membership count | Condition                             | Status           |
| ---------------- | ------------------------------------- | ---------------- |
| > 1              | any set, any type                     | `Conflict`       |
| 1                | any set, any type                     | `Ok`             |
| 0                | set is compulsory                     | `MissingError`   |
| 0                | set is a data dimension, not compulsory | `MissingWarning` |
| 0                | otherwise                             | `Ok`             |

The population is unchanged: every organisation unit in the current scope, at
every level, for every organisation unit group set. There is no longer any
per-set level policy.

The reasoning, from the review: level-based compulsoriness and group set
completeness are separate concerns. The data entry API is permissive, so data
arrives at level 3 even where group assignment was only enforced at level 4,
and DHIS2's own integrity checks flag a partial set regardless of what this
app was told. "Every object belongs to exactly one group of the set" is a rule
a manager can act on. The remedy for objects the set does not really describe
is a catch-all group, not a narrowed rule — see §5.

### 2.2 What is removed

`requiredLevels` leaves `EngineConfig` (`src/engine/types.ts`), `GsiConfig`
and `saveRequiredLevels` (`src/data/datastore.ts`), `setRequiredLevels`
(`src/hooks/useGsiConfig.tsx`), and the Settings editor
(`src/pages/Settings/Settings.tsx`), with their tests.

`EngineConfig` is then left holding `includeTracker` alone, which decides the
data element population rather than any object's status, so
`EngineStore.setConfig` re-evaluates only when the tracker toggle changes.

Level remains everywhere it is a view concern and nowhere it is a policy: the
Objects tab's level filter, the matrix row level, the drill-down (§4.3), and
`useScope().rootLevel`.

### 2.3 Stored configuration already on instances

Existing `config/orgUnitGroupSets/<setId>` dataStore keys are left in place
and never read again. The app stops writing them. Deleting a user's stored
data as a side effect of an upgrade is worse than leaving orphaned keys, and
leaving them keeps a downgrade working.

## 3. Group set usage

### 3.1 Why

The app already lets a user disable a group set's data dimension flag but
gives no basis for deciding whether that is safe. Usage data is that basis,
and it is also how a user decides which sets are worth fixing at all.

### 3.2 The SQL view

One new view, code `GSI_GROUPSET_USAGE`, returning one row per group set:

| Column          | Meaning                                                              |
| --------------- | -------------------------------------------------------------------- |
| `groupset_uid`  | the group set                                                         |
| `groupset_type` | `orgUnitGroupSet`, `dataElementGroupSet`, `categoryOptionGroupSet`    |
| `favourites`    | distinct saved analytics objects referencing it as a dimension        |
| `views_12m`     | rows in `datastatisticsevent` for those favourites, last 12 months    |

Modelled on `github.com/dhis2/tool-category-dimension-disabler` (`src/app.js`),
which counts views of favourites using a category dimension. That app counts
only views; the review asks for a count of favourites. Both are kept, because
they answer different questions: zero favourites means nothing references the
set, while referenced-but-never-viewed means the reference is probably stale.

The body is a `UNION ALL` over each favourite table crossed with each of the
three dimension link tables (`orgunitgroupsetdimension`,
`dataelementgroupsetdimension`, `categoryoptiongroupsetdimension`) joined
through their `<favourite>_<type>dimensions` bridge tables, aggregated once at
the end.

Indicator group sets are not analytics dimensions, so they never appear in the
result and their Usage tab says so rather than showing a zero that reads as a
finding.

### 3.3 Version differences

Table names move between 2.40 and 2.43 — the disabler already ships two
variants of its own query for exactly this reason (`category` became
`dataelementcategory`) — and the review flags line listing and the new EVER
app favourites as further unknowns.

The definition therefore carries an **ordered list of candidate SQL bodies**.
Install tries each in turn until one both creates and executes, and Settings
reports which variant took. The inventory of favourite tables per version is a
verification task in Plan 6, run against 2.40, 2.41, 2.42 and 2.43 on live
instances; no table name enters this spec that has not been seen on a server.

### 3.4 Installation

The view follows the existing `createOrRepairSqlViews` install, the
readability probe, public read sharing, and a remove button, as the `GSI_*`
views do and as the disabler app does.

It lives in its own definition list, **not** in `SQL_VIEW_DEFINITIONS`,
because it differs in one decisive way: there is no fallback. The metadata API
cannot count dimension references, so an absent or broken usage view must not
push `selectSource` into the metadata-API fallback for the whole app. Absent
means the Usage tab shows an install prompt and the dashboard has no usage
column; it means nothing else.

Like the `GSI_*` views it is pinned to `type: 'VIEW'`: a materialised view
would serve arbitrarily old counts with no signal.

### 3.5 Where usage appears

- **Usage tab** on the group set page: the two counts, favourites broken down
  by favourite type, and the caveat in §3.6.
- **Dashboard card**: a usage figure on every card.
- **Dashboard sort control**: `Issues` (the default, today's worst-first
  order) or `Usage`. The default does not change — a user arriving to triage
  errors still sees the worst first — but a user pruning dead sets can invert
  it.
- **"Appears unused" tag** on a card with zero favourites, linking to that
  set's Usage tab.

### 3.6 Indicative, not proof

Every surface above carries the same caveat: these counts cover saved
favourites and their recorded views. An ad-hoc analytics request, an external
client, or an API consumer leaves no favourite behind. Zero favourites means
nothing on this instance *references* the set; it does not mean nothing uses
it. No surface may word this as certainty, and none may offer a one-click
delete on the strength of it.

## 4. Organisation unit, layout, navigation

### 4.1 One organisation unit control

A new `FilterBar` component renders one row of equal-height labelled fields,
used by both `Dashboard` and `GroupSetDetail`. Its first field is the
organisation unit.

- It is labelled **Organisation unit**. The old label, "Scope", was missed by
  the reviewer and then found unclear.
- It shows the current unit's name and opens the existing
  `OrganisationUnitTree` modal unchanged.
- `ScopeSelector`'s "Scope: X [Change]" line collapses into it, and the
  `Scope ({name})` tag leaves the group set header.
- There is exactly one such value in the app, so the front page and the
  Objects tab cannot disagree. The Objects tab has no tree of its own; it
  reads the bar. This is what the review means by aligning the two.
- Because the bar is on the group set page too, the control is reachable
  without leaving the set being worked on.

The dashboard's "Only sets with issues" checkbox becomes a `Show` select with
two options, `Only sets with issues` (the default, as today) and `All sets`,
so every control in the row is one labelled field of one height. Today's row
mixes a label-left line, a label-above select, a checkbox and a small button
under `align-items: center`, which is the misalignment the review reports.

The bar's fields vary by page, in a fixed order, so a field never moves
between pages:

| Page              | Fields                                                             |
| ----------------- | ------------------------------------------------------------------ |
| Dashboard         | Organisation unit · Object type · Show · Sort by · Reload data      |
| Group set, Overview | Organisation unit · Rows                                          |
| Group set, other tabs | Organisation unit                                              |

The organisation unit field is rendered only where it means something: on the
dashboard always (it scopes the organisation unit group set cards), and on a
group set page only when the set's object type is `organisationUnit`. A data
element group set has no organisation unit scope, and a control that changes
nothing on screen is worse than no control.

### 4.2 The matrix

- Numeric `DataTableColumnHeader`s take `align="right"`. Headers currently
  sit left over right-aligned numbers, so a header is nowhere near its own
  column once a group name is long.
- Group columns are capped at the **eight largest by total membership within
  the current scope** — the `MatrixResult`'s own per-group totals, so the
  ranking is recomputed whenever the scope or row level changes and never
  needs a query of its own. A trailing **Other groups** column carries the
  rest, and a picker changes which eight are shown; an explicit choice
  persists while the user stays on that set and is dropped on leaving it.
  `Missing`, `Conflict` and `Total` are always present. A data element group
  set can have hundreds of groups, and one column each is not a table.
- The **Other groups** column opens the picker rather than the Objects tab. A
  list of "objects in some of 192 groups" answers no question anyone has.

### 4.3 Drill-down

Clicking a row's label sets the bar's organisation unit to that row's unit and
moves the row level one deeper; the bar's breadcrumb is the way back. Numeric
cells keep today's behaviour of opening the Objects tab filtered to that cell.
Flat object types have one row and no drill-down.

This closes the review's "rows should be clickable to drill down … does not
appear to work for orgunits, only groups".

### 4.4 Groups in this set

The header tag listing every group name — which overflows, and which reads as
a list of things one object is in when an object is in exactly one — is
replaced by:

- a **`N groups`** chip in the header, and
- a **Groups in this set** panel on the Overview tab: the eight biggest
  groups — same ranking and same source as the matrix columns in §4.2 — with
  counts and share bars, then `Show all N groups` opening a scrollable,
  filterable list of all of them.

The panel is derived from the `MatrixResult` totals already on screen, never
from a second query, so the panel and the matrix cannot disagree.

### 4.5 Integrity checks

`Run DHIS2 integrity checks` joins the group set page's header actions, so the
feature is visible without finding the tab first. The overlay stays read-only
and stays gated on the maintenance authority; nothing about what it does
changes.

## 5. Fixing

### 5.1 One entry point, on the filtered table

`Fix issues…` leaves the page header. The Objects tab's own fix button becomes
the primary action there and the only way in. It acts on the tab's current
filter, which is already how that button behaves; what changes is that the
coarse header shortcut — "move all with conflicts or missing assignment" with
no way to narrow it — no longer exists.

Nothing becomes unreachable: opening the dialog with no filter set still means
every violation. What the user gains is that they always see which rows they
are about to change, and the count, first. `BulkFixDialog` already shows
`plan.affected` before applying; that stays.

### 5.2 Naming the catch-all group

The create-catch-all step gains editable **name** and **short name** fields,
prefilled with the generated `Other/unknown <set name>`.

The generated name is already per-set, and that stays a constraint rather than
a default: the review is explicit that one shared "Other" group must never be
reused across several group sets, so the dialog keeps looking up an existing
group by exact name within the set and refuses a name already used by a group
belonging to a different set.

## 6. Bulk write performance

### 6.1 The problem

A bulk apply over the EMIS population (77,017 objects) extrapolates to 8–12
minutes as 79 sequential collection updates at 6–9 seconds each, against a
stated budget of roughly 60 seconds. The dominant cost is DHIS2 re-evaluating
the whole collection on every write, not app code.

### 6.2 Measurement before choice

Three write shapes are timed against the same target group on
`agent-gsi-emis` (2.41, 266,396 organisation units, 1.1M memberships):

1. today's batched collection endpoint, at 250, 1,000 and 5,000 ids per batch
   — per-batch cost may not be linear in batch size;
2. a single `/api/metadata` import of the group object carrying its complete
   member list;
3. shape 2 with `async=true` and job polling.

For each run, record wall-clock, request count, and server-side cost sampled
throughout (`docker stats` on the DHIS2 and database containers).

**A shape that halves elapsed time by doubling peak server load loses.** Least
server load is this project's standing tie-breaker, and it is why the app
computes client-side in the first place. Results go to
`docs/superpowers/notes/`; the winning shape and the reason are recorded there
and in §6.4 of this document once known.

### 6.3 The correctness constraint on the import shapes

Shapes 2 and 3 replace a group's whole membership rather than adding to it, so
they silently discard a concurrent editor's change in a way the batched
endpoint does not. The app holds the complete membership already, and its
cache validation already keys on each group's `lastUpdated`, so the guard is a
re-check of `lastUpdated` immediately before the write, aborting if it moved.

2.40 bumps a group's `lastUpdated` when members change; 2.43 does not
(`2026-09-plan2-write-compatibility.md`). **The guard must therefore be proven
on every target version before an import shape is adopted.** Where it cannot
be proven, the batched endpoint stays the write path on that version whatever
the timings say.

### 6.4 Outcome

To be filled in from the measurement, before the write path changes.

## 7. Carried-forward defects

From `2026-09-plan3-carry-forward.md`:

- **Per-row assign never triggers a reload.** The write lands, the control
  snaps back to "no group", no success message — a successful write looks
  exactly like a failure, and the natural retry writes the same change again
  and adds a second History row for one intent.
  `src/components/ObjectsTable/ObjectsTable.tsx`.
- **`#/history` direct navigation flashes "This group set no longer exists"**
  on rows whose Revert then works once group sets finish loading. The message
  must not render until the group sets have loaded.
  `src/pages/History/History.tsx`.
- **`@types/node`** was pinned app-wide (25.0.3 → 22.20.2) to satisfy an
  `e2e/`-only need. Move it to where the need is, or record why it must stay
  app-wide.
- **No regression coverage for the integrity tab or text search.**
  `e2e/flows.spec.ts` never drives the integrity overlay and never asserts on
  search as a feature. Both areas are touched by this work, so the net goes in
  before the change, not after.

## 8. Open items from the original spec

Verified during this work rather than left standing:

- Whether SQL view CSV export honours `paging=false` on 2.40 and 2.43. Install
  the `GSI_*` views on a 2.40 and a 2.43 instance, request
  `sqlViews/<id>/data.csv?paging=false` on each, and check the full row count.
- Whether `access.write` is returned on group collections for a non-admin user
  on 2.40.

Left open, and recorded as such: resolving organisation unit name
translations inside the names SQL view (spec §8a's divergence). It is
independent of everything here.

## 9. Edits to the 2026-09-10 spec

- §3.2: replace the rule table with §2.1 above and delete the paragraph
  explaining that the third and fourth Missing rows are mutually exclusive —
  it exists only to explain required levels.
- §3.3: delete the `config/orgUnitGroupSets/<setId>` bullet; note that
  existing keys are ignored.
- §1 and §2: drop "declare at which org unit levels the set is required" from
  what the app lets a user do.
- §9: mark the two items in §8 above as answered once they are, and leave the
  translations item open.

## 10. Verification

Engine work is plain-Jest and test-first, as it already is. The e2e suite
gains the integrity-tab flow, the text-search flow, and the relocated fix
entry point.

The full review the manual review asks for — 2.40 through 2.43 against
different databases — runs **once, after all four plans land**, rather than
four times against a moving target.

## 11. Plans

1. **Correctness and simplification.** §2 (remove required levels), §7 (the
   four carried-forward defects), §8 (the two verifications). First, because
   §2 changes what `missing` means and every later plan renders that number.
2. **Navigation and layout.** §4, and the e2e coverage in §7's last bullet.
3. **Usage.** §3. Independent of plans 1 and 2.
4. **Fixing.** §6 (measure, then choose), §5.

Then the multi-version review in §10.
