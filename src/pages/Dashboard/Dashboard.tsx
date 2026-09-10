import i18n from '@dhis2/d2-i18n'
import { Checkbox, NoticeBox } from '@dhis2/ui'
import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import styles from './Dashboard.module.css'
import { GroupSetCard } from '@/components/GroupSetCard/GroupSetCard'
import { LoadProgress } from '@/components/LoadProgress/LoadProgress'
import { ScopeSelector } from '@/components/ScopeSelector/ScopeSelector'
import { DashboardEntry } from '@/engine/store'
import { OBJECT_TYPES, ObjectType } from '@/engine/types'
import { useEngine } from '@/hooks/useEngine'
import { useScope } from '@/hooks/useScope'

const TYPE_LABEL: Record<ObjectType, string> = {
    organisationUnit: i18n.t('Organisation unit group sets'),
    dataElement: i18n.t('Data element group sets'),
    indicator: i18n.t('Indicator group sets'),
    categoryOption: i18n.t('Category option group sets'),
}

const hasIssues = (e: DashboardEntry) =>
    e.summary.conflict + e.summary.missingError + e.summary.missingWarning > 0

export const Dashboard = () => {
    const { client, status, error } = useEngine()
    const { rootId, isReady } = useScope()
    const navigate = useNavigate()
    const [onlyIssues, setOnlyIssues] = useState(true)
    const [entries, setEntries] = useState<
        Partial<Record<ObjectType, DashboardEntry[]>>
    >({})

    useEffect(() => {
        if (!client || !isReady) {
            return
        }
        let cancelled = false
        Promise.all(
            OBJECT_TYPES.map((objectType) =>
                client
                    .call<DashboardEntry[]>('dashboard', {
                        objectType,
                        rootId:
                            objectType === 'organisationUnit' ? rootId : null,
                    })
                    // A stale or otherwise unrecognised root id makes the
                    // engine throw for the type it applies to; one bad
                    // scope must not blank out every other type's cards.
                    .catch(() => [] as DashboardEntry[])
            )
        ).then((results) => {
            if (!cancelled) {
                setEntries(
                    Object.fromEntries(
                        OBJECT_TYPES.map((t, i) => [t, results[i]])
                    )
                )
            }
        })
        return () => {
            cancelled = true
        }
    }, [client, rootId, isReady, status?.phase, status?.type])

    return (
        <div className={styles.page}>
            <div className={styles.toolbar}>
                <ScopeSelector />
                <Checkbox
                    checked={onlyIssues}
                    label={i18n.t('Only sets with issues')}
                    onChange={({ checked }) => setOnlyIssues(checked)}
                />
            </div>
            {error && (
                <NoticeBox error title={i18n.t('Loading failed')}>
                    {error}
                </NoticeBox>
            )}
            <LoadProgress status={status} />
            {OBJECT_TYPES.map((type) => {
                const all = entries[type] ?? []
                const shown = onlyIssues
                    ? all.filter((e) => hasIssues(e) || !e.hasData)
                    : all
                const hidden = all.length - shown.length
                if (all.length === 0) {
                    return null
                }
                return (
                    <section key={type}>
                        <h2 className={styles.heading}>{TYPE_LABEL[type]}</h2>
                        <div className={styles.cards}>
                            {shown.map((entry) => (
                                <GroupSetCard
                                    key={entry.set.id}
                                    entry={entry}
                                    onOpen={() =>
                                        navigate(`/sets/${entry.set.id}`)
                                    }
                                />
                            ))}
                        </div>
                        {hidden > 0 && (
                            <p className={styles.note}>
                                {i18n.t('{{count}} set without issues hidden', {
                                    count: hidden,
                                    defaultValue_plural:
                                        '{{count}} sets without issues hidden',
                                })}
                            </p>
                        )}
                    </section>
                )
            })}
        </div>
    )
}
