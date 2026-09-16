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
export const MetadataFreshness = ({ loadedAt }: { loadedAt: number | null }) => {
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

    if (loadedAt === null) {
        return null
    }
    const { label, stale } = metadataAge(loadedAt, now)

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
                {busy ? i18n.t('Reloading metadata…') : label}
            </span>
            <Button small disabled={busy} onClick={() => void onRefresh()}>
                {i18n.t('Refresh')}
            </Button>
        </div>
    )
}
