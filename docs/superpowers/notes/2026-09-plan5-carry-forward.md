# Carried forward from Plans 4 and 5: found, recorded, not fixed

Plan 4 (correctness and simplification) and Plan 5 (navigation and layout)
are complete. These items were found during them, confirmed, and
deliberately left — each is either outside the plan that found it or needs
its own investigation. A future plan should pick them up in this order.

## 1. Three e2e write/revert flows fail — ANSWERED (Plan 7 Task 1)

**Status: settled and fixed.** See
`docs/superpowers/notes/2026-09-plan7-e2e-write-flows.md` for the full
evidence. The summary, because the framing below turned out to point the
wrong way:

The cause was **neither** of the two candidates this section proposed. There
was no contention of any kind, because there was no delayed promise:
`planRevert` resolved promptly and correctly reported *"Nothing to revert"*,
and `RevertDialog` disables its button on `plan.affected === 0`. The disabled
button was the app telling the truth about a stale input.

Two independent causes, both pre-existing, both unrelated to Plans 4, 5 and 6:

1. **The app created its `GSI_*` SQL views without a `cacheStrategy`**, so
   DHIS2 applied `RESPECT_SYSTEM_SETTING`, which on these instances resolves
   to `keyCacheStrategy: CACHE_TWO_WEEKS`. `/api/sqlViews/<id>/data` was
   therefore served with `Cache-Control: max-age=1209600, public` and the
   browser answered every post-write membership read from its own cache,
   without contacting the server, for up to fourteen days. A user-facing
   defect in its own right: a user's own fix vanishes on the next load.
   Fixed in Plan 7 (`cacheStrategy: 'NO_CACHE'` on the definitions, plus
   `cache: 'no-store'` on the reads, because layer one does nothing for views
   an earlier version already created).
2. **The missing cleanup net in §2 below**, which turned one failure into a
   permanent one: each failed flow left the shared instance in exactly the
   state that fails the *next* run's precondition. This is what hid cause 1 —
   the three flows were failing on their preconditions, never reaching the
   symptom described below.

**The original observation, kept for provenance** (and note that its most
suggestive detail had the opposite meaning to the one read into it):

> after a real, successful server write (confirmed via direct read-only API
> calls — the membership change always lands), opening History's Revert
> dialog leaves its own Revert button disabled for 5-15 seconds, with **zero**
> further `/api/*` requests in that window, and it self-resolves on its own
> some of the time.

The "zero `/api/*` requests" was read as evidence that the stall was inside
the Web Worker, since `planRevert` is not HTTP. It was in fact the signature
of a **browser HTTP cache hit**: no request appears because no request is
made. The reasoning that followed from it — a FIFO client/worker protocol in
which a never-settling promise would need a non-terminating loop — was sound,
and its conclusion (that no such loop existed) was right. There was no stalled
promise.

The proposed step one, a re-run at a commit before Plan 4, was **not** run and
would have proved nothing: both causes predate Plan 4 and neither depends on
app code that changed since. What varies is the *instance* — whether the
`GSI_*` views are installed on it, and what its `keyCacheStrategy` is.

`bulk move`'s additional failure on 2.40.12 is **not** explained by this and
was not investigated; §3 below (that instance's "Northern Area" holding 0
members) is sufficient on its own to fail that flow's matrix assertion.

## 2. The e2e suite has no cleanup net — FIXED (Plan 9)

**Closed.** `flows.spec.ts` now has a suite-wide `beforeAll`/`afterEach` net
over the `Area` set. `beforeAll` strips any member below level 2 (reporting
what it removed) and snapshots the repaired state; `afterEach` restores any
group that diverges from that snapshot. Both halves were verified against a
real failure rather than only reasoned about: a level-4 facility injected into
"Northern Area" was reported and removed on the next run, and a deliberate
throw between a flow's write and its revert produced
`cleanup net: restoring "Southern Area" -- found 4 member(s), expected 3`,
leaving the instance back at its thirteen level-2 districts.

The three design questions this entry raised, answered: **what to revert** —
`Area`'s membership, the only thing these flows write. **How to know what this
run wrote** — don't; journalling fails in precisely the case that matters (the
test died early and recorded nothing), so it compares against a snapshot
instead. **What to do when cleanup fails** — throw, because a net that
silently does not work is worse than none.

**Original entry, kept for provenance:**

> ## 2. The e2e suite has no cleanup net

`e2e/flows.spec.ts` and `e2e/fixtures/session.ts` have no `afterEach` or
`afterAll`. Every write-then-revert test reverts only as its own last step,
so a test failing between the write and the revert leaves a **shared broker
instance** dirty for whoever runs next. Pre-existing; Plan 5's two added
flows are read-only and add no new exposure.

Not fixed because adding structural cleanup to a suite that writes to shared
instances is its own design question — what to revert, how to know what this
run wrote, and what to do when cleanup itself fails.

**Updated after Plan 6.** Plan 6's usage flow writes too (it installs a SQL
view), and rather than widen this gap it was given a `test.afterAll` of its
own that deletes the view by code. That was necessary beyond tidiness: a
leftover usage view makes every *subsequent* run of that flow fail at its
first assertion, because the button it looks for then reads "Remove usage SQL
view" instead of "Install usage SQL view". So the suite now has exactly one
flow that cleans up structurally, and the general question — a suite-wide
`afterEach` for the membership flows — is still open.

## 3. A data anomaly on `agent-gsi-p2-40` — FIXED (Plan 7 Task 8)

**Original entry, kept for provenance:**

> That instance's "Northern Area" organisation unit group has **0** members,
> where `agent-gsi-p2` correctly has 4 (Tonkolili, Kono, Bombali, Koinadugu —
> the seed data `flows.spec.ts`'s own comments describe). History on 2.40.12
> carries entries from 2026-09-12, so this looks like leftover damage from an
> earlier session rather than anything recent.
>
> Left alone deliberately: restoring it means guessing the intended full set
> beyond what 2.43.1 happens to show, and a testing task should not silently
> rewrite seed data.

**Settled.** By 2026-09-16 the group held **3** members and they were exactly
`Badjia`, `Njandama MCHP` and `Ngelehun CHC` — the `bulk move` flow's own
population (`BULK_POPULATION_COUNT`), at levels 3 and 4, with all four
districts still missing. That removes the guesswork the entry was hedging
against: this is unreverted damage from an aborted run of this suite, not
something about the seed, and the intended contents are named by
`flows.spec.ts`'s own comment rather than inferred from 2.43.1.

Restored: the four districts added back, the three facilities removed. The
2.40.12 suite then passed 8/8, including `bulk move`, which had been the one
flow failing on that instance — so this anomaly, not the caching defect in §1,
was the whole of that failure.

**One observation while restoring, not acted on.** On `agent-gsi-p2-40`,
`Kambia` is a member of **both** "Western Area" and "Eastern Area" — a genuine
conflict in the Area set, and exactly the kind of thing this tool exists to
report. It was left alone: unlike Northern Area it is not obviously damage
(the Sierra Leone seed has real oddities, and a demo database containing a
conflict is plausible and even useful here), no flow depends on it, and
"restore what is clearly damaged" is a different licence from "tidy the seed".
Worth a minute's comparison against `agent-gsi-p2` before anyone treats it as
either.

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

`e2e/flows.spec.ts:728`'s `root.getByText('0 objects', { exact: true })` has
(line number as of Plan 6; it was 674 when this was written)
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
