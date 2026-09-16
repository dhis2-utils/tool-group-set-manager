# Plan 7 Task 2: three bulk write shapes, measured

Spec `2026-09-15-manual-review-1-design.md` §6.2 asks for elapsed time **and**
server-side cost for three ways of writing a large membership change, before
any of them is adopted. This note is the measurement. It deliberately stops
short of the §6.4 decision — Task 4 makes that, with Task 3's concurrency
guard answer in hand.

Driver: `scripts/perf/write-shapes.js` (committed, so a future run is a re-run
rather than a re-implementation).

---

## 1. What was measured, and on what

| | |
| --- | --- |
| Instance | `agent-gsi-emis`, DHIS2 **2.41.10**, 266,396 organisation units |
| Target group | `Basic Education` (`O1hqU8q6iea`), in the `School Level` group set |
| Population per run | **91,892** memberships |
| Date | 2026-09-16 |
| Concurrency | one broker instance running; nothing else driving the API |

91,892 is the largest single group on the instance, and the closest available
to the 77,017 objects §6.1 extrapolates from — so it is the honest worst case
rather than a flattering one. Where this note compares against §6.1's budget
it scales the measured figure down to 77,017 and says so.

Every run starts from the **same** state: the group emptied, then filled with
the captured member list. So each shape does the same 91,892 inserts, and the
numbers are comparable to each other.

Each run also **reads the membership back** afterwards and reports
`complete: true` only when the group really holds all 91,892. A shape that
finished fast because it quietly did less is the one thing a timing alone
cannot show. All seven runs completed in full.

### The three shapes

1. **`batched`** — today's path. Sequential `POST
   organisationUnitGroups/<id>/organisationUnits` collection updates,
   `batchSize` ids each. Additive: it sends a delta, never a whole collection.
2. **`import`** — one `POST metadata?importStrategy=UPDATE` carrying the
   group's **complete** intended member list.
3. **`import-async`** — the same payload with `async=true`, then polling
   `system/tasks/METADATA_IMPORT/<id>` once a second until the job reports
   completion.

### How server-side cost was measured

§6.2 asks for server-side cost, and the plan suggested sampling
`docker stats` on the Tomcat and Postgres containers. **That was not available:
the sandbox has no access to the host's Docker daemon** (`docker: command not
found`, and it is the host's daemon, not one this container could reach). The
instance's PostgreSQL *is* reachable on dev-net, so cost is taken from
`pg_stat_database` deltas across each run instead:

```sql
select xact_commit, tup_inserted, tup_updated, tup_deleted,
       tup_fetched, blks_read, blks_hit
from pg_stat_database where datname='dhis2'
```

This is a substitution, and it should be read as one. What is lost: Tomcat's
own CPU, JVM garbage collection, and anything the application server does that
never reaches the database. What is gained, and why it is arguably the better
instrument for *this* comparison: §6.1's own diagnosis is that "the dominant
cost is DHIS2 re-evaluating the whole collection on every write" — that
re-evaluation **is** database work, and these counters measure it directly and
exactly, rather than inferring it from a container CPU percentage sampled
every two seconds.

---

## 2. The seven runs

| # | shape | batch | seconds | requests | rows inserted | rows fetched | buffer hits | buffer reads | commits |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | `import` | — | **18.2** | 2 | 91,892 | 283,997 | 1,713,532 | 13 | 31 |
| 2 | `import-async` | — | 22.2 | 21 | 91,892 | 377,248 | 2,079,090 | 5,439 | 113 |
| 3 | `batched` | 5000 | **47.4** | 20 | 91,892 | 1,789,883 | 5,872,166 | 11,079 | 134 |
| 4 | `batched` | 1000 | 192.0 | 93 | 91,892 | 5,152,181 | 9,326,676 | 5,878 | 560 |
| 5 | `batched` | 250 | 822.6 | 369 | 91,892 | 36,525,519 | 96,295,511 | 4,762 | 2,213 |
| 6 | `import` (repeat of best) | — | 20.3 | 2 | 91,892 | 435,686 | 2,280,294 | 0 | 36 |
| 7 | `batched` (repeat of worst) | 250 | 1997.5 | 369 | 91,892 | 34,610,290 | 94,383,466 | 8,325 | 2,230 |

Run 4 is **today's shipped default** (`writeMemberships`'s `batchSize = 1000`).

### Normalised, which is where the shapes separate

"Rows fetched per object written" is the clearest single number here: it is
how many rows the database had to read to place **one** membership.

| shape | batch | s / request | rows fetched **per object** | buffer hits **per object** |
| --- | --- | ---: | ---: | ---: |
| `import` | — | 9.09 | **3.1** | 18.6 |
| `import` (repeat) | — | 10.15 | 4.7 | 24.8 |
| `import-async` | — | 1.06 | 4.1 | 22.6 |
| `batched` | 5000 | 2.37 | 19.5 | 63.9 |
| `batched` | 1000 | 2.06 | 56.1 | 101.5 |
| `batched` | 250 | 2.23 | 397.5 | 1,047.9 |
| `batched` (repeat) | 250 | 5.41 | 376.6 | 1,027.1 |

---

## 3. Apparent server load

This is the part §6.2 says decides a close race, and it is not close.

**The batched endpoint's cost per membership rises sharply as the batch gets
smaller, and it is the re-reading that grows, not the writing.** Every run
inserts exactly 91,892 rows — that is the work the user asked for, and it is
constant. What changes is how many rows the server *reads* to do it:

- `import`: **3.1** rows fetched per object written
- `batched` @ 5000: **19.5** — 6.3× the import
- `batched` @ 1000: **56.1** — 18× the import (and this is today's default)
- `batched` @ 250: **397.5** — **128× the import**

That is §6.1's hypothesis confirmed directly, and quantified. DHIS2 re-reads
the group's collection on every collection write, so halving the batch size
roughly doubles the number of times the whole collection is re-read. At batch
250 the server fetched **36.5 million rows** and touched **96.3 million buffer
pages** to insert 91,892 memberships. The import did the same job with 284,000
rows fetched and 1.7 million buffer pages — **two orders of magnitude less
work for an identical result.**

Transaction counts tell the same story from another angle: 31 commits for the
import, 2,213 for `batched` @ 250. Each batch is its own transaction, with its
own overhead.

**Buffer reads (actual disk I/O) are small and noisy everywhere** — 0 to
11,079 across all runs, against millions of buffer hits. The working set fits
in PostgreSQL's cache on this instance, so this comparison is about CPU and
memory bandwidth, not disk. Run 3's 11,079 reads is the highest and run 6's
zero the lowest, and they are not in shape order; this column should not be
read as a ranking.

### The one rate figure that needs a caveat

Runs 5 and 7 are the same shape, the same batch size, the same population, and
they did the same amount of database work — 397.5 vs 376.6 rows fetched per
object, a 5% difference. But run 5 took 822.6s and run 7 took **1997.5s**, 2.4×
longer.

**That spread is my own doing, and it should not be read as instability in the
shape.** Run 7 was deliberately backgrounded so that Tasks 6 and 7 could
proceed, so it overlapped with several `pnpm test` runs, a `tsc` pass and an
`i18n extract` — all on the same host the DHIS2 and PostgreSQL containers run
on. The signature is unambiguous: the *work* was constant (same rows fetched
per object) while the *rate* halved (44,401 → 17,327 rows fetched per second).
That is contention for CPU, not a different amount of work.

The honest reading of runs 5 and 7 together is therefore:

- **the work each shape costs the server is highly reproducible** — that is
  the column to decide on, and it varies by two orders of magnitude between
  shapes;
- **wall-clock time is contention-sensitive**, which is itself an argument
  against the expensive shapes: on a busy production server, the shape that
  costs 128× more work is the one whose elapsed time degrades first, and it
  degrades for every other user of that server at the same time.

Runs 1 and 6 (`import`, 18.2s and 20.3s, ~11% apart) are the clean repeat pair,
and they were not run under contention.

---

## 4. Against §6.1's budget

§6.1 states a budget of "roughly 60 seconds" for a bulk apply over the EMIS
population of **77,017** objects. Scaling the measured figures from 91,892
down to 77,017:

| shape | batch | measured @ 91,892 | scaled to 77,017 | within ~60s? |
| --- | --- | ---: | ---: | :--- |
| `import` | — | 18.2s | **15.3s** | yes, comfortably |
| `import-async` | — | 22.2s | 18.6s | yes |
| `batched` | 5000 | 47.4s | **39.7s** | **yes** |
| `batched` | 1000 | 192.0s | 160.9s | no — 2.7× over |
| `batched` | 250 | 822.6s | 689.4s | no — 11× over |

Two findings worth stating plainly, because both differ from what §6.1
assumed:

1. **§6.1's estimate was pessimistic.** It projected "8–12 minutes as 79
   sequential collection updates at 6–9 seconds each". Measured, the collection
   endpoint costs ~2.1s per request at batch 1000, not 6–9s, and today's
   default finishes in **3.2 minutes**, not 8–12. The complaint behind §6.1 is
   still valid — 3.2 minutes is far outside a 60-second budget — but the
   starting point is better than recorded.
2. **The batched endpoint does meet the budget, at batch 5000.** §6.1 framed
   the problem as one that app-side batching could not solve ("which is why
   app-side micro-optimisation is not on the list of shapes"). On this
   evidence that framing is wrong: simply sending 5× more ids per request is a
   4× speedup that lands inside the budget, and it is a one-number change to
   an existing, additive code path.

---

## 5. Rejections, refusals and other findings of equal weight

§6.2 asks for these to be recorded as plainly as a timing.

- **No shape was rejected by the server.** No payload size limit, no proxy
  timeout, no 413, no 500. The import shape's body carries all 91,892 ids
  (~1.3 MB of JSON) and was accepted without special handling. Batch 5000 was
  accepted equally.
- **`import-async` is slower *and* costlier than the synchronous import**
  (22.2s vs 18.2s; 21 requests vs 2; 5,439 buffer reads vs 13). Its one-second
  poll interval accounts for some of the extra wall-clock, but not the extra
  database work. It buys nothing here: the synchronous import already returns
  in 18 seconds, which needs no job queue to stay responsive. Its case would be
  a payload large enough to exceed a request timeout, which this one is not
  close to.
- **The import shape replaces the whole collection**, which is why §6.3 gates
  it on a concurrency guard. That is Task 3's subject, not measured here —
  but note that it is the reason the fastest and cheapest shape is not
  automatically the winner.
- **The restore between runs is not neutral, and uses a shape under test.**
  `write-shapes.js restore` is a metadata import. It was chosen because it is
  the only shape fast enough to run before each of seven runs, and because a
  restore's cost never falls inside a measured interval — the timer starts
  after it returns. But it does mean this harness cannot measure the import
  shape on an instance where the import shape is broken, and a future run
  investigating an import-specific fault should not use it to set up.
- **`tup_updated` is tiny everywhere** (4–373 rows). The collection write is
  genuinely an insert into the join table, not a rewrite of the group row —
  which is consistent with 2.43 not bumping the group's `lastUpdated` on a
  collection write (Task 3).

---

## 6. Summary, without the decision

- **Cheapest by a wide margin:** `import` — 3.1 rows fetched per object.
- **Fastest:** `import` — 18.2s, ~15.3s at §6.1's population.
- **Fastest shape needing no concurrency guard:** `batched` @ 5000 — 47.4s,
  ~39.7s at §6.1's population, inside the ~60s budget, at 19.5 rows fetched
  per object (6.3× the import, and 2.9× cheaper than today's default).
- **Today's default,** `batched` @ 1000, meets neither the budget (160.9s) nor
  the load comparison (56.1 rows fetched per object).
- **Worst on every axis:** `batched` @ 250. Smaller batches are not gentler on
  the server; they are dramatically worse, because the per-write collection
  re-read dominates.

The §6.4 decision — which of these to adopt, and on which versions — is
Task 4's, and it needs Task 3's per-version answer on whether the import
shape's concurrency guard can actually be built. See
`2026-09-plan7-lastupdated-guard.md`.

---

## 7. Conclusion (Task 4)

Added after `2026-09-plan7-lastupdated-guard.md` answered the guard question.
The four rules of §6.4's decision procedure, applied in order and against the
numbers above rather than against whichever looked best.

### Rule 1 — a shape whose guard cannot be built on a version is disqualified there

`2026-09-plan7-lastupdated-guard.md`: the guard can be built on **2.40 only**.
On 2.41, 2.42 and 2.43 a group's `lastUpdated` does not move on a
collection-endpoint membership write, and `~size` does not move on an
equal-sized swap — so both available signals are blind to exactly the
concurrent edit the guard exists to catch, including one made by another user
of this app through its own batched write path.

**`import` and `import-async` are therefore disqualified on 2.41, 2.42 and
2.43.** They survive on 2.40 alone. Rule 1 does not eliminate them entirely,
so the procedure continues — but it has already ruled out adopting either as
*the* write path.

### Rule 2 — a shape that buys speed with server load loses

This rule does not eliminate anything, because the fastest shape is also the
cheapest: `import` is both quickest (18.2s) and lightest (3.1 rows fetched per
object). There is no speed-for-load trade to reject here.

Where rule 2 does bite is on the batched sizes among themselves, and it
sharpens the choice within Branch A: batch 5000 is 4× faster than today's
1000 **and** 2.9× cheaper per object (19.5 vs 56.1 rows fetched). It is better
on both axes at once, so nothing is being bought with load.

### Rule 3 — if the batched endpoint meets the budget at some batch size, adopt it

It does. **Batch 5000: 47.4s measured over 91,892 objects, ~39.7s scaled to
§6.1's stated 77,017.** Inside the ~60-second budget with room to spare.

Rule 3 says to adopt it, and gives the reasons: no guard, no new code path, no
per-version branching, and the simplest thing that meets the budget wins.
Every one of those holds here, and the guard clause is not a formality — rule
1 has just established that the guard is unbuildable on three of four
supported versions.

**The decision is Branch A: `writeMemberships`'s default batch size moves from
1000 to 5000.**

### Rule 4 — if nothing meets the budget, say so

Does not apply. Something meets it.

### Why each loser lost

- **`import-async`** lost on every axis and needed no veto: slower than the
  synchronous import (22.2s vs 18.2s), more requests (21 vs 2), more database
  work (377k rows fetched vs 284k). Its only argument is avoiding a request
  timeout, and an 18-second request is not near one.
- **`import`** lost on **rule 1**, not on its numbers, which are the best of
  the seven runs. This is worth stating plainly because it is the
  uncomfortable outcome: the fastest and by far the cheapest shape is being
  left on the table for a correctness reason. §6.3 anticipated exactly this
  and settled it in advance — "where it cannot be proven, the batched endpoint
  stays the write path on that version whatever the timings say" — and the
  measurement did not change that calculus, it confirmed it.
  Adopting it only on 2.40 (Branch C) would mean a second write path, a
  concurrency guard, and a version selector, all to save ~25 seconds on the
  **oldest** supported version — the one least likely to be running a
  national-scale population, and the one whose users will upgrade away from
  the special case. Rule 3's "the simplest thing that meets the budget wins"
  is the right call here, not a shortcut.
- **`batched` @ 1000** — today's default — lost to `batched` @ 5000 on both
  axes: 4× slower and 2.9× more server work per object. It does not meet the
  budget (160.9s scaled).
- **`batched` @ 250** lost decisively and is the clearest single result in the
  table: 397.5 rows fetched per object, 128× the import, 11× over the budget.
  If there was ever an instinct that smaller batches are kinder to a shared
  server, this is the measurement that retires it.

### What the user should now expect

A bulk fix over a national-scale population (~77,000 objects) takes **roughly
40 seconds**, not the 8–12 minutes §6.1 projected and not the 3.2 minutes it
actually took before this change. That is a real number measured on a real
266,396-org-unit instance, and it is honest about its conditions: it was
measured with nothing else driving the API. Run 7 showed what contention does
to wall-clock (2.4× on an unchanged workload), so on a busy production server
this will be slower — which is itself the argument for the shape that asks the
server for 2.9× less work than the one it replaces.
