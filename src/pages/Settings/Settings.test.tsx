import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { Settings } from './Settings'
import { SqlViewActionError } from '@/data/sources/sqlViewSharing'
import {
    checkUsageView,
    installUsageView,
    removeUsageView,
} from '@/data/sources/usageAdmin'
import { actAndFlush } from '@/testing/actAndFlush'

jest.mock('@dhis2/app-runtime', () => ({
    useConfig: () => ({ baseUrl: 'http://localhost:8080', apiVersion: 41 }),
}))

// Only the sharing choice's user group list goes through the fetcher here;
// every other server call is in a mocked module.
jest.mock('@/data/fetcher', () => ({
    createFetcher: () => (path: string) =>
        Promise.resolve(
            new Response(
                JSON.stringify(
                    path.startsWith('userGroups')
                        ? {
                              userGroups: [
                                  { id: 'ug1', displayName: 'Data managers' },
                              ],
                          }
                        : {}
                ),
                { status: 200 }
            )
        ),
}))

// Settings depends on @/hooks/useUsage only for `useUsageRefresh` -- mocked
// at module level the same way GroupSetDetail.test.tsx mocks it, since the
// real hook needs a DataProvider/QueryClient this file's shallow render
// tree doesn't have.
const mockUsageRefresh = jest.fn()
jest.mock('@/hooks/useUsage', () => ({
    useUsageRefresh: () => mockUsageRefresh,
}))

const mockGroupSets = [
    {
        id: 'own',
        displayName: 'Ownership',
        objectType: 'organisationUnit' as const,
        compulsory: true,
        dataDimension: true,
        canWrite: true,
        groups: [
            { id: 'g1', displayName: 'Group one', canWrite: true },
            { id: 'g2', displayName: 'Group two', canWrite: true },
        ],
    },
]

const mockReload = jest.fn()
const mockClearCache = jest.fn(() => Promise.resolve(undefined))
const mockEngine = {
    groupSets: mockGroupSets,
    client: null as { call: jest.Mock } | null,
    reload: mockReload,
    clearCache: mockClearCache,
}
jest.mock('@/hooks/useEngine', () => ({
    useEngine: () => mockEngine,
}))

const mockSetCatchAllGroup = jest.fn(() => Promise.resolve(undefined))
const mockClearCatchAllGroup = jest.fn(() => Promise.resolve(undefined))
const mockSetIncludeTracker = jest.fn(() => Promise.resolve(undefined))
const mockGsiConfig: {
    config: {
        catchAllGroup: Record<string, string>
        includeTracker: boolean
    }
    isLoaded: boolean
    setCatchAllGroup: typeof mockSetCatchAllGroup
    clearCatchAllGroup: typeof mockClearCatchAllGroup
    setIncludeTracker: typeof mockSetIncludeTracker
} = {
    config: { catchAllGroup: {}, includeTracker: false },
    isLoaded: true,
    setCatchAllGroup: mockSetCatchAllGroup,
    clearCatchAllGroup: mockClearCatchAllGroup,
    setIncludeTracker: mockSetIncludeTracker,
}
jest.mock('@/hooks/useGsiConfig', () => ({
    useGsiConfig: () => mockGsiConfig,
}))

// Settings changes need ALL (or, for a catch-all group, write access to
// the set). Every test runs as a superuser unless it says otherwise.
const mockUserScope: { isLoading: boolean; authorities: Set<string> } = {
    isLoading: false,
    authorities: new Set(['ALL']),
}
jest.mock('@/hooks/useUserScope', () => ({
    useUserScope: () => mockUserScope,
}))

const mockCheckSqlViews = jest.fn()
const mockSqlViewAuthorities = jest.fn()
const mockCreateOrRepairSqlViews = jest.fn()
jest.mock('@/data/sources/sqlViewAdmin', () => ({
    checkSqlViews: (...args: unknown[]) => mockCheckSqlViews(...args),
    sqlViewAuthorities: (...args: unknown[]) => mockSqlViewAuthorities(...args),
    createOrRepairSqlViews: (...args: unknown[]) =>
        mockCreateOrRepairSqlViews(...args),
}))

const mockLoadSharing = jest.fn()
const mockSaveSharing = jest.fn()
jest.mock('@/data/sources/sqlViewSharing', () => ({
    ...jest.requireActual('@/data/sources/sqlViewSharing'),
    loadSqlViewSharing: (...args: unknown[]) => mockLoadSharing(...args),
    saveSqlViewSharing: (...args: unknown[]) => mockSaveSharing(...args),
}))

jest.mock('@/data/sources/usageAdmin', () => ({
    checkUsageView: jest.fn(),
    installUsageView: jest.fn(),
    removeUsageView: jest.fn(),
}))

const mockCheckUsage = checkUsageView as jest.MockedFunction<
    typeof checkUsageView
>
const mockInstallUsage = installUsageView as jest.MockedFunction<
    typeof installUsageView
>
const mockRemoveUsage = removeUsageView as jest.MockedFunction<
    typeof removeUsageView
>

const usableCheck = (code: string, name: string) => ({
    code,
    name,
    id: `id-${code}`,
    type: 'VIEW',
    status: 'usable',
    usable: true,
    view: null,
})
const missingCheck = (code: string, name: string) => ({
    code,
    name,
    id: null,
    type: undefined,
    status: 'missing',
    usable: false,
    view: null,
})

/** A usage check as `checkUsageView` returns it. */
const usageCheck = (
    id: string | null,
    status: 'missing' | 'needsRepair' | 'usable'
) => ({
    id,
    status,
    usable: status === 'usable',
    view: id
        ? {
              id,
              code: 'GSI_GROUPSET_USAGE',
              type: 'VIEW',
              access: { data: { read: true } },
          }
        : null,
})

const ALL_USABLE = [
    usableCheck('GSI_ORGUNITS', 'GSI org unit hierarchy'),
    usableCheck('GSI_ORGUNIT_NAMES', 'GSI org unit names'),
    usableCheck('GSI_ORGUNIT_MEMBERSHIPS', 'GSI org unit group memberships'),
]
const ALL_MISSING = [
    missingCheck('GSI_ORGUNITS', 'GSI org unit hierarchy'),
    missingCheck('GSI_ORGUNIT_NAMES', 'GSI org unit names'),
    missingCheck('GSI_ORGUNIT_MEMBERSHIPS', 'GSI org unit group memberships'),
]

beforeEach(() => {
    mockReload.mockClear()
    mockSetCatchAllGroup.mockClear()
    mockSetIncludeTracker.mockClear()
    mockClearCache.mockClear()
    mockCheckSqlViews.mockReset()
    // A default so a test that only cares about the usage section (and
    // never sets this itself) does not leave `checks` as a bare `undefined`
    // -- `allUsable`/`anyUnusable` distinguish "not yet known" (null) from
    // "checked, nothing there" ([]), and `undefined` satisfies neither.
    mockCheckSqlViews.mockResolvedValue([])
    mockSqlViewAuthorities.mockReset()
    mockLoadSharing.mockReset()
    mockLoadSharing.mockResolvedValue({ kind: 'public' })
    mockSaveSharing.mockReset()
    mockSaveSharing.mockResolvedValue(undefined)
    mockCreateOrRepairSqlViews.mockReset()
    // Cleared (not just re-configured in each usage test's own beforeEach)
    // so call-count assertions like `toHaveBeenCalledTimes` aren't polluted
    // by every other test in the file also rendering the usage section.
    mockCheckUsage.mockReset()
    mockInstallUsage.mockReset()
    mockRemoveUsage.mockReset()
    mockUsageRefresh.mockReset()
    mockSetCatchAllGroup.mockClear()
    mockClearCatchAllGroup.mockClear()
    mockGsiConfig.config = {
        catchAllGroup: {},
        includeTracker: false,
    }
    mockUserScope.isLoading = false
    mockUserScope.authorities = new Set(['ALL'])
    mockEngine.groupSets = mockGroupSets
})

/**
 * `canManage` drives `sqlViewAuthorities` -- the same authority governs
 * creating the three GSI_* views and creating the usage view, so one flag
 * covers both sections' create/repair buttons, and (unless `canRemove`
 * says otherwise) removing the usage view.
 */
const renderSettings = ({
    canManage,
    canRemove = canManage,
}: {
    canManage: boolean | null
    canRemove?: boolean | null
}) => {
    mockSqlViewAuthorities.mockResolvedValue(
        canManage === null
            ? null
            : { create: canManage, remove: canRemove === true }
    )
    return render(<Settings />)
}

describe('SQL view status', () => {
    it('shows each view and whether it is usable', async () => {
        mockCheckSqlViews.mockResolvedValue(ALL_USABLE)
        renderSettings({ canManage: true })
        await waitFor(() =>
            expect(
                screen.getByText('GSI org unit hierarchy')
            ).toBeInTheDocument()
        )
        expect(screen.getByText('GSI org unit names')).toBeInTheDocument()
        expect(
            screen.getByText('GSI org unit group memberships')
        ).toBeInTheDocument()
        // All three usable: no create/repair button offered.
        expect(
            screen.queryByRole('button', { name: /create/i })
        ).not.toBeInTheDocument()
    })

    it('offers to create the missing views when the user has the authority, reports what was created, and reloads onto the new source (I2)', async () => {
        mockCheckSqlViews.mockResolvedValue(ALL_MISSING)
        mockCreateOrRepairSqlViews.mockResolvedValue({
            created: [
                'GSI_ORGUNITS',
                'GSI_ORGUNIT_NAMES',
                'GSI_ORGUNIT_MEMBERSHIPS',
            ],
            repaired: [],
            failed: [],
        })
        renderSettings({ canManage: true })
        const button = await screen.findByRole('button', {
            name: /create sql views/i,
        })
        mockCheckSqlViews.mockResolvedValue(ALL_USABLE)
        await actAndFlush(() => {
            fireEvent.click(button)
        })
        expect(mockCreateOrRepairSqlViews).toHaveBeenCalledWith(
            expect.anything(),
            ALL_MISSING,
            { kind: 'public' }
        )
        await waitFor(() =>
            expect(screen.getByText(/created 3 sql views/i)).toBeInTheDocument()
        )
        // I2: without this, the app would stay on the metadata API until a
        // manual reload -- on the instance that motivates this feature, the
        // button would appear to do nothing.
        expect(mockReload).toHaveBeenCalledWith(true)
    })

    it('reports which view failed and why, not just a count (M2)', async () => {
        mockCheckSqlViews.mockResolvedValue(ALL_MISSING)
        mockCreateOrRepairSqlViews.mockResolvedValue({
            created: ['GSI_ORGUNITS', 'GSI_ORGUNIT_NAMES'],
            repaired: [],
            failed: [
                {
                    code: 'GSI_ORGUNIT_MEMBERSHIPS',
                    message: 'HTTP 500 executing view',
                },
            ],
        })
        renderSettings({ canManage: true })
        const button = await screen.findByRole('button', {
            name: /create sql views/i,
        })
        await actAndFlush(() => {
            fireEvent.click(button)
        })
        expect(screen.getByText(/GSI_ORGUNIT_MEMBERSHIPS/)).toBeInTheDocument()
        expect(screen.getByText(/HTTP 500 executing view/)).toBeInTheDocument()
        // A partial failure is not a reason to reload if nothing was
        // created or repaired -- but here two of three were, so it should.
        expect(mockReload).toHaveBeenCalledWith(true)
    })

    // Regression: the hook extraction (25798e0) folded handleCreate's body
    // into sqlViews.run and dropped the setCreateSummary(null) /
    // setCreateFailures([]) that used to run before the try block, so a
    // previous run's green summary survived next to a later run's failure.
    it('clears a previous run’s success summary when a later create fails, rather than showing both', async () => {
        mockCheckSqlViews.mockResolvedValue(ALL_MISSING)
        mockCreateOrRepairSqlViews.mockResolvedValueOnce({
            created: [
                'GSI_ORGUNITS',
                'GSI_ORGUNIT_NAMES',
                'GSI_ORGUNIT_MEMBERSHIPS',
            ],
            repaired: [],
            failed: [],
        })
        renderSettings({ canManage: true })
        const button = await screen.findByRole('button', {
            name: /create sql views/i,
        })
        await actAndFlush(() => {
            fireEvent.click(button)
        })
        await waitFor(() =>
            expect(screen.getByText(/created 3 sql views/i)).toBeInTheDocument()
        )

        // The re-create button is still offered (the views the mocked
        // check reports are still missing), and this run fails outright.
        mockCreateOrRepairSqlViews.mockRejectedValueOnce(new Error('HTTP 500'))
        const buttonAgain = await screen.findByRole('button', {
            name: /create sql views/i,
        })
        await actAndFlush(() => {
            fireEvent.click(buttonAgain)
        })

        await waitFor(() =>
            expect(
                screen.getByText(/sql view update failed/i)
            ).toBeInTheDocument()
        )
        expect(screen.getByText('HTTP 500')).toBeInTheDocument()
        // The stale success report from the first run must be gone, not
        // sitting next to the failure claiming views were created.
        expect(
            screen.queryByText(/created 3 sql views/i)
        ).not.toBeInTheDocument()
        expect(
            screen.queryByText(/sql view update complete/i)
        ).not.toBeInTheDocument()
    })

    it('does not reload when nothing was created or repaired', async () => {
        mockCheckSqlViews.mockResolvedValue(ALL_MISSING)
        mockCreateOrRepairSqlViews.mockResolvedValue({
            created: [],
            repaired: [],
            failed: [
                { code: 'GSI_ORGUNITS', message: 'boom' },
                { code: 'GSI_ORGUNIT_NAMES', message: 'boom' },
                { code: 'GSI_ORGUNIT_MEMBERSHIPS', message: 'boom' },
            ],
        })
        renderSettings({ canManage: true })
        const button = await screen.findByRole('button', {
            name: /create sql views/i,
        })
        await actAndFlush(() => {
            fireEvent.click(button)
        })
        expect(mockReload).not.toHaveBeenCalled()
    })

    it('shows the status and an explanation, never a create button, for a user without the authority', async () => {
        mockCheckSqlViews.mockResolvedValue(ALL_MISSING)
        renderSettings({ canManage: false })
        await waitFor(() =>
            expect(
                screen.getByText('GSI org unit hierarchy')
            ).toBeInTheDocument()
        )
        expect(
            screen.queryByRole('button', { name: /create sql views/i })
        ).not.toBeInTheDocument()
        expect(
            screen.getByText(/do not have the required authority/i)
        ).toBeInTheDocument()
    })

    // M1
    it('shows an explanation, never a create button, when it could not determine authority', async () => {
        mockCheckSqlViews.mockResolvedValue(ALL_MISSING)
        renderSettings({ canManage: null })
        await waitFor(() =>
            expect(
                screen.getByText('GSI org unit hierarchy')
            ).toBeInTheDocument()
        )
        expect(
            screen.queryByRole('button', { name: /create sql views/i })
        ).not.toBeInTheDocument()
        expect(
            screen.getByText(/could not determine whether you can create/i)
        ).toBeInTheDocument()
    })

    // I1
    it('shows an explicit error and a retry option, never an endless spinner, when the status check itself fails', async () => {
        mockCheckSqlViews.mockRejectedValue(new Error('HTTP 500'))
        renderSettings({ canManage: true })
        await waitFor(() =>
            expect(
                screen.getByText(/could not check sql view status/i)
            ).toBeInTheDocument()
        )
        expect(screen.getByText('HTTP 500')).toBeInTheDocument()
        expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()

        // Retrying re-runs the same, safe (read-only) status check.
        mockCheckSqlViews.mockResolvedValue(ALL_USABLE)
        await actAndFlush(() => {
            fireEvent.click(screen.getByRole('button', { name: /try again/i }))
        })
        await waitFor(() =>
            expect(
                screen.getByText('GSI org unit hierarchy')
            ).toBeInTheDocument()
        )
    })
})

describe('required levels', () => {
    // Spec 2026-09-15 §2.2: the setting is gone, not hidden. A user who had
    // it configured must not find a control that silently does nothing.
    it('has no required organisation unit levels control', async () => {
        mockCheckSqlViews.mockResolvedValue(ALL_USABLE)
        renderSettings({ canManage: true })
        await waitFor(() =>
            expect(
                screen.getByText('GSI org unit hierarchy')
            ).toBeInTheDocument()
        )
        expect(
            screen.queryByText('Required organisation unit levels')
        ).not.toBeInTheDocument()
    })
})

describe('catch-all mapping', () => {
    it('can be set to any group of the set', async () => {
        mockCheckSqlViews.mockResolvedValue(ALL_USABLE)
        renderSettings({ canManage: true })
        const placeholder = await screen.findByText('Choose catch-all group')
        await actAndFlush(() => {
            fireEvent.click(placeholder)
        })
        const option = await screen.findByText('Group two')
        await actAndFlush(() => {
            fireEvent.click(option)
        })
        await waitFor(() =>
            expect(mockSetCatchAllGroup).toHaveBeenCalledWith('own', 'g2')
        )
    })

    // I3
    it('reports a save failure rather than discarding it silently', async () => {
        mockCheckSqlViews.mockResolvedValue(ALL_USABLE)
        mockSetCatchAllGroup.mockRejectedValueOnce(new Error('HTTP 403'))
        renderSettings({ canManage: true })
        const placeholder = await screen.findByText('Choose catch-all group')
        await actAndFlush(() => {
            fireEvent.click(placeholder)
        })
        const option = await screen.findByText('Group two')
        await actAndFlush(() => {
            fireEvent.click(option)
        })
        await waitFor(() =>
            expect(
                screen.getByText(/could not save the catch-all group/i)
            ).toBeInTheDocument()
        )
    })
})

describe('tracker toggle', () => {
    // I3
    it('reports a save failure rather than discarding it silently', async () => {
        mockCheckSqlViews.mockResolvedValue(ALL_USABLE)
        mockSetIncludeTracker.mockRejectedValueOnce(new Error('HTTP 403'))
        renderSettings({ canManage: true })
        const checkbox = await screen.findByLabelText(
            /include tracker data elements/i
        )
        await actAndFlush(() => {
            fireEvent.click(checkbox)
        })
        await waitFor(() =>
            expect(
                screen.getByText(/could not save the tracker data setting/i)
            ).toBeInTheDocument()
        )
    })
})

describe('clear cache', () => {
    it('clears the cache and reloads', async () => {
        mockCheckSqlViews.mockResolvedValue(ALL_USABLE)
        renderSettings({ canManage: true })
        const button = await screen.findByRole('button', {
            name: /clear cache/i,
        })
        await actAndFlush(() => {
            fireEvent.click(button)
        })
        expect(mockClearCache).toHaveBeenCalledTimes(1)
        expect(mockReload).toHaveBeenCalledWith(true)
    })
})

describe('Settings — group set usage', () => {
    beforeEach(() => {
        mockCheckUsage.mockResolvedValue(usageCheck(null, 'missing'))
        mockInstallUsage.mockResolvedValue({
            installed: true,
            variant: 'eventvisualization',
            failures: [],
        })
        mockRemoveUsage.mockResolvedValue(undefined)
    })

    it('offers to install the view when it is missing and the user may create SQL views', async () => {
        renderSettings({ canManage: true })
        expect(
            await screen.findByRole('button', {
                name: 'Install usage SQL view',
            })
        ).toBeInTheDocument()
    })

    // Fix round 2 (Important 3): before this fix, a user without the
    // authority saw "Missing", no button and no explanation -- exactly
    // after UsageTab.tsx tells them to "Go to Settings to install it". A
    // loop with no exit. The sibling SQL views section already explains
    // this case (and the `null` case below); this section must too.
    it('does not offer the button to a user who cannot create SQL views, and explains why', async () => {
        renderSettings({ canManage: false })
        expect(
            await screen.findByText(/do not have the required authority/i)
        ).toBeInTheDocument()
        expect(
            screen.queryByRole('button', { name: 'Install usage SQL view' })
        ).not.toBeInTheDocument()
    })

    it('explains that authority could not be determined when canManage is null', async () => {
        renderSettings({ canManage: null })
        expect(
            await screen.findByText(
                /could not determine whether you can create/i
            )
        ).toBeInTheDocument()
        expect(
            screen.queryByRole('button', { name: 'Install usage SQL view' })
        ).not.toBeInTheDocument()
    })

    it('says which query variant took', async () => {
        renderSettings({ canManage: true })
        fireEvent.click(
            await screen.findByRole('button', {
                name: 'Install usage SQL view',
            })
        )
        expect(
            await screen.findByText(
                'Installed using the eventvisualization query variant'
            )
        ).toBeInTheDocument()
    })

    // A successful install changes what every other reader of `useUsage()`
    // (Dashboard, GroupSetCard, UsageTab) sees, but each of those mounts its
    // own instance of the hook, subject to the lookup query's own
    // `staleTime: Infinity` -- so nothing tells them the view they thought
    // was absent now exists until this call refetches the shared cache
    // entry. Was a real gap: `useUsage()` has always exposed `refresh`, but
    // nothing called it until this fix.
    it('tells the shared usage cache to refresh after a successful install', async () => {
        renderSettings({ canManage: true })
        fireEvent.click(
            await screen.findByRole('button', {
                name: 'Install usage SQL view',
            })
        )
        await waitFor(() => expect(mockUsageRefresh).toHaveBeenCalled())
    })

    it('names every candidate that failed when none could be installed', async () => {
        mockInstallUsage.mockResolvedValue({
            installed: false,
            variant: null,
            failures: [
                {
                    variant: 'eventvisualization',
                    reason: 'other',
                    message: 'HTTP 409',
                },
            ],
        })
        renderSettings({ canManage: true })
        fireEvent.click(
            await screen.findByRole('button', {
                name: 'Install usage SQL view',
            })
        )
        expect(
            await screen.findByText(
                'The eventvisualization query variant could not be installed — HTTP 409'
            )
        ).toBeInTheDocument()
        // Nothing changed on the server, so nothing tells other readers to
        // refetch -- see the success-path test above for what this guards.
        expect(mockUsageRefresh).not.toHaveBeenCalled()
    })

    it('offers removal once the view is usable, and removes it', async () => {
        mockCheckUsage.mockResolvedValue(usageCheck('v1', 'usable'))
        renderSettings({ canManage: true })
        fireEvent.click(
            await screen.findByRole('button', { name: 'Remove usage SQL view' })
        )
        await waitFor(() =>
            expect(mockRemoveUsage).toHaveBeenCalledWith(
                expect.anything(),
                'v1'
            )
        )
        // Same reasoning as the install-success test above, in the other
        // direction: other readers must stop reporting the view as usable.
        await waitFor(() => expect(mockUsageRefresh).toHaveBeenCalled())
    })

    // Review fix 1 (Important): `usageCheck` starts `null`, so before the
    // status check resolves neither `usable` nor `id` is truthy -- without a
    // distinct "still checking" state the tag would assert "Missing" before
    // anything had looked.
    it('shows neither Missing nor Usable while the check is still pending, and Missing once it resolves', async () => {
        let resolveCheck: (value: ReturnType<typeof usageCheck>) => void = () =>
            undefined
        mockCheckUsage.mockReturnValue(
            new Promise((resolve) => {
                resolveCheck = resolve
            })
        )
        renderSettings({ canManage: true })
        expect(await screen.findByText('Group set usage')).toBeInTheDocument()
        expect(screen.queryByText('Missing')).not.toBeInTheDocument()
        expect(screen.queryByText('Usable')).not.toBeInTheDocument()

        resolveCheck(usageCheck(null, 'missing'))
        expect(await screen.findByText('Missing')).toBeInTheDocument()
    })

    // Review fix 2 (Important): an install/remove failure must not gate the
    // whole section -- a 403 on remove (or a view someone else deleted
    // mid-session) would otherwise wipe the tag and both buttons with no way
    // back except reloading the page.
    it('leaves the remove button and the view row on screen when removal fails, reporting the error alongside them', async () => {
        mockCheckUsage.mockResolvedValue(usageCheck('v1', 'usable'))
        mockRemoveUsage.mockRejectedValue(new Error('HTTP 403'))
        renderSettings({ canManage: true })
        const button = await screen.findByRole('button', {
            name: 'Remove usage SQL view',
        })
        fireEvent.click(button)
        expect(await screen.findByText('HTTP 403')).toBeInTheDocument()
        expect(
            screen.getByRole('button', { name: 'Remove usage SQL view' })
        ).toBeInTheDocument()
        expect(screen.getByText('Group set usage view')).toBeInTheDocument()
        // Nothing changed on the server -- see the two success-path tests
        // above for what this guards against not happening instead.
        expect(mockUsageRefresh).not.toHaveBeenCalled()
    })

    // Fix round 2 (Minor folded in): `refreshUsage()` used to run only on
    // the success path inside the `try`, so an unexpected throw from
    // `installUsageView` (it does not normally throw -- see its own doc
    // comment -- but a genuinely unexpected error must still be handled)
    // left `usageCheck` exactly as it was before the click, even if the
    // view was actually created on the server moments before the throw.
    // Moving the re-check into `finally` means the second `checkUsageView`
    // call below -- simulating the server having the view now -- always
    // happens, and "Usable" replaces "Missing" despite the error shown.
    it('re-checks the server after an unexpected install failure, instead of leaving a stale status', async () => {
        mockCheckUsage
            .mockResolvedValueOnce(usageCheck(null, 'missing'))
            .mockResolvedValueOnce(usageCheck('v2', 'usable'))
        mockInstallUsage.mockRejectedValueOnce(new Error('boom'))
        renderSettings({ canManage: true })
        fireEvent.click(
            await screen.findByRole('button', {
                name: 'Install usage SQL view',
            })
        )
        expect(await screen.findByText('boom')).toBeInTheDocument()
        expect(await screen.findByText('Usable')).toBeInTheDocument()
        expect(mockCheckUsage).toHaveBeenCalledTimes(2)
    })

    // Review fix 2 (Important), status-check half: a failing status check
    // (unlike an action failure) is a real "nothing to show" state, gated
    // the same way the SQL views section gates on `checkError`, with the
    // same retry affordance.
    it('shows an error and a retry option when the status check itself fails, and retrying re-checks', async () => {
        mockCheckUsage.mockRejectedValueOnce(new Error('HTTP 500'))
        renderSettings({ canManage: true })
        expect(
            await screen.findByText('Could not check the usage SQL view')
        ).toBeInTheDocument()
        expect(screen.getByText('HTTP 500')).toBeInTheDocument()
        expect(
            screen.queryByRole('button', { name: 'Install usage SQL view' })
        ).not.toBeInTheDocument()

        mockCheckUsage.mockResolvedValue(usageCheck(null, 'missing'))
        fireEvent.click(screen.getByRole('button', { name: /try again/i }))
        await waitFor(() => expect(mockCheckUsage).toHaveBeenCalledTimes(2))
        expect(await screen.findByText('Missing')).toBeInTheDocument()
    })

    // Review fix 3 (Minor): `variant: 'existing'` is a placeholder for "the
    // view already there", not a SQL variant name, and must not reach the
    // "{variant} query variant" wording.
    it('names an existing-view repair failure without the query-variant wording', async () => {
        mockCheckUsage.mockResolvedValue(usageCheck('v1', 'needsRepair'))
        mockInstallUsage.mockResolvedValue({
            installed: false,
            variant: null,
            failures: [
                { variant: 'existing', reason: 'other', message: 'HTTP 500' },
            ],
        })
        renderSettings({ canManage: true })
        fireEvent.click(
            await screen.findByRole('button', {
                name: 'Install usage SQL view',
            })
        )
        expect(
            await screen.findByText(
                'The existing usage SQL view could not be repaired — HTTP 500'
            )
        ).toBeInTheDocument()
        expect(
            screen.queryByText(/existing query variant/)
        ).not.toBeInTheDocument()
    })
})

describe('catch-all group', () => {
    it('offers no clear action for a set with no catch-all group', async () => {
        renderSettings({ canManage: true })
        await screen.findByText('Catch-all group')
        expect(
            screen.queryByRole('button', {
                name: /^Clear the catch-all group/,
            })
        ).not.toBeInTheDocument()
    })

    it('clears a configured catch-all group through the config hook', async () => {
        mockGsiConfig.config = {
            catchAllGroup: { own: 'g1' },
            includeTracker: false,
        }
        renderSettings({ canManage: true })
        await screen.findByText('Catch-all group')

        fireEvent.click(
            screen.getByRole('button', {
                name: 'Clear the catch-all group of Ownership',
            })
        )

        await waitFor(() =>
            expect(mockClearCatchAllGroup).toHaveBeenCalledWith('own')
        )
        // Never through setCatchAllGroup with an empty id: "not configured"
        // is the absence of the entry, not a stored empty string.
        expect(mockSetCatchAllGroup).not.toHaveBeenCalled()
    })

    it('reports a failed clear without wiping the shown selection', async () => {
        mockGsiConfig.config = {
            catchAllGroup: { own: 'g1' },
            includeTracker: false,
        }
        mockClearCatchAllGroup.mockRejectedValueOnce(
            new Error('dataStore unreachable')
        )
        renderSettings({ canManage: true })
        await screen.findByText('Catch-all group')

        fireEvent.click(
            screen.getByRole('button', {
                name: 'Clear the catch-all group of Ownership',
            })
        )

        expect(
            await screen.findByText('Could not save the catch-all group')
        ).toBeInTheDocument()
    })
})

describe('catch-all group, accessibility and stale values', () => {
    // M12: the select is named by the set, and each Clear button says which
    // set it clears.
    it('names each select by its group set', async () => {
        renderSettings({ canManage: true })
        expect(
            await screen.findByRole('group', { name: 'Ownership' })
        ).toBeInTheDocument()
    })

    // L6: a group deleted or moved out of the set since it was chosen.
    it('says the configured group is gone instead of showing its raw id', async () => {
        mockGsiConfig.config = {
            catchAllGroup: { own: 'goneGroupId' },
            includeTracker: false,
        }
        renderSettings({ canManage: true })
        expect(
            await screen.findByText(
                'The configured catch-all group no longer exists in this set.'
            )
        ).toBeInTheDocument()
        expect(screen.queryByText('goneGroupId')).not.toBeInTheDocument()
        expect(screen.getByText('Choose catch-all group')).toBeInTheDocument()
        expect(
            screen.getByRole('button', {
                name: 'Clear the catch-all group of Ownership',
            })
        ).toBeInTheDocument()
    })
})

describe('SQL view failures in words', () => {
    it.each([
        ['forbidden', /another administrator probably owns it/i],
        ['conflicting', /delete it in the maintenance app/i],
        ['hiddenDuplicate', /already exists but is not shared with you/i],
    ])('explains a %s failure', async (reason, text) => {
        mockCheckSqlViews.mockResolvedValue(ALL_MISSING)
        mockCreateOrRepairSqlViews.mockResolvedValue({
            created: [],
            repaired: [],
            failed: [{ code: 'GSI_ORGUNITS', reason, message: 'HTTP 4xx' }],
        })
        renderSettings({ canManage: true })
        fireEvent.click(
            await screen.findByRole('button', { name: /create sql views/i })
        )
        expect(await screen.findByText(text)).toBeInTheDocument()
    })
})

describe('usage view removal', () => {
    beforeEach(() => {
        mockCheckUsage.mockResolvedValue(usageCheck('v1', 'usable'))
    })

    it('is not offered without the authority to delete SQL views', async () => {
        renderSettings({ canManage: true, canRemove: false })
        expect(await screen.findByText('Group set usage view')).toBeVisible()
        await waitFor(() => expect(mockCheckUsage).toHaveBeenCalled())
        expect(
            screen.queryByRole('button', { name: 'Remove usage SQL view' })
        ).not.toBeInTheDocument()
    })

    it('explains a refused removal in words', async () => {
        mockRemoveUsage.mockRejectedValue(
            new SqlViewActionError('forbidden', 'HTTP 403')
        )
        renderSettings({ canManage: true })
        fireEvent.click(
            await screen.findByRole('button', { name: 'Remove usage SQL view' })
        )
        expect(
            await screen.findByText(/you may not delete the usage sql view/i)
        ).toBeInTheDocument()
    })
})

describe('SQL view sharing', () => {
    it('is offered only to a user who can create SQL views', async () => {
        mockCheckSqlViews.mockResolvedValue(ALL_USABLE)
        renderSettings({ canManage: false })
        await screen.findByText('GSI org unit hierarchy')
        expect(
            screen.queryByText('Who can read the SQL views')
        ).not.toBeInTheDocument()
    })

    it('saves a user group choice and applies it to the existing views', async () => {
        mockCheckSqlViews.mockResolvedValue(ALL_USABLE)
        mockCreateOrRepairSqlViews.mockResolvedValue({
            created: [],
            repaired: ['GSI_ORGUNITS'],
            failed: [],
        })
        mockCheckUsage.mockResolvedValue(usageCheck(null, 'missing'))
        renderSettings({ canManage: true })
        const groupOption = await screen.findByLabelText(
            'Only the members of one user group'
        )
        await actAndFlush(() => {
            fireEvent.click(groupOption)
        })
        await actAndFlush(() => {
            fireEvent.click(screen.getByText('Choose a user group'))
        })
        await actAndFlush(() => {
            fireEvent.click(screen.getByText('Data managers'))
        })
        await actAndFlush(() => {
            fireEvent.click(
                screen.getByRole('button', {
                    name: 'Save and apply to the SQL views',
                })
            )
        })
        const choice = { kind: 'userGroup', userGroupId: 'ug1' }
        expect(mockSaveSharing).toHaveBeenCalledWith(expect.anything(), choice)
        expect(mockCheckSqlViews).toHaveBeenCalledWith(
            expect.anything(),
            choice
        )
        // The fixtures' usable views carry no server row, so there is no
        // existing view to patch here; the call itself is what is checked.
        expect(mockCreateOrRepairSqlViews).toHaveBeenCalledWith(
            expect.anything(),
            [],
            choice
        )
        expect(
            await screen.findByText(/the sharing setting was saved/i)
        ).toBeInTheDocument()
        expect(mockReload).toHaveBeenCalledWith(true)
    })
})

describe('who can change the settings', () => {
    const readOnlySet = {
        ...mockGroupSets[0],
        id: 'ro',
        displayName: 'Read-only set',
        canWrite: false,
    }
    const asUser = (authorities: string[]) => {
        mockUserScope.authorities = new Set(authorities)
    }

    it('tells a user without ALL that the settings apply to everyone', async () => {
        asUser(['F_SQLVIEW_PUBLIC_ADD'])
        mockCheckSqlViews.mockResolvedValue(ALL_USABLE)
        renderSettings({ canManage: true })
        expect(
            await screen.findByText('These settings apply to every user')
        ).toBeInTheDocument()
    })

    it('shows no such notice to a superuser', async () => {
        mockCheckSqlViews.mockResolvedValue(ALL_USABLE)
        renderSettings({ canManage: true })
        await screen.findByText('GSI org unit hierarchy')
        expect(
            screen.queryByText('These settings apply to every user')
        ).not.toBeInTheDocument()
    })

    it('lets a user without ALL choose the catch-all group of a set they can edit', async () => {
        asUser([])
        mockCheckSqlViews.mockResolvedValue(ALL_USABLE)
        renderSettings({ canManage: false })
        const placeholder = await screen.findByText('Choose catch-all group')
        await actAndFlush(() => {
            fireEvent.click(placeholder)
        })
        await actAndFlush(() => {
            fireEvent.click(screen.getByText('Group two'))
        })
        await waitFor(() =>
            expect(mockSetCatchAllGroup).toHaveBeenCalledWith('own', 'g2')
        )
    })

    it('shows the catch-all group of a set the user cannot edit read-only, and says why', async () => {
        asUser([])
        mockEngine.groupSets = [readOnlySet]
        mockGsiConfig.config = {
            catchAllGroup: { ro: 'g1' },
            includeTracker: false,
        }
        mockCheckSqlViews.mockResolvedValue(ALL_USABLE)
        renderSettings({ canManage: false })
        expect(
            await screen.findByText(
                'You cannot change the catch-all group because you cannot edit this group set.'
            )
        ).toBeInTheDocument()
        expect(screen.getByText('Group one')).toBeInTheDocument()
        expect(
            screen.queryByRole('button', { name: /clear the catch-all group/i })
        ).not.toBeInTheDocument()
        await actAndFlush(() => {
            fireEvent.click(screen.getByText('Group one'))
        })
        expect(screen.queryByText('Group two')).not.toBeInTheDocument()
        expect(mockSetCatchAllGroup).not.toHaveBeenCalled()
    })

    it('lets a superuser choose the catch-all group of a set they cannot edit', async () => {
        mockEngine.groupSets = [readOnlySet]
        mockCheckSqlViews.mockResolvedValue(ALL_USABLE)
        renderSettings({ canManage: true })
        await screen.findByText('Choose catch-all group')
        expect(
            screen.queryByText(
                'You cannot change the catch-all group because you cannot edit this group set.'
            )
        ).not.toBeInTheDocument()
        await actAndFlush(() => {
            fireEvent.click(screen.getByText('Choose catch-all group'))
        })
        await actAndFlush(() => {
            fireEvent.click(screen.getByText('Group two'))
        })
        await waitFor(() =>
            expect(mockSetCatchAllGroup).toHaveBeenCalledWith('ro', 'g2')
        )
    })

    it('keeps the tracker toggle read-only for a user without ALL, and says why', async () => {
        asUser(['F_PERFORM_MAINTENANCE'])
        mockCheckSqlViews.mockResolvedValue(ALL_USABLE)
        renderSettings({ canManage: false })
        const checkbox = await screen.findByLabelText(
            /include tracker data elements/i
        )
        expect(checkbox).toBeDisabled()
        expect(
            screen.getByText(
                'Only a superuser can change this setting, because it applies to every user.'
            )
        ).toBeInTheDocument()
        await actAndFlush(() => {
            fireEvent.click(checkbox)
        })
        expect(mockSetIncludeTracker).not.toHaveBeenCalled()
    })

    it('keeps the tracker toggle closed while the authorities are loading', async () => {
        mockUserScope.isLoading = true
        mockUserScope.authorities = new Set()
        mockCheckSqlViews.mockResolvedValue(ALL_USABLE)
        renderSettings({ canManage: true })
        expect(
            await screen.findByLabelText(/include tracker data elements/i)
        ).toBeDisabled()
        expect(
            screen.queryByText('These settings apply to every user')
        ).not.toBeInTheDocument()
    })

    it('shows a SQL view creator without ALL the sharing choice but not the save', async () => {
        asUser(['F_SQLVIEW_PUBLIC_ADD'])
        mockCheckSqlViews.mockResolvedValue(ALL_USABLE)
        renderSettings({ canManage: true })
        expect(
            await screen.findByLabelText('Only the members of one user group')
        ).toBeDisabled()
        expect(screen.getByLabelText('Every logged-in user')).toBeChecked()
        expect(
            screen.getByText(
                'Only a superuser can change who can read the SQL views, because the choice applies to every user.'
            )
        ).toBeInTheDocument()
        expect(
            screen.queryByRole('button', {
                name: 'Save and apply to the SQL views',
            })
        ).not.toBeInTheDocument()
    })

    it('still offers a SQL view creator without ALL to create the views', async () => {
        asUser(['F_SQLVIEW_PUBLIC_ADD'])
        mockCheckSqlViews.mockResolvedValue(ALL_MISSING)
        renderSettings({ canManage: true })
        expect(
            await screen.findByRole('button', { name: 'Create SQL views' })
        ).toBeInTheDocument()
    })

    it('leaves clearing the cache to every user', async () => {
        asUser([])
        mockCheckSqlViews.mockResolvedValue(ALL_USABLE)
        renderSettings({ canManage: false })
        const button = await screen.findByRole('button', {
            name: /clear cache/i,
        })
        expect(button).toBeEnabled()
        await actAndFlush(() => {
            fireEvent.click(button)
        })
        expect(mockClearCache).toHaveBeenCalledTimes(1)
    })
})
