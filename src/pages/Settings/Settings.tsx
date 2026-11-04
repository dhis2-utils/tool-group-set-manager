import { useConfig } from '@dhis2/app-runtime'
import i18n from '@dhis2/d2-i18n'
import { NoticeBox } from '@dhis2/ui'
import React, { useMemo } from 'react'
import { CatchAllSection } from './CatchAllSection'
import { CacheSection, TrackerSection } from './GeneralSection'
import styles from './Settings.module.css'
import type { SqlViewsState } from './SqlViewsSection'
import { SqlViewsSection } from './SqlViewsSection'
import type { UsageState } from './UsageSection'
import { UsageSection } from './UsageSection'
import { useAdminSection } from './useAdminSection'
import { useIsSuperuser } from './useIsSuperuser'
import { createFetcher } from '@/data/fetcher'
import { checkSqlViews, sqlViewAuthorities } from '@/data/sources/sqlViewAdmin'
import { loadSqlViewSharing } from '@/data/sources/sqlViewSharing'
import { checkUsageView } from '@/data/sources/usageAdmin'
import { useEngine } from '@/hooks/useEngine'
import { useUsageRefresh } from '@/hooks/useUsage'

/**
 * For a user without `ALL`: why most of this page is read-only. The
 * settings live in a dataStore namespace and apply to every user, so a
 * read-only user's choice would reach everyone (the catch-all group they
 * chose was then suggested to others in the bulk fix).
 */
const SharedSettingsNotice = () => (
    <NoticeBox title={i18n.t('These settings apply to every user')}>
        <p className={styles.note}>
            {i18n.t(
                'The settings on this page apply to every user of the tool, so only a superuser with the ALL authority can change them.'
            )}
        </p>
        <p className={styles.note}>
            {i18n.t(
                'You can still choose the catch-all group of a group set that you can edit, and clear the cache in this browser.'
            )}
        </p>
    </NoticeBox>
)

export const Settings = () => {
    const { baseUrl, apiVersion } = useConfig() as {
        baseUrl: string
        apiVersion: number
    }
    const fetcher = useMemo(
        () => createFetcher(baseUrl, apiVersion),
        [baseUrl, apiVersion]
    )
    const { reload } = useEngine()
    // Not the full `useUsage()` hook: Settings never displays usage. This
    // tells the readers that do (Dashboard, GroupSetCard, UsageTab) that the
    // view just changed.
    const refreshUsageReaders = useUsageRefresh()
    const isSuperuser = useIsSuperuser()

    // Each section reads the sharing choice itself: its checks judge every
    // view against it (M7), and the two sections load independently.
    const sqlViews = useAdminSection<SqlViewsState>(async () => {
        const sharing = await loadSqlViewSharing(fetcher)
        const [checks, authorities] = await Promise.all([
            checkSqlViews(fetcher, sharing),
            sqlViewAuthorities(fetcher),
        ])
        return { checks, authorities, sharing }
    })
    const usage = useAdminSection<UsageState>(async () => {
        const sharing = await loadSqlViewSharing(fetcher)
        return { view: await checkUsageView(fetcher, sharing), sharing }
    })

    const handleViewsChanged = async () => {
        await usage.refresh()
        refreshUsageReaders()
        await reload(true)
    }

    return (
        <div className={styles.page}>
            {isSuperuser === false && <SharedSettingsNotice />}
            <div className={styles.section}>
                <h2 className={styles.heading}>{i18n.t('SQL views')}</h2>
                <SqlViewsSection
                    fetcher={fetcher}
                    sqlViews={sqlViews}
                    onViewsChanged={handleViewsChanged}
                />
            </div>

            <div className={styles.section}>
                <h2 className={styles.heading}>{i18n.t('Group set usage')}</h2>
                <p className={styles.note}>
                    {i18n.t(
                        'An optional SQL view that counts the saved favourites referencing each group set, and how often they were viewed in the last 12 months. Without it the app works exactly as before, only with no usage figures.'
                    )}
                </p>
                <UsageSection
                    fetcher={fetcher}
                    usage={usage}
                    authorities={sqlViews.check?.authorities ?? null}
                    authoritiesKnown={sqlViews.check !== null}
                    onUsageChanged={refreshUsageReaders}
                />
            </div>

            <div className={styles.section}>
                <h2 className={styles.heading}>{i18n.t('Catch-all group')}</h2>
                <CatchAllSection />
            </div>

            <TrackerSection />
            <CacheSection />
        </div>
    )
}
