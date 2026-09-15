import { CircularLoader, NoticeBox } from '@dhis2/ui'
import React, { useMemo } from 'react'
import styles from './GroupSetDetail.module.css'
import { GroupsPanel } from '@/components/GroupsPanel/GroupsPanel'
import { planColumns } from '@/components/SummaryMatrix/columnPlan'
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
    // Pre-composed, already-translated -- see SummaryMatrix's own doc for
    // this prop. GroupSetDetail builds it (it is the one place that still
    // holds `levels`, and so the chosen level's display name, after the row
    // level selector moved into the bar above the tabs); OverviewTab only
    // forwards it.
    aboveLevelCaption?: string
    onCell: (row: ObjectRef | null, column: MatrixColumn) => void
}

export const OverviewTab = ({
    set,
    scope,
    rowLevel,
    aboveLevelCaption,
    onCell,
}: Props) => {
    const { data, isLoading, error } = useEngineQuery<MatrixResult>(
        'matrixFor',
        [set.id, scope, rowLevel]
    )
    const isHierarchical = set.objectType === 'organisationUnit'
    // Computed once here, independent of SummaryMatrix's own `pinnedGroups`
    // state (which only partitions this same `ranked` array into
    // shown/other -- see columnPlan.ts): the panel always lists every group
    // ranked, whatever subset of columns the matrix currently shows, so the
    // two views of the same set cannot disagree.
    const plan = useMemo(() => (data ? planColumns(data) : null), [data])
    const populationTotal = useMemo(
        () => (data ? data.rows.reduce((s, r) => s + r.total, 0) : 0),
        [data]
    )
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
                <>
                    {plan && (
                        <GroupsPanel plan={plan} total={populationTotal} />
                    )}
                    <SummaryMatrix
                        result={data}
                        onCell={onCell}
                        flat={!isHierarchical}
                        aboveLevelCaption={aboveLevelCaption}
                        // Only a set that is neither compulsory nor a data
                        // dimension can hold objects that are in no group and
                        // still Ok (spec 3.2); anywhere else the column would
                        // be a permanent zero.
                        showUnassigned={!set.compulsory && !set.dataDimension}
                    />
                </>
            ) : isLoading ? (
                <CircularLoader small />
            ) : null}
        </div>
    )
}
