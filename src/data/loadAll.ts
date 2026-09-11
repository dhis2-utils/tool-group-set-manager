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

/**
 * The `lastUpdated` stamp of every group of the type, keyed by id (spec 4.4).
 * Adding or removing a member updates the group, so this is what tells a
 * cached membership payload apart from the current one -- the group id list
 * and the object total are both unchanged by a move between groups.
 */
export async function groupStamps(
    fetcher: Fetcher,
    type: ObjectType
): Promise<Record<string, string>> {
    const groups = ENDPOINTS[type].groups
    const body = await fetchJson<
        Record<string, { id: string; lastUpdated?: string }[]>
    >(fetcher, `${groups}?fields=id,lastUpdated&paging=false`)
    const stamps: Record<string, string> = {}
    ;(body[groups] ?? []).forEach((g) => {
        stamps[g.id] = g.lastUpdated ?? ''
    })
    return stamps
}

function sameStamps(
    cached: Record<string, string> | undefined,
    current: Record<string, string>,
    groupIds: string[]
): boolean {
    if (!cached) {
        // An entry cached before stamps were stored cannot be verified.
        return false
    }
    return groupIds.every((id) => cached[id] === current[id])
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
    const { sets: groupSets, errors: groupSetErrors } = await loadGroupSets(
        deps.fetcher
    )
    // A type whose group sets could not be read is recorded and skipped
    // (spec 6.4); the types that did load carry on.
    Object.assign(status.errors, groupSetErrors)
    if (Object.keys(groupSetErrors).length > 0) {
        emit({})
    }
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
                // loadMemberships requires the type to already exist, so
                // these two calls can't be resolved-then-committed together
                // the way the fresh-load path below is. If the second call
                // fails after the first has landed, the engine would be
                // left holding objects with no membership data for this
                // type -- indistinguishable from every object being
                // uncategorised. dropType undoes the first call so a
                // failure here leaves the engine exactly as it was before
                // this type was attempted, same as the fresh-load path.
                try {
                    await deps.engine.call('loadObjects', reused.objects)
                    await deps.engine.call(
                        'loadMemberships',
                        reused.memberships
                    )
                    if (reused.names) {
                        await deps.engine.call('setNames', type, reused.names)
                    }
                } catch (error) {
                    await deps.engine.call('dropType', type)
                    throw error
                }
                status.fromCache[type] = true
                // A cache hit is at the same point a freshly loaded type is
                // right after its memberships land: data is in the engine
                // and only the (shared, end-of-loop) evaluate() is still to
                // come. Reusing 'evaluate' here, rather than patching only
                // `type`, means the phase can't be left showing whatever an
                // earlier type happened to leave behind.
                emit({ phase: 'evaluate', type, progress: null })
                continue
            }

            emit({ phase: 'objects', type, progress: null })
            const objects = await deps.source.loadObjects(type, (p) =>
                emit({ phase: 'objects', type, progress: p })
            )

            emit({ phase: 'memberships', type, progress: null })
            const memberships = await deps.source.loadMemberships(
                type,
                groupIds,
                (p) => emit({ phase: 'memberships', type, progress: p })
            )

            // Commit to the engine only once both payloads are in hand. If
            // memberships failed after objects had already landed, the
            // engine would hold objects with no membership data, and the
            // unconditional evaluate() below would then read every object as
            // missing from every group of this type -- indistinguishable
            // from a real integrity failure. Resolving both first means a
            // failure anywhere above leaves the engine exactly as it was
            // before this type was attempted.
            await deps.engine.call('loadObjects', objects)
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

            const total = await objectTotal(deps.fetcher, type).catch(
                () => objects.ids.length
            )
            const stamps = await groupStamps(deps.fetcher, type).catch(
                () => undefined
            )
            const entry: CachedType = {
                objects,
                memberships,
                names,
                groupIds,
                groupLastUpdated: stamps,
                objectTotal: total,
                savedAt: Date.now(),
            }
            await deps.cache.put(type, entry)
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

/**
 * Spec 4.4. A cached payload is only reused when the group id list, the
 * object total *and* every group's `lastUpdated` match the server. The first
 * two alone are blind to the change this tool exists to track: moving an
 * object from one group to another leaves both identical, so a stale
 * membership set would be reused forever and the app would keep insisting
 * data the user has already fixed is still broken. A stamp that cannot be
 * fetched (or was never cached) counts as a mismatch, so the type is
 * reloaded rather than trusted -- the same conservative reading the object
 * total check already applies.
 */
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
    if (total !== cached.objectTotal) {
        return undefined
    }
    const stamps = await groupStamps(deps.fetcher, type).catch(() => null)
    if (!stamps || !sameStamps(cached.groupLastUpdated, stamps, groupIds)) {
        return undefined
    }
    return cached
}
