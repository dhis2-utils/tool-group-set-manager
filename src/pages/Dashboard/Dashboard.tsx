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
import { TYPE_LABEL } from '@/utils/objectTypeLabels'

const hasIssues = (e: DashboardEntry) =>
    e.summary.conflict + e.summary.missingError + e.summary.missingWarning > 0

// See the matching comment in GroupSetCard.tsx: a single i18n.t(key, {
// count, defaultValue_plural }) call neither pluralises at runtime with
// this i18next version nor gets picked up by this project's i18n extractor
// at all (any second argument makes a call invisible to it), so this stays
// two fully literal, argument-free i18n.t calls with the count spliced in
// separately.
const hiddenSetsLabel = (count: number) =>
    `${count} ${
        count === 1
            ? i18n.t('set without issues hidden')
            : i18n.t('sets without issues hidden')
    }`

export const Dashboard = () => {
    const { client, status, error } = useEngine()
    const { rootId, isReady } = useScope()
    const navigate = useNavigate()
    const [onlyIssues, setOnlyIssues] = useState(true)
    const [entries, setEntries] = useState<
        Partial<Record<ObjectType, DashboardEntry[]>>
    >({})
    const [typeErrors, setTypeErrors] = useState<
        Partial<Record<ObjectType, string>>
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
                    .then((result) => ({
                        entries: result,
                        error: null as string | null,
                    }))
                    // A stale or otherwise unrecognised root id makes the
                    // engine throw for the type it applies to (the store
                    // throws when a scope root id isn't among a loaded
                    // type's objects); one bad scope must not blank out
                    // every other type's cards, and the failure must stay
                    // visible rather than silently rendering as "no group
                    // sets of this type".
                    .catch((e: unknown) => ({
                        entries: [] as DashboardEntry[],
                        error: e instanceof Error ? e.message : String(e),
                    }))
            )
        ).then((results) => {
            if (cancelled) {
                return
            }
            const nextEntries: Partial<Record<ObjectType, DashboardEntry[]>> =
                {}
            const nextErrors: Partial<Record<ObjectType, string>> = {}
            OBJECT_TYPES.forEach((type, i) => {
                nextEntries[type] = results[i].entries
                if (results[i].error) {
                    nextErrors[type] = results[i].error as string
                }
            })
            setEntries(nextEntries)
            setTypeErrors(nextErrors)
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
                const typeError = typeErrors[type]
                const shown = onlyIssues
                    ? all.filter((e) => hasIssues(e) || !e.hasData)
                    : all
                const hidden = all.length - shown.length
                if (all.length === 0 && !typeError) {
                    return null
                }
                return (
                    <section key={type}>
                        <h2 className={styles.heading}>{TYPE_LABEL[type]}</h2>
                        {typeError && (
                            <NoticeBox
                                error
                                title={i18n.t(
                                    "This type's summary could not be computed"
                                )}
                            >
                                {typeError}
                            </NoticeBox>
                        )}
                        {shown.length > 0 && (
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
                        )}
                        {hidden > 0 && (
                            <p className={styles.note}>
                                {hiddenSetsLabel(hidden)}
                            </p>
                        )}
                    </section>
                )
            })}
        </div>
    )
}
