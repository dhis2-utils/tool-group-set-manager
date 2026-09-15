# Two open items from spec §9, measured on live 2.40 and 2.43

Measured against two disposable broker instances, both on the same Sierra
Leone demo seed: `agent-gsi-p2` (DHIS2 2.43.1) for both questions, and
`agent-gsi-p2-40` (DHIS2 2.40.12) for both questions on version 1 and for
question 2 specifically as the brief requires. The app's own pinned SQL view
definitions (`src/data/sources/sqlViewSource.ts`, `SQL_VIEW_DEFINITIONS`)
were posted directly to `/api/sqlViews`, executed, then read — the app's
dev server and Settings UI were never started for this task.

## Question 1: does `paging=false` on a SQL view export return every row, on both CSV and JSON?

### Setup

The three `GSI_*` views were created with `POST /api/sqlViews` using the
exact `code`, `name`, `type: "VIEW"` and `sqlQuery` from
`SQL_VIEW_DEFINITIONS`, then executed with `POST /api/sqlViews/<id>/execute`.
Created successfully (HTTP 201) on both instances.

View ids:

| code | 2.43.1 id | 2.40.12 id |
| --- | --- | --- |
| GSI_ORGUNITS | `p6dkSohQD3P` | `BaT96Th5PcG` |
| GSI_ORGUNIT_NAMES | `ZQEgXECcoiM` | `e6YD82nzEda` |
| GSI_ORGUNIT_MEMBERSHIPS | `ebmFsoPonu3` | `gLQ2xoswWHg` |

**Environmental snag:** the seed's own `admin` user does not carry `ALL`
authority on either instance (`GET /api/me/authorization` as `admin` omits
`ALL`; it has only `F_SQLVIEW_PUBLIC_ADD`, `F_SQLVIEW_EXTERNAL`,
`F_SQLVIEW_DELETE`, `F_SQLVIEW_PRIVATE_ADD`). Reading data from a view it had
just created as `admin` returned HTTP 500 with
`org.hisp.dhis.common.IllegalQueryException: Current user is not authorised
to read data from SQL view`. All view creation and every data read below
therefore used `local_admin` / `district` (the broker's guaranteed
superuser, confirmed to hold `ALL` on both instances) instead of `admin`.
This is a fact about the seed's `admin` user, not about SQL view paging, and
is recorded here rather than folded into the paging measurement.

### True row counts (independent of the SQL views)

- Org units, both instances: `GET /api/organisationUnits.json?pageSize=1&fields=id` →
  `pager.total = 1332` on both `agent-gsi-p2` and `agent-gsi-p2-40`.
- Org-unit-group memberships restricted to groups that belong to at least one
  group set (what `GSI_ORGUNIT_MEMBERSHIPS` selects), both instances:
  `GET /api/organisationUnitGroups.json?fields=id,organisationUnits~size,groupSets~size&paging=false`,
  summing `organisationUnits~size` over the 15 (of 18) groups whose
  `groupSets~size > 0` → **3526** on both instances. Cross-checked the
  `~size` transform itself against a full `fields=organisationUnits[id]`
  list for one group (`CXw2yu5fodb`): both gave 194, so `~size` is trustworthy
  here.

### Measured: CSV vs JSON vs true count, `paging=false`

Requests (repeated per view, per instance, as `local_admin:district`):

```
GET /api/sqlViews/<id>/data.csv?paging=false     -> wc -l, minus 1 for the header
GET /api/sqlViews/<id>/data.json?paging=false    -> len(listGrid.rows)
```

**DHIS2 2.43.1 (`agent-gsi-p2`):**

| view | CSV rows (paging=false) | JSON rows (paging=false) | true count |
| --- | --- | --- | --- |
| GSI_ORGUNITS | 1332 | 1332 | 1332 |
| GSI_ORGUNIT_NAMES | 1332 | 1332 | 1332 |
| GSI_ORGUNIT_MEMBERSHIPS | 3526 | 3526 | 3526 |

**DHIS2 2.40.12 (`agent-gsi-p2-40`):**

| view | CSV rows (paging=false) | JSON rows (paging=false) | true count |
| --- | --- | --- | --- |
| GSI_ORGUNITS | 1332 | 1332 | 1332 |
| GSI_ORGUNIT_NAMES | 1332 | 1332 | 1332 |
| GSI_ORGUNIT_MEMBERSHIPS | 3526 | 3526 | 3526 |

(Before switching to `local_admin`, the same requests as `admin` returned an
HTTP 500 error page for JSON, and for CSV returned Tomcat's HTML 500 error
page itself — `wc -l` on that page happened to report 265/266 lines on
2.43.1 and 208/209 lines on 2.40.12. That is an artifact of the error page's
line count, not a page-size cap, and is not a CSV row count at all; it is
recorded here only so it is not mistaken for a paging result if this note is
read out of order.)

### Answer

On both DHIS2 2.40.12 and 2.43.1, for all three `GSI_*` views, `data.csv?paging=false`
and `data.json?paging=false` both returned exactly the true row count, with no
capping observed at any default page size. **No version difference found** —
`paging=false` was honoured identically by CSV and JSON export on both
versions tested. This was checked only up to 3526 rows; it does not rule out a
cap that only bites above that size.

## Question 2: does a non-admin's `access.write` on nested `organisationUnitGroups` reflect their real permission, on 2.40?

Measured only on `agent-gsi-p2-40` (2.40.12), per the task's scope.

### Test user and authorities granted

Created via `POST /api/userRoles` then `POST /api/users` as `local_admin`:

- User role `GSI test: group set editor` (id `KR6PNZnqXRk`) with exactly these
  authorities — the schema-declared create/delete authorities for both
  `organisationUnitGroupSet` and `organisationUnitGroup`
  (`GET /api/schemas/organisationUnitGroupSet.json?fields=authorities` and
  the same for `organisationUnitGroup`):
  - `F_ORGUNITGROUPSET_PUBLIC_ADD`
  - `F_ORGUNITGROUPSET_PRIVATE_ADD`
  - `F_ORGUNITGROUPSET_DELETE`
  - `F_ORGUNITGROUP_PUBLIC_ADD`
  - `F_ORGUNITGROUP_PRIVATE_ADD`
  - `F_ORGUNITGROUP_DELETE`
- User `gsi_test_editor` (id `BoIJegxffNJ`), that role only.
- Confirmed via `GET /api/me/authorization` as `gsi_test_editor`: 6
  authorities, exactly the list above, **`ALL` absent**.

### Request: existing (publicly shared) group set

```
GET /api/organisationUnitGroupSets?fields=id,name,organisationUnitGroups[id,name,access]&pageSize=1
```
as `gsi_test_editor:Test1234!pass`. Returned the "Area" group set (id
`uIuxlbV1vRT`) with four nested groups, each carrying a full `access` object,
e.g. for "Northern Area" (id `J40PpdN4Wkk`):

```json
{
  "manage": true, "externalize": false, "write": true,
  "read": true, "update": true, "delete": true
}
```

`access` (including `access.write`) **is returned** on the nested
`organisationUnitGroups`. This group's actual sharing
(`GET /api/organisationUnitGroups/J40PpdN4Wkk.json?fields=sharing,publicAccess`
as `local_admin`) is `publicAccess: "rw------"`, so `write: true` here only
tests the positive case — a group anyone with the right create authority can
already write via public sharing. To confirm the field is not simply always
`true`, and to check what happens when the test user should be refused, a
negative control was added:

### Negative control: restricted-sharing group

Created as `local_admin` (throwaway):
- Org unit group `GSI access test group (restricted)` (id `TMNk20Jgf2H`),
  `sharing.public: "--------"`, no user/userGroup grants.
- Org unit group set `GSI access test set` (id `boDbQupcur4`) containing only
  that group.

Request as `gsi_test_editor`:

```
GET /api/organisationUnitGroupSets/boDbQupcur4?fields=id,name,organisationUnitGroups[id,name,access]
```

Returned:

```json
{
  "manage": false, "externalize": false, "write": false,
  "read": false, "update": false, "delete": false
}
```

### Ground truth: does the field match what the server actually allows?

Attempted the real write predicted by each case, as `gsi_test_editor`:

- `PUT /api/organisationUnitGroups/J40PpdN4Wkk` (predicted `write: true`,
  identical name/shortName body) → **HTTP 200 OK**.
- `PUT /api/organisationUnitGroups/TMNk20Jgf2H` (predicted `write: false`)
  → **HTTP 403 Forbidden**, `"You don't have the proper permissions to
  update this object."` (`E1006`).

Both predictions matched the real outcome.

### Answer

On DHIS2 2.40.12, `access` (including `access.write`) **is returned** on
`organisationUnitGroups` nested under a group set fetch for a non-admin user
without `ALL`, and in both the positive and negative case tested, it
correctly predicted whether a subsequent `PUT` to that group by the same
user would succeed. **2.43.1 was not tested for this question** — the task
scoped question 2 to 2.40 only, so no cross-version comparison can be made
here; if the app is relying on this elsewhere on other versions, that would
need its own check.

## Instances used

- `agent-gsi-p2` (2.43.1): started 2026-09-15 13:58 UTC (job `j-0be36134`),
  stopped 2026-09-15 after all measurements above.
- `agent-gsi-p2-40` (2.40.12): started 2026-09-15 13:58 UTC (job
  `j-27f7600c`), stopped 2026-09-15 after all measurements above.

Everything created on either instance (SQL views, the test user role, the
test user, the restricted group and group set) is throwaway and was left in
place only because the instances themselves were stopped, not deleted, at
the end of this task.
