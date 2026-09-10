import { useEffect, useState } from 'react'
import { useEngine } from './useEngine'
import { EngineMethod } from '@/engine/protocol'

interface EngineQueryState<T> {
    data: T | undefined
    isLoading: boolean
    error: string | null
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
        setState((s) => ({ ...s, isLoading: true }))
        client
            .call<T>(method, ...(JSON.parse(argsKey) as unknown[]))
            .then((data) => {
                if (!cancelled) {
                    setState({ data, isLoading: false, error: null })
                }
            })
            .catch((e: unknown) => {
                if (!cancelled) {
                    setState({
                        data: undefined,
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

    return state
}
