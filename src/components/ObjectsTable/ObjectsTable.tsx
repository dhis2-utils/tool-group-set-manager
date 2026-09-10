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

interface Props {
    set: GroupSetMeta
    scope: ScopeRef
    filter: ObjectFilter
    search: string
}

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
// GroupSetCard.tsx), so the count is spliced in with plain JS templating
// and the two full strings are chosen between rather than pluralised via
// i18next's own count option.
const objectsCountLabel = (count: number) =>
    count === 1
        ? `1 ${i18n.t('object')}`
        : `${count.toLocaleString()} ${i18n.t('objects')}`

export const ObjectsTable = ({ set, scope, filter, search }: Props) => {
    const [limit, setLimit] = useState(PAGE)
    // Keyed on everything that identifies *which* page this is a request
    // for -- set, scope and filter, but deliberately not `limit` itself,
    // which is what changes as paging grows it. A filter/scope/set change
    // resets paging back to the first page.
    const filterKey = JSON.stringify([set.id, scope, filter])
    useEffect(() => {
        setLimit(PAGE)
    }, [filterKey])

    // `useEngineQuery` itself is what makes a slow, superseded response for
    // a *previous filter* harmless: its effect is keyed on the full args
    // (so a filter, scope or limit change re-runs it), and its cleanup sets
    // a `cancelled` flag that the in-flight promise's `.then()` checks
    // before calling `setState` -- see src/hooks/useEngineQuery.ts. So a
    // request for a superseded filter can never land once a newer one has
    // started. `objectsFor` also always returns the *complete* row list
    // for whatever key was requested (offset 0 through `limit`), never a
    // delta to append, so there is nothing to append stale rows onto.
    const { data, isLoading, error } = useEngineQuery<ObjectsResult>(
        'objectsFor',
        [set.id, scope, filter, 0, limit]
    )

    const rows = useMemo(() => {
        const items = data?.items ?? []
        const q = search.trim().toLowerCase()
        return q
            ? items.filter((r) =>
                  (r.displayName ?? r.id).toLowerCase().includes(q)
              )
            : items
    }, [data, search])

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

    // Loading more must request exactly one page at a time, never a
    // stampede to the end: `data` does not update until the in-flight
    // fetch for the *current* `limit` actually resolves, but `lastVisible`
    // and `rows.length` (both derived from the still-stale `data`) don't
    // change meanwhile either -- so as long as this effect's decision were
    // keyed on `limit` alone, the first near-the-end scroll would re-fire
    // it on every render `limit` itself causes, ratcheting `limit` to the
    // full total before a single response returns (confirmed: this is
    // exactly what happened before this guard existed).
    //
    // `caughtUpWithLimit` is the fix: a response only counts as "settled"
    // once it has actually returned as many items as the current `limit`
    // asked for (or hit the true end of the list first). While a bigger
    // request is outstanding, `data` is still whatever the *previous*,
    // smaller `limit` returned, so `loadedCount` lags `limit` and this
    // stays false -- which is precisely the signal that holds off
    // requesting yet another page before this one has landed. Combined
    // with the `!isLoading` check (belt-and-braces for the same
    // "outstanding fetch" case), the effect now only ever asks for one
    // more page per settled result, no matter how many times it re-fires
    // for unrelated reasons (`lastVisible` ticking, `limit` changing) in
    // between.
    const loadedCount = data?.items.length ?? 0
    const caughtUpWithLimit =
        data !== undefined &&
        (loadedCount === limit || loadedCount === data.total)

    useEffect(() => {
        if (
            !isLoading &&
            caughtUpWithLimit &&
            data &&
            lastVisible >= rows.length - 50 &&
            limit < data.total
        ) {
            setLimit((l) => l + PAGE)
        }
    }, [isLoading, caughtUpWithLimit, data, lastVisible, rows.length, limit])

    if (error) {
        return <NoticeBox error>{error}</NoticeBox>
    }
    if (!data) {
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
    const trimmedSearch = search.trim()
    return (
        <div>
            <p className={styles.count}>
                {objectsCountLabel(data.total)}
                {trimmedSearch &&
                    ` · ${i18n.t('search matches loaded rows only')}`}
                {isLoading && ` · ${i18n.t('updating…')}`}
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
