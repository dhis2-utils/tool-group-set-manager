# What the DHIS2 write API actually does, measured before writing Plan 2

Probed on a disposable DHIS2 2.43.1 with the Sierra Leone demo, and on the
2.41.10 Nigeria EMIS instance for the cost figures. These four facts shape the
plan; none of them is guesswork.

## 1. The bulk membership endpoint works, and is idempotent

`POST /api/organisationUnitGroups/<id>/organisationUnits` with a body of
`{"additions":[{"id":…}],"deletions":[{"id":…}]}` returns 200 and a type report
carrying `stats`. Re-adding an existing member reports `ignored: 1` rather than
failing, and deleting a non-member behaves the same way. So a preview that has
gone slightly stale cannot corrupt anything, which is what the design assumed.

The single-member forms, `POST` and `DELETE` on
`…/organisationUnits/<memberId>`, also work and are a reasonable fallback.

## 2. An invalid id in a batch is silently dropped

This is the one that matters. Sending two additions where one id does not exist
returns **200 OK** with `stats.total: 1, updated: 1`. There is no error report,
no mention of the rejected id, and nothing in the response distinguishes this
from a request that only ever contained one addition.

So the app cannot trust the response to tell it that a write was partial. Every
batch must compare `stats.total` against the number of changes it sent, and
treat any shortfall as a partial failure naming the objects it cannot account
for. A result panel that reports success from the HTTP status alone would lie.

## 3. A membership write does not bump `lastUpdated`

Adding or removing a member through the collection endpoint leaves the group's
`lastUpdated` untouched, and the member object's too. An object-level write does
bump it: patching a group's short name moved it immediately.

Consequences:

- Plan 1's cache validity check, which compares each group's `lastUpdated`, does
  catch an edit made in the Maintenance app, because that saves the whole object.
  It does **not** catch a membership change made through the collection endpoint.
- Plan 2's own writes therefore cannot rely on it. The app knows exactly what it
  changed, so it must invalidate precisely that itself rather than expect the
  next load to notice.
- A membership change made by a third tool using the collection endpoint will go
  unnoticed until a forced reload. That is a real limitation and belongs in the
  interface, not only in a document.

## 4. Member counts are not affordable as a cache signal

The obvious alternative to `lastUpdated` is to ask for each group's member count
and compare. It is cheap on a small instance and unusable on a large one:

| Instance | Request | Time |
| --- | --- | --- |
| Sierra Leone, 1,332 org units | org unit groups with member counts | 3.5 s |
| Nigeria EMIS, 266,396 org units | org unit groups with member counts | **97 s** |
| Nigeria EMIS | data element, indicator, category option groups | 0.8 to 2.4 s |

Ninety-seven seconds to decide whether a cached load is still valid costs more
than the load it is trying to avoid. Rejected.

## Also confirmed

- `PATCH` with `application/json-patch+json` sets `compulsory` and
  `dataDimension` on a group set and takes effect immediately.
- The dataStore supports create, read, list and delete under a namespace of the
  app's choosing.
- A group carries `sharing` as `{owner, users, userGroups, public}`, which is the
  shape to clone when creating a catch-all group.
- Not yet checked on 2.40, which is the app's stated floor. The plan treats that
  as a task rather than an assumption.
