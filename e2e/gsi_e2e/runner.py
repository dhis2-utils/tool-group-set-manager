"""Runs the suite end to end and writes results.json (TESTING.md contract 1).

Stages: read the environment, purge leftovers, install the app, seed, run
the tests, clean up (always), write results. Exit 0 = all passed, 1 = a test
failed, 2 = the suite could not run (or could not clean up after itself).
"""

import json
import logging
import os
import sys
import time
import traceback
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

from . import ui
from .api import Api
from .checks import SkipTest, sql_view_exists
from .seed import restore_baseline, seed
from .state import StateRecord, purge, purge_leftovers
from .tests import TESTS, USAGE_VIEW_CODE, Context

CONTRACT_VERSION = 1
REQUIRED_ENV = ("DHIS2_URL", "DHIS2_USER", "DHIS2_PASS", "APP_ZIP", "RESULTS_DIR")
EXIT_PASSED, EXIT_FAILED, EXIT_ERROR = 0, 1, 2
VIEWPORT = {"width": 1440, "height": 900}
TEST_TIMEOUT_MS = 60_000

log = logging.getLogger("e2e")


class StageError(Exception):
    def __init__(self, stage, cause):
        super().__init__(f"{stage}: {cause}")
        self.stage = stage


@dataclass
class Run:
    env: dict
    api: Api = None
    label: str = ""
    server_version: str = ""
    app_name: str = ""
    app_version: str = ""
    app_key: str = ""
    app_installed: bool = False
    results: list = field(default_factory=list)
    error: str = None
    started: float = field(default_factory=time.monotonic)


# --- setup ------------------------------------------------------------------------

def read_env():
    missing = [name for name in REQUIRED_ENV if not os.environ.get(name)]
    if missing:
        raise StageError("environment", f"missing required variable(s): {', '.join(missing)}")
    env = {name: os.environ[name] for name in REQUIRED_ENV}
    env["DHIS2_URL"] = env["DHIS2_URL"].rstrip("/")
    env["LABEL"] = os.environ.get("LABEL", "")
    env["APP_KEY"] = os.environ.get("APP_KEY", "")
    if not os.path.isdir(env["RESULTS_DIR"]):
        raise StageError("environment", f"RESULTS_DIR {env['RESULTS_DIR']} is not a directory")
    if not os.path.isfile(env["APP_ZIP"]):
        raise StageError("environment", f"APP_ZIP {env['APP_ZIP']} does not exist")
    return env


def setup_logging(results_dir):
    handlers = [logging.StreamHandler(sys.stdout),
                logging.FileHandler(os.path.join(results_dir, "e2e.log"), mode="w")]
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", handlers=handlers)


def read_manifest(zip_path):
    with zipfile.ZipFile(zip_path) as archive:
        manifest = json.loads(archive.read("manifest.webapp"))
    return manifest["name"], manifest.get("version", "")


def identify_server(run):
    info = run.api.get("system/info")
    run.server_version = info["version"]
    run.label = run.env["LABEL"] or run.server_version
    run.app_name, run.app_version = read_manifest(run.env["APP_ZIP"])
    log.info("server %s, app %s %s", run.server_version, run.app_name, run.app_version)


def install_app(run):
    status = run.api.upload_app(run.env["APP_ZIP"])
    run.app_installed = True
    apps = run.api.get("apps")
    match = next((a for a in apps if a.get("name") == run.app_name), None)
    if not match:
        raise StageError("install", f"POST /api/apps answered {status} but no app named {run.app_name!r} is listed")
    run.app_key = run.env["APP_KEY"] or match["key"]
    log.info("installed %s (HTTP %s) as key %s", run.app_name, status, run.app_key)


def uninstall_app(run):
    if run.app_installed and run.app_key:
        run.api.delete(f"apps/{run.app_key}")
        log.info("uninstalled %s", run.app_key)


def level_names(api):
    body = api.get("organisationUnitLevels?fields=level,displayName&paging=false")
    return {lvl["level"]: lvl["displayName"] for lvl in body["organisationUnitLevels"]}


def authorities(api):
    return set(api.get("me?fields=authorities").get("authorities", []))


# --- tests ------------------------------------------------------------------------

def _screenshot(page, run, test_id):
    path = os.path.join(run.env["RESULTS_DIR"], f"{run.label}-{test_id}.png")
    try:
        page.screenshot(path=path, full_page=True)
    except Exception:  # noqa: BLE001 -- a screenshot is best effort
        log.warning("could not save a screenshot for %s", test_id)


def _first_line(error):
    text = str(error).strip() or type(error).__name__
    return text.splitlines()[0][:500]


def run_one(run, ctx, pages, test_id, test):
    started = time.monotonic()
    result = {"id": test_id, "status": "pass"}
    try:
        test(ctx)
    except SkipTest as skip:
        result.update(status="skip", message=str(skip))
    except Exception as error:  # noqa: BLE001 -- any failure fails this test only
        result.update(status="fail", message=_first_line(error))
        log.error("%s failed:\n%s", test_id, traceback.format_exc())
        if pages:
            _screenshot(pages[-1], run, test_id)
    finally:
        for page in pages:
            page.close()
        pages.clear()
        restored = restore_baseline(ctx.api, ctx.fixture)
        if restored:
            log.warning("%s: restored %d group(s) to the seeded state", test_id, len(restored))
    result["duration_s"] = round(time.monotonic() - started, 1)
    log.info("%-28s %s %s", test_id, result["status"].upper(), result.get("message", ""))
    run.results.append(result)


def login(context, run):
    """A session cookie from Basic-auth GET /api/me, shared with every page in
    the context. (POST /api/auth/login does not exist on older versions.)"""
    response = context.request.get(
        f"{run.env['DHIS2_URL']}/api/me",
        headers={"Authorization": run.api.auth_header},
    )
    if not response.ok:
        raise StageError("login", f"GET /api/me answered HTTP {response.status}")


def run_tests(run, ctx_args):
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=["--disable-dev-shm-usage"])
        try:
            context = browser.new_context(viewport=VIEWPORT)
            context.set_default_timeout(TEST_TIMEOUT_MS)
            login(context, run)
            pages = []

            def new_session():
                page = context.new_page()
                pages.append(page)
                return ui.AppSession(page, run.env["DHIS2_URL"], run.app_key)

            ctx = Context(new_session=new_session, **ctx_args)
            for test_id, test in TESTS:
                run_one(run, ctx, pages, test_id, test)
        finally:
            browser.close()


# --- results ----------------------------------------------------------------------

def write_results(run):
    tally = {s: sum(1 for r in run.results if r["status"] == s) for s in ("pass", "fail", "skip")}
    body = {
        "contract_version": CONTRACT_VERSION,
        "label": run.label,
        "server_version": run.server_version,
        "app_key": run.app_key,
        "app_version": run.app_version,
        "duration_s": round(time.monotonic() - run.started),
        "total": len(run.results),
        "passed": tally["pass"],
        "failed": tally["fail"],
        "skipped": tally["skip"],
        "tests": run.results,
    }
    if run.error:
        # Contract: on exit >= 2 the tests list is empty; e2e.log has them.
        body.update(error=run.error, tests=[], total=0, passed=0, failed=0, skipped=0)
    with open(os.path.join(run.env["RESULTS_DIR"], "results.json"), "w") as handle:
        json.dump(body, handle, indent=2)
    return body


def exit_code(run):
    if run.error:
        return EXIT_ERROR
    return EXIT_FAILED if any(r["status"] == "fail" for r in run.results) else EXIT_PASSED


# --- orchestration --------------------------------------------------------------

def _stage(name, action, *args):
    try:
        return action(*args)
    except StageError:
        raise
    except Exception as error:  # noqa: BLE001 -- reported as a stage failure
        raise StageError(name, error) from error


def prepare_and_test(run, state):
    _stage("purge", purge_leftovers, run.api)
    usage_preexisting = _stage("purge", sql_view_exists, run.api, USAGE_VIEW_CODE)
    _stage("install", install_app, run)
    fixture = _stage("seed", seed, run.api, state, state.run_id)
    log.info("seeded fixture %s", fixture.prefix)
    ctx_args = {
        "api": run.api,
        "fixture": fixture,
        "state": state,
        "level_names": _stage("seed", level_names, run.api),
        "authorities": _stage("seed", authorities, run.api),
        "usage_view_preexisting": usage_preexisting,
    }
    _stage("browser", run_tests, run, ctx_args)


def clean_up(run, state):
    """Deletes this run's objects and the record, then uninstalls the app.
    A failure here leaves the instance polluted, so it is a run error."""
    try:
        purge(run.api, state.entries)
        state.clear()
    except Exception as error:  # noqa: BLE001
        run.error = run.error or f"cleanup: {error}"
        log.error("cleanup failed: %s", error)
    try:
        uninstall_app(run)
    except Exception as error:  # noqa: BLE001
        run.error = run.error or f"uninstall: {error}"
        log.error("uninstall failed: %s", error)


def main():
    try:
        env = read_env()
    except StageError as error:
        print(f"e2e: {error}", file=sys.stderr)
        return EXIT_ERROR
    setup_logging(env["RESULTS_DIR"])
    run = Run(env=env, api=Api(env["DHIS2_URL"], env["DHIS2_USER"], env["DHIS2_PASS"]))
    state = None
    try:
        _stage("connect", identify_server, run)
        state = StateRecord(run.api, datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S"))
        prepare_and_test(run, state)
    except StageError as error:
        run.error = str(error)
        log.error("suite could not run: %s", error)
    finally:
        if state is not None:
            clean_up(run, state)
    body = write_results(run)
    log.info("passed %d, failed %d, skipped %d", body["passed"], body["failed"], body["skipped"])
    return exit_code(run)
