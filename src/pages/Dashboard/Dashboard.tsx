import i18n from '@dhis2/d2-i18n'
import { NoticeBox, SingleSelectField, SingleSelectOption } from '@dhis2/ui'
import React, { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import styles from './Dashboard.module.css'
import { FilterBar, FilterBarField } from '@/components/FilterBar/FilterBar'
import { OrgUnitField } from '@/components/FilterBar/OrgUnitField'
import { GroupSetCard } from '@/components/GroupSetCard/GroupSetCard'
import { RestrictedGroupSetCard } from '@/components/GroupSetCard/RestrictedGroupSetCard'
import { LoadProgress } from '@/components/LoadProgress/LoadProgress'
import { MetadataFreshness } from '@/components/MetadataFreshness/MetadataFreshness'
import { usageApplies } from '@/data/sources/usageSqlView'
import type { DashboardEntry } from '@/engine/store'
import type { ObjectType } from '@/engine/types'
import { OBJECT_TYPES } from '@/engine/types'
import { useEngine } from '@/hooks/useEngine'
import { useScope } from '@/hooks/useScope'
import { useSessionState } from '@/hooks/useSessionState'
import type { UsageStatus } from '@/hooks/useUsage'
import { useUsage } from '@/hooks/useUsage'
import { interpolate } from '@/utils/interpolate'
import { typeLabel } from '@/utils/objectTypeLabels'

const hasIssues = (e: DashboardEntry) =>
    e.summary.conflict + e.summary.missingError + e.summary.missingWarning > 0

/** Spec 5.1 sorts cards by error count. Errors are conflicts and missing
 * memberships the rules call errors; a missing membership that is only a
 * warning breaks ties, so a set with warnings still outranks a clean one. */
const errorCount = (e: DashboardEntry) =>
    e.summary.conflict + e.summary.missingError

/**
 * A set whose dashboard call has not resolved yet (`hasData === false`) has
 * an all-zero summary -- there is nothing to count yet -- so it ties with
 * a genuinely clean set on error count and sorts wherever that tie happens
 * to place it, with only the card's own "Loading…" text (GroupSetCard.tsx)
 * telling the two apart. Carried forward from Plan 1: it belongs in its
 * own group, ahead of every loaded set, rather than interleaved among the
 * clean ones by a coincidental tie.
 */
const byWorstFirst = (a: DashboardEntry, b: DashboardEntry) => {
    if (a.hasData !== b.hasData) {
        return a.hasData ? 1 : -1
    }
    return (
        errorCount(b) - errorCount(a) ||
        b.summary.missingWarning - a.summary.missingWarning
    )
}

type SortKey = 'issues' | 'usage'

// Type guards for the three filter choices kept across page changes (see
// useSessionState): whatever is stored has to be one of the values the
// controls below can actually show, or the default is used instead.
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean'
const isTypeFilter = (v: unknown): v is ObjectType | 'all' =>
    v === 'all' || (OBJECT_TYPES as readonly unknown[]).includes(v)
const isSortKey = (v: unknown): v is SortKey => v === 'issues' || v === 'usage'

// See the matching comment in GroupSetCard.tsx: a single i18n.t(key, {
// count, defaultValue_plural }) call neither pluralises at runtime with
// this i18next version nor gets picked up by this project's i18n extractor
// at all (any second argument makes a call invisible to it). So this is two
// argument-free calls chosen on the count, each a complete string with the
// number in a {count} placeholder rather than glued to a translated word.
const hiddenSetsLabel = (count: number) =>
    count === 1
        ? i18n.t('1 set without issues hidden')
        : interpolate(i18n.t('{count} sets without issues hidden'), {
              count: count.toLocaleString(),
          })

// Spec 8a accepts that the SQL view path shows untranslated organisation
// unit names specifically because the app says which source served it, so
// this line is not decoration: it is the explanation a user needs for names
// that do not match their locale.
const sourceLabel = (
    kind: 'sqlView' | 'metadata',
    nameSource: 'sqlView' | 'metadata' | null
) => {
    if (kind !== 'sqlView') {
        return i18n.t('Data loaded from the metadata API')
    }
    // The §8a remedy in force: the views still serve the hierarchy and the
    // memberships, but `GSI_ORGUNIT_NAMES` is gone, so names come from the
    // metadata API and are resolved against the user's locale. Saying only
    // "from the GSI SQL views" here would be wrong about the one thing the
    // user can see, which is the names themselves.
    return nameSource === 'metadata'
        ? i18n.t(
              'Data loaded from the GSI SQL views, with organisation unit names from the metadata API'
          )
        : i18n.t('Data loaded from the GSI SQL views')
}

// Fix round 2 (Important 1): `useUsage()`'s own doc comment is explicit that
// 'error' (a view that exists but cannot be read) must never be told to the
// user as if it were 'absent' (no view installed) -- Settings and the Usage
// tab already keep those apart, so this field must too, rather than
// collapsing both into one boolean and telling every user mid-load
// ('loading') the most specific of the four stories regardless of which one
// is true. 'loading' and 'ready' get no help text at all: a transient state
// should not explain itself, and a working one needs no explanation.
const usageSortHelpText = (status: UsageStatus) => {
    switch (status) {
        case 'absent':
            return i18n.t('Usage data is not available to you')
        case 'error':
            return i18n.t('Usage data could not be read on this instance')
        default:
            return undefined
    }
}

export const Dashboard = () => {
    const {
        client,
        status,
        error,
        sourceKind,
        nameSource,
        fellBack,
        revision,
        restrictedSets,
    } = useEngine()
    const { rootId, isReady } = useScope()
    const navigate = useNavigate()
    // Manual review 2: these three were plain `useState`, so going into a
    // group set and back put the dashboard back to "Only sets with issues"
    // every time. Kept for the browser session, like the scope.
    const [onlyIssues, setOnlyIssues] = useSessionState(
        'gsi.dashboard.onlyIssues',
        true,
        isBoolean
    )
    const [typeFilter, setTypeFilter] = useSessionState<ObjectType | 'all'>(
        'gsi.dashboard.typeFilter',
        'all',
        isTypeFilter
    )
    const [sortKey, setSortKey] = useSessionState<SortKey>(
        'gsi.dashboard.sortKey',
        'issues',
        isSortKey
    )
    const [entries, setEntries] = useState<
        Partial<Record<ObjectType, DashboardEntry[]>>
    >({})
    const [typeErrors, setTypeErrors] = useState<
        Partial<Record<ObjectType, string>>
    >({})
    const usage = useUsage()
    const usageSortable = usage.status === 'ready'

    // Fix round 2 (Important 1): if usage stops being ready while the usage
    // sort is selected -- the view is removed in Settings mid-session, or a
    // read starts erroring -- `shown.sort` below silently falls back to
    // `byWorstFirst` (it already guards on `usageSortable`), but without
    // this the field itself kept showing "Usage (least used first)" as
    // selected. The field and the actual order must never disagree about
    // which sort is in effect.
    useEffect(() => {
        if (!usageSortable && sortKey === 'usage') {
            setSortKey('issues')
        }
    }, [usageSortable, sortKey, setSortKey])

    /**
     * Least used first, because that is the question this sort answers --
     * which sets nothing references any more (spec 3.5). A set whose type
     * can never be an analytics dimension (indicators) has no usage to
     * compare, so it sorts after every set that does, rather than tying at
     * zero with the genuinely unreferenced ones.
     */
    const byLeastUsed = (a: DashboardEntry, b: DashboardEntry) => {
        const applicable = (e: DashboardEntry) => usageApplies(e.set.objectType)
        // Defensive, not reachable: this component renders one section per
        // ObjectType and never sorts a mixed-type array, so the two sides
        // always agree. Kept so the comparator stays total if a caller ever
        // does sort across types -- and commented so the next reader does
        // not spend the same minutes proving it unreachable.
        if (applicable(a) !== applicable(b)) {
            return applicable(a) ? -1 : 1
        }
        if (!applicable(a)) {
            return 0
        }
        const ua = usage.forSet(a.set.id)
        const ub = usage.forSet(b.set.id)
        return (
            (ua?.favourites ?? 0) - (ub?.favourites ?? 0) ||
            (ua?.views12m ?? 0) - (ub?.views12m ?? 0)
        )
    }

    useEffect(() => {
        if (!client || !isReady) {
            return
        }
        let cancelled = false
        Promise.all(
            OBJECT_TYPES.map((objectType) =>
                client
                    .call<DashboardEntry[]>('dashboard', {
                        objectType,
                        rootId:
                            objectType === 'organisationUnit' ? rootId : null,
                    })
                    .then((result) => ({
                        entries: result,
                        error: null as string | null,
                    }))
                    // A stale or otherwise unrecognised root id makes the
                    // engine throw for the type it applies to (the store
                    // throws when a scope root id isn't among a loaded
                    // type's objects); one bad scope must not blank out
                    // every other type's cards, and the failure must stay
                    // visible rather than silently rendering as "no group
                    // sets of this type".
                    .catch((e: unknown) => ({
                        entries: [] as DashboardEntry[],
                        error: e instanceof Error ? e.message : String(e),
                    }))
            )
        ).then((results) => {
            if (cancelled) {
                return
            }
            const nextEntries: Partial<Record<ObjectType, DashboardEntry[]>> =
                {}
            const nextErrors: Partial<Record<ObjectType, string>> = {}
            OBJECT_TYPES.forEach((type, i) => {
                nextEntries[type] = results[i].entries
                if (results[i].error) {
                    nextErrors[type] = results[i].error as string
                }
            })
            setEntries(nextEntries)
            setTypeErrors(nextErrors)
        })
        return () => {
            cancelled = true
        }
        // `revision` re-reads the summaries after anything changed the
        // engine's data without moving the load phase: a write, or the
        // tracker setting arriving after the load.
    }, [client, rootId, isReady, status?.phase, status?.type, revision])

    const shownTypes = OBJECT_TYPES.filter(
        (type) => typeFilter === 'all' || type === typeFilter
    )

    // The oldest of the loaded types, not the newest: a dashboard built from
    // four snapshots is only as current as its stalest one, and reporting
    // the freshest would overstate the page as a whole.
    const oldestLoadedAt = useMemo(() => {
        const stamps = Object.values(status?.loadedAt ?? {}).filter(
            (n): n is number => typeof n === 'number'
        )
        return stamps.length > 0 ? Math.min(...stamps) : null
    }, [status])

    return (
        <div className={styles.page}>
            <FilterBar status={<MetadataFreshness loadedAt={oldestLoadedAt} />}>
                <OrgUnitField />
                <FilterBarField label={i18n.t('Object type')}>
                    <SingleSelectField
                        dense
                        selected={typeFilter}
                        onChange={({ selected }) =>
                            setTypeFilter(selected as ObjectType | 'all')
                        }
                    >
                        <SingleSelectOption
                            value="all"
                            label={i18n.t('All object types')}
                        />
                        {OBJECT_TYPES.map((type) => (
                            <SingleSelectOption
                                key={type}
                                value={type}
                                label={typeLabel(type)}
                            />
                        ))}
                    </SingleSelectField>
                </FilterBarField>
                <FilterBarField label={i18n.t('Show')}>
                    <SingleSelectField
                        dense
                        selected={onlyIssues ? 'onlyIssues' : 'all'}
                        onChange={({ selected }) =>
                            setOnlyIssues(selected === 'onlyIssues')
                        }
                    >
                        <SingleSelectOption
                            value="onlyIssues"
                            label={i18n.t('Only sets with issues')}
                        />
                        <SingleSelectOption
                            value="all"
                            label={i18n.t('All sets')}
                        />
                    </SingleSelectField>
                </FilterBarField>
                <FilterBarField label={i18n.t('Sort by')}>
                    {/* The option is shown, not hidden, whether or not
                        usage data is available -- so the sort a user will
                        eventually want is visible now. Until a usage view
                        is installed and read (`usageSortable`), it stays
                        disabled with a documented `helpText` explaining
                        why, rather than silently doing nothing. */}
                    <SingleSelectField
                        dense
                        selected={sortKey}
                        onChange={({ selected }) =>
                            setSortKey(selected as SortKey)
                        }
                        helpText={usageSortHelpText(usage.status)}
                        // Manual review 2: unsized, the select was as wide
                        // as its selected label, and with the default
                        // "Issues" selected the menu inherited that width
                        // and wrapped "Usage (least used first)" onto four
                        // lines. Wide enough for the longer option.
                        inputWidth="220px"
                    >
                        <SingleSelectOption
                            value="issues"
                            label={i18n.t('Issues')}
                        />
                        <SingleSelectOption
                            value="usage"
                            label={i18n.t('Usage (least used first)')}
                            disabled={!usageSortable}
                        />
                    </SingleSelectField>
                </FilterBarField>
            </FilterBar>
            {error && (
                <NoticeBox error title={i18n.t('Loading failed')}>
                    {error}
                </NoticeBox>
            )}
            <LoadProgress status={status} />
            {(sourceKind || usage.status === 'ready') && (
                // Manual review 3: these two lines were separate `<p>`s
                // with default margins, each also a child of the page's
                // 16px flex gap -- three gaps' worth of white space for two
                // lines of grey text. One block, margins off, 4px apart.
                <div className={styles.notes}>
                    {sourceKind && (
                        <p className={styles.note}>
                            {sourceLabel(sourceKind, nameSource)}
                        </p>
                    )}
                    {
                        // Fix round 2 (Important 2): spec 3.6 requires every
                        // surface showing a count to carry the caveat, not
                        // just the tab -- otherwise the dashboard's cards
                        // show a favourites count with none at all. One
                        // line here, not one per card: the plan's own
                        // words for this were "the tab is where the full
                        // sentence lives; the card carries the short form",
                        // and this is that short form.
                        usage.status === 'ready' && (
                            <p className={styles.note}>
                                {i18n.t(
                                    'Usage counts are indicative — they cover saved favourites and their recorded views.'
                                )}
                            </p>
                        )
                    }
                </div>
            )}
            {
                // Closes Plan 2's deferred item: the D4 fallback is silent
                // per-load, so a broken SQL view degrades every load with
                // nothing telling the user it can be repaired. Gated on
                // `fellBack`, never on `sourceKind === 'metadata'` alone --
                // that reads identically on a server that never had SQL
                // views at all, which must stay silent.
                fellBack && (
                    <NoticeBox
                        warning
                        title={i18n.t('A GSI SQL view failed to load')}
                    >
                        <p>
                            {i18n.t(
                                'Data is being loaded from the metadata API instead because one of the GSI SQL views could not be read. Performance may be slower until the view is repaired.'
                            )}
                        </p>
                        <Link to="/settings">
                            {i18n.t(
                                'Go to Settings to check or repair the SQL views'
                            )}
                        </Link>
                    </NoticeBox>
                )
            }
            {shownTypes.map((type) => {
                // `entries` only gains a key for a type once its dashboard
                // call has actually settled (see the effect above, which
                // sets every type's key together). Until then, the type has
                // no key at all -- distinct from a type whose call settled
                // with zero group sets, which has a key holding `[]`. The
                // two must not collapse into the same rendering: one means
                // "still loading" (say nothing here; `LoadProgress` above
                // already covers it) and the other means "there is nothing
                // to show", which needs to say so rather than leave a
                // silent gap indistinguishable from a stuck load.
                const hasLoaded = type in entries
                const all = entries[type] ?? []
                const typeError = typeErrors[type]
                // The type itself failed to load: its sets have no data and
                // will not get any in this load, so they are shown as
                // failed, not as still loading.
                const loadError = status?.errors[type]
                const shown = [
                    ...(onlyIssues
                        ? all.filter((e) => hasIssues(e) || !e.hasData)
                        : all),
                ]
                    // Array.prototype.sort is stable, so sets with the same
                    // error count (or, under the usage sort, the same
                    // usage) keep the order the API returned them in.
                    .sort(
                        sortKey === 'usage' && usageSortable
                            ? byLeastUsed
                            : byWorstFirst
                    )
                const hidden = all.length - shown.length
                // Sets the user cannot check (a group is not shared with
                // them). Shown whether or not "Only sets with issues" is on:
                // nothing is known about their issues, and hiding them would
                // let a user believe every set of the type was checked. They
                // have no counts to sort on, so they come last, by name.
                const restricted = restrictedSets
                    .filter((r) => r.objectType === type)
                    .sort((a, b) => a.displayName.localeCompare(b.displayName))
                // Minor 9 (fix round 1): `byWorstFirst` sorts a set with
                // no data yet ahead of every loaded one, but until now
                // nothing on screen said why -- only the card's own
                // "Loading…" text (unchanged from before this batch)
                // distinguished it, with no label for the group as a
                // whole. Split the already-sorted `shown` list at the
                // boundary (not-yet-loaded entries are always first) so a
                // one-line explanation can sit above just that group.
                const notYetLoaded = shown.filter(
                    (e) => !e.hasData && !loadError
                )
                const failed = shown.filter((e) => !e.hasData && loadError)
                const loaded = shown.filter((e) => e.hasData)
                if (!hasLoaded) {
                    return null
                }
                if (all.length === 0 && restricted.length === 0 && !typeError) {
                    return (
                        <section key={type}>
                            <h2 className={styles.heading}>
                                {typeLabel(type)}
                            </h2>
                            <NoticeBox
                                title={i18n.t('No group sets of this type')}
                            >
                                {i18n.t(
                                    'There are no group sets of this type on this instance.'
                                )}
                            </NoticeBox>
                        </section>
                    )
                }
                return (
                    <section key={type}>
                        <h2 className={styles.heading}>{typeLabel(type)}</h2>
                        {typeError && (
                            <NoticeBox
                                error
                                title={i18n.t(
                                    "This type's summary could not be computed"
                                )}
                            >
                                {typeError}
                            </NoticeBox>
                        )}
                        {failed.length > 0 && (
                            <div className={styles.cards}>
                                {failed.map((entry) => (
                                    <GroupSetCard
                                        key={entry.set.id}
                                        entry={entry}
                                        loadError={loadError}
                                        onOpen={() =>
                                            navigate(`/sets/${entry.set.id}`)
                                        }
                                        onOpenUsage={() =>
                                            navigate(`/sets/${entry.set.id}`, {
                                                state: { tab: 'usage' },
                                            })
                                        }
                                    />
                                ))}
                            </div>
                        )}
                        {notYetLoaded.length > 0 && (
                            <>
                                <p className={styles.note}>
                                    {i18n.t(
                                        'Still loading, so these summaries are not ready yet'
                                    )}
                                </p>
                                <div className={styles.cards}>
                                    {notYetLoaded.map((entry) => (
                                        <GroupSetCard
                                            key={entry.set.id}
                                            entry={entry}
                                            onOpen={() =>
                                                navigate(
                                                    `/sets/${entry.set.id}`
                                                )
                                            }
                                            onOpenUsage={() =>
                                                navigate(
                                                    `/sets/${entry.set.id}`,
                                                    { state: { tab: 'usage' } }
                                                )
                                            }
                                        />
                                    ))}
                                </div>
                            </>
                        )}
                        {loaded.length > 0 && (
                            <div className={styles.cards}>
                                {loaded.map((entry) => (
                                    <GroupSetCard
                                        key={entry.set.id}
                                        entry={entry}
                                        onOpen={() =>
                                            navigate(`/sets/${entry.set.id}`)
                                        }
                                        onOpenUsage={() =>
                                            navigate(`/sets/${entry.set.id}`, {
                                                state: { tab: 'usage' },
                                            })
                                        }
                                    />
                                ))}
                            </div>
                        )}
                        {restricted.length > 0 && (
                            <div className={styles.cards}>
                                {restricted.map((set) => (
                                    <RestrictedGroupSetCard
                                        key={set.id}
                                        set={set}
                                    />
                                ))}
                            </div>
                        )}
                        {hidden > 0 && (
                            <p className={styles.note}>
                                {hiddenSetsLabel(hidden)}
                            </p>
                        )}
                    </section>
                )
            })}
        </div>
    )
}
