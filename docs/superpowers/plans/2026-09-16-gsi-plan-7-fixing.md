# GSI Plan 7: Fixing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a bulk fix over a national-scale population finish in a time a user will wait for, without buying that speed with server load — and make the fix flow one entry point on the table the user is already looking at, with a catch-all group they can name themselves.

**Architecture:** Measurement decides the write path, not preference. Three write shapes are timed against the same real population before any of them is adopted, and the shape that wins on elapsed time still loses if it costs more server load. The import shapes replace a group's whole membership, so adopting one is additionally gated on proving a concurrency guard works on every supported version. Everything in §5 is a presentation and metadata change on top of whatever the measurement selects.

**Tech Stack:** TypeScript, React 18, @dhis2/ui 10.17.0, @dhis2/app-runtime, TanStack Query v4, Jest + @testing-library/react, Playwright for e2e, Vite via the DHIS2 App Platform, pnpm, PostgreSQL (direct, for measurement only).

**Spec:** `docs/superpowers/specs/2026-09-15-manual-review-1-design.md` — this plan implements **§6 then §5**, in that order, because §6 is "measure, then choose" and §5 sits on top of whatever it chooses. It is the fourth and last plan in §11's list. After it lands, §10's multi-version review (2.40 through 2.43 against different databases) runs once, over all four plans' work together.

**Read before starting:** `docs/superpowers/notes/2026-09-plan5-carry-forward.md` and `docs/superpowers/notes/2026-09-plan6-carry-forward.md`. Task 1 exists because of the first of those.

## Global Constraints

- Supported DHIS2 versions: **2.40 and newer**.
- **Least server load is this project's standing tie-breaker.** It is why the app computes client-side in the first place. A shape that halves elapsed time by doubling peak server load loses. This is not a tiebreak of last resort — it decides §6.4.
- `src/engine` is pure TypeScript with typed arrays, runs in a Web Worker, imports nothing from React or DHIS2. Test it with plain Jest.
- Every user-facing string goes through a single, **argument-free** `i18n.t('…')` call. Any second argument makes the call invisible to this project's i18next-scanner, so it never reaches `i18n/en.pot`.
- **A sentence is translated whole.** Never join translated fragments around a value; put a `{name}` placeholder inside the one complete string and fill it with `interpolate()` from `src/utils/interpolate.ts`. Single braces, never `{{…}}`.
- **No colon inside an `i18n.t()` string** — the scanner reads it as a namespace separator and drops the key.
- Counts are two complete strings chosen on `count === 1`, with the number in a `{count}` placeholder.
- Data fetching goes through `useApiDataQuery` (TanStack Query v4), never `useDataQuery` directly. The write path (`src/data/writes.ts`, `src/data/metadataWrites.ts`) uses `createFetcher` directly, as it already does.
- Jest maps every `.css` import to an empty object, so a component's own CSS-module class names are `undefined` in tests. Do not assert on one without a scoped per-file mock.
- Run `pnpm exec d2-app-scripts i18n extract` after adding or changing any string; commit `i18n/en.pot` and check the output for scanner warnings.
- Gates before every commit: `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm exec eslint src`, and `pnpm exec tsc -p e2e --noEmit` when `e2e/` is touched.
- **Commit message trailer:** end every commit message with exactly `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`, character for character, whatever model does the work. Never a `Claude-Session:` or session-URL trailer.
- Broker instances are shared. Keep **one running at a time**; never reset or delete one you did not create; restore the state you found.

---

## File Structure

| File | Responsibility after this plan |
| --- | --- |
| `scripts/perf/write-shapes.js` | **New.** The §6.2 measurement driver — three shapes, three batch sizes, wall-clock + request count + sampled container stats |
| `docs/superpowers/notes/2026-09-plan7-write-shapes.md` | **New.** The measurements, and the reasoning from them to §6.4 |
| `docs/superpowers/notes/2026-09-plan7-lastupdated-guard.md` | **New.** Whether a group's `lastUpdated` moves on a membership change, per version |
| `docs/superpowers/notes/2026-09-plan7-e2e-write-flows.md` | **New.** What the three failing write/revert flows turn out to be |
| `src/data/writes.ts` | Keeps `writeMemberships` (the batched path); may gain the measured batch size and, only if §6.4 selects it, an import-shaped sibling |
| `src/data/metadataWrites.ts` | `createCatchAllGroup` takes caller-supplied names and refuses a name owned by another set |
| `src/components/BulkFixDialog/BulkFixDialog.tsx` | The create-catch-all step gains editable name and short name fields |
| `src/pages/GroupSetDetail/GroupSetDetail.tsx` | Loses the header `Fix issues…` button and `VIOLATION_STATUSES` |
| `e2e/flows.spec.ts` | Its bulk flow drives the relocated entry point |

**Dependency order:** Task 1 → Task 2 (you cannot attribute a new write-path failure while three write flows already fail for an unknown cause). Task 2 and Task 3 are independent of each other and both feed Task 4. Task 4 → Task 5. Tasks 6 and 7 are independent of Tasks 1–5 and of each other. Task 8 needs Task 6.

---

### Task 1: Establish what the three failing e2e write/revert flows actually are

**Files:**
- Create: `docs/superpowers/notes/2026-09-plan7-e2e-write-flows.md`
- Modify: `docs/superpowers/notes/2026-09-plan5-carry-forward.md` (§1, to record the answer)

**Interfaces:**
- Consumes: nothing.
- Produces: a documented answer that Tasks 2 and 5 depend on for attribution. No code.

**Why this is first, and why it is in this plan at all.** `docs/superpowers/notes/2026-09-plan5-carry-forward.md` §1 records that `single assign`, `bulk move` and `revert` fail on 2.43.1, and `bulk move` also on 2.40.12, for a cause nobody established. Every one of them is a **write/revert** flow, and this plan changes the write path. Changing it while those fail means no one can tell a regression from the standing fault — the suite stops being evidence exactly when this plan needs it most. The carry-forward note's own step one is a re-run at a commit before Plan 4; that is cheap and settles the biggest unknown.

The observation, restated from the note so it is not re-derived: after a real, successful server write (confirmed via direct read-only API calls — the membership change always lands), opening History's Revert dialog leaves its own Revert button disabled for 5–15 seconds with **zero** further `/api/*` requests in that window, and it self-resolves on its own some of the time. `planRevert` is a Web Worker call, not HTTP, which is why no traffic appears. The client/worker protocol is a FIFO where every message either resolves or rejects, so a never-settling promise would need a non-terminating loop — and a non-terminating loop does not self-resolve in 5–15 seconds repeatedly.

Two candidate explanations, neither confirmed: **worker-queue contention** (something ahead of `planRevert` in the single-threaded worker's queue takes that long) or **main-thread contention** (the response arrives promptly, its handler is delayed). They want opposite fixes. Either way the user gets no feedback distinguishing "still working" from "stuck", which is a defect on its own.

- [ ] **Step 1: Reproduce at the current HEAD, and record the baseline**

Start `agent-gsi-p2` (2.43.1) and no other instance. Build and install the app (`pnpm build`, then `POST /api/apps` with `build/bundle/*.zip` as `local_admin`/`district`). Run the three flows:

```bash
pnpm exec playwright test --config e2e/playwright.config.ts --project 2.43.1 \
  -g "single assign|bulk move|revert"
```

Record: which fail, how they fail (the assertion and its timeout), and how long the Revert button stays disabled.

- [ ] **Step 2: Re-run the same three flows at a commit before Plan 4**

This is the question the carry-forward note names as unanswered: "very likely not Plan 4's or Plan 5's fault" is not "proven pre-existing".

```bash
git log --oneline --before=2026-09-15 -5     # find the last pre-Plan-4 commit
git stash list                                # confirm nothing is in flight
git worktree add /tmp/gsi-prePlan4 <that-sha>
```

Work in that worktree: `pnpm install --force` if `node_modules` needs it (see CLAUDE.md on host-mounted `node_modules` and platform binaries), `pnpm build`, install that build on the instance, run the same three flows, then **reinstall the current build** so the instance is not left on an old app. Remove the worktree when done.

Expected outcomes and what each means:
- **They fail there too** → pre-existing, and Plan 4/5/6 are exonerated. Record it and stop investigating; Task 5 then only has to avoid making it worse.
- **They pass there** → something between that commit and HEAD introduced it, and a bisect over the ~40 commits is warranted before this plan touches the write path.

- [ ] **Step 3: Distinguish worker-queue from main-thread contention**

Only if step 2 leaves the cause open. Both are observable without changing behaviour:

```js
// In the page, before opening the Revert dialog:
performance.mark('planRevert:start')
// The worker's own message handler timestamp vs. the client's resolve
// timestamp is the discriminator: a large gap before the worker receives
// the message is queue contention; a large gap between the worker posting
// its reply and the client's .then() running is main-thread contention.
```

Add temporary instrumentation to `src/engine/client.ts` and `src/engine/worker.ts` logging `performance.now()` at four points — client send, worker receive, worker reply, client resolve — run one failing flow with the browser console captured, and record the four intervals. **Revert the instrumentation before committing**; the note carries the numbers.

- [ ] **Step 4: Write the note and update the carry-forward**

Create `docs/superpowers/notes/2026-09-plan7-e2e-write-flows.md` with the baseline, the pre-Plan-4 comparison, and (if step 3 ran) the four intervals. State plainly which of the two explanations the evidence supports, or that it supports neither.

Then rewrite `2026-09-plan5-carry-forward.md` §1 to record the answer rather than the open question, keeping the original observation for provenance.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/notes/
git commit -m "Establish what the failing e2e write/revert flows are"
```

---

### Task 2: Measure the three write shapes

**Files:**
- Create: `scripts/perf/write-shapes.js`
- Create: `docs/superpowers/notes/2026-09-plan7-write-shapes.md`

**Interfaces:**
- Consumes: Task 1's conclusion, for attributing anything odd during the runs.
- Produces: the measurements Task 4 decides on. No app code changes.

**The problem, from §6.1.** A bulk apply over the EMIS population (77,017 objects) extrapolates to 8–12 minutes as 79 sequential collection updates at 6–9 seconds each, against a stated budget of roughly 60 seconds. The dominant cost is DHIS2 re-evaluating the whole collection on every write, not app code — which is why app-side micro-optimisation is not on the list of shapes.

**The instance.** `agent-gsi-emis` (2.41, 266,396 organisation units, 1.1M memberships), the same instance Plan 3 measured on. Start it and run nothing else concurrently — `docs/superpowers/notes/2026-09-plan3-performance.md` records a seed restore on one instance stretching an 11-minute analytics run to ~25 minutes on another.

**Follow `scripts/perf/emis-run.js`'s conventions**: env-overridable `GSI_PERF_BASE_URL` / `GSI_PERF_USERNAME` / `GSI_PERF_PASSWORD`, no hardcoded browser paths, and a header comment saying a future run should be a re-run rather than a re-implementation.

- [ ] **Step 1: Write the measurement driver**

Create `scripts/perf/write-shapes.js`. It needs no browser — these are API calls, not UI — so it is plain Node with `fetch`, unlike `emis-run.js`.

```js
// Write-shape measurement for spec §6.2. Three shapes against one target
// group on the EMIS instance, each run from the same starting state, with
// server-side cost sampled throughout. Kept in the repository so a future
// run is a re-run, not a re-implementation.
//
// Usage: node scripts/perf/write-shapes.js <groupId> <shape> [batchSize]
//   shape: batched | import | import-async
//
// Overridable: GSI_PERF_BASE_URL, GSI_PERF_USERNAME, GSI_PERF_PASSWORD
'use strict'

const BASE_URL =
    process.env.GSI_PERF_BASE_URL || 'http://dhis2-agent-gsi-emis:8080'
const CREDS = {
    username: process.env.GSI_PERF_USERNAME || 'local_admin',
    password: process.env.GSI_PERF_PASSWORD || 'district',
}
const AUTH =
    'Basic ' +
    Buffer.from(`${CREDS.username}:${CREDS.password}`).toString('base64')

let requestCount = 0

async function api(path, init) {
    requestCount += 1
    return fetch(`${BASE_URL}/api/${path}`, {
        ...init,
        headers: {
            Authorization: AUTH,
            'Content-Type': 'application/json',
            ...(init && init.headers),
        },
    })
}

/** Shape 1: today's path — sequential collection updates, `size` ids each. */
async function batched(groupId, memberIds, size) {
    for (let i = 0; i < memberIds.length; i += size) {
        const slice = memberIds.slice(i, i + size)
        const response = await api(
            `organisationUnitGroups/${groupId}/organisationUnits`,
            {
                method: 'POST',
                body: JSON.stringify({
                    additions: slice.map((id) => ({ id })),
                    deletions: [],
                }),
            }
        )
        if (!response.ok) {
            throw new Error(`batch at ${i} failed: HTTP ${response.status}`)
        }
    }
}

/** Shape 2: one metadata import carrying the group's complete member list. */
async function metadataImport(groupId, memberIds, group) {
    const response = await api('metadata?importStrategy=UPDATE', {
        method: 'POST',
        body: JSON.stringify({
            organisationUnitGroups: [
                {
                    ...group,
                    organisationUnits: memberIds.map((id) => ({ id })),
                },
            ],
        }),
    })
    if (!response.ok) {
        throw new Error(`import failed: HTTP ${response.status}`)
    }
    return response.json()
}

/** Shape 3: shape 2 with async=true, then poll the job to completion. */
async function metadataImportAsync(groupId, memberIds, group) {
    const response = await api('metadata?importStrategy=UPDATE&async=true', {
        method: 'POST',
        body: JSON.stringify({
            organisationUnitGroups: [
                {
                    ...group,
                    organisationUnits: memberIds.map((id) => ({ id })),
                },
            ],
        }),
    })
    if (!response.ok) {
        throw new Error(`async import failed: HTTP ${response.status}`)
    }
    const { response: job } = await response.json()
    // Poll the job's own notification endpoint until it reports completion.
    // Record the polling requests in requestCount too -- they are real load.
    for (;;) {
        await new Promise((r) => setTimeout(r, 1000))
        const poll = await api(
            `system/tasks/METADATA_IMPORT/${job.id}`,
            undefined
        )
        const notifications = await poll.json()
        if (notifications.some((n) => n.completed)) {
            return notifications
        }
    }
}
```

Plus a `main()` that reads the group's current members, runs the requested shape, and prints `{ shape, batchSize, seconds, requestCount }` as JSON.

- [ ] **Step 2: Sample server-side cost alongside each run**

§6.2 requires server-side cost, not just elapsed time, and it is what decides a close race. From a second shell, for the duration of each run:

```bash
docker stats --no-stream --format \
  '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' \
  agent-gsi-emis-tomcat-1 agent-gsi-emis-db-1
```

Sample every 2 seconds into a file per run. Record peak and mean CPU for both containers.

- [ ] **Step 3: Run the matrix, from the same starting state each time**

Seven runs: `batched` at 250, 1000 and 5000; `import`; `import-async`. Plus a repeat of the best and the worst, to show the spread is not noise.

Each run must start from the same membership state. Capture the target group's member list once, and restore it between runs (a `metadata` import of the original list is the fastest restore — note in the write-up that the restore itself uses one of the shapes under test, so it is not neutral, and say which).

Record for each: wall-clock seconds, request count, peak and mean CPU for both containers.

- [ ] **Step 4: Write the note**

Create `docs/superpowers/notes/2026-09-plan7-write-shapes.md`: the instance and its version, the target group and population size, the seven runs in a table, the restore method and its caveat, and — separately from the numbers — what they mean against the ~60-second budget **and** against the least-server-load rule. Do not draw the §6.4 conclusion here; Task 4 does that, with Task 3's answer in hand.

If any shape is rejected by the server outright (a payload size limit, a timeout at the proxy), that is a finding of equal weight to a timing — record it plainly.

- [ ] **Step 5: Stop the instance and commit**

```bash
git add scripts/perf/write-shapes.js docs/superpowers/notes/2026-09-plan7-write-shapes.md
git commit -m "Measure three bulk write shapes against the EMIS population"
```

---

### Task 3: Prove the `lastUpdated` guard, per version

**Files:**
- Create: `docs/superpowers/notes/2026-09-plan7-lastupdated-guard.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a per-version yes/no that Task 4 treats as a veto. No app code changes.

**Why this gates the import shapes (§6.3).** Shapes 2 and 3 replace a group's whole membership rather than adding to it, so they silently discard a concurrent editor's change in a way the batched endpoint does not. The app already holds the complete membership, and its cache validation already keys on each group's `lastUpdated`, so the guard is a re-check of `lastUpdated` immediately before the write, aborting if it moved.

But `docs/superpowers/notes/2026-09-plan2-write-compatibility.md` records that **2.40 bumps a group's `lastUpdated` when members change and 2.43 does not**. A guard that cannot see the change it exists to detect is not a guard. **Where it cannot be proven, the batched endpoint stays the write path on that version whatever the timings say.**

- [ ] **Step 1: Run the same probe on each supported version**

One instance at a time. 2.40 and 2.43 have existing instances (`agent-gsi-p2-40`, `agent-gsi-p2`); create Sierra Leone instances for 2.41 and 2.42 as Plan 6's Task 1 did, and delete them afterwards.

For each, as `local_admin`/`district`:

```bash
G=<an org unit group id on that instance>
BASE=http://dhis2-<instance>:8080

# 1. Read lastUpdated before
curl -s -u local_admin:district "$BASE/api/organisationUnitGroups/$G?fields=id,lastUpdated"

# 2. Add one member through the collection endpoint (the batched path)
curl -s -u local_admin:district -X POST -H 'Content-Type: application/json' \
  -d '{"additions":[{"id":"<an org unit id not currently a member>"}],"deletions":[]}' \
  "$BASE/api/organisationUnitGroups/$G/organisationUnits"

# 3. Read lastUpdated after
curl -s -u local_admin:district "$BASE/api/organisationUnitGroups/$G?fields=id,lastUpdated"

# 4. Remove it again, and re-read once more
```

Then repeat steps 2–4 using a **metadata import** rather than the collection endpoint, because that is the shape whose guard this is: a version might bump `lastUpdated` for one and not the other, and it is the import's own behaviour that decides whether the guard protects the import.

- [ ] **Step 2: Check the fallback signal where `lastUpdated` does not move**

Where `lastUpdated` is unchanged, the guard needs something else or the version is disqualified. Check, on that version, whether either of these moves:

```bash
# the group set's lastUpdated, rather than the group's
curl -s -u local_admin:district "$BASE/api/organisationUnitGroupSets/<setId>?fields=id,lastUpdated"
# the member count, which the app already knows
curl -s -u local_admin:district "$BASE/api/organisationUnitGroups/$G?fields=id,organisationUnits~size"
```

A member count is a weaker guard than a timestamp — it cannot see a swap that adds one member and removes another — so record it as "weaker, and why" rather than as an equivalent.

- [ ] **Step 3: Write the note**

Create `docs/superpowers/notes/2026-09-plan7-lastupdated-guard.md`: a table of version × (collection write, import write) × (group `lastUpdated` moved, set `lastUpdated` moved, `~size` moved), each cell a measured value with the two timestamps quoted, not a summary. Then a plain statement per version: **can the guard be built here, yes or no.**

- [ ] **Step 4: Restore instances and commit**

```bash
git add docs/superpowers/notes/2026-09-plan7-lastupdated-guard.md
git commit -m "Measure whether a group's lastUpdated moves on a membership change, 2.40 to 2.43"
```

---

### Task 4: Decide §6.4 and record it

**Files:**
- Modify: `docs/superpowers/specs/2026-09-15-manual-review-1-design.md` §6.4
- Modify: `docs/superpowers/notes/2026-09-plan7-write-shapes.md` (the conclusion section)

**Interfaces:**
- Consumes: Tasks 2 and 3's notes.
- Produces: the decision Task 5 implements. No app code changes.

**The decision procedure, in order.** Apply these as written — the point of separating this task from Task 2 is that the decision is made against stated rules, not against whichever number looks best.

1. **Any shape whose guard cannot be built on a version is disqualified on that version** (§6.3), regardless of its timings. If it is disqualified on every supported version, it is out entirely.
2. Among what survives, **a shape that halves elapsed time by doubling peak server load loses** (§6.2). Compare peak and mean CPU for both containers, not just elapsed time.
3. If the batched endpoint at some batch size meets the ~60-second budget, **adopt it** — it needs no guard, no new code path and no per-version branching, and the simplest thing that meets the budget wins.
4. If nothing meets the budget, say so plainly and pick the best available, recording what the realistic expectation now is. A bulk fix that takes four minutes and says so honestly is a better outcome than one that claims sixty seconds.

- [ ] **Step 1: Write the conclusion into the note**

Add a "Conclusion" section to `docs/superpowers/notes/2026-09-plan7-write-shapes.md` walking the four rules above against the measured numbers, naming the winner and — as importantly — why each loser lost.

- [ ] **Step 2: Fill in §6.4**

Replace §6.4's "To be filled in from the measurement, before the write path changes." with the outcome: the chosen shape, the batch size if applicable, the per-version position if it differs, and a one-line pointer to the note. Keep it short; the note carries the evidence.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-15-manual-review-1-design.md \
        docs/superpowers/notes/2026-09-plan7-write-shapes.md
git commit -m "Record the chosen bulk write shape in spec 6.4"
```

---

### Task 5: Implement the chosen write path

**Files:**
- Modify: `src/data/writes.ts`
- Test: `src/data/writes.test.ts`

**Interfaces:**
- Consumes: Task 4's decision; `GroupChange` from `@/engine/changeSet`; `Fetcher` from `@/data/sources/DataSource`.
- Produces: `writeMemberships` keeps its exact current signature and `WriteResult` shape, whatever shape is chosen underneath. `useMembershipWrite`, `BulkFixDialog` and `ChangeSetPreview` all read `WriteResult`, and none of them should need to change.

**This task has three branches. Task 4 decides which one you are in.** All three are specified; implement exactly one and record in your report which and why.

#### Branch A — the batched endpoint wins (rules 2 or 3)

The smallest possible change: `writeMemberships`'s `batchSize` default moves from `1000` to the measured optimum.

- [ ] **A1: Write the failing test**

In `src/data/writes.test.ts`:

```ts
it('defaults to the batch size measured fastest in Plan 7', async () => {
    const calls: unknown[] = []
    const fetcher = jest.fn(async (_path: string, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)))
        return {
            ok: true,
            status: 200,
            json: async () => ({ response: { stats: { updated: 1 } } }),
        } as unknown as Response
    }) as unknown as Fetcher
    // 1 more than one batch's worth, so the split is observable
    const additions = Array.from({ length: MEASURED_BATCH_SIZE + 1 }, (_, i) => `ou${i}`)
    await writeMemberships(fetcher, 'organisationUnit', [
        { groupId: 'g1', additions, deletions: [] },
    ], () => undefined)
    expect(calls).toHaveLength(2)
})
```

- [ ] **A2: Change the default, run the test, commit.** Add a comment on the parameter naming the measurement and the note, so the number is not mistaken for a guess.

#### Branch B — an import shape wins on every supported version

- [ ] **B1: Write the failing tests** for a new `writeMembershipsByImport(fetcher, objectType, changes, currentMembers, onProgress)`:
  - it re-reads each group's `lastUpdated` immediately before writing and **aborts that group** if it differs from the value the caller captured, reporting it in `unaccounted` with a distinguishable `error`;
  - it sends the group's **complete** intended member list, not a delta;
  - a group whose guard trips does not stop the other groups;
  - the returned `WriteResult` has the same shape `writeMemberships` returns, so callers cannot tell which path ran.

- [ ] **B2: Implement it**, then make `writeMemberships` delegate. The public signature does not change. The guard is not optional and has no bypass flag — an import that skips it is the silent-data-loss bug §6.3 exists to prevent.

- [ ] **B3: Add the `lastUpdated` capture to the caller.** `useMembershipWrite` must pass the values the engine's cache already holds; if it does not hold them at write time, read them once before the write rather than trusting a stale snapshot.

- [ ] **B4: Commit,** citing the note.

#### Branch C — an import shape wins on some versions only

As Branch B, plus a selector: `writeMemberships` picks the import path when the server's version is one the guard was proven on (Task 3's note names them), and the batched path otherwise.

- [ ] **C1: Write the failing test** that the selector picks the batched path on a version the guard was not proven on, and the import path where it was. Get the version from `useConfig()`'s `systemInfo` or `/api/system/info`, and pass it in as a parameter rather than reading it inside `writes.ts` — that module takes no app-runtime dependency today and should not gain one.

- [ ] **C2–C4:** as B2–B4, with the selector covered by tests on both sides of the boundary.

---

### Task 6: One fix entry point, on the filtered table

**Files:**
- Modify: `src/pages/GroupSetDetail/GroupSetDetail.tsx`
- Test: `src/pages/GroupSetDetail/GroupSetDetail.test.tsx`

**Interfaces:**
- Consumes: `ObjectsTab`'s existing `onBulkFix: () => void` prop, unchanged.
- Produces: nothing new. This task only removes.

**What changes (§5.1).** `Fix issues…` leaves the page header. The Objects tab's own fix button becomes the primary action there and the only way in. It already acts on the tab's current filter; what goes away is the coarse header shortcut — "move all with conflicts or missing assignment" with no way to narrow it.

Nothing becomes unreachable: opening the dialog with no filter set still means every violation. What the user gains is that they always see which rows they are about to change, and the count, first. `BulkFixDialog` already shows `plan.affected` before applying; that stays.

- [ ] **Step 1: Write the failing tests**

In `src/pages/GroupSetDetail/GroupSetDetail.test.tsx`:

```tsx
it('offers no fix action in the page header', async () => {
    renderDetail()
    expect(await screen.findByText('Overview')).toBeInTheDocument()
    expect(
        screen.queryByRole('button', { name: 'Fix issues…' })
    ).not.toBeInTheDocument()
})

it('opens the bulk fix dialog from the Objects tab, against that tab\'s filter', async () => {
    renderDetail()
    fireEvent.click(await screen.findByText('Objects'))
    fireEvent.click(await screen.findByRole('button', { name: /Fix/ }))
    expect(await screen.findByText('mock-bulk-fix-dialog')).toBeInTheDocument()
})
```

The second is the one that matters — deleting a button is easy to do while also breaking the path that replaces it. This file already mocks `BulkFixDialog`; reuse that mock.

- [ ] **Step 2: Run them, and watch the first fail**

Run: `pnpm test -- GroupSetDetail`
Expected: the first FAILS (the header button is still there), the second PASSES already.

- [ ] **Step 3: Remove the header button**

In `GroupSetDetail.tsx`, delete the `Fix issues…` `Button` from `styles.actions`, and delete the now-unused `VIOLATION_STATUSES` constant with its doc comment. `bulkFixFilter` stays — `ObjectsTab`'s `onBulkFix` is now its only setter, which is the point.

Check whether `Status` is still used in that file after the constant goes; if not, drop the import.

- [ ] **Step 4: Run the tests, extract strings, run the gates, commit**

`Fix issues…` may now be unused; `i18n extract` will drop it from `en.pot`, which is correct — commit that.

```bash
pnpm exec d2-app-scripts i18n extract
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src
git add src/pages/GroupSetDetail i18n/en.pot
git commit -m "Make the Objects tab the one way into the bulk fix"
```

---

### Task 7: Naming the catch-all group

**Files:**
- Modify: `src/data/metadataWrites.ts`, `src/components/BulkFixDialog/BulkFixDialog.tsx`
- Test: `src/data/metadataWrites.test.ts`, `src/components/BulkFixDialog/BulkFixDialog.test.tsx`

**Interfaces:**
- Consumes: `GroupSetMeta` from `@/engine/types`.
- Produces:
  - `createCatchAllGroup(fetcher, set, names?: { displayName: string; shortName: string })` — names default to today's generated pair when omitted, so every existing caller and test keeps working.
  - `generateCatchAllNames(set: GroupSetMeta): { displayName: string; shortName: string }` — **extracted** from today's inline logic and exported, because the dialog must prefill the fields with exactly what the server would otherwise generate.
  - `NAME_OWNED_BY_ANOTHER_SET` — a sentinel `error` value, like `writes.ts`'s `UNPARSEABLE_RESPONSE`, that the dialog translates before display. This module has no `i18n.t` and must not gain one.

**A hazard this task creates, which does not exist today.** `findExistingGroupId` looks a group up by name **globally** and reuses whatever it finds, then adds it to this set. That is safe while the name is generated — it embeds the set's own name — and it exists for a good reason: the create step is not idempotent, so a retry after a failed add-to-set must find the group the previous attempt made rather than 409 forever.

The moment the name is user-editable, the same code silently pulls another set's group into this set. A user typing `Other` on two different sets gets **one shared group in both** — precisely what §5.2 forbids ("one shared 'Other' group must never be reused across several group sets"). So the lookup must learn the difference between the three cases:

| Existing group with this name | Meaning | Behaviour |
| --- | --- | --- |
| belongs to no group set | the retry case this lookup was written for | reuse it |
| belongs to **this** set | already done | reuse it |
| belongs to **another** set | the hazard | **refuse**, with `NAME_OWNED_BY_ANOTHER_SET` |

- [ ] **Step 1: Write the failing tests for the data layer**

In `src/data/metadataWrites.test.ts`:

```ts
describe('createCatchAllGroup', () => {
    it('uses caller-supplied names when given them', async () => {
        const bodies: Record<string, unknown>[] = []
        const fetcher = makeFetcher({ existing: [], capture: bodies })
        await createCatchAllGroup(fetcher, setFixture(), {
            displayName: 'Unclassified facilities',
            shortName: 'Unclassified',
        })
        expect(bodies[0]).toMatchObject({
            name: 'Unclassified facilities',
            shortName: 'Unclassified',
        })
    })

    it('falls back to the generated names when none are given', async () => {
        const bodies: Record<string, unknown>[] = []
        const fetcher = makeFetcher({ existing: [], capture: bodies })
        await createCatchAllGroup(fetcher, setFixture())
        expect(bodies[0]).toMatchObject({
            name: 'Other/unknown Facility type',
        })
    })

    it('reuses a same-named group that belongs to no set (the retry case)', async () => {
        const fetcher = makeFetcher({
            existing: [{ id: 'g9', groupSets: [] }],
        })
        await expect(
            createCatchAllGroup(fetcher, setFixture())
        ).resolves.toMatchObject({ id: 'g9' })
    })

    it('reuses a same-named group that already belongs to this set', async () => {
        const fetcher = makeFetcher({
            existing: [{ id: 'g9', groupSets: [{ id: 'set1' }] }],
        })
        await expect(
            createCatchAllGroup(fetcher, setFixture())
        ).resolves.toMatchObject({ id: 'g9' })
    })

    it('refuses a name owned by a group in a different set', async () => {
        const fetcher = makeFetcher({
            existing: [{ id: 'g9', groupSets: [{ id: 'someOtherSet' }] }],
        })
        await expect(
            createCatchAllGroup(fetcher, setFixture(), {
                displayName: 'Other',
                shortName: 'Other',
            })
        ).rejects.toThrow(NAME_OWNED_BY_ANOTHER_SET)
    })
})

describe('generateCatchAllNames', () => {
    it('produces the name the dialog prefills', () => {
        expect(generateCatchAllNames(setFixture())).toEqual({
            displayName: 'Other/unknown Facility type',
            shortName: 'Other/unknown Facility type',
        })
    })

    it('reserves the tail for the set id when the name is too long', () => {
        const long = setFixture({ displayName: 'x'.repeat(60), id: 'abcdefghijk' })
        const { shortName } = generateCatchAllNames(long)
        expect(shortName).toHaveLength(50)
        expect(shortName.endsWith(' abcdefghijk')).toBe(true)
    })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test -- metadataWrites`
Expected: FAIL — `generateCatchAllNames` is not exported and the third argument does not exist.

- [ ] **Step 3: Implement the data layer**

Extract `generateCatchAllNames` from `createCatchAllGroup`'s body verbatim (the `MAX_SHORT_NAME_LENGTH` logic and its doc comment move with it — that comment explains a real server constraint and must not be lost). Widen `findExistingGroupId` to request `fields=id,groupSets[id]` and return the group with its sets, and add the three-case decision above. Export the sentinel:

```ts
/**
 * Sentinel `error`, like writes.ts's UNPARSEABLE_RESPONSE: a name the user
 * typed is already held by a group belonging to a *different* group set, and
 * reusing it would quietly put one group in two sets -- which spec 5.2
 * forbids outright. Not English prose, because this module has no i18n.t and
 * is not where a user-facing sentence should be built.
 */
export const NAME_OWNED_BY_ANOTHER_SET = 'name-owned-by-another-set'
```

- [ ] **Step 4: Write the failing tests for the dialog**

In `src/components/BulkFixDialog/BulkFixDialog.test.tsx`: the create-catch-all step shows a name and a short name field prefilled from `generateCatchAllNames`; editing them passes the edited values through; a short name over 50 characters is rejected before any request is made; and `NAME_OWNED_BY_ANOTHER_SET` renders as a translated sentence naming the conflict rather than as the raw token.

- [ ] **Step 5: Implement the dialog fields**

Two `InputField`s in the create-catch-all step, prefilled from `generateCatchAllNames(set)` and re-prefilled if the set changes. Validate before calling: both non-empty, short name ≤ 50 characters. Translate the sentinel:

```tsx
const nameConflictMessage = i18n.t(
    'A group with this name already belongs to a different group set. Choose another name — one group must not be shared between two sets.'
)
```

- [ ] **Step 6: Run the tests, extract strings, run the gates, commit**

```bash
pnpm exec d2-app-scripts i18n extract
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src
git add src/data/metadataWrites.ts src/data/metadataWrites.test.ts \
        src/components/BulkFixDialog i18n/en.pot
git commit -m "Let the user name the catch-all group, and refuse another set's name"
```

---

### Task 8: End-to-end coverage for the relocated entry point

**Files:**
- Modify: `e2e/flows.spec.ts`

**Interfaces:**
- Consumes: `authedApp` from `e2e/fixtures/session.ts`. Note `authedApp.root()` **re-resolves the app root and must be called again after every navigation** — on 2.43 the app runs inside the Global App Shell's iframe, which the shell recreates on some route changes.
- Produces: nothing other tasks import.

**Why this is a modification, not a new flow.** §10 names "the relocated fix entry point" as the e2e coverage this plan owes. The existing `bulk move` flow already drives the bulk fix; after Task 6 it must reach it from the Objects tab instead of the header. Updating that flow is the coverage — a second flow that opens the same dialog a different way would be duplication.

**Before you start**, read `docs/superpowers/notes/2026-09-plan7-e2e-write-flows.md` (Task 1). `bulk move` is one of the flows that was failing; whether it passes now depends on what Task 1 found. Do not spend this task re-investigating that — if it still fails for the established reason, say so and assert only what the relocation changes.

- [ ] **Step 1: Update the flow's entry point**

Change the `bulk move` flow so it opens the dialog from the Objects tab's button, and add an assertion that the page header offers no fix action — the regression guard for Task 6, at the level where it is user-visible.

- [ ] **Step 2: Run it against both projects, one instance at a time**

```bash
pnpm exec playwright test --config e2e/playwright.config.ts --project 2.43.1 -g "bulk move"
# then stop that instance, start the other
pnpm exec playwright test --config e2e/playwright.config.ts --project 2.40.12 -g "bulk move"
```

Rebuild and reinstall the app first (`pnpm build`, `POST /api/apps`) — the installed zip will not have Tasks 5–7 in it otherwise.

- [ ] **Step 3: Restore the instances, run `tsc -p e2e --noEmit`, and commit**

```bash
git add e2e/flows.spec.ts
git commit -m "Drive the bulk fix from the Objects tab in the e2e suite"
```

---

## What this plan deliberately does not do

- **It does not add a suite-wide `afterEach` to the e2e suite.** `2026-09-plan5-carry-forward.md` §2 records why that is its own design question, and Plan 6 closed only its own flow's cleanup.
- **It does not fix the items in `2026-09-plan6-carry-forward.md`** unless Task 5 happens to touch them. They stay carried forward.
- **It does not change what the engine computes.** §5 and §6 are a write path, an entry point and a metadata name.
- **It does not run §10's multi-version review.** That runs once, after this plan lands, over all four plans' work together.

## Self-review

- **§5.1** (one entry point) — Task 6, with the e2e guard in Task 8.
- **§5.2** (naming the catch-all) — Task 7, including the cross-set refusal §5.2 requires and the hazard that editing the name creates.
- **§6.1** (the problem) — motivates Task 2; no task of its own.
- **§6.2** (measurement before choice) — Task 2, with the least-server-load rule carried into Task 4's decision procedure rather than left as a sentiment.
- **§6.3** (the correctness constraint) — Task 3, wired into Task 4 as a veto and into Task 5's Branches B and C as a non-optional guard.
- **§6.4** (outcome) — Task 4 writes it; Task 5 implements it.
- **Carried-forward item** (`2026-09-plan5-carry-forward.md` §1) — Task 1, because this plan cannot use the write flows as evidence until it is settled.
