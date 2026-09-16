import type { Page } from '@playwright/test'
import {
    appRoot,
    APP_PATH,
    CREDENTIALS,
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

/**
 * Task 8 (Plan 6): the organisation unit group set the usage flow drills
 * into, on the Sierra Leone seed both instances share. Not "Area" -- every
 * other flow in this file already writes to Area, and while this flow
 * itself never writes a membership change, picking a different set keeps
 * it independent of Area's own state. "Facility Type" is referenced by 37
 * visualizations on `agent-gsi-p2` (measured directly against the seed via
 * a throwaway SQL view, then deleted), so the Usage tab has a real,
 * non-zero count to render rather than only ever exercising the
 * zero-favourites branch of `UsageTab.tsx`.
 */
const USAGE_SET_NAME = 'Facility Type'

/** `USAGE_SQL_VIEW_CODE` in `src/data/sources/usageSqlView.ts`. */
const USAGE_SQL_VIEW_CODE = 'GSI_GROUPSET_USAGE'

/**
 * Fix round 2 (Minor folded in): the usage flow below writes (installs,
 * then removes) exactly one piece of shared, instance-wide metadata -- the
 * usage SQL view. Unlike the membership flows, which revert through the
 * app's own History, there is deliberately no `afterEach` net in this file
 * (`2026-09-plan5-carry-forward.md` records that as its own open design
 * question -- not something this fix reopens). Without something here, a
 * failure between install and remove -- an assertion timeout, a dropped
 * connection -- leaves the view standing, and every subsequent run's own
 * `expect(install).toBeVisible()` fails immediately because Settings shows
 * "Remove usage SQL view" instead. This calls the API directly (never
 * through the page) precisely because it has to work when the page itself
 * is the thing that failed.
 */
type ApiRequest = import('@playwright/test').APIRequestContext

/** Basic auth for the direct-to-API calls the cleanup net and the usage
 * teardown make -- both have to work when the page is the thing that
 * failed, so neither goes through the app. */
function apiHeaders(): Record<string, string> {
    const auth = Buffer.from(
        `${CREDENTIALS.username}:${CREDENTIALS.password}`
    ).toString('base64')
    return { Authorization: `Basic ${auth}` }
}

async function deleteUsageViewByCode(
    request: ApiRequest,
    baseURL: string
): Promise<void> {
    const headers = apiHeaders()
    const lookup = await request.get(
        `${baseURL}/api/sqlViews.json?filter=code:eq:${USAGE_SQL_VIEW_CODE}&fields=id`,
        { headers }
    )
    if (!lookup.ok()) {
        return
    }
    const body = (await lookup.json()) as { sqlViews: { id: string }[] }
    for (const view of body.sqlViews) {
        await request.delete(`${baseURL}/api/sqlViews/${view.id}`, {
            headers,
        })
    }
}

/**
 * The cleanup net (carried forward from Plan 5 §2, through Plans 6, 7 and 8).
 *
 * Every membership flow below reverts its own write as its last step, but a
 * flow that fails *between* the write and the revert leaves this shared
 * instance in exactly the state that fails the next run's precondition -- so
 * one failure becomes permanent. That has twice cost this project a full
 * investigation, and once produced a wrong diagnosis in a written note.
 *
 * The net does not journal what each test wrote: the case that matters is
 * precisely the one where the test died early and recorded nothing. It
 * snapshots `Area`'s membership once, and restores anything that diverges.
 *
 * Scope: `Area` only, because `Area` is the only set these flows write to.
 * A future flow that writes to a different set gets no protection from this
 * and must extend it. History is deliberately not cleaned -- `revertChangeSet`
 * always targets the newest row, so stale entries accumulate harmlessly, and
 * deleting the app's own audit trail wholesale is a bigger statement than
 * this problem warrants. The usage SQL view keeps its own `afterAll`.
 */
const AREA_SET_ID = 'uIuxlbV1vRT'

/**
 * Every legitimate member of an `Area` group is one of the thirteen level-2
 * districts. The flows here only ever wrongly add level-3/4 facilities, so
 * "member below level 2" is an exact characterisation of the damage they
 * cause -- and a seed-agnostic one, which a hardcoded list of district names
 * would not be.
 *
 * Deliberately narrow. `agent-gsi-p2-40` has `Kambia` in both "Western Area"
 * and "Eastern Area" -- a real conflict, and both entries are level 2, so the
 * net leaves them alone. That is the point: a level-2 org unit in two groups
 * is exactly the condition this tool exists to *detect*, not damage from a
 * half-finished test, and a net that tidied it away would be quietly
 * destroying the more interesting fixture. Only sub-level-2 members are
 * treated as leftovers.
 */
const AREA_MEMBER_LEVEL = 2

interface AreaGroupState {
    id: string
    name: string
    memberIds: string[]
}

async function readAreaGroups(
    request: ApiRequest,
    baseURL: string
): Promise<{ id: string; name: string; members: { id: string; level: number }[] }[]> {
    const response = await request.get(
        `${baseURL}/api/organisationUnitGroupSets/${AREA_SET_ID}` +
            `?fields=organisationUnitGroups[id,name,organisationUnits[id,level]]`,
        { headers: apiHeaders() }
    )
    if (!response.ok()) {
        throw new Error(
            `cleanup net: could not read the Area set -- HTTP ${response.status()}`
        )
    }
    const body = (await response.json()) as {
        organisationUnitGroups: {
            id: string
            name: string
            organisationUnits?: { id: string; level: number }[]
        }[]
    }
    return body.organisationUnitGroups.map((g) => ({
        id: g.id,
        name: g.name,
        members: g.organisationUnits ?? [],
    }))
}

/**
 * A JSON Patch `replace` of the group's whole members collection -- the same
 * shape `writes.ts` uses for a large change, and proven atomic on every
 * supported version (2026-09-plan9-json-patch-rejection.md): a refusal
 * changes nothing rather than partially applying, which is what makes it
 * safe to use for a restore.
 */
async function replaceAreaGroupMembers({
    request,
    baseURL,
    groupId,
    memberIds,
}: {
    request: ApiRequest
    baseURL: string
    groupId: string
    memberIds: string[]
}): Promise<void> {
    const response = await request.patch(
        `${baseURL}/api/organisationUnitGroups/${groupId}`,
        {
            headers: {
                ...apiHeaders(),
                'Content-Type': 'application/json-patch+json',
            },
            data: [
                {
                    op: 'replace',
                    path: '/organisationUnits',
                    value: memberIds.map((id) => ({ id })),
                },
            ],
        }
    )
    if (!response.ok()) {
        // Loud on purpose. A net that silently does not work is worse than
        // no net at all, because it invites trust it has not earned.
        throw new Error(
            `cleanup net: could not restore group ${groupId} -- HTTP ${response.status()}: ${(
                await response.text()
            ).slice(0, 300)}`
        )
    }
}

const sameIds = (a: string[], b: string[]) =>
    a.length === b.length && a.every((id, i) => id === b[i])

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
    /**
     * `Area`'s membership as this run found it, after repair -- what
     * `afterEach` restores to. Populated once per project by `beforeAll`;
     * the config runs one worker with `fullyParallel: false`, so there is
     * exactly one run of these hooks in flight at a time.
     */
    let areaBaseline: AreaGroupState[] = []

    test.beforeAll(async ({ request, baseURL }) => {
        if (!baseURL) {
            return
        }
        const groups = await readAreaGroups(request, baseURL)
        const repaired: AreaGroupState[] = []
        for (const group of groups) {
            const keep = group.members.filter(
                (m) => m.level === AREA_MEMBER_LEVEL
            )
            if (keep.length !== group.members.length) {
                // A previous run died between its write and its revert.
                // Repair rather than refuse to start -- refusing would
                // block the suite until someone cleaned up by hand, and
                // this damage is exactly what the net exists to absorb --
                // but never silently, or a real seed problem would hide
                // here indefinitely.
                const removed = group.members
                    .filter((m) => m.level !== AREA_MEMBER_LEVEL)
                    .map((m) => m.id)
                console.warn(
                    `cleanup net: "${group.name}" started dirty -- removing ${removed.length} member(s) below level ${AREA_MEMBER_LEVEL}: ${removed.join(', ')}`
                )
                await replaceAreaGroupMembers({
                    request,
                    baseURL,
                    groupId: group.id,
                    memberIds: keep.map((m) => m.id),
                })
            }
            repaired.push({
                id: group.id,
                name: group.name,
                memberIds: keep.map((m) => m.id).sort(),
            })
        }
        areaBaseline = repaired
    })

    test.afterEach(async ({ request, baseURL }) => {
        if (!baseURL || areaBaseline.length === 0) {
            return
        }
        const groups = await readAreaGroups(request, baseURL)
        for (const base of areaBaseline) {
            const current = groups.find((g) => g.id === base.id)
            if (!current) {
                continue
            }
            const currentIds = current.members.map((m) => m.id).sort()
            if (sameIds(currentIds, base.memberIds)) {
                continue
            }
            // Reached only when a flow failed before its own revert ran --
            // a passing flow leaves membership exactly as it found it, so
            // this is silent on a green run.
            console.warn(
                `cleanup net: restoring "${base.name}" -- found ${currentIds.length} member(s), expected ${base.memberIds.length}`
            )
            await replaceAreaGroupMembers({
                request,
                baseURL,
                groupId: base.id,
                memberIds: base.memberIds,
            })
        }
    })

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

    /**
     * Task 11: the metadata freshness indicator and its Refresh button
     * (spec 2026-09-16 section 4), rendered as the `FilterBar`'s own
     * `status` slot on a group set page (GroupSetDetail.tsx). The changed-
     * plan path -- a stale read caught by the bulk fix's own pre-write
     * check -- is deliberately not covered here (task-11-brief.md): forcing
     * a real cross-client change between a preview and its Apply would
     * need a second session writing mid-flow, and four unit tests already
     * pin that path (Task 9).
     */
    test('metadata freshness: the age is shown and Refresh reloads', async ({
        authedApp,
    }) => {
        const { page } = authedApp
        const root = await openGroupSet(page, AREA_SET_NAME)

        // A freshly opened app has just read, so this is the "just now" or
        // small-minutes wording -- matched loosely, since the exact number
        // depends on how long the load took.
        const freshness = root.locator('[data-test="filter-bar"]')
        await expect(freshness.getByText(/^Metadata from /)).toBeVisible({
            timeout: 20_000,
        })

        await root.getByRole('button', { name: 'Refresh' }).click()
        // The load runs again: the button is disabled while it does, and the
        // age line comes back afterwards. Asserting the disabled beat, not
        // only the re-enabled one, is what actually proves the click did
        // something -- without it, a Refresh wired to a no-op would pass
        // an enabled-then-visible pair trivially, since neither the button
        // nor the age text would ever have differed from their state
        // before the click (`MetadataFreshness.tsx`'s own `busy` state is
        // what this disables against).
        await expect(root.getByRole('button', { name: 'Refresh' })).toBeDisabled({
            timeout: 5_000,
        })
        await expect(root.getByRole('button', { name: 'Refresh' })).toBeEnabled({
            timeout: 30_000,
        })
        await expect(freshness.getByText(/^Metadata from /)).toBeVisible()
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

        // Spec 5.1 (Plan 7 Task 6): the page header's old "Fix issues…"
        // shortcut is gone, and the Objects tab's own button -- used further
        // down, against whatever that tab is filtered to -- is the one way
        // in. Asserted here, at the level where it is user-visible, because
        // deleting a button is easy to do while also breaking the path that
        // replaces it: the rest of this flow is what proves the replacement
        // still works, and this line is what proves the old one is not
        // quietly still there beside it.
        await expect(
            root.getByRole('button', { name: 'Fix issues…' })
        ).toHaveCount(0)

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

    /**
     * Task 8 (Plan 6): end-to-end coverage for the usage flow. Installing
     * the SQL view (Settings) is the only way to reach any surface Plan 6
     * added, so this flow installs it, reads a count through the Usage tab,
     * and removes it again -- the same write-then-revert shape the other
     * write flows in this file use, and for the same reason
     * (docs/superpowers/notes/2026-09-plan5-carry-forward.md §2: this suite
     * has no `afterEach` net, so the removal has to be the test's own last
     * step). Unlike the other write flows this one writes no membership
     * change and touches no group set the rest of the suite depends on --
     * the view it installs is instance-wide metadata, not data on any
     * particular object.
     *
     * Nested in its own `describe` purely to scope `afterAll`
     * (`deleteUsageViewByCode` above) to this one flow -- see that
     * function's doc comment for why it exists, and why it is not the
     * suite-wide `afterEach` the carry-forward note already treats as a
     * separate, open design question.
     */
    test.describe('usage', () => {
        test.afterAll(async ({ request, baseURL }) => {
            if (!baseURL) {
                return
            }
            await deleteUsageViewByCode(request, baseURL)
        })

        /**
         * `root` is re-resolved after every navigation that goes through
         * one of the app's own nav links (`SyncUrlWithGlobalShell`'s
         * "Dashboard" and "Settings", plus the dashboard card's own
         * client-side navigation into a group set page) -- never reused
         * across one -- because on 2.43.1 the app runs inside the Global
         * App Shell's `<iframe>`, which the shell can tear down and
         * recreate on a route change; a `root` handed out before that
         * happens can end up asserting against a detached frame.
         * `authedApp.root()` hides that behind one call, and costs nothing
         * extra on 2.40.12, which has no shell and no iframe to lose.
         */
        test('usage: install the SQL view, read a count on a group set, then remove it', async ({
            authedApp,
        }) => {
            let root = await authedApp.root()

            // `exact: true`: without it, a substring match on "Settings" also
            // resolves Dashboard.tsx's `fellBack` notice link ("Go to Settings to
            // check or repair the SQL views") and UsageTab.tsx's own "Go to
            // Settings to install it" -- neither renders in this flow's own run
            // (the general SQL views are fine, and the usage view is installed
            // before the Usage tab is ever opened here), but nothing prevents a
            // future run where one does, and `exact` removes the trap rather
            // than relying on that.
            await root
                .getByRole('link', { name: 'Settings', exact: true })
                .click()
            root = await authedApp.root()

            await expect(
                root.getByRole('heading', {
                    name: 'Group set usage',
                    exact: true,
                })
            ).toBeVisible()

            const install = root.getByRole('button', {
                name: 'Install usage SQL view',
            })
            await expect(install).toBeVisible({ timeout: 15_000 })
            await install.click()
            // Creates the SQL view, then executes it once to prove it is
            // readable (Settings.tsx's `handleInstallUsage` -> `usageAdmin.ts`'s
            // `installUsageView`) -- slower than a plain metadata write, hence
            // the generous timeout the other write flows in this file also use
            // for their own settle waits.
            await expect(root.getByText('Usage data is installed')).toBeVisible(
                {
                    timeout: 30_000,
                }
            )

            // `exact: true`: GroupSetDetail.tsx's own breadcrumb link is also
            // named exactly "Dashboard", but only on a group set page -- this
            // click happens from Settings, where the nav link is the only match,
            // so `exact` costs nothing here and avoids the trap on a future
            // reuse from a page that has both.
            await root
                .getByRole('link', { name: 'Dashboard', exact: true })
                .click()
            root = await authedApp.root()

            // Exact match on the card's own name, not a substring -- see
            // `openGroupSet`'s identical comment above: `hasText` alone would
            // also match a card whose name merely contains this one.
            const card = root
                .locator('[role="button"]')
                .filter({
                    has: root.getByText(USAGE_SET_NAME, { exact: true }),
                })
            await expect(card.first()).toBeVisible({ timeout: 20_000 })
            await card.first().click()
            root = await authedApp.root()
            await expect(
                root.getByRole('heading', { name: USAGE_SET_NAME, exact: true })
            ).toBeVisible()

            await root.getByRole('tab', { name: 'Usage', exact: true }).click()
            // The headline sentence: `references? ` (the `s` is dropped only in
            // the plural-count wording, "N favourites reference this group
            // set" -- `UsageTab.tsx`'s `headlineFavouritesLabel`) covers all
            // three of its complete strings (zero, one, many) without pinning
            // this flow to whichever one the seed happens to produce today.
            await expect(
                root.getByText(/references? this group set/)
            ).toBeVisible({ timeout: 15_000 })
            await expect(root.getByText(/in the last 12 months/)).toBeVisible()
            // Spec 3.6's caveat, rendered on every surface that shows a count.
            await expect(
                root.getByText(/leaves no favourite behind/)
            ).toBeVisible()

            await root
                .getByRole('link', { name: 'Settings', exact: true })
                .click()
            root = await authedApp.root()

            const remove = root.getByRole('button', {
                name: 'Remove usage SQL view',
            })
            await expect(remove).toBeVisible({ timeout: 15_000 })
            await remove.click()
            // `handleRemoveUsage` deletes the view then re-checks status
            // (`refreshUsage`) -- the install button reappearing is that
            // re-check landing on "missing" again, not merely the click having
            // registered. A fresh locator against the current `root`, not the
            // `install` above: that one was resolved against the root from
            // before the Dashboard round trip, which this suite's own rule
            // (see this test's doc comment) never trusts past a navigation.
            await expect(
                root.getByRole('button', { name: 'Install usage SQL view' })
            ).toBeVisible({ timeout: 30_000 })
        })
    })
})
