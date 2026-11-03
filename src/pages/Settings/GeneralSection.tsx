import i18n from '@dhis2/d2-i18n'
import { Button, Checkbox, NoticeBox } from '@dhis2/ui'
import React, { useState } from 'react'
import styles from './Settings.module.css'
import { useEngine } from '@/hooks/useEngine'
import { useGsiConfig } from '@/hooks/useGsiConfig'

export const TrackerSection = () => {
    const { config, isLoaded, setIncludeTracker } = useGsiConfig()
    // I3: a failed save is reported, never dropped.
    const [error, setError] = useState<string | null>(null)
    return (
        <div className={styles.section}>
            <h2 className={styles.heading}>{i18n.t('Tracker data')}</h2>
            {/* L1: the setting adds tracker data elements to the data element
                population (src/engine/population.ts) and applies to every
                user; it has nothing to do with tracked entity attributes. */}
            <Checkbox
                label={i18n.t(
                    'Include tracker data elements when checking data element group sets'
                )}
                checked={config.includeTracker}
                disabled={!isLoaded}
                onChange={({ checked }: { checked: boolean }) => {
                    setError(null)
                    setIncludeTracker(checked).catch((e: unknown) => {
                        setError(e instanceof Error ? e.message : String(e))
                    })
                }}
            />
            {error && (
                <NoticeBox
                    error
                    title={i18n.t('Could not save the tracker data setting')}
                >
                    {error}
                </NoticeBox>
            )}
        </div>
    )
}

export const CacheSection = () => {
    const { reload, clearCache } = useEngine()
    const [clearing, setClearing] = useState(false)
    const handleClear = async () => {
        setClearing(true)
        try {
            await clearCache()
            await reload(true)
        } finally {
            setClearing(false)
        }
    }
    return (
        <div className={styles.section}>
            <h2 className={styles.heading}>{i18n.t('Cache')}</h2>
            <div>
                <Button
                    onClick={handleClear}
                    disabled={clearing}
                    loading={clearing}
                >
                    {i18n.t('Clear cache')}
                </Button>
            </div>
        </div>
    )
}
