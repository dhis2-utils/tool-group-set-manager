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
        queryKey: ['sqlViews', USAGE_SQL_VIEW_CODE],
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
        queryKey: ['sqlViewData', view?.id ?? 'none'],
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

    const error =
        parsed?.error ??
        (lookup.isError || read.isError
            ? ((lookup.error ?? read.error) as Error | null)?.message ?? null
            : null)

    const byId = status === 'ready' ? parsed?.byId ?? null : null

    const forSet = useCallback(
        (groupSetId: string) => (byId ? byId.get(groupSetId) ?? EMPTY : null),
        [byId]
    )

    const refresh = useCallback(() => {
        void lookup.refetch()
        void read.refetch()
    }, [lookup, read])

    return { status, error, forSet, refresh }
}
