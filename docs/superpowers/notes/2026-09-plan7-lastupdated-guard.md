# Plan 7 Task 3: can the import shape's concurrency guard be built?

Spec §6.3 gates the import shapes (Task 2's shapes 2 and 3) on a concurrency
guard. Those shapes replace a group's **whole** membership rather than adding
to it, so they discard a concurrent editor's change in a way the batched
collection endpoint — which sends a delta — cannot. The proposed guard is a
re-read of the group's `lastUpdated` immediately before writing, aborting if
it moved since the app captured it.

§6.3's own rule: **where the guard cannot be proven, the batched endpoint
stays the write path on that version, whatever the timings say.**

**Answer: the guard can be built on 2.40 only. It cannot be built on 2.41,
2.42 or 2.43 — three of the four supported versions.**

Measured 2026-09-16, one instance at a time, as `local_admin`. Probe script:
`lastupdated-probe.js` (reproduced in §5 below); it is self-restoring — every
write it makes it undoes, and each run confirmed `restoredCleanly`.

---

## 1. The measurements

For each version: read the signals, write **one** membership change, read
again, undo, read again. Done twice per version — once through the collection
endpoint (`POST organisationUnitGroups/<id>/organisationUnits`, today's path)
and once through a metadata import carrying the group's complete member list
(the shape whose guard this is). The two are measured separately because a
version may bump for one and not the other, and it does.

| version | write shape | group `lastUpdated` before → after | moved? |
| --- | --- | --- | :---: |
| **2.40.12** | collection | `2026-09-15T22:32:36.606` → `2026-09-16T06:55:48.320` | **yes** |
| 2.40.12 | import | `2026-09-16T06:55:49.811` → `2026-09-16T06:55:51.727` | yes |
| **2.41.10** | collection | `2026-07-17T07:53:45.794` → `2026-07-17T07:53:45.794` | **no** |
| 2.41.10 | import | `2026-07-17T07:53:45.794` → `2026-09-16T06:54:17.834` | yes |
| **2.42.6** | collection | `2017-01-26T17:45:00.717` → `2017-01-26T17:45:00.717` | **no** |
| 2.42.6 | import | `2017-01-26T17:45:00.717` → `2026-09-16T06:58:58.497` | yes |
| **2.43.1** | collection | `2017-01-26T17:43:47.259` → `2017-01-26T17:43:47.259` | **no** |
| 2.43.1 | import | `2017-01-26T17:43:47.259` → `2026-09-16T05:52:55.881` | yes |

Timestamps are quoted rather than summarised, per the task's own instruction.
Note the unchanged ones are quoted identically on both sides — a 2017 or
July-2026 stamp surviving a membership write that demonstrably landed.

Each probe sleeps 1.1s between the baseline read and the write, so a stamp
that failed to move cannot be explained by millisecond-resolution collision.
Every run's `sizeMoved` was `true`, confirming the write itself landed.

### The fallback signals, per §6.3 step 2

| version | write shape | **set** `lastUpdated` moved | `organisationUnits~size` moved |
| --- | --- | :---: | :---: |
| 2.40.12 | collection / import | no / no | yes / yes |
| 2.41.10 | collection / import | no / no | yes / yes |
| 2.42.6 | collection / import | no / no | yes / yes |
| 2.43.1 | collection / import | no / no | yes / yes |

**The group set's own `lastUpdated` never moves on any version, for either
shape.** It is not a fallback; it is not a signal at all.

---

## 2. Where the behaviour changes

The boundary is **2.40 → 2.41**. 2.40 bumps a group's `lastUpdated` on a
collection membership write; 2.41, 2.42 and 2.43 do not. This confirms and
extends `2026-09-plan2-write-compatibility.md` §4, which had recorded the two
endpoints of that range without the middle: the two versions in between
behave like 2.43, not like 2.40, so this is one change at 2.41 rather than
anything version-specific to 2.43.

Every version bumps `lastUpdated` on a metadata import, because an import
rewrites the group object itself.

---

## 3. Why this disqualifies the guard on 2.41+

The distinction that matters is **not** "does the import bump the stamp" — it
always does. It is **"would the guard see a change made by somebody else"**,
and somebody else is not obliged to use the same shape this app does.

On 2.41, 2.42 and 2.43 the guard is blind to **every** membership change made
through the collection endpoint. That is not a remote possibility:

- **this app's own batched write path uses that endpoint.** Two users of this
  very tool, fixing the same group set at the same time, would be invisible to
  each other's guard — the import would silently discard the other's work,
  which is precisely the silent-data-loss bug §6.3 exists to prevent;
- anything else that assigns group membership through the collection API —
  other tools, scripts, integrations — is equally invisible.

A guard that cannot see the change it exists to detect is not a guard.

### The `~size` fallback does not rescue it

§6.3 step 2 anticipates a weaker fallback where the timestamp fails, and asks
that it be recorded as "weaker, and why" rather than as an equivalent. It is
weaker for the reason the plan predicted — it cannot see a swap that adds one
member and removes another — and this was verified rather than assumed.

On **2.42.6**, one collection write removing `O6uvpzGd5pu` and adding
`Rp268JB6Ne4` in the same request:

```
before:                          lastUpdated 2026-09-16T06:59:00.067  size 3
after equal-sized swap:          lastUpdated 2026-09-16T06:59:00.067  size 3
restored:                        lastUpdated 2026-09-16T06:59:00.067  size 3
```

**Neither signal moved.** On 2.41 through 2.43, a concurrent editor can
replace a group's entire membership — every single object — and, as long as
the count comes out the same, both available signals report that nothing
happened. There is nothing left to build a guard on.

This is not a hypothetical shape of edit, either: it is exactly what a "move
these objects from group A to group B" fix does to a group, which is this
tool's central operation.

---

## 4. The answer, per version

| version | can the guard be built? | on what |
| --- | :---: | --- |
| **2.40.12** | **yes** | group `lastUpdated` moves for both write shapes |
| **2.41.10** | **no** | blind to collection writes; `~size` blind to a swap |
| **2.42.6** | **no** | as 2.41, and demonstrated with a real swap above |
| **2.43.1** | **no** | as 2.41 |

Under §6.3's rule, the import shapes are therefore **disqualified on 2.41,
2.42 and 2.43**, whatever Task 2's timings say. They survive only on 2.40 —
the one version where nobody wants a special case, since it is the oldest
supported and the least likely to be carrying a national-scale population.

Task 4 applies this as the veto it is.

---

## 5. Reproducing this

`lastupdated-probe.js`, run once per instance:

```
node lastupdated-probe.js http://dhis2-<instance>:8080
```

It discovers its own targets (the first group set with groups, that set's
first group, and an organisation unit not currently in it), so it needs no
per-instance configuration. For each of the two shapes it reads the three
signals, writes, reads, undoes, and reads again, reporting `restoredCleanly`.

Kept in the scratchpad rather than committed: unlike
`scripts/perf/write-shapes.js`, this answers a question that is now answered,
and the answer is a property of the DHIS2 versions rather than of this app. If
it needs re-running it will be against a version that does not exist yet, and
the script above is short enough to reproduce from this note.

```js
// The discriminating part, verbatim -- the rest is target discovery.
async function readSignals(groupId, setId) {
    const g = await api(
        `organisationUnitGroups/${groupId}?fields=lastUpdated,organisationUnits~size`
    )
    const s = await api(`organisationUnitGroupSets/${setId}?fields=lastUpdated`)
    return {
        groupLastUpdated: g.lastUpdated,
        setLastUpdated: s.lastUpdated,
        size: g.organisationUnits,
    }
}
```

### Instances used

- 2.40.12 — `agent-gsi-p2-40` (existing)
- 2.41.10 — `agent-gsi-emis` (existing; probed while up for Task 2)
- 2.42.6 — `agent-gsi-p7-42`, created from `dhis2-db-sierra-leone_v42.sql.gz`
  for this task and **deleted afterwards**
- 2.43.1 — `agent-gsi-p2` (existing)

One at a time throughout. Every instance was left with its membership restored
to the state it was found in.
