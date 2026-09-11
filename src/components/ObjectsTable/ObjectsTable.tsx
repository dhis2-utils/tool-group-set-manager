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
import { ObjectRef, ObjectsResult, ScopeRef } from '@/engine/store'
import { GroupMeta, GroupSetMeta } from '@/engine/types'
import { useEngineQuery } from '@/hooks/useEngineQuery'
import { useMembershipWrite } from '@/hooks/useMembershipWrite'
import { interpolate } from '@/utils/interpolate'

interface Props {
    set: GroupSetMeta
    scope: ScopeRef
    filter: ObjectFilter
}

type Row = ObjectsResult['items'][number]

/**
 * A loaded row plus the parent object its own page resolved alongside it
 * (D1: one `resolveParents` call per page, not per row -- see the effect
 * that appends pages below). `null` covers both "this object is a root"
 * (D2) and "this type has no hierarchy at all" (D3); the rendering layer
 * treats both the same way, by showing nothing.
 */
type LoadedRow = Row & { parent: ObjectRef | null }

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

// A stable empty array, so `pageIndexes` below does not manufacture a new
// argument identity on every render before the first page has landed --
// `useEngineQuery`'s query key is a JSON.stringify of the args, so content
// equality is all that matters, but a fresh `[]` literal here would still
// be harmless; this just avoids allocating one every render for no reason.
const EMPTY_INDEXES: number[] = []

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

/**
 * What has been loaded for one filter. `offset` is the offset of the page
 * currently being requested, and `rows` holds every page before it, so
 * `rows.length === offset` exactly while a request is outstanding and
 * `rows.length > offset` once its page has landed. That is what paces the
 * paging: one page in flight at a time, appended on arrival.
 */
interface Loaded {
    key: string
    rows: LoadedRow[]
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
 * Whether a landed page belongs to the list that is currently waiting for
 * it. All three checks matter:
 *
 * - `prev.key === filterKey`: the list this page is about to be folded into
 *   is still the one whose filter asked for it. Review round 1, Major-2:
 *   with `useEngineQuery`'s own masking in place (it never hands a consumer
 *   a result for arguments it has since stopped asking about --
 *   src/hooks/useEngineQuery.ts), `data` truthy already implies its filter
 *   matches the render it arrived on, which makes this specific clause hard
 *   to exercise through the React/effect timing the rest of this file's
 *   tests drive. It is exported and unit-tested directly below instead --
 *   defence in depth against a filter change resetting to a new (also
 *   offset-0) list while an older filter's own page is still landing, the
 *   exact fold this file's `withEngine` test suite is named for.
 * - `dataOffset === prev.offset`: this is the page the list is waiting for,
 *   not one for a different offset.
 * - `prev.rows.length === prev.offset`: the list is actually still waiting
 *   (nothing has appended this offset's page already) -- see the doc
 *   comment on `Loaded` above.
 */
export function isAwaitedPage(
    prev: Pick<Loaded, 'key' | 'offset' | 'rows'>,
    filterKey: string,
    dataOffset: number
): boolean {
    return (
        prev.key === filterKey &&
        dataOffset === prev.offset &&
        prev.rows.length === prev.offset
    )
}

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
export function computeMembershipChanges(
    row: Pick<Row, 'id' | 'groups'>,
    groups: GroupMeta[],
    chosenIndex: number
): GroupChange[] {
    // M6: the same rule `planAssignment` applies in the engine -- a move is
    // blocked when the target needs an addition and is not writable, or
    // when any group the object must leave is not writable. The membership
    // control disables those options too, but an invariant about what may
    // be written belongs in the layer that builds the write, not only in
    // the one that renders the choice.
    const target = groups[chosenIndex]
    const needsAddition = !row.groups.includes(chosenIndex)
    const deletionPositions = row.groups.filter((p) => p !== chosenIndex)
    if (
        (needsAddition && !target?.canWrite) ||
        deletionPositions.some((p) => groups[p] && !groups[p].canWrite)
    ) {
        return []
    }
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
    if (needsAddition) {
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
/**
 * M2: `engineError` and `historyError` are independent, and a single write
 * can surface both at once (the engine call and the history save are two
 * separate steps after the same confirmed server write). Each full
 * sentence names, first, that the server change is real, and then what
 * specifically did not follow it -- never joined fragments, and never
 * reusing the failure wording, since nothing here failed to reach the
 * server.
 */
function engineHistoryMessage(
    engineError: boolean,
    historyError: boolean
): string | undefined {
    if (engineError && historyError) {
        return i18n.t(
            'The change was saved to the server, but the screen could not be updated and it could not be recorded in History. Reload to see it.'
        )
    }
    if (engineError) {
        return i18n.t(
            'The change was saved to the server, but the screen could not be updated to show it. Reload to see it.'
        )
    }
    if (historyError) {
        return i18n.t(
            'The change was saved to the server, but could not be recorded in History.'
        )
    }
    return undefined
}

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

export const ObjectsTable = ({ set, scope, filter }: Props) => {
    // D3: only organisation units have a hierarchy at all; the level and
    // parent columns (and the resolveParents call below) are both gated on
    // this, the same flag the level column already used.
    const isOrgUnit = set.objectType === 'organisationUnit'
    const { write } = useMembershipWrite()
    // D5/I2: tracked per row, as a set of row ids currently writing, so
    // that only the row(s) actually writing are disabled -- never the
    // whole table -- and a different row's control stays fully live (can
    // start its own write) while another row's is outstanding. A second
    // click on the *same* row while its own write is still outstanding is
    // ignored rather than queued.
    const [writingRowIds, setWritingRowIds] = useState<ReadonlySet<string>>(
        () => new Set()
    )
    // M1: the change is computed once, on click, and carried through to the
    // write on confirm rather than recomputed from `row`/`index` a second
    // time -- nothing changes `row.groups` between the two (D4: no
    // optimistic update), so the two computations could never disagree
    // today, but carrying one result is what keeps that true by
    // construction rather than by coincidence.
    const [confirm, setConfirm] = useState<{
        row: Row
        index: number
        changes: GroupChange[]
    } | null>(null)
    // A failure ( `unaccounted`, nothing confirmed) is reported as
    // critical; `engineError`/`historyError` are reported as informational
    // -- see M2 below -- so the two need separate slots rather than one
    // shared banner fighting over its own severity.
    const [failureAlert, setFailureAlert] = useState<string | null>(null)
    const [infoAlert, setInfoAlert] = useState<string | null>(null)

    const handleGroupChoice = (row: Row, index: number) => {
        // D5/I2: per row, not per table -- a second click on the row
        // that is currently writing is ignored, but a different row's
        // control is fully live (its `disabled` prop below is never set
        // by another row's in-flight write).
        if (writingRowIds.has(row.id)) {
            return
        }
        const changes = computeMembershipChanges(row, set.groups, index)
        if (changes.length === 0) {
            // Already the sole member of the chosen group: a no-op, per D1.
            return
        }
        setConfirm({ row, index, changes })
    }

    const handleConfirm = async () => {
        if (!confirm) {
            return
        }
        const { row, index, changes } = confirm
        setConfirm(null)
        setWritingRowIds((prev) => new Set(prev).add(row.id))
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
            // `unaccounted` (a batch the server did not confirm at all)
            // means the assignment itself did not land -- the only case
            // reported as a failure.
            if (result.unaccounted.length > 0) {
                // M2: a single-object move is a deletion plus an addition,
                // and a partial write can land the deletions without the
                // addition -- leaving the object in no group at all, which
                // is the violation this app exists to find. "Try again"
                // alone did not say that, so the state the user may now be
                // looking at is named.
                setFailureAlert(
                    i18n.t(
                        'The group change could not be fully applied, so this object may now be in no group at all. Reload and check it before trying again.'
                    )
                )
            }
            // M2: `engineError` and `historyError` both mean the server
            // change already happened -- see useMembershipWrite's own doc
            // comment -- so neither is a failure. But silently dropping
            // them left a user whose change landed but wasn't reflected,
            // or wasn't recorded to History, with no signal at all. A
            // single, complete, non-critical sentence names what it is --
            // the change was saved -- and what did not follow it, chosen
            // between the three possible cases rather than built from
            // joined fragments (both can be true from the one write).
            const info = engineHistoryMessage(
                Boolean(result.engineError),
                Boolean(result.historyError)
            )
            if (info) {
                setInfoAlert(info)
            }
        } catch (e) {
            // M1: the same guard both dialogs have. `write()` does the
            // server write first and only then invalidates the cache,
            // records History and tells the engine -- so a rejection here
            // means the change may well be on the server. Swallowing it
            // (this was a bare try/finally) left the user with an
            // unhandled rejection and no signal at all.
            //
            // Deliberately no retry offer, here or in either dialog (the
            // parked "Retry not offered when write() rejects" item): a
            // rejection says nothing about which batches landed, so a
            // retry would resend an unknown amount of an unknown change.
            // Re-reading is the only honest next step.
            setFailureAlert(
                interpolate(
                    i18n.t(
                        'The result could not be confirmed — the change may have reached the server. Reload and check History to see what happened. ({message})'
                    ),
                    { message: e instanceof Error ? e.message : String(e) }
                )
            )
        } finally {
            setWritingRowIds((prev) => {
                const next = new Set(prev)
                next.delete(row.id)
                return next
            })
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

    // D1: one `resolveParents` call per landed page, not one per row -- the
    // indexes are derived from the page that just arrived (`data`), so this
    // query's args change once per page rather than once per row, and a
    // mutation that moved the resolution into the row-rendering loop below
    // would not change this call's argument count at all (it would just
    // make it wrong to rely on), which is why the per-page guarantee is
    // pinned by counting calls, not just by reading this comment.
    // Gated on `isOrgUnit` (D3): flat types have no hierarchy, so
    // `resolveParents` is never asked for them at all.
    const pageIndexes = useMemo(
        () => (data ? data.items.map((item) => item.index) : EMPTY_INDEXES),
        [data]
    )
    const { data: parentPage } = useEngineQuery<(ObjectRef | null)[]>(
        'resolveParents',
        [set.objectType, pageIndexes],
        isOrgUnit && Boolean(data)
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
        // D1/D3: for an org unit type, the page's rows and the parents
        // resolved for that same page must land together -- appending rows
        // before their parents landed would show a page with no parent
        // column for one render, and then risk mismatching row-for-row if a
        // later, different page's parents arrived first. A flat type never
        // asks for parents at all (`parentPage` stays undefined for it, so
        // this only waits for the org unit case).
        if (isOrgUnit && !parentPage) {
            return
        }
        setLoaded((prev) => {
            return isAwaitedPage(prev, filterKey, data.offset)
                ? {
                      ...prev,
                      rows: [
                          ...prev.rows,
                          ...data.items.map((item, i) => ({
                              ...item,
                              parent: isOrgUnit
                                  ? (parentPage?.[i] ?? null)
                                  : null,
                          })),
                      ],
                      total: data.total,
                  }
                : prev
        })
    }, [data, parentPage, filterKey, isOrgUnit])

    const rows = current.rows

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
    const requestNextPage =
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
    // Org unit rows: Name / Parent / Level / Status / Group. Flat types
    // have no hierarchy at all, so just Name / Status / Group.
    const gridStyle = {
        gridTemplateColumns: isOrgUnit ? undefined : '3fr 130px 2fr',
    }
    return (
        <div>
            <p className={styles.count}>
                {objectsCountLabel(current.total)}
                {isLoading && ` · ${i18n.t('Loading more rows…')}`}
            </p>
            <div className={styles.head} style={gridStyle}>
                <span>{i18n.t('Name')}</span>
                {isOrgUnit && <span>{i18n.t('Parent')}</span>}
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
                                {isOrgUnit && (
                                    <span data-test={`parent-${r.id}`}>
                                        {/* D2: a root shows nothing, not a
                                            dash -- a dash in a data column
                                            reads as data. D4: a parent that
                                            could not be resolved to a name
                                            also shows nothing, never its
                                            raw id (the reason this column
                                            was dropped in Plan 1). */}
                                        {r.parent?.displayName ?? ''}
                                    </span>
                                )}
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
                                            writingRowIds.has(r.id)
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
            {failureAlert && (
                <AlertBar critical onHidden={() => setFailureAlert(null)}>
                    {failureAlert}
                </AlertBar>
            )}
            {infoAlert && (
                <AlertBar onHidden={() => setInfoAlert(null)}>
                    {infoAlert}
                </AlertBar>
            )}
        </div>
    )
}
