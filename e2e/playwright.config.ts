import { defineConfig, devices } from '@playwright/test'

/**
 * Runs the built app installed on two live DHIS2 instances (task-9-brief.md):
 * 2.43.1 and 2.40.12. Neither instance is a throwaway -- see e2e/flows.spec.ts
 * for how every writing test reverts through the app's own History.
 *
 * There is no `webServer` entry: the dev server cannot be used here (its
 * origin differs from the API's, and the broker sends no
 * `access-control-*` headers -- see fixtures/session.ts). Each project
 * points straight at the app already installed on that instance.
 */
export default defineConfig({
    testDir: '.',
    testMatch: '**/*.spec.ts',
    fullyParallel: false,
    forbidOnly: Boolean(process.env.CI),
    retries: 0,
    reporter: [['list']],
    // One worker: the two projects' browsers, run concurrently on this
    // sandbox's 4 shared CPUs, were measured starving each other's page --
    // the engine's own status recompute after a write (all in a Web
    // Worker, CPU-bound) took over two minutes under that contention on
    // whichever project lost the scheduler, against a few seconds with
    // only one browser running. Serializing removes that contention; it
    // costs wall-clock time, not correctness.
    workers: 1,
    // Individual waits after a write allow up to 240s each (this instance's
    // dataStore save and engine reload can legitimately take that long
    // against the metadata API -- see flows.spec.ts's
    // waitForNewestHistoryRow), and a single test can chain more than one
    // of those (write, then revert), so the overall budget needs headroom
    // well above a single step's own allowance.
    timeout: 480_000,
    expect: { timeout: 10_000 },
    use: {
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        // The sandbox's egress firewall does not reach the host Playwright's
        // own installer downloads browsers from
        // (playwright.download.prss.microsoft.com), so `playwright install`
        // cannot fetch anything not already on disk. The exact revision
        // `@playwright/test`'s default project wants (chrome-headless-shell)
        // is missing, but the full chromium binary for the same revision is
        // already present at this path -- pointing at it directly avoids
        // the download entirely.
        launchOptions: {
            executablePath:
                '/opt/playwright-browsers/chromium-1243/chrome-linux-arm64/chrome',
        },
    },
    projects: [
        {
            name: '2.43.1',
            use: {
                ...devices['Desktop Chrome'],
                baseURL: 'http://dhis2-agent-gsi-p2:8080',
            },
        },
        {
            name: '2.40.12',
            use: {
                ...devices['Desktop Chrome'],
                baseURL: 'http://dhis2-agent-gsi-p2-40:8080',
            },
        },
    ],
})
