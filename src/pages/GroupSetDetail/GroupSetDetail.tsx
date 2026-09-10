import i18n from '@dhis2/d2-i18n'
import { Button, Tab, TabBar, Tag } from '@dhis2/ui'
import React, { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import styles from './GroupSetDetail.module.css'
import { ObjectsTab } from './ObjectsTab'
import { OverviewTab } from './OverviewTab'
import { MatrixColumn } from '@/components/SummaryMatrix/SummaryMatrix'
import { ObjectFilter } from '@/engine/queries'
import { ObjectRef, ScopeRef } from '@/engine/store'
import { Status } from '@/engine/types'
import { useEngine } from '@/hooks/useEngine'
import { useScope } from '@/hooks/useScope'
import { useUserScope } from '@/hooks/useUserScope'
import { useApiDataQuery } from '@/utils/useApiDataQuery'

interface LevelsResponse {
    organisationUnitLevels: { level: number; displayName: string }[]
}

type DetailTab = 'overview' | 'objects'

export const GroupSetDetail = () => {
    const { setId = '' } = useParams()
    const { groupSets } = useEngine()
    const { rootId, rootName } = useScope()
    const { roots } = useUserScope()
    const set = groupSets.find((s) => s.id === setId)
    const [tab, setTab] = useState<DetailTab>('overview')
    const [filter, setFilter] = useState<ObjectFilter>({})

    const scopeLevel = roots.find((r) => r.id === rootId)?.level ?? 1
    const [rowLevel, setRowLevel] = useState(scopeLevel + 1)
    const { data: levelsData } = useApiDataQuery<LevelsResponse>({
        queryKey: ['organisationUnitLevels'],
        query: {
            resource: 'organisationUnitLevels',
            params: { fields: 'level,displayName', paging: false },
        },
        staleTime: Infinity,
    })
    const levels = useMemo(
        () =>
            (levelsData?.organisationUnitLevels ?? [])
                .filter((l) => l.level > scopeLevel)
                .sort((a, b) => a.level - b.level),
        [levelsData, scopeLevel]
    )

    if (!set) {
        return <p>{i18n.t('Group set not found or not loaded yet.')}</p>
    }
    const scope: ScopeRef = {
        objectType: set.objectType,
        rootId: set.objectType === 'organisationUnit' ? rootId : null,
    }

    const onCell = (row: ObjectRef | null, column: MatrixColumn) => {
        const next: ObjectFilter = {}
        if (row) {
            next.ancestor = row.index
        }
        if (column.kind === 'group') {
            next.group = column.index
        } else if (column.kind === 'missing') {
            next.statuses = [Status.MissingError, Status.MissingWarning]
        } else if (column.kind === 'conflict') {
            next.statuses = [Status.Conflict]
        }
        setFilter(next)
        setTab('objects')
    }

    return (
        <div className={styles.page}>
            <Link to="/">{i18n.t('Dashboard')}</Link>
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>{set.displayName}</h1>
                    <div className={styles.badges}>
                        {set.compulsory && (
                            <Tag positive>{i18n.t('Compulsory')}</Tag>
                        )}
                        {set.dataDimension && (
                            <Tag positive>{i18n.t('Data dimension')}</Tag>
                        )}
                        <Tag neutral>
                            {set.groups.map((g) => g.displayName).join(' · ')}
                        </Tag>
                        {set.objectType === 'organisationUnit' && (
                            <Tag
                                neutral
                            >{`${i18n.t('Scope')}: ${rootName}`}</Tag>
                        )}
                    </div>
                </div>
                <div className={styles.actions}>
                    <Button small disabled title={i18n.t('Not available yet')}>
                        {i18n.t('Set properties…')}
                    </Button>
                    <Button small disabled title={i18n.t('Not available yet')}>
                        {i18n.t('Fix issues…')}
                    </Button>
                </div>
            </div>
            <TabBar>
                <Tab
                    selected={tab === 'overview'}
                    onClick={() => setTab('overview')}
                >
                    {i18n.t('Overview')}
                </Tab>
                <Tab
                    selected={tab === 'objects'}
                    onClick={() => setTab('objects')}
                >
                    {i18n.t('Objects')}
                </Tab>
            </TabBar>
            {tab === 'overview' ? (
                <OverviewTab
                    set={set}
                    scope={scope}
                    rowLevel={rowLevel}
                    levels={levels}
                    onRowLevel={setRowLevel}
                    onCell={onCell}
                />
            ) : (
                <ObjectsTab
                    set={set}
                    scope={scope}
                    filter={filter}
                    onFilter={setFilter}
                    levels={levels}
                />
            )}
        </div>
    )
}
