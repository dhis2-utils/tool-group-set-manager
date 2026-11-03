"""The run's state record (TESTING.md, "Seeding and cleanup").

Every object the suite creates is listed in the dataStore at
`e2e-state/tool-group-set-manager` *before* it is created, with a UID the
suite generated itself. The next run deletes whatever the record still lists
before it seeds anything, so a run that was killed half way never breaks the
one after it.
"""

import logging

from .api import NOT_FOUND

STATE_NAMESPACE = "e2e-state"
STATE_KEY = "tool-group-set-manager"
STATE_PATH = f"dataStore/{STATE_NAMESPACE}/{STATE_KEY}"

# The app's own dataStore namespace; its History entries are `history-<id>`.
APP_NAMESPACE = "group-set-integrity"
HISTORY_PREFIX = "history-"

TYPE_ORG_UNIT = "organisationUnits"
TYPE_GROUP = "organisationUnitGroups"
TYPE_GROUP_SET = "organisationUnitGroupSets"
TYPE_SQL_VIEW_CODE = "sqlViewCode"

# Deletion order: whatever references something else goes first.
DELETE_ORDER = [TYPE_SQL_VIEW_CODE, TYPE_GROUP_SET, TYPE_GROUP, TYPE_ORG_UNIT]

log = logging.getLogger("e2e")


class StateRecord:
    def __init__(self, api, run_id):
        self.api = api
        self.run_id = run_id
        self.entries = []
        self.saved = False

    def add(self, *entries):
        """Records entries and writes the record before returning."""
        self.entries.extend(entries)
        body = {"runId": self.run_id, "entries": self.entries}
        if self.saved:
            self.api.put(STATE_PATH, body)
        else:
            self.api.post(STATE_PATH, body)
            self.saved = True

    def clear(self):
        self.api.delete(STATE_PATH)
        self.saved = False
        self.entries = []


def _delete_history_for_sets(api, set_ids):
    """Deletes the app's own History entries for the given group sets: the
    app writes one for every change the suite makes through it."""
    if not set_ids:
        return
    keys = api.get_or_none(f"dataStore/{APP_NAMESPACE}") or []
    for key in keys:
        if not key.startswith(HISTORY_PREFIX):
            continue
        entry = api.get_or_none(f"dataStore/{APP_NAMESPACE}/{key}") or {}
        if entry.get("groupSetId") in set_ids:
            api.delete(f"dataStore/{APP_NAMESPACE}/{key}")


def _delete_sql_view_by_code(api, code):
    found = api.get(f"sqlViews?filter=code:eq:{code}&fields=id&paging=false")
    for view in found.get("sqlViews", []):
        api.delete(f"sqlViews/{view['id']}")


def _delete_entry(api, entry):
    kind = entry["type"]
    if kind == TYPE_SQL_VIEW_CODE:
        _delete_sql_view_by_code(api, entry["code"])
    else:
        api.delete(f"{kind}/{entry['id']}")


def _ordered(entries):
    """Entries in deletion order; org units deepest first."""
    def sort_key(entry):
        return (DELETE_ORDER.index(entry["type"]), -entry.get("depth", 0))
    return sorted(entries, key=sort_key)


def purge(api, entries):
    """Deletes everything listed. Raises after trying them all if any
    deletion failed, so a failed cleanup is never silent."""
    set_ids = {e["id"] for e in entries if e["type"] == TYPE_GROUP_SET}
    failures = []
    try:
        _delete_history_for_sets(api, set_ids)
    except Exception as error:  # noqa: BLE001 -- keep deleting the rest
        failures.append(f"history: {error}")
    for entry in _ordered(entries):
        try:
            _delete_entry(api, entry)
        except Exception as error:  # noqa: BLE001 -- keep deleting the rest
            failures.append(f"{entry}: {error}")
    if failures:
        raise RuntimeError("cleanup failed for " + "; ".join(failures))


def purge_leftovers(api):
    """Deletes whatever an earlier run left listed, then the record."""
    status, record = api.request("GET", STATE_PATH, allow=(NOT_FOUND,))
    if status == NOT_FOUND:
        return 0
    entries = (record or {}).get("entries", [])
    log.info("purging %d leftover object(s) from run %s", len(entries), (record or {}).get("runId"))
    purge(api, entries)
    api.delete(STATE_PATH)
    return len(entries)
