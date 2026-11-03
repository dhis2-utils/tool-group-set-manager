import { toCsv } from '@/data/csv'
import type { ChangeSet } from '@/engine/changeSet'
import { GROUP_SET_PROPERTY_KEYS } from '@/engine/changeSet'
import type { EngineClient } from '@/engine/client'
import type { ObjectRef } from '@/engine/store'
import type { GroupSetMeta } from '@/engine/types'

const HEADER = [
    'changeSetId',
    'createdAt',
    'createdBy',
    'groupSet',
    'action',
    'note',
    'revertOf',
    'objectId',
    'objectName',
    'groupId',
    'groupName',
    'operation',
    'property',
    'oldValue',
    'newValue',
]

/**
 * I4: spec 5.4's Export -- one row per recorded membership change, or, for
 * a change to the group set's properties (M11), one row per property, with
 * the change set's own metadata on every row so the file is
 * self-describing once downloaded. The three property columns are blank on
 * membership rows, and the object and group columns on property rows.
 */
export function exportRows(
    cs: ChangeSet,
    nameById: Map<string, string>,
    groupName: (groupId: string) => string
): string[][] {
    const meta = [
        cs.id,
        cs.createdAt,
        cs.createdBy.displayName,
        cs.groupSetName,
        cs.action,
        cs.note,
        cs.revertOf ?? '',
    ]
    const rows: string[][] = [HEADER]
    for (const change of cs.changes) {
        const addRow = (id: string, operation: string) => {
            rows.push([
                ...meta,
                id,
                nameById.get(id) ?? '',
                change.groupId,
                groupName(change.groupId),
                operation,
                '',
                '',
                '',
            ])
        }
        for (const id of change.additions) {
            addRow(id, 'added')
        }
        for (const id of change.deletions) {
            addRow(id, 'removed')
        }
    }
    const { properties } = cs
    if (properties) {
        for (const key of GROUP_SET_PROPERTY_KEYS) {
            const after = properties.after[key]
            if (after === undefined) {
                continue
            }
            const before = properties.before[key]
            rows.push([
                ...meta,
                '',
                '',
                '',
                '',
                'changed',
                key,
                before === undefined ? '' : String(before),
                String(after),
            ])
        }
    }
    return rows
}

/**
 * Object names for a change set's ids, resolved through the engine's plain
 * `indexesOf`/`resolve` (not `objectsFor`, which needs a group set the
 * engine still knows about -- Export must work even for a set that no
 * longer exists). I3: one round-trip for every id, not one per id.
 */
async function resolveNames(
    client: Pick<EngineClient, 'call'> | null,
    cs: ChangeSet
): Promise<Map<string, string>> {
    const ids = [
        ...new Set(cs.changes.flatMap((c) => [...c.additions, ...c.deletions])),
    ]
    const nameById = new Map<string, string>()
    if (!client || ids.length === 0) {
        return nameById
    }
    const allIndexes = await client.call<number[]>(
        'indexesOf',
        cs.objectType,
        ids
    )
    const indexes: number[] = []
    const idOfIndexPos: string[] = []
    allIndexes.forEach((idx, i) => {
        if (idx >= 0) {
            indexes.push(idx)
            idOfIndexPos.push(ids[i])
        }
    })
    if (indexes.length > 0) {
        const resolved = await client.call<ObjectRef[]>(
            'resolve',
            cs.objectType,
            indexes
        )
        resolved.forEach((r, i) => {
            nameById.set(idOfIndexPos[i], r.displayName ?? '')
        })
    }
    return nameById
}

/** Filesystem-unsafe characters a group set's own display name could contain. Same rule as BulkFixDialog's. */
function safeFileName(name: string): string {
    return name.replace(/[\\/:*?"<>|]/g, '_')
}

function downloadCsv(rows: string[][], fileName: string): void {
    const csv = toCsv(rows)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
}

export async function exportChangeSet(
    cs: ChangeSet,
    client: Pick<EngineClient, 'call'> | null,
    groupSets: GroupSetMeta[]
): Promise<void> {
    const nameById = await resolveNames(client, cs)
    const set = groupSets.find((s) => s.id === cs.groupSetId)
    const groupName = (groupId: string) =>
        set?.groups.find((g) => g.id === groupId)?.displayName ?? groupId
    downloadCsv(
        exportRows(cs, nameById, groupName),
        `${safeFileName(cs.groupSetName)}-${cs.id}.csv`
    )
}
