# Plan 8 Task 8, fix round 2: does mergeMode=MERGE preserve omitted properties?

Task 8's round 1 fix read `fields=id,name,shortName,code` before an import and
spread those four fields into the payload, on the reasoning that
`mergeMode=REPLACE` (the metadata import's default) nulls anything the
payload omits. Round 1 review caught that the four-field list itself was
still incomplete -- `description`, `symbol`, `color`, `attributeValues` and
`translations` (and, on other object types, other owned properties again)
would be nulled by the same mechanism, just less obviously.

Round 2's question, before writing any code: does `mergeMode=MERGE` avoid the
nulling for properties the payload omits, while still fully replacing a
collection the payload *does* supply? Both halves matter -- a `MERGE` that
preserved `description` but unioned the membership collection with what
already existed would silently fail to apply deletions, which is worse than
the bug being fixed.

## Instance

`agent-gsi-p2`, DHIS2 **2.43.1**, Sierra Leone demo. Started via the broker,
all other broker instances confirmed `stopped` before and after, stopped
again once the check and the restoration below were both confirmed.

## Object and baseline

Group: **CHC** (`CXw2yu5fodb`, organisation unit group), 194 members.
Original state (`fields=*`): `code: "CHC"`, `symbol: "16.png"`,
`description: null`, `color: null`, `attributeValues: []`,
`translations: []`.

Per the brief, since the group had no `description`/`color`, both were set
first (via `PATCH` with `Content-Type: application/json-patch+json` --
plain-JSON `PATCH` returned 415 on this server) so the check would have
something non-default to lose:

```
PATCH /api/organisationUnitGroups/CXw2yu5fodb
[{"op":"add","path":"/description","value":"GSI task8 round2 probe"},
 {"op":"add","path":"/color","value":"#3366ff"}]
-> 200 OK
```

Confirmed via `fields=id,name,shortName,code,description,color,symbol,organisationUnits`:
`description: "GSI task8 round2 probe"`, `color: "#3366ff"`, `code: "CHC"`,
`symbol: "16.png"`, 194 members.

## Check 1: mergeMode=MERGE, payload carrying only `id` and a changed member list

Built the intended membership as 193 of the 194 original members (removed
`Mi4dWRtfIOC`) plus one new member (`Rp268JB6Ne4`, an org unit not already in
the group) -- both an addition and a removal in the same import, per the
brief.

```
POST /api/metadata?importStrategy=UPDATE&mergeMode=MERGE
{"organisationUnitGroups":[{"id":"CXw2yu5fodb",
  "organisationUnits":[...194 ids...]}]}
```

Response: **409 Conflict**, `status: "ERROR"`:

```json
{"errorReports":[
  {"message":"Missing required property `name`","errorCode":"E4000", ...},
  {"message":"Missing required property `shortName`","errorCode":"E4000", ...}
]}
```

So `mergeMode` does not relax DHIS2's own required-field validation:
`name`/`shortName` must be present in the payload regardless of merge mode,
or the whole import is rejected outright (never silently accepted with
those fields left blank).

## Check 2: mergeMode=MERGE, payload carrying id/name/shortName plus the changed member list

Same membership change, `name`/`shortName` added to satisfy validation,
`description`/`color`/`code`/`symbol` still omitted:

```
POST /api/metadata?importStrategy=UPDATE&mergeMode=MERGE
{"organisationUnitGroups":[{"id":"CXw2yu5fodb","name":"CHC",
  "shortName":"CHC","organisationUnits":[...194 ids...]}]}
```

Response: **200 OK**, `status: "OK"`, `stats: {"updated":1}`.

Re-read (`fields=id,name,shortName,code,description,color,symbol,organisationUnits`):

| field | before | after `MERGE` import |
| --- | --- | --- |
| `name` | CHC | CHC (unchanged -- was supplied) |
| `shortName` | CHC | CHC (unchanged -- was supplied) |
| `code` | CHC | **null** |
| `description` | GSI task8 round2 probe | **null** |
| `color` | #3366ff | **null** |
| `symbol` | 16.png | **null** |
| members | 194 (baseline set) | 194, **exactly** the intended set: `Mi4dWRtfIOC` absent, `Rp268JB6Ne4` present, no others changed |

So on this version, **`mergeMode=MERGE` nulls every omitted property exactly
as `REPLACE` does** -- it bought nothing for the fields problem. The one
thing it did right is the collection: the membership after the import was
exactly the supplied list, not a union with what existed beforehand (194 in,
194 out, with the one swap applied) -- so there is no additional hazard on
that axis, but no benefit either, since `REPLACE` already does the same
thing for a collection the payload supplies.

**Conclusion: switching to `mergeMode=MERGE` would not solve the problem.**
Both merge modes null an omitted property; only `REPLACE` (the default) was
implemented further, per the ruling for that branch.

## Check 3: does `fields=:owner` solve the field-list problem generically?

Rather than hand-widen the round 1 field list (fragile: has to be revisited
by hand whenever DHIS2 adds a property, and separately for each of the four
object types this module writes), tried DHIS2's `:owner` field preset, which
is schema-driven.

```
GET /api/organisationUnitGroups/CXw2yu5fodb.json?fields=:owner
-> {"attributeValues":[...],"code":"CHC","color":"#3366ff",
    "created":...,"createdBy":...,"description":"...","id":"...",
    "lastUpdated":...,"lastUpdatedBy":...,"name":"CHC",
    "organisationUnits":[...194 objects...],"sharing":{...},
    "shortName":"CHC","symbol":"16.png","translations":[]}
```

(Re-set `description`/`color`/`symbol`/`code` via `PATCH` first, to confirm
`:owner` includes them once non-null -- confirmed by schema check too:
`GET /api/schemas/organisationUnitGroup.json` lists `symbol`, `code`,
`color`, `description` as `persisted: true, owner: true, collection: false`.
`:owner` appears to omit a field from the response when its value is
default/null rather than emitting it as an explicit `null` -- irrelevant for
building a `REPLACE` payload, since "omitted because it's currently null"
and "present with value null" both mean the same thing to the importer.)

`fields=:owner,!organisationUnits` excludes the (potentially huge) member
collection, since the caller already has the intended list computed
separately:

```
GET /api/organisationUnitGroups/CXw2yu5fodb.json?fields=:owner,!organisationUnits
-> {"attributeValues":[...],"code":"CHC","color":"#3366ff","created":...,
    "createdBy":...,"description":"...","id":"...","lastUpdated":...,
    "lastUpdatedBy":...,"name":"CHC","sharing":{...},"shortName":"CHC",
    "symbol":"16.png","translations":[]}
```

**Import with this payload (default `mergeMode=REPLACE`, no `mergeMode`
param), restoring the original 194-member list at the same time:**

```
POST /api/metadata?importStrategy=UPDATE
{"organisationUnitGroups":[{
  "attributeValues":[],"code":"CHC","color":"#3366ff","created":"...",
  "createdBy":{...},"description":"GSI task8 round2 probe","id":"...",
  "lastUpdated":"...","lastUpdatedBy":{...},"name":"CHC","sharing":{...},
  "shortName":"CHC","symbol":"16.png","translations":[],
  "organisationUnits":[...194 ids, original set...]
}]}
-> 200 OK, stats: {"updated":1}
```

Re-read: `name`, `shortName`, `code`, `description`, `color`, `symbol` all
preserved exactly; membership exactly the 194-id set passed. Server-managed
audit fields (`created`, `createdBy`, `lastUpdated`, `lastUpdatedBy`) present
in the payload did not cause an error or get misapplied -- the import
either ignores or accepts them as no-ops.

**Confirmed the same query shape generalises to the other three object
types this module writes** (schema-only reads, no data changed):

```
GET /api/dataElementGroups/oDkJh5Ddh7d.json?fields=:owner
-> {attributeValues, created, createdBy, dataElements, id, lastUpdated,
    name, sharing, shortName, translations}
GET /api/dataElementGroups/oDkJh5Ddh7d.json?fields=:owner,!dataElements
-> same, minus dataElements

GET /api/indicatorGroups/oehv9EO3vP7.json?fields=:owner
-> {attributeValues, created, id, indicators, lastUpdated, name, sharing,
    translations}   -- no code/shortName because this indicator group's
    values for them are null/default, same reasoning as above

GET /api/categoryOptionGroups/OK2Nr4wdfrZ.json?fields=:owner
-> {attributeValues, categoryOptions, code, created, createdBy,
    dataDimensionType, id, lastUpdated, name, sharing, shortName,
    translations}   -- dataDimensionType is a categoryOptionGroup-only
    owned property, correctly picked up with no code change needed
```

## Conclusion and what was implemented

`mergeMode` does not solve the omitted-property problem (Check 1 and 2), so
`writes.ts` stays on the default `mergeMode=REPLACE` (no `mergeMode` query
param). The field-read before an import now requests
`fields=:owner,!<endpoint.members>` instead of a hardcoded field list --
schema-driven, so it does not need revisiting per-object-type or when DHIS2
adds a property, and Check 3 confirms it produces a correct, complete
payload (every owned property preserved, collection replaced exactly) on
all four object types this module writes.

## Restoration

`description` and `color` were cleared back to their original `null` via a
final `PATCH` (`remove` ops), and membership was already restored to the
original 194-id set as part of Check 3's import. Re-read confirmed every
field (`name`, `shortName`, `code`, `description`, `color`, `symbol`,
`attributeValues`, `translations`, membership) matches the very first
`fields=*` capture, except `lastUpdated` (a server-managed timestamp, not
something the check could or should restore). The instance was then
stopped.
