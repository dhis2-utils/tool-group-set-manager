import { useUserScope } from '@/hooks/useUserScope'

/**
 * Whether the user has the `ALL` authority, or null while that is not yet
 * known. Settings that apply to every user (stored in the dataStore
 * namespace that every user can write through the API) are changed in the
 * app only by such a user; the catch-all group of a set is the exception,
 * also open to a user who can write the set. A failed lookup reads as "no"
 * rather than "unknown", so the settings stay closed.
 */
export function useIsSuperuser(): boolean | null {
    const { isLoading, authorities } = useUserScope()
    return isLoading ? null : authorities.has('ALL')
}
