# DHIS2 server behavior that the app depends on

This page records how the DHIS2 Web API behaves in the places where the app's design depends on it. Each fact was measured against a live server. The version and the database are named with each fact, because several of them differ between versions.

The versions measured are 2.40.12, 2.41.10, 2.42.6 and 2.43.1. The databases are:

- the Sierra Leone demo database (1,332 organisation units);
- a national education (EMIS) metadata database with 266,396 organisation units, on 2.41.10;
- an anonymized HMIS demo database (12,445 organisation units) and a data quality test database (1,553 organisation units, 31 group sets) for cross-checks.

If a new DHIS2 version changes one of these facts, the code that depends on it is named in each section.

## Membership writes through the collection endpoint

The app adds and removes group members with one request per batch:

```
POST /api/organisationUnitGroups/{id}/organisationUnits
Content-Type: application/json

{"additions":[{"id":"..."}],"deletions":[{"id":"..."}]}
```

The same shape works for the other three group types (`dataElementGroups`, `indicatorGroups`, `categoryOptionGroups`), with their own member collection names (`src/data/endpoints.ts`).

The response is a `TypeReport` with counts in `response.stats` (`created`, `updated`, `deleted`, `ignored`, `total`). The envelope is the same on 2.40.12 and 2.43.1.

- **An invalid id is dropped without an error.** A batch with one valid and one nonexistent id returns `200 OK` with `stats.total: 1` and no error report. Nothing in the response names the dropped id. Measured on 2.40.12 and 2.43.1.
- **A no-op is counted as `ignored`.** Adding an existing member, or deleting a non-member, reports `ignored: 1` and does not fail.

So the HTTP status does not tell the app that a batch was partial. `writeMemberships` (`src/data/writes.ts`) adds `created + updated + deleted + ignored` and compares the sum with the number of ids it sent. A batch that comes back short is disowned in full, because the response does not say which ids were dropped. A response with no `stats` counts as zero accepted.

### Batch size and server cost

DHIS2 reads the group's whole member collection again on every collection write. For a large group, many small batches cost much more than a few large ones. The following figures fill one group from empty to 91,892 members on 2.41.10 (EMIS):

| Batch size | Requests |      Seconds | Rows fetched by the database per membership |
| ---------- | -------: | -----------: | ------------------------------------------: |
| 250        |      369 | 823 to 1,998 |                                  377 to 398 |
| 1,000      |       93 |          192 |                                          56 |
| 5,000      |       20 |           47 |                                        19.5 |

No batch size was refused by the server (no 413, no timeout). This is why `DEFAULT_BATCH_SIZE` is 5,000. Smaller batches are not gentler on the server.

A single small write to a group of this size took 8 to 10 seconds, and its revert about 14 seconds. Most of that time is the server reading the collection.

## Membership writes with JSON Patch

For one group's change of more than 5,000 ids, the app replaces the whole member list with one JSON Patch (`patchChange` and `takesPatchRoute` in `src/data/writes.ts`):

```
PATCH /api/organisationUnitGroups/{id}
Content-Type: application/json-patch+json

[{"op":"replace","path":"/organisationUnits","value":[{"id":"..."}]}]
```

- **It adds and removes correctly.** Verified by reading the full member set back on 2.40.12 and 2.41.10.
- **It does not change the group's other properties.** `description`, `color` and `symbol` survived a full empty-and-refill of a 91,892-member group on 2.41.10, and a small patch on 2.40.12.
- **It is as fast as a metadata import.** 19 to 23 seconds for 91,892 members on 2.41.10, with about 3 to 4 rows fetched per membership. The 1.3 MB payload was accepted. Removing members costs real work too: emptying the same group took 14 to 17 seconds.
- **A refusal is atomic.** On all four versions, every refused patch left the membership unchanged:

| Case                                         | Status | Membership after            |
| -------------------------------------------- | ------ | --------------------------- |
| All ids valid                                | 200    | as sent                     |
| One nonexistent id among valid ids           | 409    | unchanged                   |
| Only a nonexistent id                        | 409    | unchanged                   |
| Malformed id                                 | 409    | unchanged                   |
| Duplicate ids                                | 200    | as sent, without duplicates |
| User without the authority to edit the group | 403    | unchanged                   |

So `response.ok` is a complete success signal for this patch. A 409 carries an `ObjectReport` with `errorReports`, for example `Invalid reference [Zz9GhOsT000] (OrganisationUnit)`. A 403 carries error code `E1006`. The app logs this body in `rawError` and does not show it to the user.

A replace overwrites the whole collection, so the app uses it only with a member list that it has read from the server immediately before the write. The bulk fix dialog reads the members of each group that takes the patch route, and recomputes the plan from them, before it writes (`readPatchRouteGroups` in `src/components/BulkFixDialog/BulkFixDialog.tsx`). The check has a 60-second deadline.

Reading every group of a set before every write is too slow on a large instance. On EMIS (2.41.10), reading all the members of a whole set took 4 to 11 seconds: up to 9.7 seconds for a set of 6 groups and up to 10.8 seconds for a set of 4 groups. This is why the app reads only the groups that take the patch route.

The app also uses JSON Patch to set `compulsory` and `dataDimension` on a group set (`setGroupSetProperties` in `src/data/metadataWrites.ts`), which works the same way on 2.40.12 and 2.43.1. It also patches `/sharing/public` on a SQL view, so that it does not replace the view's user and user group sharing. Use `add`, not `replace`, for a property that the object does not have yet: `replace` needs the path to exist.

### Do not write membership through the metadata import

`POST /api/metadata` overwrites every owned property that the payload leaves out, even when the new value is null. The `mergeMode` parameter was removed in 2.41 and in 2.38.7, 2.39.6 and 2.40.4 (DHIS2-16525, DHIS2-11779). On 2.43.1 the server accepts `mergeMode=MERGE` and ignores it. A membership write through the import would have to read and send back every owned property of the group, including `sharing` and `attributeValues`. JSON Patch avoids this.

### Other write details

- A POST that has a JSON body and no `Content-Type` header returns 415 on 2.40.12 and 2.43.1. The POST that adds an existing group to a set (`/api/organisationUnitGroupSets/{id}/organisationUnitGroups/{groupId}`) has no body and works without the header.
- On 2.40.12, the `access.write` flag on groups nested in a group set response matched whether a user without `ALL` could edit the group. This was not checked on other versions.

## `lastUpdated` after a membership write

The following table shows whether a group's `lastUpdated` changes after a membership write:

| Version | Collection endpoint | Metadata import |
| ------- | ------------------- | --------------- |
| 2.40.12 | changes             | changes         |
| 2.41.10 | does not change     | changes         |
| 2.42.6  | does not change     | changes         |
| 2.43.1  | does not change     | changes         |

The effect of the JSON Patch replace on `lastUpdated` was not measured.

Other signals were checked as well:

- The group set's own `lastUpdated` never changes after a membership write, on any version.
- `organisationUnits~size` on the group changes when the count changes. It does not change when one write removes one member and adds another (measured on 2.42.6).

The consequences for the app are:

- On 2.41 and later, nothing that the server returns cheaply shows that an object moved from one group to another. The IndexedDB cache can therefore be up to 10 minutes out of date after an edit made by another tool (see [Data and storage](data-and-storage.md)).
- The app removes the cache entry for the object type that it wrote itself, and does not wait for the next load to notice.
- An optimistic concurrency check ("abort if the group changed since I read it") cannot be built on 2.41 and later. This is the reason the app re-reads the group's members before a JSON Patch replace, and does not compare timestamps.
- On 2.40, every membership write by anyone changes the group's `lastUpdated`, so the cache is rebuilt more often. That costs load time, and does not cause wrong numbers.

Member counts are not a usable cache signal either. Asking for all organisation unit groups with their member counts took 3.5 seconds on Sierra Leone and 97 seconds on EMIS (2.41.10).

## Data integrity checks

The app shows DHIS2's own integrity results beside its own counts. The check names and codes are not stable from 2.40 to 2.43:

| 2.43 name (code)                                             | 2.40 name (code)                           |
| ------------------------------------------------------------ | ------------------------------------------ |
| `org_units_not_in_compulsory_group_sets` (OUNICGS)           | `orgunits_compulsory_group_count` (OCGC)   |
| `organisation_units_violating_exclusive_group_sets` (OUVEGS) | `orgunit_group_sets_excess_groups` (OGSEG) |
| `data_elements_violating_exclusive_group_sets` (DEVEGS)      | same                                       |
| `indicators_violating_exclusive_group_sets` (IVEGS)          | same                                       |
| `category_options_excess_groupset_membership` (COEGM)        | same                                       |
| `category_option_group_sets_incomplete` (COGSI)              | same                                       |

On 2.40, the code OUVEGS belongs to a different check, `org_units_violating_exclusive_group_sets`, which is slow and programmatic. A match on code would choose that check on 2.40 without any error. The app matches on name only, and takes the first candidate name that the server lists (`CANDIDATES` in `src/data/integrity.ts`). The server lists 100 checks on 2.40.12 and 111 on 2.43.1.

The endpoints behave the same on 2.40.12 and 2.43.1:

- `GET /api/dataIntegrity/summary?checks=...` reads the last stored result and does not run anything. If the checks have never run, it returns `{}`.
- The `timeout` parameter is a blocking wait in milliseconds. With `timeout=60000` and no job running, the request waited 60 seconds and returned `{}`. The app always sends `timeout=0`.
- `POST` to the same URL starts a `DATA_INTEGRITY` job and returns at once with the job id. The app then polls the `GET` until `finishedTime` is newer.
- Each summary entry has `count`, `percentage`, `startTime`, `finishedTime`, `averageExecutionTime`, `isSlow` and the check's metadata.
- `GET /api/dataIntegrity/details` names each object by `id` and `name`. The group information is prose: `refs` (an array of strings) on 2.43, `comment` (one string) on 2.40, and neither on the compulsory check. The app shows this text as it is, and never parses it.
- Neither endpoint takes an organisation unit filter. The counts cover the whole hierarchy, and the app filters by scope itself.

The app shows the integrity results only to a user with `ALL` or `F_PERFORM_MAINTENANCE` (from `GET /api/me?fields=authorities`). A 403 from either endpoint has the same effect as a missing authority.

## SQL views

These facts apply to the `GSI_*` views that the app creates (see [Data and storage](data-and-storage.md)).

- **A view cannot be read until it has been run.** After `POST /api/sqlViews`, a read of `data.csv` returns 500. `POST /api/sqlViews/{id}/execute` returns 201 (`SQL view created`), and after that the read works. Running a view a second time is safe, so it is also the repair. Measured on 2.40.12 and 2.43.1.
- **Reading rows needs the data read bit in sharing.** Public sharing `r-------` gives metadata read only. A user without `ALL` then gets `409 E4312` ("Current user is not authorised to read data from SQL view"), even the user who created the view. The app creates and repairs views with `r-r-----`. Found on 2.41.10.
- **A view is cached for two weeks by default.** If `cacheStrategy` is not set, DHIS2 uses the system setting, which is `CACHE_TWO_WEEKS` on a new installation. The data response then has `Cache-Control: max-age=1209600, public`, and the browser answers later reads from its own cache without asking the server. The app's own writes then disappear on the next load. The app creates views with `cacheStrategy: NO_CACHE`, and reads them with `fetch(..., { cache: 'no-store' })` so that a view made by an older build cannot do this.
- **A materialized view can return old rows.** A `MATERIALIZED_VIEW` returns the rows from its last run, and nothing in the response says how old they are. The app reads only views of type `VIEW` or `QUERY`, and uses the metadata API otherwise.
- **`paging=false` returns every row.** Checked on 2.40.12 and 2.43.1 for CSV and JSON up to 3,526 rows, and on 2.41.10 for CSV at 266,397 and 1,098,185 rows.
- **A view returns the raw `name` column.** The metadata API returns `displayName` in the user's locale. See "Known open items" in [Data and storage](data-and-storage.md).

The usage view (`GSI_GROUPSET_USAGE`) depends on these database facts, which are the same on all four versions:

- `eventvisualization` contains every `eventchart` and `eventreport` row, and its dimension link tables have the same links. Reading `eventchart` or `eventreport` as well would count event favorites twice.
- `datastatisticsevent.favoriteuid` for a map view event names the map, never the map view. The view joins `mapview` to `map` through `mapmapviews`.
- There is no data element group set link table for maps or event visualizations, and no indicator group set dimension table at all. The app shows no usage for indicator group sets.

## The metadata API at scale

These figures are from EMIS (266,396 organisation units, 2.41.10):

| Read                                                    | Payload                      | Time                                                 |
| ------------------------------------------------------- | ---------------------------- | ---------------------------------------------------- |
| `organisationUnits?fields=id,level,parent&paging=false` | 16.25 MB JSON                | 11 to 21 s on an idle server, 84 to 167 s under load |
| `GSI_ORGUNITS` view, the same data                      | 6.93 MB CSV                  | 1.0 s                                                |
| `GSI_ORGUNIT_MEMBERSHIPS` view                          | 26.36 MB CSV, 1,098,185 rows | 2.5 s                                                |
| `GSI_ORGUNIT_NAMES` view                                | 8.52 MB CSV                  | 0.5 s                                                |

With the metadata API only, the dashboard did not finish loading in 640 seconds, because the organisation unit read is followed by one member read per group and a name read. With the SQL views, a load with an empty cache took 9 to 44 seconds, depending on server load, and a load from the cache took about 5 seconds with no SQL view request.

After the data is loaded, the worker answers queries in memory. Opening the 266,396-object set took 0.2 seconds, a text search 0.45 seconds, and a bulk fix preview of 77,017 objects 0.14 seconds.
