# Group Set Integrity Tool: design

Date: 2026-09-10
Status: approved in conversation, pending review of this document

## 1. Purpose

A DHIS2 App Platform app that helps managers at every level keep group set
categorisation valid. A group set such as "Ownership" splits objects into
groups such as Public and Private. Two DHIS2 properties make a group set
strict: **compulsory** (every object must be in a group of the set) and
**data dimension** (analytics breaks data down by the set, so an object must
be in exactly one group or its data is double counted or lost). In practice
instances accumulate objects in no group, or in conflicting groups such as
both Public and Private.

The app lets a user:

- see, for the org units they manage, how every group set categorises them,
  as a summary matrix and as a filterable list;
- see which objects violate the rules, with DHIS2's own data integrity
  results overlaid where the user may read them;
- fix violations in bulk by moving objects to a set-specific "Other/unknown"
  group, or individually by picking the correct group;
- create that catch-all group when the set lacks one;
- adjust the set's compulsory and data dimension properties, or declare at
  which org unit levels the set is required, when the strict reading is
  wrong for the instance;
- review and revert past changes.

Performance is a first-class requirement: the Nigeria EMIS instance has
266,396 org units and 1.1 million group memberships, and a national user
must be able to load the dashboard within about 60 seconds without putting
undue load on the server.

## 2. Scope

Object types covered from the first version: organisation units, data
elements, indicators, category options. Group set properties per type:

| Group set type     | compulsory | dataDimension |
| ------------------ | ---------- | ------------- |
| Organisation unit  | yes        | yes           |
| Data element       | yes        | yes           |
| Indicator          | yes        | no            |
| Category option    | no         | yes           |

The app does not replace the Maintenance app. It creates only the
"Other/unknown" group and edits only the two set properties above. Group
level checks such as "group has fewer than two members" are out of scope.

Supported DHIS2 versions: 2.40 and newer.

## 3. Domain model and rules

### 3.1 Population

The population of a group set is the set of objects that should be
categorised by it.

- **Organisation units**: every org unit in the current scope. The default
  scope is the subtree under the user's data capture org units. The user
  can narrow the scope to any descendant. Admins can configure app level
  **required levels** per set (see 3.3).
- **Data elements**: aggregate domain by default. A toggle includes tracker
  domain data elements. DHIS2 itself has no compulsory check for data
  elements, so this is the app's own rule.
- **Indicators**: all indicators.
- **Category options**: all options of every category that already
  contributes at least one option to the set. This matches DHIS2's
  `category_option_group_sets_incomplete` check.

### 3.2 Rules

Evaluated per group set and per object in the population.

| Rule     | Condition                                                                  | Applies to                               | Severity |
| -------- | -------------------------------------------------------------------------- | ---------------------------------------- | -------- |
| Conflict | Object is in more than one group of the set                                | Every set, every type                    | Error    |
| Missing  | Object is in no group, set is DHIS2 compulsory                             | Org unit (all levels), data element, indicator | Error |
| Missing  | Object is in no group at an app level required level, set not compulsory   | Org unit                                 | Error    |
| Missing  | Object is in no group, set is a data dimension but not compulsory          | Org unit, data element, category option  | Warning  |

Conflict is always an error regardless of the data dimension property. This
matches DHIS2's `*_violating_exclusive_group_sets` checks and the Maintenance
app's single select behaviour. Sets that are neither compulsory nor a data
dimension get only the conflict rule but still appear in the overview.

The third and fourth Missing rows are mutually exclusive per set, not
additive: an org unit set with required levels configured (3.3) is narrowed
to only those levels, so the fourth row's data-dimension warning does not
apply to it at all, at any level -- not just at the required ones. An admin
who configures required levels is saying "this set only applies at these
levels"; a warning at every other level is exactly the noise they configured
required levels to remove. The fourth row applies only to a set with no
required levels configured.

Groups can belong to more than one set (EMIS has "Private" in both
Ownership and School Type). Membership is therefore counted per set, never
per group.

### 3.3 App level configuration

Stored in the dataStore namespace `group-set-integrity`, editable by admins:

- `config/orgUnitGroupSets/<setId>`: `{ requiredLevels: number[] }`. When
  set on a non-compulsory set, missing objects at those levels are errors
  and other levels are ignored. When the set is DHIS2 compulsory the strict
  rule wins and the app offers to un-flag compulsory and keep the required
  levels instead.
- `config/catchAll/<setId>`: `{ groupId }`. The set's Other/unknown group.
  Written when the app creates the group, or when an admin picks an
  existing group. The user can pick another target at fix time and may
  save that choice as the new default.
- `config/dataElements`: `{ includeTracker: boolean }` default for the
  tracker toggle.

### 3.4 Remedies

- **Move to catch-all**: remove the object from every group in the set,
  add it to the target group. Available in bulk for any filtered list and
  per object.
- **Assign group**: per object, choose one group of the set; the app
  removes the object from the others. Also available in bulk for a filtered
  list known to belong to one group.
- **Create catch-all group**: creates "Other/unknown <set name>" with a
  short name, a code derived from the set's code, and sharing copied from a
  sibling group; adds it to the set; records the mapping.
- **Set properties**: toggle compulsory and data dimension on the set
  (JSON patch). Set required levels (dataStore).

## 4. Data loading and validation engine

### 4.1 Measurements that drove the design

Nigeria EMIS, DHIS2 2.41.10, 266,396 org units, 7 org unit group sets,
1.1 million memberships, measured 2026-09-10 from inside the sandbox:

| Data                                | Metadata API          | SQL view CSV      |
| ----------------------------------- | --------------------- | ----------------- |
| Org units: id, level, parent        | 16 MB, 11 to 21 s     | 6.9 MB, 2.0 s     |
| Group memberships (groups in sets)  | 23 MB, 26 s           | 26 MB, 3.5 s      |
| Org unit display names              | 15 MB, 24 s           | not yet measured  |
| Gist API                            | capped at 1000 rows per page, unusable | |

The metadata API path costs the server 40 to 50 seconds of Hibernate work
for a full load. SQL views are roughly ten times cheaper.

### 4.2 Two data sources, one format

Both sources produce the same in-memory arrays: object ids, level, parent
id, display names, and per group the list of member ids.

- **Fast path: SQL views.** The app looks up three SQL views by code:
  `GSI_ORGUNITS` (uid, level, parent uid), `GSI_ORGUNIT_NAMES` (uid, name),
  `GSI_ORGUNIT_MEMBERSHIPS` (group uid, member uid, for groups that belong to a
  set, one view per object type or a type column). If they exist and the
  user can read them, the app fetches CSV with paging disabled. If they are
  missing and the user has the SQL view authority, the Settings page and
  the first-load screen offer to create them once, shared public read-only.
  The views are plain row exports. All rules live in the engine.
- **Fallback: metadata API.** Same fields through `paging=false` requests
  per type plus member id lists per group. A progress bar shows per request
  progress. Used when the views are unavailable.
- Data elements, indicators and category options are small enough that the
  metadata API is always used for them, including names.

### 4.3 Engine

Plain TypeScript with no React or DHIS2 dependencies, running in a Web
Worker so the UI never freezes. Message protocol: `load(type, source
payload)`, `computeDashboard(scopeRoot)`, `matrix(setId, scopeRoot,
rowLevel)`, `violations(setId, scopeRoot, filters)`, `applyLocal(changeSet)`.

Indexes per object type:

- `ids: string[]`, `indexOf: Map<string, number>`.
- Org units only: `level: Uint8Array`, `parent: Int32Array`, `dfsOrder`
  and `subtreeEnd` so "is in subtree of X" is a range check and "ancestor
  at level N" is a precomputed lookup per level.
- Per group set: `groupOf: Int32Array` (group index, -1 none, -2 conflict)
  and `memberCount: Uint8Array`. Conflict lists are derived from
  `memberCount > 1`; the conflicting groups are found by scanning the set's
  member lists for that object on demand.

Queries are linear passes over at most a few hundred thousand entries and
return in milliseconds. Names live in a separate map loaded after the
counts, so the dashboard shows numbers before names have arrived.

### 4.4 Cache and refresh

- IndexedDB, keyed by server URL and object type. Stores the raw arrays,
  the group `lastUpdated` stamps and the object total at load time.
- On start, cached data is used immediately. A background check compares
  the object total and the groups' `lastUpdated` against the server and
  reloads only what changed. A mismatch in totals triggers a full reload
  for that type.
- After the app writes, the worker applies the change locally and the
  affected groups' member lists are re-pulled in the background.
- Settings has a clear-cache button.

### 4.5 DHIS2 data integrity overlay

For users holding the maintenance authority (`F_PERFORM_MAINTENANCE` or
`ALL`):

- Relevant checks: `org_units_not_in_compulsory_group_sets`,
  `organisation_units_violating_exclusive_group_sets`,
  `data_elements_violating_exclusive_group_sets`,
  `indicators_violating_exclusive_group_sets`,
  `category_options_excess_groupset_membership`,
  `category_option_group_sets_incomplete`.
- Dashboard and the set's integrity tab read `GET
  /api/dataIntegrity/summary?checks=...` and show the count and
  `finishedTime`. "Run now" posts to the same endpoint and polls.
- Details come from `GET /api/dataIntegrity/details?checks=...`. Each issue
  carries the object id and, for exclusive checks, group references. The
  app filters issues to the current scope through its hierarchy index and
  shows them next to the engine's list with a reconciliation line.
- Integrity results are cached by DHIS2 and may be stale. Every number is
  labelled with its run time. After the app writes, the affected checks
  are marked stale and a re-run is suggested, not triggered automatically,
  because the checks are national and can take a minute on large
  instances.
- The engine is the source of truth for counts and for non-admin users.

## 5. Screens and flows

A clickable mockup of screens 1 to 4 is published at
https://claude.ai/code/artifact/a4e4e147-2142-4a72-9dbf-f07124db9503.

### 5.1 Dashboard

Scope selector at the top (org unit tree rooted at the user's data capture
org units). Progress per type while loading. One card per group set,
grouped by object type, sorted by error count. Card content: name,
property badges (Compulsory, Data dimension, Required at level N), group
count, population size in scope, conflict count, missing count, OK count,
a lock indicator when the user cannot write to some groups, and for admins
the integrity result with its run time and a stale marker. Filters: object
type, only sets with issues.

### 5.2 Group set detail

Header: name, badges, and actions "Set properties", "Required levels",
"Catch-all group: <name>" and "Fix N issues". Three tabs:

- **Overview**: summary matrix. Rows are org units at a chosen level under
  the scope root, children by default. Columns: one per group, then
  Missing, Conflict, Total. Clicking a cell opens the Objects tab with the
  row and column applied as filters. Upper level org units flagged under a
  compulsory set are shown as their own row with an inline explanation and
  the two remedies. For non hierarchical types the matrix collapses to a
  single row of counts.
- **Objects**: virtualised table of the population in scope: name, parent
  or path, level, status pill (OK, Missing, Conflict), membership control.
  Filters: status, ancestor, level, group, text search. Checkboxes plus
  "select all matching". The membership control is a segmented single
  select when the set has five groups or fewer, and a searchable single
  select dropdown above that. On a conflict row the current groups are
  highlighted red and clicking one keeps it and removes the others. A
  change writes after a one line confirmation and is recorded in History.
- **DHIS2 integrity** (admins): the relevant checks with national count, in
  scope count, engine count, run time, and "Run now".

### 5.3 Bulk fix dialog

Opened from the selection in Objects or from a card's "Fix" shortcut, which
preselects all violations of one rule.

1. **Action**: move to catch-all (target preselected from the mapping or a
   name match, changeable, with "Create Other/unknown <set>" when none
   exists) or assign all to one group.
2. **Preview**: per group "+N" and "-M" lines, a sample of rows with Now and
   After columns, full list CSV download, and a callout listing objects
   skipped because a group involved is read-only for the user. Optional
   note for History.
3. **Apply**: progress over batches, result panel with per batch outcome,
   retry for failed batches.

### 5.4 History

List of change sets: when, who, group set, action, number of membership
changes, note. Actions: Revert, Export. Revert previews what would change
given the current state, skips objects that have since been moved
elsewhere, and is itself recorded as a new change set. Property and
configuration changes are listed but not revertible from here.

### 5.5 Settings (admins)

Required levels per org unit group set, catch-all mapping per set, default
tracker toggle, SQL view status with create or repair, clear cache.

### 5.6 Write access

Every action that would touch a group without write access is disabled with
a tooltip naming the group. Bulk previews list skipped objects.

## 6. Writes, permissions, history, errors

### 6.1 Writes

- Membership changes use `POST /api/<groups>/<groupId>/<members>` with
  `{ additions: [{id}], deletions: [{id}] }`, one request per group per
  batch of about 1,000 ids, sequential. Additions of existing members and
  deletions of non-members are no-ops, so a stale preview cannot corrupt.
- Catch-all group creation: `POST /api/<groups>` then `POST
  /api/<groupSets>/<setId>/<groups>/<groupId>`.
- Set properties: JSON patch on the group set.
- After a write the worker applies the change locally and the data layer
  re-pulls the affected groups.

### 6.2 Permissions

- Groups and sets are fetched with `access`. The UI gates on
  `access.write`.
- Authorities checked once at start: maintenance authority for integrity,
  SQL view authority for view creation, metadata authority for Settings.
- dataStore namespace `group-set-integrity`. Config keys written by admins
  with public read. Each change set is its own key `history/<uid>` created
  by the acting user with public read.

### 6.3 Change sets

```
{
  id, createdAt, createdBy: { id, name }, objectType, groupSetId,
  action: 'move' | 'assign' | 'revert', note,
  targetGroupId,
  changes: [{ groupId, additions: string[], deletions: string[] }],
  revertOf?: id
}
```

Only changes that actually succeeded are recorded.

### 6.4 Error handling

- Load failures are per object type: the failed type shows an error and
  retry on its cards; other types keep working.
- Bulk writes stop at the first failed batch; the result panel shows what
  was applied, what failed and why, with retry.
- Permission or session errors surface as plain messages naming the group
  and the missing right.
- A cache whose totals no longer match the server is discarded.

## 7. Technical stack and structure

- DHIS2 App Platform, TypeScript template, pnpm, Vite through
  `@dhis2/cli-app-scripts`, React 18, `@dhis2/ui`, hash routing, TanStack
  Query v4, TanStack Table with row virtualisation, `@dhis2/d2-i18n`,
  `idb`. Min DHIS2 version 2.40 in `d2.config.js`. App name "Group Set
  Integrity Tool".
- Structure:
  - `src/engine`: types, index builder, rules, queries, worker entry,
    worker client. No React or DHIS2 imports.
  - `src/data`: `sources/sqlViewSource.ts`, `sources/metadataSource.ts`
    behind one interface; `groupSets.ts`; `integrity.ts`; `writes.ts`
    (batching); `datastore.ts`; `cache.ts`.
  - `src/pages`: Dashboard, GroupSetDetail (Overview, Objects, Integrity),
    History, Settings.
  - `src/components`: ScopeSelector, GroupSetCard, SummaryMatrix,
    ObjectsTable, MembershipControl, BulkFixDialog, ChangeSetPreview,
    IntegrityPanel.
  - `CLAUDE.md` recording decisions for later sessions.

## 8. Testing

- Engine: unit tests for every rule and query on small synthetic trees,
  including groups in two sets and upper level objects. A performance test
  with a generated 300K unit tree asserting load and query budgets.
- Data layer: CSV parser, batching, change set and revert computation with
  mocked responses.
- Components: Jest and React Testing Library through the app-runtime custom
  provider.
- End to end: Playwright against Sierra Leone 2.40 and 2.43 seeds for the
  flows (dashboard, drill down, single assign, bulk move, revert), and
  against the EMIS instance `agent-gsi-emis` for load time and server side
  timing with the numbers in 4.1 as baseline.
- Final pass with the DHIS2 app review recipe before hand-off.

## 8a. Known divergence between the two data sources

The SQL view path reads organisation unit names from the `name` column,
while the metadata API path requests `displayName`, which resolves the
user's locale against the object's translations. On an instance where org
unit names are translated, the two paths therefore show different names for
the same unit. Counts, statuses and every fix are unaffected, since those
key on ids.

This is accepted for now rather than fixed: making the view translation
aware would mean resolving the caller's locale inside SQL, and org unit
name translations are rare in practice. The app states which source it
used, so a user seeing untranslated names has a way to explain them. If an
instance needs translated names, the remedy is to remove the
`GSI_ORGUNIT_NAMES` view, which drops only names back to the metadata API
while keeping the hierarchy and membership views.

## 9. Open items to verify during implementation

- Whether adding members to a group updates the group's `lastUpdated` on
  2.40 to 2.43 (needed for the delta refresh). **Answered:** 2.40 bumps it,
  2.43 does not. Harmless — the app never relies on `lastUpdated` to detect
  its own writes, only to detect an *external* edit when deciding whether
  its cache is stale. See `docs/superpowers/notes/2026-09-plan2-write-compatibility.md`.
- Whether SQL view CSV export honours `paging=false` on 2.40 and 2.43 the
  way it does on 2.41. **Still open.** No note on the branch measures this
  specifically: Plan 1's compatibility campaign
  (`docs/superpowers/notes/2026-09-plan1-compatibility.md`) ran the app
  end to end on 2.40, 2.42 and 2.43 and reconciled its on-screen numbers
  against the API, but that note does not say which of those runs had the
  `GSI_*` SQL views installed, and it never mentions CSV export or
  `paging=false` at all — the per-run reports it points to
  ("the procedure section of the 2.40 report is the one to start from")
  were not committed to the repo. A future plan should confirm directly
  (install the SQL views on a 2.40 and a 2.43 instance, request
  `sqlViews/<id>/data.csv?paging=false` on each, and check the full row
  count returned) before relying on this.
- Exact field names of the integrity details payload (`refs`, `comment`)
  across versions. **Answered:** 2.43 returns `refs` (an array of strings),
  2.40 returns `comment` (a single string); both hold the same unparseable
  prose describing the same violation, and the app keys on `id`, never on
  either field's content. See
  `docs/superpowers/notes/2026-09-plan3-integrity-api-findings.md`.
- Whether `access.write` is returned on group collections for non-admin
  users on 2.40. **Still open** — out of scope for Plans 1-3; a future plan
  should measure it before relying on it.
- Whether resolving org unit name translations inside the names SQL view is
  practical on 2.40 to 2.43, which would remove the divergence in 8a.
  **Still open** — out of scope for Plans 1-3; a future plan should
  investigate whether locale-aware resolution is possible inside the view.
