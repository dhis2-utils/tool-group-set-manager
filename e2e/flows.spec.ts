import type { Page } from '@playwright/test'
import {
    appRoot,
    APP_PATH,
    expect,
    SCOPE_LABEL,
    test,
} from './fixtures/session'
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

/**
 * Task 8: a term whose one match sits well past `ObjectsTable`'s own page
 * size (`PAGE = 200` in ObjectsTable.tsx) in the unfiltered Area
 * population's load order -- confirmed live on both instances (see the
 * report) at load position 1315 of 1332, reached only once the table has
 * paged in seven more 200-row pages than the first. A component-level
 * filter over just the rows paged in so far would never find this object;
 * only a predicate over the engine's own whole population (spec 5.2) can --
 * which is the entire point of this flow, so this term is deliberately not
 * relaxed to something closer to the front of the list.
 */
const SEARCH_BEYOND_FIRST_PAGE_TERM = 'Mitchener'
const SEARCH_BEYOND_FIRST_PAGE_OBJECT =
    'UMC Mitchener Memorial Maternity & Health Centre'

/** Matches no organisation unit, group or group name on either instance. */
const SEARCH_NO_MATCH_TERM = 'zzz-no-such-object-in-this-instance-zzz'

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

/**
 * A `SingleSelectField` hosted in the shared `FilterBar` (Task 8's plan --
 * "Show the same filter bar on the group set page"). `FilterBarField`
 * (FilterBar.tsx) renders the label as a `<span>` *sibling* of the widget,
 * never passing it as the widget's own `label` prop -- confirmed live: the
 * "Rows" field's DOM is
 * `<div class="field"><span>Rows</span><div data-test="dhis2-uiwidgets-singleselectfield">…</div></div>`.
 * `singleSelectField` above only matches a widget that contains its own
 * label text, which this deliberately does not, so a FilterBar-hosted field
 * needs its own locator: find the exact label text, then the widget that is
 * its next sibling under their shared `.field` wrapper.
 */
function filterBarField(root: AppRoot, labelText: string) {
    return root
        .getByText(labelText, { exact: true })
        .locator('xpath=..')
        .locator('[data-test="dhis2-uiwidgets-singleselectfield"]')
}

async function chooseFilterBarOption(
    root: AppRoot,
    fieldLabel: string,
    optionLabel: string
): Promise<void> {
    await filterBarField(root, fieldLabel)
        .locator('[data-test="dhis2-uicore-select-input"]')
        .click()
    await root
        .locator(
            `[data-test="dhis2-uicore-singleselectoption"][data-label="${optionLabel}"]`
        )
        .click()
}

/**
 * Switches the Overview matrix's row level to "Chiefdom (level 3)". "Rows"
 * moved into the group set page's own `FilterBar` in this plan (it used to
 * live inside `OverviewTab` itself, where `SingleSelectField` was given the
 * label directly) -- see `chooseFilterBarOption`'s doc comment for why that
 * move broke the generic `chooseOption` helper for this one field.
 */
async function showChiefdomRows(root: AppRoot): Promise<void> {
    await chooseFilterBarOption(root, 'Rows', 'Chiefdom (level 3)')
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
        // The Organisation unit field (formerly "Scope:") -- see
        // fixtures/session.ts's SCOPE_LABEL doc comment for why `exact`
        // matters, and why this must be scoped to the filter bar rather
        // than searched for across the whole root (SummaryMatrix renders a
        // column header with the same text).
        await expect(
            root
                .locator('[data-test="filter-bar"]')
                .getByText(SCOPE_LABEL, { exact: true })
        ).toBeVisible()
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

    /**
     * Task 8: search as a feature in its own right, not merely a way to
     * locate a row inside another flow (every other use of `searchObjects`
     * above locates a row it already knows exists on-screen, which a
     * component-level filter over loaded rows would also pass). This test
     * asserts the three things those incidental uses never do -- see the
     * three steps below, and `SEARCH_BEYOND_FIRST_PAGE_TERM`'s own comment
     * for why the first is the one that actually distinguishes an
     * engine-level predicate from a component-level one.
     *
     * Read-only throughout: nothing here writes a membership change, so
     * there is nothing for this test to revert through History.
     */
    test('search: reaches an object beyond the first loaded page, clears back to the full count, and empties rather than staling on no match', async ({
        authedApp,
    }) => {
        const { page } = authedApp
        const root = await openGroupSet(page, AREA_SET_NAME)
        await openObjectsTab(root)

        // The unfiltered count, captured before any search narrows it --
        // this is what "clearing restores the unfiltered count" is
        // actually checked against, rather than a hardcoded population
        // number that would also have to be kept in sync with the seed.
        //
        // Scoped to `[data-test="objects-count"]` (ObjectsTable.tsx), not
        // a bare text match: GroupsPanel renders the same "{n} objects"
        // wording per group on the Overview tab, so an unscoped regex here
        // is only unique because the Overview tab happens to be unmounted
        // while the Objects tab is open. Scoping removes the trap rather
        // than relying on that.
        const countText = root.locator('[data-test="objects-count"]')
        await expect(countText).toHaveText(/^[\d,]+ objects?$/, {
            timeout: 20_000,
        })
        const unfilteredCount = await countText.textContent()

        // 1) A term matching an object beyond ObjectsTable's own first
        // loaded page (PAGE = 200) still finds it -- the property a
        // component-level filter over only the rows paged in so far could
        // never satisfy, since this object is never among them until far
        // more scrolling than this test does. `searchObjects` itself
        // already waits out the 300ms debounce (see its own doc comment);
        // the row text assertion below additionally confirms the one
        // result really is the object this term names, not merely that
        // the count happens to read 1.
        await searchObjects(root, SEARCH_BEYOND_FIRST_PAGE_TERM)
        await expect(
            root.getByText(SEARCH_BEYOND_FIRST_PAGE_OBJECT, { exact: true })
        ).toBeVisible()

        // 2) Clearing the term restores the unfiltered count -- the exact
        // text captured above, not just "some larger number".
        await inputField(root, 'Search').fill('')
        await expect(countText).toHaveText(unfilteredCount ?? '', {
            timeout: 5_000,
        })

        // 3) A term matching nothing shows the empty state -- zero rows and
        // "0 objects" -- rather than a stale list left over from the
        // previous, matching query.
        await inputField(root, 'Search').fill(SEARCH_NO_MATCH_TERM)
        await expect(root.getByText('0 objects', { exact: true })).toBeVisible(
            { timeout: 5_000 }
        )
        // Fix round 1 (Minor 1): `[class*="row"]` was a CSS-module
        // substring selector, the one locator in this file without a
        // `data-test` hook -- it breaks silently if that module class is
        // ever renamed. `ObjectsTable.tsx` now carries its own
        // `data-test="objects-table-row"` on the same element, matching
        // every other locator in this suite.
        await expect(
            root.locator('[data-test="objects-table-row"]')
        ).toHaveCount(0)
    })

    /**
     * Task 8: the header's "Run DHIS2 integrity checks" button (Task 7),
     * gated on the same maintenance authority the tab itself is gated on
     * (useIntegrity.tsx's REQUIRED_AUTHORITIES). `local_admin` carries `ALL`
     * on both broker instances, so this is expected to run rather than
     * skip in practice -- the skip exists for a session run under a
     * different, unprivileged user, per the brief.
     *
     * Never asserts on a check's name or code: `data/integrity.ts`
     * resolves checks by name at runtime precisely because neither is
     * stable across 2.40 to 2.43 (the same code, `OUVEGS`, names a
     * different check on the two versions). The result assertion below
     * matches `IntegrityLine`'s own wording for whichever check the app
     * itself resolved, confirmed live to read, e.g., "DHIS2 check Orgunits
     * that are not in all compulsory orgunit group sets found 272 objects
     * across all group sets on this instance as of ..." on 2.43.1 and the
     * same check under 2.40.12's own different display name.
     *
     * Read-only: the overlay only ever reads DHIS2's own integrity
     * results and asks it to recompute them (spec: "the app never writes
     * anything as a result of it"), so there is nothing here to revert
     * through History.
     */
    test('DHIS2 integrity: the header button opens the tab and a resolved check renders a result', async ({
        authedApp,
    }) => {
        const { page } = authedApp
        const root = await openGroupSet(page, AREA_SET_NAME)

        const headerButton = root.getByRole('button', {
            name: 'Run DHIS2 integrity checks',
        })
        // GroupSetDetail only renders this button once `useIntegrity`'s
        // authority probe (and its own check-resolution call) has come
        // back positive -- gate on it rather than asserting the button
        // outright, and skip with a reason instead of failing when this
        // session's user does not have the feature.
        //
        // Fix round 1 (Important): `isVisible({ timeout })` does NOT wait --
        // Playwright's own types mark that `timeout` deprecated and ignored
        // ("does not wait for the element to become visible and returns
        // immediately", confirmed in playwright-core@1.63.0's types.d.ts).
        // The previous version of this line was therefore a one-shot check
        // against whatever the DOM happened to be at that exact tick, which
        // races `useIntegrity`'s async `/me` authority call -- a loss of
        // that race silently skips this test's entire coverage with nothing
        // reporting that anything went wrong. `waitFor` actually waits;
        // `isVisible()` afterwards (untimed, so genuinely synchronous) reads
        // the settled result.
        await headerButton
            .waitFor({ state: 'visible', timeout: 15_000 })
            .catch(() => undefined)
        const available = await headerButton.isVisible()
        test.skip(
            !available,
            "DHIS2 integrity checks are not available for this session's user (no ALL/F_PERFORM_MAINTENANCE authority, or the server refused)"
        )

        await headerButton.click()
        await expect(
            root.getByRole('tab', { name: 'DHIS2 integrity' })
        ).toHaveAttribute('aria-selected', 'true')

        // At least one check the app itself resolved is titled here --
        // never a hardcoded name (IntegrityTab.tsx renders one heading per
        // relevant, resolved check).
        //
        // Scoped to `[data-test="integrity-check-title"]`
        // (IntegrityTab.tsx), not a generic level-3 heading: GroupsPanel's
        // "Groups in this set" is also an `<h3>`, on the Overview tab. An
        // unscoped `getByRole('heading', { level: 3 })` is only unique here
        // because the Overview tab is unmounted while this one is open;
        // scoping removes that trap.
        await expect(
            root.locator('[data-test="integrity-check-title"]').first()
        ).toBeVisible({ timeout: 20_000 })

        await root.getByRole('button', { name: 'Run now' }).click()

        // A rendered result for whichever check the app resolved --
        // IntegrityLine's own wording (resultLabel in IntegrityLine.tsx),
        // matched by pattern rather than by naming the check.
        await expect(
            root
                .getByText(
                    /found .* (object|objects) across all group sets on this instance as of/
                )
                .first()
        ).toBeVisible({ timeout: 35_000 })
    })
})
