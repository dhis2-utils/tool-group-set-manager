import { Cache, CachedType } from './cache'
import { ENDPOINTS } from './endpoints'
import { groupIdsFor, loadGroupSets } from './groupSets'
import {
    DataSource,
    fetchJson,
    Fetcher,
    NamedId,
    Progress,
} from './sources/DataSource'
import { EngineClient } from '@/engine/client'
import { GroupSetMeta, OBJECT_TYPES, ObjectType } from '@/engine/types'

export type LoadPhase =
    | 'groupSets'
    | 'objects'
    | 'memberships'
    | 'names'
    | 'evaluate'
    | 'done'

export interface LoadStatus {
    phase: LoadPhase
    type: ObjectType | null
    progress: Progress | null
    fromCache: Partial<Record<ObjectType, boolean>>
    errors: Partial<Record<ObjectType, string>>
}

type EngineLike = Pick<EngineClient, 'call'>

interface Deps {
    source: DataSource
    fetcher: Fetcher
    cache: Cache
    engine: EngineLike
    onStatus: (s: LoadStatus) => void
    forceRefresh?: boolean
}

function sameIds(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i])
}

async function objectTotal(
    fetcher: Fetcher,
    type: ObjectType
): Promise<number> {
    const body = await fetchJson<{ pager: { total: number } }>(
        fetcher,
        `${ENDPOINTS[type].collection}?fields=id&pageSize=1`
    )
    return body.pager.total
}

/** Names come back keyed by id; align them to the payload's id order. */
export function alignNames(ids: string[], named: NamedId[]): string[] {
    const byId = new Map(named.map((n) => [n.id, n.displayName]))
    return ids.map((id) => byId.get(id) ?? id)
}

export async function loadAll(
    deps: Deps
): Promise<{ groupSets: GroupSetMeta[] }> {
    const status: LoadStatus = {
        phase: 'groupSets',
        type: null,
        progress: null,
        fromCache: {},
        errors: {},
    }
    const emit = (patch: Partial<LoadStatus>) => {
        Object.assign(status, patch)
        deps.onStatus({
            ...status,
            fromCache: { ...status.fromCache },
            errors: { ...status.errors },
        })
    }

    emit({ phase: 'groupSets' })
    const groupSets = await loadGroupSets(deps.fetcher)
    // The engine's evaluate() only recomputes what setGroupSets last told it
    // about; this call must land before the first evaluate below (and it
    // does, since evaluate is only ever reached inside or after the loop
    // that follows) or every set would evaluate against stale/no group
    // definitions.
    await deps.engine.call('setGroupSets', groupSets)

    // Org units are the heavy type; load them first so the dashboard can show
    // their numbers while the small types finish.
    for (const type of OBJECT_TYPES) {
        const groupIds = groupIdsFor(groupSets, type)
        if (groupIds.length === 0) {
            continue // no group sets of this type: nothing to evaluate
        }
        try {
            const reused = deps.forceRefresh
                ? undefined
                : await tryCache(deps, type, groupIds)
            if (reused) {
                await deps.engine.call('loadObjects', reused.objects)
                await deps.engine.call('loadMemberships', reused.memberships)
                if (reused.names) {
                    await deps.engine.call('setNames', type, reused.names)
                }
                status.fromCache[type] = true
                emit({ type })
                continue
            }

            emit({ phase: 'objects', type, progress: null })
            const objects = await deps.source.loadObjects(type, (p) =>
                emit({ phase: 'objects', type, progress: p })
            )
            await deps.engine.call('loadObjects', objects)

            emit({ phase: 'memberships', type, progress: null })
            const memberships = await deps.source.loadMemberships(
                type,
                groupIds,
                (p) => emit({ phase: 'memberships', type, progress: p })
            )
            await deps.engine.call('loadMemberships', memberships)
            emit({ phase: 'evaluate', type })
            await deps.engine.call('evaluate')

            let names = objects.names
            if (!names) {
                emit({ phase: 'names', type, progress: null })
                names = alignNames(
                    objects.ids,
                    await deps.source.loadNames(type)
                )
                await deps.engine.call('setNames', type, names)
            }

            // A total of zero means the collection is (as far as the server
            // is concerned) empty. That's indistinguishable from a total
            // endpoint that hiccupped, and caching it would mean the next
            // load "validates" against that same zero forever. Empty
            // results earn nothing from caching anyway, so they're simply
            // never written.
            const total = await objectTotal(deps.fetcher, type).catch(
                () => objects.ids.length
            )
            if (total > 0) {
                const entry: CachedType = {
                    objects,
                    memberships,
                    names,
                    groupIds,
                    objectTotal: total,
                    savedAt: Date.now(),
                }
                await deps.cache.put(type, entry)
            }
        } catch (error) {
            status.errors[type] =
                error instanceof Error ? error.message : String(error)
            emit({ type })
        }
    }

    emit({ phase: 'evaluate', type: null, progress: null })
    await deps.engine.call('evaluate')
    emit({ phase: 'done', type: null, progress: null })
    return { groupSets }
}

async function tryCache(
    deps: Deps,
    type: ObjectType,
    groupIds: string[]
): Promise<CachedType | undefined> {
    const cached = await deps.cache.get(type)
    if (!cached || !sameIds(cached.groupIds, groupIds)) {
        return undefined
    }
    const total = await objectTotal(deps.fetcher, type).catch(() => -1)
    return total > 0 && total === cached.objectTotal ? cached : undefined
}
