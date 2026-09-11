# Plan 1: compatibility across DHIS2 versions and databases

The app was run end to end against four databases across four DHIS2 versions.
Every number on screen was reconciled against the instance's own API, rather
than being read off the screen and believed.

**Result: all six checks pass. No number failed to reconcile anywhere.**

| DHIS2 | Database | Scale | Result |
| --- | --- | --- | --- |
| 2.40.12 | Sierra Leone demo | 1,332 org units | Pass |
| 2.41.10 | Nigeria EMIS metadata | 266,396 org units | Pass |
| 2.42.6 | EHR metadata | 8 org unit group sets, no sets of the other three types | Pass |
| 2.42.6 | Sierra Leone demo | 1,332 org units | Pass |
| 2.43.1 | Laos HMIS demo | 36 org unit and 39 category option group sets | Pass |
| 2.43.1 | Sierra Leone demo | 1,332 org units | Pass |

## The result that matters most

The Sierra Leone database was checked on 2.40, 2.42 and 2.43. All three report
Facility Ownership as **15 conflicts, 230 uncategorised and 1,087 correct**, and
name the same fifteen Bo district facilities. The 2.42 run computed those numbers
from the API before opening the app at all. The same data gives the same answers
three DHIS2 versions apart.

## What each database exercised that the others did not

- **EMIS** is the scale case the architecture exists for. Ownership reconciled at
  0 conflicts and 0 missing across 266,396 org units, which is correct: its three
  groups hold 136,538, 129,853 and 5 members, summing exactly to the total. One
  state subtree of 34,491 org units reconciled column by column.
- **EHR** is metadata only, with group sets for one object type and none for the
  other three. It also holds the most group-heavy compulsory set tested anywhere,
  at 18 groups, whose conflict drill-down was verified object by object.
- **Laos** has a category option group set that is entirely empty, which renders
  as zeros rather than as an error.
- **Sierra Leone** carries the conflicts the app was built to find.

## What the campaign changed

Two findings, both fixed in commit 8566520:

- The organisation unit levels query disabled paging, which DHIS2 warns about on
  every version and intends to stop supporting. It now requests an explicit page
  size.
- Filtering the dashboard to an object type with no group sets showed a blank
  area with no explanation. It now says there are none.

## Version-specific observations

- 2.43 adds `corsAllowlist` alongside the older `corsWhitelist`, and its app shell
  requests a custom translations endpoint that returns 404. Neither is this app.
- The DHIS2 app shell's own logo request 404s on every version tested.
- No group set property, field expansion or access flag the app depends on
  changed shape between 2.40 and 2.43.

## Reproducing this

Per-run reports, including how a browser is authenticated against a disposable
DHIS2 instance in the sandbox, were written during the campaign. The procedure
section of the 2.40 report is the one to start from.
