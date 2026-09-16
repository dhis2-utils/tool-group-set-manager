# Metadata freshness — design

**Status:** approved in brainstorming, 2026-09-16. Implementation plan to follow.

**Supersedes:** `2026-09-15-manual-review-1-design.md` §6.3 and §6.4 (see §8
below). Repairs a defect in **`2026-09-10-group-set-integrity-tool-design.md`
§4.4 ("Cache and refresh")** — that document, not the 2026-09-15 one, whose
own §4.4 is an unrelated UI section.

---

## 1. The problem

A group set integrity tool exists to tell the user what is wrong with their
metadata right now. Today it can quietly tell them what was wrong some
unbounded time ago, and it does not say which.

Three separate findings converge on this:

1. **The cache cannot detect the change this tool watches.**
   `2026-09-10-group-set-integrity-tool-design.md` §4.4 reuses
   a cached payload when the group ids, the object total **and** every group's
   `lastUpdated` match the server. The first two are blind to an object moving
   between groups by construction, and `lastUpdated` was added specifically to
   cover that. `2026-09-plan7-lastupdated-guard.md` measured that a group's
   `lastUpdated` **does not move on a collection-endpoint membership write on
   2.41, 2.42 or 2.43** — so on three of four supported versions the gate added
   to catch membership moves cannot see them.
2. **There is no TTL.** `CachedType.savedAt` is written on every cache put and
   read by nothing. Combined with (1), a browser can serve a membership
   snapshot of arbitrary age and nothing in the validation can notice.
3. **Nothing on screen says how old the numbers are, and there is no way to
   refresh** outside a control buried in Settings.

The consequence is not hypothetical. It is the same class of fault Plan 7
Task 1 spent its whole budget diagnosing: the app showing a state the server
had already left, with no signal that it was doing so.

**Principle adopted:** a few minutes old is fine. Unbounded and unlabelled is
not.

### What this is *not* about

The app already handles its **own** writes correctly. `useMembershipWrite`
updates the in-memory engine via `applyChangeSet` and drops the type's cache
entry via `invalidateType`, and it does the latter even when the former throws
— so a failed engine patch still forces a fresh read next time.

The gaps are all **cross-client**: a second browser tab, the same person on
another device, or another user. Everything below is scoped to that, which is
why the pre-write check in §5 is expected to stay silent almost always.

---

## 2. Scope

| In | Out |
| --- | --- |
| Cache TTL | Auto-refresh of a live session |
| Age indicator and manual refresh | Freshness of anything but metadata |
| Pre-write freshness check on the **bulk fix** | Same check on inline assign or revert |
| Write-shape selection by change size | Per-version write branching |
| Amending §6.3/§6.4 | Multi-tab coordination (BroadcastChannel etc.) |

---

## 3. Freshness model

### 3.1 Where the age comes from

`CachedType.savedAt` already exists. A load that reads from the source stamps
`savedAt = Date.now()`; a load served from cache carries the stored value
forward unchanged — the age is of **the underlying server read**, never of the
page load.

`LoadStatus` gains:

```ts
loadedAt: Partial<Record<ObjectType, number>>
```

populated on both branches of `loadAll`'s per-type loop (the cache-hit
`continue` and the network path), so one field is the single source of the
answer however the data arrived.

### 3.2 Which age is displayed

- **Group set page** — the age of that set's own `objectType`. It is the only
  type on screen, so this is exact.
- **Dashboard** — the **oldest** `loadedAt` among the types it renders.
  Conservative by design: a summary built from four snapshots is only as
  current as its stalest one.

### 3.3 The TTL

**10 minutes.** Enforced in `tryCache` as an additional gate, evaluated
*first* because it is the only one needing no network call — an expired entry
is rejected without spending the `objectTotal` and `groupStamps` requests the
existing three gates cost:

```ts
if (Date.now() - cached.savedAt > CACHE_TTL_MS) return undefined
```

One exported constant, deliberately easy to change; 10 minutes is a starting
value, not a tuned one.

The TTL does not make the 2026-09-10 spec's §4.4 `lastUpdated` gate work —
nothing can, on
2.41–2.43. It **bounds how long that gate can be wrong**, which is the
available remedy.

### 3.4 In-session escalation

The TTL governs whether a *load* may reuse cache. A session that outlives it
is a separate case: the user loaded fresh, then stayed on the page.

Past the TTL the indicator turns amber and its wording changes. **Nothing is
refetched without the user asking.** Silently re-reading would change counts
under someone mid-way through setting up a bulk fix, which is worse than an
honest label — and §5 guarantees correctness at the point it actually matters.

---

## 4. The indicator and refresh control

### 4.1 Placement

Right-aligned in `FilterBar`, which is shared by the dashboard and the group
set page, so both get it from one change. `FilterBar` renders its children in
a single flex row today; it gains a `status` slot rendered after a
`space-between`. Being the only thing in the row that is *not* label-above is
what makes it read as status rather than as a control.

### 4.2 States

| State | Reads |
| --- | --- |
| Fresh | green dot — *Metadata from 2 minutes ago* — `Refresh` |
| Past TTL | amber dot — *Metadata from 2 hours ago and may be out of date* — `Refresh` |
| Refreshing | grey dot — *Reloading metadata…* — `Refresh` disabled |
| Just loaded | green dot — *Metadata from just now* — `Refresh` |

`Refresh` calls the existing `reload(true)`, which already resets the engine
and re-reads. No new load machinery.

### 4.3 Wording

**"Metadata", never "Data."** In DHIS2 "data" means data values; this snapshot
is organisation units, groups, group sets and memberships. Calling it data
would mislead a DHIS2 user about what the number refers to.

### 4.4 Strings

Every string is one complete, argument-free `i18n.t()` call with the age
spliced in afterwards by `interpolate()`; counts are two strings chosen on
`=== 1`; no colons. Granularity is capped deliberately — "just now", minutes,
hours, then "over a day ago" — rather than carrying days, weeks and months
nobody will read.

The past-TTL variants are a **parallel set of whole sentences**, not the fresh
string wrapped in a second one. Nesting a translated fragment inside another
translated sentence is what CLAUDE.md forbids, and for the usual reason: the
translator cannot reorder it. It costs about twelve short strings instead of
seven, which is the right trade.

```
Metadata from just now
Metadata from 1 minute ago            /  Metadata from {count} minutes ago
Metadata from 1 hour ago              /  Metadata from {count} hours ago
Metadata from over a day ago
Metadata from just now and may be out of date
Metadata from 1 minute ago and may be out of date   /  …{count} minutes…
Metadata from 1 hour ago and may be out of date     /  …{count} hours…
Metadata from over a day ago and may be out of date
Reloading metadata…
Refresh
```

---

## 5. The pre-write freshness check

### 5.1 What it does

On **Apply** in `BulkFixDialog`, before any write:

1. Re-read, from the server, the membership of **only the groups that will
   take the replace route** — those whose own delta exceeds
   `DEFAULT_BATCH_SIZE` (§6.1). Not the whole set, not the whole type, and
   not every group the plan names.

   **Amended 2026-09-16 after measurement.** This section originally said
   every group the plan names. Measured on `agent-gsi-emis` (266,396
   organisation units), reading every group of a set costs 2.1–10.8s
   — `2026-09-plan8-reread-cost.md` — which §5.4's own ladder puts in the
   "stop and revisit" band. The narrowing is not a cost compromise that
   weakens the guarantee: **the hazard this check exists to prevent is
   exclusive to the replace route.** A whole-collection replace rewrites a
   group's whole
   collection, so a member added by someone else since our snapshot is
   absent from the list we send and is silently dropped. A batched delta
   touches only the ids it names and cannot do that. Reading a group we are
   about to write a *delta* to buys no safety at all.

   What this costs: the re-confirmation in §5.3 now fires only for fixes
   large enough to cross the threshold. A small fix applies its delta
   against a snapshot at most `CACHE_TTL_MS` old, and the worst it can do is
   add an object to a group someone else has since classified — which
   surfaces as a conflict the tool itself reports, not as silent loss.
2. Push that into the engine via `setGroupMembers` (§5.2).
3. Recompute the plan.
4. **Identical → write immediately.** No interruption, no message.
5. **Different → stop and re-confirm** (§5.3).

Step 4 is the overwhelmingly common path, and always the path when one person
is using the app, so the normal experience is unchanged except for the
re-read's own latency.

### 5.2 `setGroupMembers`

`planAssignment` computes against the engine's own membership, so fresh data
must reach the engine before recomputing — and `loadMemberships` only accepts
a whole type's payload. Hence one new engine method:

```ts
setGroupMembers(
  objectType: ObjectType,
  groups: { groupId: string; memberIds: string[] }[]
): void
```

It sets the named groups' membership **absolutely** and re-evaluates only the
group sets containing those groups.

This is deliberately the same shape as `applyChangeSet`, which already patches
`membersByGroup` and re-evaluates only affected sets — absolute values instead
of a delta. It is an addition to a well-worn path, not a new mechanism, and it
produces exactly the complete membership §6 needs.

### 5.3 Re-confirmation

A notice — *"The metadata changed while you were reviewing"* — the previewed
count struck through beside the recalculated one, and one sentence naming what
moved ("1 object is no longer affected because it has since been assigned to a
group").

Actions: `Cancel` / `Review changes` / `Apply {n} changes`. *Review changes*
returns to the preview step with the recalculated plan, for a fix large enough
that a changed count deserves a proper look.

The user authorised a specific set of changes. Applying a different set
without asking is the same class of fault this whole document exists to
remove, in miniature.

### 5.4 Risk: the re-read's cost is unmeasured

**Measured, and the result changed the design.**
`docs/superpowers/notes/2026-09-plan8-reread-cost.md`: reading every group of
a set on `agent-gsi-emis` took 9.7s / 6.3s (Geo-Political Zone, 6 groups,
211,299 ids), 10.8s / 4.9s (School Level, 4 groups, 221,652 ids) and 3.9s /
2.1s (Location, 2 groups, 97,264 ids) — roughly 1–2s per group, and over the
6s ceiling for the larger sets even on their faster run. Every set disagreed
between its two runs by more than 30%, consistently slower on the first,
which reads as a cold JVM or database cache rather than external load (only
one instance was running).

Two things follow, both applied in §5.1 above:

1. **The re-read is scoped to replace-route groups**, because that is where
   the hazard is. A large fix crosses the threshold on one or two groups, not
   all of them, so the realistic cost is ~1–4s rather than 2–11s.
2. **Show progress while it runs.** At 1–2s per group this lands in the
   "2–6s" band of the ladder below even after narrowing, so Apply must say
   what it is doing rather than appear to hang.

The measurement read groups **sequentially**; the implementation reads them
concurrently, so the per-group figures above are an upper bound on the real
cost. Concurrency is not a free win on a shared server, though, and the
narrowing in (1) is what actually makes this affordable.

---

## 6. Write-shape selection

### 6.1 The rule

`writeMemberships` keeps its public signature and chooses **per group**:

| per-group delta | shape |
| --- | --- |
| ≤ 5000 ids | collection endpoint, batched (today's path) |
| > 5000 ids | JSON Patch replacing that group's members array with its complete membership |

**Amended after measurement.** This was originally specified as a
`POST /api/metadata` import, which is what Plan 7 measured. It is now a JSON
Patch. `POST /api/metadata` overwrites every owned property absent from the
payload — `mergeMode` was removed from that endpoint in 2.41 and backported to
2.38.7/2.39.6/2.40.4 — so an import would have nulled a group's `description`,
`symbol`, `color`, `attributeValues` and `translations`. A patch touches only
the members array, so the hazard disappears rather than being compensated for.
Measured at 23.0s/19.2s over 91,892 memberships against the import's
18.2s/20.3s, same server-cost cluster, and identical behaviour on 2.40.12 and
2.41.10 — the only shape measured in this project with no per-version caveat.
See `docs/superpowers/notes/2026-09-plan8-json-patch.md`.

### 6.2 Why 5000, and why per group

`2026-09-plan7-write-shapes.md` measured that DHIS2 re-reads a group's whole
collection on every collection write, so the batched path's cost is
approximately *(number of requests) × (collection size)* while the import's is
one pass. The two are equal at one request — which at `DEFAULT_BATCH_SIZE` is
5000 ids — and the import wins beyond it.

Below the threshold the batched path costs the same single collection re-read
**and sends far fewer ids**. This corrects an error in Plan 7's own analysis:
all seven runs wrote a group's entire population, which flatters a shape that
always sends the complete membership. A realistic fix of a few hundred
violations would have been markedly *worse* by import — ~100,000 ids instead
of ~300.

### 6.3 Two properties worth keeping

**It routes itself.** Inline assign is one or two ids; revert replays a
recorded delta. Both are always under the threshold and keep today's behaviour
without any caller deciding. Only the bulk fix can produce a change large
enough to take the replace route.

**The safety is structural.** The replace route requires the group's complete
membership, supplied by the caller as a new optional parameter. Without it the
route is unavailable and the code falls back to batched — so a caller that has
**not** done a §5 refresh cannot obtain replace-all semantics. This is enforced
by the signature, not by a comment.

---

## 7. Testing

- **Engine (plain Jest, no React/DHIS2):** `setGroupMembers` sets absolute
  membership, re-evaluates only affected sets, and ignores unknown ids the way
  `applyChangeSet` already does.
- **`tryCache`:** an entry past the TTL is not reused even when all three
  existing gates pass — the case that matters, since on 2.41+ they all do.
- **`loadAll`:** `loadedAt` is populated on both the cache-hit and network
  branches.
- **Age formatting:** boundaries (59s, 60s, 1 unit vs many, over a day) and
  that each variant is a whole string.
- **`writeMemberships`:** routes at the threshold on both sides; falls back to
  batched when no complete membership is supplied, **even above the
  threshold**; the import sends the complete list, not a delta; `WriteResult`
  is indistinguishable between routes.
- **`BulkFixDialog`:** unchanged plan writes without interrupting; changed plan
  blocks and re-confirms; *Review changes* returns to preview with the
  recalculated plan; Cancel writes nothing.
- **e2e:** the indicator renders and `Refresh` reloads. The changed-plan path
  is a unit concern — provoking a real cross-client change mid-flow is not
  worth the suite's complexity.

Jest maps `.css` imports to an empty object, so CSS-module class names are
`undefined` in tests; assert on roles and text, or use a scoped per-file mock.

---

## 8. Amendments to the earlier specs

- **`2026-09-10-group-set-integrity-tool-design.md` §4.4** ("Cache and
  refresh") — record that the `lastUpdated` gate cannot see a membership move
  on 2.41–2.43, and that the TTL bounds rather than fixes this. Recorded via
  the 2026-09-15 spec's §9 running list of edits to that earlier document,
  which is the established mechanism.
- **§6.3** — the concurrency guard is no longer a `lastUpdated` re-check. It is
  the §5 freshness check: re-read the affected groups, recompute, and require
  re-confirmation if the plan changed. Version-independent, and it observes
  content rather than a proxy that three of four supported versions do not
  maintain.
- **§6.4** — replace the flat "batch size 5000" outcome with §6.1's threshold
  rule, citing both the Plan 7 measurement and the small-fix correction.

---

## 9. Out of scope, and why

- **Multi-tab coordination.** A second tab of the same app stays stale until it
  reloads. Detectable with `BroadcastChannel`, but it is a different problem
  (live invalidation between clients) and the TTL plus the §5 check bound the
  damage.
- **Auto-refresh of a live session.** Rejected in design: changing counts under
  a user mid-task is worse than an honest label.
- **Freshness checks on inline assign and revert.** Inline assign changes one
  object, visibly and revertibly. `planRevert` already performs a
  content-based check — its `stillHolds` test compares each touched object's
  current membership, which is why the Revert dialog can report "Nothing to
  revert". Adding a second guarantee there would duplicate a working one.
