import i18n from '@dhis2/d2-i18n'
import React, { useMemo } from 'react'
import styles from './ChangeSetPreview.module.css'
import type { GroupChange } from '@/engine/changeSet'
import type { GroupMeta } from '@/engine/types'
import { interpolate } from '@/utils/interpolate'

export interface PreviewRow {
    id: string
    displayName: string | null
    /** group positions (indexes into `groups`) the object currently holds */
    groups: number[]
}

export interface SkippedRow {
    id: string
    displayName: string | null
}

export interface ChangeSetPreviewObjects {
    /** size of the population the plan was computed over */
    total: number
    /** the first page of the population, Name/Now/After sample rows */
    sample: PreviewRow[]
    /**
     * How many objects the plan could not touch. Kept apart from
     * `skippedSample` (I4): the exact count is cheap and always shown, but
     * the ids themselves are capped upstream (`SKIPPED_SAMPLE_LIMIT` in
     * `src/engine/store.ts`), so this component must never assume
     * `skippedSample.length === skippedCount`.
     */
    skippedCount: number
    /** a bounded sample of the skipped objects, resolved to display names */
    skippedSample: SkippedRow[]
    /**
     * Why those objects were skipped, which differs by caller and must not
     * be guessed. An assignment plan skips for exactly one reason, so it
     * says so. A revert skips for three -- the object has moved since, its
     * group has left the set, or a group involved is read-only -- and
     * naming only the last of those told the user the wrong thing in the
     * dominant case. Defaults to the assignment reason so existing callers
     * keep their precise wording.
     */
    skipReason?: 'readOnly' | 'revert'
}

interface Props {
    changes: GroupChange[]
    groups: GroupMeta[]
    objects: ChangeSetPreviewObjects
}

const noGroupLabel = () => i18n.t('No group')

/**
 * Every group name the row currently belongs to, joined for display. Used
 * as-is for the Now column, and also as the starting point for After,
 * which then applies `changes` on top of it -- so After can never disagree
 * with what `changes` will actually write (D3).
 */
function namesOf(positions: number[], groups: GroupMeta[]): string {
    const names = positions
        .map((p) => groups[p]?.displayName)
        .filter((n): n is string => Boolean(n))
    return names.length > 0 ? names.join(', ') : noGroupLabel()
}

/**
 * The group ids a row would end up in after `changes` is applied, derived
 * from the row's own current groups plus that same `changes` -- never a
 * second, independent guess at the outcome. This is what keeps the After
 * column unable to disagree with what will actually be written.
 */
/**
 * M1: the one place this arithmetic lives. `BulkFixDialog`'s CSV export
 * needs the exact same "what group would this row end up in" computation
 * (for its own After column) and imports this rather than keeping a
 * second copy that could quietly drift from what the preview shows.
 */
export interface PreparedChange {
    groupId: string
    additions: Set<string>
    deletions: Set<string>
}

/**
 * I2: the id arrays of a national fix hold the whole population, so
 * testing membership with `Array.includes` once per row is quadratic --
 * measured at roughly 99 seconds of blocking main-thread work for a
 * 200,000-object CSV export. A caller that applies the same `changes` to
 * many rows builds this once, outside its row loop, and the per-row cost
 * becomes a hash lookup per change.
 */
export function prepareChanges(changes: GroupChange[]): PreparedChange[] {
    return changes.map((change) => ({
        groupId: change.groupId,
        additions: new Set(change.additions),
        deletions: new Set(change.deletions),
    }))
}

/** `afterIds` against an already-prepared `changes` -- see `prepareChanges`. */
export function afterIdsPrepared(
    row: PreviewRow,
    groups: GroupMeta[],
    prepared: PreparedChange[]
): string[] {
    const ids = new Set(
        row.groups
            .map((p) => groups[p]?.id)
            .filter((id): id is string => Boolean(id))
    )
    prepared.forEach((change) => {
        if (change.deletions.has(row.id)) {
            ids.delete(change.groupId)
        }
        if (change.additions.has(row.id)) {
            ids.add(change.groupId)
        }
    })
    return [...ids]
}

/**
 * The one-shot form, for a caller with a single row (or a bounded sample)
 * in hand. Anything looping over a population must prepare once and call
 * `afterIdsPrepared` instead.
 */
export function afterIds(
    row: PreviewRow,
    groups: GroupMeta[],
    changes: GroupChange[]
): string[] {
    return afterIdsPrepared(row, groups, prepareChanges(changes))
}

function afterLabel(
    row: PreviewRow,
    groups: GroupMeta[],
    prepared: PreparedChange[]
): string {
    const ids = afterIdsPrepared(row, groups, prepared)
    if (ids.length === 0) {
        return noGroupLabel()
    }
    const names = ids
        .map((id) => groups.find((g) => g.id === id)?.displayName)
        .filter((n): n is string => Boolean(n))
    return names.length > 0 ? names.join(', ') : noGroupLabel()
}

const skippedMessage = (
    count: number,
    reason: 'readOnly' | 'revert' = 'readOnly'
) => {
    if (reason === 'revert') {
        return count === 1
            ? i18n.t(
                  '1 object was skipped because it has moved since this change, its group has left the set, or a group involved is read-only for you'
              )
            : interpolate(
                  i18n.t(
                      '{count} objects were skipped because they have moved since this change, their group has left the set, or a group involved is read-only for you'
                  ),
                  { count: count.toLocaleString() }
              )
    }
    return count === 1
        ? i18n.t(
              '1 object was skipped because a group involved is read-only for you'
          )
        : interpolate(
              i18n.t(
                  '{count} objects were skipped because a group involved is read-only for you'
              ),
              { count: count.toLocaleString() }
          )
}

export const ChangeSetPreview = ({ changes, groups, objects }: Props) => {
    // Prepared once per render rather than once per row. `prepareChanges`
    // builds a Set per group over the whole change, so calling `afterIds`
    // inside the row loop rebuilds every one of them for each of the
    // twenty sampled rows -- which is the same quadratic shape I2 removed
    // from the CSV export, just at sample scale instead of population
    // scale. At 200,000 ids that was measured in seconds per re-render.
    const prepared = useMemo(() => prepareChanges(changes), [changes])
    return (
        <div>
            <ul className={styles.lines}>
                {changes.map((change) => {
                    const group = groups.find((g) => g.id === change.groupId)
                    return (
                        <li key={change.groupId} className={styles.line}>
                            <span>{group?.displayName ?? change.groupId}</span>
                            <span className={styles.count}>
                                {`+${change.additions.length} / -${change.deletions.length}`}
                            </span>
                        </li>
                    )
                })}
            </ul>
            {objects.sample.length > 0 && (
                <table className={styles.table}>
                    <thead>
                        <tr>
                            <th>{i18n.t('Object')}</th>
                            <th>{i18n.t('Now')}</th>
                            <th>{i18n.t('After')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {objects.sample.map((row) => (
                            <tr key={row.id}>
                                <td>{row.displayName ?? row.id}</td>
                                <td>{namesOf(row.groups, groups)}</td>
                                <td>{afterLabel(row, groups, prepared)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            {objects.skippedCount > 0 && (
                <div className={styles.callout}>
                    <p>
                        {skippedMessage(
                            objects.skippedCount,
                            objects.skipReason
                        )}
                    </p>
                    {objects.skippedSample.length > 0 && (
                        <p>
                            {objects.skippedSample
                                .map((s) => s.displayName ?? s.id)
                                .join(', ')}
                            {objects.skippedCount >
                                objects.skippedSample.length && (
                                <>
                                    {' '}
                                    {interpolate(i18n.t('and {count} more'), {
                                        count: (
                                            objects.skippedCount -
                                            objects.skippedSample.length
                                        ).toLocaleString(),
                                    })}
                                </>
                            )}
                        </p>
                    )}
                </div>
            )}
        </div>
    )
}
