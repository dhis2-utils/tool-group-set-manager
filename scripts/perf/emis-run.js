// Performance measurement driver for the EMIS 266,396-org-unit instance
// (docs/superpowers/notes/2026-09-plan3-performance.md, Task 10 + fix round
// 1). Kept in the repository per that note's own recommendation (fix round
// 1, m4/M-series review) so a future run is a re-run, not a
// re-implementation from scratch.
//
// Not part of e2e/ (Task 9's Playwright suite): this script needs raw
// network-request visibility (counting `sqlViews/{id}/data.csv` fetches to
// tell a genuine cache hit apart from a load that merely finished quickly)
// and fine-grained wall-clock control over cold vs warm browser state that
// the shared e2e fixtures don't expose. It reuses the same session
// mechanics as e2e/fixtures/session.ts: Basic-auth GET /api/me, the
// resulting cookie shared into the browser context, and the
// iframe-or-page `appRoot` (a Global App Shell wraps the app in an
// <iframe> on some DHIS2 versions, not on others).
//
// Usage: node scripts/perf/emis-run.js
// Requires: the app already built and installed on the target instance
// (pnpm build && POST /api/apps), and BASE_URL answering.
//
// Overridable via environment variables (fix round 2 -- a previous version
// hard-coded the instance's own default credentials with no override, and
// pinned `EXEC` to a specific Chromium build revision path
// (`chromium-1243/...-arm64`) that is only ever going to be correct for as
// long as that exact revision happens to still be installed):
//   GSI_PERF_BASE_URL       target instance (default: agent-gsi-emis)
//   GSI_PERF_USERNAME       login (default: local_admin)
//   GSI_PERF_PASSWORD       password (default: district)
//   PLAYWRIGHT_CHROME_PATH  explicit browser binary, if the bundled one
//                           found via `chromium.executablePath()` isn't
//                           right for the machine this runs on
'use strict'
const { chromium } = require('@playwright/test')

const BASE_URL =
    process.env.GSI_PERF_BASE_URL || 'http://dhis2-agent-gsi-emis:8080'
const APP_PATH = '/api/apps/group-set-integrity-tool/index.html'
const CREDS = {
    username: process.env.GSI_PERF_USERNAME || 'local_admin',
    password: process.env.GSI_PERF_PASSWORD || 'district',
}
// `chromium.executablePath()` asks the installed Playwright package for
// whatever browser revision it actually bundles right now, so this stays
// correct across Playwright upgrades without a hard-coded, eventually-stale
// revision path. `PLAYWRIGHT_CHROME_PATH` still wins when set, for a machine
// where that default isn't the right binary.
const EXEC = process.env.PLAYWRIGHT_CHROME_PATH || chromium.executablePath()

function now() {
    return Date.now()
}

async function appRoot(page) {
    const iframe = page.locator('iframe').first()
    try {
        await iframe.waitFor({ state: 'attached', timeout: 5000 })
        return page.frameLocator('iframe')
    } catch {
        return page
    }
}

async function newAuthedContext(browser) {
    const context = await browser.newContext({ baseURL: BASE_URL })
    const auth = Buffer.from(`${CREDS.username}:${CREDS.password}`).toString(
        'base64'
    )
    const meResp = await context.request.get(`${BASE_URL}/api/me`, {
        headers: { Authorization: `Basic ${auth}` },
    })
    if (!meResp.ok()) throw new Error(`api/me failed: ${meResp.status()}`)
    const page = await context.newPage()
    return { context, page }
}

/**
 * Loads the app and reports the real cache-hit/miss signal (a count of
 * `sqlViews/{id}/data.csv` requests, from the network -- ground truth,
 * confirmed against raw request logging) plus a completion timestamp.
 *
 * Getting the completion timestamp right took two wrong turns worth
 * recording, because both are the exact "signal that can't tell finished
 * from never-started" defect class this branch's reviews keep finding:
 *
 * 1. `LoadProgress`'s DOM text ("progress text absent") cannot fire before
 *    the text has ever appeared -- and on a genuine cache hit it never
 *    does, so a naive poll can time out or (worse) fire on an accidental,
 *    momentary reading of "not present yet". Fix round 1, M1.
 * 2. Playwright's own `waitForLoadState('networkidle')`, and a hand-rolled
 *    "no request started in the last N ms" check, both fail here for the
 *    opposite reason: on a genuine cold load this app fetches its three
 *    CSVs *sequentially*, each gated on the previous one finishing plus
 *    real client-side parsing, and the gaps between requests starting
 *    (confirmed by direct instrumentation: request 2 start -> request 3
 *    start was ~4.1s on one run) comfortably exceed any quiet-window
 *    threshold short enough to still catch a genuine warm no-op quickly.
 *    Both approaches reported "settled" immediately after first paint on
 *    a COLD run that other instrumentation proved was still mid-fetch --
 *    the opposite failure from #1, but the same root cause: inferring
 *    "nothing more will happen" from an absence that a slow-but-genuine
 *    load can also produce.
 *
 * The fix used here needs both signals, because neither alone covers both
 * the cold and the warm case: watch the `LoadProgress` phase text with NO
 * upper bound other than the real timeout, but only ever treat its
 * disappearance as completion *after* it has been seen present at least
 * once (correct and sufficient for a cold load, which shows multiple
 * multi-second phases). For the case that text handles badly -- a load
 * that finishes so fast the phase text is never observed between polls --
 * fall back on the network ground truth: once `graceMs` has passed since
 * first paint with the phase text never once seen AND zero CSV fetches
 * observed, the load is a genuine, instant cache hit and first paint IS
 * the completion time.
 */
async function loadAndWatchNetwork(
    page,
    t0,
    navigate,
    { graceMs = 3000, pollMs = 100, timeoutMs = 60000 } = {}
) {
    let csvFetches = 0
    const onRequest = (req) => {
        if (/sqlViews\/[^/]+\/data\.csv/.test(req.url())) csvFetches += 1
    }
    // Attached before the navigation itself is triggered -- a listener
    // added only after `goto`/`reload` resolves would already have missed
    // every request the initial document load made.
    page.on('request', onRequest)
    await navigate()

    const root = await appRoot(page)
    await root.getByText('Scope:', { exact: false }).waitFor({ timeout: 30000 })
    const firstPaint = now() - t0

    const progressLocator = root.locator('text=/Loading|Checking/').first()
    let everSeen = false
    let settledAt = null
    const deadline = now() + timeoutMs
    while (now() < deadline) {
        let present = false
        try {
            present = (await progressLocator.count()) > 0
        } catch {
            /* transient DOM churn between count() and this read */
        }
        if (present) {
            everSeen = true
        } else if (everSeen) {
            settledAt = now() - t0
            break
        } else if (now() - t0 - firstPaint >= graceMs && csvFetches === 0) {
            // Never seen, generous grace period elapsed, and the network
            // confirms nothing was ever fetched: a genuine, instant cache
            // hit -- first paint already was completion.
            settledAt = firstPaint
            break
        }
        await new Promise((r) => setTimeout(r, pollMs))
    }
    if (settledAt === null) settledAt = now() - t0 // timed out; report what we have

    page.off('request', onRequest)

    return { firstPaint, settledAt, csvFetches, root }
}

async function main() {
    const browser = await chromium.launch({ executablePath: EXEC })
    const out = {}

    // ---------------------------------------------------------------
    // COLD dashboard load: brand-new browser context (empty IndexedDB),
    // run first in this session so nothing has warmed anything yet.
    // ---------------------------------------------------------------
    {
        const { context, page } = await newAuthedContext(browser)
        const t0 = now()
        const { firstPaint, settledAt, csvFetches } = await loadAndWatchNetwork(
            page,
            t0,
            () => page.goto(`${BASE_URL}${APP_PATH}`)
        )
        console.log(
            `[cold] firstPaint=${firstPaint}ms settled=${settledAt}ms csvFetches=${csvFetches}`
        )
        out.cold = { firstPaint, settledAt, csvFetches }
        await context.close()
    }

    // ---------------------------------------------------------------
    // WARM dashboard load: same context reused across several reloads, so
    // IndexedDB is genuinely warm. Reports csvFetches per reload -- 0
    // means a real cache hit, not just "finished quickly".
    // ---------------------------------------------------------------
    {
        const { context, page } = await newAuthedContext(browser)
        const tPrime = now()
        const prime = await loadAndWatchNetwork(page, tPrime, () =>
            page.goto(`${BASE_URL}${APP_PATH}`)
        )
        console.log(
            `[warm-prime] firstPaint=${prime.firstPaint}ms settled=${prime.settledAt}ms csvFetches=${prime.csvFetches}`
        )

        out.warmReloads = []
        for (let i = 0; i < 4; i++) {
            const t0 = now()
            const r = await loadAndWatchNetwork(page, t0, () => page.reload())
            console.log(
                `[warm-reload-${i + 1}] firstPaint=${r.firstPaint}ms settled=${r.settledAt}ms csvFetches=${r.csvFetches}`
            )
            out.warmReloads.push(r)
        }

        await context.close()
    }

    console.log('SUMMARY', JSON.stringify(out, null, 2))
    await browser.close()
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
