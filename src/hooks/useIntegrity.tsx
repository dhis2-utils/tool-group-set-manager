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

// How often run() re-reads the summary while waiting for finishedTime to
// move past the value it held before the run started (finding 2: the
// server gives no push notification, only a cache to poll).
const POLL_INTERVAL_MS = 300

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
    })

    const [available, setAvailable] = useState(false)
    const [checks, setChecks] = useState<ResolvedCheck[]>([])
    const [summaries, setSummaries] =
        useState<Record<string, CheckSummary>>(EMPTY_SUMMARIES)
    const [stale, setStale] = useState<Set<string>>(new Set())
    const [isRunning, setIsRunning] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const checksRef = useRef<ResolvedCheck[]>([])

    // Once flipped, no further integrity request is ever made again this
    // session -- checked before every fetch, not just in the initial gate.
    const disabledRef = useRef(false)

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
                if (disabledRef.current) {
                    return
                }
                applySummaries(rows)
            } catch (e) {
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
        setAvailable(true)
        void (async () => {
            try {
                const resolved = await resolveChecks(fetcher)
                if (cancelled || disabledRef.current) {
                    return
                }
                checksRef.current = resolved
                setChecks(resolved)
                await loadSummaries(resolved)
            } catch (e) {
                if (cancelled) {
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

    const refresh = useCallback(async () => {
        if (disabledRef.current) {
            return
        }
        await loadSummaries(checksRef.current)
    }, [loadSummaries])

    const run = useCallback(
        async (names: string[]) => {
            if (disabledRef.current || names.length === 0) {
                return
            }
            setIsRunning(true)
            setError(null)
            try {
                const before = new Map(
                    names.map((n) => [n, summaries[n]?.finishedTime ?? null])
                )
                await startRun(fetcher, names, 'summary')
                if (disabledRef.current) {
                    return
                }
                // Spec 4.5 forbids re-running automatically -- this loop
                // only ever polls the run this call itself started, never
                // triggers a new one.
                for (;;) {
                    const rows = await readSummaries(fetcher, names)
                    if (disabledRef.current) {
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
                        break
                    }
                    await new Promise((resolve) =>
                        setTimeout(resolve, POLL_INTERVAL_MS)
                    )
                }
            } catch (e) {
                if (isForbidden(e)) {
                    disable()
                } else {
                    setError(e instanceof Error ? e.message : String(e))
                }
            } finally {
                setIsRunning(false)
            }
        },
        [fetcher, summaries, disable, applySummaries]
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
