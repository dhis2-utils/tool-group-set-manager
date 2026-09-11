import { useConfig } from '@dhis2/app-runtime'
import i18n from '@dhis2/d2-i18n'
import { Button, NoticeBox } from '@dhis2/ui'
import React, { useEffect, useMemo, useState } from 'react'
import styles from './IntegrityTab.module.css'
import { IntegrityLine } from '@/components/IntegrityLine/IntegrityLine'
import { createFetcher } from '@/data/fetcher'
import { CheckIssue, readDetails } from '@/data/integrity'
import { DashboardEntry, ObjectsResult, ScopeRef } from '@/engine/store'
import { GroupSetMeta } from '@/engine/types'
import { useEngine } from '@/hooks/useEngine'
import { useEngineQuery } from '@/hooks/useEngineQuery'
import { useIntegrity } from '@/hooks/useIntegrity'
import { useScope } from '@/hooks/useScope'
import { interpolate } from '@/utils/interpolate'

interface Props {
    set: GroupSetMeta
    scope: ScopeRef
}

/** Every Status value (types.ts): passed as `filter.statuses` so the
 *  scope-membership check below never excludes an id because of its
 *  status under *this* set -- the DHIS2 check the app is reconciling
 *  against spans every group set of the object type (finding 5), not
 *  just this one, so an id can be perfectly valid here while this set
 *  alone would have called it NotApplicable. */
const ALL_STATUSES = [0, 1, 2, 3, 4]

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

const engineCountLabel = (count: number | null, scopeName: string) =>
    count === null
        ? i18n.t('The engine has not evaluated this rule for this scope yet')
        : count === 1
          ? interpolate(
                i18n.t(
                    'The engine itself -- the source of truth -- counts 1 matching object within {scope}'
                ),
                { scope: scopeName }
            )
          : interpolate(
                i18n.t(
                    'The engine itself -- the source of truth -- counts {count} matching objects within {scope}'
                ),
                { count, scope: scopeName }
            )

/**
 * Spec 4.5/5.2, Task 4: the group set detail page's third tab. Shows each
 * DHIS2 data integrity check relevant to this set's object type, alongside
 * the engine's own reconciliation of the same rule in the user's scope.
 *
 * Finding 5: neither the summary nor the details endpoint takes an org
 * unit or a group set parameter -- both are national and span every group
 * set of the object type. Scoping the details to the user's current scope
 * is therefore this component's own work: `readDetails` is read once per
 * relevant check (the server groups issues by check name), the resulting
 * ids are resolved to engine indexes in one batched `indexesOf` call
 * across every relevant check -- never one call per id, and never one
 * call per check -- and then narrowed to the scope subtree in one batched
 * `objectsFor` call. An id the engine does not know (`indexesOf` gives
 * -1) is neither in scope nor out of it: it is counted and named in its
 * own line, never folded into either bucket.
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

    // The engine's own, independent reconciliation source (spec 4.5's
    // "engine is the source of truth"): this set's own violation counts in
    // this scope, computed entirely from the loaded hierarchy and
    // membership -- never derived from the DHIS2 issue ids above.
    const { data: dashboardEntries } = useEngineQuery<DashboardEntry[]>(
        'dashboard',
        [scope]
    )
    const entry = dashboardEntries?.find((e) => e.set.id === set.id)
    const engineCountFor = (logical: string): number | null => {
        if (!entry) {
            return null
        }
        return logical === 'orgUnitsMissingCompulsory'
            ? entry.summary.missingError + entry.summary.missingWarning
            : entry.summary.conflict
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
                const perCheck = await Promise.all(
                    relevantChecks.map(async (c) => ({
                        name: c.name,
                        issues: await readDetails(fetcher, c.name),
                    }))
                )
                if (cancelled) {
                    return
                }
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
                                        <p className={styles.line}>
                                            {unknownCountLabel(
                                                bucket.unknownCount
                                            )}
                                        </p>
                                    </>
                                )}
                                <p className={styles.line}>
                                    {engineCountLabel(engineCount, rootName)}
                                </p>
                            </div>
                        )}
                        {bucket && bucket.inScope.length > 0 && (
                            <ul className={styles.issues}>
                                {bucket.inScope.map((issue) => (
                                    <li key={issue.id} className={styles.issue}>
                                        {issue.displayName}
                                        {issue.detail && (
                                            <span
                                                className={styles.issueDetail}
                                            >
                                                {issue.detail}
                                            </span>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                )
            })}
        </div>
    )
}

IntegrityTab.displayName = 'IntegrityTab'
