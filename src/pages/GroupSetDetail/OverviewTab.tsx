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
import { interpolate } from '@/utils/interpolate'

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
    // Every organisation unit group set -- compulsory or not -- evaluates
    // every organisation unit at every level (`populationFor` in
    // `src/engine/population.ts` never restricts an org unit set's
    // population by level), so the "above the row level" row is not
    // specific to compulsory sets: confirmed against the Sierra Leone demo,
    // where the non-compulsory "Area" set still has a non-empty one. What
    // *is* true, and known here rather than inside SummaryMatrix, is which
    // row level was actually chosen -- so that is what the caption names.
    const rowLevelLabel = levels.find((l) => l.level === rowLevel)?.displayName
    // One whole translated sentence with a placeholder filled in afterwards,
    // never a join of separately translated fragments -- see
    // src/utils/interpolate.ts.
    const aboveLevelCaption = rowLevelLabel
        ? interpolate(
              i18n.t('Includes organisation units above the {level} level'),
              { level: rowLevelLabel }
          )
        : undefined
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
                            // One complete string with placeholders rather
                            // than translated fragments joined in English
                            // word order -- see src/utils/interpolate.ts for
                            // why the call itself takes no second argument.
                            label={interpolate(
                                i18n.t('{name} (level {level})'),
                                {
                                    name: l.displayName,
                                    level: l.level,
                                }
                            )}
                        />
                    ))}
                </SingleSelectField>
            )}
            {isLoading ? (
                <CircularLoader small />
            ) : error ? (
                <NoticeBox error>{error}</NoticeBox>
            ) : (
                data && (
                    <SummaryMatrix
                        result={data}
                        onCell={onCell}
                        flat={!isHierarchical}
                        aboveLevelCaption={aboveLevelCaption}
                        // Only a set that is neither compulsory nor a data
                        // dimension can hold objects that are in no group
                        // and still Ok (spec 3.2); anywhere else the column
                        // would be a permanent zero.
                        showUnassigned={!set.compulsory && !set.dataDimension}
                    />
                )
            )}
        </div>
    )
}
