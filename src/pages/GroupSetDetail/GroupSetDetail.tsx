import i18n from '@dhis2/d2-i18n'
import { Button, Tab, TabBar, Tag } from '@dhis2/ui'
import React, { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import styles from './GroupSetDetail.module.css'
import { ObjectsTab } from './ObjectsTab'
import { OverviewTab } from './OverviewTab'
import { BulkFixDialog } from '@/components/BulkFixDialog/BulkFixDialog'
import { MatrixColumn } from '@/components/SummaryMatrix/SummaryMatrix'
import { ObjectFilter } from '@/engine/queries'
import { ObjectRef, ScopeRef } from '@/engine/store'
import { Status } from '@/engine/types'
import { useEngine } from '@/hooks/useEngine'
import { useEngineQuery } from '@/hooks/useEngineQuery'
import { useScope } from '@/hooks/useScope'
import { useUserScope } from '@/hooks/useUserScope'
import { interpolate } from '@/utils/interpolate'
import { useApiDataQuery } from '@/utils/useApiDataQuery'

interface LevelsResponse {
    organisationUnitLevels: { level: number; displayName: string }[]
}

type DetailTab = 'overview' | 'objects'

/** Used only while nothing at all is known about the scope's level yet. */
const DEFAULT_LEVEL = 1

/**
 * Spec 5.3: the header's "Fix issues…" is the card/header shortcut that
 * "preselects all violations of one rule" -- opening it unfiltered would
 * hand the bulk fix dialog every correctly categorised object too (see
 * task-7-fix1.md's Critical finding).
 */
const VIOLATION_STATUSES = [
    Status.MissingError,
    Status.MissingWarning,
    Status.Conflict,
]

export const GroupSetDetail = () => {
    const { setId = '' } = useParams()
    const { groupSets, reload } = useEngine()
    const { rootId, rootName, rootLevel } = useScope()
    const { roots } = useUserScope()
    const set = groupSets.find((s) => s.id === setId)
    const [tab, setTab] = useState<DetailTab>('overview')
    const [filter, setFilter] = useState<ObjectFilter>({})
    // The filter a bulk fix was opened for -- the header's own "Fix
    // issues…" button opens it unfiltered (every object in the set), and
    // ObjectsTab's button opens it against whatever the Objects tab is
    // currently filtered to. `null` means the dialog is closed.
    const [bulkFixFilter, setBulkFixFilter] = useState<ObjectFilter | null>(
        null
    )

    // The scope's own level, needed so the row level list starts *below* the
    // scope and the matrix cannot key rows on org units outside it. The
    // selector carries the level with the selection; a scope stored before it
    // did, or restored some other way, falls back to the user's own roots and
    // then to the engine, which holds the hierarchy. Only that last fallback
    // costs a call, and only in the case where the first two know nothing.
    const rootLevelFromUserRoots =
        roots.find((r) => r.id === rootId)?.level ?? null
    const needsEngineLevel =
        rootId !== null && rootLevel === null && rootLevelFromUserRoots === null
    const { data: engineLevel } = useEngineQuery<number | null>(
        'levelOf',
        ['organisationUnit', rootId],
        needsEngineLevel
    )
    const scopeLevel =
        rootLevel ?? rootLevelFromUserRoots ?? engineLevel ?? DEFAULT_LEVEL
    const [rowLevel, setRowLevel] = useState(scopeLevel + 1)
    const { data: levelsData } = useApiDataQuery<LevelsResponse>({
        queryKey: ['organisationUnitLevels'],
        query: {
            resource: 'organisationUnitLevels',
            // `paging: false` triggers the app runtime's "paging=false is
            // deprecated" warning (and DHIS2 itself discourages it -- it
            // forces the server to return every matching row in one
            // response). An instance has at most a handful of levels, so an
            // explicit page size comfortably above any real hierarchy gets
            // the full list back in one page without ever disabling paging.
            params: { fields: 'level,displayName', pageSize: 100 },
        },
        staleTime: Infinity,
    })
    const levels = useMemo(
        () =>
            (levelsData?.organisationUnitLevels ?? [])
                .filter((l) => l.level > scopeLevel)
                .sort((a, b) => a.level - b.level),
        [levelsData, scopeLevel]
    )

    // `rowLevel` is seeded once, at mount, from `scopeLevel` -- which itself
    // depends on the asynchronously-resolved user roots. A deep link opened
    // before roots resolve seeds it from the fallback scope level (1), and
    // when the real roots arrive with a deeper root, `levels` is recomputed
    // against the new `scopeLevel` and may no longer contain the seeded
    // value at all. Left uncorrected, `rowLevel` would then point at a
    // level `SingleSelectField` has no matching option for, which
    // `@dhis2/ui` treats as a hard render error rather than a no-op -- the
    // same crash the empty-list gate in OverviewTab guards against, just
    // reached a different way.
    //
    // Correcting this from a `useEffect` alone is one render too late: the
    // render that first sees the new, narrower `levels` also passes the
    // still-stale `rowLevel` straight into `OverviewTab`/`SingleSelectField`
    // in that same pass, and `SingleSelectField` throws synchronously
    // during that render -- before any effect from this render has had a
    // chance to run and fix `rowLevel` up. So the value actually handed to
    // children is a synchronously-derived, always-valid one computed right
    // here during render; the effect below only exists to bring the
    // underlying `rowLevel` state itself back in sync afterwards (so a
    // later, organic level list change starts from a consistent value
    // rather than compounding drift).
    const effectiveRowLevel =
        levels.length === 0 || levels.some((l) => l.level === rowLevel)
            ? rowLevel
            : levels[0].level

    useEffect(() => {
        if (effectiveRowLevel !== rowLevel) {
            setRowLevel(effectiveRowLevel)
        }
    }, [effectiveRowLevel, rowLevel])

    if (!set) {
        return <p>{i18n.t('Group set not found or not loaded yet.')}</p>
    }
    const scope: ScopeRef = {
        objectType: set.objectType,
        rootId: set.objectType === 'organisationUnit' ? rootId : null,
    }

    const onCell = (row: ObjectRef | null, column: MatrixColumn) => {
        const next: ObjectFilter = {}
        if (row) {
            next.ancestor = row.index
        }
        if (column.kind === 'group') {
            next.group = column.index
        } else if (column.kind === 'missing') {
            next.statuses = [Status.MissingError, Status.MissingWarning]
        } else if (column.kind === 'unassigned') {
            // "In no group, and that is allowed here": the engine records
            // those as Status.Ok with no group, so both halves are needed --
            // status alone would also list every object that *is* in a
            // group, and group alone would also list the missing ones on a
            // set where being in no group is an error.
            next.group = -1
            next.statuses = [Status.Ok]
        } else if (column.kind === 'conflict') {
            next.statuses = [Status.Conflict]
        }
        setFilter(next)
        setTab('objects')
    }

    return (
        <div className={styles.page}>
            <Link to="/">{i18n.t('Dashboard')}</Link>
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>{set.displayName}</h1>
                    <div className={styles.badges}>
                        {set.compulsory && (
                            <Tag positive>{i18n.t('Compulsory')}</Tag>
                        )}
                        {set.dataDimension && (
                            <Tag positive>{i18n.t('Data dimension')}</Tag>
                        )}
                        <Tag neutral>
                            {set.groups.map((g) => g.displayName).join(' · ')}
                        </Tag>
                        {set.objectType === 'organisationUnit' && (
                            <Tag neutral>
                                {interpolate(i18n.t('Scope ({name})'), {
                                    name: rootName,
                                })}
                            </Tag>
                        )}
                    </div>
                </div>
                <div className={styles.actions}>
                    <Button small disabled title={i18n.t('Not available yet')}>
                        {i18n.t('Set properties…')}
                    </Button>
                    <Button
                        small
                        onClick={() =>
                            setBulkFixFilter({ statuses: VIOLATION_STATUSES })
                        }
                    >
                        {i18n.t('Fix issues…')}
                    </Button>
                </div>
            </div>
            <TabBar>
                <Tab
                    selected={tab === 'overview'}
                    onClick={() => setTab('overview')}
                >
                    {i18n.t('Overview')}
                </Tab>
                <Tab
                    selected={tab === 'objects'}
                    onClick={() => setTab('objects')}
                >
                    {i18n.t('Objects')}
                </Tab>
            </TabBar>
            {tab === 'overview' ? (
                <OverviewTab
                    set={set}
                    scope={scope}
                    rowLevel={effectiveRowLevel}
                    levels={levels}
                    onRowLevel={setRowLevel}
                    onCell={onCell}
                />
            ) : (
                <ObjectsTab
                    set={set}
                    scope={scope}
                    filter={filter}
                    onFilter={setFilter}
                    levels={levels}
                    onBulkFix={() => setBulkFixFilter(filter)}
                />
            )}
            {bulkFixFilter !== null && (
                <BulkFixDialog
                    set={set}
                    scope={scope}
                    filter={bulkFixFilter}
                    onClose={() => setBulkFixFilter(null)}
                    // D4: applying (or retrying) must not dismiss the
                    // dialog -- only the dialog's own Close button, called
                    // through `onClose`, does that. This handler's job is
                    // D5's refresh: `set.groups` is a prop that comes from
                    // this engine snapshot, so a non-forced reload is what
                    // picks up a group the dialog created or a membership
                    // change the write already applied locally.
                    onApplied={() => {
                        void reload(false)
                    }}
                />
            )}
        </div>
    )
}
