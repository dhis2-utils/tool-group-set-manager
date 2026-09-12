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
    // One worker: running both projects' browsers concurrently on this
    // sandbox's 4 shared CPUs was measured starving whichever one lost the
    // scheduler -- the engine's own status recompute after a write (a Web
    // Worker, CPU-bound) took noticeably longer under that contention than
    // with only one browser running. Serializing removes that variable; it
    // costs wall-clock time (the suite runs projects one after another
    // instead of side by side), not correctness.
    workers: 1,
    // Every wait in flows.spec.ts is now on a specific, named condition
    // (a control re-enabling, a row's text, a result message) rather than a
    // fixed delay -- see waitForWriteToSettle's doc comment (fix round 1) --
    // so this is a safety ceiling for the whole test, not a number anything
    // is tuned against.
    timeout: 60_000,
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
        // the download entirely. `PLAYWRIGHT_CHROME_PATH` overrides this for
        // any other machine (or CI) where that path does not exist.
        launchOptions: {
            executablePath:
                process.env.PLAYWRIGHT_CHROME_PATH ??
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
