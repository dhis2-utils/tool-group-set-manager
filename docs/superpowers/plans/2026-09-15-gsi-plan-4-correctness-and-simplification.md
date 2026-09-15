# GSI Plan 4: Correctness and Simplification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the per-group-set "required levels" policy so that "every object belongs to exactly one group of the set" is the whole rule, fix the four defects carried forward from Plan 3, and answer the two remaining open items from the original spec.

**Architecture:** The rule change is subtractive and starts in the engine: `evaluateSet` loses two parameters and one branch, which cascades outward to `EngineConfig`, the dataStore layer, the config hook and the Settings page. The four defect fixes are independent of it and of each other. The two verifications are measurements against live DHIS2 instances, written up as a note.

**Tech Stack:** TypeScript, React 18, @dhis2/ui, @dhis2/app-runtime, TanStack Query v4, Jest + @testing-library/react, Vite via the DHIS2 App Platform, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-15-manual-review-1-design.md` (this plan implements §2, §7 and §8). The original design it amends is `docs/superpowers/specs/2026-09-10-group-set-integrity-tool-design.md`.

## Global Constraints

- Supported DHIS2 versions: **2.40 and newer**. Nothing may require a later version.
- `src/engine` is pure TypeScript with typed arrays, runs in a Web Worker, and imports nothing from React or DHIS2. Test it with plain Jest.
- Every user-facing string goes through a single, **argument-free** `i18n.t('…')` call. A second argument makes the call invisible to this project's i18next-scanner.
- **A sentence is translated whole.** Never join translated fragments around a value; put a `{name}` placeholder inside the one complete string and fill it with `interpolate()` from `src/utils/interpolate.ts`. Single braces, never `{{…}}`.
- **No colon inside an `i18n.t()` string** — the scanner reads it as a namespace separator and drops the key.
- Counts are two complete strings chosen on `count === 1`, with the number in a `{count}` placeholder.
- Run `pnpm exec d2-app-scripts i18n extract` after adding strings and check the output for scanner warnings.
- Gates that must pass before every commit: `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm exec eslint src`.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` and **never** a session-URL trailer.
- Broker instances are all `stopped` as of 2026-09-15. Start what you need, stop it again when done, and never touch an instance whose name does not begin with `agent-`.

---

## File Structure

| File | Responsibility after this plan |
| --- | --- |
| `src/engine/rules.ts` | `evaluateSet(set, membership, population)` — four branches, no level, no config |
| `src/engine/types.ts` | `EngineConfig` holds `includeTracker` only |
| `src/engine/store.ts` | `setConfig` re-evaluates; `evaluateOne` no longer passes level/config to `evaluateSet` |
| `src/data/datastore.ts` | `GsiConfig` holds `catchAllGroup` and `includeTracker`; no `saveRequiredLevels` |
| `src/hooks/useGsiConfig.tsx` | No `setRequiredLevels`; pushes `{ includeTracker }` to the worker |
| `src/pages/Settings/Settings.tsx` | No required-levels editor |
| `src/components/ObjectsTable/ObjectsTable.tsx` | A confirmed per-row assign updates its row and says so |
| `src/hooks/useEngine.tsx` | Exposes `groupSetsLoaded` so consumers can tell "not loaded yet" from "not there" |
| `src/pages/History/History.tsx` | Claims a group set is gone only once group sets have loaded |
| `package.json` | `@types/node` scoped to the need that introduced it |
| `docs/superpowers/notes/2026-09-plan4-version-verifications.md` | New: the two measurements |

---

### Task 1: Engine — remove required levels from the rule

**Files:**
- Modify: `src/engine/rules.ts`
- Modify: `src/engine/types.ts:39-48`
- Modify: `src/engine/store.ts:320-333`
- Test: `src/engine/rules.test.ts`, `src/engine/store.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `evaluateSet(set: GroupSetMeta, membership: SetMembership, population: Uint8Array): Uint8Array`
  - `interface EngineConfig { includeTracker: boolean }`
  - `const DEFAULT_CONFIG: EngineConfig = { includeTracker: false }`

- [ ] **Step 1: Rewrite the rule tests to the new signature**

Replace the whole `describe('evaluateSet')` block in `src/engine/rules.test.ts` with this. Note the two required-levels tests are deleted outright — that behaviour no longer exists — and a new test pins the case they used to own.

```ts
import { buildSetMembership } from './membership'
import { evaluateSet } from './rules'
import { GroupSetMeta, Status } from './types'

const set = (partial: Partial<GroupSetMeta>): GroupSetMeta => ({
    id: 's',
    displayName: 'S',
    objectType: 'organisationUnit',
    compulsory: false,
    dataDimension: false,
    groups: [],
    canWrite: true,
    ...partial,
})

// objects: 0 in group A, 1 in A and B, 2 in none, 3 in none (outside
// population), 4 in B
const m = buildSetMembership(5, [
    Int32Array.from([0, 1]),
    Int32Array.from([1, 4]),
])
const population = Uint8Array.from([1, 1, 1, 0, 1])

describe('evaluateSet', () => {
    it('conflict is always an error, even for plain sets', () => {
        const s = evaluateSet(set({}), m, population)
        expect(s[1]).toBe(Status.Conflict)
        expect(s[0]).toBe(Status.Ok)
        expect(s[2]).toBe(Status.Ok) // missing, but set is neither compulsory nor a dimension
        expect(s[3]).toBe(Status.NotApplicable)
    })

    it('missing is an error when the set is compulsory', () => {
        const s = evaluateSet(set({ compulsory: true }), m, population)
        expect(s[2]).toBe(Status.MissingError)
        expect(s[3]).toBe(Status.NotApplicable)
    })

    it('missing is a warning when the set is a dimension but not compulsory', () => {
        const s = evaluateSet(set({ dataDimension: true }), m, population)
        expect(s[2]).toBe(Status.MissingWarning)
    })

    it('compulsory wins over data dimension', () => {
        const s = evaluateSet(
            set({ compulsory: true, dataDimension: true }),
            m,
            population
        )
        expect(s[2]).toBe(Status.MissingError)
    })

    // Spec 2026-09-15 §2.1: the rule no longer varies by organisation unit
    // level. An object at level 2 and an object at level 4 with the same
    // membership get the same status, for every kind of set. This is the
    // case the deleted required-levels tests used to own.
    it('does not vary by organisation unit level', () => {
        const deep = buildSetMembership(2, [Int32Array.from([])])
        const s = evaluateSet(
            set({ dataDimension: true }),
            deep,
            Uint8Array.from([1, 1])
        )
        expect(s[0]).toBe(Status.MissingWarning)
        expect(s[1]).toBe(Status.MissingWarning)
    })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- src/engine/rules.test.ts`
Expected: FAIL — TypeScript/Jest reports `evaluateSet` called with 3 arguments but 5 expected.

- [ ] **Step 3: Rewrite the rule**

Replace the whole of `src/engine/rules.ts` with:

```ts
import { SetMembership } from './membership'
import { GroupSetMeta, Status } from './types'

/**
 * Spec 2026-09-15 §2.1. Returns one Status per object.
 * - Conflict (count > 1) is always an error.
 * - Exactly one group is Ok.
 * - Missing (count === 0) is an error when the set is compulsory, a
 *   warning when it is a data dimension and not compulsory, and Ok
 *   otherwise -- the "in no group, and that is allowed here" bucket.
 *
 * The rule deliberately does not vary by organisation unit level. The
 * per-set "required levels" policy that used to narrow it was removed in
 * Plan 4: level-based compulsoriness and group set completeness are
 * separate concerns, the data entry API is permissive enough that data
 * arrives below any level a policy names, and DHIS2's own integrity checks
 * flag a partial set regardless of what this app was told. The remedy for
 * objects a set does not really describe is a per-set catch-all group, not
 * a narrower rule.
 */
export function evaluateSet(
    set: GroupSetMeta,
    membership: SetMembership,
    population: Uint8Array
): Uint8Array {
    const n = population.length
    const status = new Uint8Array(n)

    for (let i = 0; i < n; i++) {
        if (population[i] === 0) {
            status[i] = Status.NotApplicable
            continue
        }
        const count = membership.memberCount[i]
        if (count > 1) {
            status[i] = Status.Conflict
        } else if (count === 1) {
            status[i] = Status.Ok
        } else if (set.compulsory) {
            status[i] = Status.MissingError
        } else if (set.dataDimension) {
            status[i] = Status.MissingWarning
        } else {
            status[i] = Status.Ok
        }
    }
    return status
}
```

- [ ] **Step 4: Shrink `EngineConfig`**

In `src/engine/types.ts`, replace lines 39-48 with:

```ts
export interface EngineConfig {
    includeTracker: boolean
}

export const DEFAULT_CONFIG: EngineConfig = {
    includeTracker: false,
}
```

- [ ] **Step 5: Update the store's call site**

In `src/engine/store.ts`, in the method that builds a set's state (around line 320), delete the `const level = t.hierarchy ? t.hierarchy.level : null` line **only if nothing else in that method uses `level`** (check first — `populationFor` takes `t.attrs`, not `level`), and change the call to:

```ts
        const status = evaluateSet(set, membership, population)
```

Leave `populationFor(set, t.ids.length, membership, t.attrs, this.config)` alone: it reads `includeTracker`, which survives.

Then update `setConfig`'s doc comment (around line 229) — it names "the Settings page writing required levels" as one of its two callers, and there is now only one:

```ts
    /**
     * Re-evaluates immediately. The tracker toggle is the only caller that
     * changes config, and it changes which data elements are in the
     * population, so a caller that forgot to follow up with an explicit
     * evaluate() would serve numbers computed against the old population
     * with nothing on screen to say so. The store does not leave that door
     * open.
     */
```

- [ ] **Step 6: Fix the store tests**

Run: `pnpm test -- src/engine/store.test.ts` and update every construction of an `EngineConfig` or use of `DEFAULT_CONFIG` that still names `requiredLevels`. Delete any store test whose subject is required-levels behaviour; do not rewrite it into something else.

- [ ] **Step 7: Run the full gate**

Run: `pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src`
Expected: PASS. `tsc` is the real check here — it names every remaining reference to `requiredLevels` inside `src/engine`.

- [ ] **Step 8: Commit**

```bash
git add src/engine
git commit -m "$(cat <<'EOF'
Drop the required-levels policy from the rule

Every object in the population is evaluated the same way at every level:
conflict is an error, one group is Ok, and no group is an error when the
set is compulsory, a warning when it is a data dimension, and allowed
otherwise. evaluateSet no longer needs the level array or the config.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Data layer and config hook — stop reading and writing required levels

**Files:**
- Modify: `src/data/datastore.ts:8,15,113-147`
- Modify: `src/hooks/useGsiConfig.tsx`
- Test: `src/data/datastore.test.ts`, `src/hooks/useGsiConfig.test.tsx`

**Interfaces:**
- Consumes: `EngineConfig` from Task 1.
- Produces:
  - `interface GsiConfig { catchAllGroup: Record<string, string>; includeTracker: boolean }`
  - `GsiConfigContextValue` without `setRequiredLevels`: `{ config, isLoaded, setCatchAllGroup, setIncludeTracker }`

- [ ] **Step 1: Write the failing test**

Add to `src/data/datastore.test.ts`:

```ts
// Spec 2026-09-15 §2.3: the dataStore document survives on instances that
// already have one, but the app neither reads it nor writes it. Deleting a
// user's stored data as a side effect of an upgrade is worse than leaving
// orphaned keys, and leaving them keeps a downgrade working.
it('never requests the required-levels document', async () => {
    const fetcher = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    await loadConfig(fetcher as never)
    const requested = fetcher.mock.calls.map((c) => String(c[0]))
    expect(requested.some((u) => u.includes('config-required-levels'))).toBe(false)
})
```

Match the existing mock-fetcher shape in that file — read the top of `datastore.test.ts` first and use whatever helper the neighbouring tests use rather than the sketch above if one exists.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test -- src/data/datastore.test.ts -t "required-levels document"`
Expected: FAIL — `loadConfig` still requests it.

- [ ] **Step 3: Remove it from the data layer**

In `src/data/datastore.ts`:
- delete `requiredLevels: Record<string, number[]>` from `GsiConfig` (line 8) and `requiredLevels: {}` from its default (line 15);
- in `loadConfig`, drop the first element of the `Promise.all` and the `requiredLevels:` key of the returned object, so it reads:

```ts
export async function loadConfig(fetcher: Fetcher): Promise<GsiConfig> {
    const [catchAllGroup, general] = await Promise.all([
        readDocument<Record<string, string>>(fetcher, 'config-catch-all'),
        readDocument<{ includeTracker?: boolean }>(fetcher, 'config-general'),
    ])
    return {
        catchAllGroup: catchAllGroup ?? DEFAULT_CONFIG.catchAllGroup,
        includeTracker:
            general?.includeTracker ?? DEFAULT_CONFIG.includeTracker,
    }
}
```

- delete `saveRequiredLevels` entirely, and reword the `saveCatchAllGroup` doc comment that currently says "likewise shared across every group set; see saveRequiredLevels" so it stands alone:

```ts
/**
 * config-catch-all holds every group set's catch-all group together, keyed
 * by set id, so saving one set's choice must read the current document
 * first to avoid erasing the others' entries.
 */
```

- [ ] **Step 4: Remove it from the hook**

In `src/hooks/useGsiConfig.tsx`: drop `saveRequiredLevels` from the import, `setRequiredLevels` from `GsiConfigContextValue`, `requiredLevels: {}` from `DEFAULT_CONFIG`, the whole `setRequiredLevels` callback, and its entry in the `useMemo` value and dependency array. The engine push effect becomes:

```ts
    useEffect(() => {
        if (!client || !isLoaded) {
            return
        }
        const engineConfig: EngineConfig = {
            includeTracker: config.includeTracker,
        }
        void client.call('setConfig', engineConfig)
    }, [client, isLoaded, config.includeTracker])
```

The long M4 comment above that effect names required levels as one of two things a future in-place panel would have to invalidate. Reword its last sentence to name only the tracker toggle; keep the warning itself, which is still true.

- [ ] **Step 5: Run the tests**

Run: `pnpm test -- src/data/datastore.test.ts src/hooks/useGsiConfig.test.tsx`
Expected: PASS, after deleting the `setRequiredLevels` tests in `useGsiConfig.test.tsx`.

- [ ] **Step 6: Commit**

```bash
git add src/data/datastore.ts src/data/datastore.test.ts src/hooks/useGsiConfig.tsx src/hooks/useGsiConfig.test.tsx
git commit -m "$(cat <<'EOF'
Stop reading and writing the required-levels document

Existing config-required-levels documents are left on the instance,
unread: deleting a user's stored data as a side effect of an upgrade is
worse than leaving orphaned keys behind.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Settings — remove the required-levels editor

**Files:**
- Modify: `src/pages/Settings/Settings.tsx:68,94,173-186,295-365`
- Test: `src/pages/Settings/Settings.test.tsx`

**Interfaces:**
- Consumes: `GsiConfigContextValue` from Task 2.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

In `src/pages/Settings/Settings.test.tsx`, delete every test covering the required-levels editor and add one that pins its absence:

```ts
// Spec 2026-09-15 §2.2: the setting is gone, not hidden. A user who had it
// configured must not find a control that silently does nothing.
it('has no required organisation unit levels control', async () => {
    renderSettings()
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument())
    expect(
        screen.queryByText('Required organisation unit levels')
    ).not.toBeInTheDocument()
})
```

Use whatever render helper the neighbouring tests in that file already use in place of `renderSettings()`.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test -- src/pages/Settings/Settings.test.tsx -t "required organisation unit levels"`
Expected: FAIL — the heading is still rendered.

- [ ] **Step 3: Remove the editor**

In `src/pages/Settings/Settings.tsx`, delete:
- `setRequiredLevels` from the `useGsiConfig()` destructuring (line 68);
- the `requiredLevelsError` state (line 94);
- the whole section from the `Required organisation unit levels` heading through the closing of its error `NoticeBox` (roughly lines 295-365).

Then check whether `levelsData` / `levels` (lines 173-186) still have a consumer in this file. If nothing else uses them, delete the `useApiDataQuery<LevelsResponse>` call, the `levels` memo, and the now-unused `LevelsResponse` type — an unused API call on every Settings load is a real cost, not just dead code. `pnpm exec eslint src` will name them if they are genuinely orphaned.

- [ ] **Step 4: Run the tests**

Run: `pnpm test -- src/pages/Settings/Settings.test.tsx`
Expected: PASS.

- [ ] **Step 5: Re-extract translations**

Run: `pnpm exec d2-app-scripts i18n extract`
Expected: `i18n/en.pot` loses the required-levels strings. Check the command's output for scanner warnings and fix any it reports.

- [ ] **Step 6: Run the full gate and commit**

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src
git add src/pages/Settings i18n
git commit -m "$(cat <<'EOF'
Remove the required organisation unit levels editor

The setting it wrote is no longer read by anything.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: ObjectsTable — a confirmed assign updates its row and says so

**Files:**
- Modify: `src/components/ObjectsTable/ObjectsTable.tsx:283-363`
- Test: `src/components/ObjectsTable/ObjectsTable.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing other tasks rely on.

**Background:** `loaded.rows` is a local snapshot appended page by page and keyed by `filterKey`. A confirmed write updates the server, the cache and the engine, but never that snapshot — so the control snaps back to its old value and no message appears. A successful write is indistinguishable from a failure, and the natural retry writes the same change again, adding a second History row for one intent.

Do **not** fix this by re-requesting the page and splicing it in: with a filter such as "only missing", the fixed row no longer matches, so the re-requested page holds different rows and position-based splicing corrupts the list. Update the one row in place instead, and leave it visible even when it no longer matches the filter — the user needs to see what they just changed.

- [ ] **Step 1: Write the failing test**

Add to `src/components/ObjectsTable/ObjectsTable.test.tsx`, following the file's existing `mockWrite` and controllable-query conventions:

```ts
it('shows the new group and a confirmation after a successful assign', async () => {
    mockWrite.mockResolvedValue({
        unaccounted: [],
        engineError: null,
        historyError: null,
    })
    // one row, currently in group 0 ("Public")
    renderWithOnePage(makeItems(1))

    fireEvent.click(await screen.findByRole('button', { name: 'Private' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }))

    await waitFor(() => expect(mockWrite).toHaveBeenCalledTimes(1))
    // The row now reads as Private, without a reload...
    await waitFor(() =>
        expect(
            screen.getByRole('button', { name: 'Private', pressed: true })
        ).toBeInTheDocument()
    )
    // ...and the user is told the write landed, so a successful write can
    // never look like a failure.
    expect(screen.getByText('Item 0 is now in Private')).toBeInTheDocument()
})
```

Replace `renderWithOnePage` and the button names with whatever this file's existing helpers and `MembershipControl` markup actually produce — read the neighbouring assign tests first and match them exactly.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test -- src/components/ObjectsTable/ObjectsTable.test.tsx -t "successful assign"`
Expected: FAIL — the control still reads `Public` and no confirmation text exists.

- [ ] **Step 3: Add the success message string**

Near the other label helpers at the top of `ObjectsTable.tsx`:

```ts
// One whole translated sentence with placeholders, never joined fragments
// -- see src/utils/interpolate.ts. No colon: the i18next-scanner reads one
// as its namespace separator and drops the key.
const assignedLabel = (name: string, group: string) =>
    interpolate(i18n.t('{name} is now in {group}'), { name, group })
```

- [ ] **Step 4: Update the row and set the message on success**

In `handleConfirm`, add a `successAlert` state alongside `failureAlert` and `infoAlert`:

```ts
    const [successAlert, setSuccessAlert] = useState<string | null>(null)
```

and inside the `try`, immediately after the `result.unaccounted.length > 0` block, add an `else` branch:

```ts
            } else {
                // The write is confirmed, and `useMembershipWrite` has
                // already told the engine. `loaded.rows` is this
                // component's own snapshot, though, and nothing re-requests
                // it -- so without this the control snaps back to its old
                // value and a successful write looks exactly like a failed
                // one.
                //
                // The new status is Status.Ok by construction rather than
                // by re-running the rule: `computeMembershipChanges` makes
                // the object the sole member of the chosen group, and
                // "exactly one group is Ok" is the one branch of
                // evaluateSet that holds for every kind of set (spec
                // 2026-09-15 §2.1).
                //
                // The row is deliberately left in the list even when it no
                // longer matches the filter (a "only missing" view, say).
                // Making it vanish at the moment of success is how the
                // user loses track of what they just did.
                setLoaded((prev) => ({
                    ...prev,
                    rows: prev.rows.map((r) =>
                        r.id === row.id
                            ? { ...r, groups: [index], status: Status.Ok }
                            : r
                    ),
                }))
                setSuccessAlert(assignedLabel(name, groupName))
            }
```

Import `Status` from `@/engine/types` if it is not already imported.

- [ ] **Step 5: Render the message**

Wherever `failureAlert` and `infoAlert` are rendered, add the success one in the same place, as a non-critical notice (match the existing markup — if they use `NoticeBox`, use `<NoticeBox valid>`; if an `AlertBar`, use `<AlertBar success>`). Clear `successAlert` at the top of `handleConfirm`, next to wherever `failureAlert` is cleared, so a second assign never shows the previous one's message.

- [ ] **Step 6: Run the tests**

Run: `pnpm test -- src/components/ObjectsTable/ObjectsTable.test.tsx`
Expected: PASS, including the existing assign tests.

- [ ] **Step 7: Re-extract translations, run the gate, commit**

```bash
pnpm exec d2-app-scripts i18n extract
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src
git add src/components/ObjectsTable i18n
git commit -m "$(cat <<'EOF'
Show a per-row assign landing, instead of snapping back

The write was confirmed and the engine updated, but the table's own row
snapshot was not, so the control reverted and a successful write looked
exactly like a failed one -- and the natural retry wrote the same change
again, adding a second History row for one intent.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: History — do not claim a group set is gone before group sets load

**Files:**
- Modify: `src/hooks/useEngine.tsx:19-26,73,125-145,201-212`
- Modify: `src/pages/History/History.tsx:125-127,533,629-690`
- Test: `src/hooks/useEngine.test.tsx`, `src/pages/History/History.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `EngineContextValue` gains `groupSetsLoaded: boolean` — false until the first load has set `groupSets`, true from then on, including when the load produced an empty array.

**Background:** `setExists` is `groupSets.some(...)`, and `groupSets` is `[]` until `loadAll` resolves. On a direct `#/history` navigation every row therefore renders "This group set no longer exists, so this change cannot be reverted from here" and a disabled Revert, then flips to a working Revert seconds later. `status.phase === 'done'` is not a safe substitute: `loadAll` emits `done` before the provider calls `setGroupSets`, so there is a render in between where the phase says loaded and the array is still empty.

- [ ] **Step 1: Write the failing test**

Add to `src/pages/History/History.test.tsx`:

```ts
// The engine has not finished loading, so nothing is known about which
// group sets exist. "No longer exists" is a claim, and it must not be made
// on the strength of an array that is empty only because it is unfilled.
it('does not claim a group set is missing while group sets are still loading', async () => {
    mockUseEngine.mockReturnValue({
        client: null,
        groupSets: [],
        groupSetsLoaded: false,
        status: null,
    })
    renderHistory([changeSetFixture({ groupSetId: 'own' })])

    await waitFor(() =>
        expect(screen.getByText('Ownership')).toBeInTheDocument()
    )
    expect(
        screen.queryByText(
            'This group set no longer exists, so this change cannot be reverted from here'
        )
    ).not.toBeInTheDocument()
})

it('claims it once group sets have loaded and it is genuinely absent', async () => {
    mockUseEngine.mockReturnValue({
        client: null,
        groupSets: [],
        groupSetsLoaded: true,
        status: null,
    })
    renderHistory([changeSetFixture({ groupSetId: 'own' })])

    expect(
        await screen.findByText(
            'This group set no longer exists, so this change cannot be reverted from here'
        )
    ).toBeInTheDocument()
})
```

Use this file's own `useEngine` mock and change-set fixture helpers in place of `mockUseEngine` / `renderHistory` / `changeSetFixture`; read the top of the file first.

- [ ] **Step 2: Run them to verify the first fails**

Run: `pnpm test -- src/pages/History/History.test.tsx -t "still loading"`
Expected: FAIL — the message is rendered.

- [ ] **Step 3: Expose `groupSetsLoaded` from the engine provider**

In `src/hooks/useEngine.tsx`: add `groupSetsLoaded: boolean` to `EngineContextValue`, add

```ts
    const [groupSetsLoaded, setGroupSetsLoaded] = useState(false)
```

next to the `groupSets` state, and set it in the same `isCurrent()` block that sets the array, so the two can never disagree:

```ts
                if (isCurrent()) {
                    setGroupSets(result.groupSets)
                    // Set together with the array itself, never derived from
                    // status.phase: loadAll emits 'done' before this line
                    // runs, so there is a render in between where the phase
                    // says loaded and the array is still empty.
                    setGroupSetsLoaded(true)
```

Add `groupSetsLoaded` to the context value object and its `useMemo` dependency array. Leave it `true` once set — a reload replaces the array, it does not make the app un-know what exists.

- [ ] **Step 4: Use it in History**

In `src/pages/History/History.tsx`, take it from both `useEngine()` call sites (lines 125 and 473) and make the existence check tri-state. At line 127:

```ts
    const set = groupSets.find((s) => s.id === changeSet.groupSetId)
    const setMissing = groupSetsLoaded && !set
```

and render this component's `missingGroupSetTooltip()` (line 321) on `setMissing` rather than on `!set`.

At line 629, the three states are named separately rather than derived from
each other — `setExists` and `setMissing` are **not** complements, because
"not loaded yet" is neither:

```ts
                            // D4: a change set whose group set no longer
                            // exists is still listed (never hidden), just
                            // without a working Revert. Until group sets
                            // have loaded, nothing is known either way --
                            // so Revert waits rather than accusing.
                            const setPresent = groupSets.some(
                                (gs) => gs.id === cs.groupSetId
                            )
                            const setExists = groupSetsLoaded && setPresent
                            const setMissing = groupSetsLoaded && !setPresent
                            // setExists === false && setMissing === false is
                            // the still-loading case, and it renders neither
                            // the note nor the tooltip.
```

Render the `missingGroupSetTooltip()` note on `setMissing` (never on
`!setExists`), render the working Revert on `setExists`, and in the remaining
case — still loading — render the Revert button `disabled` with **no** tooltip
and no note. Apply the same tri-state at line 533 (`handleRevert`'s lookup) so
a revert attempted mid-load fails loudly rather than on a lookup that was
never going to succeed.

- [ ] **Step 5: Run the tests**

Run: `pnpm test -- src/pages/History/History.test.tsx src/hooks/useEngine.test.tsx`
Expected: PASS. Existing History tests that mock `useEngine` need `groupSetsLoaded: true` added to their return value.

- [ ] **Step 6: Run the gate and commit**

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src
git add src/hooks/useEngine.tsx src/hooks/useEngine.test.tsx src/pages/History
git commit -m "$(cat <<'EOF'
Wait for group sets before saying one no longer exists

A direct #/history navigation rendered "This group set no longer exists"
on every row, on the strength of an array that was empty only because it
was unfilled. groupSetsLoaded is set together with the array itself, not
derived from the load phase, which flips to done one render earlier.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Scope `@types/node` to the need that introduced it

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml` (regenerated)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

**Background:** `@types/node` was added for the Playwright e2e suite only, and pinning it re-resolved the app-wide transitive version from 25.0.3 down to 22.20.2. Every check passes and the pin is correct for the Node in use, but it is an app-wide dependency change made to satisfy an `e2e/`-only requirement.

- [ ] **Step 1: Establish what actually needs it**

Run:

```bash
grep -rln "@types/node\|NodeJS\.\|process\.env" src e2e types | sort
```

Record which of `src/`, `e2e/` and `types/` genuinely reference Node types. This decides the task: if only `e2e/` does, the dependency moves; if `src/` does too, it stays app-wide and this task's deliverable is the written justification in Step 4 rather than a dependency move.

- [ ] **Step 2: If only e2e needs it, scope it there**

The repo is a single pnpm package, so there is no separate `e2e` package to move it to. Scope it instead by confirming `types/` and `tsconfig.json` do not pull Node types into the app build: check whether `tsconfig.json`'s `compilerOptions.types` names `node`, and if it does not, the app build already ignores it and the dependency is e2e-only in effect.

- [ ] **Step 3: Check whether the downgrade is still needed**

Run:

```bash
node --version
pnpm why @types/node
```

If the installed Node's major version is ≥ 22 and nothing requires 25.x specifically, the pin is doing its job. If the pin can be widened to `^22 || ^25` without breaking `pnpm exec tsc --noEmit`, widen it — that removes the app-wide downgrade while keeping the e2e suite working.

- [ ] **Step 4: Record the outcome**

Either way, add a short comment block to the carry-forward note explaining what was found, so this item stops being an open question. Append to `docs/superpowers/notes/2026-09-plan3-carry-forward.md`:

```markdown
## Resolved in Plan 4

- **`@types/node`**: <one paragraph — which directories actually reference
  Node types, whether `tsconfig.json` pulls them into the app build, the
  installed Node version, and what the version constraint ended up as and
  why.>
```

- [ ] **Step 5: Run the gate and commit**

```bash
pnpm install
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src
pnpm exec playwright test --list
git add package.json pnpm-lock.yaml docs/superpowers/notes/2026-09-plan3-carry-forward.md
git commit -m "$(cat <<'EOF'
Settle the @types/node constraint

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Verify the two open items against live 2.40 and 2.43

**Files:**
- Create: `docs/superpowers/notes/2026-09-plan4-version-verifications.md`

**Interfaces:**
- Consumes: nothing.
- Produces: findings other plans cite. Plan 6's SQL view work depends on the `paging=false` answer.

**Background:** Spec §9 of the original design leaves two items open, both of which the app already behaves as though it knows. Broker instances `agent-gsi-p2` (2.43.1) and `agent-gsi-p2-40` (2.40.12) exist and are stopped; start them, use them, stop them again.

- [ ] **Step 1: Start both instances**

```bash
curl -s -X POST -H "Authorization: Bearer $DHIS2_BROKER_TOKEN" \
  "$DHIS2_BROKER_URL/instances/agent-gsi-p2/start"
curl -s -X POST -H "Authorization: Bearer $DHIS2_BROKER_TOKEN" \
  "$DHIS2_BROKER_URL/instances/agent-gsi-p2-40/start"
```

Poll the returned jobs until both report done, then confirm each answers:

```bash
curl -s -u admin:district http://dhis2-agent-gsi-p2:8080/api/system/info | head -c 300
curl -s -u admin:district http://dhis2-agent-gsi-p2-40:8080/api/system/info | head -c 300
```

Use the `dhis2-instances` skill for the exact job-polling shape rather than guessing it.

- [ ] **Step 2: Install the GSI SQL views on both**

Start the app against each instance in turn and use its Settings page to create the views, which is the same path a user takes:

```bash
pnpm start --port "$SANDBOX_HOST_PORT" --proxy http://dhis2-agent-gsi-p2:8080
```

- [ ] **Step 3: Measure `paging=false` on CSV export**

For each instance, and for each installed `GSI_*` view, compare the row count returned with and without paging against the count the database actually holds:

```bash
# id comes from /api/sqlViews?filter=code:eq:GSI_ORGUNITS&fields=id
curl -s -u admin:district \
  "http://dhis2-agent-gsi-p2:8080/api/sqlViews/<id>/data.csv?paging=false" | wc -l
curl -s -u admin:district \
  "http://dhis2-agent-gsi-p2:8080/api/sqlViews/<id>/data.json?paging=false" \
  | python3 -c "import json,sys; print(len(json.load(sys.stdin)['listGrid']['rows']))"
```

The question is whether the CSV row count equals the JSON row count and the true total, or is silently capped at a default page size (commonly 50). Record the exact numbers per version, not a verdict.

- [ ] **Step 4: Measure `access.write` on group collections for a non-admin on 2.40**

On `agent-gsi-p2-40`, create a user with the group-set-editing authorities but not `ALL`, then request a group set with its groups and read whether `access.write` is present on each group:

```bash
curl -s -u <nonadmin>:<password> \
  "http://dhis2-agent-gsi-p2-40:8080/api/organisationUnitGroupSets?fields=id,name,organisationUnitGroups[id,name,access]&pageSize=1" \
  | python3 -m json.tool | head -40
```

Record whether `access` is returned at all, and whether `access.write` reflects the user's real permission. The app's `canWrite` flags on groups depend on this.

- [ ] **Step 5: Write the note**

Create `docs/superpowers/notes/2026-09-plan4-version-verifications.md` with one section per question, each holding: the exact requests made, the raw numbers or payload fragments returned, the version each came from, and a one-line answer. Where an answer is "it depends", say what it depends on. Do not write a verdict that the recorded output does not support.

- [ ] **Step 6: Stop both instances**

```bash
curl -s -X POST -H "Authorization: Bearer $DHIS2_BROKER_TOKEN" \
  "$DHIS2_BROKER_URL/instances/agent-gsi-p2/stop"
curl -s -X POST -H "Authorization: Bearer $DHIS2_BROKER_TOKEN" \
  "$DHIS2_BROKER_URL/instances/agent-gsi-p2-40/stop"
```

Both were stopped when this plan was written; leave them as found.

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/notes/2026-09-plan4-version-verifications.md
git commit -m "$(cat <<'EOF'
Measure SQL view CSV paging and group access.write on 2.40 and 2.43

Closes two of the three items left open in section 9 of the original
design.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Bring the original spec into line

**Files:**
- Modify: `docs/superpowers/specs/2026-09-10-group-set-integrity-tool-design.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: the outcomes of Tasks 1-3 and Task 7.
- Produces: nothing code depends on.

- [ ] **Step 1: Edit §3.2**

Replace the four-row rule table with the three-condition table from `2026-09-15-manual-review-1-design.md` §2.1, and delete the paragraph beginning "The third and fourth Missing rows are mutually exclusive per set" — it exists only to explain required levels.

- [ ] **Step 2: Edit §3.3**

Delete the `config/orgUnitGroupSets/<setId>` bullet and replace it with one sentence recording that documents already written under that key are ignored and never deleted, citing §2.3 of the new spec.

- [ ] **Step 3: Edit §1 and §2**

In §1's bulleted list of what the app lets a user do, delete "or declare at which org unit levels the set is required". Check §2 for any matching claim and remove it too.

- [ ] **Step 4: Edit §9**

Mark the `paging=false` and `access.write` items **Answered**, each with a one-line summary and a pointer to `docs/superpowers/notes/2026-09-plan4-version-verifications.md`. Leave the org unit name translation item open.

- [ ] **Step 5: Update CLAUDE.md**

The architecture-decisions list does not currently mention required levels, so check it rather than assuming. Add one line recording the rule as it now stands, next to the existing conflict line:

```markdown
- Membership is evaluated the same way at every org unit level: conflict is always an error, one group is Ok, and no group is an error when the set is compulsory, a warning when it is a data dimension, and allowed otherwise. The per-set "required levels" policy was removed in Plan 4.
```

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-09-10-group-set-integrity-tool-design.md CLAUDE.md
git commit -m "$(cat <<'EOF'
Update the original design for the removed required-levels policy

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Done when

- `grep -rn "requiredLevels\|RequiredLevels" src` returns nothing.
- `pnpm test`, `pnpm exec tsc --noEmit` and `pnpm exec eslint src` all pass.
- A per-row assign shows the new group and a confirmation without a reload.
- A direct `#/history` navigation never renders "This group set no longer exists" before group sets have loaded.
- `docs/superpowers/notes/2026-09-plan4-version-verifications.md` answers both open items with recorded output.
- The 2026-09-10 spec no longer describes a feature the code does not have.
