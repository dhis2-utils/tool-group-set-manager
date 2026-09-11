import i18n from '@dhis2/d2-i18n'
import {
    Button,
    InputField,
    SingleSelectField,
    SingleSelectOption,
} from '@dhis2/ui'
import React, { useState } from 'react'
import styles from './GroupSetDetail.module.css'
import { ObjectsTable } from '@/components/ObjectsTable/ObjectsTable'
import { ObjectFilter } from '@/engine/queries'
import { ScopeRef } from '@/engine/store'
import { GroupSetMeta, Status } from '@/engine/types'

interface Props {
    set: GroupSetMeta
    scope: ScopeRef
    filter: ObjectFilter
    onFilter: (filter: ObjectFilter) => void
    levels: { level: number; displayName: string }[]
    /** Opens the bulk fix dialog against this tab's current filter. */
    onBulkFix: () => void
}

type StatusChoice = 'all' | 'ok' | 'missing' | 'conflict'

const statusChoiceOf = (f: ObjectFilter): StatusChoice => {
    if (!f.statuses) {
        return 'all'
    }
    if (f.statuses.includes(Status.Conflict)) {
        return 'conflict'
    }
    if (f.statuses.includes(Status.Ok)) {
        return 'ok'
    }
    return 'missing'
}

const statusesOf = (c: StatusChoice): Status[] | undefined => {
    switch (c) {
        case 'ok':
            return [Status.Ok]
        case 'missing':
            return [Status.MissingError, Status.MissingWarning]
        case 'conflict':
            return [Status.Conflict]
        default:
            return undefined
    }
}

export const ObjectsTab = ({
    set,
    scope,
    filter,
    onFilter,
    levels,
    onBulkFix,
}: Props) => {
    const [search, setSearch] = useState('')
    const isOrgUnit = set.objectType === 'organisationUnit'
    // `levels` resolves asynchronously and can later narrow (the same
    // `organisationUnitLevels`/user-roots timing GroupSetDetail documents
    // for OverviewTab's row-level selector), so a `filter.level` set from
    // an earlier, wider `levels` list can stop matching any current
    // `SingleSelectOption` -- which `@dhis2/ui`'s `SingleSelectField`
    // treats as a hard render error, not a harmless mismatch (confirmed in
    // Task 12's browser check). Falling back to "All levels" is always
    // safe since that option is rendered unconditionally.
    const levelSelected =
        filter.level !== undefined &&
        levels.some((l) => l.level === filter.level)
            ? String(filter.level)
            : 'all'
    // `filter` state lives in GroupSetDetail, keyed by route rather than by
    // group set, so it survives switching to a different group set on the
    // same route -- a `filter.group` index valid for a previous set (say,
    // position 3 of a 4-group set) can arrive here for a set with fewer
    // groups. That is exactly the "selected with no matching option" crash
    // the level filter above already guards against, so this mirrors it:
    // -1 (no group) and -2 (conflict) are always valid, any other index
    // only if it is actually within this set's `groups`.
    const groupSelected =
        filter.group !== undefined &&
        (filter.group === -1 ||
            filter.group === -2 ||
            (filter.group >= 0 && filter.group < set.groups.length))
            ? String(filter.group)
            : 'all'
    return (
        <div>
            <div className={styles.filters}>
                <SingleSelectField
                    dense
                    label={i18n.t('Status')}
                    selected={statusChoiceOf(filter)}
                    onChange={({ selected }) =>
                        onFilter({
                            ...filter,
                            statuses: statusesOf(selected as StatusChoice),
                        })
                    }
                >
                    <SingleSelectOption value="all" label={i18n.t('All')} />
                    <SingleSelectOption value="ok" label={i18n.t('OK')} />
                    <SingleSelectOption
                        value="missing"
                        label={i18n.t('Missing')}
                    />
                    <SingleSelectOption
                        value="conflict"
                        label={i18n.t('Conflict')}
                    />
                </SingleSelectField>
                {isOrgUnit && (
                    <SingleSelectField
                        dense
                        label={i18n.t('Level')}
                        selected={levelSelected}
                        onChange={({ selected }) =>
                            onFilter({
                                ...filter,
                                level:
                                    selected === 'all'
                                        ? undefined
                                        : Number(selected),
                            })
                        }
                    >
                        <SingleSelectOption
                            value="all"
                            label={i18n.t('All levels')}
                        />
                        {levels.map((l) => (
                            <SingleSelectOption
                                key={l.level}
                                value={String(l.level)}
                                label={l.displayName}
                            />
                        ))}
                    </SingleSelectField>
                )}
                <SingleSelectField
                    dense
                    label={i18n.t('Group')}
                    selected={groupSelected}
                    onChange={({ selected }) =>
                        onFilter({
                            ...filter,
                            group:
                                selected === 'all'
                                    ? undefined
                                    : Number(selected),
                        })
                    }
                >
                    <SingleSelectOption value="all" label={i18n.t('Any')} />
                    <SingleSelectOption value="-1" label={i18n.t('No group')} />
                    <SingleSelectOption
                        value="-2"
                        label={i18n.t('Several groups (conflict)')}
                    />
                    {set.groups.map((g, i) => (
                        <SingleSelectOption
                            key={g.id}
                            value={String(i)}
                            label={g.displayName}
                        />
                    ))}
                </SingleSelectField>
                <InputField
                    dense
                    label={i18n.t('Search loaded rows')}
                    value={search}
                    onChange={({ value }) => setSearch(value ?? '')}
                />
                {filter.ancestor !== undefined && (
                    <button
                        type="button"
                        className={styles.clear}
                        onClick={() =>
                            onFilter({ ...filter, ancestor: undefined })
                        }
                    >
                        {i18n.t('Clear area filter')}
                    </button>
                )}
                <Button small onClick={onBulkFix}>
                    {i18n.t('Bulk fix…')}
                </Button>
            </div>
            <ObjectsTable
                set={set}
                scope={scope}
                filter={filter}
                search={search}
            />
        </div>
    )
}
