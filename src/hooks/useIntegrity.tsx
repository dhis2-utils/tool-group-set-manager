import { useConfig } from '@dhis2/app-runtime'
import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react'
import { createFetcher } from '@/data/fetcher'
import {
    CheckSummary,
    readSummaries,
    resolveChecks,
    ResolvedCheck,
    startRun,
} from '@/data/integrity'
import { ObjectType } from '@/engine/types'
import { useApiDataQuery } from '@/utils/useApiDataQuery'

export interface IntegrityState {
    /** false when the user lacks the authority, or the server refused */
    available: boolean
    checks: ResolvedCheck[]
    summaries: Record<string, CheckSummary>
    /** names whose result predates a write this session */
    stale: Set<string>
    isRunning: boolean
    error: string | null
    run: (names: string[]) => Promise<void>
    markStale: (objectType: ObjectType) => void
    refresh: () => Promise<void>
}

const IntegrityContext = createContext<IntegrityState | null>(null)

// Finding 6: the overlay is gated on ALL or F_PERFORM_MAINTENANCE. A user
// with neither must never cause a single dataIntegrity request.
const REQUIRED_AUTHORITIES = ['ALL', 'F_PERFORM_MAINTENANCE']

interface Me {
    authorities: string[]
}

// run()'s poll backoff (C1): starts at POLL_INITIAL_INTERVAL_MS, grows by
// POLL_BACKOFF_FACTOR each attempt up to POLL_MAX_INTERVAL_MS, and gives up
// after POLL_MAX_ATTEMPTS reads rather than polling forever -- a DHIS2
// DATA_INTEGRITY job that failed or was dropped server-side leaves the
// cached summary's finishedTime untouched, which must end the loop, not
// spin it. Summing the schedule, the twelve attempts wait about 30 seconds
// in total before giving up -- generous against finding 2's "well under a
// second" measurement, and short enough that a user who gets the give-up
// message has not sat through a stalled run for long. Spec 4.5 warns these
// checks can take a minute on a large instance, which is fine: giving up
// stops the polling, not the run, and the message says the result may
// still arrive. Re-sum the schedule if any of these four values change.
const POLL_INITIAL_INTERVAL_MS = 300
const POLL_BACKOFF_FACTOR = 1.5
const POLL_MAX_INTERVAL_MS = 5000
const POLL_MAX_ATTEMPTS = 12

const EMPTY_SUMMARIES: Record<string, CheckSummary> = {}

/**
 * A 403 from any of the three integrity calls (the authority check itself,
 * resolving the checks, or reading/starting a run) is not a failure the
 * user needs to read about -- finding 6 says it is the same as the
 * authority being absent, so it permanently disables the overlay for the
 * rest of the session and never surfaces as `error`.
 */
function isForbidden(e: unknown): boolean {
    return e instanceof Error && /\bHTTP 403\b/.test(e.message)
}

export const IntegrityProvider = ({
    children,
}: {
    children: React.ReactNode
}) => {
    const { baseUrl, apiVersion } = useConfig() as {
        baseUrl: string
        apiVersion: number
    }
    const fetcher = useMemo(
        () => createFetcher(baseUrl, apiVersion),
        [baseUrl, apiVersion]
    )

    const {
        data: me,
        isError: meIsError,
        isSuccess: meIsSuccess,
    } = useApiDataQuery<Me>({
        queryKey: ['me', 'authorities'],
        query: { resource: 'me', params: { fields: 'id,authorities' } },
        staleTime: Infinity,
        // m4: an unauthorised user's 403 on this probe would otherwise be
        // retried once by the app-wide default (App.tsx sets retry: 1) --
        // a wasted second request for a user who is never going to pass.
        retry: false,
    })

    const [available, setAvailable] = useState(false)
    const [checks, setChecks] = useState<ResolvedCheck[]>([])
    const [summaries, setSummaries] =
        useState<Record<string, CheckSummary>>(EMPTY_SUMMARIES)
    const [stale, setStale] = useState<Set<string>>(new Set())
    const [isRunning, setIsRunning] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const checksRef = useRef<ResolvedCheck[]>([])
    // m4 (final review): `run` used to close over `summaries` state
    // directly (to snapshot `before`), so its own identity -- and with it
    // the whole `IntegrityState` memo -- changed on every poll iteration,
    // since each one calls `applySummaries`. Harmless while no consumer
    // puts `run` in an effect's dependency list, but reading through a ref
    // instead removes the hazard rather than relying on that.
    const summariesRef = useRef<Record<string, CheckSummary>>(EMPTY_SUMMARIES)

    // Once flipped, no further integrity request is ever made again this
    // session -- checked before every fetch, not just in the initial gate.
    const disabledRef = useRef(false)
    // M1: flipped once on unmount and never reset. Checked before every
    // request `run()`'s poll loop makes and before every state update it
    // performs, so an unmount mid-poll stops both the requests and any
    // attempt to setState on the now-unmounted provider.
    const unmountedRef = useRef(false)
    useEffect(() => {
        return () => {
            unmountedRef.current = true
        }
    }, [])
    // M2: guards against a second run() call while one is already polling.
    const runInFlightRef = useRef(false)

    const disable = useCallback(() => {
        disabledRef.current = true
        setAvailable(false)
        setError(null)
    }, [])

    const applySummaries = useCallback((rows: CheckSummary[]) => {
        setSummaries((prev) => {
            const next = { ...prev }
            rows.forEach((r) => {
                next[r.name] = r
            })
            return next
        })
    }, [])

    const loadSummaries = useCallback(
        async (resolved: ResolvedCheck[]) => {
            if (disabledRef.current || resolved.length === 0) {
                return
            }
            try {
                const rows = await readSummaries(
                    fetcher,
                    resolved.map((c) => c.name)
                )
                if (disabledRef.current || unmountedRef.current) {
                    return
                }
                applySummaries(rows)
                // m2: a later success must not leave an earlier transient
                // failure's message stuck on screen.
                setError(null)
            } catch (e) {
                if (unmountedRef.current) {
                    return
                }
                if (isForbidden(e)) {
                    disable()
                } else {
                    setError(e instanceof Error ? e.message : String(e))
                }
            }
        },
        [fetcher, disable, applySummaries]
    )

    // Resolves the checks and their summaries exactly once, and only once
    // the authority check has come back positive -- never before, and
    // never at all when it comes back negative or errors.
    useEffect(() => {
        if (disabledRef.current) {
            return
        }
        if (meIsError) {
            disable()
            return
        }
        if (!meIsSuccess || !me) {
            return
        }
        const authorized = me.authorities.some((a) =>
            REQUIRED_AUTHORITIES.includes(a)
        )
        if (!authorized) {
            disable()
            return
        }
        let cancelled = false
        void (async () => {
            try {
                const resolved = await resolveChecks(fetcher)
                if (cancelled || disabledRef.current || unmountedRef.current) {
                    return
                }
                checksRef.current = resolved
                setChecks(resolved)
                // m1: a server with none of the six checks must not present
                // as an overlay with nothing in it -- available only
                // becomes true once there is at least one resolved check.
                setAvailable(resolved.length > 0)
                await loadSummaries(resolved)
            } catch (e) {
                if (cancelled || unmountedRef.current) {
                    return
                }
                if (isForbidden(e)) {
                    disable()
                } else {
                    setError(e instanceof Error ? e.message : String(e))
                }
            }
        })()
        return () => {
            cancelled = true
        }
        // Deliberately keyed only on the inputs that can legitimately
        // change this decision (the identity of `me` and the fetcher);
        // `loadSummaries`/`disable` are stable callbacks.
    }, [me, meIsError, meIsSuccess, fetcher, disable, loadSummaries])

    useEffect(() => {
        checksRef.current = checks
    }, [checks])

    useEffect(() => {
        summariesRef.current = summaries
    }, [summaries])

    const refresh = useCallback(async () => {
        if (disabledRef.current) {
            return
        }
        await loadSummaries(checksRef.current)
    }, [loadSummaries])

    const run = useCallback(
        async (names: string[]) => {
            if (
                disabledRef.current ||
                names.length === 0 ||
                runInFlightRef.current
            ) {
                // M2: an overlapping call is a no-op -- it neither starts
                // its own run nor touches isRunning/stale, both owned by
                // whichever call is already in flight.
                return
            }
            runInFlightRef.current = true
            setIsRunning(true)
            setError(null)
            try {
                const before = new Map(
                    names.map((n) => [
                        n,
                        summariesRef.current[n]?.finishedTime ?? null,
                    ])
                )
                // C1 (final review): a SUMMARY run alone never populates the
                // *details* cache -- `readDetails` (the integrity tab's
                // in-scope count, unknown-id count and issue list) reads a
                // separately cached result that only a DETAILS run fills,
                // measured live to stay `{}` forever otherwise. Both are
                // started from the same click so one "Run now" produces
                // both the count DHIS2 already showed and the population
                // the tab needs to reconcile it against.
                await Promise.all([
                    startRun(fetcher, names, 'summary'),
                    startRun(fetcher, names, 'details'),
                ])
                if (disabledRef.current || unmountedRef.current) {
                    return
                }
                // Spec 4.5 forbids re-running automatically -- this loop
                // only ever polls the run this call itself started, never
                // triggers a new one. C1: bounded by both an attempt cap
                // and a growing backoff, so a check whose finishedTime
                // never advances (a dropped/failed job) ends the loop
                // instead of polling forever.
                let interval = POLL_INITIAL_INTERVAL_MS
                let advanced = false
                for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
                    const rows = await readSummaries(fetcher, names)
                    if (disabledRef.current || unmountedRef.current) {
                        return
                    }
                    applySummaries(rows)
                    const allAdvanced = rows.every(
                        (r) =>
                            r.finishedTime !== null &&
                            r.finishedTime !== before.get(r.name)
                    )
                    if (allAdvanced) {
                        setStale((prev) => {
                            const next = new Set(prev)
                            names.forEach((n) => next.delete(n))
                            return next
                        })
                        advanced = true
                        break
                    }
                    if (attempt === POLL_MAX_ATTEMPTS - 1) {
                        break
                    }
                    await new Promise((resolve) =>
                        setTimeout(resolve, interval)
                    )
                    if (disabledRef.current || unmountedRef.current) {
                        return
                    }
                    interval = Math.min(
                        interval * POLL_BACKOFF_FACTOR,
                        POLL_MAX_INTERVAL_MS
                    )
                }
                if (!advanced && !unmountedRef.current) {
                    // Diagnostic text, not user-facing as written --
                    // translate before display, same as engineError and
                    // historyError in useMembershipWrite.ts. The check(s)
                    // stay marked stale (if they were) since this run
                    // never confirmed a fresh result.
                    setError(
                        'The run did not report back in time; the result may still arrive.'
                    )
                }
            } catch (e) {
                if (unmountedRef.current) {
                    return
                }
                if (isForbidden(e)) {
                    disable()
                } else {
                    setError(e instanceof Error ? e.message : String(e))
                }
            } finally {
                runInFlightRef.current = false
                if (!unmountedRef.current) {
                    setIsRunning(false)
                }
            }
        },
        [fetcher, disable, applySummaries]
    )

    const markStale = useCallback((objectType: ObjectType) => {
        const matching = checksRef.current
            .filter((c) => c.objectType === objectType)
            .map((c) => c.name)
        if (matching.length === 0) {
            return
        }
        setStale((prev) => {
            const next = new Set(prev)
            matching.forEach((n) => next.add(n))
            return next
        })
    }, [])

    const value = useMemo<IntegrityState>(
        () => ({
            available,
            checks,
            summaries,
            stale,
            isRunning,
            error,
            run,
            markStale,
            refresh,
        }),
        [
            available,
            checks,
            summaries,
            stale,
            isRunning,
            error,
            run,
            markStale,
            refresh,
        ]
    )

    return (
        <IntegrityContext.Provider value={value}>
            {children}
        </IntegrityContext.Provider>
    )
}

export function useIntegrity(): IntegrityState {
    const ctx = useContext(IntegrityContext)
    if (!ctx) {
        throw new Error('useIntegrity must be used inside IntegrityProvider')
    }
    return ctx
}
