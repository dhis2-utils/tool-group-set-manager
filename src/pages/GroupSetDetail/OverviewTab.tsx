import i18n from '@dhis2/d2-i18n'
import {
    CircularLoader,
    NoticeBox,
    SingleSelectField,
    SingleSelectOption,
} from '@dhis2/ui'
import React from 'react'
import styles from './GroupSetDetail.module.css'
import {
    MatrixColumn,
    SummaryMatrix,
} from '@/components/SummaryMatrix/SummaryMatrix'
import { MatrixResult, ObjectRef, ScopeRef } from '@/engine/store'
import { GroupSetMeta } from '@/engine/types'
import { useEngineQuery } from '@/hooks/useEngineQuery'

interface Props {
    set: GroupSetMeta
    scope: ScopeRef
    rowLevel: number
    levels: { level: number; displayName: string }[]
    onRowLevel: (level: number) => void
    onCell: (row: ObjectRef | null, column: MatrixColumn) => void
}

export const OverviewTab = ({
    set,
    scope,
    rowLevel,
    levels,
    onRowLevel,
    onCell,
}: Props) => {
    const { data, isLoading, error } = useEngineQuery<MatrixResult>(
        'matrixFor',
        [set.id, scope, rowLevel]
    )
    const isHierarchical = set.objectType === 'organisationUnit'
    // `levels` only has entries once the organisationUnitLevels query
    // resolves; until then it is `[]`. @dhis2/ui's SingleSelect throws a
    // hard runtime error (not just a visual blank) if `selected` doesn't
    // match the value of any currently-rendered SingleSelectOption, so the
    // selector must not render at all while there is nothing for the
    // current `rowLevel` to match -- rather than rendering it with a
    // `selected` value that has no corresponding option yet.
    const canShowRowLevelSelector = isHierarchical && levels.length > 0
    return (
        <div className={styles.overview}>
            {canShowRowLevelSelector && (
                <SingleSelectField
                    label={i18n.t('Rows')}
                    selected={String(rowLevel)}
                    onChange={({ selected }) => onRowLevel(Number(selected))}
                    inputWidth="280px"
                >
                    {levels.map((l) => (
                        <SingleSelectOption
                            key={l.level}
                            value={String(l.level)}
                            // See the matching comment in GroupSetCard.tsx: any
                            // second argument to i18n.t (interpolation options
                            // included) makes this project's i18next-scanner
                            // treat the whole call as unextractable, so the
                            // level number is spliced in with plain JS
                            // templating instead of i18next's own {{level}}
                            // interpolation.
                            label={`${l.displayName} (${i18n.t('level')} ${l.level})`}
                        />
                    ))}
                </SingleSelectField>
            )}
            {error && <NoticeBox error>{error}</NoticeBox>}
            {isLoading || !data ? (
                <CircularLoader small />
            ) : (
                <SummaryMatrix
                    result={data}
                    onCell={onCell}
                    flat={!isHierarchical}
                />
            )}
        </div>
    )
}
