import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { chromium, defineConfig, devices } from '@playwright/test'

/**
 * Which Chromium to launch.
 *
 * This has cost time in three separate plans, so it resolves rather than
 * assumes. A hardcoded path embeds a browser revision and a platform triple
 * and goes stale the moment either moves -- the old default named
 * `chromium-1243/chrome-linux-arm64` on an image shipping
 * `chromium-1234/chrome-linux`, and every run failed at launch until
 * `PLAYWRIGHT_CHROME_PATH` was exported.
 *
 * `chromium.executablePath()` alone does not fix that, which is worth
 * stating because it looks like it should: it reports the revision the
 * installed `@playwright/test` *wants*, which in this sandbox is exactly
 * the 1243 that is not there. It is right whenever the package and the
 * browsers were installed together, and wrong in precisely the case that
 * keeps biting.
 *
 * So: the env var wins if set, then the package's own answer if that
 * actually exists on disk, and failing both, any Chromium build sitting
 * beside it in the shared browser directory. Returning undefined lets
 * Playwright use its own default and report its own error, which is a
 * better failure than a path this file invented.
 */
function resolveChromePath(): string | undefined {
    const fromEnv = process.env.PLAYWRIGHT_CHROME_PATH
    if (fromEnv) {
        return fromEnv
    }
    const fromPackage = chromium.executablePath()
    if (existsSync(fromPackage)) {
        return fromPackage
    }
    // .../<browsers root>/chromium-<rev>/<platform>/chrome -- three levels
    // up, not two: the platform directory sits between the revision and the
    // binary.
    const browsersRoot = dirname(dirname(dirname(fromPackage)))
    if (!existsSync(browsersRoot)) {
        return undefined
    }
    for (const entry of readdirSync(browsersRoot)) {
        // `chromium_headless_shell-*` sorts adjacent to these and is not a
        // full browser, so match the prefix exactly.
        if (!entry.startsWith('chromium-')) {
            continue
        }
        for (const platform of [
            'chrome-linux',
            'chrome-linux-arm64',
            'chrome-mac',
            'chrome-win',
        ]) {
            const candidate = join(browsersRoot, entry, platform, 'chrome')
            if (existsSync(candidate)) {
                return candidate
            }
        }
    }
    return undefined
}

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
        // cannot fetch anything not already on disk -- which is why this
        // resolves an existing browser rather than expecting a matching one
        // to be fetchable. See `resolveChromePath` above.
        launchOptions: {
            executablePath: resolveChromePath(),
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
        // The two middle versions. Added when a multi-version pass found the
        // suite had only ever run on the ends of the supported range, so
        // anything that broke on 2.41 or 2.42 alone would have shipped
        // unnoticed -- and 2.41 is where DHIS2 changed both `mergeMode` and
        // whether a group's `lastUpdated` moves on a collection write, so it
        // is the least safe version to have been guessing about.
        //
        // These instances are created for a verification pass rather than
        // kept running, so a project whose instance is stopped fails at the
        // fixture's session gate rather than mid-flow. Run one project at a
        // time with `--project`, matching the one instance that is up; the
        // broker cannot afford four DHIS2 instances at once.
        {
            name: '2.41',
            use: {
                ...devices['Desktop Chrome'],
                baseURL: 'http://dhis2-agent-gsi-p8-41:8080',
            },
        },
        {
            name: '2.42',
            use: {
                ...devices['Desktop Chrome'],
                baseURL: 'http://dhis2-agent-gsi-p8-42:8080',
            },
        },
    ],
})
