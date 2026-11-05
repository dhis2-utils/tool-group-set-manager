import i18n from '@dhis2/d2-i18n'
import {
    AlertBar,
    Button,
    ButtonStrip,
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
import {
    MembershipControl,
    NO_GROUP,
} from '@/components/MembershipControl/MembershipControl'
import { StatusPill } from '@/components/StatusPill/StatusPill'
import type { GroupChange } from '@/engine/changeSet'
import type { ObjectFilter } from '@/engine/queries'
import type { ObjectRef, ObjectsResult, ScopeRef } from '@/engine/store'
import type { GroupMeta, GroupSetMeta } from '@/engine/types'
import { Status } from '@/engine/types'
import { useEngineQuery } from '@/hooks/useEngineQuery'
import { useMembershipWrite } from '@/hooks/useMembershipWrite'
import { interpolate } from '@/utils/interpolate'
import { noGroupIsWarning } from '@/utils/noGroup'

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
const objectsCountLabel = (count: number, loadingMore: boolean) => {
    if (loadingMore) {
        return count === 1
            ? i18n.t('1 object, loading more rows…')
            : interpolate(i18n.t('{count} objects, loading more rows…'), {
                  count: count.toLocaleString(),
              })
    }
    return count === 1
        ? i18n.t('1 object')
        : interpolate(i18n.t('{count} objects'), {
              count: count.toLocaleString(),
          })
}

/**
 * What has been loaded for one filter. `offset` is the offset of the page
 * currently being requested, and `rows` holds every page before it, so
 * `rows.length === offset` exactly while a request is outstanding and
 * `rows.length > offset` once its page has landed. That is what paces the
 * paging: one page in flight at a time, appended on arrival.
 *
 * `after` is the id of the last row held when the page was requested: the
 * engine starts the page right after that object (M9a). `offset` alone is
 * wrong once an inline fix has moved a held row out of the filter -- the
 * engine's list is one shorter, and the next page by offset skips a row.
 * For the same reason `hasMore` (from the engine) decides whether there is
 * a next page, not a comparison of the held row count with `total`.
 */
interface Loaded {
    key: string
    rows: LoadedRow[]
    total: number | null
    offset: number
    after: string | null
    hasMore: boolean
}

const emptyLoad = (key: string): Loaded => ({
    key,
    rows: [],
    total: null,
    offset: 0,
    after: null,
    hasMore: false,
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
    if (chosenIndex === NO_GROUP) {
        // Removal only: leave every group the object holds. Blocked when any
        // of them is read-only, or the object would be left half removed.
        if (row.groups.some((p) => groups[p] && !groups[p].canWrite)) {
            return []
        }
        return row.groups
            .filter((p) => groups[p])
            .map((p) => ({
                groupId: groups[p].id,
                additions: [],
                deletions: [row.id],
            }))
    }
    const target = groups[chosenIndex]
    const needsAddition = !row.groups.includes(chosenIndex)
    const deletionPositions = row.groups.filter((p) => p !== chosenIndex)
    if (
        (needsAddition && !target?.canWrite) ||
        deletionPositions.some((p) => groups[p] && !groups[p].canWrite)
    ) {
        return []
    }
    // M4: the addition goes first. Each change is written in order, so if
    // the addition fails the object is left in a conflict (both groups),
    // which the tool still shows and can fix -- never in no group at all,
    // the "missing" state this tool exists to prevent. planAssignment
    // orders a bulk fix the same way.
    const changes: GroupChange[] = []
    if (needsAddition && target) {
        changes.push({
            groupId: target.id,
            additions: [row.id],
            deletions: [],
        })
    }
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
 *
 * F3: an `engineError` never means this row is wrong -- `handleConfirm`
 * updates this row's own state by construction, regardless of
 * `engineError`, before this message is even chosen. What `engineError`
 * means is that the engine itself (the worker state the dashboard and
 * matrix summary counts are read from) was not told, so those counts are
 * stale until a reload -- the wording below says that, not that "the
 * screen" is wrong, which the user can see is false on the very row they
 * are looking at.
 */
function engineHistoryMessage(
    engineError: boolean,
    historyError: boolean
): string | undefined {
    if (engineError && historyError) {
        return i18n.t(
            'The change was saved to the server and this row now reflects it, but the dashboard and matrix counts are stale until you reload, and it could not be recorded in History.'
        )
    }
    if (engineError) {
        return i18n.t(
            'The change was saved to the server and this row now reflects it, but the dashboard and matrix counts are stale until you reload.'
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

// One whole translated sentence with placeholders, never joined fragments
// -- see src/utils/interpolate.ts. No colon: the i18next-scanner reads one
// as its namespace separator and drops the key.
const assignedLabel = (name: string, group: string) =>
    interpolate(i18n.t('{name} is now in {group}'), { name, group })

const removedLabel = (name: string) =>
    interpolate(i18n.t('{name} is now in no group of this set'), { name })

// oxlint-disable-next-line complexity -- predates the lint migration; splitting it is a refactor of its own, not part of adopting the linter
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
    const [successAlert, setSuccessAlert] = useState<string | null>(null)
    // Identifies *which* list this is a page of. A set, scope or filter
    // change starts a new list from offset 0.
    const filterKey = JSON.stringify([set.id, scope, filter])
    const [loaded, setLoaded] = useState<Loaded>(() => emptyLoad(filterKey))

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
        // Cleared here, not just left to the AlertBar's own auto-hide, so a
        // second assign can never show a stale message -- success,
        // failure, or info -- about a different row.
        setSuccessAlert(null)
        setFailureAlert(null)
        setInfoAlert(null)
        setWritingRowIds((prev) => new Set(prev).add(row.id))
        try {
            const name = row.displayName ?? row.id
            const removing = index === NO_GROUP
            // A removal leaves the object's only group (deselecting is
            // offered only for an object in exactly one group).
            const groupName = removing
                ? row.groups.map((p) => set.groups[p]?.displayName).join(', ')
                : set.groups[index].displayName
            const result = await write({
                set,
                changes,
                action: removing ? 'unassign' : 'assign',
                note: removing
                    ? interpolate(i18n.t('Removed {name} from {group}'), {
                          name,
                          group: groupName,
                      })
                    : interpolate(i18n.t('Assigned {name} to {group}'), {
                          name,
                          group: groupName,
                      }),
                targetGroupId: removing ? undefined : set.groups[index].id,
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
                    removing
                        ? i18n.t(
                              'The object could not be removed from its group. Reload and check it before trying again.'
                          )
                        : i18n.t(
                              'The group change could not be fully applied, so this object may now be in no group at all. Reload and check it before trying again.'
                          )
                )
            } else {
                // The write is confirmed, and `useMembershipWrite` has
                // already told the engine. `loaded.rows` is this
                // component's own snapshot, though, and nothing re-requests
                // it -- so without this the control snaps back to its old
                // value and a successful write looks exactly like a failed
                // one.
                //
                // The new status is Status.Ok by construction rather than
                // by re-running the rule: `computeMembershipChanges` makes
                // the object the sole member of the chosen group, and
                // "exactly one group is Ok" is the one branch of
                // evaluateSet that holds for every kind of set (spec
                // 2026-09-15 §2.1).
                //
                // The row is deliberately left in the list even when it no
                // longer matches the filter (a "only missing" view, say).
                // Making it vanish at the moment of success is how the
                // user loses track of what they just did.
                // A removal leaves the object in no group, which the
                // control is offered for only on a set that is not
                // compulsory: allowed there (NoGroup), or a warning on a data dimension.
                const removedStatus = noGroupIsWarning(set)
                    ? Status.MissingWarning
                    : Status.NoGroup
                setLoaded((prev) => ({
                    ...prev,
                    rows: prev.rows.map((r) =>
                        r.id === row.id
                            ? removing
                                ? { ...r, groups: [], status: removedStatus }
                                : { ...r, groups: [index], status: Status.Ok }
                            : r
                    ),
                }))
                setSuccessAlert(
                    removing
                        ? removedLabel(name)
                        : assignedLabel(name, groupName)
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
    const { data, isLoading, error, refetch } = useEngineQuery<ObjectsResult>(
        'objectsFor',
        [set.id, scope, filter, current.offset, PAGE, current.after]
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
            if (isAwaitedPage(prev, filterKey, data.offset)) {
                return {
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
                    hasMore: data.hasMore,
                }
            }
            // The page already held, asked again because the engine's data
            // changed (an inline fix here, a write elsewhere): its rows stay
            // as they are (see handleConfirm on why a fixed row stays), but
            // the count follows the engine.
            if (
                prev.key === filterKey &&
                data.offset === prev.offset &&
                prev.total !== data.total
            ) {
                return { ...prev, total: data.total }
            }
            return prev
        })
    }, [data, parentPage, filterKey, isOrgUnit])

    const rows = current.rows

    const parentRef = useRef<HTMLDivElement>(null)
    // oxlint-disable-next-line react/incompatible-library -- a React Compiler notice; this app does not use the compiler, and @tanstack/react-virtual is its chosen virtualiser
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
        current.hasMore &&
        // The page for the current offset has landed (see Loaded).
        loadedCount > current.offset &&
        lastVisible >= loadedCount - 50

    useEffect(() => {
        if (!requestNextPage) {
            return
        }
        setLoaded((prev) =>
            prev.key === filterKey && prev.rows.length > prev.offset
                ? {
                      ...prev,
                      offset: prev.rows.length,
                      after: prev.rows[prev.rows.length - 1]?.id ?? null,
                  }
                : prev
        )
    }, [requestNextPage, filterKey])

    // A failed page names itself beside the rows already on screen rather
    // than replacing them -- losing two thousand loaded rows to one failed
    // request is the worse outcome -- and offers the one honest next step,
    // asking the engine again. Distinct from the deliberate no-retry on a
    // rejected write in handleConfirm above: a read that failed changed
    // nothing, so repeating it is safe.
    const errorNotice = error ? (
        <NoticeBox error title={i18n.t('Could not load this page of objects')}>
            {error}
            <div>
                <Button small onClick={refetch}>
                    {i18n.t('Try again')}
                </Button>
            </div>
        </NoticeBox>
    ) : null
    if (current.total === null) {
        return errorNotice ?? <CircularLoader small />
    }
    // Org unit rows: Name / Parent / Level / Status / Group. Flat types
    // have no hierarchy at all, so just Name / Status / Group.
    const gridStyle = {
        gridTemplateColumns: isOrgUnit
            ? undefined
            : '3fr 130px minmax(240px, 2fr)',
    }
    return (
        <div className={styles.table}>
            <p className={styles.count} data-test="objects-count">
                {objectsCountLabel(current.total, isLoading)}
            </p>
            {errorNotice}
            {/* L7: below about 700px the columns no longer fit; the head
                and the rows keep a minimum width and this wrapper scrolls
                sideways rather than clipping the group control. */}
            <div className={styles.hscroll}>
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
                            const disabledReason = disabledReasonFor(
                                r,
                                set.groups
                            )
                            return (
                                <div
                                    key={r.id}
                                    className={styles.row}
                                    data-test="objects-table-row"
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
                                            allowNone={!set.compulsory}
                                            onChange={(index) =>
                                                handleGroupChoice(r, index)
                                            }
                                        />
                                    </span>
                                </div>
                            )
                        })}
                    </div>
                    {current.total === 0 && (
                        <p className={styles.empty} data-test="objects-empty">
                            {i18n.t('No objects match this filter.')}
                        </p>
                    )}
                </div>
            </div>
            {confirm && (
                <Modal small position="middle" onClose={() => setConfirm(null)}>
                    <ModalTitle>{i18n.t('Confirm group change')}</ModalTitle>
                    <ModalContent>
                        <p>
                            {confirm.index === NO_GROUP
                                ? interpolate(
                                      i18n.t(
                                          '{name} will be removed from {group}, and will be in no group of this set'
                                      ),
                                      {
                                          name:
                                              confirm.row.displayName ??
                                              confirm.row.id,
                                          group: confirm.row.groups
                                              .map(
                                                  (p) =>
                                                      set.groups[p]?.displayName
                                              )
                                              .join(', '),
                                      }
                                  )
                                : interpolate(
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
                        {confirm.index === NO_GROUP &&
                            noGroupIsWarning(set) && (
                                <p>
                                    {i18n.t(
                                        'This set is a data dimension, so the data of an object in no group drops out when analytics is broken down by this set.'
                                    )}
                                </p>
                            )}
                    </ModalContent>
                    <ModalActions>
                        {/* ModalActions lays its children out with no gap
                            of its own; ButtonStrip is what spaces them
                            (the same pairing SetPropertiesDialog and
                            SummaryMatrix use). */}
                        <ButtonStrip end>
                            <Button secondary onClick={() => setConfirm(null)}>
                                {i18n.t('Cancel')}
                            </Button>
                            <Button primary onClick={handleConfirm}>
                                {confirm.index === NO_GROUP
                                    ? i18n.t('Remove')
                                    : i18n.t('Assign')}
                            </Button>
                        </ButtonStrip>
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
            {successAlert && (
                <AlertBar success onHidden={() => setSuccessAlert(null)}>
                    {successAlert}
                </AlertBar>
            )}
        </div>
    )
}
