import i18n from '@dhis2/d2-i18n'
import {
    Button,
    SingleSelectField,
    SingleSelectOption,
    Tab,
    TabBar,
    Tag,
} from '@dhis2/ui'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useParams } from 'react-router-dom'
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
import { ScopeCrumb, ScopeTrail } from '@/components/ScopeTrail/ScopeTrail'
import { SetPropertiesDialog } from '@/components/SetPropertiesDialog/SetPropertiesDialog'
import { MatrixColumn } from '@/components/SummaryMatrix/SummaryMatrix'
import { ObjectFilter } from '@/engine/queries'
import { ObjectRef, ScopeRef } from '@/engine/store'
import { Status } from '@/engine/types'
import { useEngine } from '@/hooks/useEngine'
import { useEngineQuery } from '@/hooks/useEngineQuery'
import { useIntegrity } from '@/hooks/useIntegrity'
import { useScope } from '@/hooks/useScope'
import { useUserScope } from '@/hooks/useUserScope'
import { groupsLabel } from '@/utils/groupsLabel'
import { interpolate } from '@/utils/interpolate'
import { useApiDataQuery } from '@/utils/useApiDataQuery'

interface LevelsResponse {
    organisationUnitLevels: { level: number; displayName: string }[]
}

type DetailTab = 'overview' | 'objects' | 'usage' | 'integrity'

/** Used only while nothing at all is known about the scope's level yet. */
const DEFAULT_LEVEL = 1

export const GroupSetDetail = () => {
    const { setId = '' } = useParams()
    const location = useLocation()
    const { groupSets, reload, status } = useEngine()
    const { rootId, rootName, rootLevel, setRoot } = useScope()
    const integrity = useIntegrity()
    const { roots } = useUserScope()
    const set = groupSets.find((s) => s.id === setId)
    // Lets a card link straight into this tab, e.g.
    // navigate('/sets/<id>', { state: { tab: 'usage' } }) -- see Task 5/6.
    const initialTab = (location.state as { tab?: DetailTab } | null)?.tab
    const [tab, setTab] = useState<DetailTab>(initialTab ?? 'overview')
    // m6 (Task 4 review round 1): the Tab button is hidden the moment
    // `integrity.available` goes false (a 403 mid-session, most often), but
    // without this the `tab` state itself stayed `'integrity'` -- the body
    // already falls through to ObjectsTab in that case (see the ternary
    // below), so the TabBar was left showing no tab selected over Objects
    // content. Falling the state back to 'overview' keeps the two in sync.
    useEffect(() => {
        if (tab === 'integrity' && !integrity.available) {
            setTab('overview')
        }
    }, [tab, integrity.available])
    const [filter, setFilter] = useState<ObjectFilter>({})
    // The filter a bulk fix was opened for. Spec 5.1: ObjectsTab's own
    // button is the only thing that sets this, so a bulk fix always acts on
    // rows the user can see and has already been shown the count of. The
    // header's old "Fix issues…" shortcut set it to every violation in the
    // set with no way to narrow it, and is gone. `null` means the dialog is
    // closed.
    const [bulkFixFilter, setBulkFixFilter] = useState<ObjectFilter | null>(
        null
    )
    // I4: spec 3.5's "Set properties" action. The dialog itself does the
    // confirm-then-report work; this only decides when it is on screen.
    const [propertiesOpen, setPropertiesOpen] = useState(false)
    // MR §4.3's "way back" from a drill-down: the scopes this page has
    // drilled through, oldest first, each with the row level it was showing
    // when the user left it. Page state rather than scope state, because it
    // is the history of one visit, not part of the selection the rest of the
    // app shares -- and it holds a row level, which `useScope` has no
    // business knowing about.
    const [trail, setTrail] = useState<
        (ScopeCrumb & { level: number | null; rowLevel: number })[]
    >([])
    // A scope change this page did not make -- the organisation unit tree in
    // the bar, or a restored session -- lands the user somewhere the trail
    // does not lead, so the trail is no longer a path back from anywhere.
    // Drilling and jumping both set this ref first, so only outside changes
    // clear it.
    const scopeFromTrailRef = useRef<string | null>(null)
    useEffect(() => {
        if (scopeFromTrailRef.current !== rootId) {
            scopeFromTrailRef.current = null
            setTrail((current) => (current.length === 0 ? current : []))
        }
    }, [rootId])

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
    // same crash the empty-list gate in the bar above guards against, just
    // reached a different way.
    //
    // Correcting this from a `useEffect` alone is one render too late: the
    // render that first sees the new, narrower `levels` also passes the
    // still-stale `rowLevel` straight into `SingleSelectField` in the bar
    // above in that same pass, and `SingleSelectField` throws synchronously
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

    // Pre-composed, already-translated explanation of why the "above the
    // row level" row exists in OverviewTab's matrix -- see SummaryMatrix's
    // own doc comment on `aboveLevelCaption` for why it wants the caller to
    // supply this rather than working it out itself. Every organisation
    // unit group set -- compulsory or not -- evaluates every organisation
    // unit at every level (`populationFor` in `src/engine/population.ts`
    // never restricts an org unit set's population by level), so the row is
    // not specific to compulsory sets: confirmed against the Sierra Leone
    // demo, where the non-compulsory "Area" set still has a non-empty one.
    // What *is* true, and known here (this is the one place that still
    // holds `levels`, now that the row level selector lives in the bar
    // above), is which row level was actually chosen and what it is
    // called -- so that is what the caption names. When the level list
    // hasn't resolved yet, or doesn't contain the current level, there is
    // nothing to name it with; `undefined` lets SummaryMatrix fall back to
    // its own generic default instead.
    //
    // One whole translated sentence with a placeholder filled in
    // afterwards, never a join of separately translated fragments -- see
    // src/utils/interpolate.ts.
    const rowLevelLabel = levels.find(
        (l) => l.level === effectiveRowLevel
    )?.displayName
    const aboveLevelCaption = rowLevelLabel
        ? interpolate(
              i18n.t('Includes organisation units above the {level} level'),
              { level: rowLevelLabel }
          )
        : undefined

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

    // Task 6: a row's own level is always `effectiveRowLevel` -- every row
    // in the matrix sits there by construction (`ObjectRef.level`, on each
    // row's own `row`, is the same value; `effectiveRowLevel` is used here
    // only because it is already in scope, not because rows lack a level
    // of their own). Drilling only makes sense when a
    // level exists below it; `levels` is already sorted ascending and
    // filtered to what lies below the scope, so its first entry past the
    // row's own level is the next one down. When there is none -- the
    // chosen row level is already the deepest the hierarchy offers --
    // `onDrillDown` stays undefined and SummaryMatrix leaves row labels as
    // plain text, the same treatment it already gives a flat object type.
    const nextRowLevel = levels.find((l) => l.level > effectiveRowLevel)?.level
    const onDrillDown =
        set.objectType === 'organisationUnit' && nextRowLevel !== undefined
            ? (row: ObjectRef) => {
                  // Remember where we were before moving, so the trail in
                  // the bar can put the user back on the scope *and* the row
                  // level they left -- returning to a parent scope showing a
                  // different row level than it had would be a second,
                  // unasked-for change.
                  if (rootId !== null) {
                      setTrail((current) => [
                          ...current,
                          {
                              id: rootId,
                              name: rootName || rootId,
                              level: rootLevel,
                              rowLevel: effectiveRowLevel,
                          },
                      ])
                  }
                  scopeFromTrailRef.current = row.id
                  setRoot(row.id, row.displayName ?? row.id, effectiveRowLevel)
                  setRowLevel(nextRowLevel)
              }
            : undefined

    // Jumping to a crumb drops it and everything after it: the trail is the
    // path still ahead of you, so arriving at a scope means you are no
    // longer below it.
    const onJumpToCrumb = (index: number) => {
        const crumb = trail[index]
        if (!crumb) {
            return
        }
        scopeFromTrailRef.current = crumb.id
        setTrail((current) => current.slice(0, index))
        setRoot(crumb.id, crumb.name, crumb.level)
        setRowLevel(crumb.rowLevel)
    }

    return (
        <div className={styles.page}>
            {/* Manual review 2: the scope fields only exist for an
                organisation unit set -- for every other type this bar
                held nothing but the freshness line, in a box of its own
                under a breadcrumb of its own. The freshness line sits in
                the header now (beside the properties button), the
                breadcrumb is gone (the Dashboard tab is one line above
                it), and the bar is rendered only when it has fields. */}
            {set.objectType === 'organisationUnit' && (
                <FilterBar>
                    <ScopeTrail
                        trail={trail}
                        currentName={
                            rootName || i18n.t('All organisation units')
                        }
                        onJump={onJumpToCrumb}
                    />
                    <OrgUnitField />
                    {tab === 'overview' && levels.length > 0 && (
                        <FilterBarField label={i18n.t('Rows')}>
                            <SingleSelectField
                                dense
                                selected={String(effectiveRowLevel)}
                                onChange={({ selected }) =>
                                    setRowLevel(Number(selected))
                                }
                                inputWidth="240px"
                            >
                                {levels.map((l) => (
                                    <SingleSelectOption
                                        key={l.level}
                                        value={String(l.level)}
                                        // One complete string with
                                        // placeholders rather than
                                        // translated fragments joined in
                                        // English word order -- see
                                        // src/utils/interpolate.ts for why
                                        // the call itself takes no second
                                        // argument.
                                        label={interpolate(
                                            i18n.t('{name} (level {level})'),
                                            {
                                                name: l.displayName,
                                                level: l.level,
                                            }
                                        )}
                                    />
                                ))}
                            </SingleSelectField>
                        </FilterBarField>
                    )}
                </FilterBar>
            )}
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
                        <Tag neutral>{groupsLabel(set.groups.length)}</Tag>
                    </div>
                </div>
                <div className={styles.actions}>
                    <MetadataFreshness
                        loadedAt={status?.loadedAt[set.objectType] ?? null}
                    />
                    <Button
                        small
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
                </div>
            </div>
            <LoadProgress status={status} />
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
                <Tab selected={tab === 'usage'} onClick={() => setTab('usage')}>
                    {i18n.t('Usage')}
                </Tab>
                {integrity.available && (
                    <Tab
                        selected={tab === 'integrity'}
                        onClick={() => setTab('integrity')}
                    >
                        {i18n.t('DHIS2 integrity')}
                    </Tab>
                )}
            </TabBar>
            {tab === 'overview' ? (
                <OverviewTab
                    set={set}
                    scope={scope}
                    rowLevel={effectiveRowLevel}
                    aboveLevelCaption={aboveLevelCaption}
                    onCell={onCell}
                    onDrillDown={onDrillDown}
                />
            ) : tab === 'integrity' && integrity.available ? (
                <IntegrityTab set={set} scope={scope} />
            ) : tab === 'usage' ? (
                // Shown for every set, including indicator group sets -- the
                // tab's own body is what explains there is nothing to show
                // there (spec 3.5), so no extra gate is needed here.
                <UsageTab set={set} />
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
            {propertiesOpen && (
                <SetPropertiesDialog
                    set={set}
                    onClose={() => setPropertiesOpen(false)}
                    // Group set metadata is re-read on every load (it is
                    // never cached -- only object and membership payloads
                    // are), so a non-forced reload is enough to bring the
                    // patched `compulsory`/`dataDimension` back, and with
                    // them every count that depends on them.
                    onApplied={() => {
                        void reload(false)
                    }}
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
                    //
                    // M4: this fires on every apply AND every retry while
                    // the dialog is still open, so `set` (and therefore
                    // `set.groups`) can change under the dialog mid-flow.
                    // Harmless today -- the apply step never re-reads the
                    // plan or re-renders the preview -- but a future change
                    // to the apply/preview steps should not assume `set` is
                    // stable for the dialog's lifetime.
                    onApplied={() => {
                        void reload(false)
                    }}
                />
            )}
        </div>
    )
}
