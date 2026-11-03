#!/usr/bin/env bash
# End-to-end suite entry point (TESTING.md contract 1). See e2e/README.md.
# Changes and deletes data: run it only against a throwaway DHIS2 instance.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for name in DHIS2_URL DHIS2_USER DHIS2_PASS APP_ZIP RESULTS_DIR; do
    if [[ -z "${!name:-}" ]]; then
        echo "e2e/run.sh: $name is required (no default; see e2e/README.md)" >&2
        exit 2
    fi
done

if ! python3 -c 'import playwright.sync_api' 2>/dev/null; then
    echo "e2e/run.sh: Playwright for Python is missing: pip install -r e2e/requirements.txt && python3 -m playwright install chromium" >&2
    exit 2
fi

cd "$here"
exec python3 run_suite.py
