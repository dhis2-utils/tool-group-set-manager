import type { Page } from '@playwright/test'
import { appRoot, APP_PATH, expect, test } from './fixtures/session'
import type { AppRoot } from './fixtures/session'

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
 * poisoned instance. That guarantee only holds if the change set the
 * revert needs actually exists before the test does anything else with the
 * page -- see `waitForWriteToSettle` below, which is what fix round 1 was
 * about.
 */

const AREA_SET_NAME = 'Area'
const SOUTHERN_AREA = 'Southern Area'
const NORTHERN_AREA = 'Northern Area'

// A single, distinct facility under chiefdom "Bagruwa" -- used only by the
// single-assign and revert flows.
const SINGLE_FACILITY = 'Sembehun CHC'

// Chiefdom "Badjia" (id YuQRtpLP10I) has exactly two children -- used by
// both the drill-down and bulk-move flows, reached through the Overview
// matrix so the dialog's population is exactly these two, not a
// text-search guess. Confirmed live: the Overview matrix's row for a
// chiefdom counts every org unit in its subtree, which includes the
// chiefdom itself alongside its children (Area's population is "every
// organisation unit", never restricted by level -- OverviewTab.tsx) -- so
// Badjia's own row totals three, not two: Badjia, Njandama MCHP and
// Ngelehun CHC. This is a real, pinned number, not a self-consistency
// check: it is only 3 because Area is the group set under test (fix
// round 1's M1 -- pointing the drill-down flow at a different group set,
// e.g. "Facility Type", produces a different total for the same row, so
// pinning this number is what ties the flow to Area specifically).
const BULK_CHIEFDOM = 'Badjia'
const BULK_POPULATION_COUNT = 3

async function goto(page: Page, hash: string): Promise<AppRoot> {
    await page.goto(`${APP_PATH}#${hash}`)
    return appRoot(page)
}

async function openGroupSet(page: Page, name: string): Promise<AppRoot> {
    const root = await goto(page, '/')
    // Exact match on the card's own name, not a substring: `hasText`
    // alone would also match "Area" against a card for a different set
    // whose name happens to contain it (fix round 1's m5).
    const card = root
        .locator('[role="button"]')
        .filter({ has: root.getByText(name, { exact: true }) })
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

/**
 * KNOWN DEFECT, not accommodated as if it were correct behaviour:
 * `ObjectsTable`'s own per-row assign (`handleConfirm` in
 * `src/components/ObjectsTable/ObjectsTable.tsx`) never calls `reload()`
 * after a successful write -- unlike `BulkFixDialog` and the revert
 * dialog, both of which refresh through `onApplied`. A user who confirms
 * an assign sees the segmented control snap back to its pre-click state
 * with no success message (the only in-page message is the *failure*
 * wording -- `engineHistoryMessage` fires only when something went
 * wrong), which reads as the write having failed. The natural response,
 * clicking again, writes the same assignment a second time and adds a
 * second row to the audit log History exists to keep honest. This is
 * real, reported separately for a fix of its own, and not this task's to
 * fix -- but this suite must not rely on the control ever showing
 * "selected" on this same page, so every assertion below reads the result
 * through History (or a fresh navigation) instead.
 *
 * What this suite *can* rely on, because it is driven by `ObjectsTable`'s
 * own local `writingRowIds` state rather than the stale engine snapshot,
 * is that the row's control goes disabled the instant `handleConfirm`
 * starts writing and is re-enabled only in a `finally`, once `write()`
 * itself has settled. `write()` awaits all four of its steps -- server,
 * engine, cache, then `saveChangeSet` -- in one sequential chain
 * (`useMembershipWrite.ts`), so it never resolves before the change set
 * exists. Waiting for disabled-then-enabled is therefore a wait on the
 * actual client-side completion of the write, not a fixed delay and not
 * "the UI settling" -- it is safe to navigate away the moment this
 * resolves.
 *
 * This is the fix for fix round 1's Critical: clicking "Assign" and
 * immediately calling `page.goto` (the previous version of this suite)
 * raced this exact completion. On 2.40.12 that `goto` happened to be a
 * same-document, hash-only navigation, so the in-flight write survived by
 * luck; on 2.43.1 the app is served from a URL that redirects once
 * (`/api/apps/.../index.html` -> `/apps/<key>`), so the page was never
 * "already there" and the same `goto` was a real top-level navigation --
 * confirmed live, it tore the document (and the write) down mid-flight,
 * leaving the membership on the server with no change set to revert it
 * through. Waiting here instead of racing removes the need to special-case
 * either instance.
 *
 * If this write is broken instead of merely slow (a bulk-fix-style
 * no-write regression), `write()` still resolves -- it never rejects, it
 * only reports failure via its own result -- so this wait still completes
 * quickly and the *next* assertion (the row appearing in History) is what
 * fails, fast and specifically, rather than this wait timing out and
 * masking the failure as "the instance is slow" (fix round 1's other
 * concern).
 */
async function waitForWriteToSettle(
    root: AppRoot,
    groupName: string
): Promise<void> {
    const button = root.getByRole('button', { name: groupName })
    await expect(button).toBeDisabled({ timeout: 5_000 })
    await expect(button).toBeEnabled({ timeout: 30_000 })
}

/** The newest row in History -- `listChangeSets` sorts newest first
 * (src/data/datastore.ts). */
function newestHistoryRow(root: AppRoot) {
    return root.locator('table tbody tr').first()
}

/** The current modal's own action row. History lists a "Revert" button on
 * every row, so an unscoped `getByRole('button', { name: 'Revert' })` while
 * a revert dialog is open is ambiguous (confirmed live: it resolves to every
 * row's button plus the dialog's own) -- scoping to the modal's own
 * `ModalActions` is what picks out only the dialog's button. Also needed
 * for "Close": an unscoped match also finds the modal's own top-right X
 * (aria-label "Close modal dialog", which contains the same substring). */
function modalActions(root: AppRoot) {
    return root.locator('[data-test="dhis2-uicore-modalactions"]')
}

/**
 * Navigates to History, reverts the newest change set, and confirms
 * success -- used by every writing flow's own cleanup, and exercised
 * directly by the dedicated revert flow below.
 *
 * `expectedText` ties the row this reverts to the change this test itself
 * just made (fix round 1's M2): reverting "whatever the newest row
 * happens to be" without checking is safe today only because every
 * caller already waited for its own write to land first, and nothing
 * enforces that stays true -- asserting the text here is what would catch
 * it if it ever stopped being true, or if this ran against a shared
 * instance with other activity.
 */
async function revertChangeSet(
    page: Page,
    expectedText: string | RegExp
): Promise<void> {
    const root = await goto(page, '/history')
    const row = newestHistoryRow(root)
    await expect(row).toContainText(expectedText, { timeout: 15_000 })
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
    await expect(revertButton).toBeEnabled({ timeout: 20_000 })
    await revertButton.click()
    // The write itself -- server, engine, cache, history -- completes
    // before this text ever appears (`RevertDialog`'s `write()` call is
    // awaited the same way `ObjectsTable`'s is), so nothing further needs
    // to wait for anything once this is visible.
    await expect(root.getByText('All changes applied to')).toBeVisible({
        timeout: 30_000,
    })
    await actions.getByRole('button', { name: 'Close' }).click()
}

/** "{n} membership change(s)", matching `History.tsx`'s own wording --
 * used to identify a change set by its row text when it has no note
 * (the bulk-fix dialog's note field is optional and left blank here). */
function membershipChangeText(count: number): string {
    return count === 1 ? '1 membership change' : `${count} membership changes`
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
            .filter({ has: root.getByText(AREA_SET_NAME, { exact: true }) })
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

        // The matrix's own column headers are the set's own group names --
        // "Northern Area" belongs to no other group set on this instance,
        // so this ties the whole flow to Area specifically. Necessary,
        // not just belt-and-braces: Facility Type happens to be compulsory
        // and a data dimension too, so its Badjia row also totals 3 --
        // pinning only the number (fix round 1's first attempt at M1) was
        // re-verified live to still pass against "Facility Type" with this
        // column-header check absent.
        await expect(
            root.getByRole('columnheader', { name: NORTHERN_AREA })
        ).toBeVisible()

        const chiefdomRow = root.getByRole('row', {
            name: new RegExp(`^${BULK_CHIEFDOM}\\b`),
        })
        await expect(chiefdomRow).toBeVisible({ timeout: 20_000 })
        // Pinned to a real, Area-specific number: not merely "whatever the
        // cell shows", which would agree with itself even against the
        // wrong group set or a consistently miscounting engine.
        const totalCell = chiefdomRow.getByRole('cell').last()
        await expect(totalCell).toHaveText(String(BULK_POPULATION_COUNT))

        await totalCell.click()
        await expect(
            root.getByText(new RegExp(`^${BULK_POPULATION_COUNT} objects?$`))
        ).toBeVisible({ timeout: 20_000 })
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

        // See waitForWriteToSettle's doc comment: this is what makes the
        // subsequent navigation to History safe rather than a race.
        await waitForWriteToSettle(root, SOUTHERN_AREA)

        await revertChangeSet(
            page,
            `Assigned ${SINGLE_FACILITY} to ${SOUTHERN_AREA}`
        )

        // Back on the same filtered view: the assignment is gone.
        root = await openGroupSet(page, AREA_SET_NAME)
        await openObjectsTab(root)
        await searchObjects(root, SINGLE_FACILITY)
        await expect(
            root.getByRole('button', { name: SOUTHERN_AREA })
        ).toHaveAttribute('data-state', 'none', { timeout: 20_000 })
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
        await expect(chiefdomRow).toBeVisible({ timeout: 20_000 })
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
        ).toBeVisible({ timeout: 20_000 })

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
        //
        // This is the weaker half of the brief's "assert the preview's
        // counts against the result panel's counts": the result panel
        // carries no counts at all on a clean write (`writeOutcomes.ts`
        // reports "All changes applied to {name}", with numbers appearing
        // only in the partial/failed wording), so that literal comparison
        // is not implementable against a successful write. The stronger,
        // implementable form -- confirmed by deliberately dropping one
        // object from the write and re-checking (see the report) -- is
        // the post-apply Objects-tab re-filter below, which catches a
        // write that silently applied to fewer objects than the preview
        // promised even though the result panel still reports success.
        const dialogContent = root.locator(
            '[data-test="dhis2-uicore-modalcontent"]'
        )
        await expect(
            dialogContent.getByText(`${BULK_POPULATION_COUNT} objects`)
        ).toBeVisible({ timeout: 20_000 })
        const previewLine = dialogContent
            .locator('li', { hasText: NORTHERN_AREA })
            .filter({ hasText: '+' })
        await expect(previewLine).toHaveText(
            new RegExp(`\\+${BULK_POPULATION_COUNT} / -0`)
        )

        await root.getByRole('button', { name: 'Apply…' }).click()
        // The result panel: on a clean write every touched group reports
        // full success, by name -- so the same group named in the preview
        // line above must be named here too, tying the two together. This
        // text appears only once `write()` (server, engine, cache,
        // history, in that order) has fully resolved, so nothing further
        // needs to wait before navigating away.
        await expect(
            root.getByText(`All changes applied to ${NORTHERN_AREA}`)
        ).toBeVisible({ timeout: 30_000 })
        await modalActions(root).getByRole('button', { name: 'Close' }).click()

        // The actual, post-apply population: filtering Objects to this
        // group now returns exactly the preview's count -- the concrete
        // number the dialog's own success message elides, and the check
        // that actually proves the preview and the applied write agree
        // (see the comment above the preview assertion). The tab's filter
        // is still "Status: Missing" from opening the bulk fix dialog
        // (GroupSetDetail carries `filter` across tabs), and these three
        // objects are no longer Missing now that they are assigned --
        // combined with the old status filter, "Group: Northern Area"
        // alone would show zero. Status is reset to "All" first so the
        // group filter is the only one still applied.
        await openObjectsTab(root)
        await chooseOption(root, 'Status', 'All')
        await chooseOption(root, 'Group', NORTHERN_AREA)
        await expect(
            root.getByText(`${BULK_POPULATION_COUNT} objects`)
        ).toBeVisible({ timeout: 20_000 })

        await revertChangeSet(
            page,
            new RegExp(
                `${AREA_SET_NAME}.*${membershipChangeText(BULK_POPULATION_COUNT)}`,
                's'
            )
        )

        // Reverted: the chiefdom's own subtree is missing again.
        root = await openGroupSet(page, AREA_SET_NAME)
        await openOverviewTab(root)
        await showChiefdomRows(root)
        const revertedRow = root.getByRole('row', {
            name: new RegExp(`^${BULK_CHIEFDOM}\\b`),
        })
        await expect(revertedRow).toBeVisible({ timeout: 20_000 })
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
        await waitForWriteToSettle(root, SOUTHERN_AREA)

        root = await goto(page, '/history')
        const row = newestHistoryRow(root)
        const expectedNote = `Assigned ${SINGLE_FACILITY} to ${SOUTHERN_AREA}`
        await expect(row).toContainText(expectedNote, { timeout: 15_000 })
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
            timeout: 30_000,
        })
        await actions.getByRole('button', { name: 'Close' }).click()

        root = await openGroupSet(page, AREA_SET_NAME)
        await openObjectsTab(root)
        await searchObjects(root, SINGLE_FACILITY)
        await expect(
            root.getByRole('button', { name: SOUTHERN_AREA })
        ).toHaveAttribute('data-state', 'none', { timeout: 20_000 })
    })
})
