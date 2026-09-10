import i18n from '@dhis2/d2-i18n'
import { CircularLoader, NoticeBox } from '@dhis2/ui'
import { useVirtualizer } from '@tanstack/react-virtual'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import styles from './ObjectsTable.module.css'
import { MembershipControl } from '@/components/MembershipControl/MembershipControl'
import { StatusPill } from '@/components/StatusPill/StatusPill'
import { ObjectFilter } from '@/engine/queries'
import { ObjectsResult, ScopeRef } from '@/engine/store'
import { GroupSetMeta } from '@/engine/types'
import { useEngineQuery } from '@/hooks/useEngineQuery'
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

export const ObjectsTable = ({ set, scope, filter, search }: Props) => {
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
                                        disabled
                                        onChange={() => undefined}
                                    />
                                </span>
                            </div>
                        )
                    })}
                </div>
            </div>
        </div>
    )
}
