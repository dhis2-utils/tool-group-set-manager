import i18n from '@dhis2/d2-i18n'
import {
    Button,
    InputField,
    SingleSelectField,
    SingleSelectOption,
} from '@dhis2/ui'
import React, { useEffect, useRef, useState } from 'react'
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

// Every keystroke that reached the filter directly was a worker round trip
// and a full re-query at 200K scale, and the filter is also what the bulk
// fix dialog reads its population from -- a half-typed query must not be
// what a user opens that dialog on. 300ms after the last keystroke is what
// actually reaches `onFilter`; the input itself always shows the pending,
// undebounced value.
const SEARCH_DEBOUNCE_MS = 300

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
    // The input's own displayed value -- always the pending keystroke,
    // never delayed by the debounce below (spec: "the pending value is
    // what the input shows"). Seeded once from `filter.text` and from then
    // on changed only by typing -- it never re-syncs if `filter.text`
    // changes for a reason other than this debounce echoing it back (the
    // echoed value is always identical, so that round trip is invisible).
    // No caller does that today: `GroupSetDetail` only ever resets `filter`
    // to `{}` from `onCell`, which is reached from the Overview tab, so
    // this tab has already unmounted (and this state with it) by the time
    // it happens. If a future caller ever changes `filter.text` while this
    // tab stays mounted, the box would keep showing a query the table has
    // stopped applying -- worth a `useEffect` re-sync from `filter.text`
    // at that point, not before.
    const [searchInput, setSearchInput] = useState(filter.text ?? '')
    // `filter` is owned by the caller (GroupSetDetail) and can change for
    // reasons unrelated to search -- a status or level pick -- while a
    // debounce is outstanding. The ref (not an effect dependency) is what
    // lets the debounce apply `text` on top of whichever filter is current
    // when it actually fires, rather than the one in scope when typing
    // started.
    const filterRef = useRef(filter)
    filterRef.current = filter
    useEffect(() => {
        const handle = setTimeout(() => {
            const trimmed = searchInput.trim()
            const nextText = trimmed === '' ? undefined : trimmed
            // m1: without this check, every mount (and every render whose
            // debounce fires with nothing actually changed) called
            // `onFilter` with a fresh-but-equal object 300ms later --
            // harmless today only because `filterKey`'s `JSON.stringify`
            // drops an `undefined` field the same as a missing one, which
            // is too thin a coincidence to build on.
            if (nextText === (filterRef.current.text ?? undefined)) {
                return
            }
            onFilter({ ...filterRef.current, text: nextText })
        }, SEARCH_DEBOUNCE_MS)
        return () => clearTimeout(handle)
        // m3: `onFilter` is deliberately not a dependency here. It is
        // `GroupSetDetail`'s `setFilter`, a plain `useState` setter and so
        // guaranteed stable for the life of that component -- including it
        // would restart this debounce's timer on every render if a future
        // caller ever passed a fresh function identity instead, which is
        // not what "300ms after the last keystroke" is supposed to mean.
    }, [searchInput])
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
                    label={i18n.t('Search')}
                    value={searchInput}
                    onChange={({ value }) => setSearchInput(value ?? '')}
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
            <ObjectsTable set={set} scope={scope} filter={filter} />
        </div>
    )
}
