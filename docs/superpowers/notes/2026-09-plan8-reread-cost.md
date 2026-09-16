# Plan 8 Task 1: what the pre-write re-read costs

Spec 2026-09-16 section 5.4 names the cost of re-reading a plan's groups
(every group named in a "move to catch-all" bulk fix, read sequentially, the
way the app will) as the one unmeasured risk that must be settled before
Task 9 wires a pre-write freshness check into the bulk-fix Apply path. This
measures it directly against `scripts/perf/reread-cost.js`.

## Instance

`agent-gsi-emis`, DHIS2 2.41, 266,396 organisation units. Started via the
broker, measured alone (all three other broker instances confirmed
`stopped` throughout, checked again after the run), stopped again at the
end. No other instance and no other load was running on the host during
these measurements.

## Raw measurements

Each set run twice, sequentially, in the order the brief gives (largest
first).

### Geo-Political Zone (`Ibw8YdnSCJq`, 6 groups)

| run | seconds | totalIds | secondsPerGroup |
|---|---|---|---|
| 1 | 9.669 | 211,299 | 1.612 |
| 2 | 6.251 | 211,299 | 1.042 |

### School Level (`kqEaTzvdL6D`, 4 groups)

| run | seconds | totalIds | secondsPerGroup |
|---|---|---|---|
| 1 | 10.760 | 221,652 | 2.690 |
| 2 | 4.922 | 221,652 | 1.231 |

### Location Rural/Urban (`K2HBmy0JOC2`, 2 groups)

| run | seconds | totalIds | secondsPerGroup |
|---|---|---|---|
| 1 | 3.866 | 97,264 | 1.933 |
| 2 | 2.086 | 97,264 | 1.043 |

## Run-to-run disagreement

All three sets disagree between their two runs by well over the ~30%
threshold that flags a distorted measurement rather than genuine cost:

- Geo-Political Zone: 9.669s vs 6.251s (run 1 is 1.55x run 2)
- School Level: 10.760s vs 4.922s (run 1 is 2.19x run 2)
- Location Rural/Urban: 3.866s vs 2.086s (run 1 is 1.85x run 2)

This is reported rather than averaged away, per the instruction that a
previous measurement on this host was once distorted 2.4x by competing
load. That specific cause is ruled out here: `GET /instances` was checked
before starting and again after all six runs, and only `agent-gsi-emis`
was ever `running`. The pattern instead looks like a straightforward
cold/warm effect internal to the DHIS2 server or its JVM/database caches:
run 1 is always slower than run 2 for the same set, and run 1 for the very
first set measured (Geo-Political Zone) is the run immediately after
startup. Whatever the mechanism, the numbers themselves stand: this is the
real spread this instance produces, not a single slow outlier to discard.

## Verdict

**Over ~6s. Stop and report; do not proceed to Task 9 with a workaround.**

Reasoning: the brief's three bands are evaluated against the worst case a
bulk fix can produce — every group in a set, unfiltered, which is exactly
what these runs measure. Two of the three sets tested have at least one
run at or above 6 seconds (Geo-Political Zone: 9.669s and 6.251s; School
Level: 10.760s and 4.922s), and the fastest run recorded for the largest
set (Geo-Political Zone, run 2) is itself 6.251s — already past the
threshold, not comfortably inside it. Only the smallest set (Location
Rural/Urban, 2 groups) stays under 6s on both runs, and its slower run
(3.866s) is still well above the 2s "no progress indicator needed" band.
There is no reading of this data — fast run, slow run, or the pair
together — that puts the largest, most representative sets under 6
seconds. Given that a national-scale group set can run to hundreds of
thousands of members across just a handful of groups, and that "move to
catch-all" is not a rare or edge-case bulk-fix shape, wiring in the
pre-write re-read as specified in spec 5.1 would put a multi-second (and
sometimes double-digit-second) block on the Apply button with no
mitigation defined for that band.

Per spec 5.4's own ladder, this means section 5.1's design needs
revisiting before Task 9 proceeds — for example, reading only the groups
with *deletions* in the plan rather than every named group, or checking
counts before reading ids — rather than shipping the re-read as specified
behind a progress indicator alone.

## Files

- `scripts/perf/reread-cost.js` — the measurement script, kept in the
  repository so a future run is a re-run rather than a re-implementation.
