import { useMemo } from 'react'
import { useApiDataQuery } from '@/utils/useApiDataQuery'

interface Me {
    organisationUnits: { id: string; displayName: string; level: number }[]
    authorities: string[]
}

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
    return {
        isLoading,
        roots: data?.organisationUnits ?? [],
        authorities,
        hasAuthority: (authority: string) =>
            authorities.has('ALL') || authorities.has(authority),
    }
}
