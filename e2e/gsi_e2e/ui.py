"""Selectors and page helpers for driving the app.

Where the app's DOM lives: from 2.42 the global shell loads every app in an
<iframe> next to its own header, so the page itself only ever holds the
shell's chrome. 2.41 and earlier serve the app at the top level.
`AppSession.root()` hides that difference.

@dhis2/ui's SingleSelectField and InputField render a <label> that is not
wired to the control, so `get_by_label` cannot find them; they are located
by their data-test wrapper filtered on the label text instead.
"""

import re

from playwright.sync_api import expect

# --- selectors -------------------------------------------------------------
IFRAME = "iframe"
FILTER_BAR = '[data-test="filter-bar"]'
CARD = '[data-test="group-set-card"]'
CARD_NAME = '[data-test="group-set-card-name"]'
FRESHNESS = '[data-test="metadata-freshness"]'
OBJECTS_COUNT = '[data-test="objects-count"]'
OBJECTS_SCROLL = '[data-test="objects-table-scroll"]'
OBJECTS_ROW = '[data-test="objects-table-row"]'
INPUT_FIELD = '[data-test="dhis2-uiwidgets-inputfield"]'
SELECT_FIELD = '[data-test="dhis2-uiwidgets-singleselectfield"]'
SELECT_INPUT = '[data-test="dhis2-uicore-select-input"]'
SELECT_OPTION = '[data-test="dhis2-uicore-singleselectoption"]'
MODAL_CONTENT = '[data-test="dhis2-uicore-modalcontent"]'
MODAL_ACTIONS = '[data-test="dhis2-uicore-modalactions"]'
INTEGRITY_TITLE = '[data-test="integrity-check-title"]'
HISTORY_ROW = "table tbody tr"
LOGIN_FIELD = 'input[name="j_username"]'
PARENT_ELEMENT = "xpath=.."
PREVIOUS_ELEMENT = "xpath=preceding-sibling::*[1]"

# --- texts the app renders ---------------------------------------------------
SCOPE_LABEL = "Organisation unit"
ROWS_LABEL = "Rows"
SEARCH_LABEL = "Search"
STATUS_LABEL = "Status"
STATUS_ALL = "All"
TAB_OVERVIEW = "Overview"
TAB_OBJECTS = "Objects"
TAB_USAGE = "Usage"
TAB_INTEGRITY = "DHIS2 integrity"
TOTAL_HEADER = "Total"
APPLIED_PREFIX = "All changes applied to"
METADATA_FROM = re.compile(r"^Metadata from ")
COUNT_TEXT = re.compile(r"^([\d,]+) objects?$")

# --- timeouts (ms) -----------------------------------------------------------
SHELL_IFRAME_MS = 10_000
APP_LOAD_MS = 120_000
WRITE_MS = 60_000
SHORT_MS = 15_000


def count_label(count):
    return "1 object" if count == 1 else f"{count:,} objects"


class AppSession:
    """One browser page on the installed app."""

    def __init__(self, page, base_url, app_key):
        self.page = page
        self.app_url = f"{base_url}/api/apps/{app_key}/index.html"

    def root(self):
        """The frame holding the app's DOM (2.42+) or the page (2.41-).
        The shell inserts the iframe a moment after load, so wait for it
        briefly rather than checking once."""
        iframe = self.page.locator(IFRAME).first
        try:
            iframe.wait_for(state="attached", timeout=SHELL_IFRAME_MS)
            return self.page.frame_locator(IFRAME).first
        except Exception:  # noqa: BLE001 -- no shell: the app is the page
            return self.page

    def goto(self, route):
        self.page.goto(f"{self.app_url}#{route}")
        return self.root()


# --- navigation --------------------------------------------------------------

def open_dashboard(session):
    root = session.goto("/")
    expect(root.locator(FILTER_BAR).get_by_text(SCOPE_LABEL, exact=True)).to_be_visible(timeout=APP_LOAD_MS)
    return root


def open_group_set(session, fixture):
    root = session.goto(f"/sets/{fixture.set_id}")
    heading = root.get_by_role("heading", name=fixture.set_name, exact=True)
    expect(heading).to_be_visible(timeout=APP_LOAD_MS)
    return root


def open_tab(root, name):
    tab = root.get_by_role("tab", name=name, exact=True)
    tab.click()
    expect(tab).to_have_attribute("aria-selected", "true")


def open_objects_tab(root):
    open_tab(root, TAB_OBJECTS)
    expect(root.locator(OBJECTS_SCROLL)).to_be_visible(timeout=APP_LOAD_MS)


def open_overview_tab(root):
    open_tab(root, TAB_OVERVIEW)
    expect(root.get_by_role("columnheader", name=TOTAL_HEADER, exact=True)).to_be_visible(timeout=APP_LOAD_MS)


def open_history(session):
    root = session.goto("/history")
    expect(root.get_by_role("heading", name="History", exact=True)).to_be_visible(timeout=APP_LOAD_MS)
    return root


def open_settings(session):
    root = session.goto("/settings")
    expect(root.get_by_role("heading", name="SQL views", exact=True)).to_be_visible(timeout=APP_LOAD_MS)
    return root


# --- form controls ----------------------------------------------------------

def select_field(root, label):
    return root.locator(SELECT_FIELD).filter(has_text=label)


def input_field(root, label):
    return root.locator(INPUT_FIELD).filter(has_text=label).locator("input")


def _pick_option(root, field, option_label):
    """Picks an option unless it is already chosen: clicking the option
    that is already selected leaves the menu (and its click-intercepting
    backdrop) open."""
    select = field.locator(SELECT_INPUT)
    expect(select).to_be_visible(timeout=APP_LOAD_MS)
    if select.inner_text().strip() == option_label:
        return
    select.click()
    root.locator(f'{SELECT_OPTION}[data-label="{option_label}"]').click()


def choose_option(root, field_label, option_label):
    _pick_option(root, select_field(root, field_label), option_label)


def choose_filter_bar_option(root, field_label, option_label):
    """FilterBar renders its label as a sibling <span> of the widget, not
    inside it, so the widget is found through the label's parent."""
    label = root.locator(FILTER_BAR).get_by_text(field_label, exact=True)
    field = label.locator(PARENT_ELEMENT).locator(SELECT_FIELD)
    _pick_option(root, field, option_label)


def modal_actions(root):
    return root.locator(MODAL_ACTIONS)


def modal_content(root):
    return root.locator(MODAL_CONTENT)


# --- objects table ----------------------------------------------------------

def objects_count(root):
    return root.locator(OBJECTS_COUNT)


def read_count(root):
    """The objects tab's count as an int, once it shows one."""
    count = objects_count(root)
    expect(count).to_have_text(COUNT_TEXT, timeout=APP_LOAD_MS)
    match = COUNT_TEXT.match(count.inner_text().strip())
    return int(match.group(1).replace(",", ""))


def search_objects(root, text, expected_count):
    input_field(root, SEARCH_LABEL).fill(text)
    expect(objects_count(root)).to_have_text(count_label(expected_count), timeout=SHORT_MS)


def object_row(root, name):
    return root.locator(OBJECTS_ROW).filter(has_text=name)


def membership_button(row, group_name):
    return row.get_by_role("button", name=group_name, exact=True)


# --- overview matrix --------------------------------------------------------

def show_rows_at_level(root, level_label):
    choose_filter_bar_option(root, ROWS_LABEL, level_label)


def matrix_row(root, name):
    return root.get_by_role("row", name=re.compile(rf"^{re.escape(name)}\b"))


def matrix_cells(row):
    """(missing, conflict, total) cells: the last three columns."""
    cells = row.get_by_role("cell")
    return cells.nth(-3), cells.nth(-2), cells.nth(-1)


# --- history -----------------------------------------------------------------

def history_row(root, text):
    return root.locator(HISTORY_ROW).filter(has_text=text).first


def revert_history_row(root, text):
    """Opens the History row containing `text`, reverts it, and closes the
    result. Returns the dialog's content locator text for assertions."""
    row = history_row(root, text)
    expect(row).to_be_visible(timeout=SHORT_MS)
    row.get_by_role("button", name="Revert", exact=True).first.click()
    expect(root.get_by_role("heading", name="Revert change")).to_be_visible()
    actions = modal_actions(root)
    revert = actions.get_by_role("button", name="Revert", exact=True)
    expect(revert).to_be_enabled(timeout=WRITE_MS)
    content = modal_content(root).inner_text()
    revert.click()
    expect(root.get_by_text(APPLIED_PREFIX).first).to_be_visible(timeout=WRITE_MS)
    actions.get_by_role("button", name="Close", exact=True).click()
    return content
