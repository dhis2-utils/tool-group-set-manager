import i18n from '@dhis2/d2-i18n'
import { CircularLoader, NoticeBox } from '@dhis2/ui'
import React from 'react'
import { Link } from 'react-router-dom'
import styles from './GroupSetDetail.module.css'
import { usageApplies } from '@/data/sources/usageSqlView'
import type { GroupSetMeta } from '@/engine/types'
import { useUsage } from '@/hooks/useUsage'
import { favouritesLabel } from '@/utils/favouritesLabel'
import { favouriteTypeLabel } from '@/utils/favouriteTypeLabels'
import { interpolate } from '@/utils/interpolate'

// Distinct from the shared favouritesLabel (imported above, "N favourites")
// used per favourite type below: this is the tab's own headline sentence,
// naming the group set explicitly, so it stays a local helper.
const headlineFavouritesLabel = (count: number) =>
    count === 1
        ? i18n.t('1 favourite references this group set')
        : interpolate(i18n.t('{count} favourites reference this group set'), {
              count: count.toLocaleString(),
          })

/**
 * "Recorded uses", not "views". The view counts every `datastatisticsevent`
 * row for a favourite's uid with no `eventtype` filter -- which is what spec
 * §3.2 defines the column as, but is broader than viewing, since that table
 * also records creating and updating a favourite. The wording is what moved
 * rather than the SQL: the view is installed by code, so a changed query
 * would silently leave every instance that already installed it reporting
 * the old numbers under new wording, which is worse than either.
 */
const viewsLabel = (count: number) =>
    count === 1
        ? i18n.t('1 recorded use in the last 12 months')
        : interpolate(i18n.t('{count} recorded uses in the last 12 months'), {
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
            <NoticeBox title={i18n.t('Usage data is not available to you')}>
                <p>
                    {i18n.t(
                        'Usage counts come from an optional SQL view. Either it is not installed, or an administrator has shared it only with a user group you are not in.'
                    )}
                </p>
                <Link to="/settings">
                    {i18n.t('Go to Settings to check it')}
                </Link>
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
                    : headlineFavouritesLabel(setUsage.favourites)}
            </p>
            <p>{viewsLabel(setUsage.views12m)}</p>
            {setUsage.byFavouriteType.length > 0 && (
                <ul className={styles.usageBreakdown}>
                    {setUsage.byFavouriteType.map((row) => (
                        <li key={row.favouriteType}>
                            <span>{favouriteTypeLabel(row.favouriteType)}</span>
                            <span>{favouritesLabel(row.favourites)}</span>
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
