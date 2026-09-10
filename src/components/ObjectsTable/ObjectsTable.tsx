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

    // `useEngineQuery` itself is what makes a slow, superseded response
    // harmless: its effect is keyed on the full args (so a filter, scope or
    // limit change re-runs it), and its cleanup sets a `cancelled` flag
    // that the in-flight promise's `.then()` checks before calling
    // `setState` -- see src/hooks/useEngineQuery.ts. So a request for the
    // previous filter that resolves *after* a newer request has already
    // started can never land: its own effect was already cleaned up by
    // then, `cancelled` is already true, and its result is dropped. There
    // is deliberately no separate "does this response match the current
    // filter" bookkeeping here on top of that -- `objectsFor` always
    // returns the *complete* row list for whatever key was requested
    // (offset 0 through `limit`), never a delta to append, so there is
    // nothing to append stale rows onto in the first place.
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

    useEffect(() => {
        if (data && lastVisible >= rows.length - 50 && limit < data.total) {
            setLimit((l) => l + PAGE)
        }
    }, [lastVisible, rows.length, limit, data])

    if (error) {
        return <NoticeBox error>{error}</NoticeBox>
    }
    if (!data) {
        return <CircularLoader small />
    }
    const isOrgUnit = set.objectType === 'organisationUnit'
    const gridStyle = {
        gridTemplateColumns: isOrgUnit ? undefined : '3fr 130px 2fr',
    }
    return (
        <div>
            <p className={styles.count}>
                {objectsCountLabel(data.total)}
                {search && ` · ${i18n.t('search matches loaded rows only')}`}
                {isLoading && ` · ${i18n.t('updating…')}`}
            </p>
            <div className={styles.head} style={gridStyle}>
                <span>{i18n.t('Name')}</span>
                {isOrgUnit && <span>{i18n.t('Parent id')}</span>}
                {isOrgUnit && <span>{i18n.t('Level')}</span>}
                <span>{i18n.t('Status')}</span>
                <span>{i18n.t('Group in this set')}</span>
            </div>
            <div ref={parentRef} className={styles.scroll}>
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
                                {isOrgUnit && (
                                    <span title={r.parentId ?? ''}>
                                        {r.parentId ?? ''}
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
