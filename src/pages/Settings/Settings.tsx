import { useConfig } from '@dhis2/app-runtime'
import i18n from '@dhis2/d2-i18n'
import {
    Button,
    Checkbox,
    CircularLoader,
    NoticeBox,
    SingleSelectField,
    SingleSelectOption,
    Tag,
} from '@dhis2/ui'
import React, { useMemo, useState } from 'react'
import styles from './Settings.module.css'
import { useAdminSection } from './useAdminSection'
import { createFetcher } from '@/data/fetcher'
import {
    canCreateSqlViews,
    checkSqlViews,
    createOrRepairSqlViews,
} from '@/data/sources/sqlViewAdmin'
import {
    checkUsageView,
    installUsageView,
    removeUsageView,
    InstallUsageResult,
} from '@/data/sources/usageAdmin'
import { useEngine } from '@/hooks/useEngine'
import { useGsiConfig } from '@/hooks/useGsiConfig'
import { useUsageRefresh } from '@/hooks/useUsage'
import { interpolate } from '@/utils/interpolate'

/** Two complete strings, never a fragment glued to a number: see CLAUDE.md. */
const createdSummary = (count: number) =>
    count === 1
        ? i18n.t('Created 1 SQL view')
        : interpolate(i18n.t('Created {count} SQL views'), { count })

const repairedSummary = (count: number) =>
    count === 1
        ? i18n.t('Repaired 1 SQL view')
        : interpolate(i18n.t('Repaired {count} SQL views'), { count })

/**
 * M2: the count alone doesn't say which view failed or why. No colon in the
 * template (the i18n scanner reads a colon as its own namespace separator
 * and drops the key -- see CLAUDE.md), so this reads as one clause per
 * failed view rather than a "label: value" pair.
 */
const failedDetail = (failed: { code: string; message: string }) =>
    interpolate(i18n.t('{code} could not be created or repaired — {message}'), {
        code: failed.code,
        message: failed.message,
    })

export const Settings = () => {
    const { baseUrl, apiVersion } = useConfig() as {
        baseUrl: string
        apiVersion: number
    }
    const fetcher = useMemo(
        () => createFetcher(baseUrl, apiVersion),
        [baseUrl, apiVersion]
    )
    const { groupSets, reload, clearCache } = useEngine()
    const {
        config,
        isLoaded: configLoaded,
        setCatchAllGroup,
        setIncludeTracker,
    } = useGsiConfig()
    // Not the full `useUsage()` hook: Settings never displays usage, and
    // mounting the hook here issued the lookup and the data read on every
    // visit just to reach `refresh`. This tells the readers that do display
    // it (Dashboard, GroupSetCard, UsageTab) that the view just changed.
    const refreshUsageReaders = useUsageRefresh()

    const [createSummary, setCreateSummary] = useState<string | null>(null)
    const [createFailures, setCreateFailures] = useState<
        { code: string; message: string }[]
    >([])
    const [clearingCache, setClearingCache] = useState(false)
    // I3: every saver below reports its own failure into one of these,
    // rather than the write vanishing silently. Keyed by which control
    // caused it, so one save's error cannot outlive the control that raised
    // it or be mistaken for a different one's.
    const [catchAllError, setCatchAllError] = useState<string | null>(null)
    const [trackerError, setTrackerError] = useState<string | null>(null)

    const [usageResult, setUsageResult] = useState<InstallUsageResult | null>(
        null
    )

    const sqlViews = useAdminSection(async () => {
        const [checks, canManage] = await Promise.all([
            checkSqlViews(fetcher),
            canCreateSqlViews(fetcher),
        ])
        return { checks, canManage }
    })

    const usage = useAdminSection(() => checkUsageView(fetcher))

    const handleCreate = () =>
        sqlViews.run(async () => {
            if (!sqlViews.check) {
                return
            }
            const result = await createOrRepairSqlViews(
                fetcher,
                sqlViews.check.checks
            )
            const parts: string[] = []
            if (result.created.length > 0) {
                parts.push(createdSummary(result.created.length))
            }
            if (result.repaired.length > 0) {
                parts.push(repairedSummary(result.repaired.length))
            }
            setCreateSummary(parts.length > 0 ? parts.join(' — ') : null)
            setCreateFailures(result.failed)
            // I2: on the very instances that motivate this feature, staying
            // on the metadata API until a manual reload would make this
            // button appear to do nothing. Any view this call actually
            // created or repaired can change which source `useEngine`
            // should be using, so a real reload -- not just a re-check of
            // status -- is what puts the app on the fast path immediately.
            if (result.created.length > 0 || result.repaired.length > 0) {
                await reload(true)
            }
        })

    const handleClearCache = async () => {
        setClearingCache(true)
        try {
            await clearCache()
            await reload(true)
        } finally {
            setClearingCache(false)
        }
    }

    const handleInstallUsage = () =>
        usage.run(async () => {
            if (!usage.check) {
                return
            }
            const result = await installUsageView(fetcher, usage.check)
            setUsageResult(result)
            if (result.installed) {
                // Only on a real change: a failed install leaves the
                // instance exactly as `useUsage()`'s readers already saw it.
                refreshUsageReaders()
            }
        })

    const handleRemoveUsage = () =>
        usage.run(async () => {
            if (!usage.check?.id) {
                return
            }
            await removeUsageView(fetcher, usage.check.id)
            // The install report belongs to a view that no longer exists.
            setUsageResult(null)
            refreshUsageReaders()
        })

    const checks = sqlViews.check?.checks ?? null
    const canManage = sqlViews.check?.canManage ?? null
    const allUsable = checks !== null && checks.every((c) => c.usable)
    const anyUnusable = checks !== null && checks.some((c) => !c.usable)

    return (
        <div className={styles.page}>
            <div className={styles.section}>
                <h2 className={styles.heading}>{i18n.t('SQL views')}</h2>
                {sqlViews.checking && sqlViews.check === null ? (
                    <CircularLoader small />
                ) : sqlViews.checkError ? (
                    // I1: without this, a failing checkSqlViews (a 403, a
                    // 500 with an HTML body, a dropped connection) left the
                    // spinner above running forever with an unhandled
                    // rejection behind it, and no way for the user to know
                    // why. `sqlViews.refresh` is safe to call again -- it
                    // does not create or execute anything -- so retrying is
                    // a plain reload, not a repair attempt.
                    <NoticeBox
                        error
                        title={i18n.t('Could not check SQL view status')}
                    >
                        {sqlViews.checkError}
                        <div>
                            <Button
                                small
                                onClick={() => void sqlViews.refresh()}
                            >
                                {i18n.t('Try again')}
                            </Button>
                        </div>
                    </NoticeBox>
                ) : (
                    <>
                        {(checks ?? []).map((check) => (
                            <div key={check.code} className={styles.viewRow}>
                                <span className={styles.viewName}>
                                    {check.name}
                                </span>
                                {check.usable ? (
                                    <Tag positive>{i18n.t('Usable')}</Tag>
                                ) : check.id ? (
                                    <Tag neutral>
                                        {i18n.t('Not usable yet')}
                                    </Tag>
                                ) : (
                                    <Tag negative>{i18n.t('Missing')}</Tag>
                                )}
                            </div>
                        ))}
                        {allUsable && (
                            <NoticeBox
                                valid
                                title={i18n.t('SQL views are set up')}
                            >
                                {i18n.t(
                                    'The app is reading organisation unit data through the fast SQL view path.'
                                )}
                            </NoticeBox>
                        )}
                        {anyUnusable && canManage === true && (
                            <Button
                                onClick={handleCreate}
                                disabled={sqlViews.busy}
                                loading={sqlViews.busy}
                            >
                                {i18n.t('Create SQL views')}
                            </Button>
                        )}
                        {anyUnusable && canManage === false && (
                            <NoticeBox
                                warning
                                title={i18n.t('SQL views are not set up')}
                            >
                                {i18n.t(
                                    'You do not have the required authority to create SQL views. Ask an administrator to create them, or grant the authority to add public SQL views.'
                                )}
                            </NoticeBox>
                        )}
                        {anyUnusable &&
                            canManage === null &&
                            !sqlViews.checking && (
                                <NoticeBox
                                    warning
                                    title={i18n.t('SQL views are not set up')}
                                >
                                    {i18n.t(
                                        'The app could not determine whether you can create SQL views.'
                                    )}
                                </NoticeBox>
                            )}
                        {(createSummary || createFailures.length > 0) && (
                            <NoticeBox
                                title={i18n.t('SQL view update complete')}
                            >
                                {createSummary && <div>{createSummary}</div>}
                                {createFailures.map((f) => (
                                    <div key={f.code}>{failedDetail(f)}</div>
                                ))}
                            </NoticeBox>
                        )}
                        {sqlViews.actionError && (
                            <NoticeBox
                                error
                                title={i18n.t('SQL view update failed')}
                            >
                                {sqlViews.actionError}
                            </NoticeBox>
                        )}
                    </>
                )}
            </div>

            <div className={styles.section}>
                <h2 className={styles.heading}>{i18n.t('Group set usage')}</h2>
                <p className={styles.note}>
                    {i18n.t(
                        'An optional SQL view that counts the saved favourites referencing each group set, and how often they were viewed in the last 12 months. Without it the app works exactly as before, only with no usage figures.'
                    )}
                </p>
                {usage.checking && usage.check === null ? (
                    <CircularLoader small />
                ) : usage.checkError ? (
                    <NoticeBox
                        error
                        title={i18n.t('Could not check the usage SQL view')}
                    >
                        {usage.checkError}
                        <div>
                            <Button small onClick={() => void usage.refresh()}>
                                {i18n.t('Try again')}
                            </Button>
                        </div>
                    </NoticeBox>
                ) : (
                    <>
                        <div className={styles.viewRow}>
                            <span className={styles.viewName}>
                                {i18n.t('Group set usage view')}
                            </span>
                            {usage.check?.usable ? (
                                <Tag positive>{i18n.t('Usable')}</Tag>
                            ) : usage.check?.id ? (
                                <Tag neutral>{i18n.t('Not usable yet')}</Tag>
                            ) : (
                                <Tag negative>{i18n.t('Missing')}</Tag>
                            )}
                        </div>
                        {usage.check &&
                            !usage.check.usable &&
                            canManage === true && (
                                <Button
                                    onClick={handleInstallUsage}
                                    disabled={usage.busy}
                                    loading={usage.busy}
                                >
                                    {i18n.t('Install usage SQL view')}
                                </Button>
                            )}
                        {usage.check?.usable && canManage === true && (
                            <Button
                                secondary
                                onClick={handleRemoveUsage}
                                disabled={usage.busy}
                                loading={usage.busy}
                            >
                                {i18n.t('Remove usage SQL view')}
                            </Button>
                        )}
                        {usage.check &&
                            !usage.check.usable &&
                            canManage === false && (
                                // Fix round 2 (Important 3): mirrors the SQL
                                // views section's own `canManage === false`
                                // branch above, reusing its exact wording --
                                // without this a user without the authority
                                // saw "Missing", no button and no
                                // explanation, right after the Usage tab
                                // told them to "Go to Settings to install
                                // it": a loop with no exit.
                                <NoticeBox
                                    warning
                                    title={i18n.t('SQL views are not set up')}
                                >
                                    {i18n.t(
                                        'You do not have the required authority to create SQL views. Ask an administrator to create them, or grant the authority to add public SQL views.'
                                    )}
                                </NoticeBox>
                            )}
                        {usage.check &&
                            !usage.check.usable &&
                            canManage === null &&
                            !usage.checking && (
                                <NoticeBox
                                    warning
                                    title={i18n.t('SQL views are not set up')}
                                >
                                    {i18n.t(
                                        'The app could not determine whether you can create SQL views.'
                                    )}
                                </NoticeBox>
                            )}
                        {usageResult?.installed && (
                            <NoticeBox
                                valid
                                title={i18n.t('Usage data is installed')}
                            >
                                {/* `variant` is null when an existing view
                                    was repaired rather than created -- there
                                    is no candidate body to name in that
                                    case, but the install still succeeded
                                    and must say so. */}
                                {usageResult.variant
                                    ? interpolate(
                                          i18n.t(
                                              'Installed using the {variant} query variant'
                                          ),
                                          { variant: usageResult.variant }
                                      )
                                    : i18n.t(
                                          'The existing usage SQL view was repaired and can now be read.'
                                      )}
                            </NoticeBox>
                        )}
                        {usageResult && !usageResult.installed && (
                            <NoticeBox
                                error
                                title={i18n.t(
                                    'The usage SQL view could not be installed'
                                )}
                            >
                                {usageResult.failures.map((f) =>
                                    // `existing` is a placeholder id for "the
                                    // view already there", not a SQL variant
                                    // name -- it must not reach the
                                    // "{variant} query variant" wording.
                                    f.variant === 'existing' ? (
                                        <div key={f.variant}>
                                            {interpolate(
                                                i18n.t(
                                                    'The existing usage SQL view could not be repaired — {message}'
                                                ),
                                                { message: f.message }
                                            )}
                                        </div>
                                    ) : (
                                        <div key={f.variant}>
                                            {interpolate(
                                                i18n.t(
                                                    'The {variant} query variant could not be installed — {message}'
                                                ),
                                                {
                                                    variant: f.variant,
                                                    message: f.message,
                                                }
                                            )}
                                        </div>
                                    )
                                )}
                            </NoticeBox>
                        )}
                        {usage.actionError && (
                            <NoticeBox
                                error
                                title={i18n.t(
                                    'The usage SQL view action failed'
                                )}
                            >
                                {usage.actionError}
                            </NoticeBox>
                        )}
                    </>
                )}
            </div>

            <div className={styles.section}>
                <h2 className={styles.heading}>{i18n.t('Catch-all group')}</h2>
                {groupSets.map((set) => (
                    <div key={set.id} className={styles.row}>
                        <span className={styles.setLabel}>
                            {set.displayName}
                        </span>
                        <div className={styles.field}>
                            <SingleSelectField
                                dense
                                label=""
                                placeholder={i18n.t('Choose catch-all group')}
                                selected={config.catchAllGroup[set.id] ?? ''}
                                disabled={!configLoaded}
                                onChange={({
                                    selected,
                                }: {
                                    selected: string
                                }) => {
                                    setCatchAllError(null)
                                    setCatchAllGroup(set.id, selected).catch(
                                        (e: unknown) => {
                                            setCatchAllError(
                                                e instanceof Error
                                                    ? e.message
                                                    : String(e)
                                            )
                                        }
                                    )
                                }}
                            >
                                {set.groups.map((g) => (
                                    <SingleSelectOption
                                        key={g.id}
                                        value={g.id}
                                        label={g.displayName}
                                    />
                                ))}
                            </SingleSelectField>
                        </div>
                    </div>
                ))}
                {catchAllError && (
                    <NoticeBox
                        error
                        title={i18n.t('Could not save the catch-all group')}
                    >
                        {catchAllError}
                    </NoticeBox>
                )}
            </div>

            <div className={styles.section}>
                <h2 className={styles.heading}>{i18n.t('Tracker data')}</h2>
                <Checkbox
                    label={i18n.t(
                        'Include tracker attributes and data elements by default'
                    )}
                    checked={config.includeTracker}
                    disabled={!configLoaded}
                    onChange={({ checked }: { checked: boolean }) => {
                        setTrackerError(null)
                        setIncludeTracker(checked).catch((e: unknown) => {
                            setTrackerError(
                                e instanceof Error ? e.message : String(e)
                            )
                        })
                    }}
                />
                {trackerError && (
                    <NoticeBox
                        error
                        title={i18n.t(
                            'Could not save the tracker data setting'
                        )}
                    >
                        {trackerError}
                    </NoticeBox>
                )}
            </div>

            <div className={styles.section}>
                <h2 className={styles.heading}>{i18n.t('Cache')}</h2>
                <Button
                    onClick={handleClearCache}
                    disabled={clearingCache}
                    loading={clearingCache}
                >
                    {i18n.t('Clear cache')}
                </Button>
            </div>
        </div>
    )
}
