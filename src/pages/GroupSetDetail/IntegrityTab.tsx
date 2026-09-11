import { useConfig } from '@dhis2/app-runtime'
import i18n from '@dhis2/d2-i18n'
import { Button, NoticeBox } from '@dhis2/ui'
import React, { useEffect, useMemo, useState } from 'react'
import styles from './IntegrityTab.module.css'
import { IntegrityLine } from '@/components/IntegrityLine/IntegrityLine'
import { createFetcher } from '@/data/fetcher'
import { CheckIssue, LogicalCheck, readDetails } from '@/data/integrity'
import { DashboardEntry, ObjectsResult, ScopeRef } from '@/engine/store'
import { GroupSetMeta, Status } from '@/engine/types'
import { useEngine } from '@/hooks/useEngine'
import { useEngineQuery } from '@/hooks/useEngineQuery'
import { useIntegrity } from '@/hooks/useIntegrity'
import { useScope } from '@/hooks/useScope'
import { interpolate } from '@/utils/interpolate'

interface Props {
    set: GroupSetMeta
    scope: ScopeRef
}

/** Every `Status` value, derived from the enum rather than hand-typed
 *  (review round 1, m2): a numeric literal array happened to match today,
 *  but silently stopped matching the moment a member was added, with no
 *  compile error and no failing test. Passed as `filter.statuses` so the
 *  scope-membership check below never excludes an id because of its status
 *  under *this* set -- the DHIS2 check the app is reconciling against spans
 *  every group set of the object type (finding 5), not just this one, so an
 *  id can be perfectly valid here while this set alone would have called it
 *  NotApplicable. */
const ALL_STATUSES = Object.values(Status).filter(
    (v): v is number => typeof v === 'number'
)

interface ScopedResult {
    inScope: CheckIssue[]
    unknownCount: number
}

const nationalCountLabel = (scopeName: string) =>
    interpolate(
        i18n.t(
            'DHIS2 counts this nationally, across every group set of this type -- not only within {scope}'
        ),
        { scope: scopeName }
    )

const inScopeCountLabel = (count: number, scopeName: string) =>
    count === 1
        ? interpolate(
              i18n.t(
                  'Of those, 1 object falls within the current scope ({scope})'
              ),
              { scope: scopeName }
          )
        : interpolate(
              i18n.t(
                  'Of those, {count} objects fall within the current scope ({scope})'
              ),
              { count, scope: scopeName }
          )

const unknownCountLabel = (count: number) =>
    count === 1
        ? i18n.t(
              '1 of those objects could not be matched to anything this app has loaded, most often a tracker data element under an aggregate-only configuration'
          )
        : interpolate(
              i18n.t(
                  '{count} of those objects could not be matched to anything this app has loaded, most often tracker data elements under an aggregate-only configuration'
              ),
              { count }
          )

// M1 (review round 1): the previous wording -- "The engine itself -- the
// source of truth -- counts N matching objects within {scope}" -- named
// neither its own population nor this set, while sitting directly under a
// number that spans every group set of the object type (finding 5). A
// reader comparing the two saw only an unqualified claim of authority over
// a number that counts something narrower, which reads as the app having
// lost objects rather than as two different, correctly-labelled
// populations. This wording names the set explicitly and drops the
// authority claim from this specific sentence -- the engine is still the
// source of truth for the app's own numbers elsewhere, but asserting that
// here, next to a number counting a different population, is what made the
// disagreement read as a bug. Holds for every logical check, compulsory or
// exclusive: `engineCountFor` always returns *this set's* count against an
// equally all-group-sets-of-the-type DHIS2 number.
const engineCountLabel = (
    count: number | null,
    scopeName: string,
    setName: string
) =>
    count === null
        ? interpolate(
              i18n.t(
                  'This app has not evaluated the {set} rule for this scope yet'
              ),
              { set: setName }
          )
        : count === 1
          ? interpolate(
                i18n.t(
                    'Within {scope}, this app finds 1 object failing the {set} rule alone'
                ),
                { scope: scopeName, set: setName }
            )
          : interpolate(
                i18n.t(
                    'Within {scope}, this app finds {count} objects failing the {set} rule alone'
                ),
                { count, scope: scopeName, set: setName }
            )

// M2 (review round 1), narrowed after round 2's n1: the brief's
// reconciliation line has to say which figure is more recent when the two
// disagree, but the app cannot actually answer that. A first version tried,
// comparing DHIS2's `finishedTime` against a ref seeded at tab mount as a
// stand-in for "when the engine loaded" -- but `IntegrityTab` is
// conditionally rendered, so that ref re-seeds to `Date.now()` on every tab
// switch back, and a check that ran after the real engine load but before
// the user happened to reopen the tab compared as older, making the
// screen assert -- wrongly, and flipping on navigation alone with no data
// having changed -- that the engine figure "is" the more recent of the two.
// There is no engine-load timestamp anywhere in the app to compare against
// honestly (adding one would be the load-timestamp plumbing ruling P3-R7
// already excludes for the union question, and the same reasoning applies
// here: a sentence that claims less and is always true beats one that
// claims more and is sometimes wrong). So this states only the two facts the
// app actually holds -- when DHIS2 ran the check, and that the app's own
// figure reflects whatever this session has loaded -- without ranking them
// against each other.
const recencyLabel = (time: string) =>
    interpolate(
        i18n.t(
            "DHIS2 last ran this check at {time}; this app's figure above reflects whatever this session has loaded, which may be more or less recent"
        ),
        { time }
    )

/**
 * Spec 4.5/5.2, Task 4: the group set detail page's third tab. Shows each
 * DHIS2 data integrity check relevant to this set's object type, alongside
 * the engine's own reconciliation of the same rule in the user's scope.
 *
 * Finding 5: neither the summary nor the details endpoint takes an org
 * unit or a group set parameter -- both are national and span every group
 * set of the object type. Scoping the details to the user's current scope
 * is therefore this component's own work: `readDetails` is read once for
 * the whole tab, batched across every relevant check in one comma-joined
 * request (review round 1, M3 -- the server already returns a map keyed by
 * check name for exactly this). The resulting ids are resolved to engine
 * indexes in one batched `indexesOf` call across every relevant check --
 * never one call per id, and never one call per check -- and then narrowed
 * to the scope subtree in one batched `objectsFor` call. An id the engine
 * does not know (`indexesOf` gives -1) is neither in scope nor out of it: it
 * is counted and named in its own line, never folded into either bucket.
 *
 * Round 1 ruling (P3-R7): the engine count stays per-set, not unioned across
 * every same-type compulsory/exclusive set to force agreement with DHIS2's
 * number -- that union would be unused everywhere else in the app, is not
 * actionable from this set's page, and would destroy the very information a
 * disagreement carries (see `engineCountLabel`'s comment). The fix for a
 * disagreement is wording, not a new computation.
 */
export const IntegrityTab = ({ set, scope }: Props) => {
    const integrity = useIntegrity()
    const { client } = useEngine()
    const { rootName } = useScope()
    const { baseUrl, apiVersion } = useConfig() as {
        baseUrl: string
        apiVersion: number
    }
    const fetcher = useMemo(
        () => createFetcher(baseUrl, apiVersion),
        [baseUrl, apiVersion]
    )

    const relevantChecks = useMemo(
        () => integrity.checks.filter((c) => c.objectType === set.objectType),
        [integrity.checks, set.objectType]
    )
    const checkNames = useMemo(
        () => relevantChecks.map((c) => c.name),
        [relevantChecks]
    )
    const checkNamesKey = checkNames.join(',')

    // The engine's own, independent reconciliation source: this set's own
    // violation counts in this scope, computed entirely from the loaded
    // hierarchy and membership -- never derived from the DHIS2 issue ids
    // below.
    const { data: dashboardEntries } = useEngineQuery<DashboardEntry[]>(
        'dashboard',
        [scope]
    )
    const entry = dashboardEntries?.find((e) => e.set.id === set.id)
    // Exhaustive over `LogicalCheck` (review round 1, m3): a `switch` with
    // no `default` and a `never` check at the end means a seventh logical
    // check added to the union without a case here is a compile error,
    // rather than silently falling through to `conflict` (correct for
    // today's four exclusive checks, wrong the moment a check is added that
    // is neither compulsory-missing nor exclusive-conflict).
    const engineCountFor = (logical: LogicalCheck): number | null => {
        if (!entry) {
            return null
        }
        switch (logical) {
            case 'orgUnitsMissingCompulsory':
                return entry.summary.missingError + entry.summary.missingWarning
            case 'orgUnitsConflicting':
            case 'dataElementsConflicting':
            case 'indicatorsConflicting':
            case 'categoryOptionsConflicting':
                return entry.summary.conflict
            case 'categoryOptionGroupSetsIncomplete': {
                // No object type (see OBJECT_TYPE_OF in data/integrity.ts),
                // so it never matches `set.objectType` and `relevantChecks`
                // never includes it -- this arm exists only so the switch
                // stays exhaustive.
                return null
            }
            default: {
                const exhaustive: never = logical
                return exhaustive
            }
        }
    }

    const [scoped, setScoped] = useState<Record<string, ScopedResult>>({})
    const [detailsError, setDetailsError] = useState<string | null>(null)

    // Guarding on presence rather than the `client` object's own identity
    // (the same reasoning as `useEngineQuery`'s `hasClient`): a consumer
    // that hands back a structurally-equal-but-freshly-allocated context
    // value on every render would otherwise re-run this effect, whose body
    // calls setState unconditionally, forever.
    const hasClient = client !== null

    useEffect(() => {
        if (relevantChecks.length === 0) {
            setScoped({})
            return
        }
        let cancelled = false
        void (async () => {
            try {
                // One request for the whole tab: the server groups issues by
                // check name and already accepts a comma-joined list, so
                // every relevant check's details are read in a single call
                // rather than one per check (M3).
                const detailsByCheck = await readDetails(fetcher, checkNames)
                if (cancelled) {
                    return
                }
                const perCheck = relevantChecks.map((c) => ({
                    name: c.name,
                    issues: detailsByCheck[c.name] ?? [],
                }))
                const allIds = Array.from(
                    new Set(perCheck.flatMap((p) => p.issues.map((i) => i.id)))
                )
                if (allIds.length === 0) {
                    const empty: Record<string, ScopedResult> = {}
                    perCheck.forEach((p) => {
                        empty[p.name] = { inScope: [], unknownCount: 0 }
                    })
                    setScoped(empty)
                    setDetailsError(null)
                    return
                }
                if (!client) {
                    return
                }
                // One batched call across every relevant check's ids --
                // never one call per id, and never one call per check.
                const indexes = await client.call<number[]>(
                    'indexesOf',
                    set.objectType,
                    allIds
                )
                const knownIds = allIds.filter((_, i) => indexes[i] !== -1)
                const knownSet = new Set(knownIds)
                let inScopeSet = new Set<string>()
                if (knownIds.length > 0) {
                    const result = await client.call<ObjectsResult>(
                        'objectsFor',
                        set.id,
                        scope,
                        { ids: knownIds, statuses: ALL_STATUSES },
                        0,
                        knownIds.length
                    )
                    inScopeSet = new Set(result.items.map((i) => i.id))
                }
                if (cancelled) {
                    return
                }
                const next: Record<string, ScopedResult> = {}
                perCheck.forEach((p) => {
                    next[p.name] = {
                        inScope: p.issues.filter((i) => inScopeSet.has(i.id)),
                        unknownCount: p.issues.filter(
                            (i) => !knownSet.has(i.id)
                        ).length,
                    }
                })
                setScoped(next)
                setDetailsError(null)
            } catch (e) {
                if (!cancelled) {
                    setDetailsError(e instanceof Error ? e.message : String(e))
                }
            }
        })()
        return () => {
            cancelled = true
        }
        // Deliberately keyed on the check *names* (a stable string), not the
        // `relevantChecks`/`checkNames` array identities, which are fresh on
        // every render.
    }, [
        checkNamesKey,
        scope.objectType,
        scope.rootId,
        hasClient,
        fetcher,
        set.id,
        set.objectType,
    ])

    if (!integrity.available) {
        return null
    }

    return (
        <div className={styles.tab}>
            <div className={styles.actions}>
                <Button
                    small
                    disabled={integrity.isRunning || checkNames.length === 0}
                    onClick={() => {
                        // Spec 4.5: run is suggested, never triggered on its
                        // own -- this is the only place `run` is called from
                        // this tab, and it only fires from a click.
                        void integrity.run(checkNames)
                    }}
                >
                    {i18n.t('Run now')}
                </Button>
            </div>
            {integrity.error !== null && (
                <NoticeBox error title={i18n.t('DHIS2 integrity error')}>
                    {i18n.t(
                        'Something went wrong reading the DHIS2 integrity result; try again.'
                    )}
                </NoticeBox>
            )}
            {detailsError !== null && (
                <NoticeBox error title={i18n.t('DHIS2 integrity error')}>
                    {i18n.t(
                        'Something went wrong reading the DHIS2 issue details; try again.'
                    )}
                </NoticeBox>
            )}
            {relevantChecks.length === 0 && (
                <p className={styles.line}>
                    {i18n.t(
                        'No DHIS2 integrity checks apply to this object type.'
                    )}
                </p>
            )}
            {relevantChecks.map((check) => {
                const summary = integrity.summaries[check.name]
                const isStale = integrity.stale.has(check.name)
                const bucket = scoped[check.name]
                const engineCount = engineCountFor(check.logical)
                const disagrees =
                    !!bucket &&
                    engineCount !== null &&
                    engineCount !== bucket.inScope.length
                return (
                    <div key={check.name} className={styles.check}>
                        <h3 className={styles.checkTitle}>
                            {check.displayName}
                        </h3>
                        {summary && (
                            <IntegrityLine
                                check={check}
                                summary={summary}
                                stale={isStale}
                            />
                        )}
                        {isStale && (
                            <p className={styles.line}>
                                {i18n.t(
                                    'A write since the last run may have changed this; run it again to be sure.'
                                )}
                            </p>
                        )}
                        {/* m5 (review round 1): every number below is
                            meaningless before the check's own summary has
                            been read, so the whole reconciliation block --
                            counts and issue list alike -- is gated on
                            `summary`, not just the counts. */}
                        {summary && (
                            <div className={styles.reconciliation}>
                                <p className={styles.line}>
                                    {nationalCountLabel(rootName)}
                                </p>
                                {bucket && (
                                    <>
                                        <p className={styles.line}>
                                            {inScopeCountLabel(
                                                bucket.inScope.length,
                                                rootName
                                            )}
                                        </p>
                                        {/* m1: a healthy check has no
                                            unknown ids -- naming a zero here
                                            is noise that trains the reader
                                            to skip the line that matters
                                            when it is non-zero. */}
                                        {bucket.unknownCount > 0 && (
                                            <p className={styles.line}>
                                                {unknownCountLabel(
                                                    bucket.unknownCount
                                                )}
                                            </p>
                                        )}
                                    </>
                                )}
                                <p className={styles.line}>
                                    {engineCountLabel(
                                        engineCount,
                                        rootName,
                                        set.displayName
                                    )}
                                </p>
                                {disagrees && summary.finishedTime && (
                                    <p className={styles.line}>
                                        {recencyLabel(
                                            new Date(
                                                summary.finishedTime
                                            ).toLocaleString()
                                        )}
                                    </p>
                                )}
                                {bucket && bucket.inScope.length > 0 && (
                                    <ul className={styles.issues}>
                                        {bucket.inScope.map((issue) => (
                                            <li
                                                key={issue.id}
                                                className={styles.issue}
                                            >
                                                {issue.displayName}
                                                {issue.detail && (
                                                    <span
                                                        className={
                                                            styles.issueDetail
                                                        }
                                                    >
                                                        {issue.detail}
                                                    </span>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        )}
                    </div>
                )
            })}
        </div>
    )
}

IntegrityTab.displayName = 'IntegrityTab'
