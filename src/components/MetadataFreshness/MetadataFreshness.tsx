import i18n from '@dhis2/d2-i18n'
import { Button } from '@dhis2/ui'
import React, { useEffect, useState } from 'react'
import styles from './MetadataFreshness.module.css'
import { useEngine } from '@/hooks/useEngine'
import { metadataAge } from '@/utils/metadataAge'

/** How often the rendered age catches up with the clock. */
const TICK_MS = 30_000

/**
 * Spec 2026-09-16 section 4: how old the metadata on screen is, and a way to
 * replace it.
 *
 * It never refetches on its own. Past the TTL it turns amber and changes
 * what it says, and that is all -- silently re-reading would change counts
 * under someone half way through setting up a bulk fix, which is worse than
 * an honest label. Correctness at the point it matters is the bulk fix's own
 * pre-write check (section 5), not this.
 */
export const MetadataFreshness = ({
    loadedAt,
}: {
    loadedAt: number | null
}) => {
    const { reload } = useEngine()
    const [busy, setBusy] = useState(false)
    // Re-render on a timer so "2 minutes ago" does not sit there reading
    // "just now" for the life of the page. Half a minute is well inside the
    // coarsest granularity the label has.
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), TICK_MS)
        return () => clearInterval(id)
    }, [])

    // Only "nothing has loaded yet" renders nothing. A forced reload clears
    // `loadedAt` for its duration, so returning null on that alone unmounts
    // this control mid-refresh -- taking the Refresh button and the
    // "Reloading metadata…" state off screen at the one moment they are
    // wanted, and leaving the busy branch below unreachable in practice.
    // Measured against the EMIS database (266,396 organisation units): the
    // whole indicator disappeared 117ms after the click and came back 5.6s
    // later. On the Sierra Leone seed the same reload finishes fast enough
    // that the busy render lands first, which is why the end-to-end flow
    // passed on every version while the control was still vanishing.
    if (loadedAt === null && !busy) {
        return null
    }
    const age = loadedAt === null ? null : metadataAge(loadedAt, now)
    const stale = age?.stale ?? false

    const onRefresh = async () => {
        setBusy(true)
        try {
            await reload(true)
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className={styles.freshness}>
            <span
                className={`${styles.dot} ${
                    busy ? styles.busy : stale ? styles.stale : styles.fresh
                }`}
            />
            <span className={stale ? styles.staleText : undefined}>
                {busy ? i18n.t('Reloading metadata…') : age?.label}
            </span>
            <Button small disabled={busy} onClick={() => void onRefresh()}>
                {i18n.t('Refresh')}
            </Button>
        </div>
    )
}
