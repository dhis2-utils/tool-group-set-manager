import i18n from '@dhis2/d2-i18n'
import {
    AlertBar,
    Button,
    CircularLoader,
    Modal,
    ModalActions,
    ModalContent,
    ModalTitle,
    NoticeBox,
} from '@dhis2/ui'
import { useVirtualizer } from '@tanstack/react-virtual'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import styles from './ObjectsTable.module.css'
import { MembershipControl } from '@/components/MembershipControl/MembershipControl'
import { StatusPill } from '@/components/StatusPill/StatusPill'
import { GroupChange } from '@/engine/changeSet'
import { ObjectFilter } from '@/engine/queries'
import { ObjectsResult, ScopeRef } from '@/engine/store'
import { GroupMeta, GroupSetMeta } from '@/engine/types'
import { useEngineQuery } from '@/hooks/useEngineQuery'
import { useMembershipWrite } from '@/hooks/useMembershipWrite'
import { interpolate } from '@/utils/interpolate'

interface Props {
    set: GroupSetMeta
    scope: ScopeRef
    filter: ObjectFilter
    search: string
}

type Row = ObjectsResult['items'][number]

const PAGE = 200
const ROW_HEIGHT = 36
// @tanstack/react-virtual measures its scroll container's real
// `offsetWidth`/`offsetHeight` on mount, with or without a `ResizeObserver`
// to keep that updated afterwards (checked in
// node_modules/.pnpm/@tanstack+virtual-core@3.17.9/.../dist/esm/index.js);
// `initialRect` only ever backstops a rect that has never been measured at
// all, so it matters for one instant before that first real measurement
// lands. This value is not a magic number chosen to satisfy that fallback:
// it is the same 600px `.scroll` is fixed at in the CSS below, so it is
// honestly what the container measures at in a real browser. (jsdom's
// `offsetHeight` is always zero regardless of CSS, which is why the test
// for this component additionally stubs it -- see the comment there.)
const INITIAL_RECT = { width: 800, height: 600 }

// A second argument to i18n.t makes this project's i18next-scanner treat
// the call as unextractable (see the matching comment in
// GroupSetCard.tsx), so the two full strings are chosen between on the
// count rather than pluralised via i18next's own count option, and the
// number goes into a placeholder inside the string rather than being glued
// to a translated fragment (src/utils/interpolate.ts).
const objectsCountLabel = (count: number) =>
    count === 1
        ? i18n.t('1 object')
        : interpolate(i18n.t('{count} objects'), {
              count: count.toLocaleString(),
          })

const searchNote = (loaded: number) =>
    interpolate(i18n.t('Search matches the {count} rows loaded so far'), {
        count: loaded.toLocaleString(),
    })

/**
 * What has been loaded for one filter. `offset` is the offset of the page
 * currently being requested, and `rows` holds every page before it, so
 * `rows.length === offset` exactly while a request is outstanding and
 * `rows.length > offset` once its page has landed. That is what paces the
 * paging: one page in flight at a time, appended on arrival.
 */
interface Loaded {
    key: string
    rows: Row[]
    total: number | null
    offset: number
}

const emptyLoad = (key: string): Loaded => ({
    key,
    rows: [],
    total: null,
    offset: 0,
})

/**
 * D1: the change is computed from the row's own current groups, not from
 * the whole set -- a deletion from each position the object currently
 * holds other than the chosen one, and an addition to the chosen one only
 * when it is not already held. A well-formed object moving between two
 * groups therefore produces exactly one addition and one deletion, never a
 * deletion per group in the set; clicking the group an object is already
 * the sole member of produces no changes at all, which the caller reads as
 * "nothing to write".
 */
function computeMembershipChanges(
    row: Row,
    groups: GroupMeta[],
    chosenIndex: number
): GroupChange[] {
    const changes: GroupChange[] = []
    row.groups.forEach((pos) => {
        if (pos !== chosenIndex) {
            const group = groups[pos]
            if (group) {
                changes.push({
                    groupId: group.id,
                    additions: [],
                    deletions: [row.id],
                })
            }
        }
    })
    if (!row.groups.includes(chosenIndex)) {
        const target = groups[chosenIndex]
        if (target) {
            changes.push({
                groupId: target.id,
                additions: [row.id],
                deletions: [],
            })
        }
    }
    return changes
}

/**
 * D2: the reason a control is disabled, named for the user rather than
 * merely implied by a greyed-out control. Only the groups the object
 * currently holds are checked -- those are the ones any move must be able
 * to write to, since every move removes the object from at least one of
 * them.
 */
function disabledReasonFor(row: Row, groups: GroupMeta[]): string | undefined {
    const unwritable = row.groups
        .map((pos) => groups[pos])
        .find((g) => g && !g.canWrite)
    return unwritable
        ? interpolate(i18n.t('{group} is read-only for you'), {
              group: unwritable.displayName,
          })
        : undefined
}

export const ObjectsTable = ({ set, scope, filter, search }: Props) => {
    const { write } = useMembershipWrite()
    // D5: one write in flight per table, tracked by which row asked for it
    // so only that row's controls are disabled -- not the whole table --
    // and a second click on the *same* row while its write is still
    // outstanding is ignored rather than queued.
    const [writingRowId, setWritingRowId] = useState<string | null>(null)
    const [confirm, setConfirm] = useState<{ row: Row; index: number } | null>(
        null
    )
    const [alert, setAlert] = useState<string | null>(null)

    const handleGroupChoice = (row: Row, index: number) => {
        if (writingRowId !== null) {
            return
        }
        const changes = computeMembershipChanges(row, set.groups, index)
        if (changes.length === 0) {
            // Already the sole member of the chosen group: a no-op, per D1.
            return
        }
        setConfirm({ row, index })
    }

    const handleConfirm = async () => {
        if (!confirm) {
            return
        }
        const { row, index } = confirm
        const changes = computeMembershipChanges(row, set.groups, index)
        setConfirm(null)
        if (changes.length === 0) {
            return
        }
        setWritingRowId(row.id)
        try {
            const name = row.displayName ?? row.id
            const groupName = set.groups[index].displayName
            const result = await write({
                set,
                changes,
                action: 'assign',
                note: interpolate(i18n.t('Assigned {name} to {group}'), {
                    name,
                    group: groupName,
                }),
                targetGroupId: set.groups[index].id,
            })
            // `engineError` and `historyError` both mean the server change
            // already happened -- see useMembershipWrite's own doc comment
            // -- so neither is reported here as a failed write. Only
            // `unaccounted` (a batch the server did not confirm at all)
            // means the assignment itself did not fully land.
            if (result.unaccounted.length > 0) {
                setAlert(
                    i18n.t(
                        'The group change could not be fully applied. Reload and try again.'
                    )
                )
            }
        } finally {
            setWritingRowId(null)
        }
    }

    // Identifies *which* list this is a page of. A set, scope or filter
    // change starts a new list from offset 0.
    const filterKey = JSON.stringify([set.id, scope, filter])
    const [loaded, setLoaded] = useState<Loaded>(() => emptyLoad(filterKey))
    // Reset during render, not from an effect. An effect would run after the
    // append effect below has already had a chance to fold the *previous*
    // filter's last page into the new filter's (empty) list; deriving the
    // reset here means the very first render after a filter change already
    // requests offset 0 and already renders no rows.
    const current = loaded.key === filterKey ? loaded : emptyLoad(filterKey)
    if (current !== loaded) {
        setLoaded(current)
    }

    // One page at a time, by offset -- never offset 0 with an ever-growing
    // limit. Growing the limit made every "load more" re-send and re-resolve
    // every row already on screen, so reaching row ten thousand of a
    // 266,000-row list moved a quarter of a million row objects across the
    // worker boundary instead of ten thousand.
    //
    // `useEngineQuery` is what makes a slow, superseded response harmless:
    // its effect is keyed on the full args (so a filter, scope or offset
    // change re-runs it) and its cleanup sets a `cancelled` flag the
    // in-flight promise checks before calling `setState` -- see
    // src/hooks/useEngineQuery.ts.
    const { data, isLoading, error } = useEngineQuery<ObjectsResult>(
        'objectsFor',
        [set.id, scope, filter, current.offset, PAGE]
    )

    // A result is appended only when it is *the page this list is waiting
    // for*: the same page it asked for (`data.offset`, echoed by the store)
    // and one it has not already taken (the `rows.length === offset`
    // invariant above holds only while that page is outstanding). Both
    // checks are needed because `useEngineQuery` re-issues the identical
    // request whenever the engine's load phase or type changes -- pressing
    // Reload with this tab open fires several -- and each re-issue resolves
    // to a fresh result object. Keying on object identity alone therefore
    // appended the page already held once per phase change, duplicating
    // rows and React keys and pushing the row count past `total`.
    useEffect(() => {
        if (!data) {
            return
        }
        setLoaded((prev) => {
            const isAwaitedPage =
                prev.key === filterKey &&
                data.offset === prev.offset &&
                prev.rows.length === prev.offset
            return isAwaitedPage
                ? {
                      ...prev,
                      rows: [...prev.rows, ...data.items],
                      total: data.total,
                  }
                : prev
        })
    }, [data, filterKey])

    const rows = useMemo(() => {
        const q = search.trim().toLowerCase()
        return q
            ? current.rows.filter((r) =>
                  (r.displayName ?? r.id).toLowerCase().includes(q)
              )
            : current.rows
    }, [current.rows, search])

    const parentRef = useRef<HTMLDivElement>(null)
    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 20,
        initialRect: INITIAL_RECT,
    })
    const virtualItems = virtualizer.getVirtualItems()
    const lastVisible = virtualItems[virtualItems.length - 1]?.index ?? 0

    const loadedCount = current.rows.length
    const searchActive = search.trim() !== ''
    // Two things this must not do. It must not measure "near the end"
    // against the search-filtered `rows`: a search matching a handful of the
    // loaded rows leaves the last visible index permanently within 50 of
    // that short list, so every settled response asked for another page
    // until the whole 266,000-row result set had been fetched, one worker
    // round-trip per page. And it must not page while a search is active at
    // all: the search only looks at rows already loaded, so paging in
    // service of it would be paging the entire list in the hope of a match.
    // The list is complete again the moment the search box is cleared.
    const requestNextPage =
        !searchActive &&
        !isLoading &&
        current.total !== null &&
        loadedCount < current.total &&
        // The page for the current offset has landed (see Loaded).
        loadedCount > current.offset &&
        lastVisible >= loadedCount - 50

    useEffect(() => {
        if (!requestNextPage) {
            return
        }
        setLoaded((prev) =>
            prev.key === filterKey && prev.rows.length > prev.offset
                ? { ...prev, offset: prev.rows.length }
                : prev
        )
    }, [requestNextPage, filterKey])

    if (error) {
        return <NoticeBox error>{error}</NoticeBox>
    }
    if (current.total === null) {
        return <CircularLoader small />
    }
    const isOrgUnit = set.objectType === 'organisationUnit'
    // Org unit rows: Name / Level / Status / Group. Flat types have no
    // hierarchy at all, so just Name / Status / Group. (Parent used to be
    // a column here too, but `ObjectRef.parentId` -- src/engine/store.ts,
    // not touched by this task -- is only ever a raw DHIS2 id with no name
    // resolution until Plan 2; showing it earned the column nothing beyond
    // "here is an opaque identifier", most visibly in the conflict view
    // where every row shares the same one, so it's dropped rather than
    // shown under an honest-but-unhelpful header.)
    const gridStyle = {
        gridTemplateColumns: isOrgUnit ? undefined : '3fr 130px 2fr',
    }
    return (
        <div>
            <p className={styles.count}>
                {objectsCountLabel(current.total)}
                {searchActive && ` · ${searchNote(loadedCount)}`}
                {isLoading && ` · ${i18n.t('Loading more rows…')}`}
            </p>
            <div className={styles.head} style={gridStyle}>
                <span>{i18n.t('Name')}</span>
                {isOrgUnit && <span>{i18n.t('Level')}</span>}
                <span>{i18n.t('Status')}</span>
                <span>{i18n.t('Group in this set')}</span>
            </div>
            <div
                ref={parentRef}
                className={styles.scroll}
                data-test="objects-table-scroll"
            >
                <div
                    style={{
                        height: virtualizer.getTotalSize(),
                        position: 'relative',
                    }}
                >
                    {virtualItems.map((v) => {
                        const r = rows[v.index]
                        const disabledReason = disabledReasonFor(r, set.groups)
                        return (
                            <div
                                key={r.id}
                                className={styles.row}
                                style={{
                                    ...gridStyle,
                                    transform: `translateY(${v.start}px)`,
                                }}
                            >
                                <span title={r.id}>
                                    {r.displayName ?? r.id}
                                </span>
                                {isOrgUnit && <span>{r.level}</span>}
                                <span>
                                    <StatusPill status={r.status} />
                                </span>
                                <span>
                                    <MembershipControl
                                        groups={set.groups}
                                        current={r.groups}
                                        disabled={
                                            Boolean(disabledReason) ||
                                            writingRowId === r.id
                                        }
                                        disabledReason={disabledReason}
                                        onChange={(index) =>
                                            handleGroupChoice(r, index)
                                        }
                                    />
                                </span>
                            </div>
                        )
                    })}
                </div>
            </div>
            {confirm && (
                <Modal small position="middle" onClose={() => setConfirm(null)}>
                    <ModalTitle>{i18n.t('Confirm group change')}</ModalTitle>
                    <ModalContent>
                        <p>
                            {interpolate(
                                i18n.t(
                                    '{name} will be assigned to {group} and removed from any other group in this set'
                                ),
                                {
                                    name:
                                        confirm.row.displayName ??
                                        confirm.row.id,
                                    group: set.groups[confirm.index]
                                        .displayName,
                                }
                            )}
                        </p>
                    </ModalContent>
                    <ModalActions>
                        <Button onClick={() => setConfirm(null)}>
                            {i18n.t('Cancel')}
                        </Button>
                        <Button primary onClick={handleConfirm}>
                            {i18n.t('Assign')}
                        </Button>
                    </ModalActions>
                </Modal>
            )}
            {alert && (
                <AlertBar critical onHidden={() => setAlert(null)}>
                    {alert}
                </AlertBar>
            )}
        </div>
    )
}
