import { useConfig } from '@dhis2/app-runtime'
import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
} from 'react'
import { useUserScope } from './useUserScope'

interface ScopeValue {
    rootId: string | null
    rootName: string
    /**
     * The org unit level of the scope root, or null when it is not known --
     * a scope restored from storage before levels were stored, whose id is
     * not among the user's own roots either. Screens that need the level
     * resolve that remaining case through the engine, which holds the
     * hierarchy (see GroupSetDetail).
     */
    rootLevel: number | null
    setRoot: (id: string, name: string, level: number | null) => void
    isReady: boolean
}

interface Root {
    id: string
    name: string
    level: number | null
}

interface StoredScope {
    id: string
    name: string
    /**
     * Carried with the selection because it cannot be recovered from the id
     * alone: any scope chosen through the organisation unit tree is missing
     * from the user's root list, and was previously treated as level 1 --
     * which offered row levels above the scope, defaulted to the wrong one,
     * and produced matrix rows for org units outside the scope entirely.
     * Optional so an entry stored before this existed still parses.
     */
    level?: number
    /** the baseUrl this selection was made against; guards against a stale
     * id from a different server being trusted after switching instances */
    baseUrl: string
}

const ScopeContext = createContext<ScopeValue | null>(null)
const KEY = 'gsi.scope'

function isStoredScope(value: unknown): value is StoredScope {
    if (typeof value !== 'object' || value === null) {
        return false
    }
    const v = value as Record<string, unknown>
    return (
        typeof v.id === 'string' &&
        typeof v.name === 'string' &&
        typeof v.baseUrl === 'string' &&
        (v.level === undefined || typeof v.level === 'number')
    )
}

function readStoredScope(baseUrl: string): Root | null {
    try {
        const raw = sessionStorage.getItem(KEY)
        if (!raw) {
            return null
        }
        const parsed: unknown = JSON.parse(raw)
        if (!isStoredScope(parsed) || parsed.baseUrl !== baseUrl) {
            return null
        }
        return {
            id: parsed.id,
            name: parsed.name,
            level: parsed.level ?? null,
        }
    } catch {
        return null
    }
}

export const ScopeProvider = ({ children }: { children: React.ReactNode }) => {
    const { baseUrl } = useConfig()
    const { roots, isLoading } = useUserScope()
    // oxlint-disable-next-line react/hook-use-state -- `setRoot` is the context's persisting setter below, which wraps this raw one
    const [root, setRootState] = useState<Root | null>(() =>
        readStoredScope(baseUrl)
    )

    useEffect(() => {
        if (root === null && roots.length > 0) {
            setRootState({
                id: roots[0].id,
                name: roots[0].displayName,
                level: roots[0].level ?? null,
            })
        }
    }, [root, roots])

    const setRoot = useCallback(
        (id: string, name: string, level: number | null) => {
            setRootState({ id, name, level })
            try {
                sessionStorage.setItem(
                    KEY,
                    JSON.stringify({
                        id,
                        name,
                        // Omitted rather than stored as null when unknown, so
                        // the stored shape stays the one isStoredScope
                        // accepts either way.
                        ...(level === null ? {} : { level }),
                        baseUrl,
                    })
                )
            } catch {
                // ignore storage failures; the choice still lives in state
            }
        },
        [baseUrl]
    )

    const value = useMemo<ScopeValue>(
        () => ({
            rootId: root?.id ?? null,
            rootName: root?.name ?? '',
            rootLevel: root?.level ?? null,
            setRoot,
            isReady: !isLoading && root !== null,
        }),
        [root, setRoot, isLoading]
    )
    return (
        <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>
    )
}

export function useScope(): ScopeValue {
    const ctx = useContext(ScopeContext)
    if (!ctx) {
        throw new Error('useScope must be used inside ScopeProvider')
    }
    return ctx
}
