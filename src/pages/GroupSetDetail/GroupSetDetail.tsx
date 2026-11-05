import i18n from '@dhis2/d2-i18n'
import {
    Button,
    NoticeBox,
    SingleSelectField,
    SingleSelectOption,
    Tab,
    TabBar,
    Tag,
} from '@dhis2/ui'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import styles from './GroupSetDetail.module.css'
import { IntegrityTab } from './IntegrityTab'
import { ObjectsTab } from './ObjectsTab'
import { OverviewTab } from './OverviewTab'
import { UsageTab } from './UsageTab'
import { BulkFixDialog } from '@/components/BulkFixDialog/BulkFixDialog'
import { FilterBar, FilterBarField } from '@/components/FilterBar/FilterBar'
import { OrgUnitField } from '@/components/FilterBar/OrgUnitField'
import { LoadProgress } from '@/components/LoadProgress/LoadProgress'
import { MetadataFreshness } from '@/components/MetadataFreshness/MetadataFreshness'
import type { ScopeCrumb } from '@/components/ScopeTrail/ScopeTrail'
import { ScopeTrail } from '@/components/ScopeTrail/ScopeTrail'
import { SetPropertiesDialog } from '@/components/SetPropertiesDialog/SetPropertiesDialog'
import type { MatrixColumn } from '@/components/SummaryMatrix/SummaryMatrix'
import type { RestrictedGroupSet } from '@/data/groupSets'
import type { ObjectFilter } from '@/engine/queries'
import type { ObjectRef, ScopeRef } from '@/engine/store'
import type { GroupSetMeta } from '@/engine/types'
import { NO_GROUP_STATUSES, Status } from '@/engine/types'
import { useEngine } from '@/hooks/useEngine'
import { useEngineQuery } from '@/hooks/useEngineQuery'
import { useIntegrity } from '@/hooks/useIntegrity'
import { useScope } from '@/hooks/useScope'
import { useUserScope } from '@/hooks/useUserScope'
import { groupsLabel } from '@/utils/groupsLabel'
import { interpolate } from '@/utils/interpolate'
import { restrictedSetLabel } from '@/utils/restrictedSetLabel'
import { useApiDataQuery } from '@/utils/useApiDataQuery'

interface LevelsResponse {
    organisationUnitLevels: { level: number; displayName: string }[]
}

type Level = LevelsResponse['organisationUnitLevels'][number]

type DetailTab = 'overview' | 'objects' | 'usage' | 'integrity'

type Crumb = ScopeCrumb & { level: number | null; rowLevel: number }

/** Used only while nothing at all is known about the scope's level yet. */
const DEFAULT_LEVEL = 1

/**
 * The organisation unit levels below the scope, and the row level the
 * Overview matrix shows.
 *
 * The scope's own level is needed so the list starts *below* it. The
 * selector carries the level with the selection; a scope stored before it
 * did falls back to the user's own roots and then to the engine, which
 * holds the hierarchy. Only that last fallback costs a call.
 */
function useRowLevels() {
    const { rootId, rootLevel } = useScope()
    const { roots } = useUserScope()
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
            // Not `paging: false` (deprecated, and the runtime warns): an
            // instance has a handful of levels, so one page of 100 is all.
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

    // `rowLevel` is seeded once from `scopeLevel`, which can change when the
    // user roots resolve late, and `levels` may then no longer contain it.
    // @dhis2/ui's SingleSelectField throws on a value with no option, during
    // render, before an effect could fix it -- so the value handed to
    // children is derived here, always valid, and the effect only brings the
    // state back in line afterwards.
    const effectiveRowLevel =
        levels.length === 0 || levels.some((l) => l.level === rowLevel)
            ? rowLevel
            : levels[0].level

    useEffect(() => {
        if (effectiveRowLevel !== rowLevel) {
            setRowLevel(effectiveRowLevel)
        }
    }, [effectiveRowLevel, rowLevel])

    return { levels, effectiveRowLevel, setRowLevel }
}

/** The matrix cell a user clicked, as the Objects tab's filter. */
function filterForCell(row: ObjectRef | null, column: MatrixColumn) {
    const next: ObjectFilter = {}
    if (row) {
        next.ancestor = row.index
    }
    if (column.kind === 'group') {
        next.group = column.index
    } else if (column.kind === 'noGroup') {
        next.statuses = NO_GROUP_STATUSES
    } else if (column.kind === 'conflict') {
        next.statuses = [Status.Conflict]
    }
    return next
}

const RowLevelField = ({
    levels,
    rowLevel,
    onChange,
}: {
    levels: Level[]
    rowLevel: number
    onChange: (level: number) => void
}) => (
    <FilterBarField label={i18n.t('Rows')}>
        <SingleSelectField
            dense
            selected={String(rowLevel)}
            onChange={({ selected }) => onChange(Number(selected))}
            inputWidth="240px"
        >
            {levels.map((l) => (
                <SingleSelectOption
                    key={l.level}
                    value={String(l.level)}
                    // One complete string with placeholders, never
                    // fragments joined in English word order.
                    label={interpolate(i18n.t('{name} (level {level})'), {
                        name: l.displayName,
                        level: l.level,
                    })}
                />
            ))}
        </SingleSelectField>
    </FilterBarField>
)

const SetHeader = ({ set }: { set: GroupSetMeta }) => (
    <div className={styles.header}>
        <h1 className={styles.title}>{set.displayName}</h1>
        <div className={styles.badges}>
            {set.compulsory && <Tag positive>{i18n.t('Compulsory')}</Tag>}
            {set.dataDimension && (
                <Tag positive>{i18n.t('Data dimension')}</Tag>
            )}
            <Tag neutral>{groupsLabel(set.groups.length)}</Tag>
        </div>
    </div>
)

const DetailTabBar = ({
    tab,
    onTab,
    integrityAvailable,
}: {
    tab: DetailTab
    onTab: (tab: DetailTab) => void
    integrityAvailable: boolean
}) => (
    <TabBar>
        <Tab selected={tab === 'overview'} onClick={() => onTab('overview')}>
            {i18n.t('Overview')}
        </Tab>
        <Tab selected={tab === 'objects'} onClick={() => onTab('objects')}>
            {i18n.t('Objects')}
        </Tab>
        <Tab selected={tab === 'usage'} onClick={() => onTab('usage')}>
            {i18n.t('Usage')}
        </Tab>
        {integrityAvailable && (
            <Tab
                selected={tab === 'integrity'}
                onClick={() => onTab('integrity')}
            >
                {i18n.t('DHIS2 integrity')}
            </Tab>
        )}
    </TabBar>
)

/**
 * M10: a deep link to a set that is not (yet) there. While the first load
 * runs this is the load's own progress; once it has finished and the set is
 * still absent, the set was deleted or is not shared with this user, and
 * the page says so with a way back, instead of "not loaded yet" forever.
 */
const SetNotFound = () => {
    const { status, groupSetsLoaded, error } = useEngine()
    if (!groupSetsLoaded && error === null) {
        return (
            <div className={styles.page}>
                <LoadProgress status={status} />
            </div>
        )
    }
    return (
        <div className={styles.page}>
            <LoadProgress status={status} />
            <NoticeBox title={i18n.t('Group set not found')}>
                <p>
                    {i18n.t(
                        'This group set does not exist, or you cannot see it.'
                    )}
                </p>
                <Link to="/">{i18n.t('Back to the dashboard')}</Link>
            </NoticeBox>
        </div>
    )
}

/**
 * The way back from a drill-down: the scopes this page drilled through,
 * oldest first, each with the row level it was left at. Page state, not
 * scope state: it is the history of one visit.
 */
function useScopeTrail({
    rowLevel,
    setRowLevel,
    setFilter,
}: {
    rowLevel: number
    setRowLevel: (level: number) => void
    setFilter: React.Dispatch<React.SetStateAction<ObjectFilter>>
}) {
    const { rootId, rootName, rootLevel, setRoot } = useScope()
    const [trail, setTrail] = useState<Crumb[]>([])
    // Drilling and jumping set this ref first, so only a scope change this
    // page did not make (the organisation unit tree, a restored session)
    // clears the trail -- it no longer leads back from there.
    const scopeFromTrailRef = useRef<string | null>(null)
    useEffect(() => {
        if (scopeFromTrailRef.current !== rootId) {
            scopeFromTrailRef.current = null
            setTrail((current) => (current.length === 0 ? current : []))
        }
        // Any scope change, drill-down included, makes an area (ancestor)
        // filter from the old scope stale: it would carry a unit from
        // outside, or above, the new scope into the Objects tab.
        setFilter((current) => {
            if (current.ancestor === undefined) {
                return current
            }
            const next = { ...current }
            delete next.ancestor
            return next
        })
    }, [rootId, setFilter])

    /** Remember the scope and row level being left, then move to the row. */
    const drillTo = (row: ObjectRef, nextRowLevel: number) => {
        if (rootId !== null) {
            setTrail((current) => [
                ...current,
                {
                    id: rootId,
                    name: rootName || rootId,
                    level: rootLevel,
                    rowLevel,
                },
            ])
        }
        scopeFromTrailRef.current = row.id
        setRoot(row.id, row.displayName ?? row.id, rowLevel)
        setRowLevel(nextRowLevel)
    }

    /** Jumping to a crumb drops it and everything after it. */
    const jumpTo = (index: number) => {
        const crumb = trail[index]
        if (!crumb) {
            return
        }
        scopeFromTrailRef.current = crumb.id
        setTrail((current) => current.slice(0, index))
        setRoot(crumb.id, crumb.name, crumb.level)
        setRowLevel(crumb.rowLevel)
    }

    return { trail, drillTo, jumpTo }
}

const TabBody = ({
    tab,
    set,
    scope,
    overview,
    objects,
}: {
    tab: DetailTab
    set: GroupSetMeta
    scope: ScopeRef
    overview: {
        rowLevel: number
        levels: Level[]
        onCell: (row: ObjectRef | null, column: MatrixColumn) => void
        onDrillDown: ((row: ObjectRef) => void) | undefined
    }
    objects: {
        filter: ObjectFilter
        onFilter: (filter: ObjectFilter) => void
        onBulkFix: () => void
    }
}) => {
    switch (tab) {
        case 'overview': {
            // Why the "above the row level" row exists, naming the chosen
            // level when it is known; SummaryMatrix has a generic default
            // otherwise. One whole translated sentence with a placeholder.
            const rowLevelLabel = overview.levels.find(
                (l) => l.level === overview.rowLevel
            )?.displayName
            return (
                <OverviewTab
                    set={set}
                    scope={scope}
                    rowLevel={overview.rowLevel}
                    aboveLevelCaption={
                        rowLevelLabel
                            ? interpolate(
                                  i18n.t(
                                      'Includes organisation units above the {level} level'
                                  ),
                                  { level: rowLevelLabel }
                              )
                            : undefined
                    }
                    onCell={overview.onCell}
                    onDrillDown={overview.onDrillDown}
                />
            )
        }
        case 'integrity':
            return <IntegrityTab set={set} scope={scope} />
        case 'usage':
            // Shown for every set; the tab's own body explains when there is
            // nothing to show.
            return <UsageTab set={set} />
        default:
            return (
                <ObjectsTab
                    set={set}
                    scope={scope}
                    filter={objects.filter}
                    onFilter={objects.onFilter}
                    levels={overview.levels}
                    onBulkFix={objects.onBulkFix}
                />
            )
    }
}

const GroupSetPage = ({ set }: { set: GroupSetMeta }) => {
    const location = useLocation()
    const { reload, status } = useEngine()
    const { rootId, rootName } = useScope()
    const integrity = useIntegrity()
    // Lets a card link straight into this tab, e.g.
    // navigate('/sets/<id>', { state: { tab: 'usage' } }).
    const initialTab = (location.state as { tab?: DetailTab } | null)?.tab
    const [tab, setTab] = useState<DetailTab>(initialTab ?? 'overview')
    // m6: the integrity Tab disappears when `integrity.available` goes
    // false (a 403 mid-session, most often); the selected tab must follow,
    // or the TabBar shows nothing selected over the Objects content.
    useEffect(() => {
        if (tab === 'integrity' && !integrity.available) {
            setTab('overview')
        }
    }, [tab, integrity.available])
    const [filter, setFilter] = useState<ObjectFilter>({})
    // The filter a bulk fix was opened for; only ObjectsTab's own button
    // sets it, so a bulk fix acts on rows the user can see. `null` = closed.
    const [bulkFixFilter, setBulkFixFilter] = useState<ObjectFilter | null>(
        null
    )
    const [propertiesOpen, setPropertiesOpen] = useState(false)
    const { levels, effectiveRowLevel, setRowLevel } = useRowLevels()
    const { trail, drillTo, jumpTo } = useScopeTrail({
        rowLevel: effectiveRowLevel,
        setRowLevel,
        setFilter,
    })

    const isOrgUnitSet = set.objectType === 'organisationUnit'
    const scope: ScopeRef = {
        objectType: set.objectType,
        rootId: isOrgUnitSet ? rootId : null,
    }

    // Drilling moves the scope to the row and the row level to the next
    // level that exists; on the deepest level there is nowhere to go, and
    // SummaryMatrix leaves row labels as plain text.
    const nextRowLevel = levels.find((l) => l.level > effectiveRowLevel)?.level
    const onDrillDown =
        isOrgUnitSet && nextRowLevel !== undefined
            ? (row: ObjectRef) => drillTo(row, nextRowLevel)
            : undefined

    // A non-forced reload is enough after a write or a property change:
    // group set metadata is never cached, only object and membership
    // payloads are.
    const onApplied = () => {
        void reload(false)
    }

    return (
        <div className={styles.page}>
            <FilterBar
                status={
                    <MetadataFreshness
                        loadedAt={status?.loadedAt[set.objectType] ?? null}
                    />
                }
            >
                {isOrgUnitSet && (
                    <ScopeTrail
                        trail={trail}
                        currentName={
                            rootName || i18n.t('All organisation units')
                        }
                        onJump={jumpTo}
                    />
                )}
                {isOrgUnitSet && <OrgUnitField />}
                {isOrgUnitSet && tab === 'overview' && levels.length > 0 && (
                    <RowLevelField
                        levels={levels}
                        rowLevel={effectiveRowLevel}
                        onChange={setRowLevel}
                    />
                )}
                <FilterBarField label={i18n.t('Group set')}>
                    <Button
                        disabled={!set.canWrite}
                        title={
                            set.canWrite
                                ? undefined
                                : i18n.t(
                                      'You do not have permission to change this group set'
                                  )
                        }
                        onClick={() => setPropertiesOpen(true)}
                    >
                        {i18n.t('Group set properties…')}
                    </Button>
                </FilterBarField>
            </FilterBar>
            <SetHeader set={set} />
            <LoadProgress status={status} />
            <DetailTabBar
                tab={tab}
                onTab={setTab}
                integrityAvailable={integrity.available}
            />
            <TabBody
                tab={
                    integrity.available || tab !== 'integrity' ? tab : 'objects'
                }
                set={set}
                scope={scope}
                overview={{
                    rowLevel: effectiveRowLevel,
                    levels,
                    onCell: (row, column) => {
                        setFilter(filterForCell(row, column))
                        setTab('objects')
                    },
                    onDrillDown,
                }}
                objects={{
                    filter,
                    onFilter: setFilter,
                    onBulkFix: () => setBulkFixFilter(filter),
                }}
            />
            {propertiesOpen && (
                <SetPropertiesDialog
                    set={set}
                    onClose={() => setPropertiesOpen(false)}
                    onApplied={onApplied}
                />
            )}
            {bulkFixFilter !== null && (
                <BulkFixDialog
                    set={set}
                    scope={scope}
                    filter={bulkFixFilter}
                    onClose={() => setBulkFixFilter(null)}
                    // D4: applying or retrying never closes the dialog; only
                    // its own Close does. `set` can therefore change under
                    // the open dialog after each apply.
                    onApplied={onApplied}
                />
            )}
        </div>
    )
}

/**
 * A deep link to a set the user can see but not check, because some of its
 * groups are not shared with them: say why, rather than "not found".
 */
const SetRestricted = ({ set }: { set: RestrictedGroupSet }) => (
    <div className={styles.page}>
        <NoticeBox warning title={set.displayName}>
            <p>{restrictedSetLabel(set.hiddenGroups, set.totalGroups)}</p>
            <Link to="/">{i18n.t('Back to the dashboard')}</Link>
        </NoticeBox>
    </div>
)

export const GroupSetDetail = () => {
    const { setId = '' } = useParams()
    const { groupSets, restrictedSets } = useEngine()
    const set = groupSets.find((s) => s.id === setId)
    if (set) {
        // Keyed by id, so moving from one set to another starts afresh
        // rather than carrying one set's filter or tab into the next.
        return <GroupSetPage key={set.id} set={set} />
    }
    const restricted = restrictedSets.find((s) => s.id === setId)
    return restricted ? <SetRestricted set={restricted} /> : <SetNotFound />
}
