import { useEffect, useState } from 'react'
import { useEngine } from './useEngine'
import { EngineMethod } from '@/engine/protocol'

interface EngineQueryState<T> {
    data: T | undefined
    isLoading: boolean
    error: string | null
    /**
     * The arguments key (`JSON.stringify(args)`) that produced `data`, or
     * null when there is none. `data` is already cleared the moment the
     * arguments change, so a consumer never needs this to stay safe -- it is
     * here so one that wants certainty can check rather than infer.
     */
    dataKey: string | null
}

export function useEngineQuery<T>(
    method: EngineMethod,
    args: unknown[],
    enabled = true
): EngineQueryState<T> {
    const { client, status } = useEngine()
    const [state, setState] = useState<EngineQueryState<T>>({
        data: undefined,
        isLoading: enabled,
        error: null,
        dataKey: null,
    })
    const argsKey = JSON.stringify(args)
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
            s.dataKey === argsKey
                ? { ...s, isLoading: true }
                : {
                      data: undefined,
                      dataKey: null,
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
                        dataKey: argsKey,
                        isLoading: false,
                        error: null,
                    })
                }
            })
            .catch((e: unknown) => {
                if (!cancelled) {
                    setState({
                        data: undefined,
                        dataKey: argsKey,
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
        // the comment on its declaration above.
    }, [hasClient, method, argsKey, enabled, status?.phase, status?.type])

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
    // The test is the arguments key and nothing else. This effect also
    // re-runs on every engine load phase and type change; those re-runs ask
    // the same question, so the answer already on screen is still that
    // question's answer, and blanking it would flash a loader over an
    // already rendered matrix several times per load.
    if (state.dataKey !== argsKey) {
        return {
            data: undefined,
            dataKey: null,
            isLoading: enabled,
            error: null,
        }
    }
    return state
}
