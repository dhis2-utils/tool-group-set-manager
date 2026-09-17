import { useCallback, useEffect, useMemo, useState } from 'react'
import { useEngine } from './useEngine'
import { EngineMethod } from '@/engine/protocol'

interface EngineQueryState<T> {
    data: T | undefined
    isLoading: boolean
    error: string | null
    /**
     * Re-issues the same call. Only meaningful after an error -- a
     * successful result is already re-requested by the effect whenever the
     * engine's load phase or the arguments change, so nothing else needs it.
     */
    refetch: () => void
}

/**
 * What the hook actually stores. `settledKey` is the query key of the last
 * *settled* result, whether it settled as data or as an error -- the catch
 * below stamps it too, and must, or the freshness mask at the end of this
 * hook would swallow every error before a consumer could render it.
 *
 * It stays internal deliberately. Its one correct reading is subtle enough
 * to be worth not exposing ("the key of the last settled result", not "the
 * key that produced the data"), and with the mask in place a consumer can
 * never be handed a result for arguments it has stopped asking about, so
 * there is nothing left for a caller to check. If a consumer ever does need
 * to distinguish, widen the return type then, with this comment attached.
 */
interface QueryState<T> extends Omit<EngineQueryState<T>, 'refetch'> {
    settledKey: string | null
}

export function useEngineQuery<T>(
    method: EngineMethod,
    args: unknown[],
    enabled = true
): EngineQueryState<T> {
    const { client, status } = useEngine()
    const [state, setState] = useState<QueryState<T>>({
        data: undefined,
        isLoading: enabled,
        error: null,
        settledKey: null,
    })
    const argsKey = JSON.stringify(args)
    // The method belongs in the key as much as the arguments do: a call site
    // that switched method while passing identical arguments would otherwise
    // have its old result read as fresh. No call site does that today, so
    // this is closing the hole rather than fixing a live fault.
    const queryKey = `${method}:${argsKey}`
    // Whether a client exists, not the client object itself: `client` goes
    // from null to a real EngineClient exactly once (EngineProvider's own
    // creation effect runs after this hook's, so the first render or two
    // sees null), and after that it keeps the same identity for the life of
    // the mount. Depending on the object reference directly would also
    // re-run this effect any time a *consumer* (a test double, most
    // concretely) hands back a structurally-equal-but-newly-allocated
    // context value on every render -- and because the effect body itself
    // calls setState unconditionally, that re-run would trigger another
    // render, which would see yet another new reference, forever. Depending
    // on presence instead of identity still reacts to the one transition
    // that matters (no client -> a client) without being sensitive to that.
    const hasClient = client !== null
    const [attempt, setAttempt] = useState(0)
    const refetch = useCallback(() => setAttempt((a) => a + 1), [])

    useEffect(() => {
        // Guard on the client rather than assert it away: it is genuinely
        // null until the provider's creation effect runs.
        if (!enabled || !client) {
            return
        }
        let cancelled = false
        // Dropping a superseded result from state as well as flagging
        // isLoading, so nothing keeps a payload for arguments no longer
        // asked about. The guarantee consumers rely on is the derivation at
        // the end of this hook, not this line -- see the comment there.
        setState((s) =>
            s.settledKey === queryKey
                ? { ...s, isLoading: true }
                : {
                      data: undefined,
                      settledKey: null,
                      isLoading: true,
                      error: null,
                  }
        )
        client
            .call<T>(method, ...(JSON.parse(argsKey) as unknown[]))
            .then((data) => {
                if (!cancelled) {
                    setState({
                        data,
                        settledKey: queryKey,
                        isLoading: false,
                        error: null,
                    })
                }
            })
            .catch((e: unknown) => {
                if (!cancelled) {
                    setState({
                        data: undefined,
                        // Stamped on the error path too: without it the mask
                        // below would hide the error and leave the consumer
                        // loading forever.
                        settledKey: queryKey,
                        isLoading: false,
                        error: e instanceof Error ? e.message : String(e),
                    })
                }
            })
        return () => {
            cancelled = true
        }
        // status.phase/type re-run the query as data arrives in the worker.
        // `client` is deliberately omitted in favour of `hasClient` -- see
        // the comment on its declaration above. `queryKey` covers both
        // `method` and `argsKey`, which are listed anyway for the linter.
        // `attempt` is bumped by refetch() and nothing else.
    }, [
        hasClient,
        method,
        argsKey,
        queryKey,
        enabled,
        status?.phase,
        status?.type,
        attempt,
    ])

    // A result belongs to the arguments it was asked for, and that is
    // enforced here, during render, rather than by clearing state in the
    // effect above: effects are too late. On the render after the arguments
    // change, this hook's own effect and the consumer's run in the same
    // commit, and this one clearing state only schedules another render --
    // the consumer's effect in that same commit still closes over the
    // previous arguments' result. That is precisely how the objects table
    // folded the old filter's page 0 into the new filter's freshly reset
    // (also offset 0) list, and then rejected the real response forever
    // because its loaded row count no longer matched the offset. Masking the
    // stale result during render means the consumer never sees it at all.
    //
    // The test is the query key and nothing else. This effect also re-runs
    // on every engine load phase and type change; those re-runs ask the same
    // question, so the answer already on screen is still that question's
    // answer, and blanking it would flash a loader over an already rendered
    // matrix several times per load.
    return useMemo(
        () =>
            state.settledKey === queryKey
                ? {
                      data: state.data,
                      isLoading: state.isLoading,
                      error: state.error,
                      refetch,
                  }
                : {
                      data: undefined,
                      isLoading: enabled,
                      error: null,
                      refetch,
                  },
        [state, queryKey, enabled, refetch]
    )
}
