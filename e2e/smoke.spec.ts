import { expect, test } from './fixtures/session'
import type { AppRoot } from './fixtures/session'

/**
 * Read-only flows that take every name they need from the page, so they
 * run against any database -- the EMIS instance (266k organisation units)
 * included, which `flows.spec.ts` cannot reach because it is pinned to the
 * Sierra Leone seed. Nothing here writes, so there is nothing to revert.
 *
 * Run with GSI_E2E_BASE_URL=http://dhis2-<name>:8080 pnpm test:e2e --project smoke
 */
test.skip(() => !process.env.GSI_E2E_BASE_URL, 'GSI_E2E_BASE_URL is not set')

const COUNT = /^[\d,]+ objects?$/

/** The dashboard's first-rendered card's name. Position only, never a
 * `Locator` handed back for a later click -- `Dashboard.tsx` re-sorts its
 * cards by issue count as each group set type's results arrive (spec 5.1),
 * so "first" is not stable across two separate actions. Callers that need
 * to click the card this named must look it up again by name (`cardByName`
 * below), not reuse a positional locator. */
async function firstOrgUnitCardName(root: AppRoot): Promise<string> {
    const card = root.locator('[role="button"]').first()
    await expect(card).toBeVisible({ timeout: 60_000 })
    const name = await card
        .locator('[data-test="group-set-card-name"]')
        .textContent()
    if (!name) {
        throw new Error('the first card has no name')
    }
    return name
}

/** The one card whose name is exactly `name` -- `:text-is`, not `hasText`,
 * because `hasText` is a substring match and would also pick a card whose
 * name contains this one's as a substring (e.g. a set named "Area" and
 * another named "Coastal Area"). */
function cardByName(root: AppRoot, name: string) {
    return root.locator('[role="button"]').filter({
        has: root.locator(
            `[data-test="group-set-card-name"]:text-is(${JSON.stringify(name)})`
        ),
    })
}

test.describe('smoke', () => {
    test('dashboard renders the filter bar and at least one card', async ({
        authedApp,
    }) => {
        const root = await authedApp.root()
        await expect(
            root
                .locator('[data-test="filter-bar"]')
                .getByText('Organisation unit', { exact: true })
        ).toBeVisible({ timeout: 60_000 })
        await firstOrgUnitCardName(root)
    })

    test('the freshness indicator shows an age and Refresh reloads', async ({
        authedApp,
    }) => {
        const root = await authedApp.root()
        const bar = root.locator('[data-test="filter-bar"]')
        await expect(bar.getByText(/^Metadata from /)).toBeVisible({
            timeout: 60_000,
        })
        const refresh = bar.getByRole('button', { name: 'Refresh' })
        await refresh.click()
        await expect(refresh).toBeDisabled({ timeout: 5_000 })
        await expect(refresh).toBeEnabled({ timeout: 120_000 })
        await expect(bar.getByText(/^Metadata from /)).toBeVisible()
    })

    test('a card opens to a matrix, and the objects tab counts and searches its own rows', async ({
        authedApp,
    }) => {
        const root = await authedApp.root()
        const name = await firstOrgUnitCardName(root)
        // Click by name, not position: Dashboard re-sorts its cards by
        // issue count as more group set types' results arrive, so the
        // card that was first when its name was read can already be a
        // different one by the time a click fires (confirmed live: reading
        // "Area" at position 0 and then clicking "position 0" again a
        // moment later opened "Facility Ownership" instead). Looking the
        // card up again by its exact name is what makes the read and the
        // click agree on which card, regardless of any re-sort in between.
        await cardByName(root, name).click()
        await expect(
            root.getByRole('heading', { name, exact: true })
        ).toBeVisible()
        await expect(
            root.getByRole('columnheader', { name: 'Total' })
        ).toBeVisible({ timeout: 60_000 })

        await root.getByText('Objects', { exact: true }).click()
        const count = root.locator('[data-test="objects-count"]')
        await expect(count).toHaveText(COUNT, { timeout: 60_000 })
        const before = await count.textContent()

        // Search for the first row's own name: seed-agnostic, and the
        // result must contain that row.
        const firstRowName = await root
            .locator('[data-test="objects-table-row"] span[title]')
            .first()
            .textContent()
        if (!firstRowName) {
            throw new Error('no rows rendered')
        }
        await root
            .locator('[data-test="dhis2-uiwidgets-inputfield"]')
            .filter({ hasText: 'Search' })
            .locator('input')
            .fill(firstRowName)
        await expect(count).not.toHaveText(before ?? '', { timeout: 10_000 })
        await expect(
            root.getByText(firstRowName, { exact: true }).first()
        ).toBeVisible()
    })

    test('settings reports the status of every GSI SQL view', async ({
        authedApp,
    }) => {
        await authedApp.page.goto(
            `${process.env.GSI_E2E_BASE_URL}/api/apps/group-set-integrity-tool/index.html#/settings`
        )
        const root = await authedApp.root()
        // `exact: true`: Settings.tsx also renders a NoticeBox heading
        // ("SQL views are not set up" / "SQL views are set up") whenever
        // the views aren't usable -- a substring match against "SQL views"
        // resolves both that heading and this section's own <h2>, a
        // strict-mode violation (confirmed live against an instance with
        // no GSI SQL views installed). Scoping to the exact text is what
        // `SCOPE_LABEL` in fixtures/session.ts does for the same kind of
        // collision.
        await expect(
            root.getByRole('heading', { name: 'SQL views', exact: true })
        ).toBeVisible({ timeout: 30_000 })
        for (const viewName of [
            'GSI org unit hierarchy',
            'GSI org unit names',
            'GSI org unit group memberships',
        ]) {
            await expect(
                root.getByText(viewName, { exact: true })
            ).toBeVisible()
        }
    })
})
