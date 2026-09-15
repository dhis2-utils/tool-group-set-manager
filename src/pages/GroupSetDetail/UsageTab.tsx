import i18n from '@dhis2/d2-i18n'
import { CircularLoader, NoticeBox } from '@dhis2/ui'
import React from 'react'
import styles from './GroupSetDetail.module.css'
import { usageApplies } from '@/data/sources/usageSqlView'
import { GroupSetMeta } from '@/engine/types'
import { useUsage } from '@/hooks/useUsage'
import { favouriteTypeLabel } from '@/utils/favouriteTypeLabels'
import { interpolate } from '@/utils/interpolate'

const favouritesLabel = (count: number) =>
    count === 1
        ? i18n.t('1 favourite references this group set')
        : interpolate(i18n.t('{count} favourites reference this group set'), {
              count: count.toLocaleString(),
          })

const viewsLabel = (count: number) =>
    count === 1
        ? i18n.t('1 view in the last 12 months')
        : interpolate(i18n.t('{count} views in the last 12 months'), {
              count: count.toLocaleString(),
          })

const typeFavouritesLabel = (count: number) =>
    count === 1
        ? i18n.t('1 favourite')
        : interpolate(i18n.t('{count} favourites'), {
              count: count.toLocaleString(),
          })

export const UsageTab = ({ set }: { set: GroupSetMeta }) => {
    const usage = useUsage()

    if (!usageApplies(set.objectType)) {
        // Spec 3.2: there is no indicatorgroupsetdimension table on any
        // supported version, so a zero here would be a fact about DHIS2's
        // data model presented as a finding about this group set.
        return (
            <NoticeBox title={i18n.t('Usage')}>
                {i18n.t(
                    'Indicator group sets are not analytics dimensions, so there is no usage data for them.'
                )}
            </NoticeBox>
        )
    }

    if (usage.status === 'loading') {
        return <CircularLoader small />
    }

    if (usage.status === 'absent') {
        return (
            <NoticeBox
                title={i18n.t('Usage data is not installed on this instance')}
            >
                <p>
                    {i18n.t(
                        'Usage counts come from an optional SQL view that an administrator installs once.'
                    )}
                </p>
                {/*
                    A plain hash-router anchor, not react-router's `Link`:
                    this app is a `createHashRouter` (App.tsx), so `#/settings`
                    navigates correctly, and it does so without requiring a
                    Router context around every render of this tab -- `Link`
                    throws when rendered outside one (confirmed against
                    UsageTab.test.tsx's unwrapped `render`).
                */}
                <a href="#/settings">
                    {i18n.t('Go to Settings to install it')}
                </a>
            </NoticeBox>
        )
    }

    if (usage.status === 'error') {
        return (
            <NoticeBox error title={i18n.t('Usage data could not be read')}>
                {usage.error}
            </NoticeBox>
        )
    }

    const setUsage = usage.forSet(set.id)
    if (!setUsage) {
        return <CircularLoader small />
    }

    return (
        <div className={styles.usage}>
            <p className={styles.usageHeadline}>
                {setUsage.favourites === 0
                    ? i18n.t('No saved favourite references this group set')
                    : favouritesLabel(setUsage.favourites)}
            </p>
            <p>{viewsLabel(setUsage.views12m)}</p>
            {setUsage.byFavouriteType.length > 0 && (
                <ul className={styles.usageBreakdown}>
                    {setUsage.byFavouriteType.map((row) => (
                        <li key={row.favouriteType}>
                            <span>{favouriteTypeLabel(row.favouriteType)}</span>
                            <span>{typeFavouritesLabel(row.favourites)}</span>
                        </li>
                    ))}
                </ul>
            )}
            {/* Spec 3.6, on every surface that shows a count. */}
            <NoticeBox title={i18n.t('These counts are indicative')}>
                {i18n.t(
                    'They cover saved favourites and their recorded views. An ad-hoc analytics request, an external client or an API consumer leaves no favourite behind, so a count of zero means nothing on this instance references the group set — not that nothing uses it.'
                )}
            </NoticeBox>
        </div>
    )
}
