import i18n from '@dhis2/d2-i18n'
import { Button, CircularLoader, NoticeBox, Tag } from '@dhis2/ui'
import React, { useState } from 'react'
import styles from './Settings.module.css'
import { SharingChoice } from './SharingChoice'
import { createdSummary, failedDetail, repairedSummary } from './sqlViewText'
import type { AdminSection } from './useAdminSection'
import { useIsSuperuser } from './useIsSuperuser'
import type { Fetcher } from '@/data/sources/DataSource'
import type {
    SqlViewAuthorities,
    SqlViewCheck,
    SqlViewFailure,
    SqlViewStatus,
} from '@/data/sources/sqlViewAdmin'
import {
    checkSqlViews,
    createOrRepairSqlViews,
} from '@/data/sources/sqlViewAdmin'
import type { SqlViewSharing } from '@/data/sources/sqlViewSharing'
import { saveSqlViewSharing } from '@/data/sources/sqlViewSharing'
import { checkUsageView, installUsageView } from '@/data/sources/usageAdmin'
import { USAGE_SQL_VIEW_CODE } from '@/data/sources/usageSqlView'

export interface SqlViewsState {
    checks: SqlViewCheck[]
    authorities: SqlViewAuthorities | null
    sharing: SqlViewSharing
}

/** The tag for one view's status; shared with the usage section. */
export const StatusTag = ({ status }: { status: SqlViewStatus }) => {
    switch (status) {
        case 'usable':
            return <Tag positive>{i18n.t('Usable')}</Tag>
        case 'notSharedWithYou':
            return <Tag neutral>{i18n.t('Not shared with you')}</Tag>
        case 'needsRepair':
            return <Tag neutral>{i18n.t('Not usable yet')}</Tag>
        default:
            return <Tag negative>{i18n.t('Missing')}</Tag>
    }
}

/** The two notices for a user who may not, or may or may not, create views. */
export const NoAuthorityNotice = ({
    canManage,
}: {
    canManage: boolean | null
}) =>
    canManage === false ? (
        <NoticeBox warning title={i18n.t('SQL views are not set up')}>
            {i18n.t(
                'You do not have the required authority to create SQL views. Ask an administrator to create them, or grant the authority to add public SQL views.'
            )}
        </NoticeBox>
    ) : (
        <NoticeBox warning title={i18n.t('SQL views are not set up')}>
            {i18n.t(
                'The app could not determine whether you can create SQL views.'
            )}
        </NoticeBox>
    )

/**
 * Applies a new sharing choice: saves it, then patches every existing view
 * (the three GSI_* views and the usage view) to it. Missing views are left
 * missing: creating them is the create button's job.
 */
async function applySharing(
    fetcher: Fetcher,
    sharing: SqlViewSharing
): Promise<{ repaired: number; failed: SqlViewFailure[] }> {
    await saveSqlViewSharing(fetcher, sharing)
    const checks = await checkSqlViews(fetcher, sharing)
    const result = await createOrRepairSqlViews(
        fetcher,
        checks.filter((c) => c.view !== null),
        sharing
    )
    let repaired = result.repaired.length
    const failed = [...result.failed]
    const usage = await checkUsageView(fetcher, sharing)
    if (usage.view && usage.status === 'needsRepair') {
        const installed = await installUsageView(fetcher, usage, { sharing })
        if (installed.installed) {
            repaired += 1
        }
        failed.push(
            ...installed.failures.map((f) => ({
                code: USAGE_SQL_VIEW_CODE,
                reason: f.reason,
                message: f.message,
            }))
        )
    }
    return { repaired, failed }
}

/** The create and apply-sharing actions, and the report they leave. */
function useSqlViewActions(
    fetcher: Fetcher,
    sqlViews: AdminSection<SqlViewsState>,
    onViewsChanged: () => Promise<void>
) {
    const [summary, setSummary] = useState<string | null>(null)
    const [failures, setFailures] = useState<SqlViewFailure[]>([])

    const report = (lines: string[], failed: SqlViewFailure[]) => {
        setSummary(lines.length > 0 ? lines.join(' — ') : null)
        setFailures(failed)
    }

    const create = () =>
        sqlViews.run(async () => {
            if (!sqlViews.check) {
                return
            }
            // A previous run's report must not survive this one: if the
            // call rejects, `actionError` takes over the section, and a
            // stale "complete" box must not still claim views were created.
            report([], [])
            const result = await createOrRepairSqlViews(
                fetcher,
                sqlViews.check.checks,
                sqlViews.check.sharing
            )
            const lines: string[] = []
            if (result.created.length > 0) {
                lines.push(createdSummary(result.created.length))
            }
            if (result.repaired.length > 0) {
                lines.push(repairedSummary(result.repaired.length))
            }
            report(lines, result.failed)
            // I2: a created or repaired view can change which source the
            // app should read from, so reload rather than wait for the user
            // to.
            if (result.created.length > 0 || result.repaired.length > 0) {
                await onViewsChanged()
            }
        })

    const applySharingChoice = (sharing: SqlViewSharing) =>
        sqlViews.run(async () => {
            report([], [])
            const result = await applySharing(fetcher, sharing)
            const lines = [i18n.t('The sharing setting was saved.')]
            if (result.repaired > 0) {
                lines.push(repairedSummary(result.repaired))
            }
            report(lines, result.failed)
            await onViewsChanged()
        })

    return { summary, failures, create, applySharingChoice }
}

/** One row per view, then what the set of statuses means for this user. */
const ViewList = ({ checks }: { checks: SqlViewCheck[] }) => {
    const allUsable = checks.every((c) => c.usable)
    const notShared = checks.some((c) => c.status === 'notSharedWithYou')
    return (
        <>
            {checks.map((check) => (
                <div key={check.code} className={styles.viewRow}>
                    <span className={styles.viewName}>{check.name}</span>
                    <StatusTag status={check.status} />
                </div>
            ))}
            {allUsable && (
                <NoticeBox valid title={i18n.t('SQL views are set up')}>
                    {i18n.t(
                        'The app is reading organisation unit data through the fast SQL view path.'
                    )}
                </NoticeBox>
            )}
            {notShared && (
                <NoticeBox title={i18n.t('SQL views are not shared with you')}>
                    {i18n.t(
                        'The SQL views are shared with a user group you are not in, so the app loads your data through the slower metadata API. Join that group to use the fast path.'
                    )}
                </NoticeBox>
            )}
        </>
    )
}

const UpdateReport = ({
    summary,
    failures,
    actionError,
}: {
    summary: string | null
    failures: SqlViewFailure[]
    actionError: string | null
}) => (
    <>
        {(summary || failures.length > 0) && (
            <NoticeBox title={i18n.t('SQL view update complete')}>
                {summary && <div>{summary}</div>}
                {failures.map((f) => (
                    <div key={f.code}>{failedDetail(f)}</div>
                ))}
            </NoticeBox>
        )}
        {actionError && (
            <NoticeBox error title={i18n.t('SQL view update failed')}>
                {actionError}
            </NoticeBox>
        )}
    </>
)

const CheckFailed = ({
    sqlViews,
}: {
    sqlViews: AdminSection<SqlViewsState>
}) => (
    // I1: a failing check gets an explicit error and a retry, never an
    // endless spinner. Retrying only reads.
    <NoticeBox error title={i18n.t('Could not check SQL view status')}>
        {sqlViews.checkError}
        <div>
            <Button small onClick={() => void sqlViews.refresh()}>
                {i18n.t('Try again')}
            </Button>
        </div>
    </NoticeBox>
)

export const SqlViewsSection = ({
    fetcher,
    sqlViews,
    onViewsChanged,
}: {
    fetcher: Fetcher
    sqlViews: AdminSection<SqlViewsState>
    /** after a create, repair or sharing change: reload data, re-check usage */
    onViewsChanged: () => Promise<void>
}) => {
    const actions = useSqlViewActions(fetcher, sqlViews, onViewsChanged)
    // Creating and repairing views is gated on the F_SQLVIEW_* authorities;
    // the sharing choice is also a setting every user is subject to, so
    // changing it takes ALL.
    const isSuperuser = useIsSuperuser()

    if (sqlViews.checkError) {
        return <CheckFailed sqlViews={sqlViews} />
    }
    const state = sqlViews.check
    if (state === null) {
        return sqlViews.checking ? <CircularLoader small /> : null
    }

    const canManage = state.authorities?.create ?? null
    const needsAction = state.checks.some(
        (c) => c.status === 'missing' || c.status === 'needsRepair'
    )

    return (
        <>
            <ViewList checks={state.checks} />
            {needsAction && canManage === true && (
                <div>
                    <Button
                        onClick={actions.create}
                        disabled={sqlViews.busy}
                        loading={sqlViews.busy}
                    >
                        {i18n.t('Create SQL views')}
                    </Button>
                </div>
            )}
            {needsAction && canManage !== true && !sqlViews.checking && (
                <NoAuthorityNotice canManage={canManage} />
            )}
            {canManage === true && (
                <SharingChoice
                    fetcher={fetcher}
                    current={state.sharing}
                    busy={sqlViews.busy}
                    readOnly={isSuperuser !== true}
                    onApply={actions.applySharingChoice}
                />
            )}
            <UpdateReport
                summary={actions.summary}
                failures={actions.failures}
                actionError={sqlViews.actionError}
            />
        </>
    )
}
