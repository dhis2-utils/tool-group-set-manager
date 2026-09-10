import { useCallback, useMemo } from 'react'
import { useApiDataQuery } from '@/utils/useApiDataQuery'

interface Me {
    organisationUnits: { id: string; displayName: string; level: number }[]
    authorities: string[]
}

type OrgUnitRoot = Me['organisationUnits'][number]

// A stable fallback so `roots` keeps the same reference across renders while
// there is no data yet, instead of a fresh `[]` (and therefore a new
// dependency-array/memo entry) every time.
const EMPTY_ROOTS: OrgUnitRoot[] = []

export function useUserScope() {
    const { data, isLoading } = useApiDataQuery<Me>({
        queryKey: ['me', 'scope'],
        query: {
            resource: 'me',
            params: {
                fields: 'organisationUnits[id,displayName,level],authorities',
            },
        },
        staleTime: Infinity,
    })
    const authorities = useMemo(() => new Set(data?.authorities ?? []), [data])
    const roots = data?.organisationUnits ?? EMPTY_ROOTS
    const hasAuthority = useCallback(
        (authority: string) =>
            authorities.has('ALL') || authorities.has(authority),
        [authorities]
    )
    return useMemo(
        () => ({ isLoading, roots, authorities, hasAuthority }),
        [isLoading, roots, authorities, hasAuthority]
    )
}
