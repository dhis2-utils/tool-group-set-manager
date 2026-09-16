# Plan 7 Task 1: what the three failing e2e write/revert flows actually are

`docs/superpowers/notes/2026-09-plan5-carry-forward.md` §1 recorded that
`single assign`, `bulk move` and `revert` fail on 2.43.1, with a cause nobody
had established, and offered two candidate explanations: worker-queue
contention or main-thread contention.

**The evidence supports neither.** The cause is a third thing, and it is a
real, user-facing application defect rather than a test problem:

> The app's own SQL views are created without a `cacheStrategy`, so DHIS2
> serves their data with `Cache-Control: max-age=1209600, public`. The
> browser then answers every membership read after a write from its own HTTP
> cache — for up to **two weeks** — so the app never sees the change it just
> made.

A second, compounding cause turned the first into a self-perpetuating
failure: the suite has no cleanup net (carry-forward §2), so each failure
left the shared instance in exactly the state that makes the *next* run fail
at its precondition.

Measured on `agent-gsi-p2` (2.43.1, `local_admin`), 2026-09-16.

---

## 1. What was actually observed, in order

### 1.1 The runs did not even reach the reported symptom

The first run at HEAD failed all three flows, but none of them failed the way
§1 describes. All three failed on their **preconditions**:

| Flow | Failure | Meaning |
| --- | --- | --- |
| `single assign` | `Southern Area` had `data-state="selected"`, expected `"none"` | the facility was already assigned |
| `bulk move` | Badjia's "missing" cell read `0`, expected `3` | those three objects were already in a group |
| `revert` | the `Assign` button never appeared | the facility was already assigned |

Read directly from the API, the `Area` set held exactly the leftovers those
three flows write:

```
Northern (7 members): 4 districts + Badjia, Njandama MCHP, Ngelehun CHC
Southern (4 members): 3 districts + Sembehun CHC
Western  (3 members): 3 districts
Eastern  (3 members): 3 districts
```

The seed has only the thirteen level-2 districts in this set. `Badjia`,
`Njandama MCHP` and `Ngelehun CHC` are precisely `bulk move`'s population
(`BULK_POPULATION_COUNT = 3`); `Sembehun CHC` is precisely `single assign`'s
and `revert`'s `SINGLE_FACILITY`. Every leftover was this suite's own
unreverted write.

**So the three flows were failing for two different reasons at once, and the
second was hiding the first.** Restoring the five memberships to their seed
state was step one of seeing anything real.

### 1.2 With seed state restored, the reported symptom appeared

`single assign` then failed exactly as §1 describes — the Revert dialog's own
Revert button disabled, 43 polls over 20 s, zero `/api/*` requests in the
window.

The screenshot settled the first question immediately. The dialog was **not
loading**; it had fully resolved and was displaying its own notice:

> **Nothing to revert** — Every object this change touched has since been
> reassigned by hand, so reverting it now would not change anything

`RevertDialog`'s button is `disabled={!plan || plan.affected === 0}`. So
`plan` had landed and `plan.affected === 0`. The button was **correctly**
disabled. There was never a pending promise, and therefore never anything for
either contention hypothesis to explain.

### 1.3 What the engine believed

Temporary instrumentation in `EngineStore.planRevert` (since reverted), on the
run immediately after a successful assign of `Sembehun CHC` to `Southern
Area`:

```json
{"setId":"uIuxlbV1vRT",
 "groupsInSet":[{"id":"J40PpdN4Wkk","canWrite":true},
                {"id":"jqBqIXoXpfy","canWrite":true},
                {"id":"b0EsAxm8Nge","canWrite":true},
                {"id":"nlX2VoouN63","canWrite":true}],
 "touches":[{"id":"egjrZ1PHNtT","idx":1305,"positions":[],
             "entries":[{"groupId":"jqBqIXoXpfy","wasAddition":true}]}],
 "affected":0,"skippedCount":1}
```

- the object is in the population (`idx: 1305`), so this is not a missing id;
- every group is writable, so this is not the `canWrite` branch (I2);
- `positions: []` — **the engine believes the object is in no group of the
  set at all**, immediately after a write the server had accepted.

`planRevert` is therefore right on its own terms: reverting an addition whose
object is not currently in the group is a no-op. The fault is upstream, in
what the engine was loaded with.

### 1.4 Where the stale membership came from

Instrumentation in `loadAll` logged, for each type, whether the payload came
from the IndexedDB cache or from the source, and whether it contained the
written membership:

```
loadAll {"type":"organisationUnit","source":"network","southern":false}   <- cold load, correct
loadAll {"type":"dataElement",     "source":"network","southern":false}
loadAll {"type":"indicator",       "source":"network","southern":false}
loadAll {"type":"categoryOption",  "source":"network","southern":false}
loadAll {"type":"organisationUnit","source":"network","southern":false}   <- POST-WRITE, still false
loadAll {"type":"dataElement",     "source":"cache",  "southern":false}
loadAll {"type":"indicator",       "source":"cache",  "southern":false}
loadAll {"type":"categoryOption",  "source":"cache",  "southern":false}
```

Two things to read here.

- The app's **own** caching behaved exactly as spec 4.4 intends.
  `useMembershipWrite` calls `invalidateType('organisationUnit')` after the
  write, so on the next load that one type goes to the source while the other
  three are legitimately reused from cache. That is visible in the log and it
  is correct.
- The post-write load went to the **source** and still came back without the
  membership — while `curl` against the same instance at the same moment
  returned it. The staleness was one layer below the app's cache, in the
  browser's HTTP cache.

A later probe added `sourceKind`, which named the layer:

```
loadAll {"type":"organisationUnit","source":"network","sourceKind":"sqlView", ...}
```

This instance has the `GSI_*` SQL views installed, so memberships are read
from `/api/sqlViews/<id>/data` rather than from the metadata API.

### 1.5 The header

```
$ curl -sD- .../api/sqlViews/ebmFsoPonu3/data.json?paging=false
Cache-Control: max-age=1209600, public
ETag: "0655e2ba8f010c8d01cd17bae737f92b7"
```

1 209 600 seconds is **fourteen days**, and `max-age` without
`must-revalidate` means the browser serves it without contacting the server
at all. That is why the carry-forward's "zero `/api/*` requests in that
window" looked like a worker problem: no request appears because no request
is made. The observation was real; it was a cache hit, not a stalled promise.

Where the number comes from:

```
$ curl -s .../api/sqlViews?filter=code:like:GSI&fields=code,type,cacheStrategy
GSI_ORGUNIT_MEMBERSHIPS  VIEW  RESPECT_SYSTEM_SETTING
GSI_ORGUNITS             VIEW  RESPECT_SYSTEM_SETTING
GSI_ORGUNIT_NAMES        VIEW  RESPECT_SYSTEM_SETTING

$ curl -s .../api/systemSettings/keyCacheStrategy
{"keyCacheStrategy":"CACHE_TWO_WEEKS"}
$ curl -s .../api/systemSettings/keyCacheability
{"keyCacheability":"PUBLIC"}
```

`createView` in `src/data/sources/sqlViewAdmin.ts` sends `name`, `code`,
`type`, `sqlQuery` and `sharing` — **no `cacheStrategy`** — so the server
applies its default, `RESPECT_SYSTEM_SETTING`, which defers to
`keyCacheStrategy`. `CACHE_TWO_WEEKS` is a stock value on these instances; it
was not set by hand for this test.

`SQL_VIEW_DEFINITIONS` pins `type: 'VIEW'` deliberately (a
`MATERIALIZED_VIEW` serves arbitrarily old rows with no signal). The irony is
that the unpinned `cacheStrategy` reintroduced exactly the staleness the
pinned `type` was there to prevent — one layer further out, in the browser
rather than in the database.

### 1.6 Proof by remediation

Setting `cacheStrategy` to `NO_CACHE` on the three existing views changed the
header:

```
$ curl -sX PATCH -H 'Content-Type: application/json-patch+json' \
    -d '[{"op":"replace","path":"/cacheStrategy","value":"NO_CACHE"}]' \
    .../api/sqlViews/ebmFsoPonu3
$ curl -sD- .../api/sqlViews/ebmFsoPonu3/data.json?paging=false
Cache-Control: no-cache
```

With no other change — same build, same commit, instrumentation reverted —
and the five leftover memberships restored to seed state:

```
✓ single assign: pick a group, confirm, then revert through History (6.0s)
✓ bulk move: preview counts match the result panel, then revert (5.5s)
✓ revert: History reverts a change and the object list reflects it (4.5s)
3 passed (16.9s)
```

All three pass, each reverts its own write, and the instance is left at seed
state. Before the change the same three took 25 s, 25 s and a 60 s timeout.

---

## 2. The answer to §1's question

**Neither candidate.** There is no contention of either kind, because there is
no delayed promise to explain: `planRevert` resolves promptly and correctly
reports that there is nothing to revert. The disabled button was the app
telling the truth about a stale input.

The two causes, in the order they have to be fixed:

1. **The app creates its SQL views without a `cacheStrategy`.** On any
   instance whose `keyCacheStrategy` is not `NO_CACHE`, the browser serves
   membership data from its own cache for as long as that setting says — two
   weeks here. This is user-facing: a user who fixes a group set sees their
   own change vanish on the next page load, and History offers them a Revert
   that reports "nothing to revert". It has nothing to do with the e2e suite.
2. **The suite has no cleanup net** (carry-forward §2). A flow that fails
   between its write and its revert leaves the shared instance in exactly the
   state that fails the *next* run's precondition, so one failure becomes a
   permanent one. This is what made the first cause so hard to see: the
   symptom on screen was never the symptom being investigated.

### Was it pre-existing?

Yes, and the pre-Plan-4 re-run the carry-forward proposed as step one is moot
— it would have proved nothing. Both causes are independent of Plan 4, 5 and
6:

- the missing `cacheStrategy` has been in `createView` since the SQL view
  admin code was written, and depends on the *instance's* system setting and
  on whether the `GSI_*` views happen to be installed there — which is why
  the failure looked instance-specific and version-specific. It is neither.
  It is "are the GSI views installed on this instance, and what is that
  instance's `keyCacheStrategy`".
- the missing cleanup net predates all three plans and is recorded as such.

A build from before Plan 4, run against this same instance, would have failed
the same three flows in the same way — and, because of cause 2, would have
left the instance dirtier for the next run. Nothing in the ~40 commits needed
bisecting.

### Why `bulk move` also failed on 2.40.12

Not investigated here and not explained by this. `2026-09-plan5-carry-forward.md`
§3 records a data anomaly on `agent-gsi-p2-40` — its "Northern Area" group has
0 members where `agent-gsi-p2` has 4 — which is sufficient on its own to fail
that flow's matrix assertion. That instance was not started for this task (the
plan asks for one at a time); the remaining question there is a data question,
not a caching one.

---

## 3. What this costs the later tasks

- **Task 5** can use the write flows as evidence once the fix below lands.
  They are now a genuine regression signal rather than a constant.
- **Task 8** can run at all, which it could not before.
- The user-visible half of §1's original complaint — "the user gets no
  feedback distinguishing *still working* from *stuck*" — **does not apply**.
  The dialog was not stuck and said so, in its own notice, correctly. There is
  no missing progress indicator here. What was missing was a true input.

## 4. The fix

Two layers, because either alone leaves a real gap:

1. **`cacheStrategy: 'NO_CACHE'` on every entry in `SQL_VIEW_DEFINITIONS`,**
   sent by `createView` alongside the already-pinned `type`. This fixes views
   this app creates from now on, for every client that reads them.
2. **`cache: 'no-store'` on the SQL view data reads.** Layer 1 does nothing
   for a view created by an earlier version of this app — including the ones
   on `agent-gsi-p2` right now, and on any real installation — and nothing if
   an administrator edits the view later. The app must not depend on a server
   object it does not re-check to get its own writes back.

Committed separately from this note; see the commit following it.
