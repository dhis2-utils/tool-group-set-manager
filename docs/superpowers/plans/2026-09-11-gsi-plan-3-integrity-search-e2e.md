# Group Set Integrity Tool, Plan 3: Integrity overlay, search and hand-off Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the app: overlay DHIS2's own data integrity results beside the engine's numbers for users who may run them, make text search cover the whole population instead of the loaded page, clear the carried-forward defects, and prove the whole thing end to end on 2.40 and 2.43 and at EMIS scale before hand-off.

**Architecture:** A read-only integrity client (`src/data/integrity.ts`) that resolves the six logical checks against whatever names this server actually has, reads cached results without blocking, and triggers a run on demand; a provider (`src/hooks/useIntegrity.tsx`) that holds the last result per check and marks checks stale when the app writes; presentation on the dashboard card and in a third tab on the group set detail page, always beside the engine's own count and never in place of it. Search moves from the table component into the engine as one more `ObjectFilter` predicate, which is the only way it can see objects that were never paged in. Everything after that is verification: Playwright against both version seeds, a timed EMIS run, and the DHIS2 app review recipe.

**Tech Stack:** Unchanged from Plans 1 and 2. `@dhis2/cli-app-scripts` 12 (Vite), TypeScript strict, pnpm, React 18, `@dhis2/ui` 10.17, `@dhis2/app-runtime` 3, react-router-dom hash router, `@tanstack/react-query` v4, `@tanstack/react-virtual` v3, `idb` 8, Jest with React Testing Library. New in this plan: `@playwright/test`, dev dependency only, never imported by `src`.

**Spec:** `docs/superpowers/specs/2026-09-10-group-set-integrity-tool-design.md` — sections 4.5, 5.1, 5.2, 5.5, 8 and 9 define this plan.

**Base commit:** branch from `23f4284` (the tip of `plan-2-fixing`). Plan 2 is not merged to `main`; this plan builds directly on it. Work on a branch named `plan-3-integrity`.

**Also read before starting:**
- `docs/superpowers/notes/2026-09-plan3-integrity-api-findings.md` — what the integrity API actually does, measured on 2.40.12 and 2.43.1. Six findings, and every one of them changes a task in this plan. Tasks 1 to 4 cannot be done correctly without it.
- `docs/superpowers/notes/2026-09-plan2-write-compatibility.md` — the write paths, proven on both versions.
- `docs/superpowers/notes/2026-09-plan1-carry-forward.md` — Task 8 is its "Smaller, any time" list.
- `CLAUDE.md` — the project's conventions, including the translation rules.

## Global Constraints

- Minimum DHIS2 version 2.40; every request must work on 2.40 through 2.43. The integrity endpoints differ across that range in ways the findings note measures — nothing in this plan may hard-code a check name or a check code.
- `src/engine` must not import React, anything from `@dhis2/*`, or anything from `src/data` or `src/pages`.
- React 18 only. No Suspense for data fetching, no React 19 APIs. Explicit loading states.
- UI components only from `@dhis2/ui` 10.17.0. Read the real props in `node_modules/@dhis2/ui/` before using a component.
- CSS Modules with DHIS2 design tokens for colours and spacing. No hard-coded hex colours.
- Every user-facing string through `i18n.t()` from `@dhis2/d2-i18n`, following the rules in `CLAUDE.md`: one complete string per call, never a second argument, a `{placeholder}` interpolated afterwards with `interpolate()` when a value is needed, and no colons in the string.
- `displayName`, never `name`, for anything shown to a user.
- Never call `useDataQuery` directly; go through `useApiDataQuery`. Never disable paging on a data engine query; ask for a page size instead.
- TypeScript strict mode. No `any`, no `@ts-expect-error`.
- Test-driven: write the test first, run it, watch it fail for the right reason, then implement. Every task's report carries the RED and GREEN evidence.
- Verification after every task, all four clean and each run in the foreground with a generous timeout: `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm exec eslint src`, `pnpm exec prettier -c .`.
- One commit per task. End the message with a `Co-Authored-By` trailer naming the model that wrote it, and nothing after it. Never add a session-URL trailer; the user's configuration forbids it in repo history.
- **This plan adds no new write to DHIS2 metadata.** The one thing it posts is a data integrity run, which computes and stores nothing but its own results. Every existing write still requires the user to confirm that specific change in the interface first.

## The rules this plan is built on

**The engine is the source of truth.** Spec 4.5 says so in one line, and it governs
every screen in Tasks 3 and 4. DHIS2's numbers are national, cached, possibly hours
old, and unavailable to most users. The app's own numbers are scoped, current, and
available to everyone. So the integrity result is always shown *beside* the engine's
count with its run time attached, never instead of it, and a screen must read
correctly with the overlay entirely absent — which is the normal case for a district
manager, the app's primary user.

**Two numbers that disagree are information, not an error.** They are measuring
different populations: DHIS2 counts the whole hierarchy, the engine counts the scope.
The reconciliation line says which is which. Do not "fix" a difference by filtering
one to match the other; Task 4 filters the *details* to the scope precisely so the
comparison can be made honestly, and reports both numbers either way.

**Never block a page on an integrity read.** `timeout=0`, always. Finding 2 of the
findings note measures what the alternative costs: a full 60 seconds of nothing.

## File structure

| File | Responsibility |
|---|---|
| `src/data/integrity.ts` (new) | Resolve logical checks against the server's check list; read summaries and details; start a run. No React, no caching policy, no scope logic. |
| `src/data/integrity.test.ts` (new) | Every resolution case from the findings note's table, both payload shapes, the empty-`{}` case. |
| `src/hooks/useIntegrity.tsx` (new) | Provider: holds the resolved checks, the last summary per check, and which checks are stale. Owns the authority gate. |
| `src/components/IntegrityLine/` (new) | The one-line "DHIS2 reports N, last run <time>" presentation, with its stale marker. Used by the dashboard card and the tab. |
| `src/pages/GroupSetDetail/IntegrityTab.tsx` (new) | The third tab: per check, national count, in-scope count, engine count, run time, "Run now", and the scoped issue list. |
| `src/engine/queries.ts` (modify) | `ObjectFilter.text`, matched against a lazily built lowercase name index. |
| `src/engine/store.ts` (modify) | Own that index per type; invalidate it in `setNames`, `loadObjects` and `dropType`. |
| `src/components/ObjectsTable/ObjectsTable.tsx` (modify) | Drop the client-side filter and the paging guard that existed only because search was local. |
| `src/pages/GroupSetDetail/ObjectsTab.tsx` (modify) | Search becomes part of the filter it already owns. |
| `src/pages/Dashboard/Dashboard.tsx`, `src/components/GroupSetCard/GroupSetCard.tsx` (modify) | The integrity line on the card, and the SQL view repair nudge. |
| `e2e/` (new) | Playwright config, fixtures and specs. Never imported by `src`; excluded from the Jest run and from `tsc`'s app project. |
| `docs/superpowers/notes/2026-09-plan3-performance.md` (new) | Task 10's measured EMIS numbers against the 4.1 baseline. |

---

### Task 1: The integrity client

**Files:**
- Create: `src/data/integrity.ts`, `src/data/integrity.test.ts`
- Read first: `docs/superpowers/notes/2026-09-plan3-integrity-api-findings.md`, all six findings
- Follow the shape of: `src/data/sources/sqlViewAdmin.ts` (same `Fetcher`, same error style)

**Interfaces:**
- Consumes: `Fetcher` and `fetchJson` from `src/data/sources/DataSource`; `ObjectType` from `src/engine/types`.
- Produces:

```ts
/** The app's six logical checks, named for what they mean rather than for
 *  what any one server calls them. */
export type LogicalCheck =
    | 'orgUnitsMissingCompulsory'
    | 'orgUnitsConflicting'
    | 'dataElementsConflicting'
    | 'indicatorsConflicting'
    | 'categoryOptionsConflicting'
    | 'categoryOptionGroupSetsIncomplete'

export interface ResolvedCheck {
    logical: LogicalCheck
    /** the name this server uses, which is the key for every later call */
    name: string
    displayName: string
    objectType: ObjectType | null
    isSlow: boolean
}

export interface CheckSummary {
    name: string
    count: number
    /** ISO string from the server, or null when the check has never run */
    finishedTime: string | null
}

export interface CheckIssue {
    id: string
    displayName: string
    /** the server's prose, verbatim and unparsed, or null when absent */
    detail: string | null
}

export function resolveChecks(fetcher: Fetcher): Promise<ResolvedCheck[]>
export function readSummaries(fetcher: Fetcher, names: string[]): Promise<CheckSummary[]>
export function readDetails(fetcher: Fetcher, name: string): Promise<CheckIssue[]>
export function startRun(fetcher: Fetcher, names: string[], kind: 'summary' | 'details'): Promise<void>
```

- Consumed by: Tasks 2, 3, 4.

Candidate names per logical check, in preference order, copied from the findings
note's table. The first candidate present in the server's check list wins; a logical
check with no candidate present is omitted from `resolveChecks`' result entirely.

```ts
const CANDIDATES: Record<LogicalCheck, readonly string[]> = {
    orgUnitsMissingCompulsory: [
        'org_units_not_in_compulsory_group_sets',
        'orgunits_compulsory_group_count',
    ],
    orgUnitsConflicting: [
        'organisation_units_violating_exclusive_group_sets',
        'orgunit_group_sets_excess_groups',
    ],
    dataElementsConflicting: [
        'data_elements_violating_exclusive_group_sets',
        'data_elements_excess_groupset_membership',
    ],
    indicatorsConflicting: ['indicators_violating_exclusive_group_sets'],
    categoryOptionsConflicting: ['category_options_excess_groupset_membership'],
    categoryOptionGroupSetsIncomplete: ['category_option_group_sets_incomplete'],
}
```

`objectType` is derived from the logical check, not from the payload's
`issuesIdType`: that field is inconsistent across both versions and checks
(measured values include `organisationUnits`, `dataElements`, `indicators`,
`categories`, `categoryOptionGroupSets` and, on 2.40,
`data_elements_aggregate` for a check about data elements). The logical check
already says which of the app's four object types it concerns, so map from it
and use `issuesIdType` for nothing. `categoryOptionGroupSetsIncomplete`
concerns no object type the app loads and carries `objectType: null`, which is
what keeps it out of `markStale` and out of any tab.

Matching is on `name` only. Finding 1 measures why the code is not a safe key: the
code `OUVEGS` names the fast SQL check on 2.43 and a different, slow, programmatic
check on 2.40, so a code match silently picks the wrong check on the older version.
Say that in a comment at the constant, because it is exactly the "simplification"
a later reader will otherwise make.

- [ ] **Step 1: Write the failing tests for `resolveChecks`**

Build the check list fixtures from the findings note's table, not from imagination.
Cover: a 2.43-shaped list resolving all six to their 2.43 names; a 2.40-shaped list
resolving the two org unit checks to `orgunits_compulsory_group_count` and
`orgunit_group_sets_excess_groups` while the other four keep the shared names; a
list where only some checks exist, which returns only those, in `LogicalCheck`
order, with no throw; and — the one that pins finding 1 — a 2.40-shaped list that
also contains the decoy `org_units_violating_exclusive_group_sets` with code
`OUVEGS`, asserting `orgUnitsConflicting` resolves to `orgunit_group_sets_excess_groups`
and not to the decoy. Assert the request path is
`dataIntegrity?fields=name,code,displayName,issuesIdType,isSlow&paging=false`.

- [ ] **Step 2: Write the failing tests for the three payload readers**

Cover, with fixtures taken verbatim from findings 2, 3 and 4:

- `readSummaries` requests `timeout=0` and nothing else for a wait — assert the
  exact query string. A test that does not assert this cannot fail when someone
  later "fixes" a perceived race by raising the timeout, which is the regression
  that costs a user a minute of blank screen.
- `readSummaries` on the `{}` body returns one entry per requested name with
  `count: 0` and `finishedTime: null` — never an empty array, because the caller
  must be able to tell "ran, found nothing" from "never ran", and the shape of the
  answer is what carries that.
- `readDetails` on a 2.43 body reads `refs` into `detail`, joined with a space.
- `readDetails` on a 2.40 body reads `comment` into `detail`.
- `readDetails` on an issue with neither field yields `detail: null`.
- `readDetails` reads `name` into `displayName` (the details payload has no
  `displayName`; this is the one place the project's displayName rule bends, and it
  needs the comment saying so).
- `startRun` POSTs to `dataIntegrity/summary` or `dataIntegrity/details` with the
  checks in the query string, and resolves without reading the job id — the app
  polls the summary, not the job.

- [ ] **Step 3: Run them and watch them fail**

- [ ] **Step 4: Implement**

- [ ] **Step 5: Verify against both live instances**

Both are running: `http://dhis2-agent-gsi-p2:8080` (2.43.1) and
`http://dhis2-agent-gsi-p2-40:8080` (2.40.12), `local_admin` / `district`. Neither
may be deleted or reset. Write a throwaway node script that calls the three
functions against each, and put its actual output in the report: the six resolved
names per version, the counts, and one details issue per version. The two servers
must agree on 272 for the compulsory check and 17 for the org unit conflict check
(finding 5). If they do not, stop and report — that is the client reading the wrong
check, not the servers disagreeing.

- [ ] **Step 6: Commit**

```bash
git commit -m "Add the data integrity client, resolving checks by name per server"
```

---

### Task 2: The integrity provider and its staleness rule

**Files:**
- Create: `src/hooks/useIntegrity.tsx`, `src/hooks/useIntegrity.test.tsx`
- Modify: `src/hooks/useMembershipWrite.ts` to mark checks stale after a write
- Modify: `src/App.tsx` to mount the provider inside `EngineProvider`

**Interfaces:**
- Consumes: everything Task 1 produces; `useApiDataQuery`; `useConfig` for the fetcher.
- Produces:

```ts
export interface IntegrityState {
    /** false when the user lacks the authority, or the server refused */
    available: boolean
    checks: ResolvedCheck[]
    summaries: Record<string, CheckSummary>
    /** names whose result predates a write this session */
    stale: Set<string>
    isRunning: boolean
    error: string | null
    run: (names: string[]) => Promise<void>
    markStale: (objectType: ObjectType) => void
    refresh: () => Promise<void>
}
export function useIntegrity(): IntegrityState
```

- Consumed by: Tasks 3 and 4.

The authority gate is finding 6: read `me?fields=id,authorities` once and require
`ALL` or `F_PERFORM_MAINTENANCE`. Without it, `available` is false and **no integrity
request is ever made** — not resolve, not summary, not details. A 403 from any of the
three calls sets `available` to false permanently for the session and clears `error`:
an unavailable overlay is not a failure the user needs to read about, it is a feature
they do not have.

`markStale(objectType)` marks every resolved check whose `objectType` matches. Spec
4.5 forbids re-running automatically, so this sets a flag and nothing else. It is
called from `useMembershipWrite` after a successful write, in the same place
`invalidateType` is called, and — like `invalidateType` — a failure to mark must not
fail the write. Re-running is always the user pressing "Run now".

- [ ] **Step 1: Write the failing tests**

Cover: a user without either authority produces `available: false` and zero fetch
calls (assert on the fetcher mock's call count — this is the test that pins the
"never call it for them" rule, and a test that only asserts `available` cannot
fail when the calls happen anyway); a 403 mid-session flips `available` to false
with `error` null; `run` posts and then polls the summary until `finishedTime`
moves past the value it held before the run, and clears those names from `stale`;
a successful membership write marks exactly the checks of that object type stale
and leaves the others alone; and a write whose `markStale` throws still resolves
the write.

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Verify and commit**

```bash
git commit -m "Add the integrity provider, gated on authority and stale after a write"
```

---

### Task 3: The integrity line on the dashboard, and the SQL view nudge

**Files:**
- Create: `src/components/IntegrityLine/IntegrityLine.tsx`, `IntegrityLine.module.css`, `IntegrityLine.test.tsx`
- Modify: `src/components/GroupSetCard/GroupSetCard.tsx`, `src/pages/Dashboard/Dashboard.tsx`

**Interfaces:**
- Consumes: `useIntegrity()`; the card's existing `DashboardEntry`.
- Produces: `<IntegrityLine check={ResolvedCheck} summary={CheckSummary} stale={boolean} />`, used again by Task 4.

Spec 5.1 puts "the integrity result with its run time and a stale marker" on the card
for admins. One line, after the counts, reading as a complete sentence with the time
interpolated — never a bare number next to the engine's, which invites the reader to
compare two numbers that count different populations. A check that has never run says
so and offers nothing else; running is done from the tab, not from a card.

This task also closes the last parked item from Plan 2 (`deferred-items.txt`, Task
10): the D4 SQL view fallback is per-load and silent, so a view that breaks between
loads degrades every load with nothing telling the user it can be repaired. When
`sourceKind` came back as `metadata` after a fallback, the dashboard shows a notice
linking to Settings. `useEngine` already carries the source actually used; what it
does not carry is whether a fallback happened, so add that — a boolean set by
`loadAll` when `withSourceFallback` latches — rather than inferring it from the kind,
which is also `metadata` on a server that never had views at all and must stay silent
there.

- [ ] **Step 1: Write the failing tests**

Cover: the line renders the count and the run time; a never-run check renders the
never-run wording and no time; `stale` renders the stale marker; a user without the
overlay renders nothing at all from the card (not an empty element, not a
placeholder); the dashboard shows the repair notice after a fallback and stays
silent on a metadata-only server that never fell back.

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Verify and commit**

```bash
git commit -m "Show the integrity result on the dashboard card, and nudge a broken SQL view"
```

---

### Task 4: The DHIS2 integrity tab

**Files:**
- Create: `src/pages/GroupSetDetail/IntegrityTab.tsx`, `IntegrityTab.module.css`, `IntegrityTab.test.tsx`
- Modify: `src/pages/GroupSetDetail/GroupSetDetail.tsx` to add the third tab

**Interfaces:**
- Consumes: `useIntegrity()`, `IntegrityLine`, the engine client's `indexesOf` and `resolve`, `useScope()`.
- Produces: nothing other tasks consume.

Spec 5.2's third tab: for each check relevant to this set's object type — national
count, in-scope count, engine count, run time, "Run now", and the issue list filtered
to the scope. The tab is only reachable when `available` is true.

Scoping the details is the substance of this task, and it is the app's own work
because finding 5 establishes the endpoint has no scope parameter. Given the issue
ids from `readDetails`, ask the engine for their indexes (`indexesOf`), and keep the
ones inside the scope subtree. The engine already answers this for a list of ids;
what it must not be asked to do is answer it one id at a time, which at 272 issues
is 272 worker round trips.

The reconciliation line is one complete sentence naming both populations, so that a
difference reads as what it is. The three numbers are: the server's `count`
(national), the count of issues that fell inside the scope, and the engine's own
count for the same rule in the same scope. When the last two disagree, the line says
which is more recent — the engine always is, unless the check ran after the last
load, and the app knows both times.

An issue whose id the engine does not know (`indexesOf` yields -1) is neither in
scope nor out of it: it is an object the app has not loaded, most often because it
is a tracker data element under an aggregate-only configuration. Count those
separately and name them in their own line. Silently dropping them makes the in-scope
number quietly wrong in a way nobody can see.

- [ ] **Step 1: Write the failing tests**

Cover: the three numbers render, and the in-scope number counts only ids inside the
scope subtree; unknown ids are counted and named separately rather than folded into
either bucket; "Run now" calls `run` with exactly this tab's check names; a check
marked stale shows the marker and the suggestion to re-run, and the app does not
re-run on its own (assert `run` was not called on mount — the test that pins spec
4.5's "suggested, not triggered"); the details request is made once for a tab with
several checks sharing a type, not once per check; and the tab renders its issue
list with the server's prose shown verbatim where present.

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Verify against the live 2.43 instance**

Open the tab on Facility Ownership at national scope and at Bo district scope, and
put both screens' three numbers in the report. At national scope the in-scope count
must equal the national count. At Bo it must not, and the engine's count must equal
the in-scope count.

- [ ] **Step 5: Commit**

```bash
git commit -m "Add the DHIS2 integrity tab, scoping national results to the user's scope"
```

---

### Task 5: Text search in the engine

**Files:**
- Modify: `src/engine/queries.ts`, `src/engine/store.ts`
- Test: `src/engine/queries.test.ts`, `src/engine/store.test.ts`

**Interfaces:**
- Produces: `ObjectFilter.text?: string`, honoured by `listObjects` and therefore by
  `objectsFor`, `planAssignment` and every count derived from them.
- Consumed by: Task 6.

`text` matches an object whose name contains it, case-insensitively, after both sides
are trimmed. An empty or whitespace-only `text` is the same as no filter. A type with
no names loaded matches nothing rather than everything — a search that silently
returns the entire population is the worse failure of the two.

The naive implementation lowercases every name on every call, which at 200K org units
runs on every keystroke. Instead the store owns one lowercase array per type, built on
first use and dropped whenever the names change: `setNames`, `loadObjects` and
`dropType` all invalidate it. `queries.ts` stays pure — it receives the lowercase
array as a parameter alongside the ids array it already takes, and never builds one.

`text` composes with every existing predicate rather than replacing any of them; the
`ids` predicate documents why that matters, and the same reasoning applies here.

- [ ] **Step 1: Write the failing tests**

Cover: a match on a substring in the middle of a name; case insensitivity both ways;
a trimmed query; an empty and a whitespace-only query behaving as no filter; a type
with `names: null` matching nothing; `text` combined with a status filter and with
an ancestor filter, asserting the intersection rather than either alone; and the
index being rebuilt after `setNames` replaces the names — a test that searches, calls
`setNames` with different names, searches again and asserts the second result, which
is the one a cached index would fail.

- [ ] **Step 2: Write the failing performance test**

In the existing engine performance suite, against the generated 300K tree: 20
successive `objectsFor` calls with different `text` values complete within a budget
that a per-call rebuild cannot meet. State the measured number in the test's comment
and set the budget with the same cushion the existing budgets use.

- [ ] **Step 3: Run them and watch them fail**

- [ ] **Step 4: Implement**

- [ ] **Step 5: Verify and commit**

```bash
git commit -m "Search names in the engine, over one lazily built lowercase index"
```

---

### Task 6: Search the whole population from the objects table

**Files:**
- Modify: `src/pages/GroupSetDetail/ObjectsTab.tsx`, `src/components/ObjectsTable/ObjectsTable.tsx`
- Test: `src/components/ObjectsTable/ObjectsTable.test.tsx`, `src/pages/GroupSetDetail/ObjectsTab.test.tsx`

**Interfaces:**
- Consumes: Task 5's `ObjectFilter.text`.

The table's `search` prop, its client-side `rows` filter, its `searchNote`, and the
guard that stops auto-paging while a search is active all exist for one reason: the
search only ever saw loaded rows. Task 5 removes that reason, so all four go. Search
becomes part of the filter `ObjectsTab` already owns and passes down, the label stops
saying "loaded rows", and the total under the table becomes the real total for the
query rather than a count of what happened to be in memory.

Debounce the input before it reaches the filter. Every keystroke is otherwise a
worker round trip and a full re-query at 200K scale, and the filter is also what the
bulk fix dialog reads its population from — a half-typed query must not be what a
user opens the dialog on. 300 ms, and the pending value is what the input shows.

Two things must not regress, and both need their own test because both were bugs in
Plan 1: the table pages by offset with a fixed limit and appends, never re-requesting
loaded rows with a larger limit; and a filter change resets to offset 0 rather than
appending onto rows from the previous filter.

- [ ] **Step 1: Write the failing tests**

Cover: typing a query re-queries with `text` in the filter and renders rows that were
never loaded before (the point of the whole task — the fixture's match must be beyond
the first page); the debounce coalesces rapid typing into one query; clearing the
query restores the unfiltered total; the total shown is the engine's total for the
query; a filter change resets the offset; and paging still appends.

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Verify and commit**

```bash
git commit -m "Search the whole population, not the loaded rows"
```

---

### Task 7: A reload indicator on the detail page

**Files:**
- Modify: `src/pages/GroupSetDetail/GroupSetDetail.tsx`
- Test: `src/pages/GroupSetDetail/GroupSetDetail.test.tsx`

From the Plan 1 carry-forward: only the dashboard shows that a reload is running, so
numbers on the detail page can change under the user with no explanation. Show the
same indication the dashboard shows, from the same `status`, and say which type is
loading when the status names one.

- [ ] **Step 1: Write the failing test**

A load in progress renders the indication; a finished load does not; and the numbers
stay visible while it runs rather than being replaced by a loader — a page that
blanks on every background reload is worse than the problem being fixed.

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Verify and commit**

```bash
git commit -m "Say when a reload is running on the detail page"
```

---

### Task 8: The carried-forward small defects, as one batch

**Files:** listed per item below. One commit for the whole batch.

These are independent one- or two-line corrections from
`docs/superpowers/notes/2026-09-plan1-carry-forward.md` ("Smaller, any time") and
`deferred-items.txt`. Each gets a test that fails before the fix. None is worth its
own dispatch; every one is worth doing before hand-off.

- [ ] **Step 1: Write the failing tests, one per item**

1. `src/data/sources/sqlViewSource.ts` — a malformed level column is coerced to 0.
   Level 0 is impossible in DHIS2, so it lands as a silent wrong answer. Surface it
   as a parse error naming the row.
2. `src/data/loadAll.ts` — `setNames` runs after the type's `evaluate`, so a names
   failure records a type-level error though the counts are correct. Record it as
   what it is: names unavailable, counts good.
3. `src/utils/objectTypeLabels.ts` — the labels call `i18n.t` at module evaluation
   time, so a locale set after import is not reflected. Make them functions.
4. Count labels are inconsistent about thousands separators. Pick the formatter
   already used by the dashboard and use it everywhere a count is rendered.
5. Four CSS modules use hardcoded font sizes rather than tokens. Name them in the
   report and convert them.
6. `src/engine/queries.ts` — no test combines two object filters in one call, and
   none covers a flat type under a level or ancestor filter (which silently excludes
   everything). Add both tests; fix only if they fail.
7. `src/engine/store.ts` — the matrix's flat branch ignores the scope root.
   Harmless for types with no hierarchy, but wrong; make it explicit either way.
8. `src/pages/Dashboard/Dashboard.tsx` — sets that have not loaded yet sort to the
   bottom among the clean ones. Sort them into their own group and say why.
9. `src/data/metadataWrites.ts` — the short-name disambiguator hard-codes 38
   characters instead of deriving it from `MAX_SHORT_NAME_LENGTH` minus the id
   length, so an id longer than the usual 11 characters pushes the short name back
   over 50. Derive it.
10. `src/data/writes.ts` — a non-JSON 200 surfaces a raw parse error as the
    user-visible message. The conclusion is right and the wording is not; say the
    server returned something unreadable, and keep the raw text in the diagnostics
    the result already carries.

- [ ] **Step 2: Run them and watch each fail for its own reason**

- [ ] **Step 3: Implement all ten**

- [ ] **Step 4: Verify and commit**

```bash
git commit -m "Clear the carried-forward small defects"
```

---

### Task 9: The Playwright end-to-end suite

**Files:**
- Create: `e2e/playwright.config.ts`, `e2e/fixtures/session.ts`, `e2e/flows.spec.ts`
- Modify: `package.json` (a `test:e2e` script and the `@playwright/test` dev dependency), `jest.config.js` and the TypeScript config to keep `e2e` out of the unit test run and out of the app build

**How the app is served, and why it is not the dev server.** Build the app and install
the zip into the instance (`pnpm build`, then `POST /api/apps` with the zip), and point
Playwright at the app's URL on the instance. The dev server cannot be used: it and its
`--proxy` are two different origins, the broker instances send no `access-control-*`
headers, and 2.43 moved `cors.allowed.origins` into `dhis.conf`, which the broker does
not expose. Installing the built app puts the page on the same origin as the API and
the problem disappears. This also tests the artefact that ships.

**How a session is obtained.** Basic-auth `GET /api/me` to get the session cookie, then
seed the browser context with it. Do not drive the React login form, and do not use
`POST /api/auth/login` — it does not exist on 2.40 and redirects to the legacy login
page, which a redirect-following client captures as an anonymous cookie with no error
at all, so the test then asserts against a login screen.

**Which servers.** Both, in a project matrix: `agent-gsi-p2` (2.43.1) and
`agent-gsi-p2-40` (2.40.12). Neither may be deleted or reset. The suite must leave
each instance as it found it — every test that writes reverts through the app's own
History, which is also a test of revert.

- [ ] **Step 1: Add Playwright and the config, and prove the session fixture**

One spec that logs in and asserts the dashboard renders group set cards, running green
against both projects, before any flow is written. A session fixture that silently
fails is the failure mode that makes every later spec meaningless.

- [ ] **Step 2: Write the five flows from spec 8**

Dashboard, drill down, single assign, bulk move, revert. Each asserts on what the user
sees, and each that writes ends by reverting. The bulk move flow must assert the
preview's counts against the result panel's counts — the two disagreeing is the class
of bug this whole app exists to avoid shipping.

- [ ] **Step 3: Run the suite against both projects**

Put the full output in the report, both versions, including timings.

- [ ] **Step 4: Commit**

```bash
git commit -m "Add the Playwright end-to-end suite, against 2.40 and 2.43"
```

---

### Task 10: The EMIS performance run

**Files:**
- Create: `docs/superpowers/notes/2026-09-plan3-performance.md`
- Modify: the spec's section 4.1 if a number in it is now wrong

`agent-gsi-emis` is stopped and preserved; start it, wait for the API, and do not
delete it. It holds 200K+ org units, and it is the only instance where the app's
performance claims can be checked.

Measure, cold and warm: load time per phase, the dashboard's first paint, opening a
set with 200K objects, a text search (Task 5's new path, which never ran at this
scale), a bulk preview, and one small write. The SQL views are a prerequisite there —
create them from Settings if they are absent, and time that too.

Compare every number against spec 4.1's baseline and against the user's stated budget
of roughly 60 seconds. A number that misses the budget is a finding to report with its
measurement, not something to fix quietly inside this task.

- [ ] **Step 1: Start the instance and confirm the views**

- [ ] **Step 2: Measure, cold and warm, and write the note**

- [ ] **Step 3: Stop the instance and commit**

```bash
git commit -m "Record the EMIS performance run at 200K org units"
```

---

### Task 11: The app review pass and the hand-off

**Files:**
- Modify: `CLAUDE.md`, `docs/superpowers/specs/2026-09-10-group-set-integrity-tool-design.md`

Spec 8 ends with "a final pass with the DHIS2 app review recipe before hand-off". Run
it. Report every finding; fix what is a defect in this plan's own work, and record
anything else as a finding rather than expanding scope at the last step.

Then close the spec's section 9. Every open item in it is now measured — the
`lastUpdated` behaviour and the SQL view paging by Plan 2, the integrity payload field
names by this plan's findings note — except the two that were never in scope (the
`access.write` question on 2.40, and whether name translations can be resolved inside
the SQL view). Replace each answered item with its answer and a pointer to the note
that measured it, and leave the two unanswered ones standing as what a future plan
would pick up.

Update `CLAUDE.md` with the architecture decisions this plan added: the integrity
overlay is read-only and gated on authority, checks resolve by name at runtime because
neither name nor code is stable across 2.40 to 2.43, and text search is an engine
filter rather than a component concern.

- [ ] **Step 1: Run the review recipe and report**

- [ ] **Step 2: Fix what belongs to this plan**

- [ ] **Step 3: Close section 9 and update CLAUDE.md**

- [ ] **Step 4: Verify and commit**

```bash
git commit -m "Close the spec's open items and record Plan 3's decisions"
```

---

## What this plan does not do

- It adds no new metadata write. The integrity overlay is read-only apart from asking
  the server to run its own checks.
- It does not make the app's numbers depend on DHIS2's. The engine remains the source
  of truth, and every screen must read correctly with the overlay absent.
- It does not resolve org unit name translations inside the SQL views (spec 8a), or
  settle whether `access.write` is returned on group collections for non-admin users
  on 2.40. Both stay open in spec section 9.
