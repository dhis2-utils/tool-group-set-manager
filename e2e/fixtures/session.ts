import { test as base, expect } from '@playwright/test'
import type { FrameLocator, Locator, Page } from '@playwright/test'

/**
 * The two live instances this suite runs against (task-9-brief.md). Neither
 * may be deleted or reset; every write this suite makes must be reverted
 * through the app's own History before the test ends.
 */
export const CREDENTIALS = { username: 'local_admin', password: 'district' }

/**
 * The app is installed on each instance as a built zip (`pnpm build`, then
 * `POST /api/apps`), never served from the dev server -- see the brief: the
 * dev server and its `--proxy` are two different origins, the broker
 * instances send no `access-control-*` headers, and 2.43 moved
 * `cors.allowed.origins` into `dhis.conf`, which the broker does not
 * expose. `/api/apps/<key>/index.html` is the one path that resolves on
 * both versions -- 2.43 redirects it to the canonical `/apps/<key>` URL
 * (confirmed against both live instances), 2.40 serves it directly, and
 * Playwright's `page.goto` follows the redirect either way.
 */
const APP_KEY = 'group-set-integrity-tool'
export const APP_PATH = `/api/apps/${APP_KEY}/index.html`

/**
 * Where the app's own DOM actually lives. Confirmed against both live
 * instances: 2.43.1 wraps every app in the Global App Shell, which loads
 * the app inside an `<iframe>` alongside the shell's own header/nav chrome
 * -- so `page.getByRole(...)` never sees anything the app itself rendered,
 * it only sees the shell. 2.40.12 has no such shell for this app and
 * serves the app's DOM directly on `page`. `appRoot` hides that difference
 * behind one locator-shaped object so every helper and flow below is
 * written once, against whichever root this instance actually uses.
 */
export type AppRoot = Pick<
    Page | FrameLocator,
    'getByRole' | 'getByText' | 'getByLabel' | 'locator'
>

export async function appRoot(page: Page): Promise<AppRoot> {
    // The shell (where there is one) is itself a client-rendered app: the
    // `<iframe>` is not in the DOM the instant `page.goto` resolves (that
    // only waits for the outer document's `load`), it is inserted a beat
    // later once the shell's own JS mounts. Polling briefly for it, rather
    // than checking once, is what keeps 2.40.12 (no shell, no iframe at
    // all) and 2.43.1 (shell mounts the iframe shortly after load) both
    // correctly detected instead of the 2.43.1 case racing this check and
    // silently falling back to `page` -- which never sees anything the app
    // itself renders (confirmed against the live instance: `page`'s own
    // text is only the shell's header chrome).
    const iframe = page.locator('iframe').first()
    try {
        await iframe.waitFor({ state: 'attached', timeout: 5_000 })
        return page.frameLocator('iframe')
    } catch {
        return page
    }
}

/**
 * A locator that only the authenticated app renders (never the login
 * screen, and never a blank shell) -- the dashboard's scope selector,
 * which reads "Scope: <org unit>". Used to gate the fixture itself: if the
 * session cookie did not take, this never appears and the fixture fails
 * loudly instead of handing every later test a page that looks like the
 * app but is actually a login form.
 */
export const SCOPE_LABEL = 'Scope:'

export interface AuthedApp {
    page: Page
    /** Re-resolves the app root fresh -- call again after any navigation
     * (the iframe, where there is one, is torn down and recreated by the
     * shell on some route changes). */
    root: () => Promise<AppRoot>
}

export const test = base.extend<{ authedApp: AuthedApp }>({
    authedApp: async ({ page, context, baseURL }, use) => {
        if (!baseURL) {
            throw new Error(
                'baseURL is required -- set it per project in playwright.config.ts'
            )
        }
        // Brief: "Get the session with Basic-auth GET /api/me and seed the
        // browser context with the resulting cookie." `context.request`
        // shares its cookie jar with `context` (and therefore with `page`),
        // so the session cookie DHIS2 sets on this response is already
        // available to the page once it navigates -- no manual Set-Cookie
        // parsing needed, and no dependency on the cookie's own name, which
        // differs per instance (`JSESSIONID_<context>`, confirmed against
        // both live instances).
        //
        // Deliberately NOT `POST /api/auth/login`: it does not exist on
        // 2.40 and redirects to the legacy login page, which a
        // redirect-following client captures as an anonymous cookie with
        // HTTP 200 and no error at all.
        const auth = Buffer.from(
            `${CREDENTIALS.username}:${CREDENTIALS.password}`
        ).toString('base64')
        const meResponse = await context.request.get(`${baseURL}/api/me`, {
            headers: { Authorization: `Basic ${auth}` },
        })
        if (!meResponse.ok()) {
            throw new Error(
                `Could not establish a session via GET /api/me against ${baseURL}: HTTP ${meResponse.status()}`
            )
        }

        await page.goto(`${baseURL}${APP_PATH}`)

        const root = () => appRoot(page)

        // The gate (task-9-brief.md step 1): assert on something only the
        // authenticated app renders, before any spec trusts this page. A
        // basic-auth failure that silently degraded to an anonymous
        // session would otherwise leave every later assertion looking at a
        // login screen while still reporting green.
        const scopeLabel: Locator = (await root()).getByText(SCOPE_LABEL, {
            exact: false,
        })
        await expect(scopeLabel).toBeVisible({ timeout: 30_000 })

        await use({ page, root })
    },
})

export { expect }
