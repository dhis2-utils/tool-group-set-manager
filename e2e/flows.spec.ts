import { appRoot, APP_PATH, expect, test } from './fixtures/session'
import type { AppRoot } from './fixtures/session'
import type { Page } from '@playwright/test'

/**
 * Five flows against the Sierra Leone demo data both broker instances seed
 * identically (task-9-brief.md): dashboard, drill down, single assign,
 * bulk move, revert.
 *
 * The "Area" organisation unit group set (id uIuxlbV1vRT on both
 * instances) is used for every write. Its four groups (Northern/Southern/
 * Western/Eastern Area) are assigned only to the thirteen level-2
 * districts; every level-4 facility starts with no group in this set,
 * which is what makes facilities a safe, reversible population for this
 * suite to write to.
 *
 * Every test that writes ends by reverting that exact change through
 * History's own Revert button -- never by calling the API directly -- so a
 * broken revert would show up as a failing test, not as a quietly
 * poisoned instance.
 */

const AREA_SET_NAME = 'Area'
const SOUTHERN_AREA = 'Southern Area'
const NORTHERN_AREA = 'Northern Area'

// A single, distinct facility under chiefdom "Bagruwa" -- used only by the
// single-assign and revert flows.
const SINGLE_FACILITY = 'Sembehun CHC'

// Chiefdom "Badjia" (id YuQRtpLP10I) has exactly two children -- used only
// by the bulk-move flow, reached through the Overview matrix so the
// dialog's population is exactly these two, not a text-search guess.
// Confirmed live: the Overview matrix's row for a chiefdom counts every org
// unit in its subtree, which includes the chiefdom itself alongside its
// children (Area's population is "every organisation unit", never
// restricted by level -- OverviewTab.tsx) -- so Badjia's own row totals
// three, not two: Badjia, Njandama MCHP and Ngelehun CHC.
const BULK_CHIEFDOM = 'Badjia'
const BULK_POPULATION_COUNT = 3

async function goto(page: Page, hash: string): Promise<AppRoot> {
    await page.goto(`${APP_PATH}#${hash}`)
    return appRoot(page)
}

async function openGroupSet(page: Page, name: string): Promise<AppRoot> {
    const root = await goto(page, '/')
    const card = root.locator('[role="button"]').filter({ hasText: name })
    await expect(card.first()).toBeVisible({ timeout: 20_000 })
    await card.first().click()
    await expect(root.getByRole('heading', { name, exact: true })).toBeVisible()
    return root
}

async function openObjectsTab(root: AppRoot): Promise<void> {
    await root.getByText('Objects', { exact: true }).click()
    await expect(
        root.locator('[data-test="objects-table-scroll"]')
    ).toBeVisible()
}

async function openOverviewTab(root: AppRoot): Promise<void> {
    await root.getByText('Overview', { exact: true }).click()
    await expect(
        root.getByRole('columnheader', { name: 'Organisation unit' })
    ).toBeVisible()
}

/**
 * @dhis2/ui's `SingleSelectField`/`InputField` render a `<label>` that is
 * never wired to its control by `for`/`id` or `aria-labelledby` (confirmed
 * against the live app's own DOM -- the control is a plain
 * `[data-test="dhis2-uicore-select-input"]` div with no accessible name at
 * all), so `getByLabel` cannot find either. Scoping by the field's own
 * `data-test` wrapper and filtering on the label text it still contains is
 * what actually locates them.
 */
function singleSelectField(root: AppRoot, labelText: string) {
    return root
        .locator('[data-test="dhis2-uiwidgets-singleselectfield"]')
        .filter({ hasText: labelText })
}

function inputField(root: AppRoot, labelText: string) {
    return root
        .locator('[data-test="dhis2-uiwidgets-inputfield"]')
        .filter({ hasText: labelText })
        .locator('input')
}

/** Opens a `SingleSelectField` (by its own label) and picks one option (by
 * its exact, rendered `data-label`, which is always the option's whole
 * displayed text -- see SummaryMatrix/OverviewTab/BulkFixDialog, none of
 * which truncate or decorate it). */
async function chooseOption(
    root: AppRoot,
    fieldLabel: string,
    optionLabel: string
): Promise<void> {
    await singleSelectField(root, fieldLabel)
        .locator('[data-test="dhis2-uicore-select-input"]')
        .click()
    await root
        .locator(
            `[data-test="dhis2-uicore-singleselectoption"][data-label="${optionLabel}"]`
        )
        .click()
}

/** Switches the Overview matrix's row level to "Chiefdom (level 3)". */
async function showChiefdomRows(root: AppRoot): Promise<void> {
    await chooseOption(root, 'Rows', 'Chiefdom (level 3)')
}

/** Objects tab's own "Search" filter -- an engine-side predicate (spec
 * 5.2), so it reaches the whole population, not just loaded rows. */
async function searchObjects(root: AppRoot, text: string): Promise<void> {
    await inputField(root, 'Search').fill(text)
    // Debounced 300ms (ObjectsTab.tsx); the row count text is what actually
    // confirms the debounced query landed, not a fixed wait.
    await expect(root.getByText(/^1 object$/)).toBeVisible({ timeout: 5_000 })
}

/** The newest row in History -- `listChangeSets` sorts newest first
 * (src/data/datastore.ts), so this is always the change a test just made. */
function newestHistoryRow(root: AppRoot) {
    return root.locator('table tbody tr').first()
}

/** The current modal's own action row. History lists a "Revert" button on
 * every row, so an unscoped `getByRole('button', { name: 'Revert' })` while
 * a revert dialog is open is ambiguous (confirmed live: it resolves to every
 * row's button plus the dialog's own) -- scoping to the modal's own
 * `ModalActions` is what picks out only the dialog's button. */
function modalActions(root: AppRoot) {
    return root.locator('[data-test="dhis2-uicore-modalactions"]')
}

/**
 * History loads its list once per mount (`useChangeSets`'s effect has no
 * poll and nothing here re-triggers it), so re-checking an
 * already-rendered page never sees a change set that lands after that
 * mount -- unlike most of this suite's other waits, a bigger `expect(...)`
 * timeout would not help here at all. Nothing in the UI signals when a
 * write's `saveChangeSet` step (the last of the four `useMembershipWrite`
 * runs -- server, engine, cache, history) has actually landed, so this
 * polls by re-navigating to History from scratch until the expected row is
 * the newest one there.
 */
async function waitForNewestHistoryRow(
    page: Page,
    expectedText: string,
    timeoutMs = 120_000
): Promise<AppRoot> {
    const deadline = Date.now() + timeoutMs
    // The first visit is a real `page.goto` (establishes the canonical,
    // post-redirect URL -- see `goto`'s doc comment on 2.43.1's shell
    // redirect). Every re-check after that clicks the app's own nav
    // links (`SyncUrlWithGlobalShell.tsx`'s React Router `NavLink`s)
    // instead of calling `page.goto` again: `page.goto` always asks
    // Chromium for a real top-level navigation, and on 2.43.1 that means
    // replaying the whole `/api/apps/.../index.html` -> `/apps/<key>`
    // redirect (and reloading the shell and the iframe with it) on every
    // single poll -- confirmed live, at roughly 15-20s per cycle, which
    // is what made a several-minute wait still not see enough attempts.
    // Clicking the in-app link is an ordinary React Router transition:
    // no reload, and History's own effect still re-runs on the remount.
    let root = await goto(page, '/history')
    for (;;) {
        const row = newestHistoryRow(root)
        try {
            await expect(row).toContainText(expectedText, { timeout: 3_000 })
            return root
        } catch (e) {
            if (Date.now() > deadline) {
                throw e
            }
            await root
                .getByRole('link', { name: 'Dashboard', exact: true })
                .click()
            await root
                .getByRole('link', { name: 'History', exact: true })
                .click()
        }
    }
}

/** Opens History, reverts the newest change set, and confirms success --
 * used by every writing flow's own cleanup, and exercised directly by the
 * dedicated revert flow below. */
async function revertNewestChange(page: Page): Promise<void> {
    const root = await goto(page, '/history')
    const row = newestHistoryRow(root)
    await expect(row).toBeVisible({ timeout: 20_000 })
    await row.getByRole('button', { name: 'Revert' }).click()
    await expect(
        root.getByRole('heading', { name: 'Revert change' })
    ).toBeVisible()
    const actions = modalActions(root)
    // Preview loaded: the destructive Revert button in the dialog becomes
    // enabled only once `plan` has landed and `plan.affected > 0`.
    const revertButton = actions.getByRole('button', {
        name: 'Revert',
        exact: true,
    })
    await expect(revertButton).toBeEnabled({ timeout: 60_000 })
    await revertButton.click()
    await expect(root.getByText('All changes applied to')).toBeVisible({
        timeout: 20_000,
    })
    await actions.getByRole('button', { name: 'Close' }).click()
}

test.describe('Group Set Integrity Tool', () => {
    // Step 1 gate: the session fixture itself is proven here, independent of
    // any flow below. If this is the only test running green, that is a
    // silent-fixture failure, not a pass -- see fixtures/session.ts.
    test('dashboard renders group set cards for an authenticated session', async ({
        authedApp,
    }) => {
        const root = await authedApp.root()
        await expect(root.getByText('Scope:', { exact: false })).toBeVisible()
        const areaCard = root
            .locator('[role="button"]')
            .filter({ hasText: AREA_SET_NAME })
        await expect(areaCard.first()).toBeVisible()
        await expect(areaCard.first().getByText('Conflicts')).toBeVisible()
        await expect(areaCard.first().getByText('OK')).toBeVisible()
        // Never a login screen wearing the app's clothes: none of DHIS2's
        // own legacy login form fields are present.
        await expect(
            authedApp.page.locator('input[name="j_username"]')
        ).toHaveCount(0)
    })

    test('drill down: dashboard card -> overview matrix -> filtered objects', async ({
        authedApp,
    }) => {
        const { page } = authedApp
        const root = await openGroupSet(page, AREA_SET_NAME)
        await openOverviewTab(root)
        await showChiefdomRows(root)

        const chiefdomRow = root.getByRole('row', {
            name: new RegExp(`^${BULK_CHIEFDOM}\\b`),
        })
        await expect(chiefdomRow).toBeVisible({ timeout: 60_000 })
        const totalCell = chiefdomRow.getByRole('cell').last()
        const total = Number((await totalCell.innerText()).replace(/,/g, ''))
        expect(total).toBeGreaterThan(0)

        await totalCell.click()
        await expect(
            root.getByText(new RegExp(`^${total.toLocaleString()} objects?$`))
        ).toBeVisible({ timeout: 60_000 })
    })

    test('single assign: pick a group, confirm, then revert through History', async ({
        authedApp,
    }) => {
        const { page } = authedApp
        let root = await openGroupSet(page, AREA_SET_NAME)
        await openObjectsTab(root)
        await searchObjects(root, SINGLE_FACILITY)

        // Not assigned to any Area group yet -- every segmented option
        // starts in the "none" state.
        await expect(
            root.getByRole('button', { name: SOUTHERN_AREA })
        ).toHaveAttribute('data-state', 'none')

        await root.getByRole('button', { name: SOUTHERN_AREA }).click()
        await expect(
            root.getByRole('heading', { name: 'Confirm group change' })
        ).toBeVisible()
        await expect(
            root.getByText(
                `${SINGLE_FACILITY} will be assigned to ${SOUTHERN_AREA} and removed from any other group in this set`
            )
        ).toBeVisible()
        await root.getByRole('button', { name: 'Assign' }).click()

        // ObjectsTable's own per-row assign has no `reload()` call after a
        // successful write (unlike BulkFixDialog and the revert dialog,
        // both of which refresh through `onApplied`), so this same
        // in-session view does not reflect the change at all -- confirmed
        // live: the segmented control stays "none" here no matter how long
        // this page is polled. History is a separate read (the dataStore,
        // not the engine) and is what this assertion, and a real user
        // checking their work, actually relies on.
        root = await waitForNewestHistoryRow(
            page,
            `Assigned ${SINGLE_FACILITY} to ${SOUTHERN_AREA}`
        )

        await revertNewestChange(page)

        // Back on the same filtered view: the assignment is gone.
        root = await openGroupSet(page, AREA_SET_NAME)
        await openObjectsTab(root)
        await searchObjects(root, SINGLE_FACILITY)
        await expect(
            root.getByRole('button', { name: SOUTHERN_AREA })
        ).toHaveAttribute('data-state', 'none', { timeout: 60_000 })
    })

    test('bulk move: preview counts match the result panel, then revert', async ({
        authedApp,
    }) => {
        const { page } = authedApp
        let root = await openGroupSet(page, AREA_SET_NAME)
        await openOverviewTab(root)
        await showChiefdomRows(root)

        const chiefdomRow = root.getByRole('row', {
            name: new RegExp(`^${BULK_CHIEFDOM}\\b`),
        })
        await expect(chiefdomRow).toBeVisible({ timeout: 60_000 })
        // Area is a data dimension but not compulsory (spec 3.2's third
        // Missing row), so an unassigned facility is a Missing warning, not
        // an "unassigned, and that's fine" Ok -- there is no separate
        // unassigned column here (SummaryMatrix's `showUnassigned` is only
        // for a set that is neither compulsory nor a data dimension).
        // Column order is fixed (Org unit, one per group, Missing,
        // Conflict, Total), so the Missing cell is always third from the
        // end, however many groups this set has.
        const missingCell = chiefdomRow.getByRole('cell').nth(-3)
        await expect(missingCell).toHaveText(String(BULK_POPULATION_COUNT))
        await missingCell.click()

        await expect(
            root.getByText(`${BULK_POPULATION_COUNT} objects`)
        ).toBeVisible({ timeout: 60_000 })

        await root.getByRole('button', { name: 'Bulk fix…' }).click()
        await expect(
            root.getByRole('heading', { name: `Bulk fix ${AREA_SET_NAME}` })
        ).toBeVisible()
        await root.getByLabel('Assign all to one group').check()
        await chooseOption(root, 'Target group', NORTHERN_AREA)
        await root.getByRole('button', { name: 'Next' }).click()

        // Preview: the plan's headline count, and the group's own "+N / -M"
        // line, both derive from the same population -- assert both here so
        // a preview that silently disagreed with its own change list would
        // fail this test. Scoped to the dialog's own content: the Objects
        // tab underneath is still mounted behind this modal and shows the
        // identical "N objects" text in its own row count (confirmed live
        // -- an unscoped match is ambiguous).
        const dialogContent = root.locator(
            '[data-test="dhis2-uicore-modalcontent"]'
        )
        await expect(
            dialogContent.getByText(`${BULK_POPULATION_COUNT} objects`)
        ).toBeVisible({ timeout: 60_000 })
        const previewLine = dialogContent
            .locator('li', { hasText: NORTHERN_AREA })
            .filter({ hasText: '+' })
        await expect(previewLine).toHaveText(
            new RegExp(`\\+${BULK_POPULATION_COUNT} / -0`)
        )

        await root.getByRole('button', { name: 'Apply…' }).click()
        // The result panel: on a clean write every touched group reports
        // full success, by name -- so the same group named in the preview
        // line above must be named here too, tying the two together.
        await expect(
            root.getByText(`All changes applied to ${NORTHERN_AREA}`)
        ).toBeVisible({ timeout: 20_000 })
        // Scoped to the modal's own actions: an unscoped "Close" also
        // matches the modal's top-right X (aria-label "Close modal
        // dialog", which contains the same substring) -- confirmed live,
        // a strict-mode violation.
        await modalActions(root).getByRole('button', { name: 'Close' }).click()

        // The actual, post-apply population: filtering Objects to this
        // group now returns exactly the preview's count -- the concrete
        // number the dialog's own success message elides. The tab's
        // filter is still "Status: Missing" from opening the bulk fix
        // dialog (GroupSetDetail carries `filter` across tabs), and these
        // three objects are no longer Missing now that they are assigned
        // -- combined with the old status filter, "Group: Northern Area"
        // alone would show zero. Status is reset to "All" first so the
        // group filter is the only one still applied.
        await openObjectsTab(root)
        await chooseOption(root, 'Status', 'All')
        await chooseOption(root, 'Group', NORTHERN_AREA)
        await expect(
            root.getByText(`${BULK_POPULATION_COUNT} objects`)
        ).toBeVisible({ timeout: 60_000 })

        await revertNewestChange(page)

        // Reverted: the chiefdom's own subtree is missing again.
        root = await openGroupSet(page, AREA_SET_NAME)
        await openOverviewTab(root)
        await showChiefdomRows(root)
        const revertedRow = root.getByRole('row', {
            name: new RegExp(`^${BULK_CHIEFDOM}\\b`),
        })
        await expect(revertedRow).toBeVisible({ timeout: 60_000 })
        await expect(revertedRow.getByRole('cell').nth(-3)).toHaveText(
            String(BULK_POPULATION_COUNT)
        )
    })

    test('revert: History reverts a change and the object list reflects it', async ({
        authedApp,
    }) => {
        const { page } = authedApp
        // A fresh change of its own, so this test's assertions on the
        // revert dialog do not depend on another test's ordering.
        let root = await openGroupSet(page, AREA_SET_NAME)
        await openObjectsTab(root)
        await searchObjects(root, SINGLE_FACILITY)
        await root.getByRole('button', { name: SOUTHERN_AREA }).click()
        await root.getByRole('button', { name: 'Assign' }).click()

        // ObjectsTable's own per-row assign never calls `reload()`, so this
        // page does not reflect the write in place (see the single-assign
        // flow above) -- History is read separately and does, once the
        // write's own dataStore save has actually landed (see
        // waitForNewestHistoryRow's doc comment).
        root = await waitForNewestHistoryRow(
            page,
            `Assigned ${SINGLE_FACILITY} to ${SOUTHERN_AREA}`
        )
        const row = newestHistoryRow(root)
        await expect(row).toContainText('Assigned to a group')
        await expect(row).toContainText(AREA_SET_NAME)
        await row.getByRole('button', { name: 'Revert' }).click()

        await expect(
            root.getByRole('heading', { name: 'Revert change' })
        ).toBeVisible()
        // The revert preview names exactly the one object this test just
        // touched -- a break-the-app check (see the report) confirmed a
        // revert that silently touched zero objects fails this line. Scoped
        // to the modal's own content: the object's name also appears,
        // unscoped, in the History table row sitting underneath the modal
        // (confirmed live -- an unscoped match is ambiguous).
        const modalContent = root.locator(
            '[data-test="dhis2-uicore-modalcontent"]'
        )
        await expect(modalContent.getByText(SINGLE_FACILITY)).toBeVisible({
            timeout: 15_000,
        })
        const actions = modalActions(root)
        const revertButton = actions.getByRole('button', {
            name: 'Revert',
            exact: true,
        })
        await expect(revertButton).toBeEnabled({ timeout: 15_000 })
        await revertButton.click()
        await expect(root.getByText('All changes applied to')).toBeVisible({
            timeout: 20_000,
        })
        await actions.getByRole('button', { name: 'Close' }).click()

        root = await openGroupSet(page, AREA_SET_NAME)
        await openObjectsTab(root)
        await searchObjects(root, SINGLE_FACILITY)
        await expect(
            root.getByRole('button', { name: SOUTHERN_AREA })
        ).toHaveAttribute('data-state', 'none', { timeout: 60_000 })
    })
})
