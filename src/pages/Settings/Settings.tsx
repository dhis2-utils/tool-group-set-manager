import { useConfig } from '@dhis2/app-runtime'
import i18n from '@dhis2/d2-i18n'
import {
    Button,
    Checkbox,
    CircularLoader,
    MultiSelectField,
    MultiSelectOption,
    NoticeBox,
    SingleSelectField,
    SingleSelectOption,
    Tag,
} from '@dhis2/ui'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import styles from './Settings.module.css'
import { openCache } from '@/data/cache'
import { createFetcher } from '@/data/fetcher'
import {
    canCreateSqlViews,
    checkSqlViews,
    createOrRepairSqlViews,
    SqlViewCheck,
} from '@/data/sources/sqlViewAdmin'
import { useEngine } from '@/hooks/useEngine'
import { useGsiConfig } from '@/hooks/useGsiConfig'
import { interpolate } from '@/utils/interpolate'
import { useApiDataQuery } from '@/utils/useApiDataQuery'

interface LevelsResponse {
    organisationUnitLevels: { level: number; displayName: string }[]
}

/** Two complete strings, never a fragment glued to a number: see CLAUDE.md. */
const createdSummary = (count: number) =>
    count === 1
        ? i18n.t('Created 1 SQL view')
        : interpolate(i18n.t('Created {count} SQL views'), { count })

const repairedSummary = (count: number) =>
    count === 1
        ? i18n.t('Repaired 1 SQL view')
        : interpolate(i18n.t('Repaired {count} SQL views'), { count })

const failedSummary = (count: number) =>
    count === 1
        ? i18n.t('1 SQL view could not be created or repaired')
        : interpolate(
              i18n.t('{count} SQL views could not be created or repaired'),
              { count }
          )

export const Settings = () => {
    const { baseUrl, apiVersion } = useConfig() as {
        baseUrl: string
        apiVersion: number
    }
    const fetcher = useMemo(
        () => createFetcher(baseUrl, apiVersion),
        [baseUrl, apiVersion]
    )
    const cache = useMemo(() => openCache(baseUrl), [baseUrl])
    const { groupSets, reload } = useEngine()
    const {
        config,
        isLoaded: configLoaded,
        setRequiredLevels,
        setCatchAllGroup,
        setIncludeTracker,
    } = useGsiConfig()

    const [checks, setChecks] = useState<SqlViewCheck[] | null>(null)
    // D5: null means "not yet known" (still checking, or the check itself
    // failed) -- only `true` ever shows the create/repair button.
    const [canManage, setCanManage] = useState<boolean | null>(null)
    const [checking, setChecking] = useState(true)
    const [creating, setCreating] = useState(false)
    const [createSummary, setCreateSummary] = useState<string | null>(null)
    const [createError, setCreateError] = useState<string | null>(null)
    const [clearingCache, setClearingCache] = useState(false)

    const refreshStatus = useCallback(async () => {
        setChecking(true)
        const [nextChecks, nextCanManage] = await Promise.all([
            checkSqlViews(fetcher),
            canCreateSqlViews(fetcher),
        ])
        setChecks(nextChecks)
        setCanManage(nextCanManage)
        setChecking(false)
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
        try {
            const result = await createOrRepairSqlViews(fetcher, checks)
            const parts: string[] = []
            if (result.created.length > 0) {
                parts.push(createdSummary(result.created.length))
            }
            if (result.repaired.length > 0) {
                parts.push(repairedSummary(result.repaired.length))
            }
            if (result.failed.length > 0) {
                parts.push(failedSummary(result.failed.length))
            }
            setCreateSummary(parts.length > 0 ? parts.join(' — ') : null)
            await refreshStatus()
        } catch (e) {
            setCreateError(e instanceof Error ? e.message : String(e))
        } finally {
            setCreating(false)
        }
    }

    const handleClearCache = async () => {
        setClearingCache(true)
        try {
            await cache.clear()
            await reload(true)
        } finally {
            setClearingCache(false)
        }
    }

    const { data: levelsData } = useApiDataQuery<LevelsResponse>({
        queryKey: ['organisationUnitLevels'],
        query: {
            resource: 'organisationUnitLevels',
            params: { fields: 'level,displayName', pageSize: 100 },
        },
        staleTime: Infinity,
    })
    const levels = useMemo(
        () =>
            (levelsData?.organisationUnitLevels ?? []).sort(
                (a, b) => a.level - b.level
            ),
        [levelsData]
    )

    const orgUnitSets = groupSets.filter(
        (s) => s.objectType === 'organisationUnit'
    )
    const allUsable = checks !== null && checks.every((c) => c.usable)
    const anyUnusable = checks !== null && checks.some((c) => !c.usable)

    return (
        <div className={styles.page}>
            <div className={styles.section}>
                <h2 className={styles.heading}>{i18n.t('SQL views')}</h2>
                {checking && checks === null ? (
                    <CircularLoader small />
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
                        {createSummary && (
                            <NoticeBox
                                title={i18n.t('SQL view update complete')}
                            >
                                {createSummary}
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
                <h2 className={styles.heading}>
                    {i18n.t('Required organisation unit levels')}
                </h2>
                {orgUnitSets.map((set) => (
                    <div key={set.id} className={styles.row}>
                        <span className={styles.setLabel}>
                            {set.displayName}
                        </span>
                        <div className={styles.field}>
                            <MultiSelectField
                                dense
                                label=""
                                placeholder={i18n.t('Choose required levels')}
                                selected={(
                                    config.requiredLevels[set.id] ?? []
                                ).map(String)}
                                disabled={!configLoaded}
                                onChange={({
                                    selected,
                                }: {
                                    selected: string[]
                                }) => {
                                    void setRequiredLevels(
                                        set.id,
                                        selected
                                            .map(Number)
                                            .sort((a, b) => a - b)
                                    )
                                }}
                            >
                                {levels.map((l) => (
                                    <MultiSelectOption
                                        key={l.level}
                                        value={String(l.level)}
                                        label={l.displayName}
                                    />
                                ))}
                            </MultiSelectField>
                        </div>
                    </div>
                ))}
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
                                    void setCatchAllGroup(set.id, selected)
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
                        void setIncludeTracker(checked)
                    }}
                />
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
