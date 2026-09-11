import { useConfig } from '@dhis2/app-runtime'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { listChangeSets } from '@/data/datastore'
import { createFetcher } from '@/data/fetcher'
import { ChangeSet } from '@/engine/changeSet'

const PAGE_SIZE = 20

export interface UseChangeSetsResult {
    changeSets: ChangeSet[]
    /** true only while loading the first page */
    isLoading: boolean
    /** true only while loading an additional page on top of ones already shown */
    isLoadingMore: boolean
    error: string | null
    hasMore: boolean
    loadMore: () => void
    /** re-fetches from the start -- e.g. after a revert adds a new row */
    reload: () => void
}

/**
 * D3: the History page's own paged view over `listChangeSets`. Only the
 * page actually shown (plus whatever earlier pages `loadMore` has already
 * pulled in) is ever fetched -- a namespace holding thousands of change
 * sets never costs this hook more than the pages the user has scrolled to.
 */
export function useChangeSets(): UseChangeSetsResult {
    const { baseUrl, apiVersion } = useConfig() as {
        baseUrl: string
        apiVersion: number
    }
    const fetcher = useMemo(
        () => createFetcher(baseUrl, apiVersion),
        [baseUrl, apiVersion]
    )

    const [changeSets, setChangeSets] = useState<ChangeSet[]>([])
    const [offset, setOffset] = useState(0)
    const [hasMore, setHasMore] = useState(false)
    const [isLoading, setIsLoading] = useState(true)
    const [isLoadingMore, setIsLoadingMore] = useState(false)
    const [error, setError] = useState<string | null>(null)
    // Bumped by reload() to force the initial-load effect to run again.
    const [generation, setGeneration] = useState(0)

    useEffect(() => {
        let cancelled = false
        setIsLoading(true)
        setError(null)
        listChangeSets(fetcher, { offset: 0, limit: PAGE_SIZE })
            .then((page) => {
                if (cancelled) {
                    return
                }
                setChangeSets(page.changeSets)
                setHasMore(page.hasMore)
                // M1 (fix round 1): advance by the window *requested*
                // (PAGE_SIZE), not by the rows returned. `listChangeSets`
                // pages by key index and silently drops any key whose
                // document fails to read -- advancing by the returned
                // count would make the very next page's `offset` overlap
                // the key window just read, producing duplicate rows (and
                // duplicate React keys, each with its own Revert).
                setOffset(PAGE_SIZE)
                setIsLoading(false)
            })
            .catch((e: unknown) => {
                if (cancelled) {
                    return
                }
                setError(e instanceof Error ? e.message : String(e))
                setIsLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [fetcher, generation])

    const loadMore = useCallback(() => {
        if (isLoadingMore || isLoading || !hasMore) {
            return
        }
        setIsLoadingMore(true)
        listChangeSets(fetcher, { offset, limit: PAGE_SIZE })
            .then((page) => {
                setChangeSets((prev) => [...prev, ...page.changeSets])
                setHasMore(page.hasMore)
                // M1: see the matching comment in the initial-load effect.
                setOffset((o) => o + PAGE_SIZE)
                setIsLoadingMore(false)
            })
            .catch((e: unknown) => {
                setError(e instanceof Error ? e.message : String(e))
                setIsLoadingMore(false)
            })
    }, [fetcher, offset, hasMore, isLoading, isLoadingMore])

    const reload = useCallback(() => {
        setChangeSets([])
        setOffset(0)
        setHasMore(false)
        setGeneration((g) => g + 1)
    }, [])

    return {
        changeSets,
        isLoading,
        isLoadingMore,
        error,
        hasMore,
        loadMore,
        reload,
    }
}
