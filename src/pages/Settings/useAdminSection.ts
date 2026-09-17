import { useCallback, useEffect, useRef, useState } from 'react'

export interface AdminSection<C> {
    /** the last successful check, null until the first one lands or after a failed one */
    check: C | null
    checking: boolean
    checkError: string | null
    busy: boolean
    actionError: string | null
    /** re-runs the check; safe to call any time */
    refresh: () => Promise<void>
    /** runs one action: busy while it runs, its failure on actionError, and a re-check in finally */
    run: (action: () => Promise<void>) => Promise<void>
}

/**
 * The check / busy / error machine both admin sections of Settings run: a
 * status check on mount (and on demand), one action at a time with its
 * own failure slot, and a re-check once the action settles however it
 * settled. The two sections used to carry their own copies, and the copy
 * was once incomplete (Plan 6's final review found the usage section's
 * no-authority branches missing) -- one hook is how that stays fixed.
 *
 * `checkError` and `actionError` are separate on purpose: a failing status
 * check gates the whole section (there is nothing to show), while a failed
 * action must not -- a 403 on remove would otherwise wipe the tag and both
 * buttons with no way back but a page reload.
 *
 * `load` is captured in a ref so a caller can pass an inline closure
 * without re-triggering the mount check on every render.
 */
export function useAdminSection<C>(load: () => Promise<C>): AdminSection<C> {
    const loadRef = useRef(load)
    loadRef.current = load
    const [check, setCheck] = useState<C | null>(null)
    const [checking, setChecking] = useState(true)
    const [checkError, setCheckError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [actionError, setActionError] = useState<string | null>(null)

    const refresh = useCallback(async () => {
        setChecking(true)
        setCheckError(null)
        try {
            setCheck(await loadRef.current())
        } catch (e) {
            setCheck(null)
            setCheckError(e instanceof Error ? e.message : String(e))
        } finally {
            setChecking(false)
        }
    }, [])

    useEffect(() => {
        void refresh()
    }, [refresh])

    const run = useCallback(
        async (action: () => Promise<void>) => {
            setBusy(true)
            setActionError(null)
            try {
                await action()
            } catch (e) {
                setActionError(e instanceof Error ? e.message : String(e))
            } finally {
                // On both paths: an action that threw half way may still
                // have changed the server, and the tag must say what is
                // really there.
                await refresh()
                setBusy(false)
            }
        },
        [refresh]
    )

    return { check, checking, checkError, busy, actionError, refresh, run }
}
