import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { Settings } from './Settings'
import {
    checkUsageView,
    installUsageView,
    removeUsageView,
} from '@/data/sources/usageAdmin'

jest.mock('@dhis2/app-runtime', () => ({
    useConfig: () => ({ baseUrl: 'http://localhost:8080', apiVersion: 41 }),
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
const mockClearCache = jest.fn(async () => undefined)
const mockEngine = {
    groupSets: mockGroupSets,
    client: null as { call: jest.Mock } | null,
    reload: mockReload,
    clearCache: mockClearCache,
}
jest.mock('@/hooks/useEngine', () => ({
    useEngine: () => mockEngine,
}))

const mockSetCatchAllGroup = jest.fn(async () => undefined)
const mockSetIncludeTracker = jest.fn(async () => undefined)
const mockGsiConfig: {
    config: {
        catchAllGroup: Record<string, string>
        includeTracker: boolean
    }
    isLoaded: boolean
    setCatchAllGroup: typeof mockSetCatchAllGroup
    setIncludeTracker: typeof mockSetIncludeTracker
} = {
    config: { catchAllGroup: {}, includeTracker: false },
    isLoaded: true,
    setCatchAllGroup: mockSetCatchAllGroup,
    setIncludeTracker: mockSetIncludeTracker,
}
jest.mock('@/hooks/useGsiConfig', () => ({
    useGsiConfig: () => mockGsiConfig,
}))

const mockCheckSqlViews = jest.fn()
const mockCanCreateSqlViews = jest.fn()
const mockCreateOrRepairSqlViews = jest.fn()
jest.mock('@/data/sources/sqlViewAdmin', () => ({
    checkSqlViews: (...args: unknown[]) => mockCheckSqlViews(...args),
    canCreateSqlViews: (...args: unknown[]) => mockCanCreateSqlViews(...args),
    createOrRepairSqlViews: (...args: unknown[]) =>
        mockCreateOrRepairSqlViews(...args),
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
    readable: true,
    usable: true,
})
const missingCheck = (code: string, name: string) => ({
    code,
    name,
    id: null,
    type: undefined,
    readable: false,
    usable: false,
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
    mockCanCreateSqlViews.mockReset()
    mockCreateOrRepairSqlViews.mockReset()
    // Cleared (not just re-configured in each usage test's own beforeEach)
    // so call-count assertions like `toHaveBeenCalledTimes` aren't polluted
    // by every other test in the file also rendering the usage section.
    mockCheckUsage.mockReset()
    mockInstallUsage.mockReset()
    mockRemoveUsage.mockReset()
    mockUsageRefresh.mockReset()
    mockGsiConfig.config = {
        catchAllGroup: {},
        includeTracker: false,
    }
})

/**
 * `canManage` drives `canCreateSqlViews` -- the same authority governs
 * creating the three GSI_* views and creating the usage view, so one flag
 * covers both sections' create/repair buttons.
 */
const renderSettings = ({ canManage }: { canManage: boolean | null }) => {
    mockCanCreateSqlViews.mockResolvedValue(canManage)
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
        await act(async () => {
            fireEvent.click(button)
        })
        expect(mockCreateOrRepairSqlViews).toHaveBeenCalledWith(
            expect.anything(),
            ALL_MISSING
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
        await act(async () => {
            fireEvent.click(button)
        })
        expect(screen.getByText(/GSI_ORGUNIT_MEMBERSHIPS/)).toBeInTheDocument()
        expect(screen.getByText(/HTTP 500 executing view/)).toBeInTheDocument()
        // A partial failure is not a reason to reload if nothing was
        // created or repaired -- but here two of three were, so it should.
        expect(mockReload).toHaveBeenCalledWith(true)
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
        await act(async () => {
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
        await act(async () => {
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
        await act(async () => {
            fireEvent.click(placeholder)
        })
        const option = await screen.findByText('Group two')
        await act(async () => {
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
        await act(async () => {
            fireEvent.click(placeholder)
        })
        const option = await screen.findByText('Group two')
        await act(async () => {
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
            /include tracker attributes/i
        )
        await act(async () => {
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
        await act(async () => {
            fireEvent.click(button)
        })
        expect(mockClearCache).toHaveBeenCalledTimes(1)
        expect(mockReload).toHaveBeenCalledWith(true)
    })
})

describe('Settings — group set usage', () => {
    beforeEach(() => {
        mockCheckUsage.mockResolvedValue({
            id: null,
            type: undefined,
            readable: false,
            usable: false,
        })
        mockInstallUsage.mockResolvedValue({
            installed: true,
            variant: 'eventvisualization',
            id: 'new1',
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
            id: null,
            failures: [{ variant: 'eventvisualization', message: 'HTTP 409' }],
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
        mockCheckUsage.mockResolvedValue({
            id: 'v1',
            type: 'VIEW',
            readable: true,
            usable: true,
        })
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
        let resolveCheck: (value: {
            id: string | null
            type: string | undefined
            readable: boolean
            usable: boolean
        }) => void = () => undefined
        mockCheckUsage.mockReturnValue(
            new Promise((resolve) => {
                resolveCheck = resolve
            })
        )
        renderSettings({ canManage: true })
        expect(await screen.findByText('Group set usage')).toBeInTheDocument()
        expect(screen.queryByText('Missing')).not.toBeInTheDocument()
        expect(screen.queryByText('Usable')).not.toBeInTheDocument()

        resolveCheck({
            id: null,
            type: undefined,
            readable: false,
            usable: false,
        })
        expect(await screen.findByText('Missing')).toBeInTheDocument()
    })

    // Review fix 2 (Important): an install/remove failure must not gate the
    // whole section -- a 403 on remove (or a view someone else deleted
    // mid-session) would otherwise wipe the tag and both buttons with no way
    // back except reloading the page.
    it('leaves the remove button and the view row on screen when removal fails, reporting the error alongside them', async () => {
        mockCheckUsage.mockResolvedValue({
            id: 'v1',
            type: 'VIEW',
            readable: true,
            usable: true,
        })
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
            .mockResolvedValueOnce({
                id: null,
                type: undefined,
                readable: false,
                usable: false,
            })
            .mockResolvedValueOnce({
                id: 'v2',
                type: 'VIEW',
                readable: true,
                usable: true,
            })
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

        mockCheckUsage.mockResolvedValue({
            id: null,
            type: undefined,
            readable: false,
            usable: false,
        })
        fireEvent.click(screen.getByRole('button', { name: /try again/i }))
        await waitFor(() => expect(mockCheckUsage).toHaveBeenCalledTimes(2))
        expect(await screen.findByText('Missing')).toBeInTheDocument()
    })

    // Review fix 3 (Minor): `variant: 'existing'` is a placeholder for "the
    // view already there", not a SQL variant name, and must not reach the
    // "{variant} query variant" wording.
    it('names an existing-view repair failure without the query-variant wording', async () => {
        mockCheckUsage.mockResolvedValue({
            id: 'v1',
            type: 'VIEW',
            readable: false,
            usable: false,
        })
        mockInstallUsage.mockResolvedValue({
            installed: false,
            variant: null,
            id: 'v1',
            failures: [{ variant: 'existing', message: 'HTTP 500' }],
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
