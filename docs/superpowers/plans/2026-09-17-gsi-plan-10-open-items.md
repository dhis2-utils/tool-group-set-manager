# Plan 10: Open Items Close-out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close, or explicitly accept with a written reason, every entry in `docs/superpowers/notes/OPEN-ITEMS.md`, so that the index is short and every line on it is something nobody has decided about yet.

**Architecture:** Three kinds of work, in this order. First, code changes that need only Jest (the four "with teeth" items, the test gaps, the smaller code items), each a small self-contained commit. Second, evidence work that needs live DHIS2 instances through the broker (the bridge-row measurement, a seed-agnostic e2e smoke suite, and the manual-review spec's §10 multi-version review against different databases), after a checkpoint with the maintainer. Third, the reconciliation commit that rewrites `OPEN-ITEMS.md` and strikes each closed entry in its own carry-forward note. Nothing here adds product scope; the one specified-but-unbuilt feature (translated names in the SQL view) is closed as accepted by maintainer decision, not built.

**Tech Stack:** TypeScript, React 18, @dhis2/app-runtime, @dhis2/ui 10.17, TanStack Query v4, Jest + Testing Library, Playwright 1.63, the d2-broker (`$DHIS2_BROKER_URL`) for instances.

**Spec:** This plan implements no new spec. It argues from `docs/superpowers/notes/OPEN-ITEMS.md` (the requirements list), the carry-forward notes it points at (`docs/superpowers/notes/2026-09-plan{1,5,6,7,8}-carry-forward.md`), and three existing specs where an item cites them: `docs/superpowers/specs/2026-09-10-group-set-integrity-tool-design.md` (§8a, §9), `docs/superpowers/specs/2026-09-15-manual-review-1-design.md` (§10), `docs/superpowers/specs/2026-09-16-metadata-freshness-design.md` (§5, §6).

## Global Constraints

Copied from `CLAUDE.md` and the sandbox rules. Every task's requirements include these.

- `src/engine` is pure TypeScript, runs in a Web Worker, no React or DHIS2 imports. Test it with plain Jest.
- Data fetching through `useApiDataQuery` (TanStack Query v4), never `useDataQuery` directly.
- Every user-facing string is one argument-free `i18n.t('…')` call. No colon inside an `i18n.t()` string. A sentence is translated whole; values go in `{name}` placeholders filled by `interpolate()` from `src/utils/interpolate.ts` (single braces). Counts are two complete strings chosen on `count === 1`. Run `pnpm exec d2-app-scripts i18n extract` after adding strings.
- Verification commands: `pnpm test` (Jest), `pnpm exec tsc --noEmit`, `pnpm exec eslint src`, `pnpm lint` (eslint + `prettier -c .` + `tsc -p e2e --noEmit`), `pnpm test:e2e --project <name>`.
- Broker instances: reach them at `http://dhis2-<name>:8080`, never `localhost`. Credentials `local_admin` / `district`. Run **one instance at a time** (the broker cannot afford more). The instance cap counts stopped instances; four exist today (`agent-dqa`, `agent-gsi-emis`, `agent-gsi-p2`, `agent-gsi-p2-40`). Delete only instances this plan created (`agent-gsi-p10-*`). Full API in the `dhis2-instances` skill.
- Install the app on an instance with `pnpm build` then `curl -u local_admin:district -X POST -F "file=@build/bundle/group-set-integrity-tool-1.0.0.zip" http://dhis2-<name>:8080/api/apps`. Reinstall after every source change or you test an old build.
- A freshly seeded instance can report empty legacy list endpoints (`/api/organisationUnitGroupSets` total 0) until Tomcat is restarted once. Restart before concluding metadata is missing (`2026-09-plan8-multiversion-brief.md`).
- The e2e `Area` set (`uIuxlbV1vRT`) on the Sierra Leone instances must hold only the thirteen level-2 districts; the suite's `beforeAll` net repairs it, but read that net's output.
- Git: work on branch `plan-10-open-items` cut from `c75c712` (state this base at hand-off). Linear history, one commit per task, no `Claude-Session:` trailer. Commit subjects are imperative sentences without a type prefix, matching the existing log ("Give the e2e suite a cleanup net").
- The sandbox GitHub token is read-only: `gh` can read issues and trees, `git push` and `gh issue create` are refused. Anything that must be published is written to a file and handed to the user.
- Closing an item means striking it in `OPEN-ITEMS.md` **and** in its own carry-forward note, in the same commit. Tasks 2 to 17 leave the notes alone and Task 19 does the striking in one pass, so the index changes once and stays consistent while the branch is in progress. If the branch is abandoned part-way, Task 19 must still be run for whatever landed.

## Baseline, measured 2026-09-17 on `c75c712`

| Check | Result |
| --- | --- |
| `pnpm test` | 62 suites, 698 tests, all pass, 72 s |
| `pnpm exec tsc --noEmit` | clean |
| `pnpm exec eslint src` | clean |
| `pnpm exec tsc -p e2e --noEmit` | clean |
| `pnpm exec prettier -c .` | **31 files fail** (pure formatting drift, see Task 1) |
| `BulkFixDialog.tsx` | 1428 lines (the index says ~1100; it has grown) |

Every OPEN-ITEMS entry was re-checked against the code for this plan, including the Plan 6, 7 and 8 entries the index says were only inherited. All are still accurate, with two corrections folded in below: `byLeastUsed`'s "defensive, not reachable" comment **is** present (`Dashboard.tsx:135`), and `parseUsageListGrid`'s `at()` comment **is** present but mis-indented (a Task 1 symptom).

## Decisions from the pre-execution interview (2026-09-17)

Each open-ended choice in the first draft was put to the maintainer one at a time. The answers, which the tasks below implement:

| Question | Decision |
| --- | --- |
| Nested `<button>` inside the card's `div[role="button"]` | **Accept as is.** Keyboard seam already fixed; the same information is one tab away on the Usage tab. |
| Settings' duplicated four-state machine | **Extract a shared hook now** (Task 12a). |
| `planColumns` computed twice per Overview render | **Accept as is.** |
| Unit test for Settings' invalidation propagating | **Accept**: carried by the e2e usage flow plus Task 3's key-prefix test. |
| `batchSize` parameter on `writeMemberships` | **Keep as a test seam**; Task 2 removes the duplicated predicate and pins that production never passes one. |
| `BulkFixDialog.tsx` size | **Split the JSX too** (Task 10a), after Task 10 moves the data pieces out. |
| Prettier drift on 31 files | **One formatting commit first** (Task 1). |
| Review databases (HMIS dump on 2.40, EMIS on 2.41, DQ test bed on 2.42, Sierra Leone on 2.43) | **As planned.** Fall back to the Sierra Leone v40 seed only if the HMIS dump has no organisation unit group sets. |
| Organisation unit name translations in the SQL view | **Drop it.** "This is an admin tool, so it is not critical." No spike; the divergence in main spec §8a becomes permanent and the item closes as accepted (Task 16). |
| Checkpoint | **Pause after Phase D.** Report, then wait for a go before any broker instance is started. |

## What this plan deliberately does not do

Recorded here so Task 19 can move these from "open" to "accepted" with the reasoning attached.

- **Translate organisation unit names in the names SQL view** (main spec §8a, §9). Maintainer decision above: an admin tool showing untranslated names on the SQL view path is acceptable. The app already states which source it used, and §8a's remedy (remove `GSI_ORGUNIT_NAMES` to drop only names back to the metadata API) stands for any instance that needs translated names. Task 16 records this in the spec and the index.
- **Fix the real `<button>` nested inside the card's `div[role="button"]`** (`GroupSetCard.tsx`). Plan 6's final review judged it the least-bad option for a tag that must navigate somewhere other than its own card, and fixed the keyboard seam. Accepted as is.
- **`planColumns` computed twice per Overview render.** Both are memoised on their own inputs; the cost is one extra pass over a group list per result change. Accepted.
- **Unit-test that Settings' invalidation propagates.** The propagation is TanStack Query's, and a unit test through a mocked query layer proves nothing about it. Task 3 pins the property that matters at unit level (both usage query keys sit under the one prefix `refresh()` invalidates), and the e2e usage flow proves the propagation live. Accepted.
- **Plan 7 §4's three records** (`lastupdated-probe.js` never committed, `write-shapes.js`'s non-neutral restore, the `pg_stat_database` caveat). These are notes for a future measurement, not work. Task 19 moves them to a "Records" section.
- **`batchSize` stays a parameter of `writeMemberships`**, as a test seam only (five tests split three ids across batches to keep their assertions readable). Task 2 removes the duplicated predicate that was the actual trap, and pins that production never passes a `batchSize`.

## Task order and phases

| Phase | Tasks | Needs |
| --- | --- | --- |
| A. Baseline | 1 | nothing |
| B. With teeth | 2, 3, 4, 5 | Jest |
| C. Test gaps | 6, 7, 8 | Jest; Task 8 verifies in Task 17 |
| D. Smaller code items | 9, 10, 10a, 11, 12, 12a, 13 | Jest |
| **Checkpoint** | report to the maintainer; wait for a go | |
| E. Evidence and review | 14, 15, 16, 17, 18 | broker instances, one at a time (Task 16 needs none) |
| F. Reconciliation | 19 | everything above |

Tasks 2 to 13 are independent of each other except that Task 10 depends on Task 2 (it imports `takesPatchRoute`), Task 10a depends on Task 10 (it splits the file Task 10 has already slimmed), Task 12a depends on Task 3 (Settings' usage refresh call has moved by then), and Task 7 depends on Task 3 (it tests `USAGE_QUERY_PREFIX`). Phase E tasks share instances and should run in the order given to minimise starts and stops.

## File structure

New files:

- `src/data/groupMembers.ts`, `src/data/groupMembers.test.ts` (Task 10) — one function, `readGroupMembers`, the server re-read the freshness check does.
- `src/components/BulkFixDialog/constants.ts`, `useCatchAllCreation.ts` (+ test), `ActionStep.tsx` (+ test), `PreviewStep.tsx` (+ test), `ApplyStep.tsx` (+ test) (Task 10a) — the dialog's three steps and the catch-all creation, extracted without behaviour change.
- `src/pages/Settings/useAdminSection.ts`, `useAdminSection.test.tsx` (Task 12a) — the check/busy/error machine both Settings sections share.
- `scripts/probe/bridge-rows.js` (Task 14) — throwaway SQL views that count bridge rows per version.
- `e2e/smoke.spec.ts` (Task 17) — read-only, seed-agnostic flows.
- `docs/superpowers/notes/2026-09-dhis2-ui-align-issue.md` (Task 15)
- `docs/superpowers/notes/2026-09-plan10-multiversion-review.md` (Task 18)

Modified files, by task, are listed in each task.

---

### Task 1: Restore a green `pnpm lint`

`prettier -c .` fails on 31 files under `src/`, `e2e/`, `scripts/` and `README.md`. The drift is line wrapping only (checked: `prettier src/utils/metadataAge.ts | diff` shows re-wrapped `i18n.t(...)` calls and nothing else). Nothing records this and `pnpm lint` is the project's stated check, so every later task would otherwise inherit a red baseline it did not cause.

**Files:**
- Modify: the 31 files `pnpm exec prettier -c .` names (formatting only)

- [ ] **Step 1: Confirm the failure and its extent**

Run: `pnpm exec prettier -c . 2>&1 | tail -3`
Expected: `Code style issues found in 31 files.`

- [ ] **Step 2: Format**

Run: `pnpm format` (this is `prettier . -w`, honouring `.prettierignore`, which excludes `docs/`)

- [ ] **Step 3: Verify nothing but formatting changed**

Run: `git diff --stat | tail -1` and then `pnpm test 2>&1 | tail -5 && pnpm exec tsc --noEmit && pnpm lint`
Expected: 698 tests pass, tsc clean, `pnpm lint` exits 0. If any test changes outcome, stop: prettier does not change semantics, so a failing test means something else is wrong.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Format the tree so pnpm lint passes again"
```

---

### Task 2: One route predicate for the writer and the bulk fix dialog

`writes.ts` decides which groups take the JSON Patch route with `additions + deletions > batchSize`; `BulkFixDialog.tsx` decides which groups to re-read for freshness with its own copy against `DEFAULT_BATCH_SIZE`. They agree only because `useMembershipWrite.ts` passes the constant explicitly, and no test fails if that stops being true (plan8 §3).

**Files:**
- Modify: `src/data/writes.ts:295-400`
- Modify: `src/data/writes.test.ts` (calls at lines 101, 365, 408, 454, 498 pass a numeric fifth argument; calls at 545, 571, 605, 643, 686, 723 pass `DEFAULT_BATCH_SIZE, new Map(...)`)
- Modify: `src/hooks/useMembershipWrite.ts:5-10, 150-158`
- Modify: `src/hooks/useMembershipWrite.test.tsx:374-406`
- Modify: `src/components/BulkFixDialog/BulkFixDialog.tsx:40, 613-629`

**Interfaces:**
- Produces: `export function takesPatchRoute(change: GroupChange, batchSize?: number): boolean` in `src/data/writes.ts`; `export interface WriteOptions { batchSize?: number; completeMembers?: Map<string, string[]> }`; `writeMemberships(fetcher, objectType, changes, onProgress, options?: WriteOptions)`. Task 10 imports `takesPatchRoute`.

- [ ] **Step 1: Write the failing tests in `writes.test.ts`**

Add a new top-level `describe` after the `writeMemberships` one, and one test inside the existing `describe('write shape by change size (spec 6.1)')` block (which already defines `bigChange`):

```ts
describe('takesPatchRoute', () => {
    const change = (n: number): GroupChange => ({
        groupId: 'g',
        additions: Array.from({ length: n }, (_, i) => `o${i}`),
        deletions: [],
    })

    it('is false at the threshold and true one above it', () => {
        expect(takesPatchRoute(change(DEFAULT_BATCH_SIZE))).toBe(false)
        expect(takesPatchRoute(change(DEFAULT_BATCH_SIZE + 1))).toBe(true)
    })

    it('counts additions and deletions together', () => {
        expect(
            takesPatchRoute({
                groupId: 'g',
                additions: Array.from({ length: 3000 }, (_, i) => `a${i}`),
                deletions: Array.from({ length: 2001 }, (_, i) => `d${i}`),
            })
        ).toBe(true)
    })

    it('honours an explicit batch size, which only tests pass', () => {
        expect(takesPatchRoute(change(3), 2)).toBe(true)
        expect(takesPatchRoute(change(2), 2)).toBe(false)
    })
})
```

Inside `describe('write shape by change size (spec 6.1)')`:

```ts
        it('routes exactly the changes takesPatchRoute flags, when every group has a complete membership', async () => {
            const patched: string[] = []
            const fetcher = async (path: string, init?: RequestInit) => {
                if (init?.method === 'PATCH') {
                    patched.push(path)
                    return json({})
                }
                const body = JSON.parse(String(init?.body)) as {
                    additions: unknown[]
                }
                return okStats(body.additions.length)
            }
            const changes = [
                bigChange(DEFAULT_BATCH_SIZE),
                { ...bigChange(DEFAULT_BATCH_SIZE + 1), groupId: 'g2' },
            ]
            await writeMemberships(
                fetcher,
                'organisationUnit',
                changes,
                () => undefined,
                {
                    completeMembers: new Map([
                        ['g1', []],
                        ['g2', []],
                    ]),
                }
            )
            expect(patched).toEqual(
                changes
                    .filter((c) => takesPatchRoute(c))
                    .map((c) => `organisationUnitGroups/${c.groupId}`)
            )
        })
```

Add `takesPatchRoute` to the import from `./writes`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test -- src/data/writes.test.ts`
Expected: FAIL, `takesPatchRoute` is not exported / options object not accepted.

- [ ] **Step 3: Change `writes.ts`**

Replace the `writeMemberships` signature and the internal predicate. Delete the "Finding 5 (fix round 2)" comment on the parameter.

```ts
/**
 * Options `writeMemberships` takes beyond the change list. `batchSize` is a
 * test seam: production always writes at `DEFAULT_BATCH_SIZE`, and
 * `useMembershipWrite.test.tsx` pins that the hook never passes one,
 * because `takesPatchRoute`'s default below is also what `BulkFixDialog`
 * decides its pre-write re-read with. Five tests use a batch size of one or
 * two so that a three-id change splits into batches an assertion can read.
 */
export interface WriteOptions {
    batchSize?: number
    completeMembers?: Map<string, string[]>
}

/**
 * Whether a group's change is large enough to take the JSON Patch route
 * (spec 2026-09-16 section 6.1). The one predicate both the writer below
 * and `BulkFixDialog`'s freshness check use, so the two cannot disagree
 * about where the threshold sits -- they used to be two copies that agreed
 * only because the hook between them passed the constant explicitly.
 */
export function takesPatchRoute(
    change: GroupChange,
    batchSize: number = DEFAULT_BATCH_SIZE
): boolean {
    return change.additions.length + change.deletions.length > batchSize
}

export async function writeMemberships(
    fetcher: Fetcher,
    objectType: ObjectType,
    changes: GroupChange[],
    onProgress: (done: number, total: number) => void,
    { batchSize = DEFAULT_BATCH_SIZE, completeMembers }: WriteOptions = {}
): Promise<WriteResult> {
    const endpoint = ENDPOINTS[objectType]

    // ...keep the existing spec 6.1 comment...
    const routesToPatch = (change: GroupChange): boolean =>
        takesPatchRoute(change, batchSize) &&
        completeMembers?.has(change.groupId) === true
```

Rename the single use of the old inner `takesPatchRoute` in the `units` flatMap to `routesToPatch`.

- [ ] **Step 4: Update the existing `writes.test.ts` calls**

Each numeric fifth argument becomes an options object: line 101 `2` → `{ batchSize: 2 }`; lines 365, 408, 454, 498 `1` → `{ batchSize: 1 }`. Each `DEFAULT_BATCH_SIZE,\n new Map(...)` pair (lines 545, 571, 605, 643, 686, 723) becomes `{ completeMembers: new Map(...) }`. Check the test at line 697 ("falls back to batched above the threshold when no complete membership is given"): if it passes `DEFAULT_BATCH_SIZE` alone, drop the argument.

Run: `grep -n "DEFAULT_BATCH_SIZE,$" src/data/writes.test.ts` should print nothing afterwards.

- [ ] **Step 5: Update the hook and its tests**

`useMembershipWrite.ts`: remove `DEFAULT_BATCH_SIZE` from the import; the call becomes

```ts
                const result = await writeMemberships(
                    fetcher,
                    objectType,
                    input.changes,
                    input.onProgress ?? (() => undefined),
                    { completeMembers: input.completeMembers }
                )
```

`useMembershipWrite.test.tsx`: rewrite the two tests at lines ~379 and ~393 and their comment:

```ts
// The hook never chooses a batch size. `writeMemberships`' default is also
// what `takesPatchRoute` (and so BulkFixDialog's freshness re-read) uses,
// so a batchSize appearing here would silently desync the two -- this pair
// of tests is what would fail.
it('passes completeMembers through, and no batch size', async () => {
    const completeMembers = new Map([['g1', ['existing1']]])

    await doWrite([change], { completeMembers })

    expect(mockWriteMembershipsImpl).toHaveBeenCalledWith(
        expect.anything(),
        'organisationUnit',
        [change],
        expect.any(Function),
        { completeMembers }
    )
})

it('still writes when completeMembers is omitted, passing none through', async () => {
    const writeResult = await doWrite()

    const options = mockWriteMembershipsImpl.mock.calls[0][4] as Record<
        string,
        unknown
    >
    expect(options).toEqual({ completeMembers: undefined })
    expect(Object.keys(options)).not.toContain('batchSize')
    expect(writeResult.changeSet).toBeDefined()
})
```

Remove the now-unused `DEFAULT_BATCH_SIZE` import from that test file.

- [ ] **Step 6: Point the dialog at the shared predicate**

`BulkFixDialog.tsx`: change the import on line 40 to `import { BatchOutcome, takesPatchRoute } from '@/data/writes'` and delete the local `takesPatchRoute` with its doc comment (lines 613-629). Nothing else changes: `readPatchRouteGroups` and `needsCheck` already call `takesPatchRoute(c)`.

- [ ] **Step 7: Run everything**

Run: `pnpm test -- src/data/writes.test.ts src/hooks/useMembershipWrite.test.tsx src/components/BulkFixDialog && pnpm exec tsc --noEmit && pnpm exec eslint src`
Expected: all pass, clean.

- [ ] **Step 8: Commit**

```bash
git add src/data/writes.ts src/data/writes.test.ts src/hooks/useMembershipWrite.ts src/hooks/useMembershipWrite.test.tsx src/components/BulkFixDialog/BulkFixDialog.tsx
git commit -m "Share one patch-route predicate between the writer and the bulk fix dialog"
```

---

### Task 3: Namespace the usage query keys, and give Settings a refresh without a read

`useUsage.ts`'s `refresh()` invalidates the app-wide prefix `['sqlViewData']`, correct today only because nothing else uses it (plan6 §1). Settings mounts the whole `useUsage()` hook, paying a lookup and an up-to-5000-row read, to reach `refresh()` (plan6 §4).

**Files:**
- Modify: `src/hooks/useUsage.ts`
- Modify: `src/hooks/useUsage.test.tsx:60-71, 286-305`
- Modify: `src/pages/Settings/Settings.tsx:31, 76-85, 224, 249`
- Modify: `src/pages/Settings/Settings.test.tsx:14-28`

**Interfaces:**
- Produces: `export const USAGE_QUERY_PREFIX = 'usage'`; `export function useUsageRefresh(): () => void` in `src/hooks/useUsage.ts`. Task 7 tests the prefix.

- [ ] **Step 1: Write the failing tests in `useUsage.test.tsx`**

Change the discriminator in `mockQueries` from `args.queryKey[0] === 'sqlViews'` to `args.queryKey[1] === 'sqlViews'` (this alone makes the whole file fail until the keys move). Replace the `refresh invalidates…` test's two expectations with:

```ts
        expect(mockInvalidateQueries).toHaveBeenCalledTimes(1)
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
            queryKey: [USAGE_QUERY_PREFIX],
        })
```

Add, at the end of the `describe('useUsage')` block:

```ts
    it('keeps both of its query keys under the usage prefix, so refresh cannot reach another feature', async () => {
        mockQueries(
            lookup([
                {
                    id: 'v1',
                    code: 'GSI_GROUPSET_USAGE',
                    type: 'VIEW',
                    access: { data: { read: true } },
                },
            ]),
            data([])
        )
        renderHook(() => useUsage())
        const keys = mockQuery.mock.calls.map(
            (c) => (c[0] as { queryKey: unknown[] }).queryKey
        )
        expect(keys.some((k) => k[1] === 'sqlViews')).toBe(true)
        expect(keys.some((k) => k[1] === 'sqlViewData')).toBe(true)
        keys.forEach((key) => expect(key[0]).toBe(USAGE_QUERY_PREFIX))
    })
```

And a new `describe`:

```ts
describe('useUsageRefresh', () => {
    it('invalidates the usage prefix and nothing else, without issuing any query', () => {
        mockQuery.mockClear()
        mockInvalidateQueries.mockClear()
        const { result } = renderHook(() => useUsageRefresh())
        result.current()
        expect(mockQuery).not.toHaveBeenCalled()
        expect(mockInvalidateQueries).toHaveBeenCalledTimes(1)
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
            queryKey: [USAGE_QUERY_PREFIX],
        })
    })
})
```

Import `USAGE_QUERY_PREFIX, useUsageRefresh` from `./useUsage`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test -- src/hooks/useUsage.test.tsx`
Expected: FAIL (exports missing; every test that relied on the old discriminator fails).

- [ ] **Step 3: Change `useUsage.ts`**

```ts
/**
 * Every query this feature issues sits under this prefix, and `refresh`
 * invalidates the prefix and nothing else. It used to invalidate
 * `['sqlViewData']`, an app-wide name that was correct only while no other
 * SQL-view-backed query existed -- a second one would have been invalidated
 * by every usage install or removal.
 */
export const USAGE_QUERY_PREFIX = 'usage'
const LOOKUP_KEY = [USAGE_QUERY_PREFIX, 'sqlViews', USAGE_SQL_VIEW_CODE]
const dataKey = (viewId: string) => [USAGE_QUERY_PREFIX, 'sqlViewData', viewId]

/**
 * Tells every mounted reader of `useUsage()` that the view changed, without
 * reading anything itself. Settings uses this: it installs and removes the
 * view but never displays usage, and mounting the full hook there cost a
 * lookup plus an up-to-5000-row read for data it threw away.
 *
 * Invalidation rather than refetch, and by prefix rather than by id: the
 * reasoning is in `useUsage`'s own comment on `refresh`.
 */
export function useUsageRefresh(): () => void {
    const queryClient = useQueryClient()
    return useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: [USAGE_QUERY_PREFIX] })
    }, [queryClient])
}
```

In `useUsage`: `queryKey: LOOKUP_KEY` for the lookup, `queryKey: dataKey(view?.id ?? 'none')` for the read, and replace the `refresh` `useCallback` (and its `queryClient` line) with `const refresh = useUsageRefresh()`. Keep the long comment above it but delete the sentence beginning "Matching `['sqlViewData']` as a key prefix" and replace it with one line: "Invalidating the shared prefix covers both keys, whichever view id is current."

- [ ] **Step 4: Change Settings**

`Settings.tsx`: import `useUsageRefresh` instead of `useUsage`; replace lines 76-85 (the comment and `const usage = useUsage()`) with:

```ts
    // Not the full `useUsage()` hook: Settings never displays usage, and
    // mounting the hook here issued the lookup and the data read on every
    // visit just to reach `refresh`. This tells the readers that do display
    // it (Dashboard, GroupSetCard, UsageTab) that the view just changed.
    const refreshUsageReaders = useUsageRefresh()
```

Replace both `usage.refresh()` calls with `refreshUsageReaders()`.

`Settings.test.tsx`: the mock becomes

```ts
jest.mock('@/hooks/useUsage', () => ({
    useUsageRefresh: () => mockUsageRefresh,
}))
```

and its comment is shortened to say Settings depends on the module only for `useUsageRefresh`.

- [ ] **Step 5: Run**

Run: `pnpm test -- src/hooks/useUsage.test.tsx src/pages/Settings && pnpm exec tsc --noEmit && pnpm exec eslint src`
Expected: pass, clean. Also `grep -rn "sqlViewData" src | grep -v test` should show only `useUsage.ts`'s `dataKey`.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useUsage.ts src/hooks/useUsage.test.tsx src/pages/Settings/Settings.tsx src/pages/Settings/Settings.test.tsx
git commit -m "Namespace the usage query keys and let Settings refresh them without reading"
```

---

### Task 4: Keep loaded rows and offer a retry when an object page fails

`ObjectsTable.tsx:497` returns a bare error notice on any failed page, discarding rows already on screen, with no way back except changing the filter (plan1). `useEngineQuery` has no way to re-issue a call.

**Files:**
- Modify: `src/hooks/useEngineQuery.ts`
- Modify: `src/hooks/useEngineQuery.test.tsx`
- Modify: `src/components/ObjectsTable/ObjectsTable.tsx:1-12, 438-441, 497-514`
- Modify: `src/components/ObjectsTable/ObjectsTable.test.tsx:63-165` (the controllable fake) plus two new tests

**Interfaces:**
- Produces: `EngineQueryState<T>` gains `refetch: () => void` (stable identity). Every consumer that destructures the hook keeps working; only `ObjectsTable` uses it.

- [ ] **Step 1: Write the failing hook test**

In `useEngineQuery.test.tsx`, add `fireEvent` to the Testing Library import and:

```ts
it('refetch re-issues the same call after a failure and clears the error once it succeeds', async () => {
    mockCall.mockRejectedValueOnce(new Error('worker went away'))
    const RetryProbe = () => {
        const { data, error, refetch } = useEngineQuery<string>('indexOf', [
            'organisationUnit',
            7,
        ])
        return (
            <div>
                <div data-test="error">{error ?? 'no-error'}</div>
                <div data-test="data">{data ?? 'no-data'}</div>
                <button onClick={refetch}>retry</button>
            </div>
        )
    }
    render(<RetryProbe />)
    await waitFor(() =>
        expect(screen.getByTestId('error')).toHaveTextContent(
            'worker went away'
        )
    )
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    await waitFor(() =>
        expect(data()).toHaveTextContent('result:["organisationUnit",7]')
    )
    expect(screen.getByTestId('error')).toHaveTextContent('no-error')
    expect(mockCall).toHaveBeenCalledTimes(2)
})
```

Run: `pnpm test -- src/hooks/useEngineQuery.test.tsx` → FAIL (`refetch` undefined; click throws).

- [ ] **Step 2: Add `refetch` to the hook**

```ts
interface EngineQueryState<T> {
    data: T | undefined
    isLoading: boolean
    error: string | null
    /**
     * Re-issues the same call. Only meaningful after an error -- a
     * successful result is already re-requested by the effect whenever the
     * engine's load phase or the arguments change, so nothing else needs it.
     */
    refetch: () => void
}
```

Inside the hook: `const [attempt, setAttempt] = useState(0)` and `const refetch = useCallback(() => setAttempt((a) => a + 1), [])`; add `attempt` to the effect's dependency array with the comment `// \`attempt\` is bumped by refetch() and nothing else.`; include `refetch` in both branches of the returned `useMemo` and in its dependency list. Import `useCallback`.

Run the hook test → PASS. Run `pnpm exec tsc --noEmit` → the ObjectsTable fake in tests does not need `refetch` yet because it is a `jest.fn()` mock, but check.

- [ ] **Step 3: Extend the ObjectsTable test fake, then write the two failing component tests**

In `createControllableEngineQuery`: store both settle functions, add an error slot, and expose `refetch`.

```ts
    const resolvers = new Map<
        string,
        { resolve: (result: unknown) => void; reject: (message: string) => void }
    >()
    // ...
        const [state, setState] = React.useState<{
            data: unknown
            settledKey: string | null
            isLoading: boolean
            error: string | null
        }>({ data: undefined, settledKey: null, isLoading: true, error: null })
        React.useEffect(() => {
            if (!enabled) {
                return
            }
            let cancelled = false
            setState((s) => ({ ...s, isLoading: true }))
            requests.push({ method, key })
            new Promise<unknown>((resolve, reject) => {
                resolvers.set(key, {
                    resolve,
                    reject: (message) => reject(new Error(message)),
                })
            })
                .then((result) => {
                    if (!cancelled) {
                        setState({ data: result, settledKey: key, isLoading: false, error: null })
                    }
                })
                .catch((e: Error) => {
                    if (!cancelled) {
                        setState({ data: undefined, settledKey: key, isLoading: false, error: e.message })
                    }
                })
            return () => {
                cancelled = true
            }
        }, [key, epoch, enabled])
        // Mirrors the real hook: refetch bumps a per-instance counter the
        // request effect depends on.
        const refetch = () => setEpoch((e) => e + 1)
        return state.settledKey === key
            ? { data: state.data, isLoading: state.isLoading, error: state.error, refetch }
            : { data: undefined, isLoading: enabled, error: null, refetch }
```

Update `resolve` and `resolveParentsFor` to call `.resolve(...)` on the stored entry, and add:

```ts
    const reject = (args: unknown[], message: string) => {
        const key = JSON.stringify(args)
        const entry = resolvers.get(key)
        if (!entry) {
            throw new Error(`no pending request for ${key}`)
        }
        entry.reject(message)
    }
```

Return `reject` alongside the others. Then the two tests:

```ts
it('keeps the rows already loaded when a later page fails, and Try again re-requests that page', async () => {
    const { useFakeQuery, resolve, reject, resolveParentsFor, requests } =
        createControllableEngineQuery()
    mockUseEngineQuery.mockImplementation(useFakeQuery)

    render(<ObjectsTable set={set} scope={scope} filter={{}} />)
    const firstPageArgs = lastCallArgs()
    const firstPageItems = makeItems(200)
    await act(async () => {
        resolve(firstPageArgs, { total: 1000, items: firstPageItems })
    })
    await act(async () => {
        resolveParentsFor(firstPageItems)
    })

    const scrollEl = getScrollEl()
    act(() => {
        scrollEl.scrollTop = 6000
        fireEvent.scroll(scrollEl)
    })
    await waitFor(() => expect(lastCallArgs()[3]).toBe(200))
    const secondPageArgs = lastCallArgs()
    await act(async () => {
        reject(secondPageArgs, 'worker went away')
    })

    // The first page is still there, and the failure is named beside it
    // rather than replacing it.
    act(() => {
        scrollEl.scrollTop = 0
        fireEvent.scroll(scrollEl)
    })
    await waitFor(() => expect(screen.getByText('Item 0')).toBeInTheDocument())
    expect(screen.getByText('worker went away')).toBeInTheDocument()

    const objectsRequests = () =>
        requests.filter((r) => r.method === 'objectsFor').length
    const before = objectsRequests()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(objectsRequests()).toBe(before + 1))

    const secondPageItems = makeItems(200, { offset: 200 })
    await act(async () => {
        resolve(secondPageArgs, { total: 1000, items: secondPageItems })
    })
    await act(async () => {
        resolveParentsFor(secondPageItems)
    })
    expect(screen.queryByText('worker went away')).not.toBeInTheDocument()
    act(() => {
        scrollEl.scrollTop = 13000
        fireEvent.scroll(scrollEl)
    })
    await waitFor(() =>
        expect(screen.getByText('Item 380')).toBeInTheDocument()
    )
})

it('offers Try again in place of the loader when the very first page fails', async () => {
    const { useFakeQuery, reject, requests } = createControllableEngineQuery()
    mockUseEngineQuery.mockImplementation(useFakeQuery)
    render(<ObjectsTable set={set} scope={scope} filter={{}} />)
    await act(async () => {
        reject(lastCallArgs(), 'worker went away')
    })
    expect(screen.getByText('worker went away')).toBeInTheDocument()
    expect(screen.queryByTestId('objects-table-scroll')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() =>
        expect(requests.filter((r) => r.method === 'objectsFor')).toHaveLength(2)
    )
})
```

Run: `pnpm test -- src/components/ObjectsTable/ObjectsTable.test.tsx` → the two new tests FAIL (no "Try again" button; rows gone).

- [ ] **Step 4: Change `ObjectsTable.tsx`**

Destructure `refetch` from the `objectsFor` query. Replace the `if (error) { return <NoticeBox error>{error}</NoticeBox> }` block and the loader check with:

```tsx
    // A failed page names itself beside the rows already on screen rather
    // than replacing them -- losing two thousand loaded rows to one failed
    // request is the worse outcome -- and offers the one honest next step,
    // asking the engine again. Distinct from the deliberate no-retry on a
    // rejected write in handleConfirm above: a read that failed changed
    // nothing, so repeating it is safe.
    const errorNotice = error ? (
        <NoticeBox error title={i18n.t('Could not load this page of objects')}>
            {error}
            <div>
                <Button small onClick={refetch}>
                    {i18n.t('Try again')}
                </Button>
            </div>
        </NoticeBox>
    ) : null
    if (current.total === null) {
        return errorNotice ?? <CircularLoader small />
    }
```

and render `{errorNotice}` directly after the `<p className={styles.count} …>` element.

- [ ] **Step 5: Extract strings and run**

Run: `pnpm exec d2-app-scripts i18n extract && pnpm test -- src/components/ObjectsTable src/hooks/useEngineQuery.test.tsx && pnpm exec tsc --noEmit && pnpm exec eslint src`
Expected: pass; `i18n/en.pot` gains `Could not load this page of objects` (`Try again` already exists).

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useEngineQuery.ts src/hooks/useEngineQuery.test.tsx src/components/ObjectsTable i18n src/locales
git commit -m "Keep loaded object rows when a page fails, and offer to try again"
```

---

### Task 5: Abandon an in-flight load when the engine provider unmounts

`generationRef` is bumped per `reload` call but not on unmount, so a load in flight at unmount continues, calls `loadAll` against a terminated worker (whose `postMessage` is a silent no-op, so the promise never settles) and sets state on a gone component (plan1).

**Files:**
- Modify: `src/hooks/useEngine.tsx:190-202`
- Modify: `src/hooks/useEngine.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
it('an unmount during an in-flight load abandons it rather than driving a terminated worker', async () => {
    let resolveSource: ((r: MockSelectSourceResult) => void) | undefined
    mockSelectSource.mockImplementationOnce(
        () =>
            new Promise<MockSelectSourceResult>((resolve) => {
                resolveSource = resolve
            })
    )
    const { unmount } = render(
        <Wrapper>
            <Probe />
        </Wrapper>
    )
    await waitFor(() => expect(mockSelectSource).toHaveBeenCalledTimes(1))
    unmount()
    await act(async () => {
        resolveSource?.({ source: { kind: 'metadata' }, sqlViews: null })
        for (let i = 0; i < 5; i++) {
            await Promise.resolve()
        }
    })
    // Without the generation bump on unmount, the continuation ran on and
    // called loadAll with a client whose worker had already been terminated.
    expect(mockLoadAll).not.toHaveBeenCalled()
})
```

Run: `pnpm test -- src/hooks/useEngine.test.tsx` → FAIL (`loadAll` called once).

- [ ] **Step 2: Bump the generation in the worker effect's cleanup**

```ts
        return () => {
            // Any load still in flight belongs to a provider that no longer
            // exists. Bumping the generation makes its continuation return
            // at the next isCurrent() check instead of calling loadAll on a
            // terminated worker (whose postMessage is a silent no-op, so the
            // call would never settle) and setting state on a gone tree.
            generationRef.current++
            created.terminate()
            setClient(null)
        }
```

Run the test → PASS. Run the whole file (the remount test at line 320 must still pass: the remount's own `reload` bumps the generation again and wins).

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useEngine.tsx src/hooks/useEngine.test.tsx
git commit -m "Abandon an in-flight metadata load when the engine provider unmounts"
```

---

### Task 6: Pin `onProgress` across a mixed patch-plus-batch write

Each route's progress accounting is tested alone (plan8 §2).

**Files:**
- Modify: `src/data/writes.test.ts` (inside `describe('write shape by change size (spec 6.1)')`)

- [ ] **Step 1: Write the test**

```ts
        it('reports progress as one unit per patch group and one per batch, in the order written', async () => {
            const calls: { path: string; method: string }[] = []
            const fetcher = async (path: string, init?: RequestInit) => {
                calls.push({ path, method: init?.method ?? 'GET' })
                if (init?.method === 'PATCH') {
                    return json({})
                }
                const body = JSON.parse(String(init?.body)) as {
                    additions: unknown[]
                }
                return okStats(body.additions.length)
            }
            const progress: [number, number][] = []
            const result = await writeMemberships(
                fetcher,
                'organisationUnit',
                [
                    bigChange(DEFAULT_BATCH_SIZE + 1),
                    { ...bigChange(DEFAULT_BATCH_SIZE + 1), groupId: 'g2' },
                ],
                (done, total) => progress.push([done, total]),
                // g1 has a complete membership and takes the patch route; g2
                // does not and is split into two batches.
                { completeMembers: new Map([['g1', ['existing1']]]) }
            )
            expect(calls.map((c) => c.path)).toEqual([
                'organisationUnitGroups/g1',
                'organisationUnitGroups/g2/organisationUnits',
                'organisationUnitGroups/g2/organisationUnits',
            ])
            expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1)
            expect(progress).toEqual([
                [1, 3],
                [2, 3],
                [3, 3],
            ])
            expect(result.applied).toHaveLength(3)
            expect(result.unaccounted).toEqual([])
        })
```

- [ ] **Step 2: Run**

Run: `pnpm test -- src/data/writes.test.ts`
Expected: PASS on the first run. This test pins existing behaviour; if it fails, the failure is a finding to record, not a reason to change the assertion.

- [ ] **Step 3: Commit**

```bash
git add src/data/writes.test.ts
git commit -m "Pin write progress across a mixed patch-and-batch change list"
```

---

### Task 7: Close the remaining Plan 6 test gaps

`removeUsageView`'s success path, `checkUsageView`'s one-request short-circuit, and `UsageTab`'s `'loading'` state have no unit tests (plan6 §3). The fourth gap in that entry, Settings' invalidation propagating, is handled by Task 3's prefix test plus the e2e flow and is recorded as accepted in Task 19.

**Files:**
- Modify: `src/data/sources/usageAdmin.test.ts`
- Modify: `src/pages/GroupSetDetail/UsageTab.test.tsx`

- [ ] **Step 1: Write the tests**

In `usageAdmin.test.ts`, inside `describe('checkUsageView')`:

```ts
    it('costs one request, not two, when the metadata already rules the view out', async () => {
        const fetcher = jest.fn(async () =>
            ok({
                sqlViews: [
                    {
                        id: 'v1',
                        code: 'GSI_GROUPSET_USAGE',
                        type: 'MATERIALIZED_VIEW',
                        access: { data: { read: true } },
                    },
                ],
            })
        ) as unknown as Fetcher
        await checkUsageView(fetcher)
        // No read probe: a view the metadata already refuses is not worth a
        // second round trip to confirm.
        expect(fetcher).toHaveBeenCalledTimes(1)
    })
```

Inside `describe('removeUsageView')`:

```ts
    it('deletes the view by id and resolves when the server accepts', async () => {
        const fetcher = jest.fn(async () => ok({})) as unknown as Fetcher
        await expect(removeUsageView(fetcher, 'v1')).resolves.toBeUndefined()
        expect(fetcher).toHaveBeenCalledWith('sqlViews/v1', {
            method: 'DELETE',
        })
    })
```

In `UsageTab.test.tsx`:

```ts
    it('shows a loader, not the install prompt, while the usage lookup is still in flight', () => {
        mockUsage.mockReturnValue({
            status: 'loading',
            error: null,
            forSet: () => null,
            refresh: jest.fn(),
        })
        render(
            <MemoryRouter>
                <UsageTab set={set()} />
            </MemoryRouter>
        )
        expect(
            screen.getByTestId('dhis2-uicore-circularloader')
        ).toBeInTheDocument()
        expect(
            screen.queryByText('Go to Settings to install it')
        ).not.toBeInTheDocument()
    })
```

(Check how the existing tests in that file render `UsageTab`; if they use a helper, use it. `@dhis2/ui`'s `CircularLoader` renders `data-test="dhis2-uicore-circularloader"`, and `jest.setup.js` configures `data-test` as the test id attribute, as the other test files rely on.)

- [ ] **Step 2: Run**

Run: `pnpm test -- src/data/sources/usageAdmin.test.ts src/pages/GroupSetDetail/UsageTab.test.tsx`
Expected: PASS first time (these pin existing behaviour).

- [ ] **Step 3: Commit**

```bash
git add src/data/sources/usageAdmin.test.ts src/pages/GroupSetDetail/UsageTab.test.tsx
git commit -m "Cover the usage view removal, the check short-circuit and the loading tab"
```

---

### Task 8: Scope the `'0 objects'` e2e locator

`e2e/flows.spec.ts:989` uses `root.getByText('0 objects', { exact: true })`, which collides with `GroupsPanel`'s per-group `0 objects` text the moment a test switches tabs mid-flow (plan5 §5). The same test already scopes its other count assertions to `[data-test="objects-count"]`.

**Files:**
- Modify: `e2e/flows.spec.ts:986-991`

- [ ] **Step 1: Change the locator**

Replace

```ts
        await expect(root.getByText('0 objects', { exact: true })).toBeVisible(
            { timeout: 5_000 }
        )
```

with

```ts
        // Scoped like the two count assertions above: GroupsPanel renders
        // "0 objects" for an empty group on the Overview tab, so a bare text
        // match is a strict-mode violation waiting for the first test that
        // switches tabs mid-flow.
        await expect(countText).toHaveText('0 objects', { timeout: 5_000 })
```

- [ ] **Step 2: Type-check the suite**

Run: `pnpm exec tsc -p e2e --noEmit`
Expected: clean. Live verification happens in Task 17 Step 5 (the full `2.43.1` project run), which must include the `search` test passing.

- [ ] **Step 3: Commit**

```bash
git add e2e/flows.spec.ts
git commit -m "Scope the empty-search count locator to the objects table"
```

---

### Task 9: Stop the freshness indicator ticking while it shows no age

`MetadataFreshness`'s 30-second interval runs from mount even while `loadedAt` is null and the component renders nothing (plan8 §3).

**Files:**
- Modify: `src/components/MetadataFreshness/MetadataFreshness.tsx:24-31`
- Modify: `src/components/MetadataFreshness/MetadataFreshness.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
it('only ticks while it has an age to keep current', () => {
    jest.useFakeTimers()
    try {
        const { rerender } = render(<MetadataFreshness loadedAt={null} />)
        expect(jest.getTimerCount()).toBe(0)
        rerender(<MetadataFreshness loadedAt={Date.now()} />)
        expect(jest.getTimerCount()).toBe(1)
        rerender(<MetadataFreshness loadedAt={null} />)
        expect(jest.getTimerCount()).toBe(0)
    } finally {
        jest.useRealTimers()
    }
})
```

Run: `pnpm test -- src/components/MetadataFreshness` → FAIL (`getTimerCount()` is 1 with `loadedAt` null).

- [ ] **Step 2: Gate the interval**

```tsx
    // Only while there is an age on screen to keep current. While
    // `loadedAt` is null the component renders nothing, or the busy label,
    // neither of which reads the clock -- so a tick there is a re-render
    // for nobody.
    const showsAge = loadedAt !== null
    useEffect(() => {
        if (!showsAge) {
            return
        }
        const id = setInterval(() => setNow(Date.now()), TICK_MS)
        return () => clearInterval(id)
    }, [showsAge])
```

Run the file → PASS (all eight tests).

- [ ] **Step 3: Commit**

```bash
git add src/components/MetadataFreshness
git commit -m "Tick the freshness indicator only while it shows an age"
```

---

### Task 10: Compare plans by content, and move the freshness check's data pieces out of the dialog

The freshness check compares plans with an order-sensitive `JSON.stringify`, so an equivalent plan in a different order forces a spurious re-confirmation (plan8 §3, fails safe). `readPatchRouteGroups`, the one server read the check makes, lives inside the 1428-line component (plan8 §3's size note). Depends on Task 2.

**Files:**
- Modify: `src/engine/changeSet.ts`, `src/engine/changeSet.test.ts`
- Create: `src/data/groupMembers.ts`, `src/data/groupMembers.test.ts`
- Modify: `src/components/BulkFixDialog/BulkFixDialog.tsx:631-689, 853-858`
- Modify: `src/components/BulkFixDialog/BulkFixDialog.test.tsx` (one new test in `describe('pre-write freshness check')`)

**Interfaces:**
- Produces: `export function sameChanges(a: GroupChange[], b: GroupChange[]): boolean` in `src/engine/changeSet.ts`; `export async function readGroupMembers(fetcher: Fetcher, objectType: ObjectType, groupIds: string[], signal?: AbortSignal): Promise<Map<string, string[]>>` in `src/data/groupMembers.ts`.

- [ ] **Step 1: Write the failing engine tests**

In `changeSet.test.ts`:

```ts
describe('sameChanges', () => {
    const a: GroupChange[] = [
        { groupId: 'g1', additions: ['x', 'y'], deletions: ['z'] },
        { groupId: 'g2', additions: [], deletions: ['w'] },
    ]

    it('is true for the same delta listed in a different order', () => {
        const reordered: GroupChange[] = [
            { groupId: 'g2', additions: [], deletions: ['w'] },
            { groupId: 'g1', additions: ['y', 'x'], deletions: ['z'] },
        ]
        expect(sameChanges(a, reordered)).toBe(true)
    })

    it('is false when one id differs', () => {
        const other: GroupChange[] = [
            { groupId: 'g1', additions: ['x', 'q'], deletions: ['z'] },
            { groupId: 'g2', additions: [], deletions: ['w'] },
        ]
        expect(sameChanges(a, other)).toBe(false)
    })

    it('is false when a group is missing or extra', () => {
        expect(sameChanges(a, a.slice(0, 1))).toBe(false)
        expect(
            sameChanges(a, [
                ...a,
                { groupId: 'g3', additions: ['n'], deletions: [] },
            ])
        ).toBe(false)
    })

    it('is false when an addition became a deletion', () => {
        expect(
            sameChanges(
                [{ groupId: 'g1', additions: ['x'], deletions: [] }],
                [{ groupId: 'g1', additions: [], deletions: ['x'] }]
            )
        ).toBe(false)
    })
})
```

Run: `pnpm test -- src/engine/changeSet.test.ts` → FAIL (not exported).

- [ ] **Step 2: Implement `sameChanges`**

```ts
/**
 * Whether two change lists describe the same membership delta, regardless
 * of the order groups or ids are listed in. The bulk fix's pre-write check
 * compares the previewed plan with the one recomputed from fresh
 * membership, and a `JSON.stringify` comparison there asked the user to
 * re-confirm a plan that had merely been reordered. Assumes each group
 * appears once per list, which `planAssignment` guarantees.
 */
export function sameChanges(a: GroupChange[], b: GroupChange[]): boolean {
    if (a.length !== b.length) {
        return false
    }
    const byGroup = new Map(b.map((change) => [change.groupId, change]))
    return a.every((change) => {
        const other = byGroup.get(change.groupId)
        return (
            other !== undefined &&
            sameIds(change.additions, other.additions) &&
            sameIds(change.deletions, other.deletions)
        )
    })
}

function sameIds(x: string[], y: string[]): boolean {
    if (x.length !== y.length) {
        return false
    }
    const sortedX = [...x].sort()
    const sortedY = [...y].sort()
    return sortedX.every((id, i) => id === sortedY[i])
}
```

Run → PASS.

- [ ] **Step 3: Write the failing `groupMembers.test.ts`**

```ts
import { readGroupMembers } from './groupMembers'
import { Fetcher } from './sources/DataSource'

const ok = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response

describe('readGroupMembers', () => {
    it('reads each group by id only, unpaged, bypassing the browser cache', async () => {
        const fetcher = jest.fn(async () =>
            ok({ organisationUnits: [{ id: 'm1' }, { id: 'm2' }] })
        ) as unknown as jest.Mock
        const result = await readGroupMembers(
            fetcher as unknown as Fetcher,
            'organisationUnit',
            ['g1']
        )
        expect(result).toEqual(new Map([['g1', ['m1', 'm2']]]))
        const [path, init] = fetcher.mock.calls[0] as [string, RequestInit]
        expect(path).toBe(
            'organisationUnitGroups/g1/organisationUnits?fields=id&paging=false'
        )
        expect(init.cache).toBe('no-store')
    })

    it('reads every group and keys the result by group id', async () => {
        const fetcher = jest.fn(async (path: string) =>
            ok({
                dataElements: [{ id: path.includes('/a/') ? 'ma' : 'mb' }],
            })
        ) as unknown as Fetcher
        const result = await readGroupMembers(fetcher, 'dataElement', ['a', 'b'])
        expect(result).toEqual(
            new Map([
                ['a', ['ma']],
                ['b', ['mb']],
            ])
        )
    })

    it('returns an empty map for no groups without a request', async () => {
        const fetcher = jest.fn() as unknown as Fetcher
        await expect(
            readGroupMembers(fetcher, 'organisationUnit', [])
        ).resolves.toEqual(new Map())
        expect(fetcher).not.toHaveBeenCalled()
    })

    it('rejects with the status when a read fails', async () => {
        const fetcher = jest.fn(async () =>
            ({ ok: false, status: 502 }) as unknown as Response
        ) as unknown as Fetcher
        await expect(
            readGroupMembers(fetcher, 'organisationUnit', ['g1'])
        ).rejects.toThrow('HTTP 502')
    })

    it('passes the abort signal to every request', async () => {
        const controller = new AbortController()
        const fetcher = jest.fn(async () =>
            ok({ organisationUnits: [] })
        ) as unknown as jest.Mock
        await readGroupMembers(
            fetcher as unknown as Fetcher,
            'organisationUnit',
            ['g1', 'g2'],
            controller.signal
        )
        fetcher.mock.calls.forEach(([, init]: [string, RequestInit]) =>
            expect(init.signal).toBe(controller.signal)
        )
    })
})
```

Run → FAIL (module missing).

- [ ] **Step 4: Create `src/data/groupMembers.ts`**

Move the body of `readPatchRouteGroups` (BulkFixDialog.tsx lines 649-689) here, minus the `takesPatchRoute` filtering, with its doc comment adapted:

```ts
import { ENDPOINTS } from './endpoints'
import { Fetcher } from './sources/DataSource'
import { ObjectType } from '@/engine/types'

/**
 * The complete current membership of the named groups, read from the
 * server right now. The bulk fix's pre-write check calls this for the
 * groups about to receive a JSON Patch replace (spec 2026-09-16 section
 * 5.1): a replace overwrites the whole collection, so a member someone else
 * added since our snapshot would be silently dropped unless the list we
 * send was just re-read.
 *
 * `cache: 'no-store'` because a view or collection an earlier build created
 * may carry a two-week `Cache-Control` (2026-09-plan7-e2e-write-flows.md),
 * and a cached answer here defeats the whole point. `paging=false` because
 * a default page of 50 would look like a small group. Groups are read in
 * parallel; the measured cost is 1-2 s per group on a 266k-unit instance
 * (2026-09-plan8-reread-cost.md).
 */
export async function readGroupMembers(
    fetcher: Fetcher,
    objectType: ObjectType,
    groupIds: string[],
    signal?: AbortSignal
): Promise<Map<string, string[]>> {
    if (groupIds.length === 0) {
        return new Map()
    }
    const endpoint = ENDPOINTS[objectType]
    const entries = await Promise.all(
        groupIds.map(async (groupId) => {
            const response = await fetcher(
                `${endpoint.groups}/${groupId}/${endpoint.members}?fields=id&paging=false`,
                { cache: 'no-store', signal }
            )
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`)
            }
            const body = (await response.json()) as Record<
                string,
                { id: string }[]
            >
            return [
                groupId,
                (body[endpoint.members] ?? []).map((o) => o.id),
            ] as const
        })
    )
    return new Map(entries)
}
```

Run `groupMembers.test.ts` → PASS.

- [ ] **Step 5: Write the failing dialog test**

Inside `describe('pre-write freshness check')` in `BulkFixDialog.test.tsx`, after the `beforeEach`:

```ts
        it('writes without re-confirmation when the recomputed plan is the same delta in a different order', async () => {
            const reordered = [
                {
                    ...PATCH_CHANGE[0],
                    additions: [...PATCH_CHANGE[0].additions].reverse(),
                },
            ]
            mockClientCall.mockImplementation((method: string) => {
                if (method === 'planAssignment') {
                    return Promise.resolve(
                        plan({
                            changes: reordered,
                            affected: reordered[0].additions.length,
                        })
                    )
                }
                return Promise.resolve(undefined)
            })
            await renderAndReachApply()
            fireEvent.click(screen.getByRole('button', { name: /^apply/i }))
            await waitFor(() => expect(mockWrite).toHaveBeenCalledTimes(1))
            expect(
                screen.queryByText('The metadata changed while you were reviewing')
            ).not.toBeInTheDocument()
        })
```

(Confirm the exact re-confirmation sentence by reading the `setRecheck` render branch in `BulkFixDialog.tsx`; use the string the component renders.)

Run → FAIL (re-confirmation shown, `mockWrite` not called).

- [ ] **Step 6: Change the dialog**

Import `sameChanges` from `@/engine/changeSet` and `readGroupMembers` from `@/data/groupMembers`. Replace `readPatchRouteGroups` (lines 631-689) with:

```ts
    /**
     * The membership of only the groups this plan will write by JSON Patch,
     * read fresh -- see `readGroupMembers` for why, and spec 5.1 for why
     * only those groups. Returns an empty map when nothing crosses the
     * threshold, which `runFreshnessCheck` has already ruled out before
     * calling this.
     */
    const readPatchRouteGroups = (planChanges: GroupChange[], signal?: AbortSignal) =>
        readGroupMembers(
            fetcher,
            set.objectType,
            planChanges.filter(takesPatchRoute).map((c) => c.groupId),
            signal
        )
```

Replace the comparison:

```ts
            const unchanged =
                recomputed.affected === referencePlan.affected &&
                sameChanges(recomputed.changes, referencePlan.changes)
```

Remove the `ENDPOINTS` import if nothing else in the file uses it (check with `grep -n ENDPOINTS src/components/BulkFixDialog/BulkFixDialog.tsx`).

- [ ] **Step 7: Run**

Run: `pnpm test -- src/components/BulkFixDialog src/engine/changeSet.test.ts src/data/groupMembers.test.ts && pnpm exec tsc --noEmit && pnpm exec eslint src`
Expected: pass, including the existing URL-shape and `no-store` tests at BulkFixDialog.test.tsx ~1796-1814, which now exercise `readGroupMembers` through the component. Note the new line count: `wc -l src/components/BulkFixDialog/BulkFixDialog.tsx` (expect roughly 1370).

- [ ] **Step 8: Commit**

```bash
git add src/engine/changeSet.ts src/engine/changeSet.test.ts src/data/groupMembers.ts src/data/groupMembers.test.ts src/components/BulkFixDialog
git commit -m "Compare recomputed plans by content, and read group members outside the dialog"
```

---

### Task 10a: Split `BulkFixDialog` into its three steps and a catch-all hook

Maintainer decision: split the JSX too. After Task 10 the file is ~1370 lines: ~180 of module-level helpers and constants, ~750 of state and handlers, ~440 of JSX across three `step === …` branches plus the footer. This task is a **pure extraction with no behaviour change**: every string, class, prop and handler moves verbatim, and the 54 existing component tests (which render `BulkFixDialog` and drive it through the DOM) are the safety net. Each extraction is its own commit so a regression bisects to one move. Depends on Task 10.

**Files:**
- Create: `src/components/BulkFixDialog/constants.ts`
- Create: `src/components/BulkFixDialog/useCatchAllCreation.ts`, `useCatchAllCreation.test.tsx`
- Create: `src/components/BulkFixDialog/ActionStep.tsx`, `ActionStep.test.tsx`
- Create: `src/components/BulkFixDialog/PreviewStep.tsx`, `PreviewStep.test.tsx`
- Create: `src/components/BulkFixDialog/ApplyStep.tsx`, `ApplyStep.test.tsx`
- Modify: `src/components/BulkFixDialog/BulkFixDialog.tsx`

**Interfaces (what each new module exports; the dialog is their only consumer):**

```ts
// constants.ts -- moved verbatim from the top of BulkFixDialog.tsx
export const CHECK_TIMEOUT_MS = 60_000
export const CHECK_TIMEOUT = 'CHECK_TIMEOUT'
export const SAMPLE_SIZE = 20
export const SAMPLE_FETCH_SIZE = 100
export const CSV_PAGE_SIZE = 1000
export const MAX_SHORT_NAME_LENGTH = 50
export const CATCH_ALL_NAME_PATTERN = /other|unknown/i
export const VIOLATION_STATUSES: Status[]   // the existing array
export type Action = 'moveToCatchAll' | 'assignAll'
export type Step = 'action' | 'preview' | 'apply'

// useCatchAllCreation.ts
export interface CatchAllNames { displayName: string; shortName: string }
export interface CatchAllCreation {
    names: CatchAllNames
    setNames: React.Dispatch<React.SetStateAction<CatchAllNames>>
    nameTooLong: boolean
    namesValid: boolean
    creating: boolean
    error: string | null
    createdGroup: { id: string; displayName: string } | null
    create: () => Promise<void>
}
export function useCatchAllCreation(args: {
    set: GroupSetMeta
    fetcher: Fetcher
    reload: (force: boolean) => Promise<void>
    onCreated: (group: { id: string; displayName: string }) => void
}): CatchAllCreation

// ActionStep.tsx
export interface ActionStepProps {
    action: Action
    onAction: (next: Action) => void
    configLoaded: boolean
    targetGroupId: string
    onTargetChange: (id: string) => void
    targetGroups: { id: string; displayName: string }[]   // `allGroups`
    showCreateOffer: boolean
    catchAll: CatchAllCreation
}
export const ActionStep: React.FC<ActionStepProps>

// PreviewStep.tsx
export interface PreviewStepProps {
    action: Action
    filterText: string | undefined
    plan: AssignmentPlan | null | undefined
    planLoading: boolean
    planError: string | null
    checkingFreshness: boolean
    checkError: string | null
    recheck: { previewed: number; recomputed: AssignmentPlan } | null
    groups: GroupSetMeta['groups']
    previewObjects: ChangeSetPreviewObjects
    csvBusy: boolean
    csvError: string | null
    onDownloadCsv: () => void
    note: string
    onNoteChange: (note: string) => void
}
export const PreviewStep: React.FC<PreviewStepProps>

// ApplyStep.tsx
export interface ApplyStepProps {
    isWriting: boolean
    progress: { done: number; total: number } | null
    writeResult: MembershipWriteResult | null
    mergedOutcomes: BatchOutcome[]
    applyError: string | null
    groups: { id: string; displayName: string }[]   // `allGroups`
}
export const ApplyStep: React.FC<ApplyStepProps>
```

The footer (`ModalActions` and its buttons), the step state, the freshness check, the write and retry handlers, the plan and sample queries and the CSV export stay in `BulkFixDialog.tsx`: they coordinate across steps, and moving them would be a redesign, not an extraction.

- [ ] **Step 1: Move the constants**

Create `constants.ts` with the declarations listed above, copied verbatim (including their doc comments) from `BulkFixDialog.tsx` lines ~55-135, and import them back into the dialog. Run `pnpm test -- src/components/BulkFixDialog && pnpm exec tsc --noEmit` → green. Commit: `git commit -am "Move the bulk fix dialog's constants into their own module"`.

- [ ] **Step 2: Write the failing hook test, then extract `useCatchAllCreation`**

`useCatchAllCreation.test.tsx`:

```tsx
import { act, renderHook } from '@testing-library/react'
import { useCatchAllCreation } from './useCatchAllCreation'
import { Fetcher } from '@/data/sources/DataSource'
import { GroupSetMeta } from '@/engine/types'

const mockCreateCatchAllGroup = jest.fn()
jest.mock('@/data/metadataWrites', () => ({
    ...jest.requireActual('@/data/metadataWrites'),
    createCatchAllGroup: (...args: unknown[]) => mockCreateCatchAllGroup(...args),
}))

const set: GroupSetMeta = {
    id: 'own',
    displayName: 'Ownership',
    objectType: 'organisationUnit',
    compulsory: true,
    dataDimension: true,
    canWrite: true,
    groups: [],
}
const fetcher = jest.fn() as unknown as Fetcher

const renderCreation = (onCreated = jest.fn(), reload = jest.fn(async () => undefined)) =>
    renderHook(() => useCatchAllCreation({ set, fetcher, reload, onCreated }))

beforeEach(() => {
    mockCreateCatchAllGroup.mockReset()
})

it('seeds both names from the generated catch-all names for the set', () => {
    const { result } = renderCreation()
    expect(result.current.names.displayName).toMatch(/Ownership/)
    expect(result.current.names.shortName.length).toBeGreaterThan(0)
    expect(result.current.namesValid).toBe(true)
})

it('flags a short name over 50 characters and refuses to create', async () => {
    const { result } = renderCreation()
    act(() => {
        result.current.setNames((n) => ({ ...n, shortName: 'x'.repeat(51) }))
    })
    expect(result.current.nameTooLong).toBe(true)
    expect(result.current.namesValid).toBe(false)
    await act(async () => {
        await result.current.create()
    })
    expect(mockCreateCatchAllGroup).not.toHaveBeenCalled()
})

it('creates with trimmed names, reports the group, reloads, and tells the caller', async () => {
    const created = { id: 'new1', displayName: 'Other' }
    mockCreateCatchAllGroup.mockResolvedValue(created)
    const onCreated = jest.fn()
    const reload = jest.fn(async () => undefined)
    const { result } = renderCreation(onCreated, reload)
    act(() => {
        result.current.setNames({ displayName: '  Other  ', shortName: ' Oth ' })
    })
    await act(async () => {
        await result.current.create()
    })
    expect(mockCreateCatchAllGroup).toHaveBeenCalledWith(fetcher, set, {
        displayName: 'Other',
        shortName: 'Oth',
    })
    expect(result.current.createdGroup).toEqual(created)
    expect(onCreated).toHaveBeenCalledWith(created)
    expect(reload).toHaveBeenCalledWith(false)
    expect(result.current.creating).toBe(false)
})

it('turns the cross-set name token into the translated sentence', async () => {
    const { NAME_OWNED_BY_ANOTHER_SET } = jest.requireActual('@/data/metadataWrites')
    mockCreateCatchAllGroup.mockRejectedValue(new Error(NAME_OWNED_BY_ANOTHER_SET))
    const { result } = renderCreation()
    await act(async () => {
        await result.current.create()
    })
    expect(result.current.error).toMatch(/already belongs to a different group set/)
})
```

(Check the real import path and names of `createCatchAllGroup`, `generateCatchAllNames` and `NAME_OWNED_BY_ANOTHER_SET` at `BulkFixDialog.tsx` lines 30-39 before writing the mock; the dialog imports them from `@/data/metadataWrites` today.)

Run → FAIL (module missing). Then create `useCatchAllCreation.ts` by moving, verbatim: the `catchAllNames` state and its reseeding effect, `creating`, `createError`, `createdGroup`, `trimmedNames`, `nameTooLong`, `namesValid`, and `handleCreateCatchAll` (renamed `create`; its `setTargetTouched(true)` / `setTargetGroupId(created.id)` lines become `onCreated(created)`). Keep every comment. In the dialog: `const catchAll = useCatchAllCreation({ set, fetcher, reload, onCreated: (g) => { setTargetTouched(true); setTargetGroupId(g.id) } })`, and replace each moved identifier with `catchAll.<field>` (`createdGroup` → `catchAll.createdGroup` in `allGroups`).

Run `pnpm test -- src/components/BulkFixDialog && pnpm exec tsc --noEmit && pnpm exec eslint src` → green. Commit: `git commit -am "Extract catch-all group creation from the bulk fix dialog"`.

- [ ] **Step 3: Extract `ApplyStep`** (smallest JSX branch first)

`ApplyStep.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import React from 'react'
import { ApplyStep } from './ApplyStep'

const base = {
    isWriting: false,
    progress: null,
    writeResult: null,
    mergedOutcomes: [],
    applyError: null,
    groups: [{ id: 'g1', displayName: 'Group one' }],
}

it('shows batch progress while writing', () => {
    render(<ApplyStep {...base} isWriting progress={{ done: 2, total: 5 }} />)
    expect(screen.getByText('Applied 2 of 5 batches')).toBeInTheDocument()
})

it('says so when there was nothing to apply', () => {
    render(
        <ApplyStep
            {...base}
            writeResult={{ outcomes: [], applied: [], unaccounted: [], changeSet: {} as never }}
        />
    )
    expect(screen.getByText('There was nothing to apply')).toBeInTheDocument()
})

it('names a group by display name in its outcome, not by id', () => {
    render(
        <ApplyStep
            {...base}
            writeResult={{ outcomes: [], applied: [], unaccounted: [], changeSet: {} as never }}
            mergedOutcomes={[{ groupId: 'g1', requested: 3, accepted: 3 }]}
        />
    )
    expect(screen.getByText(/Group one/)).toBeInTheDocument()
    expect(screen.queryByText(/g1/)).not.toBeInTheDocument()
})

it('reports an unconfirmed write as its own error', () => {
    render(<ApplyStep {...base} applyError="boom" />)
    expect(screen.getByText('The result could not be confirmed')).toBeInTheDocument()
})
```

Run → FAIL. Create `ApplyStep.tsx` by moving the `step === 'apply'` branch's inner `<div className={styles.applyStep}>` verbatim (imports: `i18n`, `CircularLoader`, `NoticeBox`, `styles`, `aggregateOutcomes`, `outcomeText`, `interpolate`, types). The dialog renders `{step === 'apply' && <ApplyStep isWriting={isWriting} progress={progress} writeResult={writeResult} mergedOutcomes={mergedOutcomes} applyError={applyError} groups={allGroups} />}`. Run the whole `BulkFixDialog` directory → green. Commit: `git commit -am "Extract the bulk fix dialog's apply step"`.

- [ ] **Step 4: Extract `PreviewStep`**

`PreviewStep.test.tsx` (three renders that pin the branches the dialog tests reach only through long flows):

```tsx
import { render, screen } from '@testing-library/react'
import React from 'react'
import { PreviewStep } from './PreviewStep'
import { CHECK_TIMEOUT } from './constants'

const plan = { changes: [], affected: 3, skippedCount: 0, skippedSample: [] }
const base = {
    action: 'moveToCatchAll' as const,
    filterText: undefined,
    plan,
    planLoading: false,
    planError: null,
    checkingFreshness: false,
    checkError: null,
    recheck: null,
    groups: [],
    previewObjects: { total: 3, sample: [], skippedCount: 0, skippedSample: [] },
    csvBusy: false,
    csvError: null,
    onDownloadCsv: jest.fn(),
    note: '',
    onNoteChange: jest.fn(),
}

it('headlines the affected count', () => {
    render(<PreviewStep {...base} />)
    expect(screen.getByText('3 objects')).toBeInTheDocument()
})

it('shows the checking indicator while the freshness check runs', () => {
    render(<PreviewStep {...base} checkingFreshness />)
    expect(screen.getByText('Checking the metadata is up to date…')).toBeInTheDocument()
})

it('distinguishes a timed-out check from any other check failure', () => {
    const { rerender } = render(<PreviewStep {...base} checkError={CHECK_TIMEOUT} />)
    expect(screen.getByText('Checking the metadata took too long')).toBeInTheDocument()
    rerender(<PreviewStep {...base} checkError="HTTP 502" />)
    expect(screen.getByText('The metadata could not be checked')).toBeInTheDocument()
})

it('shows the previewed and recalculated counts when the plan changed underneath', () => {
    render(
        <PreviewStep
            {...base}
            recheck={{ previewed: 5, recomputed: { ...plan, affected: 4 } }}
        />
    )
    expect(screen.getByText('The metadata changed while you were reviewing')).toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
    expect(screen.getByText(/4/)).toBeInTheDocument()
})
```

(Match `AssignmentPlan`'s real shape from `src/engine/store.ts` for the `plan` fixture; add any required field with an empty value.) Run → FAIL. Create `PreviewStep.tsx` by moving the `step === 'preview'` branch's inner `<div>` verbatim, plus `objectsCountLabel` (used only there). `filter.text` becomes the `filterText` prop; `set.groups` becomes `groups`; the note `InputField`'s `onChange` calls `onNoteChange(value ?? '')`. Run the directory → green. Commit: `git commit -am "Extract the bulk fix dialog's preview step"`.

- [ ] **Step 5: Extract `ActionStep`**

`ActionStep.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { ActionStep } from './ActionStep'

const catchAll = {
    names: { displayName: 'Other/unknown Ownership', shortName: 'Other Ownership' },
    setNames: jest.fn(),
    nameTooLong: false,
    namesValid: true,
    creating: false,
    error: null,
    createdGroup: null,
    create: jest.fn(),
}
const base = {
    action: 'moveToCatchAll' as const,
    onAction: jest.fn(),
    configLoaded: true,
    targetGroupId: '',
    onTargetChange: jest.fn(),
    targetGroups: [{ id: 'g1', displayName: 'Group one' }],
    showCreateOffer: false,
    catchAll,
}

it('labels the target as the catch-all group or the target group by action', () => {
    const { rerender } = render(<ActionStep {...base} />)
    expect(screen.getByText('Catch-all group')).toBeInTheDocument()
    rerender(<ActionStep {...base} action="assignAll" />)
    expect(screen.getByText('Target group')).toBeInTheDocument()
})

it('offers to create a group only when asked to', () => {
    const { rerender } = render(<ActionStep {...base} />)
    expect(screen.queryByRole('button', { name: 'Create group' })).not.toBeInTheDocument()
    rerender(<ActionStep {...base} showCreateOffer />)
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
    expect(catchAll.create).toHaveBeenCalledTimes(1)
})

it('shows the create error as its own notice', () => {
    render(<ActionStep {...base} showCreateOffer catchAll={{ ...catchAll, error: 'HTTP 409' }} />)
    expect(screen.getByText('Could not create the group')).toBeInTheDocument()
})
```

Run → FAIL. Create `ActionStep.tsx` by moving the `step === 'action'` branch verbatim; `targetOptions` moves with it (built from `targetGroups`); the select's `onChange` calls `onTargetChange(selected ?? '')` and the dialog's handler does `setTargetTouched(true); setTargetGroupId(id)`. Run the directory → green. Commit: `git commit -am "Extract the bulk fix dialog's action step"`.

- [ ] **Step 6: Final check**

Run: `pnpm test 2>&1 | tail -5 && pnpm exec tsc --noEmit && pnpm exec eslint src && wc -l src/components/BulkFixDialog/*.tsx`
Expected: all green; `BulkFixDialog.tsx` around 850 lines, the three steps 100-250 each. `pnpm exec d2-app-scripts i18n extract` must report **no new or removed strings** (every string moved, none reworded): `git diff --stat i18n/` empty.

---

### Task 11: Forget the groups filter term when the panel collapses

`GroupsPanel` keeps its filter term when collapsed, so re-expanding restores a term the user cannot see they had (plan5 §6).

**Files:**
- Modify: `src/components/GroupsPanel/GroupsPanel.tsx:42-43, 101-106`
- Modify: `src/components/GroupsPanel/GroupsPanel.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
it('forgets the filter term when collapsed, so re-expanding shows every group again', async () => {
    render(<GroupsPanel plan={plan} total={4500} />)
    await userEvent.click(screen.getByText('Show all 9 groups'))
    await userEvent.type(
        screen.getByPlaceholderText('Filter groups by name'),
        'Group 3'
    )
    expect(screen.queryByText('Group 8')).not.toBeInTheDocument()
    await userEvent.click(screen.getByText('Show fewer groups'))
    await userEvent.click(screen.getByText('Show all 9 groups'))
    expect(screen.getByPlaceholderText('Filter groups by name')).toHaveValue('')
    expect(screen.getByText('Group 8')).toBeInTheDocument()
})
```

Run: `pnpm test -- src/components/GroupsPanel` → FAIL (input still holds `Group 3`, Group 8 absent).

- [ ] **Step 2: Clear the term on collapse**

```tsx
    // Collapsing hides the filter input, so a term left in it would narrow
    // the next expansion invisibly. Clearing on the way out keeps "Show all"
    // meaning all.
    const toggleExpanded = () => {
        if (expanded) {
            setFilter('')
        }
        setExpanded(!expanded)
    }
```

and `onClick={toggleExpanded}` on the button.

Run → PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/GroupsPanel
git commit -m "Clear the groups filter when the panel collapses"
```

---

### Task 12: Remove what the usage feature computes and never consumes

`UsageViewCheck.readable` and `.type`, `InstallUsageResult.id` and `FavouriteTypeUsage.views12m` are asserted in tests and read by no production code; `usageApplies` is written as "not indicator" and would silently return true for a fifth object type; `.usage` in `GroupSetCard.module.css` duplicates `.meta`'s font size and colour (plan6 §4).

**Files:**
- Modify: `src/data/sources/usageAdmin.ts`, `src/data/sources/usageAdmin.test.ts`
- Modify: `src/data/sources/usageSqlView.ts`, `src/data/sources/usageSqlView.test.ts`
- Modify: `src/components/GroupSetCard/GroupSetCard.module.css:72-83`

- [ ] **Step 1: Write the failing `usageApplies` test**

In `usageSqlView.test.ts`:

```ts
describe('usageApplies', () => {
    it.each([
        ['organisationUnit', true],
        ['dataElement', true],
        ['categoryOption', true],
        ['indicator', false],
    ] as const)('%s -> %s', (objectType, expected) => {
        expect(usageApplies(objectType)).toBe(expected)
    })
})
```

This passes against the old code too; it exists so the allow-list rewrite is pinned by name. Then make the removals fail first: delete `views12m: 7` from the `byFavouriteType` expectation at `usageSqlView.test.ts:42` and change it to a `toEqual` on the whole entry (`{ favouriteType: '…', favourites: … }`) so an extra field fails; in `usageAdmin.test.ts`, remove `type:` and `readable:` from every `checkUsageView` expectation (lines 27-28, 91, 109-110, 141-142, 168, 185-186, 202-203) and make each a `toEqual` on `{ id, usable }`; remove `id:` from `installUsageView` result expectations where present.

Run: `pnpm test -- src/data/sources/usageSqlView.test.ts src/data/sources/usageAdmin.test.ts` → FAIL (extra fields present).

- [ ] **Step 2: Remove the fields**

`usageAdmin.ts`:

```ts
export interface UsageViewCheck {
    id: string | null
    /** exists, is a VIEW/QUERY, is readable, and a real read just succeeded */
    usable: boolean
}
```

`checkUsageView` returns `{ id: view?.id ?? null, usable: … }` (keep the local `readable`/`metadataUsable` computation). `InstallUsageResult` loses `id`; both `return` statements in `installUsageView` drop it. Check `Settings.tsx` compiles (it reads `usageCheck?.id` and `usageCheck?.usable` only).

`usageSqlView.ts`: `FavouriteTypeUsage` becomes `{ favouriteType: FavouriteType; favourites: number }`; `usageByGroupSet` pushes only those two fields. Rewrite `usageApplies`:

```ts
/**
 * The object types whose group sets can be analytics dimensions. Written
 * as an allow list, not "not indicator": `ObjectType` is a closed union
 * today, and a fifth member added later must fail here loudly rather than
 * silently count as having usage. Indicator group sets are excluded because
 * there is no `indicatorgroupsetdimension` table on any supported version
 * (measured on 2.43.1).
 */
const USAGE_OBJECT_TYPES: ReadonlyArray<ObjectType> = [
    'organisationUnit',
    'dataElement',
    'categoryOption',
]

export function usageApplies(objectType: ObjectType): boolean {
    return USAGE_OBJECT_TYPES.includes(objectType)
}
```

`GroupSetCard.module.css`:

```css
.meta,
.usage {
    font-size: var(--gsi-font-size-sm, 12px);
    color: var(--colors-grey600);
}
.usage {
    display: flex;
    align-items: center;
    gap: var(--spacers-dp8);
}
```

- [ ] **Step 3: Run**

Run: `pnpm test -- src/data/sources src/pages/Settings src/pages/GroupSetDetail src/components/GroupSetCard && pnpm exec tsc --noEmit && pnpm exec eslint src`
Expected: pass. `tsc` is what catches any consumer of a removed field.

- [ ] **Step 4: Commit**

```bash
git add src/data/sources/usageAdmin.ts src/data/sources/usageAdmin.test.ts src/data/sources/usageSqlView.ts src/data/sources/usageSqlView.test.ts src/components/GroupSetCard/GroupSetCard.module.css
git commit -m "Drop the usage fields nothing reads, and allow-list the types usage applies to"
```

---

### Task 12a: One state machine for both Settings admin sections

Maintainer decision: extract now. `Settings.tsx` runs the same four-state machine twice: a status check (`checking` / `checkError`), an action (`creating` or `usageBusy` / `createError` or `usageActionError`), and a re-check afterwards. The usage copy once lacked branches the SQL views copy had (plan6 §4), which is the failure mode a shared hook removes. Depends on Task 3 (Settings' usage refresh call has already moved to `useUsageRefresh`).

One deliberate behaviour change, called out so it is not mistaken for drift: the SQL views section re-checks status in the **`finally`** of its create action, as the usage section already does since Plan 6's fix, rather than only on success. A create that throws after creating one of three views then shows the real server state instead of the pre-create one.

**Files:**
- Create: `src/pages/Settings/useAdminSection.ts`, `src/pages/Settings/useAdminSection.test.tsx`
- Modify: `src/pages/Settings/Settings.tsx` (state and handlers, lines ~87-260; render conditions)
- Modify: `src/pages/Settings/Settings.test.tsx` only if a test asserts on the pre-create status surviving a failed create (check with the run in Step 4)

**Interfaces:**

```ts
export interface AdminSection<C> {
    /** the last successful check, null until the first one lands or after a failed one */
    check: C | null
    checking: boolean
    checkError: string | null
    busy: boolean
    actionError: string | null
    /** re-runs the check; safe to call any time */
    refresh: () => Promise<void>
    /** runs one action: busy while it runs, its failure on actionError, and a re-check in finally */
    run: (action: () => Promise<void>) => Promise<void>
}
export function useAdminSection<C>(load: () => Promise<C>): AdminSection<C>
```

- [ ] **Step 1: Write the failing hook tests**

```tsx
import { act, renderHook, waitFor } from '@testing-library/react'
import { useAdminSection } from './useAdminSection'

it('checks on mount and exposes the result', async () => {
    const load = jest.fn(async () => ({ ok: true }))
    const { result } = renderHook(() => useAdminSection(load))
    expect(result.current.checking).toBe(true)
    await waitFor(() => expect(result.current.checking).toBe(false))
    expect(result.current.check).toEqual({ ok: true })
    expect(result.current.checkError).toBeNull()
    expect(load).toHaveBeenCalledTimes(1)
})

it('reports a failed check as checkError with no result, and can retry', async () => {
    const load = jest
        .fn<Promise<{ ok: boolean }>, []>()
        .mockRejectedValueOnce(new Error('HTTP 500'))
        .mockResolvedValueOnce({ ok: true })
    const { result } = renderHook(() => useAdminSection(load))
    await waitFor(() => expect(result.current.checkError).toBe('HTTP 500'))
    expect(result.current.check).toBeNull()
    await act(async () => {
        await result.current.refresh()
    })
    expect(result.current.checkError).toBeNull()
    expect(result.current.check).toEqual({ ok: true })
})

it('is busy while an action runs, then re-checks, even when the action throws', async () => {
    const load = jest.fn(async () => ({ n: load.mock.calls.length }))
    const { result } = renderHook(() => useAdminSection(load))
    await waitFor(() => expect(result.current.checking).toBe(false))
    let release: () => void = () => undefined
    const action = jest.fn(
        () =>
            new Promise<void>((_, reject) => {
                release = () => reject(new Error('HTTP 403'))
            })
    )
    let running: Promise<void> | undefined
    act(() => {
        running = result.current.run(action)
    })
    expect(result.current.busy).toBe(true)
    await act(async () => {
        release()
        await running
    })
    expect(result.current.busy).toBe(false)
    expect(result.current.actionError).toBe('HTTP 403')
    expect(load).toHaveBeenCalledTimes(2)
})

it('clears a previous action error when the next action starts', async () => {
    const load = jest.fn(async () => ({}))
    const { result } = renderHook(() => useAdminSection(load))
    await waitFor(() => expect(result.current.checking).toBe(false))
    await act(async () => {
        await result.current.run(async () => {
            throw new Error('first')
        })
    })
    expect(result.current.actionError).toBe('first')
    await act(async () => {
        await result.current.run(async () => undefined)
    })
    expect(result.current.actionError).toBeNull()
})
```

Run: `pnpm test -- src/pages/Settings/useAdminSection.test.tsx` → FAIL (module missing).

- [ ] **Step 2: Implement the hook**

```ts
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The check / busy / error machine both admin sections of Settings run: a
 * status check on mount (and on demand), one action at a time with its
 * own failure slot, and a re-check once the action settles however it
 * settled. The two sections used to carry their own copies, and the copy
 * was once incomplete (Plan 6's final review found the usage section's
 * no-authority branches missing) -- one hook is how that stays fixed.
 *
 * `checkError` and `actionError` are separate on purpose: a failing status
 * check gates the whole section (there is nothing to show), while a failed
 * action must not -- a 403 on remove would otherwise wipe the tag and both
 * buttons with no way back but a page reload.
 *
 * `load` is captured in a ref so a caller can pass an inline closure
 * without re-triggering the mount check on every render.
 */
export function useAdminSection<C>(load: () => Promise<C>): AdminSection<C> {
    const loadRef = useRef(load)
    loadRef.current = load
    const [check, setCheck] = useState<C | null>(null)
    const [checking, setChecking] = useState(true)
    const [checkError, setCheckError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [actionError, setActionError] = useState<string | null>(null)

    const refresh = useCallback(async () => {
        setChecking(true)
        setCheckError(null)
        try {
            setCheck(await loadRef.current())
        } catch (e) {
            setCheck(null)
            setCheckError(e instanceof Error ? e.message : String(e))
        } finally {
            setChecking(false)
        }
    }, [])

    useEffect(() => {
        void refresh()
    }, [refresh])

    const run = useCallback(
        async (action: () => Promise<void>) => {
            setBusy(true)
            setActionError(null)
            try {
                await action()
            } catch (e) {
                setActionError(e instanceof Error ? e.message : String(e))
            } finally {
                // On both paths: an action that threw half way may still
                // have changed the server, and the tag must say what is
                // really there.
                await refresh()
                setBusy(false)
            }
        },
        [refresh]
    )

    return { check, checking, checkError, busy, actionError, refresh, run }
}
```

(with the `AdminSection` interface above it). Run → PASS.

- [ ] **Step 3: Rewire Settings**

SQL views section: `const sqlViews = useAdminSection(async () => { const [checks, canManage] = await Promise.all([checkSqlViews(fetcher), canCreateSqlViews(fetcher)]); return { checks, canManage } })`. Replace `checks`, `canManage`, `checking`, `checkError`, `creating`, `createError`, `refreshStatus` with `sqlViews.check?.checks ?? null`, `sqlViews.check?.canManage ?? null`, `sqlViews.checking`, `sqlViews.checkError`, `sqlViews.busy`, `sqlViews.actionError`, `sqlViews.refresh`. `handleCreate` becomes `sqlViews.run(async () => { const result = await createOrRepairSqlViews(fetcher, checks); …summary/failures state as today…; if (created or repaired) await reload(true) })` and loses its own `try/catch/finally` and `refreshStatus()` call. Keep `createSummary` and `createFailures` as local state: they are the action's report, not the machine.

Usage section: `const usage = useAdminSection(() => checkUsageView(fetcher))`; replace `usageCheck`, `usageChecking`, `usageCheckError`, `usageBusy`, `usageActionError`, `refreshUsage` with the hook's fields; `handleInstallUsage` and `handleRemoveUsage` become `usage.run(async () => { … })` bodies without their own `try/catch/finally`. `usageResult` stays local. Note that `canManage` for the usage buttons comes from `sqlViews.check?.canManage`, as today.

Both "Try again" buttons call the respective `refresh`. Delete the now-unused `useCallback`/`useEffect` imports if nothing else uses them.

- [ ] **Step 4: Run the Settings suite**

Run: `pnpm test -- src/pages/Settings && pnpm exec tsc --noEmit && pnpm exec eslint src`
Expected: PASS. If a test fails only because the SQL views section now re-checks after a failed create (the one intended change), update that test's expectation and say so in its comment. Any other failure is a regression in the rewiring.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Settings
git commit -m "Run both Settings admin sections on one check-and-act state machine"
```

---

### Task 13: Two overpromising test names and a level gap the fixtures cannot see

`rules.test.ts:58` is named for level invariance it cannot show and duplicates the test above it; `GroupSetDetail.test.tsx:649`'s comment claims the scope and row level move together while the scope is a static mock; every level fixture is contiguous, so `levels.find((l) => l.level > current)` is never distinguished from `+ 1` (plan5 §6).

**Files:**
- Modify: `src/engine/rules.test.ts:39-70`
- Modify: `src/pages/GroupSetDetail/GroupSetDetail.test.tsx:155-171, 644-700`

- [ ] **Step 1: Fold the duplicate rules test into the one above it**

Delete the test at lines 53-70 (`a missing object in a data dimension set is a warning wherever it sits`). Move its comment ("Spec 2026-09-15 §2.1: the rule no longer varies by organisation unit level…") above the test at line 39 (`missing is a warning when the set is a dimension but not compulsory`), and extend that test to evaluate two objects rather than one so the record it now carries is at least exercised:

```ts
    // Spec 2026-09-15 §2.1: the rule takes no level. `evaluateSet` has no
    // level argument at all, so two objects with the same membership get
    // the same status wherever they sit in the hierarchy -- that is a
    // property of the signature, not something a test can vary. This test
    // evaluates two objects so the duplicated-status shape is at least
    // exercised; a test once named "wherever it sits" claimed more than it
    // could show and was folded in here.
    it('missing is a warning when the set is a dimension but not compulsory', () => {
        const s = evaluateSet(
            set({ dataDimension: true }),
            buildSetMembership(2, [Int32Array.from([])]),
            Uint8Array.from([1, 1])
        )
        expect(s[0]).toBe(Status.MissingWarning)
        expect(s[1]).toBe(Status.MissingWarning)
    })
```

(Read the existing test at line 39 first and keep its exact `set(...)`/membership helpers; only the shape of the assertion changes.)

- [ ] **Step 2: Make the level fixture mutable and add the gap test**

In `GroupSetDetail.test.tsx`, replace the inline `organisationUnitLevels` array in the `useApiDataQuery` mock with a module-level `let mockLevels = DEFAULT_LEVELS` where

```ts
const DEFAULT_LEVELS = [
    { level: 1, displayName: 'National' },
    { level: 2, displayName: 'District' },
    { level: 3, displayName: 'Chiefdom' },
    { level: 4, displayName: 'Facility' },
]
let mockLevels = DEFAULT_LEVELS
```

and the mock returns `{ organisationUnitLevels: mockLevels }`. Add `mockLevels = DEFAULT_LEVELS` to the file's existing `beforeEach`/`afterEach` reset (find it with `grep -n "beforeEach\|afterEach" src/pages/GroupSetDetail/GroupSetDetail.test.tsx`; if none resets mocks, add an `afterEach(() => { mockLevels = DEFAULT_LEVELS })`).

Inside `describe('drilling into a matrix row (Task 6)')`, add:

```ts
    it('drills to the next level that exists, not to the current level plus one', async () => {
        // A hierarchy with no level 3 at all. DHIS2 levels are contiguous in
        // practice, so every other fixture here is blind to the difference
        // between `levels.find((l) => l.level > current)` and `current + 1`.
        mockLevels = [
            { level: 1, displayName: 'National' },
            { level: 2, displayName: 'District' },
            { level: 4, displayName: 'Facility' },
        ]
        mockScope.rootLevel = 1
        mockEngine.client = {
            call: async (method: string) => {
                if (method === 'matrixFor') {
                    return {
                        groups: [{ id: 'g1', displayName: 'G1', canWrite: true }],
                        rows: [
                            {
                                object: 1,
                                row: {
                                    index: 1,
                                    id: 'ou-badjia',
                                    displayName: 'Badjia',
                                    level: 2,
                                    parentId: 'root1',
                                },
                                perGroup: [5],
                                missing: 0,
                                unassigned: 0,
                                conflict: 0,
                                total: 5,
                            },
                        ],
                    }
                }
                return null
            },
        }
        renderDetail({ objectType: 'organisationUnit' })
        expect(await screen.findByText('District (level 2)')).toBeInTheDocument()
        fireEvent.click(await screen.findByRole('button', { name: 'Badjia' }))
        expect(await screen.findByText('Facility (level 4)')).toBeInTheDocument()
        expect(screen.queryByText(/level 3/)).not.toBeInTheDocument()
    })
```

Then fix the test at line 649: rename it to `'drills into a row: asks the scope to move to it and moves the row level down'` and replace its comment with:

```ts
    // What this exercises: `setRoot` is asked to move the scope to the row
    // (pinned by the spy), and the Rows field moves one level deeper. The
    // scope itself is a static mock here, so its own move is not observed
    // -- that belongs to useScope's tests.
```

- [ ] **Step 3: Run**

Run: `pnpm test -- src/engine/rules.test.ts src/pages/GroupSetDetail/GroupSetDetail.test.tsx`
Expected: PASS. The gap test must pass against current code (it uses `find`); if it fails, that is a real defect to fix in `GroupSetDetail.tsx:229`.

- [ ] **Step 4: Commit**

```bash
git add src/engine/rules.test.ts src/pages/GroupSetDetail/GroupSetDetail.test.tsx
git commit -m "Name two tests for what they show, and cover a hierarchy with a missing level"
```

---

### Task 14: Measure the bridge-row claim on every supported version

`usageSqlView.ts:14-17` states that `eventchart`/`eventreport` bridge rows add up to `eventvisualization`'s; this was compared only on 2.43.1 and never written down (plan6 §2). One query per version closes it.

**Files:**
- Create: `scripts/probe/bridge-rows.js`
- Modify: `docs/superpowers/notes/2026-09-plan6-usage-tables.md` (new §2b)
- Modify: `src/data/sources/usageSqlView.ts:13-17` (comment)

- [ ] **Step 1: Write the probe**

Model on `scripts/probe/json-patch-rejection.js` (same `api()` helper and env-overridable credentials). For each table below it creates a `QUERY`-type SQL view, reads it, deletes it, and prints a table. `QUERY` views need no execute step and leave no database object behind.

```js
// Do the legacy eventchart/eventreport bridge rows add up to
// eventvisualization's, on this version? usageSqlView.ts reads only the
// eventvisualization bridges on the strength of that claim, which had been
// measured on 2.43.1 alone. A missing table is reported as "absent", not as
// zero.
//
//   node scripts/probe/bridge-rows.js <baseUrl>

const [, , baseUrl] = process.argv
if (!baseUrl) {
    console.error('usage: node scripts/probe/bridge-rows.js <baseUrl>')
    process.exit(1)
}
const USER = process.env.GSI_PROBE_USERNAME || 'local_admin'
const PASS = process.env.GSI_PROBE_PASSWORD || 'district'
const auth = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`
const api = (path, init = {}) =>
    fetch(`${baseUrl}/api/${path}`, {
        ...init,
        headers: { Authorization: auth, ...(init.headers || {}) },
    })

const TABLES = [
    'eventchart_orgunitgroupsetdimensions',
    'eventreport_orgunitgroupsetdimensions',
    'eventvisualization_orgunitgroupsetdimensions',
    'eventchart_categoryoptiongroupsetdimensions',
    'eventreport_categoryoptiongroupsetdimensions',
    'eventvisualization_categoryoptiongroupsetdimensions',
]

async function countRows(table) {
    const create = await api('sqlViews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: `GSI probe ${table}`,
            code: `GSI_PROBE_${table.toUpperCase().slice(0, 40)}`,
            type: 'QUERY',
            cacheStrategy: 'NO_CACHE',
            sqlQuery: `select count(*) as n from ${table}`,
        }),
    })
    if (!create.ok) {
        return `create failed: HTTP ${create.status}`
    }
    const { response } = await create.json()
    const id = response.uid
    try {
        const read = await api(`sqlViews/${id}/data.json`)
        if (!read.ok) {
            return `absent (HTTP ${read.status})`
        }
        const body = await read.json()
        return Number(body.listGrid.rows[0][0])
    } finally {
        await api(`sqlViews/${id}`, { method: 'DELETE' })
    }
}

async function main() {
    const info = await (await api('system/info')).json()
    console.log(`DHIS2 ${info.version} at ${baseUrl}`)
    const counts = {}
    for (const table of TABLES) {
        counts[table] = await countRows(table)
        console.log(`${table.padEnd(55)} ${counts[table]}`)
    }
    for (const kind of ['orgunitgroupset', 'categoryoptiongroupset']) {
        const ec = counts[`eventchart_${kind}dimensions`]
        const er = counts[`eventreport_${kind}dimensions`]
        const ev = counts[`eventvisualization_${kind}dimensions`]
        const sum = typeof ec === 'number' && typeof er === 'number' ? ec + er : 'n/a'
        console.log(`${kind}: eventchart + eventreport = ${sum}, eventvisualization = ${ev}, ${sum === ev ? 'ADD UP' : 'DIFFER'}`)
    }
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
```

- [ ] **Step 2: Run it on each version, one instance at a time**

Use the broker (`dhis2-instances` skill) for each step and poll each job to completion:

1. Start `agent-gsi-p2-40` → `node scripts/probe/bridge-rows.js http://dhis2-agent-gsi-p2-40:8080` → stop it.
2. Create `agent-gsi-p10-41` from seed `dhis2-db-sierra-leone_v41.sql.gz` → run → **keep it running for Task 16** (or delete now and recreate; the seed takes minutes either way).
3. Stop it. Create `agent-gsi-p10-42` from `dhis2-db-sierra-leone_v42.sql.gz` → run → stop.
4. Start `agent-gsi-p2` (2.43.1) → run → stop.

If a create is refused by the instance cap, delete `agent-gsi-p10-*` instances only.

- [ ] **Step 3: Record**

Append to `docs/superpowers/notes/2026-09-plan6-usage-tables.md` after §2:

```markdown
## 2b. Do the legacy bridge rows add up to eventvisualization's? (Plan 10)

§2 proved every `eventchart`/`eventreport` **uid** is present in
`eventvisualization`. It did not compare the **bridge rows** -- the
dimension links themselves -- which is the claim `usageSqlView.ts` actually
rests on: a legacy chart whose group set link lived only in
`eventchart_orgunitgroupsetdimensions` would be silently missed. Measured
with `scripts/probe/bridge-rows.js` (throwaway QUERY views, deleted after):

| Version | ec ou | er ou | ev ou | ec+er = ev | ec co | er co | ev co | ec+er = ev |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2.40.12 | | | | | | | | |
| 2.41.10 | | | | | | | | |
| 2.42.6 | | | | | | | | |
| 2.43.1 | 4 | 1 | 5 | yes | | | | |
```

Fill every cell from the runs. If any row says DIFFER, stop and record it as a finding: the shipped query is then under-counting on that version, which is a defect for OPEN-ITEMS, not a footnote.

Update the comment at `usageSqlView.ts:14-17` to read "measured on 2.40.12, 2.41.10, 2.42.6 and 2.43.1 -- every one of their uids is present in `eventvisualization`, and their bridge rows add up to its own; `2026-09-plan6-usage-tables.md` §2 and §2b".

- [ ] **Step 4: Commit**

```bash
git add scripts/probe/bridge-rows.js docs/superpowers/notes/2026-09-plan6-usage-tables.md src/data/sources/usageSqlView.ts
git commit -m "Measure the legacy bridge-row claim on every supported version"
```

---

### Task 15: Write up the `@dhis2/ui` `align` defect for an upstream report

`DataTableColumnHeader` in `@dhis2/ui` 10.17.0 ignores its own `align` prop (plan5 §4). The app works around it; the report was never filed. The sandbox cannot create issues (read-only token), so the deliverable is a ready-to-paste issue in a note, and the closing condition is the issue URL recorded in Task 19.

**Files:**
- Create: `docs/superpowers/notes/2026-09-dhis2-ui-align-issue.md`

- [ ] **Step 1: Check whether it is already fixed or reported**

```bash
pnpm view @dhis2/ui version
gh issue list -R dhis2/ui --state all --search "DataTableColumnHeader align" --limit 20
gh api repos/dhis2/ui/git/trees/master?recursive=1 --jq '.tree[].path' | grep -i "data-table-column-header"
```

Fetch the current source of the file the last command names (raw.githubusercontent.com is reachable) and check whether its `align` rule still targets `.label` while rendering `span.container > span.top > span.content`. Also read the installed copy: `node_modules/.pnpm/@dhis2+ui-table*/node_modules/@dhis2-ui/table/build/es/data-table/data-table-column-header/data-table-column-header.js` (locate with `find node_modules/.pnpm -path "*data-table-column-header.js" | head`).

- [ ] **Step 2: Write the note**

```markdown
# Upstream report: `DataTableColumnHeader` ignores `align` (@dhis2/ui)

Status: drafted 2026-09-XX; to be filed by the maintainer from the host
(the sandbox token cannot create issues). Once filed, put the URL here and
close the item in OPEN-ITEMS.md.

Checked before drafting: latest published @dhis2/ui is <version>; the
component's master source at <commit> still <does / does not> emit the
`.label` rule against a tree of `span.container > span.top > span.content`.
Existing issues searched: <none found / #NNN>.

## Title

DataTableColumnHeader: the `align` prop has no effect

## Body

**Version:** @dhis2/ui 10.17.0 (also checked master at <commit>).

**What happens:** `<DataTableColumnHeader align="right">` renders exactly
like `align="left"`. The component turns `align` into a styled-jsx rule for
a `.label` class, but the element it renders is
`span.container > span.top > span.content`, and `.label` appears nowhere in
the rendered tree. `.label` occurs exactly once in the whole package -- in
the rule the component generates.

**Effect:** every numeric column in a `DataTable` has a left-aligned header
over right-aligned cells. On a wide table the header sits nowhere near its
own numbers once any header text is long.

**Reproduction:**

```jsx
<DataTable>
  <DataTableHead>
    <DataTableRow>
      <DataTableColumnHeader align="right">Total</DataTableColumnHeader>
    </DataTableRow>
  </DataTableHead>
  <DataTableBody>
    <DataTableRow>
      <DataTableCell align="right">1,234</DataTableCell>
    </DataTableRow>
  </DataTableBody>
</DataTable>
```

Inspect the header: `span.top` has `justify-content: flex-start` (or no
justification), and no element carries the `.label` class the generated
`<style>` targets.

**Workaround used:** a consumer-side rule on the real flex container,
`.numericHeader :global(span.top) { justify-content: flex-end }`, with the
`align="right"` props left in place so the library's fix takes over when it
lands.

**Suggested fix:** target the rule at `.top` (the actual flex container) or
render the `.label` element the rule expects.
```

Fill the angle-bracketed values from Step 1. If Step 1 finds the defect already fixed in a published version, the note says so, names the version, and Task 19 closes the item as "fixed upstream in X; upgrade when convenient" instead.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/notes/2026-09-dhis2-ui-align-issue.md
git commit -m "Draft the upstream report for the @dhis2/ui column header align defect"
```

Hand-off line for the user: "Please file `docs/superpowers/notes/2026-09-dhis2-ui-align-issue.md` against github.com/dhis2/ui and paste the URL back; Task 19 records it."

---

### Task 16: Close the translated-names item as accepted

Maintainer decision (interview, 2026-09-17): "Ignore translation of metadata from SQL views; this is an admin tool so it is not critical." The only specified-but-unbuilt item therefore closes without a spike or a feature. What closes it honestly is writing the decision where the next reader will look: the spec that still calls it open, and the index.

The reasoning to record, so it is not re-litigated: the SQL view path reads the raw `name` column; the metadata API path resolves `displayName` against the user's database locale. Counts, statuses and every fix key on ids and are unaffected. The app states which source it used, so untranslated names are explicable. An instance that needs translated names removes the `GSI_ORGUNIT_NAMES` view, which drops only names back to the metadata API and keeps the hierarchy and membership views on the fast path. DHIS2's `QUERY`-type SQL views do support `${variable}` substitution on all four versions, so the feature is buildable if the decision is ever reversed; that fact is recorded so nobody has to rediscover it.

**Files:**
- Modify: `docs/superpowers/specs/2026-09-10-group-set-integrity-tool-design.md` (§8a last paragraph, §9 last bullet)
- Modify: `docs/superpowers/notes/OPEN-ITEMS.md` (done in Task 19; this task changes the spec only)

- [ ] **Step 1: Amend §8a**

Replace the sentence "This is accepted for now rather than fixed: making the view translation aware would mean resolving the caller's locale inside SQL, and org unit name translations are rare in practice." with:

```markdown
This is accepted permanently (maintainer decision, Plan 10, 2026-09-17): this
is an administrative tool, and untranslated names on the fast path are not
worth the cost of a locale-aware view. Should that change, DHIS2's
`QUERY`-type SQL views take `${variable}` substitution on 2.40 through 2.43
(`/api/sqlViews/<id>/data?var=locale:fr`), so a names view could `coalesce`
the matching entry of the `translations` JSONB column over `name`, with the
app passing the user's `keyDbLocale`; that would also require the status
probe and the create/repair path to handle a view that cannot be read
without its variable, and a per-locale cache key.
```

- [ ] **Step 2: Amend §9**

Replace the last bullet's "**Still open** — out of scope for Plans 1-3; a future plan should investigate whether locale-aware resolution is possible inside the view." with "**Closed, accepted** (Plan 10, 2026-09-17): not worth building for an administrative tool; see §8a for the remedy and for how it could be built if the decision is reversed."

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-10-group-set-integrity-tool-design.md
git commit -m "Accept untranslated names on the SQL view path as permanent"
```

---


### Task 17: A seed-agnostic e2e smoke suite

`flows.spec.ts` is pinned to Sierra Leone names throughout, so the only genuinely different database (EMIS) has never run any automated flow (manual-review spec §10). A read-only suite that takes its names from the page can run against any instance, and is what Task 18 runs on each leg.

**Files:**
- Create: `e2e/smoke.spec.ts`
- Modify: `e2e/playwright.config.ts` (a `smoke` project; `testMatch` on the existing four)
- Modify: `src/components/GroupSetCard/GroupSetCard.tsx:111` (add `data-test="group-set-card-name"`)

- [ ] **Step 1: Add the hook the suite needs**

`GroupSetCard.tsx`: `<div className={styles.name} data-test="group-set-card-name">{set.displayName}</div>`. No test changes; `GroupSetCard.test.tsx` selects by text.

- [ ] **Step 2: Write the suite**

```ts
import { expect, test } from './fixtures/session'
import type { AppRoot } from './fixtures/session'

/**
 * Read-only flows that take every name they need from the page, so they
 * run against any database -- the EMIS instance (266k organisation units)
 * included, which `flows.spec.ts` cannot reach because it is pinned to the
 * Sierra Leone seed. Nothing here writes, so there is nothing to revert.
 *
 * Run with GSI_E2E_BASE_URL=http://dhis2-<name>:8080 pnpm test:e2e --project smoke
 */
test.skip(
    () => !process.env.GSI_E2E_BASE_URL,
    'GSI_E2E_BASE_URL is not set'
)

const COUNT = /^[\d,]+ objects?$/

async function firstOrgUnitCard(root: AppRoot) {
    const card = root.locator('[role="button"]').first()
    await expect(card).toBeVisible({ timeout: 60_000 })
    const name = await card.locator('[data-test="group-set-card-name"]').textContent()
    if (!name) {
        throw new Error('the first card has no name')
    }
    return { card, name }
}

test.describe('smoke', () => {
    test('dashboard renders the filter bar and at least one card', async ({ authedApp }) => {
        const root = await authedApp.root()
        await expect(
            root.locator('[data-test="filter-bar"]').getByText('Organisation unit', { exact: true })
        ).toBeVisible({ timeout: 60_000 })
        await firstOrgUnitCard(root)
    })

    test('the freshness indicator shows an age and Refresh reloads', async ({ authedApp }) => {
        const root = await authedApp.root()
        const bar = root.locator('[data-test="filter-bar"]')
        await expect(bar.getByText(/^Metadata from /)).toBeVisible({ timeout: 60_000 })
        const refresh = bar.getByRole('button', { name: 'Refresh' })
        await refresh.click()
        await expect(refresh).toBeDisabled({ timeout: 5_000 })
        await expect(refresh).toBeEnabled({ timeout: 120_000 })
        await expect(bar.getByText(/^Metadata from /)).toBeVisible()
    })

    test('a card opens to a matrix, and the objects tab counts and searches its own rows', async ({ authedApp }) => {
        const root = await authedApp.root()
        const { card, name } = await firstOrgUnitCard(root)
        await card.click()
        await expect(root.getByRole('heading', { name, exact: true })).toBeVisible()
        await expect(root.getByRole('columnheader', { name: 'Total' })).toBeVisible({ timeout: 60_000 })

        await root.getByText('Objects', { exact: true }).click()
        const count = root.locator('[data-test="objects-count"]')
        await expect(count).toHaveText(COUNT, { timeout: 60_000 })
        const before = await count.textContent()

        // Search for the first row's own name: seed-agnostic, and the
        // result must contain that row.
        const firstRowName = await root
            .locator('[data-test="objects-table-row"] span[title]')
            .first()
            .textContent()
        if (!firstRowName) {
            throw new Error('no rows rendered')
        }
        await root
            .locator('[data-test="dhis2-uiwidgets-inputfield"]')
            .filter({ hasText: 'Search' })
            .locator('input')
            .fill(firstRowName)
        await expect(count).not.toHaveText(before ?? '', { timeout: 10_000 })
        await expect(root.getByText(firstRowName, { exact: true }).first()).toBeVisible()
    })

    test('settings reports the status of every GSI SQL view', async ({ authedApp }) => {
        await authedApp.page.goto(`${process.env.GSI_E2E_BASE_URL}/api/apps/group-set-integrity-tool/index.html#/settings`)
        const root = await authedApp.root()
        await expect(root.getByRole('heading', { name: 'SQL views' })).toBeVisible({ timeout: 30_000 })
        for (const viewName of ['GSI org unit hierarchy', 'GSI org unit names', 'GSI org unit group memberships']) {
            await expect(root.getByText(viewName, { exact: true })).toBeVisible()
        }
    })
})
```

Check the `Search` field label and the `Objects` tab text against `ObjectsTab.tsx`/`GroupSetDetail.tsx` before relying on them (they are what `flows.spec.ts` uses today via `inputField(root, 'Search')` and `openObjectsTab`). If the instance has no SQL views installed, the settings test still passes: the three rows render with a "Missing" tag.

- [ ] **Step 3: Configure the project**

In `playwright.config.ts`, add `testMatch: 'flows.spec.ts'` to each of the four existing projects and append:

```ts
        // Read-only, seed-agnostic flows for any instance -- the EMIS leg of
        // the multi-version review, which flows.spec.ts cannot run against.
        {
            name: 'smoke',
            testMatch: 'smoke.spec.ts',
            use: {
                ...devices['Desktop Chrome'],
                baseURL: process.env.GSI_E2E_BASE_URL,
            },
        },
```

Run: `pnpm exec tsc -p e2e --noEmit` → clean.

- [ ] **Step 4: Verify on EMIS**

Start `agent-gsi-emis` via the broker. `pnpm build`, install the zip (see Global Constraints), then:

```bash
GSI_E2E_BASE_URL=http://dhis2-agent-gsi-emis:8080 pnpm test:e2e --project smoke
```

Expected: 4 passed. Record the wall-clock per test in Task 18's note (this is the EMIS leg's automated half). Stop `agent-gsi-emis`.

- [ ] **Step 5: Verify on the Sierra Leone seed too, and run Task 8's fix live**

Start `agent-gsi-p2`. Install the same build. Then:

```bash
GSI_E2E_BASE_URL=http://dhis2-agent-gsi-p2:8080 pnpm test:e2e --project smoke
pnpm test:e2e --project 2.43.1
```

Expected: smoke 4 passed; the full `2.43.1` project 9 passed, including `search` (Task 8's locator). Read the cleanup net's `beforeAll` output for any repair it reports. Stop `agent-gsi-p2`.

- [ ] **Step 6: Commit**

```bash
git add e2e/smoke.spec.ts e2e/playwright.config.ts src/components/GroupSetCard/GroupSetCard.tsx
git commit -m "Add a read-only e2e smoke suite that runs against any database"
```

---

### Task 18: The §10 multi-version review, against different databases

The manual-review spec scoped one structured review across 2.40 to 2.43 on different databases, after Plans 4 to 7. The e2e half ran (all on the Sierra Leone seed except a manual EMIS pass of one feature); the structured, screen-by-screen half never did. Plan 8 added the freshness feature on top. This task does it once, records it the way `docs/review-2026-09-12/UI-TEST-RESULTS.md` recorded the first review, and turns any finding into either a fix commit (if under an hour and covered by a test) or an OPEN-ITEMS entry with evidence.

**Files:**
- Create: `docs/superpowers/notes/2026-09-plan10-multiversion-review.md`
- Possibly modify: source files for small defects found (each its own commit with a test)

**Legs, one instance at a time.** The broker's seed list (`GET $DHIS2_BROKER_URL/seeds`) has different databases per version; use them so "different databases" is real:

| Leg | Version | Instance | Database |
| --- | --- | --- | --- |
| A | 2.40 | create `agent-gsi-p10-40h` from `hmis_raw_v40.sql.gz` | a real HMIS, not the demo. If it has no organisation unit group sets (check `GET /api/organisationUnitGroupSets?fields=id&pageSize=1`), fall back to `agent-gsi-p2-40` and say so. |
| B | 2.41 | start `agent-gsi-emis` | EMIS, 266,396 units |
| C | 2.42 | create `agent-gsi-p10-42d` from `dhis2-dqdev_2026-08-17_v42.pgc` (1.3 GB; allow time) | the DQ test bed |
| D | 2.43 | start `agent-gsi-p2` | Sierra Leone demo |

Per leg: install the current build; restart once if legacy list endpoints come back empty; run `--project smoke`; work through the checklist below in a browser driven by Playwright (the `playwright-cli` skill, or a throwaway script under the scratchpad, never committed); screenshot only failures into the scratchpad and describe them in the note; delete instances this task created; stop the rest.

- [ ] **Step 1: Create the note with the checklist, before any leg runs**

```markdown
# Multi-version review (manual-review spec §10), Plan 10

Tested: 2026-09-XX · App: built zip from commit <sha>, installed with
`POST /api/apps` · Four databases, one per version (below).

## Instances

| Leg | URL | DHIS2 | Database | Org units | OU group sets |
| --- | --- | --- | --- | --- | --- |

## Automated half

| Leg | `smoke` project | `flows.spec.ts` project (SL only) |

## Checklist

PASS / FAIL / N/A per leg, with a note column. N/A needs a reason (no
translated names on this database; no admin authority; and so on).

| # | Screen | Check | Source | A 2.40 | B 2.41 | C 2.42 | D 2.43 | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Dashboard | Filter bar fields in order: Organisation unit · Object type · Show · Sort by · Reload data, with the freshness status right-aligned | MR §4.1, FR §4.1 | | | | | |
| 2 | Dashboard | Cards grouped by object type, sorted by issues; badges Compulsory / Data dimension / N groups | spec §5.1 | | | | | |
| 3 | Dashboard | One card's conflict + missing + no-group + OK equals the Objects tab's total for that set | CLAUDE.md buckets | | | | | |
| 4 | Dashboard | Organisation unit field opens the tree; choosing a unit re-scopes every card | MR §4.1 | | | | | |
| 5 | Dashboard | "Sort by usage" offered only when the usage view is installed; "Appears unused" tag opens the Usage tab, not Overview | MR §3.5 | | | | | |
| 6 | Dashboard | Load progress per type; a type that fails is reported and the rest load | spec §6.4 | | | | | |
| 7 | Freshness | Fresh → green "Metadata from …"; Refresh → grey "Reloading metadata…" with the button disabled and **still on screen**; back to green | FR §4.2 | | | | | |
| 8 | Freshness | Past the 10-minute TTL the label turns amber and says "may be out of date" (wait it out once, on the smallest database) | FR §3.3 | | | | | |
| 9 | Detail header | Name, badges, N groups chip, Set properties, Run DHIS2 integrity checks | MR §4.4, §4.5 | | | | | |
| 10 | Overview | ≤ 8 group columns + Other groups + Missing, Conflict, Total; numeric headers right-aligned over numbers | MR §4.2 | | | | | |
| 11 | Overview | Rows field offers only levels below the scope; row-label click drills scope and level down; breadcrumb returns | MR §4.3 | | | | | |
| 12 | Overview | Numeric cell click opens Objects filtered to that row and column; Other groups opens the picker | MR §4.2 | | | | | |
| 13 | Overview | Groups in this set panel: eight biggest, Show all, filter, counts match the matrix | MR §4.4 | | | | | |
| 14 | Objects | Virtualised list scrolls past page 200 without duplicates; Parent and Level columns for org units; none for flat types | spec §5.2 | | | | | |
| 15 | Objects | Filters: status, level, group, text search (a name beyond the first page) all narrow the count | spec §5.2 | | | | | |
| 16 | Objects | Membership control: segmented ≤ 5 groups, select above; read-only group disables with the group named | spec §5.2, §5.6 | | | | | |
| 17 | Objects | Single assign: confirm, row updates, success alert, History row (SL legs only; revert afterwards) | spec §5.2 | | | | | |
| 18 | Objects | Fix issues button acts on the current filter and shows the affected count first | MR §5.1 | | | | | |
| 19 | Bulk fix | Action step: catch-all preselected from config or name match; create offered with editable name and short name; a name used by another set's group is refused | MR §5.2 | | | | | |
| 20 | Bulk fix | Preview: per-group +N/−M, Now/After sample, CSV download, read-only skipped callout, note field | spec §5.3 | | | | | |
| 21 | Bulk fix | Apply (SL legs, small population, revert after): progress, result panel, History row | spec §5.3 | | | | | |
| 22 | Bulk fix | Pre-write check (EMIS only, preview a fix whose group delta exceeds 5000 and **Cancel before Apply** unless a revert is planned): "Checking the metadata…" appears; Cancel disabled during, enabled after | FR §5 | | | | | |
| 23 | Usage tab | Absent → prompt with Settings link; installed → counts, per-type breakdown, caveat; indicator set → "not analytics dimensions" | MR §3.5 | | | | | |
| 24 | Integrity tab | Admin sees the relevant checks by name; Run now completes; results render | spec §4.5 | | | | | |
| 25 | History | Rows list when/who/set/action/count/note; Revert previews and skips moved objects; revert is itself recorded | spec §5.4 | | | | | |
| 26 | Settings | SQL view status per view; Create/Repair; usage view install and remove; catch-all mapping saves; tracker toggle saves; Clear cache reloads | spec §5.5 | | | | | |
| 27 | Source label | Remove `GSI_ORGUNIT_NAMES` via Settings or API: app falls back to metadata names, says which source it used, and hierarchy/memberships still come from views | spec §8a | | | | | |
| 28 | Timings (B only) | Cold dashboard, detail page, Refresh, Objects tab first page, one bulk preview | FR §5.4 | | | | | |

## Findings

One subsection per finding: what, where, which legs, evidence, and
whether it was fixed in this branch (commit) or added to OPEN-ITEMS.md.

## Console and network hygiene

Note any uncaught error or 4xx/5xx the browser console shows per leg.
```

MR = manual-review spec, FR = freshness spec.

- [ ] **Step 2: Run leg D first (2.43, Sierra Leone)**

It is the known-good baseline and the cheapest place to shake out the review procedure. Fill its column. Revert every write through History as the flows do; run the cleanup net (`pnpm test:e2e --project 2.43.1 -g dashboard`) once at the end to confirm `Area` is clean.

- [ ] **Step 3: Run legs A, B, C**

In that order (A and C need seeding; B is the slow database, best done with the procedure already rehearsed). On B do not apply any bulk fix; preview only (check 22) and cancel. Every N/A cell gets its reason.

- [ ] **Step 4: Triage findings**

For each FAIL: reproduce once more; if it is a defect in this app and small, fix it on this branch with a unit or e2e test in its own commit ("Fix …"), then re-check that cell on the leg that showed it. Otherwise write it up in the note's Findings section and add it to OPEN-ITEMS in Task 19 with a pointer to the note.

- [ ] **Step 5: Clean up instances**

Delete `agent-gsi-p10-*`. Stop everything else. `GET $DHIS2_BROKER_URL/instances` should show the original four, all stopped.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/notes/2026-09-plan10-multiversion-review.md
git commit -m "Record the multi-version review against four different databases"
```

---

### Task 19: Reconcile the index and the notes

The final commit: every item this plan closed is struck in `OPEN-ITEMS.md` and in its own carry-forward note, the accepted items move to an "Accepted" section with the reasons from this plan, records move to "Records", and the review's findings become the new open list.

**Files:**
- Modify: `docs/superpowers/notes/OPEN-ITEMS.md`
- Modify: `docs/superpowers/notes/2026-09-plan1-carry-forward.md`, `2026-09-plan5-carry-forward.md`, `2026-09-plan6-carry-forward.md`, `2026-09-plan7-carry-forward.md`, `2026-09-plan8-carry-forward.md` (their "Status after the Plan 9 cleanup pass" blocks gain a "Status after Plan 10" block)

- [ ] **Step 1: Update each carry-forward note**

Add, above each note's existing status block, a `> ## Status after Plan 10` block naming what closed and how, with the task's commit subject. Per note:

- plan1: unmount cancellation (Task 5), failed page fetch (Task 4). Nothing still open.
- plan5: §4 reported upstream (Task 15, URL or "fixed upstream in X"), §5 locator (Task 8), §6 test names and level fixture (Task 13), GroupsPanel filter (Task 11); `planColumns` twice accepted.
- plan6: §1 key prefix (Task 3), §2 bridge rows (Task 14), §3 test gaps (Task 7; Settings propagation accepted), §4: Settings `useUsage` (Task 3), unconsumed fields and `usageApplies` and CSS (Task 12), four-state machine (Task 12a); nested button accepted.
- plan7: §4 records stay records.
- plan8: §2 `onProgress` (Task 6); §3 `batchSize` coupling (Task 2), tick (Task 9), `JSON.stringify` (Task 10), size (Tasks 10 and 10a).

- [ ] **Step 2: Rewrite `OPEN-ITEMS.md`**

Keep the preamble's rules. Set "Last reconciled: Plan 10, <date>, every entry re-checked against the code." Structure:

```markdown
## Open

- <each finding from 2026-09-plan10-multiversion-review.md not fixed on the branch>
- @dhis2/ui align report: <"filed: URL" | "awaiting filing by the maintainer from docs/superpowers/notes/2026-09-dhis2-ui-align-issue.md">

## Accepted, with reasons

- Organisation unit name translations on the SQL view path — maintainer decision 2026-09-17: an admin tool, not worth a locale-aware view; remedy and a buildable design recorded in main spec §8a.
- `GroupSetCard`'s real `<button>` inside `div[role="button"]` — least-bad option for a tag that must navigate elsewhere; keyboard seam fixed in Plan 6.
- `planColumns` computed twice per Overview render — both memoised on their own inputs.
- Settings' invalidation propagating — pinned at unit level by the shared `USAGE_QUERY_PREFIX` test and live by the e2e usage flow; a unit test through a mocked query layer would prove nothing.
- `writeMemberships` keeps `batchSize` as a test seam — the duplicated predicate is gone (Plan 10 Task 2) and `useMembershipWrite.test.tsx` fails if production ever passes one.

## Records, not work

- plan7 §4: `lastupdated-probe.js` never committed (its discriminating part is in `2026-09-plan7-lastupdated-guard.md` §5); `write-shapes.js`'s restore uses the import shape; server cost was measured with `pg_stat_database`, missing Tomcat CPU.

## Closed in Plan 10

<one line per closed item with the task's commit subject>

## Closed earlier, so nobody re-opens them

<the existing list>
```

- [ ] **Step 3: Verify the whole branch one last time**

Run: `pnpm test 2>&1 | tail -5 && pnpm exec tsc --noEmit && pnpm lint`
Expected: all green. Then `git log --oneline c75c712..HEAD` reads as one commit per task plus any review fixes.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/notes
git commit -m "Reconcile the open items after Plan 10"
```

Hand-off: state the base commit (`c75c712`), the branch name, the number of commits, whether the `@dhis2/ui` issue still needs filing, and every review finding left open.

---

## Self-review

**Coverage against OPEN-ITEMS.md**, entry by entry:

| Entry | Task |
| --- | --- |
| Org unit name translations (specified, not built) | 16 (closed as accepted, spec amended), 19 |
| §10 multi-version review: different databases, structured manual review, freshness included, EMIS automated | 17, 18 |
| `batchSize` coupling | 2 |
| `sqlViewData` prefix | 3 |
| Failed page fetch, no retry | 4 |
| Unmount not cancelled | 5 |
| Bridge-row claim only on 2.43.1 | 14 |
| `@dhis2/ui` align not reported | 15 |
| `onProgress` mixed write | 6 |
| `removeUsageView` success, `checkUsageView` short-circuit, `UsageTab` loading, Settings propagation | 7 (first three), accepted (fourth) |
| `'0 objects'` locator | 8 |
| `BulkFixDialog` size | 10 (data pieces out), 10a (steps and catch-all hook extracted) |
| Freshness tick while null | 9 |
| Order-sensitive plan comparison | 10 |
| Settings mounts `useUsage` for `refresh` | 3 |
| Unconsumed fields, `usageApplies`, CSS duplication | 12 |
| Nested button | accepted (maintainer decision) |
| Settings' duplicated four-state machine | 12a |
| Test names, contiguous levels, GroupsPanel filter, `planColumns` | 13, 13, 11, accepted |
| plan7 §4 records | records (19) |
| Closed list | preserved (19) |

Plus one item the index did not have: the formatting drift (Task 1).

**Type consistency:** `takesPatchRoute(change, batchSize?)` (Task 2) is what Task 10 imports; `WriteOptions` is what Task 6's test passes; `USAGE_QUERY_PREFIX` / `useUsageRefresh` (Task 3) are what Task 7 relies on and Settings imports; `refetch: () => void` (Task 4) is on both branches of `useEngineQuery`'s return; `sameChanges(a, b)` and `readGroupMembers(fetcher, objectType, groupIds, signal?)` are used with those exact arities in Task 10's dialog change.

**Placeholders:** the angle-bracketed values in Tasks 15, 16, 18 and 19 are cells to be filled from measurements the task itself produces, not deferred design. The only "confirm against the file" instructions are for exact rendered strings and helper names an executor must read from the current source (the re-confirmation sentence in Task 10, the `Search`/`Objects` labels in Task 17, the reset hook in Task 13), because copying them here would rot.
