# Carried forward from Plans 4 and 5: found, recorded, not fixed

Plan 4 (correctness and simplification) and Plan 5 (navigation and layout)
are complete. These items were found during them, confirmed, and
deliberately left — each is either outside the plan that found it or needs
its own investigation. A future plan should pick them up in this order.

## 1. Three e2e write/revert flows fail, and the cause is not established

`single assign`, `bulk move` and `revert` fail on 2.43.1; `bulk move` fails
on 2.40.12. Reproduced consistently across 3+ isolated re-runs, not a
one-off.

**The observation**, stated carefully because the framing decides the fix:
after a real, successful server write (confirmed via direct read-only API
calls — the membership change always lands), opening History's Revert
dialog leaves its own Revert button disabled for 5-15 seconds, with **zero**
further `/api/*` requests in that window, and it self-resolves on its own
some of the time.

`planRevert` is a Web Worker call (`client.call('planRevert', …)`), not
HTTP, which is why no network traffic appears. The client/worker protocol
is a FIFO in which every message either resolves or rejects (`failAll` on
`onerror`/`onmessageerror`), so a promise that never settles would require a
non-terminating loop — and a non-terminating loop does not self-resolve in
5-15 seconds, repeatedly, across independent runs.

**Two candidate explanations, neither confirmed:**

- worker-queue contention — something ahead of `planRevert` in the
  single-threaded worker's queue is taking that long;
- main-thread contention — the response arrives promptly but its handler is
  delayed.

They need different fixes. Queue contention wants the heavy work moved off
the critical path; main-thread contention wants the opposite. **Either way
the user gets no feedback distinguishing "still working" from "stuck"**,
which is a defect in its own right regardless of which is happening.

**What is ruled out.** Plan 5 changes no engine, data-layer or hook code at
all — `git diff --stat 36325b4..9ef557a -- src/engine src/data src/hooks` is
empty, and its sole `ObjectsTable.tsx` edit is one `data-test` attribute.
Plan 4's two candidates were checked too: `evaluateSet`'s simplification
*removed* a branch and two parameters from a bounded loop, and
`ObjectsTable`'s per-row patch runs inside an already-resolved `.then()`
touching only its own component state, so it cannot block a different
component's pending worker call. `applyChangeSet` re-evaluates only the
touched sets, and Plan 5's integrity button is pure HTTP.

**What is not ruled out.** Nobody re-ran the suite at a commit before Plan 4.
The honest status is "very likely not Plan 4's or Plan 5's fault", not
"proven pre-existing". Establishing that is step one.

## 2. The e2e suite has no cleanup net

`e2e/flows.spec.ts` and `e2e/fixtures/session.ts` have no `afterEach` or
`afterAll`. Every write-then-revert test reverts only as its own last step,
so a test failing between the write and the revert leaves a **shared broker
instance** dirty for whoever runs next. Pre-existing; Plan 5's two added
flows are read-only and add no new exposure.

Not fixed because adding structural cleanup to a suite that writes to shared
instances is its own design question — what to revert, how to know what this
run wrote, and what to do when cleanup itself fails.

## 3. A data anomaly on `agent-gsi-p2-40`

That instance's "Northern Area" organisation unit group has **0** members,
where `agent-gsi-p2` correctly has 4 (Tonkolili, Kono, Bombali, Koinadugu —
the seed data `flows.spec.ts`'s own comments describe). History on 2.40.12
carries entries from 2026-09-12, so this looks like leftover damage from an
earlier session rather than anything recent.

Left alone deliberately: restoring it means guessing the intended full set
beyond what 2.43.1 happens to show, and a testing task should not silently
rewrite seed data.

## 4. `@dhis2/ui`'s `DataTableColumnHeader` ignores its own `align` prop

In `@dhis2/ui` 10.17.0 the component turns `align` into a styled-jsx rule
for a `.label` class, while the element it renders is
`span.container > span.top > span.content`. `.label` appears exactly once in
the whole package — in the rule it generates. So the prop is a silent no-op,
and every app passing it gets left-aligned headers over right-aligned
numbers.

This app now works around it in `SummaryMatrix.module.css`
(`.numericHeader :global(span.top) { justify-content: flex-end }`), with a
canary test that fails if the library starts rendering a `.label` element.
The canary does **not** catch the other likely fix, the library retargeting
its rule at the existing `.top` class.

**Worth reporting upstream** — this is not specific to this app.

## 5. A latent e2e locator collision

`e2e/flows.spec.ts:674`'s `root.getByText('0 objects', { exact: true })` has
the same collision shape as two locators hardened in Plan 5's final fix
wave: `GroupsPanel` renders `0 objects` for an empty group. It is latent
only because `GroupSetDetail` renders tabs with a ternary — one tab's
subtree exists at a time — and that test opens the Objects tab once and
never leaves it. A future test that switches tabs mid-flow would hit a
strict-mode violation with a confusing error.

## 6. Smaller things, recorded so they are not rediscovered

- `src/engine/rules.test.ts` has a test named for level-invariance that
  cannot demonstrate it, since `evaluateSet` no longer takes a level
  argument. It is now a near-duplicate of the test above it; only its name
  adds anything, and the name overpromises.
- `GroupSetDetail.test.tsx`'s drill test comment claims it exercises the
  scope and the row level moving down together; the scope is a static mock,
  so only the row-level half is really exercised.
- The organisation unit level fixtures are contiguous (2, 3, 4), so
  `levels.find(l => l.level > current)` is never distinguished from a naive
  `+1`. DHIS2 levels are contiguous in practice, so this covers a case that
  cannot currently occur.
- `GroupsPanel` keeps its filter term when collapsed, so re-expanding
  restores a term the user cannot see they had. Nothing renders wrongly;
  only the round trip surprises.
- `planColumns` is computed twice per render of the Overview tab — once in
  `OverviewTab` for the panel, once in `SummaryMatrix` with its pinned
  state. Both are `useMemo`d on their own inputs, so it is one extra pass
  per result change, not per render.

## Also settled during Plan 4, for the record

- SQL view CSV export **does** honour `paging=false` on 2.40.12 and 2.43.1 —
  verified up to 3526 rows, which does not rule out a cap above that size.
- `access.write` **is** returned on group collections for a non-admin on
  2.40.12 and tracks real permission (positive case plus a 403 negative
  control). Not tested on 2.43.
- `@types/node` stays at `^22.20.2`: only `e2e/` references Node types, the
  whole tree already resolves to 22.20.2, and the installed Node is v22.23.2.

See `docs/superpowers/notes/2026-09-plan4-version-verifications.md` for the
raw measurements behind the first two.
