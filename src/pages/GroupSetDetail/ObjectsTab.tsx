import i18n from '@dhis2/d2-i18n'
import React from 'react'
import { ObjectFilter } from '@/engine/queries'
import { ScopeRef } from '@/engine/store'
import { GroupSetMeta } from '@/engine/types'

interface Props {
    set: GroupSetMeta
    scope: ScopeRef
    filter: ObjectFilter
    onFilter: (filter: ObjectFilter) => void
    levels: { level: number; displayName: string }[]
}

// Filled in by Task 13; this placeholder only needs to exist so
// GroupSetDetail compiles and can switch tabs. The props are already the
// real contract Task 13 fills in against, so they stay listed here even
// though nothing reads them yet.
export const ObjectsTab = (props: Props) => {
    void props
    return <p>{i18n.t('Objects list coming next')}</p>
}
