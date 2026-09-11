# Write-path compatibility: DHIS2 2.40 vs 2.43

Plan 1 proved the read paths across 2.40–2.43 and found no difference. This
task does the same for every write the app makes: bulk membership changes
(including the silent-drop-of-invalid-ids behaviour the whole reconciliation
design in `src/data/writes.ts` rests on), creating a group and adding it to a
set, the `compulsory`/`dataDimension` JSON patch, dataStore CRUD, and
creating the three GSI SQL views — each exercised on both versions with the
actual request and the actual response recorded below, not a summary of
them. Step 4 (fix a conflict via the dialog, revert it from History, confirm
the numbers return) was then run end to end through the real app UI against
both instances.

**Bottom line: 2.40.12 supports every write the app makes.** One real
behavioural difference was found (`lastUpdated` on a membership write — see
below); it does not affect correctness because the app never relies on
`lastUpdated` for its own writes, only for detecting *external* edits when
deciding whether its cache is stale. Everything else agreed exactly between
the two versions.

Instances: 2.40.12 at `http://dhis2-agent-gsi-p2-40:8080`, 2.43.1 at
`http://dhis2-agent-gsi-p2:8080`, both `local_admin`/`district`, both
Sierra Leone demo. All test writes were reverted afterward; both instances
were verified clean of leftover test objects at the end of the session
(final API checks below).

## 1. Bulk membership write: additions, deletions, and an invalid id

Request in both columns:
`POST /api/organisationUnitGroups/MAs88nJc9nL/organisationUnits` with
`Content-Type: application/json` and body
`{"additions":[{"id":"Rp268JB6Ne4"}],"deletions":[{"id":"uROAmk9ymNE"}]}`.

| | 2.40.12 | 2.43.1 |
|---|---|---|
| Valid add+delete | `{"httpStatus":"OK","httpStatusCode":200,"status":"OK","response":{"responseType":"TypeReport","status":"OK","stats":{"created":0,"updated":1,"deleted":1,"ignored":0,"total":2},"objectReports":[]}}` | `{"httpStatus":"OK","httpStatusCode":200,"status":"OK","response":{"status":"OK","stats":{"created":0,"updated":1,"deleted":1,"ignored":0,"total":2},"objectReports":[],"responseType":"TypeReport"}}` |
| Membership after (`GET .../organisationUnitGroups/MAs88nJc9nL.json?fields=organisationUnits[id,name]`) | `{"organisationUnits":[{"name":"Bucksal Clinic","id":"vRC0stJ5y9Q"},{"name":"Fatibra CHP","id":"jfV49JGnYKF"},{"name":"UNIMUS MCHP","id":"UugO8xDeLQD"},{"name":"Massah Memorial Maternity MCHP","id":"ptc0SQi05E4"},{"name":"Needy CHC","id":"UOJlcpPnBat"},{"name":"Adonkia CHP","id":"Rp268JB6Ne4"},{"name":"Sam Lean's MCHP","id":"H0OkaM4ReRK"},{"name":"Elshadai MCHP","id":"sK498nBOLfQ"},{"name":"Kpolies Clinic","id":"bM4Ky73uMao"},{"name":"Holy Mary Hospital","id":"jk1TtiBM5hz"},{"name":"Lyn Maternity MCHP","id":"k6DIO9LIEk9"}]}` — `Rp268JB6Ne4` (the addition) present, `uROAmk9ymNE` (the deletion) absent, 11 entries | `{"organisationUnits":[{"name":"Bucksal Clinic","id":"vRC0stJ5y9Q"},{"name":"Fatibra CHP","id":"jfV49JGnYKF"},{"name":"UNIMUS MCHP","id":"UugO8xDeLQD"},{"name":"Massah Memorial Maternity MCHP","id":"ptc0SQi05E4"},{"name":"Needy CHC","id":"UOJlcpPnBat"},{"name":"Adonkia CHP","id":"Rp268JB6Ne4"},{"name":"Sam Lean's MCHP","id":"H0OkaM4ReRK"},{"name":"Elshadai MCHP","id":"sK498nBOLfQ"},{"name":"Kpolies Clinic","id":"bM4Ky73uMao"},{"name":"Holy Mary Hospital","id":"jk1TtiBM5hz"},{"name":"Lyn Maternity MCHP","id":"k6DIO9LIEk9"}]}` — byte-identical to the 2.40 column |
| Reverted back to the seed's 11 members (`GET` after the matching reverse batch) | `{"organisationUnits":[{"name":"Kindoyal Hospital","id":"uROAmk9ymNE"},{"name":"Bucksal Clinic","id":"vRC0stJ5y9Q"},{"name":"Fatibra CHP","id":"jfV49JGnYKF"},{"name":"UNIMUS MCHP","id":"UugO8xDeLQD"},{"name":"Massah Memorial Maternity MCHP","id":"ptc0SQi05E4"},{"name":"Needy CHC","id":"UOJlcpPnBat"},{"name":"Sam Lean's MCHP","id":"H0OkaM4ReRK"},{"name":"Elshadai MCHP","id":"sK498nBOLfQ"},{"name":"Kpolies Clinic","id":"bM4Ky73uMao"},{"name":"Holy Mary Hospital","id":"jk1TtiBM5hz"},{"name":"Lyn Maternity MCHP","id":"k6DIO9LIEk9"}]}` | Byte-identical to the 2.40 column |

**No difference found.** Same envelope shape (`response.stats` with
`created`/`updated`/`deleted`/`ignored`/`total`), same field order
notwithstanding (JSON key order is not significant and the app never relies
on it), same values, same effect.

## 2. An invalid id in the same batch is silently dropped on both versions

Request: `POST .../organisationUnitGroups/MAs88nJc9nL/organisationUnits`
with `{"additions":[{"id":"Rp268JB6Ne4"},{"id":"zzzINVALIDID0"}],"deletions":[]}`
— one real id, one that does not exist.

| | 2.40.12 | 2.43.1 |
|---|---|---|
| Response | `{"httpStatus":"OK","httpStatusCode":200,...,"stats":{"created":0,"updated":1,"deleted":0,"ignored":0,"total":1},"objectReports":[]}` | `{"httpStatus":"OK","httpStatusCode":200,...,"stats":{"created":0,"updated":1,"deleted":0,"ignored":0,"total":1},"objectReports":[],...}` |
| Verified via GET (`fields=organisationUnits[id,name]`) | `{"organisationUnits":[{"name":"Kindoyal Hospital","id":"uROAmk9ymNE"},{"name":"Bucksal Clinic","id":"vRC0stJ5y9Q"},{"name":"Fatibra CHP","id":"jfV49JGnYKF"},{"name":"UNIMUS MCHP","id":"UugO8xDeLQD"},{"name":"Massah Memorial Maternity MCHP","id":"ptc0SQi05E4"},{"name":"Needy CHC","id":"UOJlcpPnBat"},{"name":"Adonkia CHP","id":"Rp268JB6Ne4"},{"name":"Sam Lean's MCHP","id":"H0OkaM4ReRK"},{"name":"Elshadai MCHP","id":"sK498nBOLfQ"},{"name":"Kpolies Clinic","id":"bM4Ky73uMao"},{"name":"Holy Mary Hospital","id":"jk1TtiBM5hz"},{"name":"Lyn Maternity MCHP","id":"k6DIO9LIEk9"}]}` — 12 entries: the real id (`Rp268JB6Ne4`) and the pre-existing `uROAmk9ymNE` both present, the bogus id nowhere, no error anywhere in the create response | `{"organisationUnits":[{"name":"Kindoyal Hospital","id":"uROAmk9ymNE"},{"name":"Bucksal Clinic","id":"vRC0stJ5y9Q"},{"name":"Fatibra CHP","id":"jfV49JGnYKF"},{"name":"UNIMUS MCHP","id":"UugO8xDeLQD"},{"name":"Massah Memorial Maternity MCHP","id":"ptc0SQi05E4"},{"name":"Needy CHC","id":"UOJlcpPnBat"},{"name":"Adonkia CHP","id":"Rp268JB6Ne4"},{"name":"Sam Lean's MCHP","id":"H0OkaM4ReRK"},{"name":"Elshadai MCHP","id":"sK498nBOLfQ"},{"name":"Kpolies Clinic","id":"bM4Ky73uMao"},{"name":"Holy Mary Hospital","id":"jk1TtiBM5hz"},{"name":"Lyn Maternity MCHP","id":"k6DIO9LIEk9"}]}` — byte-identical to the 2.40 column |

**No difference found — this is the finding that matters most, and it holds.**
Both versions return **200 OK** with `stats.total` reflecting only the ids
that were actually valid, and neither names the rejected id anywhere in the
response. `acceptedCount()` in `src/data/writes.ts` sums
`created+updated+deleted+ignored` from `response.stats` and compares it
against `requested` (the number of ids sent); on 2.40 that comparison
produces exactly the same partial-failure signal (`accepted=1,
requested=2`) that it does on 2.43. The reconciliation design that disowns a
short batch rather than trusting HTTP status works identically on the app's
stated floor.

## 3. The import-report envelope (`response.stats`) — the second most
important check

Already shown above: both versions place the same four counters at
`response.stats.{created,updated,deleted,ignored}`, and `response.stats` is
present on every response tested (valid batch, partial batch, group create,
group-to-set add, SQL view create). `acceptedCount()` reading `body?.response?.stats`
never falls through to the "absent stats → 0 accepted" branch on either
version for any write this app makes.

**No difference found.** The worst-case scenario this task was written to
rule out — 2.40 shaping the envelope differently and the app disowning
every batch it actually applied — does not happen.

## 4. Does a membership write bump the group's `lastUpdated`? — the one real difference

Isolated test: read a group's `lastUpdated`, add one member, re-read.

| | 2.40.12 | 2.43.1 |
|---|---|---|
| Before | `"lastUpdated":"2026-09-11T15:07:58.575"` | `"lastUpdated":"2012-11-13T14:36:32.497"` |
| After one membership add | `"lastUpdated":"2026-09-11T15:08:07.792"` — **changed** | `"lastUpdated":"2012-11-13T14:36:32.497"` — **unchanged** |
| After the matching delete (restoring original membership) | `"lastUpdated":"2026-09-11T15:08:08.259"` — changed again | unchanged |

**Difference found: 2.40 bumps the group's `lastUpdated` on a membership
write; 2.43 does not.** This is the opposite of what
`2026-09-plan2-write-api-findings.md` documented for 2.43 alone, and 2.40
disagrees with it.

**This does not put the app's floor claim at risk.** The app's own writes
never rely on `lastUpdated` to detect their own effect — `writeMemberships`
already invalidates exactly what it changed rather than trusting the stamp
(see the doc comment on `writeMemberships` and finding 3 in the prior write
API findings doc), precisely because 2.43 was known not to bump it. The only
place `lastUpdated` is read for group sets is the app's own cache-validity
check for edits made by *other* tools (Maintenance app, a script, etc.). On
2.40, that check would actually be a little stricter than on 2.43 for the
narrow case of an external tool making a bare membership-collection edit —
it would catch it, where on 2.43 it would not. That is a strictly safer
direction in terms of correctness (more cache invalidation, never less), so
it needs no code change.

**The cost side, which correctness alone doesn't capture:** on 2.40, *any*
bare membership write by *anyone* bumps the group's stamp, so `tryCache`'s
per-group comparison fails and the type reloads on the next load for every
user, not just the one who wrote it. A 2.40 instance will therefore rebuild
its cache more often than an otherwise-identical 2.43 instance under the
same editing traffic — on a small instance like this Sierra Leone seed that
is unmeasurable, but on something Nigeria-EMIS-sized (see the load-time
figures in `2026-09-plan2-write-api-findings.md` finding 4) frequent
external edits would mean frequent full-type reloads that a 2.43 instance
would not pay. That is a real operating cost of running on 2.40, not a
correctness defect, and it needs no code change either — just this record.

## 5. Adding a group to a set: endpoint, header requirement, group creation

Request: `POST /api/organisationUnitGroups` (create) then
`POST /api/organisationUnitGroupSets/Bpx0589u8y0/organisationUnitGroups/<id>`
(add to set), both with `Content-Type: application/json`.

| | 2.40.12 | 2.43.1 |
|---|---|---|
| `POST /api/organisationUnitGroups` `{"name":"GSI Fix1 Probe","shortName":"GSI Fix1 Probe"}` | `201 {"httpStatus":"Created","httpStatusCode":201,"status":"OK","response":{"responseType":"ObjectReport","uid":"S4FNVUsy6A8","klass":"org.hisp.dhis.organisationunit.OrganisationUnitGroup","errorReports":[]}}` | `201 {"httpStatus":"Created","httpStatusCode":201,"status":"OK","response":{"uid":"xlFPyhPJwwH","klass":"org.hisp.dhis.organisationunit.OrganisationUnitGroup","errorReports":[],"responseType":"ObjectReport"}}` |
| `POST .../organisationUnitGroupSets/Bpx0589u8y0/organisationUnitGroups/<id>` | `200 {"httpStatus":"OK","httpStatusCode":200,"status":"OK","response":{"responseType":"TypeReport","status":"OK","stats":{"created":0,"updated":1,"deleted":0,"ignored":0,"total":1},"objectReports":[]}}` | `200 {"httpStatus":"OK","httpStatusCode":200,"status":"OK","response":{"status":"OK","stats":{"created":0,"updated":1,"deleted":0,"ignored":0,"total":1},"objectReports":[],"responseType":"TypeReport"}}` |
| Verified (`GET .../organisationUnitGroupSets/Bpx0589u8y0.json?fields=organisationUnitGroups[id,name]`) | `{"organisationUnitGroups":[{"name":"GSI Fix1 Probe","id":"S4FNVUsy6A8"},{"name":"Private Clinic","id":"MAs88nJc9nL"},{"name":"NGO","id":"PVLOW4bCshG"},{"name":"Public facilities","id":"oRVt7g429ZO"},{"name":"Mission","id":"w0gFTTmsUcF"}]}` — the new group present among the original four | `{"organisationUnitGroups":[{"name":"Private Clinic","id":"MAs88nJc9nL"},{"name":"GSI Fix1 Probe","id":"xlFPyhPJwwH"},{"name":"NGO","id":"PVLOW4bCshG"},{"name":"Public facilities","id":"oRVt7g429ZO"},{"name":"Mission","id":"w0gFTTmsUcF"}]}` — same, present among the original four |

Cleaned up on both immediately after: `DELETE .../organisationUnitGroupSets/Bpx0589u8y0/organisationUnitGroups/<id>` → `200`, then `DELETE /api/organisationUnitGroups/<id>` → `200`, on both instances.

**No difference found.** Both use the schema's own collection name
(`organisationUnitGroups`, not `groups`) at the group-set level, and both
accept the add-to-set POST.

One correction to a claim in `task-5-controller-findings.md` (the file
later work cites, and which now carries the controller's own appended
correction — not `task-12-context.md`, which repeats the uncorrected
claim): the add-to-set POST
(`.../organisationUnitGroupSets/<id>/organisationUnitGroups/<groupId>`)
carries **no body**, so DHIS2 answers 200 on both versions whether or not a
`Content-Type` header is sent — no 415 without it, on either version,
confirmed with a fresh request on each:

```
2.40: DELETE .../organisationUnitGroupSets/Bpx0589u8y0/organisationUnitGroups/<id> → 200
      POST (no Content-Type header) .../organisationUnitGroupSets/Bpx0589u8y0/organisationUnitGroups/<id>
        → 200 {"httpStatus":"OK","httpStatusCode":200,"status":"OK","response":{"responseType":"TypeReport","status":"OK","stats":{"created":0,"updated":1,"deleted":0,"ignored":0,"total":1},"objectReports":[]}}
2.43: DELETE .../organisationUnitGroupSets/Bpx0589u8y0/organisationUnitGroups/<id> → 200
      POST (no Content-Type header) .../organisationUnitGroupSets/Bpx0589u8y0/organisationUnitGroups/<id>
        → 200 {"httpStatus":"OK","httpStatusCode":200,"status":"OK","response":{"status":"OK","stats":{"created":0,"updated":1,"deleted":0,"ignored":0,"total":1},"objectReports":[],"responseType":"TypeReport"}}
```

The 415-without-header behaviour is real, but it belongs to a different
call: any POST that *does* carry a JSON body, confirmed directly against
**both** versions this round (not just 2.43, as an earlier draft of this
record asserted without running 2.40):

```
2.40: POST /api/organisationUnitGroups (JSON body, no Content-Type header)
  → 415 {"httpStatus":"Unsupported Media Type","httpStatusCode":415,"status":"ERROR","message":"Content type 'application/x-www-form-urlencoded' not supported"}
2.43: POST /api/organisationUnitGroups (JSON body, no Content-Type header)
  → 415 {"httpStatus":"Unsupported Media Type","httpStatusCode":415,"status":"ERROR","message":"Content-Type 'application/x-www-form-urlencoded' is not supported"}
```

Same status, near-identical message (2.40 drops the hyphen in
"Content type" and omits "is"; not worth generalising past what was
actually measured). The app already sends the header on every body-carrying
POST (`createGroup` in `src/data/metadataWrites.ts`), so this correction
changes nothing about the app's own behaviour — it only corrects which call
the 415 risk actually applies to, so a future reader doesn't go looking for
a missing header check on the wrong endpoint.

**Provenance of the original 415, for the record:** it was not caused by a
body-carrying call being mistaken for the no-body one. The controller's own
account (`progress.md`, and the correction appended to
`task-5-controller-findings.md`) is that the original measurement came from
a malformed URL — a shell substitution holding the group id was empty in
that run, leaving the request path ending in an empty segment — not from
any property of the add-to-set call actually requiring the header. The
corrected conclusion above (no body, no 415-without-header risk, on either
version) stands regardless of that provenance; it is recorded here only so
a future reader doesn't misdiagnose "the API needs this header" when the
real story was "a command was mis-run".

## 6. JSON patch: `compulsory` and `dataDimension`

Request: `PATCH /api/organisationUnitGroupSets/Bpx0589u8y0` with
`Content-Type: application/json-patch+json` and body
`[{"op":"replace","path":"/compulsory","value":true},{"op":"replace","path":"/dataDimension","value":true}]`.

| | 2.40.12 | 2.43.1 |
|---|---|---|
| Pre-patch read (`GET .../Bpx0589u8y0.json?fields=id,compulsory,dataDimension`) | `{"dataDimension":true,"compulsory":true,"id":"Bpx0589u8y0"}` — this is the seed's own value, read before this task issued any patch | `{"dataDimension":true,"compulsory":true,"id":"Bpx0589u8y0"}` — same |
| PATCH response | `{"httpStatus":"OK","httpStatusCode":200,"status":"OK","response":{"responseType":"ObjectReport","uid":"Bpx0589u8y0","klass":"org.hisp.dhis.organisationunit.OrganisationUnitGroupSet","errorReports":[]}}` | `{"httpStatus":"OK","httpStatusCode":200,"status":"OK","response":{"uid":"Bpx0589u8y0","klass":"org.hisp.dhis.organisationunit.OrganisationUnitGroupSet","errorReports":[],"responseType":"ObjectReport"}}` |
| Post-patch read | `{"dataDimension":true,"compulsory":true,"id":"Bpx0589u8y0"}` | `{"dataDimension":true,"compulsory":true,"id":"Bpx0589u8y0"}` |

The seed's own values for this group set were already `compulsory: true,
dataDimension: true` on both instances, read before this task issued its
first patch to either. The patch in this check therefore set both flags to
the value they already held — it exercises the PATCH call and its
`application/json-patch+json` content type genuinely, but it is a no-op
against the seed's state, not a mutation that then needed reverting.

This matters because a *different* check earlier in this session's raw
work (recorded in `task-12-report.md`, not repeated here) did briefly set
both flags to `false` on 2.40 by mistake and then set them back to `true`
before moving on — an in-session slip, not something left behind. The
final state, re-verified after all other work in this record was finished,
is:

```
2.40: GET .../Bpx0589u8y0.json?fields=id,compulsory,dataDimension
  → {"dataDimension":true,"compulsory":true,"id":"Bpx0589u8y0"}
2.43: GET .../Bpx0589u8y0.json?fields=id,compulsory,dataDimension
  → {"dataDimension":true,"compulsory":true,"id":"Bpx0589u8y0"}
```

Both instances carry the seed's own values. **No difference found**, and
both instances are confirmed unmutated relative to the seed for this
check.

## 7. dataStore: create, update, list, delete

Namespace `gsi-fix1-probe`, key `probe`. Verbatim bodies from both
instances, run in this fix round:

| Operation | 2.40.12 | 2.43.1 |
|---|---|---|
| `POST /api/dataStore/gsi-fix1-probe/probe` `{"a":1}` | `201` `{"httpStatus":"Created","httpStatusCode":201,"status":"OK","message":"Key created: 'probe'"}` | `201` `{"httpStatus":"Created","httpStatusCode":201,"status":"OK","message":"Key created: 'probe'"}` |
| `PUT .../probe` `{"a":2}` | `200` `{"httpStatus":"OK","httpStatusCode":200,"status":"OK","message":"Key updated: 'probe'"}` | `200` `{"httpStatus":"OK","httpStatusCode":200,"status":"OK","message":"Key updated: 'probe'"}` |
| `GET /api/dataStore/gsi-fix1-probe` (list) | `200` `["probe"]` | `200` `["probe"]` |
| `GET .../probe` (read) | `200` `{"a": 2}` | `200` `{"a": 2}` |
| `DELETE .../probe` | `200` `{"httpStatus":"OK","httpStatusCode":200,"status":"OK","message":"Key 'probe' deleted from namespace 'gsi-fix1-probe'"}` | `200` `{"httpStatus":"OK","httpStatusCode":200,"status":"OK","message":"Key 'probe' deleted from namespace 'gsi-fix1-probe'"}` |
| `GET` namespace after delete | `404` `{"httpStatus":"Not Found","httpStatusCode":404,"status":"ERROR","message":"Namespace not found: 'gsi-fix1-probe'","errorCode":"E1005"}` | `404` `{"httpStatus":"Not Found","httpStatusCode":404,"status":"ERROR","message":"Namespace not found: 'gsi-fix1-probe'","errorCode":"E1005"}` |

**No difference found** — every status code and every response body,
byte for byte, matches between the two columns.

## 8. Creating the three GSI SQL views from Settings

For each of `GSI_ORGUNITS`, `GSI_ORGUNIT_NAMES`, `GSI_ORGUNIT_MEMBERSHIPS`
(all `type: VIEW`, `sharing.public: "r-------"`), run fresh in this fix
round with verbatim bodies recorded (all three views behaved identically to
each other within a version, so one representative view's full transcript
is shown per version, with the other two views' create/execute responses
given to confirm the pattern held across all three):

**`GSI_ORGUNITS` on 2.40.12** (id `fG1H4omP4hE`):
```
POST /api/sqlViews                        → 201 {"httpStatus":"Created","httpStatusCode":201,"status":"OK","response":{"responseType":"ObjectReport","uid":"fG1H4omP4hE","klass":"org.hisp.dhis.sqlview.SqlView","errorReports":[]}}
GET  /api/sqlViews/fG1H4omP4hE/data.csv    → 500 <!doctype html><html lang="en"><head><title>HTTP Status 500 – Internal Server Error</title>...
POST /api/sqlViews/fG1H4omP4hE/execute     → 201 {"httpStatus":"Created","httpStatusCode":201,"status":"OK","message":"SQL view created"}
GET  /api/sqlViews/fG1H4omP4hE/data.csv?pageSize=2 → 200 "uid,level,parent\njmIPBj66vD6,2,ImspTQPwCqd\n..."
DELETE /api/sqlViews/fG1H4omP4hE           → 200 {"httpStatus":"OK","httpStatusCode":200,"status":"OK","response":{"responseType":"ObjectReport","uid":"fG1H4omP4hE","klass":"org.hisp.dhis.sqlview.SqlView","errorReports":[]}}
```

**`GSI_ORGUNITS` on 2.43.1** (id `FL0W9qnccAe`):
```
POST /api/sqlViews                        → 201 {"httpStatus":"Created","httpStatusCode":201,"status":"OK","response":{"uid":"FL0W9qnccAe","klass":"org.hisp.dhis.sqlview.SqlView","errorReports":[],"responseType":"ObjectReport"}}
GET  /api/sqlViews/FL0W9qnccAe/data.csv    → 500 <!doctype html><html lang="en"><head><title>HTTP Status 500 – Internal Server Error</title>...
POST /api/sqlViews/FL0W9qnccAe/execute     → 201 {"httpStatus":"Created","httpStatusCode":201,"status":"OK","message":"SQL view created"}
GET  /api/sqlViews/FL0W9qnccAe/data.csv?pageSize=2 → 200 "uid,level,parent\nPMa2VCrupOd,2,ImspTQPwCqd\n..."
DELETE /api/sqlViews/FL0W9qnccAe          → 200 {"httpStatus":"OK","httpStatusCode":200,"status":"OK","response":{"uid":"FL0W9qnccAe","klass":"org.hisp.dhis.sqlview.SqlView","errorReports":[],"responseType":"ObjectReport"}}
```

The other two views, same pattern on both versions (create 201 → read
before execute 500 → execute 201 `"SQL view created"` → read after execute
200 with real rows → delete 200):

| View | 2.40.12 id / execute response | 2.43.1 id / execute response |
|---|---|---|
| `GSI_ORGUNIT_NAMES` | `mrnn64SfVXw` / `201 {"message":"SQL view created"}`, read after: `uid,name\nYDDOlgRBEAA,Yongoro CHP\n...` | `M9tZCnwliUE` / `201 {"message":"SQL view created"}`, read after: `uid,name\nYDDOlgRBEAA,Yongoro CHP\n...` |
| `GSI_ORGUNIT_MEMBERSHIPS` | `ZjoZJZjkxuC` / `201 {"message":"SQL view created"}`, read after: `groupid,ouid\nMAs88nJc9nL,uROAmk9ymNE\n...` | `oWhD9PiEp9S` / `201 {"message":"SQL view created"}`, read after: `groupid,ouid\nEYbopBOJWsW,WjO2puYKysP\n...` |

Cleanup confirmed on both: `GET /api/sqlViews?filter=code:like:GSI&paging=false`
→ `{"sqlViews":[]}` on both instances after all six deletes.

**No difference found.** `task-10-sqlview-findings.md`'s three facts (dead
until executed, a second execute is safe/is the repair path, an unexecuted
view is worse than none) all reproduce identically on 2.40, shown above with
real bodies rather than asserted by reference.

## Step 4: the full round trip, through the real app, on both instances

Ran against the real dev server (`pnpm start --port <port> --proxy
<instance>`), one instance at a time, using Playwright request interception
to work around this sandbox's lack of a reachable CORS whitelist (same
justification as Task 10: neither instance sends any
`access-control-allow-*` header, verified directly with curl, so a real
browser cannot reach them cross-origin at all — this is a property of the
test instances, not of the app). Every request from that point still hit
the real instance and got a real response; nothing was faked except the
CORS headers layered onto genuine responses. (One additional wrinkle beyond
what Task 10 documented: the login flow's own `Origin`/`Referer` headers had
to be dropped from the forwarded request, or the DHIS2 instance answered
`200` with an empty body instead of authenticating — an artifact of testing
across an origin the server doesn't recognise, not an app behaviour.)

On the clean seed, Facility Ownership (`Bpx0589u8y0`) showed **15
Conflicts / 230 Missing / 1087 OK** on both 2.40 and 2.43 before any change,
read off the dashboard — identical to each other and to Plan 1's own
measurement, so nothing has regressed. That dashboard reading is the app
reporting on itself, though, so it is not on its own the check the context
asked for ("confirm the numbers return... by API rather than by reading the
screen").

Fixed the same conflict on both instances through the real app: **Bucksal
Clinic** (`vRC0stJ5y9Q`), in Bo, was a member of both **Private Clinic** and
**Public facilities**. In the Objects table, clicking **Private Clinic** in
its `MembershipControl` opened the confirmation dialog ("Bucksal Clinic
will be assigned to Private Clinic and removed from any other group in this
set"); confirming it removed the Public-facilities membership (confirmed by
API on both, and the dashboard moved to 14/230/1088 on both). Then, from
**History**, clicked **Revert** on that entry — the confirmation dialog
itself correctly reconstructed the pre-change state ("Public facilities
+1/-0"; "Bucksal Clinic: Now Private Clinic → After Private Clinic, Public
facilities") — and confirming it restored the membership (confirmed by API
on both, dashboard back to 15/230/1087 on both). That established the
mechanism works end to end through the dialog and History; the counts
themselves, though, were still the dashboard's own arithmetic.

**Independently re-derived all three states from raw group-membership data,
not the app's own count.** The four Facility Ownership groups
(`MAs88nJc9nL` Private Clinic, `PVLOW4bCshG` NGO, `w0gFTTmsUcF` Mission,
`oRVt7g429ZO` Public facilities) were each read in full
(`GET .../organisationUnitGroups/<id>.json?fields=organisationUnits[id]&paging=false`),
and a conflict was counted as any organisation unit id appearing in two or
more of the four member lists — no engine code, no dashboard, nothing but
raw membership lists and a tally. To get a genuine intermediate reading
(the app had already reverted the UI-driven change above by the time this
independent tally was run), the same edit was re-applied directly against
the API — a single `POST .../organisationUnitGroups/oRVt7g429ZO/organisationUnits`
with `{"deletions":[{"id":"vRC0stJ5y9Q"}]}`, the same effect the dialog's
Assign produced — then reverted the same way
(`{"additions":[{"id":"vRC0stJ5y9Q"}]}`), with the tally re-run after each
step:

| State | 2.40.12 tally | 2.43.1 tally |
|---|---|---|
| A — clean seed, before any change | 15 conflicts (ids: `H0OkaM4ReRK, UOJlcpPnBat, UugO8xDeLQD, VrDA0Hn4Xc6, Z9ny6QeqsgX, bM4Ky73uMao, jCnyQOKQBFX, jfV49JGnYKF, jk1TtiBM5hz, k6DIO9LIEk9, kMTHqMgenme, ptc0SQi05E4, roQ2l7TX0eZ, sK498nBOLfQ, vRC0stJ5y9Q`), 1102 distinct org units across the 4 groups | Same 15 ids, same 1102 distinct org units |
| B — after removing Bucksal Clinic from Public facilities | 14 conflicts — the same 15 ids minus `vRC0stJ5y9Q`, no other id changed | Same: the same 15 ids minus `vRC0stJ5y9Q` |
| C — after re-adding it | 15 conflicts, ids identical to state A, `vRC0stJ5y9Q` back in the set | Same, ids identical to state A |

This matches the dashboard's 15 → 14 → 15 reading exactly, on both
versions, but is derived independently of it: nothing here trusts the
app's own bucket arithmetic, only raw `organisationUnitGroups` membership
lists read straight from each server.

**No difference found.** The writer, the reconciliation, the engine
application, the cache invalidation, the change set, and the revert
computation all behave identically on 2.40 and 2.43 — shown above with both
columns' actual figures at every one of the three states, not collapsed to
"Same".

## Verification that both instances were left clean

Re-verified after every check in this record, including the fix-round
corrections, with fresh reads on both instances (bodies shown, not
paraphrased):

```
GET .../organisationUnitGroupSets/Bpx0589u8y0.json?fields=id,compulsory,dataDimension,organisationUnitGroups[id,name]
  2.40: {"dataDimension":true,"compulsory":true,"id":"Bpx0589u8y0","organisationUnitGroups":[{"name":"Private Clinic","id":"MAs88nJc9nL"},{"name":"NGO","id":"PVLOW4bCshG"},{"name":"Public facilities","id":"oRVt7g429ZO"},{"name":"Mission","id":"w0gFTTmsUcF"}]}
  2.43: {"dataDimension":true,"compulsory":true,"id":"Bpx0589u8y0","organisationUnitGroups":[{"name":"Private Clinic","id":"MAs88nJc9nL"},{"name":"NGO","id":"PVLOW4bCshG"},{"name":"Public facilities","id":"oRVt7g429ZO"},{"name":"Mission","id":"w0gFTTmsUcF"}]}
  — byte-identical, both the seed's original compulsory/dataDimension values (section 6)

GET .../organisationUnits/vRC0stJ5y9Q.json?fields=id,name,organisationUnitGroups[id,name]
  2.40: {"name":"Bucksal Clinic","id":"vRC0stJ5y9Q","organisationUnitGroups":[{"name":"Private Clinic","id":"MAs88nJc9nL"},{"name":"Clinic","id":"RXL3lPSK8oG"},{"name":"Public facilities","id":"oRVt7g429ZO"},{"name":"Rural","id":"GGghZsfu7qV"}]}
  2.43: {"name":"Bucksal Clinic","id":"vRC0stJ5y9Q","organisationUnitGroups":[{"name":"Private Clinic","id":"MAs88nJc9nL"},{"name":"Clinic","id":"RXL3lPSK8oG"},{"name":"Public facilities","id":"oRVt7g429ZO"},{"name":"Rural","id":"GGghZsfu7qV"}]}
  — byte-identical, the original four memberships restored after every fix/revert cycle in this record

GET .../organisationUnitGroups/MAs88nJc9nL.json?fields=organisationUnits~size
  2.40: {"organisationUnits":11}
  2.43: {"organisationUnits":11}
  — the seed's original 11 members of Private Clinic, restored after sections 1 and 2's round trips

GET .../sqlViews?filter=code:like:GSI&paging=false
  2.40: {"sqlViews":[]}
  2.43: {"sqlViews":[]}

GET .../dataStore
  → both: the gsi-fix1-probe namespace is gone (last key deleted); only
    pre-existing namespaces (group-set-integrity, etc.) remain
```

## Conclusion

**2.40.12 supports every write the app makes**, with the same request
shapes, the same response envelopes, and the same effective behaviour as
2.43.1, including the one property the entire reconciliation design depends
on (silent drop of invalid ids, reported only through a stats shortfall).
The version floor claimed in `CLAUDE.md` is correct for the write paths, not
just the read paths Plan 1 already proved.

The only measured behavioural difference — 2.40 bumps a group's
`lastUpdated` on a membership write where 2.43 does not — works in the
app's favour for correctness where it matters (external-edit cache
detection) and the app's own writes never depend on it either way. It does
carry a real operating cost on 2.40 (more frequent cache rebuilds under
external editing traffic, see section 4), which is worth knowing but is not
a defect. No code change is needed; it is recorded here so a future reader
does not go looking for a bug that isn't one.

One documentation correction, and its own correction: the
415-without-`Content-Type`-header behaviour is real only for a body-carrying
POST (e.g. group creation), not for the no-body add-to-set POST — confirmed
on both versions, not just 2.43 (section 5). The claim it corrects lives in
`task-5-controller-findings.md` (which now carries the controller's own
appended correction and is the file later work cites), not in
`task-12-context.md`, which still repeats the original, uncorrected claim.
The original 415 that prompted the claim was itself caused by a malformed
URL in that earlier run, not by any property of the add-to-set call — see
section 5. None of this changes anything about the app, which already sends
the header on every call that has a body.
