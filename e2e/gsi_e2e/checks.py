"""Server-side assertions: what the API says after the app wrote."""

from .api import poll
from .seed import groups_of, read_memberships
from .state import APP_NAMESPACE, HISTORY_PREFIX

SQL_VIEW_FIELDS = "id,code,name"


class SkipTest(Exception):
    """Raised by a test that cannot apply to this instance or user."""


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def wait_for_groups(api, fixture, ou_key, labels, timeout_s=45):
    """Waits until the org unit is in exactly these groups on the server."""
    ou = fixture.ou(ou_key)
    expected = {fixture.group(label).id for label in labels}

    def matches():
        return groups_of(read_memberships(api, fixture), ou.id) == expected

    if not poll(matches, timeout_s):
        actual = groups_of(read_memberships(api, fixture), ou.id)
        names = {g.id: g.label for g in fixture.groups.values()}
        raise AssertionError(
            f"expected {ou.name} in {sorted(labels)}, API shows "
            f"{sorted(names.get(i, i) for i in actual)}"
        )


def wait_for_baseline(api, fixture, timeout_s=45):
    if not poll(lambda: read_memberships(api, fixture) == fixture.baseline(), timeout_s):
        raise AssertionError("memberships did not return to the seeded state on the server")


def _change_sets_for(api, set_id):
    keys = api.get_or_none(f"dataStore/{APP_NAMESPACE}") or []
    found = []
    for key in keys:
        if key.startswith(HISTORY_PREFIX):
            entry = api.get_or_none(f"dataStore/{APP_NAMESPACE}/{key}")
            if entry and entry.get("groupSetId") == set_id:
                found.append(entry)
    return found


def wait_for_change_set(api, fixture, predicate, description, timeout_s=30):
    """Waits for a History entry the app saved in its dataStore namespace."""

    def find():
        return next((c for c in _change_sets_for(api, fixture.set_id) if predicate(c)), None)

    found = poll(find, timeout_s)
    check(found, f"no History entry {description} in dataStore {APP_NAMESPACE}")
    return found


def sql_views_by_code(api, code_prefix):
    body = api.get(f"sqlViews?filter=code:like:{code_prefix}&fields={SQL_VIEW_FIELDS}&paging=false")
    return {v["code"]: v for v in body.get("sqlViews", [])}


def sql_view_exists(api, code):
    body = api.get(f"sqlViews?filter=code:eq:{code}&fields=id&paging=false")
    return bool(body.get("sqlViews"))
