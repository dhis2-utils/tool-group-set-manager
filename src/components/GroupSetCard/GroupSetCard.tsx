import i18n from '@dhis2/d2-i18n'
import { Card, Tag } from '@dhis2/ui'
import React from 'react'
import styles from './GroupSetCard.module.css'
import { DashboardEntry } from '@/engine/store'

interface Props {
    entry: DashboardEntry
    onOpen: () => void
}

export const GroupSetCard = ({ entry, onOpen }: Props) => {
    const { set, summary, hasData } = entry
    const readOnlyGroups = set.groups.filter((g) => !g.canWrite).length
    return (
        <Card>
            <div
                className={styles.card}
                role="button"
                tabIndex={0}
                onClick={onOpen}
                onKeyDown={(e) => e.key === 'Enter' && onOpen()}
            >
                <div className={styles.name}>{set.displayName}</div>
                <div className={styles.badges}>
                    {set.compulsory && (
                        <Tag positive>{i18n.t('Compulsory')}</Tag>
                    )}
                    {set.dataDimension && (
                        <Tag positive>{i18n.t('Data dimension')}</Tag>
                    )}
                    <Tag neutral>
                        {i18n.t('{{count}} groups', {
                            count: set.groups.length,
                            defaultValue_plural: '{{count}} groups',
                        })}
                    </Tag>
                </div>
                {hasData ? (
                    <div className={styles.stats}>
                        <div className={styles.error}>
                            <div className={styles.value}>
                                {summary.conflict}
                            </div>
                            <div className={styles.label}>
                                {i18n.t('Conflicts')}
                            </div>
                        </div>
                        <div
                            className={
                                summary.missingError > 0
                                    ? styles.error
                                    : styles.warning
                            }
                        >
                            <div className={styles.value}>
                                {summary.missingError + summary.missingWarning}
                            </div>
                            <div className={styles.label}>
                                {i18n.t('Missing')}
                            </div>
                        </div>
                        <div className={styles.ok}>
                            <div className={styles.value}>{summary.ok}</div>
                            <div className={styles.label}>{i18n.t('OK')}</div>
                        </div>
                    </div>
                ) : (
                    <div className={styles.meta}>{i18n.t('Loading…')}</div>
                )}
                <div className={styles.meta}>
                    {readOnlyGroups > 0
                        ? i18n.t('{{count}} group read-only for you', {
                              count: readOnlyGroups,
                              defaultValue_plural:
                                  '{{count}} groups read-only for you',
                          })
                        : i18n.t('You can edit all groups')}
                </div>
            </div>
        </Card>
    )
}
