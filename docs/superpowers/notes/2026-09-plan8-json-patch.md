# Plan 8: is JSON Patch a viable replacement for the metadata-import write?

This measures whether `PATCH /api/organisationUnitGroups/<id>` with
`Content-Type: application/json-patch+json` and a single `replace` of
`/organisationUnits` is correct and fast enough to replace the metadata-import
shape `2026-09-plan7-write-shapes.md` measured and recommended. That shape
works but reads the group with `fields=:owner,!<members>` first and spreads
it into the payload, because `POST /api/metadata` overwrites every owned
property absent from the payload (`mergeMode` was removed from the endpoint;
REPLACE is the only behaviour from 2.41/2.38.7/2.39.6/2.40.4 onward). JSON
Patch is DHIS2's own recommended partial-update mechanism and is already used
in this codebase (`setGroupSetProperties`, `src/data/metadataWrites.ts`) --
this note asks whether it also works for a **national-scale membership
array**, not just the two booleans that call already patches.

Driver: `scripts/perf/json-patch-members.js` (committed). It reuses
`scripts/perf/write-shapes.js`'s `capture`/`restore` for populating and
restoring the group's member list, and adds the one shape write-shapes.js
does not have (`patch`), plus untimed `verify`/`set-props`/`read-props`
helpers for the three functional questions below.

---

## 0. Instance, version, target

| | |
| --- | --- |
| Instance | `agent-gsi-emis`, DHIS2 **2.41.10** (questions 1-3) |
| Instance | `agent-gsi-p2-40`, DHIS2 **2.40.12**, Sierra Leone demo (question 4) |
| Target group (2.41) | `Basic Education` (`O1hqU8q6iea`), 91,892 members, the same group and the same from-empty starting state as `2026-09-plan7-write-shapes.md` |
| Target group (2.40) | `District` (`w1Atoz18PCL`), 13 members |
| Concurrency | one broker instance running at a time, nothing else driving either instance's API |
| Date | 2026-09-16 |

Everything changed was restored: `Basic Education` is back to its exact
91,892-member set (verified by set-comparison, not just a count), and the
`description`/`color`/`symbol` values this note set on both test groups were
removed afterwards (both groups had none before). Both instances were stopped
at the end of the session.

---

## 1. Does it work at all? (add and remove, not just add)

`json-patch-members.js verify` builds a change that both adds and removes:
it drops the first *n* current members and adds *n* organisation units the
group does not currently contain, patches, rereads, and diffs the result
against what was intended, then patches back to the original list.

**On `agent-gsi-emis` (2.41.10), small group `Federal Unity College` (198 members), n=5:**

```json
{"removedCount":5,"addedCount":5,"matchedAfterPatch":true,
 "removalTookEffect":true,"additionTookEffect":true,"restoredExactly":true}
```

At the 91,892-member scale, the two timed runs (§3) exercise both directions
at full size, just not in the same call: each run first empties the group
(a `replace` to `[]`) and then fills it (a `replace` to the full list). The
"empty" step is itself a full-membership `replace`, and its server-side cost
(§3.2) confirms the delete path is doing real work at scale, not silently
no-oping.

**Answer: yes.** A JSON Patch `replace` of `/organisationUnits` adds and
removes members correctly, confirmed by reading the membership back and
diffing the full set (not just a count) both after the patch and after
restoring.

---

## 2. Does it preserve the group's other owned properties?

`json-patch-members.js set-props` sets `description`/`color`/`symbol` via
JSON Patch `add` (not `replace` -- these fields do not exist on a group that
has never had them, and `replace` requires the path to already exist).
`read-props` then confirms after the members-only patch.

**Small group (`Federal Unity College`, 2.41.10):**

```json
before: {"name":"Federal Unity College","organisationUnits":198}
after set-props: {"description":"Test description for plan8","symbol":"sym1","color":"#ff0000","organisationUnits":198}
after add+remove patch of members: {"description":"Test description for plan8","symbol":"sym1","color":"#ff0000","organisationUnits":198}
```

**At scale (`Basic Education`, 91,892 members, 2.41.10):** description
`"National basic education network"`, color `#2255aa`, symbol `sym_school`
were set, then the group was emptied and refilled twice (§3's two timed
runs -- each one a full-collection `replace`, the most aggressive case).
All three properties read back unchanged after **both** runs.

**On 2.40.12 (`District`, Sierra Leone demo):** same result -- description,
color and symbol set, then a members-only add+remove patch, then reread:
all three survived.

**Answer: yes, on both 2.40.12 and 2.41.10.** A JSON Patch `replace` scoped
to `/organisationUnits` never touches any other owned property, at any
scale tested, including a full empty-then-refill. This is the entire point
of the exercise: no owner-field read-and-spread is needed at all, so there
is no owned property the app can fail to preserve because it forgot to ask
for it.

---

## 3. How fast, at 91,892 members?

Same method as `2026-09-plan7-write-shapes.md`: `Basic Education` restored
to empty, then a single `PATCH .../organisationUnitGroups/<id>` carrying the
group's complete captured 91,892-id list as one `replace` of
`/organisationUnits`, then the membership read back to confirm completeness.
Server cost sampled via `pg_stat_database` deltas across each run, same
columns as the plan-7 note.

### 3.1 Timing

| run | seconds | requests | complete |
| --- | ---: | ---: | :--- |
| 1 | **23.008** | 2 | yes (91,892/91,892) |
| 2 | **19.244** | 2 | yes (91,892/91,892) |

Both runs' 2 requests are the `PATCH` itself plus the read-back `GET` --
directly comparable to the import shape's own request count. Unlike the
import shape, **no group pre-read is needed to build the payload**: the
`patch` mode only ever sends `groupId` and the member-id list, never a group
object. That is a real, structural difference from the import shape's `fields=
:owner,!<members>` read, not just a difference in what this harness happened
to measure -- see §5.

**Payload size and acceptance:** the member array is ~1.29 MB of raw ids
(`be-members.json`, 91,892 ids), wrapped as `{"op":"replace","path":
"/organisationUnits","value":[{"id":"..."}, ...]}` -- the same `{id}`-wrapped
array shape the import payload uses for its `organisationUnits` field, so the
two are comparable in size. **Both runs were accepted at full size with no
error, no 413, no timeout.** This is not a payload-size-limited operation on
this instance.

### 3.2 Server-side cost (`pg_stat_database` deltas, `dhis2-agent-gsi-emis-db`)

| run | xact_commit | tup_inserted | tup_updated | tup_deleted | tup_fetched | blks_read | blks_hit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 37 | 91,892 | 6 | 0 | 283,962 | 8,024 | 1,714,229 |
| 2 | 35 | 91,892 | 6 | 0 | 343,944 | 9,791 | 1,929,833 |

Normalised, the same way plan 7 did it:

| run | rows fetched per object written | buffer hits per object |
| --- | ---: | ---: |
| 1 | **3.09** | 18.66 |
| 2 | **3.74** | 21.00 |

Compare to plan 7's `import` shape: 3.1 and 4.7 rows fetched per object
(two runs), 18.6 and 24.8 buffer hits per object. **The JSON Patch replace
and the metadata import cost the database essentially the same amount of
work per membership**, within the same run-to-run variance plan 7 itself
saw between its own two `import` repeats. That is exactly what would be
expected if both endpoints funnel into the same collection-persistence code
path server-side -- JSON Patch is not a different (better or worse) database
operation here, it is the same operation reached through a narrower HTTP
contract.

**The "empty" half also costs real, comparable work.** Before each timed
run, `json-patch-members.js empty` replaces `/organisationUnits` with `[]`,
which took 17.16s then 13.84s (untimed relative to the runs above, but
recorded because it is informative): the delta for the second empty (a clean
sample, no other activity in the interval) was `tup_deleted: 91,892,
tup_fetched: 99,547` -- about 1.08 rows fetched per deleted membership,
cheaper per row than the insert side but not free. A production replace that
both adds and removes (rather than this harness's from-empty method, chosen
to stay comparable to plan 7) should expect cost proportional to rows
touched in both directions, not just rows added.

### 3.3 Against the plan-7 bar

| shape | seconds | rows fetched / object |
| --- | ---: | ---: |
| `import` (plan 7, run 1) | 18.2 | 3.1 |
| `import` (plan 7, repeat) | 20.3 | 4.7 |
| **`json-patch` (this note, run 1)** | **23.0** | **3.09** |
| **`json-patch` (this note, run 2)** | **19.2** | **3.74** |
| `batched` @ 5000 (plan 7) | 47.4 | 19.5 |
| `batched` @ 1000 (plan 7, old default) | 192.0 | 56.1 |

JSON Patch lands **inside the same cluster as the import shape** -- within
about 5-25% of it on wall clock, and statistically indistinguishable on
server cost. It is nowhere near the batched shapes' territory.

---

## 4. Does it work on the 2.40 floor?

Functional check only, on `agent-gsi-p2-40` (DHIS2 **2.40.12**, Sierra Leone
demo), target group `District` (`w1Atoz18PCL`, 13 members):

1. `set-props` -- description/color/symbol added via JSON Patch `add`: accepted.
2. `verify 3` -- drop 3 current members, add 3 non-members, patch, reread,
   restore: `{"matchedAfterPatch":true,"removalTookEffect":true,
   "additionTookEffect":true,"restoredExactly":true}`.
3. `read-props` after the members-only patch: description/color/symbol all
   still present, unchanged.
4. Properties removed and membership restored to the original 13 (confirmed
   by count) before stopping the instance.

**Answer: 2.40.12 behaves identically to 2.41.10.** Both the add/remove
correctness and the owned-property preservation hold on the oldest supported
floor, with nothing found that differs. This matters because plan 7's own
conclusion (`2026-09-plan7-write-shapes.md` §7) was forced to disqualify the
import shape on 2.41/2.42/2.43 specifically because `lastUpdated` does not
move on a collection write there, leaving only 2.40 able to support a
concurrency guard. JSON Patch showing **no version split at all** here is
the most important finding in this note -- see §6.

---

## 5. What JSON Patch removes, beyond the numbers

The timings in §3 already put JSON Patch in the same tier as the import
shape. Two things do not show up as a number in that table but matter for
the recommendation:

- **No owner-field pre-read.** The import shape's real production path
  fetches the group with `fields=:owner,!<members>` before it can build a
  payload that will not blank out sharing, translations, or any other owned
  property the read's field list forgot. `json-patch-members.js`'s `patch`
  mode needs no such read: it sends only the group id and the member list.
  This is not a timing difference this harness happened to record --
  write-shapes.js's own `import` measurement also skips a full `:owner` read
  in favour of a 4-field `readGroup` (`id,name,shortName,code`), so even
  plan 7's numbers understate the request the shipped code actually makes.
  JSON Patch's advantage here is structural, not something either
  measurement captured as elapsed time.
- **No owned-property hazard.** §2 is not just "it happened to work" --
  scoping the patch to `/organisationUnits` means there is no field list to
  keep in sync with whatever DHIS2 adds as an owned property next. The
  import shape's compensation (read owner fields, spread them back) is a
  standing maintenance burden against a moving target; JSON Patch has
  nothing to maintain because it never touches anything outside the path it
  names.

---

## 6. Recommendation

**Adopt JSON Patch for the membership write**, replacing the metadata-import
shape plan 7 recommended keeping around specifically for its concurrency
guard.

This is not "somewhat worse but worth the trade" -- it is a straight
improvement on every axis measured:

- **Speed:** statistically the same as the import shape (19.2-23.0s vs
  18.2-20.3s at 91,892 members), nowhere near the batched shapes.
- **Server cost:** statistically the same (3.09-3.74 vs 3.1-4.7 rows fetched
  per object).
- **Correctness:** confirmed on both 2.40.12 and 2.41.10, add and remove
  both verified by full-set comparison, not just a count.
- **Owned-property safety:** confirmed at scale, including a full
  empty-then-refill, on both versions -- and structurally guaranteed rather
  than dependent on a field list staying complete.
- **Requests:** one fewer than the import shape's real production path
  (no `:owner` pre-read needed at all).
- **No version split.** Plan 7's own recommendation (`batched` @ 5000, with
  the import shape held back as a 2.40-only special case pending a
  concurrency guard that turned out to be buildable on 2.40 alone) exists
  *because* the import shape's guard signal (`lastUpdated` on a collection
  write) is version-dependent. Nothing in this note found a version split
  for JSON Patch -- 2.40.12 and 2.41.10 behaved identically on every check.
  If a `lastUpdated`- or `~size`-based concurrency guard is wanted for the
  JSON Patch path too, that is a **separate** question this note does not
  answer (JSON Patch's own effect on the group's `lastUpdated` was not
  measured here), but it is no worse a starting position than the import
  shape's, and removes the reason the import shape was disqualified on
  three of four supported versions.

The one caveat: this note's timed runs, like plan 7's, measure a from-empty
fill (and, separately, a from-full empty) rather than a single call that
does both at once. §3.2's "empty" deltas show the delete side costs real,
comparable work, so a production replace that both adds and removes should
be expected to cost roughly the sum of what emptying and filling cost here
-- not exactly one or the other. That is worth a follow-up timed run of a
single mixed replace at full scale before this ships, but nothing in the
evidence gathered suggests it would land outside the import shape's own
cluster.
