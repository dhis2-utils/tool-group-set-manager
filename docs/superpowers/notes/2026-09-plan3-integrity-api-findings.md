# The DHIS2 data integrity API, measured

Measured 2026-09-11 against two live instances: `agent-gsi-p2` (2.43.1, v43
Sierra Leone seed) and `agent-gsi-p2-40` (2.40.12, V40 seed), both as a user
holding `ALL`. This note answers spec section 9's open item "exact field names
of the integrity details payload (`refs`, `comment`) across versions", and
three things the spec did not anticipate.

## 1. The check names in spec 4.5 are 2.43 names. Two of them do not exist on 2.40.

`GET /api/dataIntegrity?fields=name,code,severity,isSlow,issuesIdType&paging=false`
returns 111 checks on 2.43 and 100 on 2.40. Of the six checks spec 4.5 names:

| Spec 4.5 name (2.43) | 2.43 code | 2.40 name | 2.40 code |
|---|---|---|---|
| `org_units_not_in_compulsory_group_sets` | OUNICGS | `orgunits_compulsory_group_count` | OCGC |
| `organisation_units_violating_exclusive_group_sets` | OUVEGS | `orgunit_group_sets_excess_groups` | OGSEG |
| `data_elements_violating_exclusive_group_sets` | DEVEGS | same | DEVEGS |
| `indicators_violating_exclusive_group_sets` | IVEGS | same | IVEGS |
| `category_options_excess_groupset_membership` | COEGM | same | COEGM |
| `category_option_group_sets_incomplete` | COGSI | same | COGSI |

Neither the name nor the code is stable across the whole range:

- The compulsory check was renamed **and** recoded (OCGC → OUNICGS).
- The org unit exclusive check kept a code that means something else on 2.40:
  2.40 has its own `org_units_violating_exclusive_group_sets`, also coded
  **OUVEGS**, which is a different, `isSlow: true, isProgrammatic: true`
  check. On 2.43 that code belongs to the fast SQL check
  `organisation_units_violating_exclusive_group_sets`. Matching on the code
  alone therefore picks a slow check on 2.40 while believing it picked the
  fast one.

So the app must not hard-code either key. It resolves the checks it wants at
runtime: fetch the check list once, and for each of the app's six logical
checks take the first candidate name present on this server, in a fixed
preference order. Candidate lists are the rows above. A logical check with no
candidate present is simply absent from the overlay on that server, which is
also what happens on 2.41 and 2.42 without either being tested.

## 2. `GET` does not run anything, and blocks for as long as you let it.

`GET /api/dataIntegrity/summary?checks=...` returns `{}` — HTTP 200, an empty
object — when the checks have never been run. It is a read of a cached result,
not a trigger.

The `timeout` query parameter is a **blocking wait** in milliseconds. With
`timeout=60000` and nothing running, the request sat for the full 60 s and
then returned `{}`. With `timeout=0` it returned `{}` in 0.198 s. Read with
`timeout=0`; never let a user's page load block on this.

`POST` to the same URL starts a job and returns immediately:

```json
{"httpStatus":"OK","status":"OK","message":"Initiated DATA_INTEGRITY (…)",
 "response":{"id":"NgjGOsRPtPE","jobType":"DATA_INTEGRITY","jobStatus":"NOT_STARTED",
 "jobParameters":{"type":"SUMMARY","checks":["…"]},
 "relativeNotifierEndpoint":"/api/system/tasks/DATA_INTEGRITY/NgjGOsRPtPE"}}
```

Both versions behave identically here. "Run now" is POST, then poll the GET
with `timeout=0` until the checks appear with a newer `finishedTime`. The six
checks in the table took well under a second each on the Sierra Leone seed
(`averageExecutionTime` 9–38 ms), but two of them are `isSlow` on 2.40, and
spec 4.5's caution about minute-long runs stands for large instances.

## 3. A summary entry carries its own run time and count.

Fields present on both versions, on each check object keyed by check name:
`name`, `displayName`, `section`, `severity`, `description`, `issuesIdType`,
`isSlow`, `isProgrammatic`, `code`, `averageExecutionTime`, `startTime`,
`finishedTime`, `count`, `percentage`. `finishedTime` is what spec 4.5 wants
labelled on every number.

## 4. The details payload names the object, and describes the groups in prose.

This is the open item, and the answer is that neither field can be parsed.

**2.43** (`refs`, an array of strings):

```json
{"id":"roQ2l7TX0eZ","name":"SLRCS (Bo) Clinic",
 "refs":["ougs_name: Facility Ownership; ougs_id: Bpx0589u8y0; groups: [oug_uid: oRVt7g429ZO; oug_name: Public facilities, oug_uid: PVLOW4bCshG; oug_name: NGO]"]}
```

**2.40** (`comment`, a single string):

```json
{"id":"sK498nBOLfQ","name":"Elshadai MCHP",
 "comment":"Facility Ownership :(Public facilities; Private Clinic)"}
```

A check with nothing to say about groups (the compulsory check, both versions)
carries neither field: `{"id":"Rp268JB6Ne4","name":"Adonkia CHP"}`.

Both formats are human prose with a version-specific shape, and the 2.43 one
embeds ids only incidentally. **The app keys on `id` and nothing else.** It
already knows every group every object is in — that is what the engine is —
so the group references in these strings are redundant, and parsing them would
buy a second, worse copy of data the app holds exactly. Render the string
verbatim as a secondary line if it is present (prefer `refs.join(' ')`, else
`comment`, else nothing) and never read meaning out of it.

## 5. Counts are national; the app filters.

Neither endpoint takes an org unit parameter. The 2.43 instance reported 272
objects for the compulsory check and 17 for the exclusive one, against the
whole hierarchy. Scoping is the app's job, through its own hierarchy index,
exactly as spec 4.5 says. The two instances agree on those two numbers
(272 / 17) despite the different check names, which is the cross-version
sanity check to keep.

## 6. Authority

`GET /api/me?fields=id,authorities` returns `{"id":"…","authorities":["ALL"]}`
on both versions. The overlay is gated on `ALL` or `F_PERFORM_MAINTENANCE`
being present in that array. A user without it never sees the overlay and the
app never calls these endpoints for them; a 403 from either endpoint is
treated the same way as the authority being absent — the overlay is
unavailable, and the engine's numbers, which are the source of truth
regardless, carry the screen alone.
