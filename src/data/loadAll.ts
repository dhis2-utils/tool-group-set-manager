import { CACHE_TTL_MS, Cache, CachedType } from './cache'
import { ENDPOINTS } from './endpoints'
import { groupIdsFor, loadGroupSets } from './groupSets'
import {
    DataSource,
    fetchJson,
    Fetcher,
    NamedId,
    Progress,
} from './sources/DataSource'
import { createMetadataSource } from './sources/metadataSource'
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
    /**
     * When each type's payload was actually read from the server, epoch ms.
     * A cache hit carries the stored `savedAt` forward unchanged, so this is
     * always the age of the *data* and never of the page load -- a cache hit
     * reporting `now` would claim a freshness it does not have.
     */
    loadedAt: Partial<Record<ObjectType, number>>
    errors: Partial<Record<ObjectType, string>>
    /**
     * A names load/setNames failure, kept apart from `errors`. It always
     * happens after objects, memberships and evaluate have already
     * succeeded for the type, so the counts the engine reports are
     * correct -- only the display names are unavailable. Folding this into
     * `errors` reported a type-level failure (which the dashboard shows as
     * "this type's summary could not be computed") for what is really a
     * cosmetic gap.
     */
    namesErrors: Partial<Record<ObjectType, string>>
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
 * Whether a membership write bumps this stamp is version-dependent -- 2.40
 * does, 2.43 does not (see
 * docs/superpowers/notes/2026-09-plan2-write-compatibility.md section 4) --
 * but `tryCache` below treats any stamp it cannot fetch, or any mismatch, as
 * a reason to reload rather than trust the cache, so this is still what
 * tells a cached membership payload apart from the current one on either
 * version: the group id list and the object total are both unchanged by a
 * move between groups, so only the stamp (where the server bumps it) or a
 * forced reload can catch that move.
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

/**
 * Runs a group of engine calls that commit one type (loadObjects,
 * loadMemberships, and optionally setNames) and, if any of them rejects,
 * rolls the type back with dropType so the engine is left exactly as it
 * was before this type was attempted -- never holding objects with no
 * membership data, which reads as every object missing from every group.
 * Used by both the fresh-load and cached-reuse paths below: each resolves
 * its payloads (from the network, or from the cache) before calling this,
 * which protects against a *fetch* failure leaving the engine touched; this
 * function is what protects against the engine calls themselves failing
 * (e.g. a worker crash) between loadObjects landing and loadMemberships
 * landing, which resolving payloads first does nothing to prevent.
 *
 * The rollback call is itself guarded: if the engine is dead enough that
 * dropType also fails, the secondary failure is discarded and the
 * original error is what gets reported -- an engine too broken to drop a
 * type is not going to serve numbers from the half-loaded type either, so
 * telling the user why the load actually failed matters more than telling
 * them cleanup also failed.
 */
async function commitOrRollback(
    engine: EngineLike,
    type: ObjectType,
    commit: () => Promise<void>
): Promise<void> {
    try {
        await commit()
    } catch (error) {
        try {
            await engine.call('dropType', type)
        } catch {
            // Swallowed on purpose -- see the doc comment above.
        }
        throw error
    }
}

/**
 * D4: a SQL view read failure must degrade, not break. `activeSource` starts
 * as whatever `selectSource` picked; the first time a call through it
 * throws, this switches it to a fresh metadata source (built from the same
 * fetcher) and retries that one call, for the rest of this load only --
 * `fellBack` then latches so a second failure (a metadata read failing too)
 * is a real, terminal error for its type rather than another fallback
 * attempt. This is deliberately not a retry wrapper around every read: it
 * is one guarded transition, reachable at most once per `loadAll` call, and
 * only for the source kind (`sqlView`) that D4 exists for -- a metadata
 * source's own failures are never "fallen back" from, there is nowhere left
 * to fall back to.
 */
function withSourceFallback(deps: Deps): {
    call: <T>(run: (source: DataSource) => Promise<T>) => Promise<T>
    current: () => DataSource
    fellBack: () => boolean
} {
    let activeSource = deps.source
    let fellBack = false
    return {
        current: () => activeSource,
        fellBack: () => fellBack,
        async call<T>(run: (source: DataSource) => Promise<T>): Promise<T> {
            try {
                return await run(activeSource)
            } catch (error) {
                if (fellBack || activeSource.kind !== 'sqlView') {
                    throw error
                }
                fellBack = true
                activeSource = createMetadataSource(deps.fetcher)
                return run(activeSource)
            }
        },
    }
}

export async function loadAll(deps: Deps): Promise<{
    groupSets: GroupSetMeta[]
    sourceKind: DataSource['kind']
    /**
     * Where organisation unit names came from, which is not always where
     * the rest came from: with `GSI_ORGUNIT_NAMES` removed (design spec
     * §8a's remedy for translated names) the hierarchy and the memberships
     * still come from the views while names come from the metadata API.
     * Reported separately so the dashboard can say so rather than claim one
     * source for the whole load.
     */
    nameSource: DataSource['nameSource']
    /**
     * P3-R2: true only when `withSourceFallback` actually latched during
     * this load -- never inferred from `sourceKind === 'metadata'`, which
     * is equally true on a server that never had SQL views to begin with.
     * This is what lets the dashboard tell "a view broke, go fix it" apart
     * from "this server has no SQL views, say nothing".
     */
    fellBack: boolean
}> {
    const source = withSourceFallback(deps)
    const status: LoadStatus = {
        phase: 'groupSets',
        type: null,
        progress: null,
        fromCache: {},
        loadedAt: {},
        errors: {},
        namesErrors: {},
    }
    const emit = (patch: Partial<LoadStatus>) => {
        Object.assign(status, patch)
        deps.onStatus({
            ...status,
            fromCache: { ...status.fromCache },
            loadedAt: { ...status.loadedAt },
            errors: { ...status.errors },
            namesErrors: { ...status.namesErrors },
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
                // The cached payloads are already fully resolved -- they
                // came from the cache, not the network -- so there is no
                // fetch step to protect here the way the fresh-load path
                // below protects its source calls. Only the engine calls
                // themselves can still fail (e.g. a worker crash) between
                // loadObjects landing and loadMemberships landing;
                // commitOrRollback is what protects against that.
                await commitOrRollback(deps.engine, type, async () => {
                    await deps.engine.call('loadObjects', reused.objects)
                    await deps.engine.call(
                        'loadMemberships',
                        reused.memberships
                    )
                    if (reused.names) {
                        await deps.engine.call('setNames', type, reused.names)
                    }
                })
                status.fromCache[type] = true
                status.loadedAt[type] = reused.savedAt
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
            const objects = await source.call((s) =>
                s.loadObjects(type, (p) =>
                    emit({ phase: 'objects', type, progress: p })
                )
            )

            emit({ phase: 'memberships', type, progress: null })
            const memberships = await source.call((s) =>
                s.loadMemberships(type, groupIds, (p) =>
                    emit({ phase: 'memberships', type, progress: p })
                )
            )

            // Resolving both source fetches before calling the engine at
            // all protects against a *fetch* failure (loadMemberships
            // throwing after loadObjects already returned) leaving the
            // engine holding objects with no membership data -- which the
            // unconditional evaluate() below would then read as every
            // object missing from every group of this type,
            // indistinguishable from a real integrity failure. It does
            // nothing, though, if the engine calls themselves fail (e.g.
            // the worker crashes) between loadObjects landing and
            // loadMemberships landing -- commitOrRollback is what protects
            // against that half.
            await commitOrRollback(deps.engine, type, async () => {
                await deps.engine.call('loadObjects', objects)
                await deps.engine.call('loadMemberships', memberships)
            })
            emit({ phase: 'evaluate', type })
            await deps.engine.call('evaluate')

            let names = objects.names
            let namesFailed = false
            if (!names) {
                emit({ phase: 'names', type, progress: null })
                try {
                    names = alignNames(
                        objects.ids,
                        await source.call((s) => s.loadNames(type))
                    )
                    await deps.engine.call('setNames', type, names)
                } catch (error) {
                    // Objects, memberships and evaluate already succeeded
                    // above -- the counts are good. Only the names are
                    // missing, so this is recorded as that, not folded
                    // into `status.errors` (which would tell the dashboard
                    // this type's summary could not be computed at all).
                    status.namesErrors[type] =
                        error instanceof Error ? error.message : String(error)
                    names = objects.ids
                    namesFailed = true
                    emit({ type })
                }
            }

            const total = await objectTotal(deps.fetcher, type).catch(
                () => objects.ids.length
            )
            const stamps = await groupStamps(deps.fetcher, type).catch(
                () => undefined
            )
            // M1 (fix round 1): `names` above is `objects.ids` standing in
            // for real names when the names load just failed -- caching
            // that would let `tryCache` reuse it on every later load
            // (group ids, object total and every group's `lastUpdated` are
            // all untouched by a names endpoint hiccup), permanently
            // serving uids as display names with no later run's
            // `namesErrors` ever recording why. Skipping the cache write
            // here means the next load has nothing to reuse for this type
            // and goes back to the source for names, same as this load
            // did.
            const savedAt = Date.now()
            status.loadedAt[type] = savedAt
            if (!namesFailed) {
                const entry: CachedType = {
                    objects,
                    memberships,
                    names,
                    groupIds,
                    groupLastUpdated: stamps,
                    objectTotal: total,
                    savedAt,
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
    return {
        groupSets,
        sourceKind: source.current().kind,
        nameSource: source.current().nameSource,
        fellBack: source.fellBack(),
    }
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
 * total check already applies. On top of those, an entry older than
 * `CACHE_TTL_MS` is rejected outright: on 2.41-2.43 a membership move leaves
 * every one of those signals unchanged (see `CACHE_TTL_MS`'s own doc
 * comment), so age is not redundant with them -- it is the only gate that
 * still catches a stale entry on those versions.
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
    // Age first: it is the only gate needing no network call, so an expired
    // entry is rejected without spending the objectTotal and groupStamps
    // requests the other three cost.
    if (Date.now() - cached.savedAt > CACHE_TTL_MS) {
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
