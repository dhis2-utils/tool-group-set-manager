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
| Membership after | Confirmed via `GET .../organisationUnitGroups/MAs88nJc9nL` — addition present, deletion absent | Same |

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
| Verified via GET | The real id was added, the bogus one is simply absent everywhere — no error, no mention of it anywhere in the response | Same |

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
direction (more cache invalidation, never less), so it needs no code change.
It is worth a one-line note in the architecture doc if this project ever
depends on `lastUpdated` semantics being identical across versions, since
right now nothing does.

## 5. Adding a group to a set: endpoint, header requirement, group creation

Request: `POST /api/organisationUnitGroups` (create) then
`POST /api/organisationUnitGroupSets/Bpx0589u8y0/organisationUnitGroups/<id>`
(add to set), both with `Content-Type: application/json`.

| | 2.40.12 | 2.43.1 |
|---|---|---|
| Create group | `201 {"response":{"uid":"PLpod7StbP1",...}}` | `201 {"response":{"uid":"TjKG20tfFmD",...}}` |
| Add to set | `200 {"response":{"stats":{"updated":1,...}}}` | `200 {"response":{"stats":{"updated":1,...}}}` |
| Verified via GET on the set | New group present among the four | Same |

**No difference found.** Both use the schema's own collection name
(`organisationUnitGroups`, not `groups`) at the group-set level, and both
accept the add-to-set POST.

One correction to a claim in `task-12-context.md`: the add-to-set POST
(`.../organisationUnitGroupSets/<id>/organisationUnitGroups/<groupId>`)
carries **no body**, so DHIS2 answers 200 on both versions whether or not a
`Content-Type` header is sent — no 415 without it, on either version. The
415-without-header behaviour is real, but it belongs to a different call:
any POST that *does* carry a JSON body (confirmed directly against 2.43:
`POST /api/organisationUnitGroups` with a JSON body and no
`Content-Type` header → `415 Unsupported Media Type,
"Content-Type 'application/x-www-form-urlencoded' is not supported"`). The
app already sends the header on every body-carrying POST
(`createGroup` in `src/data/metadataWrites.ts`), so this correction changes
nothing about the app's own behaviour — it only corrects which call the
415 risk actually applies to, so a future reader doesn't go looking for a
missing header check on the wrong endpoint.

## 6. JSON patch: `compulsory` and `dataDimension`

Request: `PATCH /api/organisationUnitGroupSets/Bpx0589u8y0` with
`Content-Type: application/json-patch+json` and body
`[{"op":"replace","path":"/compulsory","value":true},{"op":"replace","path":"/dataDimension","value":true}]`.

| | 2.40.12 | 2.43.1 |
|---|---|---|
| Response | `200 {"response":{"responseType":"ObjectReport","uid":"Bpx0589u8y0",...,"errorReports":[]}}` | `200 {"response":{"uid":"Bpx0589u8y0",...,"errorReports":[],"responseType":"ObjectReport"}}` |
| Verified via GET | `compulsory`/`dataDimension` both take effect immediately | Same |

**No difference found.**

## 7. dataStore: create, update, list, delete

Namespace `gsi-probe-task12`, key `probe`.

| Operation | 2.40.12 | 2.43.1 |
|---|---|---|
| `POST .../probe` `{"a":1}` | `201 Key created: 'probe'` | `201 Key created: 'probe'` |
| `PUT .../probe` `{"a":2}` | `200 Key updated: 'probe'` | `200 Key updated: 'probe'` |
| `GET` namespace | `["probe"]` | `["probe"]` |
| `GET .../probe` | `{"a": 2}` | `{"a": 2}` |
| `DELETE .../probe` | `200 Key 'probe' deleted...` | `200 Key 'probe' deleted...` |
| `GET` namespace after delete | `404 Namespace not found` (last key gone removes the namespace) | Same |

**No difference found.**

## 8. Creating the three GSI SQL views from Settings

For each of `GSI_ORGUNITS`, `GSI_ORGUNIT_NAMES`, `GSI_ORGUNIT_MEMBERSHIPS`
(all `type: VIEW`, `sharing.public: "r-------"`):

| Step | 2.40.12 | 2.43.1 |
|---|---|---|
| `POST /api/sqlViews` | `201`, id at `response.uid` | `201`, id at `response.uid` |
| `GET .../data.csv` before execute | `500` (HTML error body) | `500` (HTML error body) |
| `POST .../execute` | `201 {"message":"SQL view created"}` | `201 {"message":"SQL view created"}` |
| `GET .../data.csv` after execute | `200`, real CSV rows | `200`, real CSV rows |
| Cleanup `DELETE` | `200` | `200` |

**No difference found.** `task-10-sqlview-findings.md`'s three facts (dead
until executed, a second execute is safe/is the repair path, an unexecuted
view is worse than none) all reproduce identically on 2.40.

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
Conflicts / 230 Missing / 1087 OK** on both 2.40 and 2.43 before any change
— identical to each other and to Plan 1's own measurement, so nothing has
regressed.

Fixed the same conflict on both instances: **Bucksal Clinic** (`vRC0stJ5y9Q`),
in Bo, was a member of both **Private Clinic** and **Public facilities**. In
the Objects table, clicking **Private Clinic** in its `MembershipControl`
opened the confirmation dialog ("Bucksal Clinic will be assigned to Private
Clinic and removed from any other group in this set"); confirming it:

| | 2.40.12 | 2.43.1 |
|---|---|---|
| API membership right after Assign | `["Private Clinic","Clinic","Rural"]` — Public facilities gone | Same |
| Dashboard numbers right after (no manual reload) | **14 Conflicts / 230 Missing / 1088 OK** | Same |

Then, from **History**, clicked **Revert** on that entry. The confirmation
dialog itself correctly reconstructed the pre-change state ("Public
facilities +1/-0"; "Bucksal Clinic: Now Private Clinic → After Private
Clinic, Public facilities"). Confirming the revert:

| | 2.40.12 | 2.43.1 |
|---|---|---|
| API membership right after Revert | `["Private Clinic","Clinic","Public facilities","Rural"]` — back to the original four | Same |
| Dashboard numbers right after | **15 Conflicts / 230 Missing / 1087 OK** — exactly the pre-change numbers | Same |

**No difference found.** The writer, the reconciliation, the engine
application, the cache invalidation, the change set, and the revert
computation all behave identically on 2.40 and 2.43, verified by API at
every step rather than by reading the screen.

## Verification that both instances were left clean

```
GET .../organisationUnitGroupSets/Bpx0589u8y0?fields=id,compulsory,dataDimension,organisationUnitGroups[id,name]
  → both: compulsory=true, dataDimension=true, exactly the original 4 groups
GET .../organisationUnits/vRC0stJ5y9Q?fields=id,name,organisationUnitGroups[id,name]
  → both: Rural, Private Clinic, Clinic, Public facilities — the original 4
GET .../sqlViews?filter=code:like:GSI
  → both: {"sqlViews":[]}
GET .../dataStore
  → both: the probe namespace is gone (last key deleted), only pre-existing
    namespaces (group-set-integrity, etc.) remain
```

## Conclusion

**2.40.12 supports every write the app makes**, with the same request
shapes, the same response envelopes, and the same effective behaviour as
2.43.1, including the one property the entire reconciliation design depends
on (silent drop of invalid ids, reported only through a stats shortfall).
The version floor claimed in `CLAUDE.md` is correct for the write paths, not
just the read paths Plan 1 already proved.

The only measured difference — 2.40 bumps a group's `lastUpdated` on a
membership write where 2.43 does not — works in the app's favour where it
matters (external-edit cache detection) and the app's own writes never
depend on it either way. No code change is needed; it is recorded here so a
future reader does not go looking for a bug that isn't one.

One documentation correction: the 415-without-`Content-Type`-header
behaviour noted in `task-12-context.md` applies to a body-carrying POST
(e.g. group creation), not to the no-body add-to-set POST, on either
version. This changes nothing about the app, which already sends the
header on every call that has a body.
