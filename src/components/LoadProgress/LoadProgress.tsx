import i18n from '@dhis2/d2-i18n'
import { LinearLoader, NoticeBox } from '@dhis2/ui'
import React from 'react'
import { LoadStatus } from '@/data/loadAll'
import { ObjectType } from '@/engine/types'
import { TYPE_LABEL } from '@/pages/Dashboard/Dashboard'

const PHASE_LABEL: Record<LoadStatus['phase'], string> = {
    groupSets: i18n.t('Loading group sets'),
    objects: i18n.t('Loading objects'),
    memberships: i18n.t('Loading group memberships'),
    names: i18n.t('Loading names'),
    evaluate: i18n.t('Checking rules'),
    done: i18n.t('Done'),
}

export const LoadProgress = ({ status }: { status: LoadStatus | null }) => {
    if (!status) {
        return <LinearLoader amount={0} />
    }
    const errors = Object.entries(status.errors) as [ObjectType, string][]
    if (status.phase === 'done') {
        return errors.length === 0 ? null : (
            <NoticeBox error title={i18n.t('Some data could not be loaded')}>
                {errors.map(([type, message]) => (
                    <div key={type}>
                        {TYPE_LABEL[type]}: {message}
                    </div>
                ))}
            </NoticeBox>
        )
    }
    const p = status.progress
    const amount = p && p.total ? Math.round((100 * p.done) / p.total) : 0
    const detail = p
        ? ` (${p.label} ${p.total ? `${p.done}/${p.total}` : ''})`
        : ''
    return (
        <div>
            <LinearLoader amount={amount} />
            <small>
                {PHASE_LABEL[status.phase]}
                {status.type ? `: ${TYPE_LABEL[status.type]}` : ''}
                {detail}
            </small>
        </div>
    )
}
