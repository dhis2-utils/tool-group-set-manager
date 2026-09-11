# Group Set Integrity Tool, Plan 2: Fixing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the read-only tool into one that fixes what it finds: assign an object to the right group, move a filtered set of objects to a catch-all group in bulk, create that catch-all group when a set lacks one, change a set's properties, and undo any of it from a history that survives a reload.

**Architecture:** A write layer (`src/data/writes.ts`, `src/data/metadataWrites.ts`) that batches membership changes and reconciles each batch against what the server says it did; a dataStore client (`src/data/datastore.ts`) holding configuration and one document per change set; engine additions that apply a change set to the in-memory indexes without a reload; and React mutation hooks that tie the three together so a write updates the screen, the cache and the history in one place. The UI work is the bulk fix dialog, the History page, the Settings page, and wiring the membership control that Plan 1 built read-only.

**Tech Stack:** Unchanged from Plan 1. `@dhis2/cli-app-scripts` 12 (Vite), TypeScript strict, pnpm, React 18, `@dhis2/ui` 10.17, `@dhis2/app-runtime` 3, react-router-dom hash router, `@tanstack/react-query` v4, `@tanstack/react-virtual` v3, `idb` 8, Jest with React Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-10-group-set-integrity-tool-design.md` — sections 3.3, 3.4, 5.3, 5.4, 5.5, 5.6 and 6 define this plan.

**Also read before starting:**
- `docs/superpowers/notes/2026-09-plan2-write-api-findings.md` — what the DHIS2 write API actually does, measured. Four facts in it change how this plan is built; the tasks cite them.
- `docs/superpowers/notes/2026-09-plan1-carry-forward.md` — what Plan 1 deferred. Three items block this plan and are Task 1.
- `CLAUDE.md` — the project's conventions, including the translation rules.

## Global Constraints

- Minimum DHIS2 version 2.40; every request must work on 2.40 through 2.43. Plan 1 verified the read paths on all four; this plan must verify the write paths the same way.
- `src/engine` must not import React, anything from `@dhis2/*`, or anything from `src/data` or `src/pages`.
- React 18 only. No Suspense for data fetching, no React 19 APIs. Explicit loading states.
- UI components only from `@dhis2/ui` 10.17.0. Read the real props in `node_modules/@dhis2/ui/` before using a component; the installed version differs from memory in several places Plan 1 found the hard way, and `SingleSelect` throws outright when `selected` matches no option.
- CSS Modules with DHIS2 design tokens for colours and spacing. No hard-coded hex colours.
- Every user-facing string through `i18n.t()` from `@dhis2/d2-i18n`, following the rules in `CLAUDE.md`: one complete string per call, never a second argument, a `{placeholder}` interpolated afterwards when a value is needed, and no colons in the string.
- `displayName`, never `name`, for anything shown to a user.
- Never call `useDataQuery` directly; go through `useApiDataQuery`. Never disable paging on a data engine query; ask for a page size instead.
- TypeScript strict mode. No `any`, no `@ts-expect-error`.
- Test-driven: write the test first, run it, watch it fail for the right reason, then implement. Every task's report carries the RED and GREEN evidence.
- Verification after every task, all four clean and each run in the foreground with a generous timeout: `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm exec eslint src`, `pnpm exec prettier -c .`.
- One commit per task. End the message with a `Co-Authored-By` trailer naming the model that wrote it, and nothing after it. Never add a session-URL trailer; the user's configuration forbids it in repo history.
- **Nothing in this plan may write to a DHIS2 instance without the user having confirmed that specific change in the interface first.** A preview is not a confirmation.

## A note on how much code this plan carries

Plan 1's tasks carried complete implementations, and its reviews repeatedly found
defects in that code that the implementer then had to be told to fix against the
plan's own text: an unbounded parent walk, a membership count that misread a
duplicate, a paging guard that could not distinguish two cases. Literal code in a
plan is code nobody reviewed.

So this plan carries the parts where being wrong is subtle and hard to see, which
means the interfaces, the test cases that matter, and the arithmetic in Tasks 4
and 9. The routine parts are specified by their interface, their tests and their
constraints rather than transcribed. Where a step says "implement", everything
needed to do it correctly is in the step above it and in the interfaces block; if
that turns out not to be true when you get there, say so rather than guessing.

## The rules this plan is built on

Two facts from the write API findings govern several tasks. They are repeated here because getting either wrong produces a tool that lies to its user.

**An invalid id in a batch is silently dropped.** The server returns 200 with a
type report whose `stats.total` counts only what it accepted, with no error
report and nothing naming the id it rejected. So a write is only known to have
succeeded if the number of changes the server reports equals the number sent.
Every batch reconciles; a shortfall is a partial failure.

**A membership write does not bump the group's `lastUpdated`.** The app's cache
validity check cannot see the app's own writes. The app knows what it changed,
so it invalidates precisely that. It must never assume a later load will notice.

## File structure

```
src/engine/changeSet.ts          ChangeSet types and revert inversion (pure)
src/engine/store.ts              (modify) applyChangeSet, setConfig re-evaluates, resolveParents
src/data/datastore.ts            dataStore client: config documents and change set documents
src/data/writes.ts               membership batching, reconciliation against stats, retry
src/data/metadataWrites.ts       create catch-all group, add it to a set, patch set properties
src/hooks/useGsiConfig.tsx       required levels, catch-all mapping, tracker toggle
src/hooks/useMembershipWrite.ts  the one place a write updates server, engine, cache and history
src/hooks/useChangeSets.ts       read, record and revert change sets
src/components/BulkFixDialog/    the three-step dialog
src/components/ChangeSetPreview/ shared preview table used by the dialog and by revert
src/pages/History/               the change set list
src/pages/Settings/              admin configuration
```

---

### Task 1: Close the three blockers Plan 1 left in the engine

**Files:**
- Modify: `src/engine/store.ts`, `src/engine/rules.ts`, `src/data/loadAll.ts`
- Test: `src/engine/store.test.ts`, `src/engine/rules.test.ts`, `src/data/loadAll.test.ts`

**Interfaces:**
- Produces: `EngineStore.setConfig` re-evaluates; `EngineStore.resolveParents(objectType, indexes): (ObjectRef | null)[]`; the cached-reuse path in `loadAll` can no longer leave a type half-committed.
- Consumed by: every later task.

`docs/superpowers/notes/2026-09-plan1-carry-forward.md` explains why each of these blocks this plan. Do all three in one task because they are all "make the engine safe to write against", and each is small.

- [ ] **Step 1: Write the failing test for `setConfig`**

Add to `src/engine/store.test.ts`. The store currently keeps the config and waits for an explicit `evaluate()`; this asserts that it does not have to be asked twice.

```typescript
it('re-evaluates when the config changes, without being asked twice', () => {
    const store = loadedStore() // the existing helper
    const before = store.dashboard({ objectType: 'organisationUnit', rootId: null })
    expect(before[0].summary.missingError).toBe(1)

    store.setConfig({ requiredLevels: { own: [3] }, includeTracker: false })

    const after = store.dashboard({ objectType: 'organisationUnit', rootId: null })
    expect(after[0].summary).not.toEqual(before[0].summary)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test -- src/engine/store`
Expected: the two summaries are equal, because nothing recomputed.

- [ ] **Step 3: Make `setConfig` re-evaluate**

In `src/engine/store.ts`, have `setConfig` store the config and then call its own `evaluate()`. Add a comment saying why: a caller that changes required levels or the tracker toggle and forgets to re-evaluate would serve numbers computed against the old rules, and this plan introduces exactly those callers.

Check the cost before you commit to it. `evaluate()` rebuilds every loaded set; on the EMIS instance that is seven sets over 1.1 million memberships. If a config change is rare, which it is, rebuilding is the right trade. Say in your report what `evaluate()` costs on the synthetic 300,000-object tree from `src/engine/perf.test.ts`, since that number decides whether this is acceptable.

- [ ] **Step 4: Settle the required-levels contradiction**

Spec 3.3 says required levels on a non-compulsory set make the other levels ignored. `src/engine/rules.ts` instead still returns a missing warning at other levels when the set is a data dimension, and `rules.test.ts` asserts that behaviour.

Decide which is right and make the code, the test and the spec agree. The spec's reading is the one a user configured required levels to get: they are saying "this set only applies at these levels", and a warning at every other level is the noise they were trying to remove. Prefer the spec unless you find a concrete reason not to, and say in your report which you chose and why. If you change the spec, change it in the same commit.

- [ ] **Step 5: Write the failing test for the cached-reuse rollback**

In `src/data/loadAll.test.ts`, with a populated cache, make the second engine call reject and assert the type is absent from the engine afterwards rather than holding objects with no memberships.

```typescript
it('leaves no half-loaded type when a cached reuse fails part way', async () => {
    // populate the cache
    const cache = createMemoryCache()
    await loadAll({ source: fakeSource(), fetcher, cache, engine: inlineEngine(), onStatus: () => undefined })

    // second run: the memberships call into the engine fails
    const engine = inlineEngine()
    const original = engine.call.bind(engine)
    engine.call = ((method: string, ...args: unknown[]) =>
        method === 'loadMemberships'
            ? Promise.reject(new Error('worker died'))
            : original(method, ...args)) as typeof engine.call

    const status: LoadStatus[] = []
    await loadAll({ source: fakeSource(), fetcher, cache, engine, onStatus: (s) => status.push(s) })

    expect(status[status.length - 1].errors.organisationUnit).toMatch(/worker died/)
    const [entry] = engine.store.dashboard({ objectType: 'organisationUnit', rootId: null })
    expect(entry.hasData).toBe(false)
})
```

- [ ] **Step 6: Run it and watch it fail**

Run: `pnpm test -- src/data/loadAll`
Expected: `hasData` is true, because the objects landed and the memberships did not.

- [ ] **Step 7: Make the cached-reuse path all-or-nothing**

The engine's `loadMemberships` requires the type to exist, so the two calls cannot simply be merged. Add a way to undo the first: the simplest is a `dropType(objectType)` on the store that removes the type and any sets evaluated from it, called from `loadAll`'s catch when the reuse path fails after `loadObjects` succeeded. Keep it narrow; this is not a general transaction mechanism.

- [ ] **Step 8: Add `resolveParents`**

Task 11 needs a parent's display name for a page of rows, and asking the store for one name at a time across the worker boundary would be a round-trip per row. Add to `src/engine/store.ts`:

```typescript
/**
 * The display refs of each given object's parent, in the same order, with null
 * where an object has no parent or the type has no hierarchy. One call per page
 * of rows rather than one per row: at 266,000 objects the difference is a
 * round-trip per visible row versus a round-trip per scroll.
 */
resolveParents(objectType: ObjectType, indexes: ArrayLike<number>): (ObjectRef | null)[]
```

Add `'resolveParents'` to `EngineMethod` in `src/engine/protocol.ts`. Test it for a hierarchical type, for a root object, and for a flat type.

- [ ] **Step 9: Verify and commit**

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm exec eslint src
pnpm exec prettier -c .
git add -A
git commit -m "Make the engine safe to write against

setConfig now re-evaluates, so a caller that changes required levels or the
tracker toggle cannot serve numbers computed against the old rules. Required
levels now mean what the spec says they mean. A cached reuse that fails part
way no longer leaves a type holding objects with no memberships. resolveParents
answers a page of parent names in one call."
```

---

### Task 2: Change set types and the pure revert computation

**Files:**
- Create: `src/engine/changeSet.ts`, `src/engine/changeSet.test.ts`
- Modify: `src/engine/store.ts`, `src/engine/protocol.ts`

**Interfaces:**
- Produces:
  - ```typescript
    interface GroupChange { groupId: string; additions: string[]; deletions: string[] }
    interface ChangeSet {
        id: string
        createdAt: string
        createdBy: { id: string; displayName: string }
        objectType: ObjectType
        groupSetId: string
        groupSetName: string
        action: 'move' | 'assign' | 'revert'
        note: string
        targetGroupId?: string
        changes: GroupChange[]
        revertOf?: string
    }
    ```
  - `invert(changeSet: ChangeSet): GroupChange[]` — additions and deletions swapped per group.
  - `EngineStore.applyChangeSet(objectType: ObjectType, changes: GroupChange[]): void` — updates the raw member lists and re-evaluates, so the screen reflects a write without a reload.
  - `EngineMethod` gains `'applyChangeSet'`.
- Consumed by: Task 3 (the dataStore stores them) and Tasks 5, 6, 8, 9.

This file is pure and lives in the engine because the revert computation is arithmetic on ids, not a network concern, and because the store needs it too.

- [ ] **Step 1: Write the failing tests for `invert`**

```typescript
it('inverts every group change', () => {
    const changes = [
        { groupId: 'a', additions: ['1', '2'], deletions: ['3'] },
        { groupId: 'b', additions: [], deletions: ['4'] },
    ]
    expect(invert({ ...base, changes })).toEqual([
        { groupId: 'a', additions: ['3'], deletions: ['1', '2'] },
        { groupId: 'b', additions: ['4'], deletions: [] },
    ])
})
```

- [ ] **Step 2: Write the failing tests for `applyChangeSet`**

In `src/engine/store.test.ts`. Load the usual fixture, apply a change that moves one object from one group to another, and assert the dashboard and the object list reflect it immediately with no reload. Then assert that applying a change naming an object the engine does not know is ignored rather than throwing, because a change set restored from the dataStore may name objects that have since been deleted.

- [ ] **Step 3: Run them and watch them fail**

- [ ] **Step 4: Implement**

`applyChangeSet` mutates the store's raw `membersByGroup` map for the named type, adding and removing ids, then calls `evaluate()`. Ignore ids the type does not know. Ignore group ids that belong to no loaded set, and say so in a comment: a change set may name a group that has since been removed from the set.

- [ ] **Step 5: Verify and commit**

```bash
git commit -m "Add change set types, revert inversion and in-memory application"
```

---

### Task 3: The dataStore client

**Files:**
- Create: `src/data/datastore.ts`, `src/data/datastore.test.ts`

**Interfaces:**
- Consumes: `Fetcher`, `fetchJson` from `src/data/sources/DataSource.ts`; `ChangeSet` from `src/engine/changeSet.ts` (Task 2).
- Produces:
  - `const NAMESPACE = 'group-set-integrity'`
  - `interface GsiConfig { requiredLevels: Record<string, number[]>; catchAllGroup: Record<string, string>; includeTracker: boolean }`
  - `loadConfig(fetcher): Promise<GsiConfig>` — reads the three config documents, returning defaults for any that are absent.
  - `saveRequiredLevels(fetcher, setId, levels: number[]): Promise<void>`
  - `saveCatchAllGroup(fetcher, setId, groupId: string): Promise<void>`
  - `saveIncludeTracker(fetcher, value: boolean): Promise<void>`
  - `listChangeSets(fetcher): Promise<ChangeSet[]>` — newest first.
  - `saveChangeSet(fetcher, changeSet: ChangeSet): Promise<void>`
  - `canWriteDataStore(fetcher): Promise<boolean>`

Key layout inside the namespace: `config-required-levels`, `config-catch-all`, `config-general`, and `history-<uid>` for each change set. A flat key space, because the dataStore has no nesting and listing keys is the only way to enumerate.

- [ ] **Step 1: Write the failing tests**

`src/data/datastore.test.ts`, using fabricated `Response` objects as the other data tests do. Cover: a namespace that does not exist yet returns defaults rather than throwing; a config document present is merged over the defaults; saving a document that does not exist yet creates it and saving one that does updates it, since the dataStore distinguishes those by verb; change sets come back newest first; and a 403 from the namespace reports no write access rather than throwing.

The create-versus-update distinction is the one that bites. The dataStore returns 409 when you POST a key that exists and 404 when you PUT one that does not, so the client must handle both directions rather than guessing.

```typescript
it('creates a key that does not exist and updates one that does', async () => {
    const calls: { method: string; path: string }[] = []
    const fetcher = async (path: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        calls.push({ method, path })
        if (method === 'POST' && path.endsWith('config-general')) {
            return new Response('{}', { status: 409 })
        }
        return new Response('{}', { status: 200 })
    }
    await saveIncludeTracker(fetcher, true)
    expect(calls.map((c) => c.method)).toEqual(['POST', 'PUT'])
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test -- src/data/datastore`
Expected: module not found.

- [ ] **Step 3: Implement the client**

Write to the key with a POST, and on 409 retry the same body with PUT. Read with a GET, treating 404 as absent. List with a GET on the namespace, treating 404 as an empty namespace. Never let a dataStore failure throw into a caller that is only reading configuration: `loadConfig` returns defaults on any failure and says so in a comment, because an instance where the app has never run has no namespace at all and that is the normal first-run case, not an error.

- [ ] **Step 4: Run them and watch them pass, then verify and commit**

```bash
pnpm test -- src/data/datastore
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src && pnpm exec prettier -c .
git add src/data/datastore.ts src/data/datastore.test.ts
git commit -m "Add the dataStore client for configuration and change sets"
```

---

### Task 4: The membership writer

**Files:**
- Create: `src/data/writes.ts`, `src/data/writes.test.ts`
- Modify: `src/data/endpoints.ts` if a member collection path is missing

**Interfaces:**
- Produces:
  - `interface BatchOutcome { groupId: string; requested: number; accepted: number; error?: string }`
  - `interface WriteResult { outcomes: BatchOutcome[]; applied: GroupChange[]; unaccounted: GroupChange[] }`
  - `writeMemberships(fetcher, objectType, changes: GroupChange[], onProgress: (done: number, total: number) => void, batchSize?: number): Promise<WriteResult>`
- Consumed by: Tasks 5, 6, 8, 9.

This is the task the write API findings were written for. Read section 2 of `docs/superpowers/notes/2026-09-plan2-write-api-findings.md` before starting.

- [ ] **Step 1: Write the failing tests**

Cover, with fabricated responses:

1. A single group's additions and deletions go to `POST /api/<groups>/<id>/<members>` with a body of `{additions:[{id}],deletions:[{id}]}`.
2. Changes larger than the batch size are split, and the progress callback is called once per batch with a rising count.
3. **The silent-drop case.** The server returns 200 with `stats.total` lower than the number of changes sent. The result must report that group as a partial failure, with `accepted` below `requested`, and the objects it cannot account for must appear in `unaccounted`. This is the test that matters most in this task; without it the app reports success for writes that did not happen.
4. A non-200 response records the error against that group and does not stop the remaining groups, because one read-only group must not block fixing the rest.
5. `applied` contains only what the server confirmed, so a change set records the truth rather than the intent.

```typescript
it('reports a partial failure when the server accepts fewer changes than it was sent', async () => {
    const fetcher = async () =>
        new Response(
            JSON.stringify({ response: { stats: { total: 1, updated: 1, deleted: 0, ignored: 0 } } }),
            { status: 200 }
        )
    const result = await writeMemberships(
        fetcher,
        'organisationUnit',
        [{ groupId: 'g1', additions: ['a', 'b'], deletions: [] }],
        () => undefined
    )
    expect(result.outcomes[0]).toMatchObject({ groupId: 'g1', requested: 2, accepted: 1 })
    expect(result.unaccounted).toEqual([{ groupId: 'g1', additions: ['a', 'b'], deletions: [] }])
    expect(result.applied).toEqual([])
})
```

Note what that last assertion says: when the server accepts fewer than it was sent, the client cannot tell **which** ones it accepted, because the response does not name them. So the honest result is that the whole batch is unaccounted for and must be re-read from the server. Do not guess a subset.

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

One request per group per batch, sequential, so a large fix is a steady trickle rather than a burst. The reconciliation is the part to get exactly right:

```typescript
const stats = body?.response?.stats
// An addition of an existing member is reported as ignored, and is still a
// success: the member is in the group, which is what was asked for. So every
// bucket counts. What does not count is the absence of a bucket: a response
// without stats tells us nothing, so treat it as nothing accepted.
const accepted = stats
    ? (stats.created ?? 0) + (stats.updated ?? 0) + (stats.deleted ?? 0) + (stats.ignored ?? 0)
    : 0
const requested = batch.additions.length + batch.deletions.length
```

When `accepted === requested`, the batch is confirmed and its changes go into `applied`. When it is lower, the whole batch goes into `unaccounted`, because the response names nothing and there is no way to tell which ids the server took. Do not guess a subset; the caller re-reads those groups from the server instead.

Batch size defaults to 1,000 ids per request, counting additions and deletions together, which keeps a 100,000-object fix to a hundred requests rather than one enormous body.

- [ ] **Step 4: Verify and commit**

```bash
git commit -m "Add the membership writer, reconciling every batch against what the server says it did"
```

---

### Task 5: Metadata writes, and the one place a write lands

**Files:**
- Create: `src/data/metadataWrites.ts`, `src/data/metadataWrites.test.ts`, `src/hooks/useMembershipWrite.ts`, `src/hooks/useMembershipWrite.test.tsx`
- Modify: `src/hooks/useEngine.tsx` to expose what the hook needs

**Interfaces:**
- Produces:
  - `createCatchAllGroup(fetcher, set: GroupSetMeta): Promise<{ id: string; displayName: string }>` — creates a group named "Other/unknown &lt;set name&gt;", with a short name truncated to the 50 characters DHIS2 allows, a code derived from the set's code when it has one, and sharing copied from a sibling group in the set; then adds it to the set. Returns the new group.
  - `setGroupSetProperties(fetcher, setId, props: { compulsory?: boolean; dataDimension?: boolean }): Promise<void>` — a JSON patch.
  - `useMembershipWrite()` returning `{ write(input): Promise<WriteResult & { changeSet: ChangeSet }>; isWriting: boolean }`.
- Consumed by: Tasks 6, 7, 8, 9, 10.

`useMembershipWrite` is the single place a membership change happens, and it does four things in order: write to the server, apply what was confirmed to the engine, invalidate the cache for the affected type, and record a change set. Everything else in this plan calls it. Getting the order right matters: the engine must only be told about changes the server confirmed, and the cache must be invalidated even if recording the change set fails, because a stale cache is worse than a missing history entry.

Read section 3 of the write API findings before writing the cache step: a membership write does not bump `lastUpdated`, so the next load will not notice on its own.

- [ ] **Step 1: Write the failing tests for `createCatchAllGroup`**

Cover: the created group's name and short name, the short name being truncated rather than rejected when the set's name is long, sharing copied from a sibling, the group being added to the set afterwards, and a set with no existing groups producing a group with sensible default sharing rather than throwing.

- [ ] **Step 2: Write the failing tests for `useMembershipWrite`**

Cover: a successful write applies exactly the confirmed changes to the engine and records a change set whose `changes` equal them; a partial write applies only what was confirmed; a failed change set save still leaves the engine and cache correct and surfaces the failure; and the cache for the affected type is invalidated in every one of those cases.

- [ ] **Step 3: Run them and watch them fail**

- [ ] **Step 4: Implement**

- [ ] **Step 5: Verify and commit**

```bash
git commit -m "Add catch-all group creation, set property patching and the write hook"
```

---

### Task 6: Assigning one object to a group

**Files:**
- Modify: `src/components/MembershipControl/MembershipControl.tsx`, `src/components/ObjectsTable/ObjectsTable.tsx`, `src/pages/GroupSetDetail/ObjectsTab.tsx`
- Test: the existing test files, plus `src/components/ObjectsTable/ObjectsTable.withEngine.test.tsx`

**Interfaces:**
- Consumes: `useMembershipWrite` (Task 5).
- Produces: the membership control becomes interactive when the user may write, and choosing a group assigns the object to it and removes it from the others in the same set.

This is the first task a user can feel. Plan 1 built the control read-only and disabled; the shape is already right. The work is enabling it, computing the change, confirming it, and showing the result.

- [ ] **Step 1: Write the failing tests**

Cover: clicking a group in the segmented control on a conflict row produces a change that removes the object from the other groups of the set and adds it to the chosen one; the control stays disabled when the user cannot write to one of the groups involved, with the reason named; a write in flight disables the row rather than allowing a second click; and a failed write leaves the row showing its original groups rather than the optimistic new one.

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

Compute the change from the object's current groups rather than from the whole set, so a well-formed object moving from one group to another produces one addition and one deletion rather than a deletion per group.

Confirm before writing. A single assignment does not warrant the full dialog, but it does warrant a one-line confirmation naming what will happen, because this is a metadata change to a shared instance. Use `@dhis2/ui`'s alert or modal per the project's existing patterns.

- [ ] **Step 4: Verify and commit**

---

### Task 7: The bulk fix dialog, action and preview

**Files:**
- Create: `src/components/BulkFixDialog/BulkFixDialog.tsx`, its CSS module and test; `src/components/ChangeSetPreview/ChangeSetPreview.tsx`, its CSS module and test
- Modify: `src/pages/GroupSetDetail/ObjectsTab.tsx` and `GroupSetDetail.tsx` to open it

**Interfaces:**
- Produces: `<BulkFixDialog set scope filter selection onClose onApplied />`, and `<ChangeSetPreview changes groups objects />` which both this dialog and revert use.
- Spec 5.3 defines the three steps.

- [ ] **Step 1: Write the failing tests for the preview component**

It renders one line per group with a signed count, a sample of rows with a Now and an After column, and a callout naming objects skipped because a group involved is read-only. Its counts must match the change it was given; a preview that disagrees with what will be written is the worst defect this dialog can have, so assert that directly.

- [ ] **Step 2: Write the failing tests for the dialog's first two steps**

Cover: the catch-all target is preselected from the configuration when one is recorded, from a group whose name suggests it when not, and neither when the set has no candidate, in which case the dialog offers to create one; choosing "assign all to one group" instead changes the computed change accordingly; the preview's totals equal the selection size; and the full list is downloadable as CSV.

- [ ] **Step 3: Run them and watch them fail**

- [ ] **Step 4: Implement the first two steps**

Do not implement Apply in this task; leave the button disabled with the next task's name on it. Splitting the dialog across two tasks keeps each reviewable, and the preview is the half that must be right before anything is written.

- [ ] **Step 5: Verify and commit**

---

### Task 8: The bulk fix dialog, apply and result

**Files:**
- Modify: `src/components/BulkFixDialog/BulkFixDialog.tsx` and its test

**Interfaces:**
- Consumes: `useMembershipWrite` (Task 5), `writeMemberships` progress (Task 4).

- [ ] **Step 1: Write the failing tests**

Cover: applying calls the write hook with exactly the change the preview showed; progress is reported per batch; the result panel lists each group's outcome including a partial acceptance; a failed batch offers a retry that sends only what failed; and the dialog cannot be dismissed mid-write in a way that loses the result.

The partial-acceptance case is the one to get right. When the server accepts fewer changes than it was sent, the result panel must say so plainly, name the group, and tell the user the affected objects need re-reading rather than implying the fix worked.

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Verify, then check it against a live instance**

A DHIS2 2.43 instance with the Sierra Leone demo is at `http://dhis2-agent-gsi-p2:8080`, credentials `local_admin` / `district`. It is a disposable development instance for this plan, so writing to it is expected.

Start the dev server in the background, recording its process id, and stop it by that id afterwards:

    pnpm start --port "$SANDBOX_HOST_PORT" --proxy http://dhis2-agent-gsi-p2:8080

Facility Ownership on that instance has 15 conflicting facilities, all in Bo. Fix them with the dialog, then confirm three things independently with curl: the memberships changed as the preview said, the dashboard's conflict count fell to zero, and a change set was recorded in the dataStore. Screenshot the dialog's three steps and the result.

- [ ] **Step 5: Commit**

---

### Task 9: History and revert

**Files:**
- Create: `src/pages/History/History.tsx`, its CSS module and test; `src/hooks/useChangeSets.ts` and its test
- Modify: `src/App.tsx` for the route, and the app's navigation

**Interfaces:**
- Consumes: `listChangeSets`, `saveChangeSet` (Task 2), `invert` (Task 3), `useMembershipWrite` (Task 5).
- Spec 5.4 defines the page.

- [ ] **Step 1: Write the failing tests**

Cover: change sets listed newest first with who, when, which set, the action and the number of membership changes; revert previewing what it would change given the current state; revert skipping an object that has since been moved elsewhere, and saying how many it skipped; revert being recorded as a new change set referring to the one it reverses; and a change set whose group set no longer exists being listed but not revertible.

The skipping rule is the substance of this task. Reverting a move means putting objects back where they were, but only for objects that are still where the change set left them. An object a user has since assigned deliberately must not be dragged back.

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

The skipping rule, stated precisely, because it is the whole substance of revert:

For each group change being inverted, an addition is only reverted if the object
is currently **in** that group, and a deletion is only reverted if the object is
currently **not** in it. Ask the engine for the object's current groups rather
than trusting the change set, which describes a past state. An object that fails
either test is skipped and counted, and the preview says how many were skipped
and why, naming a few of them.

This is what stops a revert from undoing a later deliberate decision. If a user
moved a facility to Other/unknown in bulk and then assigned it to Public by hand,
reverting the bulk move must leave it in Public.

- [ ] **Step 4: Verify and commit**

---

### Task 10: Settings

**Files:**
- Create: `src/pages/Settings/Settings.tsx`, its CSS module and test
- Modify: `src/App.tsx`, `src/hooks/useGsiConfig.tsx`

**Interfaces:**
- Spec 5.5 defines the page: required levels per org unit group set, the catch-all mapping per set, the default tracker toggle, SQL view status with create or repair, and clear cache.

The SQL view part is the one that matters most, and the measurement record says why: on the EMIS instance the app is unusable without those three views, and nothing in the app yet offers to create them. `SQL_VIEW_DEFINITIONS` in `src/data/sources/sqlViewSource.ts` has carried the definitions since Plan 1 for exactly this.

- [ ] **Step 1: Write the failing tests**

Cover: the page shows which of the three views exist and whether the user may read their data; the create action posts each missing view with its code, its type and public read sharing, and reports what it created; a user without the authority sees the status and an explanation rather than a button that will fail; required levels save and take effect without a reload, which Task 1 made possible; and the catch-all mapping can be set to any group of the set.

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Verify, then check the SQL view creation against a live instance**

Against `http://dhis2-agent-gsi-p2:8080`, create the views from the Settings page, confirm with curl that all three exist with the right codes and types, and confirm the app then reports the SQL view source. Then delete them and confirm the app falls back. Screenshot both states.

- [ ] **Step 5: Commit**

---

### Task 11: Parent names in the object list

**Files:**
- Modify: `src/components/ObjectsTable/ObjectsTable.tsx`, its CSS module and tests

**Interfaces:**
- Consumes: `EngineStore.resolveParents` (Task 1).

Plan 1 dropped this column because it showed a raw DHIS2 id, which reads as noise. It comes back now that the parent's name can be resolved, because at national scope the list otherwise has nothing to distinguish two identically named facilities.

- [ ] **Step 1: Write the failing tests**

Cover: the column shows the parent's display name; it asks the engine once per page rather than once per row; a root object shows nothing rather than a dash that looks like data; and a flat object type has no such column at all.

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Verify and commit**

---

### Task 12: Prove the write paths on the oldest and newest supported versions

**Files:**
- Create: `docs/superpowers/notes/2026-09-plan2-write-compatibility.md`

Plan 1 proved the read paths on 2.40 through 2.43 and found no difference. The write paths have only been probed on 2.43. The app claims 2.40 as its floor, and this task either proves that claim for writes or corrects it.

- [ ] **Step 1: Create a 2.40 instance**

Through the broker, a DHIS2 2.40 instance seeded with `dhis2-db-sierra-leone_V40.sql.gz`. The `dhis2-instances` skill has the recipe. Check the instance cap first and free a slot if needed by deleting one this project created.

- [ ] **Step 2: Exercise every write the app makes, on 2.40**

For each, record the request, the response and whether the app's handling is correct:
- a bulk membership change with additions and deletions,
- a batch containing an id that does not exist, to confirm 2.40 also drops it silently rather than reporting it, since the whole reconciliation design rests on that,
- creating a group and adding it to a set,
- a JSON patch setting `compulsory` and `dataDimension`,
- dataStore create, update, list and delete,
- creating the three SQL views from the Settings page.

- [ ] **Step 3: Do the same on 2.43**

Against the development instance, so the two columns are directly comparable.

- [ ] **Step 4: Run the app's own flows end to end on both**

Fix a conflict with the dialog, revert it from History, and confirm the numbers return to what they were. That round trip is the strongest single check in this plan: it exercises the writer, the reconciliation, the engine application, the cache invalidation, the change set and the revert computation in one motion.

- [ ] **Step 5: Write the record and commit**

State plainly whether 2.40 supports every write the app makes. If it does not, say which and what the app should do about it, and raise it rather than working around it silently.

---

## What this plan does not do

Left for a third plan, so that this one stays about fixing:

- The DHIS2 data integrity overlay, which spec 4.5 defines.
- Full-text search across all objects rather than the loaded page.
- The Playwright end-to-end suite.
- The smaller carried-forward items in `docs/superpowers/notes/2026-09-plan1-carry-forward.md` that are not blockers, which Task 1 does not touch.
