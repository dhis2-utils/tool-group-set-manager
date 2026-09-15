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
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import styles from './Settings.module.css'
import { createFetcher } from '@/data/fetcher'
import {
    canCreateSqlViews,
    checkSqlViews,
    createOrRepairSqlViews,
    SqlViewCheck,
} from '@/data/sources/sqlViewAdmin'
import {
    checkUsageView,
    installUsageView,
    removeUsageView,
    InstallUsageResult,
    UsageViewCheck,
} from '@/data/sources/usageAdmin'
import { useEngine } from '@/hooks/useEngine'
import { useGsiConfig } from '@/hooks/useGsiConfig'
import { useUsage } from '@/hooks/useUsage'
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
    // Not a provider (see the hook's own doc comment): calling it here gets
    // this component its own subscription to the same TanStack Query cache
    // entries the Dashboard, GroupSetCard and UsageTab read. `usage.refresh`
    // is what tells that shared cache the view just changed -- without it,
    // installing or removing the view here left every other reader of
    // `useUsage()` on the stale value from whenever they first mounted
    // (`staleTime: Infinity` on the lookup query), reporting the view as
    // still absent, or still present, until a full page reload.
    const usage = useUsage()

    const [checks, setChecks] = useState<SqlViewCheck[] | null>(null)
    // D5: null means "not yet known" (still checking, or the check itself
    // failed) -- only `true` ever shows the create/repair button.
    const [canManage, setCanManage] = useState<boolean | null>(null)
    const [checking, setChecking] = useState(true)
    // I1: a failing status check is itself a real, distinct state -- never
    // conflated with "still checking" (which would spin forever) or with
    // "checked and found nothing usable" (which would offer a create button
    // that may just repeat the same failure).
    const [checkError, setCheckError] = useState<string | null>(null)
    const [creating, setCreating] = useState(false)
    const [createSummary, setCreateSummary] = useState<string | null>(null)
    const [createFailures, setCreateFailures] = useState<
        { code: string; message: string }[]
    >([])
    const [createError, setCreateError] = useState<string | null>(null)
    const [clearingCache, setClearingCache] = useState(false)
    // I3: every saver below reports its own failure into one of these,
    // rather than the write vanishing silently. Keyed by which control
    // caused it, so one save's error cannot outlive the control that raised
    // it or be mistaken for a different one's.
    const [catchAllError, setCatchAllError] = useState<string | null>(null)
    const [trackerError, setTrackerError] = useState<string | null>(null)

    const [usageCheck, setUsageCheck] = useState<UsageViewCheck | null>(null)
    const [usageChecking, setUsageChecking] = useState(true)
    const [usageBusy, setUsageBusy] = useState(false)
    const [usageResult, setUsageResult] = useState<InstallUsageResult | null>(
        null
    )
    // Split the way `checkError`/`createError` are split above: a failing
    // status check gates the whole section (there is nothing to show), but
    // an install/remove failure must not -- a 403 on remove, or a view
    // someone else deleted mid-session, would otherwise wipe the tag and
    // both buttons with no way back except reloading the page.
    const [usageCheckError, setUsageCheckError] = useState<string | null>(null)
    const [usageActionError, setUsageActionError] = useState<string | null>(
        null
    )

    const refreshUsage = useCallback(async () => {
        setUsageChecking(true)
        setUsageCheckError(null)
        try {
            setUsageCheck(await checkUsageView(fetcher))
        } catch (e) {
            setUsageCheck(null)
            setUsageCheckError(e instanceof Error ? e.message : String(e))
        } finally {
            setUsageChecking(false)
        }
    }, [fetcher])

    useEffect(() => {
        void refreshUsage()
    }, [refreshUsage])

    const refreshStatus = useCallback(async () => {
        setChecking(true)
        setCheckError(null)
        try {
            const [nextChecks, nextCanManage] = await Promise.all([
                checkSqlViews(fetcher),
                canCreateSqlViews(fetcher),
            ])
            setChecks(nextChecks)
            setCanManage(nextCanManage)
        } catch (e) {
            // I1: `checkSqlViews` (unlike `canCreateSqlViews`) can reject --
            // a 403, a 500 with an HTML body, a dropped connection -- and
            // without this the section would spin forever on an unhandled
            // rejection instead of telling the user anything.
            setChecks(null)
            setCanManage(null)
            setCheckError(e instanceof Error ? e.message : String(e))
        } finally {
            setChecking(false)
        }
    }, [fetcher])

    useEffect(() => {
        void refreshStatus()
    }, [refreshStatus])

    const handleCreate = async () => {
        if (!checks) {
            return
        }
        setCreating(true)
        setCreateError(null)
        setCreateSummary(null)
        setCreateFailures([])
        try {
            const result = await createOrRepairSqlViews(fetcher, checks)
            const parts: string[] = []
            if (result.created.length > 0) {
                parts.push(createdSummary(result.created.length))
            }
            if (result.repaired.length > 0) {
                parts.push(repairedSummary(result.repaired.length))
            }
            setCreateSummary(parts.length > 0 ? parts.join(' — ') : null)
            setCreateFailures(result.failed)
            await refreshStatus()
            // I2: on the very instances that motivate this feature, staying
            // on the metadata API until a manual reload would make this
            // button appear to do nothing. Any view this call actually
            // created or repaired can change which source `useEngine`
            // should be using, so a real reload -- not just a re-check of
            // status -- is what puts the app on the fast path immediately.
            if (result.created.length > 0 || result.repaired.length > 0) {
                await reload(true)
            }
        } catch (e) {
            setCreateError(e instanceof Error ? e.message : String(e))
        } finally {
            setCreating(false)
        }
    }

    const handleClearCache = async () => {
        setClearingCache(true)
        try {
            await clearCache()
            await reload(true)
        } finally {
            setClearingCache(false)
        }
    }

    const handleInstallUsage = async () => {
        if (!usageCheck) {
            return
        }
        setUsageBusy(true)
        setUsageActionError(null)
        try {
            const result = await installUsageView(fetcher, usageCheck)
            setUsageResult(result)
            await refreshUsage()
            if (result.installed) {
                // Only on a real change: a failed install leaves the
                // instance exactly as `useUsage()`'s readers already saw it.
                usage.refresh()
            }
        } catch (e) {
            setUsageActionError(e instanceof Error ? e.message : String(e))
        } finally {
            setUsageBusy(false)
        }
    }

    const handleRemoveUsage = async () => {
        if (!usageCheck?.id) {
            return
        }
        setUsageBusy(true)
        setUsageActionError(null)
        try {
            await removeUsageView(fetcher, usageCheck.id)
            // The install report belongs to a view that no longer exists.
            setUsageResult(null)
            await refreshUsage()
            usage.refresh()
        } catch (e) {
            setUsageActionError(e instanceof Error ? e.message : String(e))
        } finally {
            setUsageBusy(false)
        }
    }

    const allUsable = checks !== null && checks.every((c) => c.usable)
    const anyUnusable = checks !== null && checks.some((c) => !c.usable)

    return (
        <div className={styles.page}>
            <div className={styles.section}>
                <h2 className={styles.heading}>{i18n.t('SQL views')}</h2>
                {checking && checks === null ? (
                    <CircularLoader small />
                ) : checkError ? (
                    // I1: without this, a failing checkSqlViews (a 403, a
                    // 500 with an HTML body, a dropped connection) left the
                    // spinner above running forever with an unhandled
                    // rejection behind it, and no way for the user to know
                    // why. `refreshStatus` is safe to call again -- it does
                    // not create or execute anything -- so retrying is a
                    // plain reload, not a repair attempt.
                    <NoticeBox
                        error
                        title={i18n.t('Could not check SQL view status')}
                    >
                        {checkError}
                        <div>
                            <Button small onClick={() => void refreshStatus()}>
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
                                disabled={creating}
                                loading={creating}
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
                        {anyUnusable && canManage === null && !checking && (
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
                        {createError && (
                            <NoticeBox
                                error
                                title={i18n.t('SQL view update failed')}
                            >
                                {createError}
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
                {usageChecking && usageCheck === null ? (
                    <CircularLoader small />
                ) : usageCheckError ? (
                    <NoticeBox
                        error
                        title={i18n.t('Could not check the usage SQL view')}
                    >
                        {usageCheckError}
                        <div>
                            <Button small onClick={() => void refreshUsage()}>
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
                            {usageCheck?.usable ? (
                                <Tag positive>{i18n.t('Usable')}</Tag>
                            ) : usageCheck?.id ? (
                                <Tag neutral>{i18n.t('Not usable yet')}</Tag>
                            ) : (
                                <Tag negative>{i18n.t('Missing')}</Tag>
                            )}
                        </div>
                        {usageCheck &&
                            !usageCheck.usable &&
                            canManage === true && (
                                <Button
                                    onClick={handleInstallUsage}
                                    disabled={usageBusy}
                                    loading={usageBusy}
                                >
                                    {i18n.t('Install usage SQL view')}
                                </Button>
                            )}
                        {usageCheck?.usable && canManage === true && (
                            <Button
                                secondary
                                onClick={handleRemoveUsage}
                                disabled={usageBusy}
                                loading={usageBusy}
                            >
                                {i18n.t('Remove usage SQL view')}
                            </Button>
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
                        {usageActionError && (
                            <NoticeBox
                                error
                                title={i18n.t(
                                    'The usage SQL view action failed'
                                )}
                            >
                                {usageActionError}
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
