"""The tests. Each takes a `Context` and either returns (pass), raises
`SkipTest` (skip) or raises anything else (fail).

Every test that writes through the app checks the result against the API,
then reverts through the app's own History and checks the server again.
The runner also restores the seeded memberships through the API after each
test, so a test that dies half way cannot change the next one's numbers.
"""

import json
import re
import logging
from dataclasses import dataclass

from playwright.sync_api import expect

from . import ui
from .api import poll
from .checks import (
    SkipTest,
    check,
    sql_view_exists,
    sql_views_by_code,
    wait_for_baseline,
    wait_for_change_set,
    wait_for_groups,
)
from .seed import count_org_units, restore_baseline
from .state import TYPE_SQL_VIEW_CODE

# Seeded matrix row for the fixture parent (see seed.py).
PARENT_ROW_MISSING = 2
PARENT_ROW_CONFLICT = 1
PARENT_ROW_TOTAL = 6
FIXTURE_OK = 3
FIXTURE_CONFLICT = 1
FIXTURE_ASSIGNED = 4

GSI_VIEW_NAMES = {
    "GSI_ORGUNITS": "GSI org unit hierarchy",
    "GSI_ORGUNIT_NAMES": "GSI org unit names",
    "GSI_ORGUNIT_MEMBERSHIPS": "GSI org unit group memberships",
}
USAGE_VIEW_CODE = "GSI_GROUPSET_USAGE"
USAGE_VIEW_LABEL = "Group set usage view"
STATUS_TAGS = {"Usable", "Not usable yet", "Missing"}
MAINTENANCE_AUTHORITIES = {"ALL", "F_PERFORM_MAINTENANCE"}
NO_MATCH_TERM = "zzz-no-such-object-zzz"
# ObjectsTable's page size: rows past it load only when scrolled to.
OBJECTS_PAGE_SIZE = 200
log = logging.getLogger("e2e")
INTEGRITY_RESULT = re.compile(r"found .* objects? across all group sets on this instance as of")


@dataclass
class Context:
    api: object
    fixture: object
    new_session: object  # () -> ui.AppSession on a fresh page
    state: object
    level_names: dict
    authorities: set
    usage_view_preexisting: bool

    def level_label(self, level):
        return f"{self.level_names[level]} (level {level})"


# --- shared steps -------------------------------------------------------------

def _stat_value(card, label):
    value = card.get_by_text(label, exact=True).locator(ui.PREVIOUS_ELEMENT)
    return int(value.inner_text().replace(",", "").strip())


def _fixture_objects(ctx):
    """Objects tab, status All, for the fixture set."""
    session = ctx.new_session()
    root = ui.open_group_set(session, ctx.fixture)
    ui.open_objects_tab(root)
    ui.choose_option(root, ui.STATUS_LABEL, ui.STATUS_ALL)
    return session, root


def _parent_matrix_row(ctx, root):
    ui.open_overview_tab(root)
    ui.show_rows_at_level(root, ctx.level_label(ctx.fixture.parent_level))
    row = ui.matrix_row(root, ctx.fixture.ou("parent").name)
    expect(row).to_be_visible(timeout=ui.APP_LOAD_MS)
    return row


def _assign_one(ctx, root, ou_key, label):
    """Single assign through the segmented control and its confirm dialog."""
    ou, group = ctx.fixture.ou(ou_key), ctx.fixture.group(label)
    ui.search_objects(root, ou.name, 1)
    row = ui.object_row(root, ou.name)
    ui.membership_button(row, group.name).click()
    expect(root.get_by_role("heading", name="Confirm group change")).to_be_visible()
    expect(root.get_by_text(
        f"{ou.name} will be assigned to {group.name} and removed from any other group in this set"
    )).to_be_visible()
    ui.modal_actions(root).get_by_role("button", name="Assign", exact=True).click()
    return row


def _assign_note(ctx, ou_key, label):
    return f"Assigned {ctx.fixture.ou(ou_key).name} to {ctx.fixture.group(label).name}"


def _expect_states(row, fixture, states):
    for label, state in states.items():
        button = ui.membership_button(row, fixture.group(label).name)
        expect(button).to_have_attribute("data-state", state, timeout=ui.WRITE_MS)


# --- tests ----------------------------------------------------------------------

def test_dashboard_cards(ctx):
    session = ctx.new_session()
    root = ui.open_dashboard(session)
    fixture = ctx.fixture
    card = root.locator(ui.CARD).filter(
        has=root.locator(f"{ui.CARD_NAME}:text-is({json.dumps(fixture.set_name)})")
    )
    expect(card).to_be_visible(timeout=ui.APP_LOAD_MS)
    expect(card.get_by_text("Compulsory", exact=True)).to_be_visible()
    expect(card.get_by_text("Data dimension", exact=True)).to_be_visible()
    expect(card.get_by_text("OK", exact=True)).to_be_visible(timeout=ui.APP_LOAD_MS)
    total = count_org_units(ctx.api)
    conflicts, missing, ok = (_stat_value(card, n) for n in ("Conflicts", "Missing", "OK"))
    check(conflicts == FIXTURE_CONFLICT, f"card shows {conflicts} conflicts, seeded {FIXTURE_CONFLICT}")
    check(ok == FIXTURE_OK, f"card shows {ok} OK, seeded {FIXTURE_OK}")
    check(missing == total - FIXTURE_ASSIGNED,
          f"card shows {missing} missing, API has {total} org units of which {FIXTURE_ASSIGNED} are in a group")
    expect(session.page.locator(ui.LOGIN_FIELD)).to_have_count(0)
    card.click()
    expect(root.get_by_role("heading", name=fixture.set_name, exact=True)).to_be_visible(timeout=ui.APP_LOAD_MS)


def test_freshness_refresh(ctx):
    """Refresh must pick up a change made on the server behind the app's back."""
    session = ctx.new_session()
    root = ui.open_group_set(session, ctx.fixture)
    row = _parent_matrix_row(ctx, root)
    missing, _, _ = ui.matrix_cells(row)
    expect(missing).to_have_text(str(PARENT_ROW_MISSING), timeout=ui.APP_LOAD_MS)
    freshness = root.locator(ui.FRESHNESS)
    expect(freshness.get_by_text(ui.METADATA_FROM)).to_be_visible(timeout=ui.SHORT_MS)

    gamma = ctx.fixture.group("Gamma")
    child4 = ctx.fixture.ou("child4")
    ctx.api.patch(f"organisationUnitGroups/{gamma.id}",
                  [{"op": "add", "path": "/organisationUnits/-", "value": {"id": child4.id}}])
    wait_for_groups(ctx.api, ctx.fixture, "child4", ["Gamma"])

    refresh = freshness.get_by_role("button", name="Refresh")
    refresh.click()
    expect(refresh).to_be_enabled(timeout=ui.APP_LOAD_MS)
    expect(freshness.get_by_text(ui.METADATA_FROM)).to_be_visible(timeout=ui.APP_LOAD_MS)
    row = ui.matrix_row(root, ctx.fixture.ou("parent").name)
    expect(ui.matrix_cells(row)[0]).to_have_text(str(PARENT_ROW_MISSING - 1), timeout=ui.APP_LOAD_MS)
    restore_baseline(ctx.api, ctx.fixture)


def test_drilldown_matrix_to_objects(ctx):
    session = ctx.new_session()
    root = ui.open_group_set(session, ctx.fixture)
    row = _parent_matrix_row(ctx, root)
    for label in ("Alpha", "Beta", "Gamma"):
        header = root.get_by_role("columnheader", name=ctx.fixture.group(label).name)
        expect(header).to_be_visible()
    missing, conflict, total = ui.matrix_cells(row)
    expect(total).to_have_text(str(PARENT_ROW_TOTAL), timeout=ui.APP_LOAD_MS)
    expect(missing).to_have_text(str(PARENT_ROW_MISSING))
    expect(conflict).to_have_text(str(PARENT_ROW_CONFLICT))

    total.click()
    expect(ui.objects_count(root)).to_have_text(ui.count_label(PARENT_ROW_TOTAL), timeout=ui.APP_LOAD_MS)
    expect(root.locator(ui.OBJECTS_ROW)).to_have_count(PARENT_ROW_TOTAL)

    row = _parent_matrix_row(ctx, root)
    ui.matrix_cells(row)[1].click()
    expect(ui.objects_count(root)).to_have_text(ui.count_label(PARENT_ROW_CONFLICT), timeout=ui.APP_LOAD_MS)
    expect(ui.object_row(root, ctx.fixture.ou("child3").name)).to_be_visible()


def _search_beyond_first_page(ctx, root):
    """Search is a predicate over the whole population, not over the rows
    loaded so far: find the object the app loads last (the API's default
    order, by name), far past the first page of rows."""
    names = [o["name"] for o in ctx.api.get("organisationUnits?fields=name&paging=false")["organisationUnits"]]
    if len(names) <= OBJECTS_PAGE_SIZE:
        log.info("search-objects: fewer org units than one page; beyond-first-page step not exercised")
        return
    last = names[-1]
    expected = sum(1 for n in names if last.lower() in n.lower())
    ui.search_objects(root, last, expected)
    expect(root.get_by_text(last, exact=True).first).to_be_visible()


def test_search_objects(ctx):
    _, root = _fixture_objects(ctx)
    unfiltered = ui.read_count(root)
    total = count_org_units(ctx.api)
    check(unfiltered == total, f"Objects tab counts {unfiltered}, API has {total} org units")

    ui.search_objects(root, ctx.fixture.run_id, PARENT_ROW_TOTAL)
    expect(root.locator(ui.OBJECTS_ROW)).to_have_count(PARENT_ROW_TOTAL)
    child5 = ctx.fixture.ou("child5").name
    ui.search_objects(root, child5, 1)
    expect(root.get_by_text(child5, exact=True).first).to_be_visible()
    _search_beyond_first_page(ctx, root)
    ui.input_field(root, ui.SEARCH_LABEL).fill("")
    expect(ui.objects_count(root)).to_have_text(ui.count_label(unfiltered), timeout=ui.SHORT_MS)
    ui.search_objects(root, NO_MATCH_TERM, 0)
    expect(root.locator(ui.OBJECTS_ROW)).to_have_count(0)


def test_single_assign_and_revert(ctx):
    """Resolve the seeded conflict on child 3 by keeping Alpha, then revert."""
    fixture = ctx.fixture
    session, root = _fixture_objects(ctx)
    row = _assign_one(ctx, root, "child3", "Alpha")
    wait_for_groups(ctx.api, fixture, "child3", ["Alpha"])
    note = _assign_note(ctx, "child3", "Alpha")
    wait_for_change_set(ctx.api, fixture, lambda c: c.get("note") == note, f"with note {note!r}")
    _expect_states(row, fixture, {"Alpha": "selected", "Beta": "none", "Gamma": "none"})

    root = ui.open_history(session)
    ui.revert_history_row(root, note)
    wait_for_groups(ctx.api, fixture, "child3", ["Alpha", "Beta"])
    wait_for_baseline(ctx.api, fixture)

    _, root = _fixture_objects(ctx)
    ui.search_objects(root, fixture.ou("child3").name, 1)
    row = ui.object_row(root, fixture.ou("child3").name)
    _expect_states(row, fixture, {"Alpha": "conflict", "Beta": "conflict", "Gamma": "none"})


def test_bulk_move_and_revert(ctx):
    """Drill into the parent's Missing cell and bulk-assign both to Gamma."""
    fixture = ctx.fixture
    gamma = fixture.group("Gamma")
    note = f"{fixture.prefix} bulk move"
    session = ctx.new_session()
    root = ui.open_group_set(session, fixture)
    row = _parent_matrix_row(ctx, root)
    missing = ui.matrix_cells(row)[0]
    expect(missing).to_have_text(str(PARENT_ROW_MISSING), timeout=ui.APP_LOAD_MS)
    missing.click()
    expect(ui.objects_count(root)).to_have_text(ui.count_label(PARENT_ROW_MISSING), timeout=ui.APP_LOAD_MS)

    root.get_by_role("button", name="Bulk fix…").click()
    expect(root.get_by_role("heading", name=f"Bulk fix {fixture.set_name}")).to_be_visible()
    root.get_by_label("Assign all to one group").check()
    ui.choose_option(root, "Target group", gamma.name)
    root.get_by_role("button", name="Next", exact=True).click()
    content = ui.modal_content(root)
    expect(content.get_by_text(ui.count_label(PARENT_ROW_MISSING), exact=True)).to_be_visible(timeout=ui.WRITE_MS)
    preview = content.locator("li", has_text=gamma.name).filter(has_text="+")
    expect(preview).to_have_text(re.compile(rf"\+{PARENT_ROW_MISSING} / -0"))
    ui.input_field(root, "Note for History (optional)").fill(note)
    root.get_by_role("button", name="Apply…").click()
    expect(root.get_by_text(f"{ui.APPLIED_PREFIX} {gamma.name}")).to_be_visible(timeout=ui.WRITE_MS)
    ui.modal_actions(root).get_by_role("button", name="Close", exact=True).click()

    for key in ("child4", "child5"):
        wait_for_groups(ctx.api, fixture, key, ["Gamma"])
    wait_for_change_set(ctx.api, fixture, lambda c: c.get("note") == note, f"with note {note!r}")

    root = ui.open_history(session)
    ui.revert_history_row(root, note)
    wait_for_baseline(ctx.api, fixture)

    root = ui.open_group_set(session, fixture)
    row = _parent_matrix_row(ctx, root)
    expect(ui.matrix_cells(row)[0]).to_have_text(str(PARENT_ROW_MISSING), timeout=ui.APP_LOAD_MS)


def test_history_revert(ctx):
    """Assign child 5 to Beta, then check History's row and revert dialog."""
    fixture = ctx.fixture
    child5 = fixture.ou("child5")
    session, root = _fixture_objects(ctx)
    _assign_one(ctx, root, "child5", "Beta")
    wait_for_groups(ctx.api, fixture, "child5", ["Beta"])
    note = _assign_note(ctx, "child5", "Beta")
    original = wait_for_change_set(ctx.api, fixture, lambda c: c.get("note") == note, f"with note {note!r}")

    root = ui.open_history(session)
    row = ui.history_row(root, note)
    expect(row).to_be_visible(timeout=ui.SHORT_MS)
    expect(row).to_contain_text("Assigned to a group")
    expect(row).to_contain_text(fixture.set_name)
    expect(row).to_contain_text("1 membership change")
    dialog_text = ui.revert_history_row(root, note)
    check(child5.name in dialog_text, f"revert dialog does not name {child5.name}: {dialog_text[:300]!r}")

    wait_for_groups(ctx.api, fixture, "child5", [])
    wait_for_baseline(ctx.api, fixture)
    wait_for_change_set(
        ctx.api, fixture,
        lambda c: c.get("action") == "revert" and c.get("revertOf") == original.get("id"),
        f"reverting {original.get('id')}",
    )
    root = ui.open_history(session)
    reverted = ui.history_row(root, "Reverted an earlier change").filter(has_text=fixture.set_name)
    expect(reverted).to_be_visible(timeout=ui.SHORT_MS)

    _, root = _fixture_objects(ctx)
    ui.search_objects(root, child5.name, 1)
    _expect_states(ui.object_row(root, child5.name), fixture, {"Alpha": "none", "Beta": "none", "Gamma": "none"})


def _view_status_tag(root, view_name):
    name = root.get_by_text(view_name, exact=True)
    expect(name).to_be_visible(timeout=ui.APP_LOAD_MS)
    return name.locator(ui.PARENT_ELEMENT)


def test_settings_sql_view_status(ctx):
    session = ctx.new_session()
    root = ui.open_settings(session)
    on_server = sql_views_by_code(ctx.api, "GSI_")
    for code, name in GSI_VIEW_NAMES.items():
        row = _view_status_tag(root, name)
        if code in on_server:
            expect(row).to_contain_text(re.compile("Usable|Not usable yet"), timeout=ui.SHORT_MS)
        else:
            expect(row).to_contain_text("Missing", timeout=ui.SHORT_MS)
    if any(code not in on_server for code in GSI_VIEW_NAMES):
        expect(root.get_by_role("button", name="Create SQL views")).to_be_visible()
    else:
        expect(root.get_by_text("SQL views are set up")).to_be_visible()
    usage_row = _view_status_tag(root, USAGE_VIEW_LABEL)
    expected_usage = re.compile("Usable|Not usable yet") if USAGE_VIEW_CODE in on_server else "Missing"
    expect(usage_row).to_contain_text(expected_usage, timeout=ui.SHORT_MS)


def test_integrity_tab(ctx):
    if not ctx.authorities & MAINTENANCE_AUTHORITIES:
        raise SkipTest("the user has neither ALL nor F_PERFORM_MAINTENANCE")
    session = ctx.new_session()
    root = ui.open_group_set(session, ctx.fixture)
    tab = root.get_by_role("tab", name=ui.TAB_INTEGRITY, exact=True)
    expect(tab).to_be_visible(timeout=ui.SHORT_MS)
    tab.click()
    expect(tab).to_have_attribute("aria-selected", "true")
    expect(root.locator(ui.INTEGRITY_TITLE).first).to_be_visible(timeout=ui.WRITE_MS)
    root.get_by_role("button", name="Run now").first.click()
    expect(root.get_by_text(INTEGRITY_RESULT).first).to_be_visible(timeout=ui.APP_LOAD_MS)
    # Read-only: the overlay must not have touched any membership.
    wait_for_baseline(ctx.api, ctx.fixture, timeout_s=1)


def test_usage_view_install_remove(ctx):
    if ctx.usage_view_preexisting:
        raise SkipTest(f"{USAGE_VIEW_CODE} existed before the run; the suite leaves it alone")
    ctx.state.add({"type": TYPE_SQL_VIEW_CODE, "code": USAGE_VIEW_CODE})
    session = ctx.new_session()
    root = ui.open_settings(session)
    install = root.get_by_role("button", name="Install usage SQL view")
    expect(install).to_be_visible(timeout=ui.APP_LOAD_MS)
    install.click()
    expect(root.get_by_text("Usage data is installed")).to_be_visible(timeout=ui.WRITE_MS)
    check(poll(lambda: sql_view_exists(ctx.api, USAGE_VIEW_CODE), 30),
          f"Settings says installed, but the API has no SQL view {USAGE_VIEW_CODE}")

    root = ui.open_group_set(session, ctx.fixture)
    ui.open_tab(root, ui.TAB_USAGE)
    expect(root.get_by_text("No saved favourite references this group set")).to_be_visible(timeout=ui.WRITE_MS)
    expect(root.get_by_text("0 recorded uses in the last 12 months")).to_be_visible()

    root = ui.open_settings(session)
    remove = root.get_by_role("button", name="Remove usage SQL view")
    expect(remove).to_be_visible(timeout=ui.APP_LOAD_MS)
    remove.click()
    expect(root.get_by_role("button", name="Install usage SQL view")).to_be_visible(timeout=ui.WRITE_MS)
    check(poll(lambda: not sql_view_exists(ctx.api, USAGE_VIEW_CODE), 30),
          f"Settings removed the usage view, but the API still has {USAGE_VIEW_CODE}")


TESTS = [
    ("dashboard-cards", test_dashboard_cards),
    ("freshness-refresh", test_freshness_refresh),
    ("drilldown-matrix-to-objects", test_drilldown_matrix_to_objects),
    ("search-objects", test_search_objects),
    ("single-assign-and-revert", test_single_assign_and_revert),
    ("bulk-move-and-revert", test_bulk_move_and_revert),
    ("history-revert", test_history_revert),
    ("settings-sql-view-status", test_settings_sql_view_status),
    ("integrity-tab", test_integrity_tab),
    ("usage-view-install-remove", test_usage_view_install_remove),
]
