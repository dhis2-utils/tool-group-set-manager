import i18n from '@dhis2/d2-i18n'
import {
    Button,
    NoticeBox,
    SingleSelectField,
    SingleSelectOption,
} from '@dhis2/ui'
import React, { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import styles from './Dashboard.module.css'
import { FilterBar, FilterBarField } from '@/components/FilterBar/FilterBar'
import { OrgUnitField } from '@/components/FilterBar/OrgUnitField'
import { GroupSetCard } from '@/components/GroupSetCard/GroupSetCard'
import { LoadProgress } from '@/components/LoadProgress/LoadProgress'
import { DashboardEntry } from '@/engine/store'
import { OBJECT_TYPES, ObjectType } from '@/engine/types'
import { useEngine } from '@/hooks/useEngine'
import { useScope } from '@/hooks/useScope'
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
const sourceLabel = (kind: 'sqlView' | 'metadata') =>
    kind === 'sqlView'
        ? i18n.t('Data loaded from the GSI SQL views')
        : i18n.t('Data loaded from the metadata API')

export const Dashboard = () => {
    const { client, status, error, sourceKind, fellBack, reload } = useEngine()
    const { rootId, isReady } = useScope()
    const navigate = useNavigate()
    const [onlyIssues, setOnlyIssues] = useState(true)
    const [typeFilter, setTypeFilter] = useState<ObjectType | 'all'>('all')
    const [entries, setEntries] = useState<
        Partial<Record<ObjectType, DashboardEntry[]>>
    >({})
    const [typeErrors, setTypeErrors] = useState<
        Partial<Record<ObjectType, string>>
    >({})

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
    }, [client, rootId, isReady, status?.phase, status?.type])

    const shownTypes = OBJECT_TYPES.filter(
        (type) => typeFilter === 'all' || type === typeFilter
    )

    return (
        <div className={styles.page}>
            <FilterBar>
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
                    {/* Usage data does not exist until Plan 6 -- the option
                        is shown, not hidden, so the sort a user will
                        eventually want is visible now, but disabled with a
                        documented `helpText` explaining why, rather than
                        silently doing nothing. */}
                    <SingleSelectField
                        dense
                        selected="issues"
                        helpText={i18n.t(
                            'Usage data is not installed on this instance'
                        )}
                    >
                        <SingleSelectOption
                            value="issues"
                            label={i18n.t('Issues')}
                        />
                        <SingleSelectOption
                            value="usage"
                            label={i18n.t('Usage')}
                            disabled
                        />
                    </SingleSelectField>
                </FilterBarField>
                {/* The cache is reused across restarts, so a user who has
                    just fixed data elsewhere needs a way to say "look
                    again" without clearing browser storage. */}
                <FilterBarField label={i18n.t('Data')}>
                    <Button onClick={() => void reload(true)}>
                        {i18n.t('Reload data')}
                    </Button>
                </FilterBarField>
            </FilterBar>
            {error && (
                <NoticeBox error title={i18n.t('Loading failed')}>
                    {error}
                </NoticeBox>
            )}
            <LoadProgress status={status} />
            {sourceKind && (
                <p className={styles.note}>{sourceLabel(sourceKind)}</p>
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
                const shown = (
                    onlyIssues
                        ? all.filter((e) => hasIssues(e) || !e.hasData)
                        : all
                )
                    .slice()
                    // Array.prototype.sort is stable, so sets with the same
                    // error count keep the order the API returned them in.
                    .sort(byWorstFirst)
                const hidden = all.length - shown.length
                // Minor 9 (fix round 1): `byWorstFirst` sorts a set with
                // no data yet ahead of every loaded one, but until now
                // nothing on screen said why -- only the card's own
                // "Loading…" text (unchanged from before this batch)
                // distinguished it, with no label for the group as a
                // whole. Split the already-sorted `shown` list at the
                // boundary (not-yet-loaded entries are always first) so a
                // one-line explanation can sit above just that group.
                const notYetLoaded = shown.filter((e) => !e.hasData)
                const loaded = shown.filter((e) => e.hasData)
                if (!hasLoaded) {
                    return null
                }
                if (all.length === 0 && !typeError) {
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
                                            navigate(
                                                `/sets/${entry.set.id}`,
                                                { state: { tab: 'usage' } }
                                            )
                                        }
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
