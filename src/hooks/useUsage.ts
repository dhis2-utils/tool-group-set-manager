import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { USABLE_SQL_VIEW_TYPES } from '@/data/sources/sqlViewSource'
import {
    parseUsageListGrid,
    SetUsage,
    usageByGroupSet,
    UsageListGrid,
    USAGE_SQL_VIEW_CODE,
} from '@/data/sources/usageSqlView'
import { useApiDataQuery } from '@/utils/useApiDataQuery'

export type UsageStatus = 'loading' | 'absent' | 'ready' | 'error'

export interface UsageState {
    status: UsageStatus
    error: string | null
    /** null whenever status is not 'ready' -- see the plan's note on this */
    forSet: (groupSetId: string) => SetUsage | null
    refresh: () => void
}

interface LookupResponse {
    sqlViews: {
        id: string
        code?: string
        type?: string
        access: { data?: { read?: boolean } }
    }[]
}

const EMPTY: SetUsage = { favourites: 0, views12m: 0, byFavouriteType: [] }

/**
 * An explicit page size rather than `paging=false`: the app runtime warns on
 * the latter, and the row count here is bounded by three times the number of
 * group sets on the instance. `PAGE_SIZE` is two orders of magnitude above
 * any real instance, and a result that reaches it is treated as truncated
 * rather than reported as if it were complete.
 */
const PAGE_SIZE = 5000

/**
 * Every query this feature issues sits under this prefix, and `refresh`
 * invalidates the prefix and nothing else. It used to invalidate
 * `['sqlViewData']`, an app-wide name that was correct only while no other
 * SQL-view-backed query existed -- a second one would have been invalidated
 * by every usage install or removal.
 */
export const USAGE_QUERY_PREFIX = 'usage'
const LOOKUP_KEY = [USAGE_QUERY_PREFIX, 'sqlViews', USAGE_SQL_VIEW_CODE]
const dataKey = (viewId: string) => [USAGE_QUERY_PREFIX, 'sqlViewData', viewId]

/**
 * Tells every mounted reader of `useUsage()` that the view changed, without
 * reading anything itself. Settings uses this: it installs and removes the
 * view but never displays usage, and mounting the full hook there cost a
 * lookup plus an up-to-5000-row read for data it threw away.
 *
 * Invalidation rather than refetch, and by prefix rather than by id: the
 * reasoning is in `useUsage`'s own comment on `refresh`.
 */
export function useUsageRefresh(): () => void {
    const queryClient = useQueryClient()
    return useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: [USAGE_QUERY_PREFIX] })
    }, [queryClient])
}

/**
 * Reads the usage SQL view (Task 1's `USAGE_SQL_VIEW_CODE`) and aggregates
 * it per group set. Deliberately not a provider -- see the plan: TanStack
 * Query already dedupes by queryKey across the dashboard's cards and the
 * group set page, and this hook owns no mutable session state.
 *
 * Deliberately does not re-probe readability the way `usageAdmin`'s
 * `checkUsageView` does: it filters the lookup on `type` and
 * `access.data.read`, then reads. A view whose metadata passes that filter
 * but whose read still fails surfaces as 'error', not 'absent' -- telling a
 * user to install a view that already exists is worse than telling them it
 * is broken.
 */
export function useUsage(): UsageState {
    const lookup = useApiDataQuery<LookupResponse>({
        queryKey: LOOKUP_KEY,
        query: {
            resource: 'sqlViews',
            params: {
                fields: 'id,code,type,access[data[read]]',
                filter: `code:eq:${USAGE_SQL_VIEW_CODE}`,
            },
        },
        staleTime: Infinity,
    })

    const view = lookup.data?.sqlViews.find(
        (v) =>
            v.code === USAGE_SQL_VIEW_CODE &&
            v.access.data?.read === true &&
            v.type !== undefined &&
            USABLE_SQL_VIEW_TYPES.includes(v.type)
    )

    const read = useApiDataQuery<UsageListGrid>({
        queryKey: dataKey(view?.id ?? 'none'),
        query: {
            resource: `sqlViews/${view?.id ?? 'none'}/data`,
            params: { pageSize: PAGE_SIZE },
        },
        enabled: Boolean(view),
        staleTime: 5 * 60 * 1000,
    })

    const parsed = useMemo(() => {
        if (!read.data) {
            return null
        }
        try {
            const rows = parseUsageListGrid(read.data)
            if (rows.length >= PAGE_SIZE) {
                throw new Error(
                    'The group set usage SQL view returned a truncated result'
                )
            }
            return { byId: usageByGroupSet(rows), error: null as string | null }
        } catch (e) {
            return {
                byId: null,
                error: e instanceof Error ? e.message : String(e),
            }
        }
    }, [read.data])

    const status: UsageStatus = lookup.isError
        ? 'error'
        : lookup.isLoading
          ? 'loading'
          : !view
            ? 'absent'
            : read.isError || parsed?.error
              ? 'error'
              : parsed?.byId
                ? 'ready'
                : 'loading'

    // Behind the same `view` guard `status` applies. Without it, a read that
    // errored while no view was found left a non-null `error` on a state
    // that reports 'absent' -- harmless while every consumer reads `error`
    // only when `status === 'error'`, and a stale message the first time one
    // does not.
    const error =
        status === 'absent'
            ? null
            : (parsed?.error ??
              (lookup.isError || read.isError
                  ? (((lookup.error ?? read.error) as Error | null)?.message ??
                    null)
                  : null))

    const byId = status === 'ready' ? (parsed?.byId ?? null) : null

    const forSet = useCallback(
        (groupSetId: string) => (byId ? (byId.get(groupSetId) ?? EMPTY) : null),
        [byId]
    )

    // Fix round 1: this used to call `lookup.refetch()`/`read.refetch()`
    // directly, but those are captured at render time -- by the time a
    // caller (Settings, after an install or remove) actually invokes
    // `refresh()`, the `read` closure's own queryKey can already be wrong.
    // On install it was still `sqlViewData/none` (the view didn't exist
    // yet at the render that produced this closure), so the "refetch" was
    // really a GET against `sqlViews/none/data`; on remove it was still the
    // id that request had just deleted. `refetch()` bypasses `enabled:
    // false` and fires anyway (v4), so both were doomed requests that
    // happened to do nothing harmful only because their responses were
    // discarded once the *next* render replaced this hook's own view of
    // the world.
    //
    // Invalidating by key instead names what changed and lets whichever
    // consumer is actually mounted -- possibly a different component with a
    // newer `view.id` than this render ever saw -- refetch under its own,
    // current key. `invalidateQueries` only refetches a query that is
    // active, so an inactive `sqlViewData/none` some other absent-state
    // reader still holds is marked stale but never actually fetched.
    // Invalidating the shared prefix covers both keys, whichever view id is
    // current.
    //
    // The repair case (`installUsageView` re-executing an existing,
    // previously-unusable view) is exactly why the lookup key is
    // invalidated too, not just the data key: the view's id, type and
    // access are unchanged by a repair, so `view` never changes and the
    // data query's key never changes either -- only invalidating it
    // (rather than relying on a key change to trigger a fresh fetch)
    // clears its 5-minute `staleTime` and forces the re-read.
    const refresh = useUsageRefresh()

    return { status, error, forSet, refresh }
}
