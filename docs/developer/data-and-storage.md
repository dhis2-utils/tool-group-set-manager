# Data and storage

This page describes what the app stores on the DHIS2 server and in the browser, and the SQL views that it reads from. It ends with the known open items.

## The dataStore namespace

The app keeps its settings and its change history in the DHIS2 dataStore, in the namespace `group-set-integrity` (`src/data/datastore.ts`). The namespace does not exist until the app first saves something. Until then, a read of a settings key returns 404, and the app treats that as "not configured".

| Key                | Content                                                           | Written by                             |
| ------------------ | ----------------------------------------------------------------- | -------------------------------------- |
| `config-catch-all` | One object for all group sets: group set id to catch-all group id | **Settings**                           |
| `config-general`   | `{ "includeTracker": boolean }`                                   | **Settings**                           |
| `history-<id>`     | One change set (see the following section)                        | Every membership write                 |
| `write-probe`      | `null`, deleted again at once                                     | The write access check on **Settings** |

### `config-catch-all`

```json
{ "Bpx0589u8y0": "a1b2c3d4e5f" }
```

The catch-all group is the group that the bulk fix puts objects in when no real group fits, for example "Other/unknown". Each group set has its own catch-all group. Do not share one group between sets.

- A set with no catch-all group has no entry. The app never stores an empty string. If a set has no entry, the bulk fix dialog looks for a group whose name matches `/other|unknown/i`.
- All sets share this one document. A save reads the document, changes one entry, and writes it back. The read accepts only a 404 as "no document yet". Any other failure stops the save, so that a temporary error cannot erase the other sets' entries.

### `config-general`

`includeTracker` decides whether data elements with the tracker domain type count in a data element group set's population. The default is `false`.

### `history-<id>`

A change set records one user action on one group set: a move, an assignment or a revert. It holds the membership changes that the server confirmed, not the changes that the user asked for (`ChangeSet` in `src/engine/changeSet.ts`).

```json
{
    "id": "mf3k2a1x9q7z0b4c",
    "createdAt": "2026-09-17T10:15:00.000Z",
    "createdBy": { "id": "xE7jOejl9FI", "displayName": "John Traore" },
    "objectType": "organisationUnit",
    "groupSetId": "Bpx0589u8y0",
    "groupSetName": "Facility Ownership",
    "action": "move",
    "note": "",
    "targetGroupId": "MAs88nJc9nL",
    "changes": [
        {
            "groupId": "MAs88nJc9nL",
            "additions": ["vRC0stJ5y9Q"],
            "deletions": []
        },
        {
            "groupId": "oRVt7g429ZO",
            "additions": [],
            "deletions": ["vRC0stJ5y9Q"]
        }
    ]
}
```

- `action` is `move`, `assign` or `revert`. A revert also has `revertOf`, the id of the change set that it undoes.
- `targetGroupId` is present only when the action has one target group.
- The id is a base-36 timestamp followed by 8 random characters. Ids therefore sort in creation order, and the **History** page sorts the key list newest first and reads only the documents of the page it shows. The id is never sent to DHIS2 as a metadata id.
- The app does not save a change set when the server confirmed nothing.
- `changes` has no size limit. A national bulk fix stores every changed id, so one document can hold about 100,000 ids.

### Write access

The dataStore has no sharing object for a namespace that the app can read, so read access does not show write access. The **Settings** page finds out by writing `write-probe` and deleting it. If the delete fails, the key stays behind and does no harm.

## Browser storage

### The IndexedDB cache

The app keeps each object type's loaded data in IndexedDB, so that it can open the dashboard again without reading everything from the server (`src/data/cache.ts`).

- Database `gsi-cache`, object store `types`, key `<server URL>|<object type>`.
- Each entry holds the objects payload, the memberships payload, the names, the group ids, each group's `lastUpdated`, the object total and the time it was saved.
- If storage is blocked, for example in a private window, the app works without a cache.

The app uses a cached entry only if all of the following are true (`tryCache` in `src/data/loadAll.ts`):

1. The group ids are the same as on the server.
2. The entry is less than 10 minutes old (`CACHE_TTL_MS`).
3. The object total is the same as on the server.
4. Every group's `lastUpdated` is the same as on the server.

On 2.41 and later, none of the server checks shows a membership write made through the collection endpoint (see "`lastUpdated` after a membership write" in [DHIS2 server behavior](dhis2-behavior.md)). The 10-minute limit is what bounds how old the cached data can be. After its own write, the app removes the cached entry for the object type that it changed. **Settings** has a button that clears the whole cache.

### Session storage

`sessionStorage` holds the selected scope (`gsi.scope`: id, name and organisation unit level) and a few view settings, such as the "only issues" filter on the dashboard. A scope stored without a level is still valid, and the engine finds the level.

## The SQL views

Settings can create four SQL views. Each one is a `VIEW` with `cacheStrategy: NO_CACHE` and public sharing `r-r-----`. [DHIS2 server behavior](dhis2-behavior.md) explains each of these choices. The app finds the views by code, and creating a view also runs it.

| Code                      | Columns                                                                      | Content                                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GSI_ORGUNITS`            | `uid`, `level`, `parent`                                                     | Every organisation unit, with its level and its parent's uid (empty for a root)                                                       |
| `GSI_ORGUNIT_NAMES`       | `uid`, `name`                                                                | Every organisation unit's raw `name`                                                                                                  |
| `GSI_ORGUNIT_MEMBERSHIPS` | `groupid`, `ouid`                                                            | One row per membership, only for groups that are in at least one group set                                                            |
| `GSI_GROUPSET_USAGE`      | `groupset_uid`, `groupset_type`, `favourite_type`, `favourites`, `views_12m` | Per group set and favorite type, the number of saved favorites that use the set as a dimension, and their views in the last 12 months |

The SQL is in `SQL_VIEW_DEFINITIONS` (`src/data/sources/sqlViewSource.ts`) and `USAGE_SQL_CANDIDATES` (`src/data/sources/usageSqlView.ts`).

- **The three organisation unit views** replace the metadata API for organisation units only. The app uses them when `GSI_ORGUNITS` and `GSI_ORGUNIT_MEMBERSHIPS` both exist, are of type `VIEW` or `QUERY`, and the user can read their data. Otherwise it uses the metadata API for everything. The other object types always come from the metadata API.
- **`GSI_ORGUNIT_NAMES` is optional.** If it is missing, the app reads names from the metadata API, and the dashboard says where the names came from. An administrator can delete this view to get translated names (see the next section).
- **`GSI_GROUPSET_USAGE`** covers organisation unit, data element and category option group sets, and the favorite types `visualization`, `map` and `eventVisualization`. The app reads it by column name and refuses a view under this code with unknown columns or values. `USAGE_SQL_CANDIDATES` is an ordered list of SQL bodies, because table names can change between versions. Settings tries each one until one is created and runs. One body works on 2.40 to 2.43.

Read the CSV views with `paging=false`. A CSV body can end in a blank line, which the parser drops.

## Known open items

### Open

- **`DataTableColumnHeader` in `@dhis2/ui` ignores its `align` prop.** This is the case in `@dhis2/ui` 10.17.0 and on its master branch. The component writes its alignment rule for a `.label` class that it never renders, so numeric column headers stay left-aligned. The app works around this with a CSS rule on the real flex container (`.numericHeader :global(span.top) { justify-content: flex-end }` in `src/components/SummaryMatrix/SummaryMatrix.module.css`), and keeps `align="right"` in place. The issue has not yet been reported to dhis2/ui. When the library fixes it, remove the workaround.

### Accepted, with reasons

- **Organisation unit names on the SQL view path are not translated.** `GSI_ORGUNIT_NAMES` returns the raw `name` column, while the metadata API returns `displayName` in the user's language. The app is an administrator tool, so this is not critical, and a view that resolves the user's locale is not worth building. On an instance with translated names, an administrator can delete `GSI_ORGUNIT_NAMES`. The app then reads names from the metadata API and still uses the other two views. On a 266,000 organisation unit instance, names then take about 4 seconds more. A cached entry keeps the old names until it expires after 10 minutes or the user refreshes.
- **A membership change by another tool can stay unseen for up to 10 minutes.** On 2.41 and later, DHIS2 gives no cheap signal for a membership write through the collection endpoint (see "The IndexedDB cache"). Refresh, or clear the cache in Settings, to see it at once.
- **`GroupSetCard` has a real `<button>` inside an element with `role="button"`.** The card must open the group set, and a tag on it must go somewhere else. This was the least bad option. Keyboard focus between the two works.
- **`planColumns` is computed twice in each Overview render.** Each copy is memoized on its own inputs, so the cost is small.
- **No unit test covers how the Settings page invalidates the usage queries.** A unit test through a mocked query layer would prove nothing. The shared `USAGE_QUERY_PREFIX` test and the end-to-end usage flow cover it.
- **`writeMemberships` keeps a `batchSize` option.** It exists only for tests, so that a test can split a three-id change into batches. `useMembershipWrite.test.tsx` fails if production code passes it.
- **The History document of a large bulk fix is large.** See `history-<id>` in the dataStore section.
- **A connection that drops after the server has saved a write** leaves the app unsure whether the write happened. No status code can show this. A later load shows the server's state.
