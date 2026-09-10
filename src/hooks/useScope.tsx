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
    setRoot: (id: string, name: string) => void
    isReady: boolean
}

interface StoredScope {
    id: string
    name: string
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
        typeof v.baseUrl === 'string'
    )
}

function readStoredScope(baseUrl: string): { id: string; name: string } | null {
    try {
        const raw = sessionStorage.getItem(KEY)
        if (!raw) {
            return null
        }
        const parsed: unknown = JSON.parse(raw)
        if (!isStoredScope(parsed) || parsed.baseUrl !== baseUrl) {
            return null
        }
        return { id: parsed.id, name: parsed.name }
    } catch {
        return null
    }
}

export const ScopeProvider = ({ children }: { children: React.ReactNode }) => {
    const { baseUrl } = useConfig()
    const { roots, isLoading } = useUserScope()
    const [root, setRootState] = useState<{
        id: string
        name: string
    } | null>(() => readStoredScope(baseUrl))

    useEffect(() => {
        if (root === null && roots.length > 0) {
            setRootState({ id: roots[0].id, name: roots[0].displayName })
        }
    }, [root, roots])

    const setRoot = useCallback(
        (id: string, name: string) => {
            setRootState({ id, name })
            try {
                sessionStorage.setItem(
                    KEY,
                    JSON.stringify({ id, name, baseUrl })
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
