import i18n from '@dhis2/d2-i18n'
import { Button, CircularLoader, NoticeBox } from '@dhis2/ui'
import React, { useState } from 'react'
import styles from './Settings.module.css'
import { NoAuthorityNotice, StatusTag } from './SqlViewsSection'
import { failedDetail } from './sqlViewText'
import type { AdminSection } from './useAdminSection'
import type { Fetcher } from '@/data/sources/DataSource'
import type { SqlViewAuthorities } from '@/data/sources/sqlViewAdmin'
import type { SqlViewSharing } from '@/data/sources/sqlViewSharing'
import { failureReason } from '@/data/sources/sqlViewSharing'
import type {
    InstallUsageResult,
    UsageInstallFailure,
    UsageViewCheck,
} from '@/data/sources/usageAdmin'
import { installUsageView, removeUsageView } from '@/data/sources/usageAdmin'
import { USAGE_SQL_VIEW_CODE } from '@/data/sources/usageSqlView'
import { interpolate } from '@/utils/interpolate'

export interface UsageState {
    view: UsageViewCheck
    sharing: SqlViewSharing
}

/**
 * `existing` is a placeholder for "the view already there", not a SQL
 * variant name, so it must not reach the "{variant} query variant" wording.
 */
const failureLine = (f: UsageInstallFailure): string => {
    if (f.reason !== 'other') {
        return failedDetail({ ...f, code: USAGE_SQL_VIEW_CODE })
    }
    if (f.variant === 'existing') {
        return interpolate(
            i18n.t(
                'The existing usage SQL view could not be repaired — {message}'
            ),
            { message: f.message }
        )
    }
    return interpolate(
        i18n.t(
            'The {variant} query variant could not be installed — {message}'
        ),
        { variant: f.variant, message: f.message }
    )
}

const InstallReport = ({ result }: { result: InstallUsageResult | null }) => {
    if (!result) {
        return null
    }
    if (result.installed) {
        return (
            <NoticeBox valid title={i18n.t('Usage data is installed')}>
                {/* `variant` is null when an existing view was repaired
                    rather than created: no candidate body to name. */}
                {result.variant
                    ? interpolate(
                          i18n.t('Installed using the {variant} query variant'),
                          { variant: result.variant }
                      )
                    : i18n.t(
                          'The existing usage SQL view was repaired and can now be read.'
                      )}
            </NoticeBox>
        )
    }
    return (
        <NoticeBox
            error
            title={i18n.t('The usage SQL view could not be installed')}
        >
            {result.failures.map((f) => (
                <div key={f.variant}>{failureLine(f)}</div>
            ))}
        </NoticeBox>
    )
}

const CheckFailed = ({ usage }: { usage: AdminSection<UsageState> }) => (
    <NoticeBox error title={i18n.t('Could not check the usage SQL view')}>
        {usage.checkError}
        <div>
            <Button small onClick={() => void usage.refresh()}>
                {i18n.t('Try again')}
            </Button>
        </div>
    </NoticeBox>
)

export const UsageSection = ({
    fetcher,
    usage,
    authorities,
    authoritiesKnown,
    onUsageChanged,
}: {
    fetcher: Fetcher
    usage: AdminSection<UsageState>
    authorities: SqlViewAuthorities | null
    /** false while the SQL views section is still finding them out */
    authoritiesKnown: boolean
    /** tells the readers of usage (Dashboard, cards, Usage tab) to re-read */
    onUsageChanged: () => void
}) => {
    const [result, setResult] = useState<InstallUsageResult | null>(null)

    const install = () =>
        usage.run(async () => {
            if (!usage.check) {
                return
            }
            const installed = await installUsageView(
                fetcher,
                usage.check.view,
                { sharing: usage.check.sharing }
            )
            setResult(installed)
            // Only on a real change: a failed install leaves the instance as
            // the readers already saw it.
            if (installed.installed) {
                onUsageChanged()
            }
        })

    const remove = () =>
        usage.run(async () => {
            if (!usage.check?.view.id) {
                return
            }
            const failure = await removeUsageView(
                fetcher,
                usage.check.view.id
            ).then(
                () => null,
                (e: unknown) => e
            )
            if (failure !== null) {
                // A 403 here means another administrator owns the view;
                // say so instead of a bare status code.
                throw failureReason(failure) === 'forbidden'
                    ? new Error(
                          i18n.t(
                              'You may not delete the usage SQL view. Another administrator probably owns it; ask them or a superuser to remove it.'
                          )
                      )
                    : failure
            }
            // The install report belongs to a view that no longer exists.
            setResult(null)
            onUsageChanged()
        })

    if (usage.checkError) {
        return <CheckFailed usage={usage} />
    }
    const view = usage.check?.view ?? null
    if (view === null) {
        return usage.checking ? <CircularLoader small /> : null
    }

    const canCreate = authorities?.create ?? null
    const needsAction =
        view.status === 'missing' || view.status === 'needsRepair'

    return (
        <>
            <div className={styles.viewRow}>
                <span className={styles.viewName}>
                    {i18n.t('Group set usage view')}
                </span>
                <StatusTag status={view.status} />
            </div>
            {needsAction && canCreate === true && (
                <div>
                    <Button
                        onClick={install}
                        disabled={usage.busy}
                        loading={usage.busy}
                    >
                        {i18n.t('Install usage SQL view')}
                    </Button>
                </div>
            )}
            {view.id && authorities?.remove === true && !needsAction && (
                <div>
                    <Button
                        secondary
                        onClick={remove}
                        disabled={usage.busy}
                        loading={usage.busy}
                    >
                        {i18n.t('Remove usage SQL view')}
                    </Button>
                </div>
            )}
            {/* Fix round 2 (Important 3): without this a user without the
                authority saw "Missing" and no button right after the Usage
                tab told them to install it in Settings. */}
            {needsAction &&
                canCreate !== true &&
                authoritiesKnown &&
                !usage.checking && <NoAuthorityNotice canManage={canCreate} />}
            <InstallReport result={result} />
            {usage.actionError && (
                <NoticeBox
                    error
                    title={i18n.t('The usage SQL view action failed')}
                >
                    {usage.actionError}
                </NoticeBox>
            )}
        </>
    )
}
