import i18n from '@dhis2/d2-i18n'
import { CircularLoader, NoticeBox } from '@dhis2/ui'
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
    onCell: (row: ObjectRef | null, column: MatrixColumn) => void
}

export const OverviewTab = ({ set, scope, rowLevel, onCell }: Props) => {
    const { data, isLoading, error } = useEngineQuery<MatrixResult>(
        'matrixFor',
        [set.id, scope, rowLevel]
    )
    const isHierarchical = set.objectType === 'organisationUnit'
    // The row level selector (and the level list it needs to render, incl.
    // display names) now lives in the bar above the tabs -- see
    // GroupSetDetail.tsx. All that is left here is the chosen level itself,
    // needed to run the query and to name it in the caption below.
    //
    // Every organisation unit group set -- compulsory or not -- evaluates
    // every organisation unit at every level (`populationFor` in
    // `src/engine/population.ts` never restricts an org unit set's
    // population by level), so the "above the row level" row is not
    // specific to compulsory sets: confirmed against the Sierra Leone demo,
    // where the non-compulsory "Area" set still has a non-empty one. What
    // *is* true, and known here rather than inside SummaryMatrix, is which
    // row level was actually chosen -- so that is what the caption names.
    // Without the level list (moved out with the selector) there is no
    // display name to put in it any more, so the caption now names the
    // level number itself rather than falling all the way back to
    // SummaryMatrix's generic default.
    //
    // One whole translated sentence with a placeholder filled in afterwards,
    // never a join of separately translated fragments -- see
    // src/utils/interpolate.ts.
    const aboveLevelCaption = isHierarchical
        ? interpolate(i18n.t('Includes organisation units above level {level}'), {
              level: rowLevel,
          })
        : undefined
    return (
        <div className={styles.overview}>
            {/* Data first, loader only when there is none. `useEngineQuery`
                clears its data the moment the arguments change, so whenever
                `data` is present it belongs to the scope and row level
                currently on screen -- and the loader shown while it is
                absent is a real "these numbers are being recomputed". The
                hook also re-runs (isLoading true, data kept) on every engine
                load phase and type change; checking isLoading first would
                replace the whole matrix with a spinner on each of those,
                several times per load. */}
            {error ? (
                <NoticeBox error>{error}</NoticeBox>
            ) : data ? (
                <SummaryMatrix
                    result={data}
                    onCell={onCell}
                    flat={!isHierarchical}
                    aboveLevelCaption={aboveLevelCaption}
                    // Only a set that is neither compulsory nor a data
                    // dimension can hold objects that are in no group and
                    // still Ok (spec 3.2); anywhere else the column would be
                    // a permanent zero.
                    showUnassigned={!set.compulsory && !set.dataDimension}
                />
            ) : isLoading ? (
                <CircularLoader small />
            ) : null}
        </div>
    )
}
