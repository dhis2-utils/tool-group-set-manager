import { fetchJson, Fetcher } from './sources/DataSource'
import { ChangeSet } from '@/engine/changeSet'

export const NAMESPACE = 'group-set-integrity'

export interface GsiConfig {
    /** group set id -> org unit levels at which membership is required */
    requiredLevels: Record<string, number[]>
    /** group set id -> the group new/unassigned objects are put in on fix */
    catchAllGroup: Record<string, string>
    includeTracker: boolean
}

const DEFAULT_CONFIG: GsiConfig = {
    requiredLevels: {},
    catchAllGroup: {},
    includeTracker: false,
}

function keyPath(key: string): string {
    return `dataStore/${NAMESPACE}/${key}`
}

/**
 * Reads one document, returning undefined for any failure: 404 (the key,
 * or the whole namespace, does not exist yet), 403 (no read access), or a
 * network error. A fresh instance where the app has never run has no
 * namespace at all, and that is the normal first-run case, not an error --
 * so `loadConfig` can turn every "undefined" here into a default rather
 * than throw and keep the app from starting.
 */
async function readDocument<T>(
    fetcher: Fetcher,
    key: string
): Promise<T | undefined> {
    try {
        return await fetchJson<T>(fetcher, keyPath(key))
    } catch {
        return undefined
    }
}

/**
 * Reads one document for the read-modify-write path in front of a shared-
 * document save (`saveRequiredLevels`, `saveCatchAllGroup`). Unlike
 * `readDocument`, only a 404 -- the document genuinely does not exist yet
 * -- is treated as absent here. A transient 403, a 500, or a dropped
 * connection must not be read the same way: the write that follows would
 * merge the new entry into an empty object and silently erase every other
 * group set's saved value. Refusing to save while the dataStore is
 * briefly unreachable is the correct behaviour, so anything but a 404 is
 * rethrown to the caller instead of swallowed.
 */
async function readCurrentForMerge<T>(
    fetcher: Fetcher,
    key: string
): Promise<T | undefined> {
    const response = await fetcher(keyPath(key))
    if (response.status === 404) {
        return undefined
    }
    if (!response.ok) {
        throw new Error(
            `Failed to read ${key} before saving: HTTP ${response.status}`
        )
    }
    return (await response.json()) as T
}

/**
 * Writes to the key with a POST (create). The dataStore answers a POST to
 * an existing key with 409, so that case is retried with the same body as
 * a PUT (update) instead. There is no way to know in advance which verb
 * applies, so both are handled rather than guessed.
 */
async function writeDocument(
    fetcher: Fetcher,
    key: string,
    value: unknown
): Promise<void> {
    const path = keyPath(key)
    const body = JSON.stringify(value)
    const headers = { 'Content-Type': 'application/json' }
    const created = await fetcher(path, { method: 'POST', body, headers })
    if (created.status === 409) {
        const updated = await fetcher(path, { method: 'PUT', body, headers })
        if (!updated.ok) {
            throw new Error(`Failed to save ${key}: HTTP ${updated.status}`)
        }
        return
    }
    if (!created.ok) {
        throw new Error(`Failed to save ${key}: HTTP ${created.status}`)
    }
}

/** The namespace's keys, or an empty list if it does not exist yet (or is unreadable). */
async function listKeys(fetcher: Fetcher): Promise<string[]> {
    try {
        return await fetchJson<string[]>(fetcher, `dataStore/${NAMESPACE}`)
    } catch {
        return []
    }
}

/**
 * Reads the three config documents, merging each over its default. Never
 * throws: a document that is absent, unreadable, or unreachable reads as
 * "not configured yet" rather than a load failure, because a fresh
 * instance has no namespace at all until something is first saved to it.
 */
export async function loadConfig(fetcher: Fetcher): Promise<GsiConfig> {
    const [requiredLevels, catchAllGroup, general] = await Promise.all([
        readDocument<Record<string, number[]>>(
            fetcher,
            'config-required-levels'
        ),
        readDocument<Record<string, string>>(fetcher, 'config-catch-all'),
        readDocument<{ includeTracker?: boolean }>(fetcher, 'config-general'),
    ])
    return {
        requiredLevels: requiredLevels ?? DEFAULT_CONFIG.requiredLevels,
        catchAllGroup: catchAllGroup ?? DEFAULT_CONFIG.catchAllGroup,
        includeTracker:
            general?.includeTracker ?? DEFAULT_CONFIG.includeTracker,
    }
}

/**
 * config-required-levels holds every group set's levels together, keyed by
 * set id, so saving one set's levels must read the current document first
 * to avoid erasing the others' entries.
 */
export async function saveRequiredLevels(
    fetcher: Fetcher,
    setId: string,
    levels: number[]
): Promise<void> {
    const current =
        (await readCurrentForMerge<Record<string, number[]>>(
            fetcher,
            'config-required-levels'
        )) ?? {}
    await writeDocument(fetcher, 'config-required-levels', {
        ...current,
        [setId]: levels,
    })
}

/** config-catch-all is likewise shared across every group set; see saveRequiredLevels. */
export async function saveCatchAllGroup(
    fetcher: Fetcher,
    setId: string,
    groupId: string
): Promise<void> {
    const current =
        (await readCurrentForMerge<Record<string, string>>(
            fetcher,
            'config-catch-all'
        )) ?? {}
    await writeDocument(fetcher, 'config-catch-all', {
        ...current,
        [setId]: groupId,
    })
}

export async function saveIncludeTracker(
    fetcher: Fetcher,
    value: boolean
): Promise<void> {
    // config-general holds only this one flag, so there is nothing else to
    // preserve and no need to read the existing document first.
    await writeDocument(fetcher, 'config-general', { includeTracker: value })
}

export interface ChangeSetsPage {
    changeSets: ChangeSet[]
    /** whether a later page (older change sets) still exists */
    hasMore: boolean
}

/**
 * A change set's id (`generateChangeSetId` in useMembershipWrite.ts) is a
 * base36 timestamp prefix plus a random suffix of fixed length, so ids sort
 * lexicographically the same as their creation time for as long as the
 * timestamp keeps the same digit count -- true across this app's whole
 * practical lifetime. That is what lets a page be served without reading
 * every stored change set: the key list (one request for the whole
 * namespace) is sorted directly, newest first, and only the requested
 * window's documents are actually fetched.
 */
function sortKeysNewestFirst(keys: string[]): string[] {
    return [...keys].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
}

/**
 * D3: paged so a namespace holding thousands of change sets does not cost
 * one request per stored document on every load -- only for the page
 * asked for. `offset`/`limit` index into the (cheaply sorted) key list,
 * not into `changeSets`' final sort below, which only re-orders the page
 * itself by `createdAt`/id as a tiebreak for documents created in the same
 * request (D3 predates a need for cross-page reordering, since only
 * concurrent writes inside one page's window could disagree with key
 * order, and this app never writes concurrently).
 */
export async function listChangeSets(
    fetcher: Fetcher,
    { offset = 0, limit = 20 }: { offset?: number; limit?: number } = {}
): Promise<ChangeSetsPage> {
    const keys = sortKeysNewestFirst(
        (await listKeys(fetcher)).filter((k) => k.startsWith('history-'))
    )
    const page = keys.slice(offset, offset + limit)
    const changeSets = await Promise.all(
        page.map((key) => readDocument<ChangeSet>(fetcher, key))
    )
    const sorted = changeSets
        .filter((c): c is ChangeSet => c !== undefined)
        .sort((a, b) => {
            // A plain "a < b ? 1 : -1" is not a comparator, just an
            // arbitrary order: two change sets created in the same
            // millisecond compare as less-than in both directions, which
            // is inconsistent rather than merely unspecified. Fall back to
            // id so the History page's order is stable across renders.
            if (a.createdAt !== b.createdAt) {
                return a.createdAt < b.createdAt ? 1 : -1
            }
            if (a.id !== b.id) {
                return a.id < b.id ? 1 : -1
            }
            return 0
        })
    return { changeSets: sorted, hasMore: offset + limit < keys.length }
}

export async function saveChangeSet(
    fetcher: Fetcher,
    changeSet: ChangeSet
): Promise<void> {
    await writeDocument(fetcher, `history-${changeSet.id}`, changeSet)
}

const PROBE_KEY = 'write-probe'

/**
 * Whether the current user can write to the namespace, found out by
 * actually writing and then deleting a dedicated probe key rather than
 * inferred from a read. A dataStore key exposes created/last-updated
 * metadata but no per-namespace sharing object, so there is nothing to
 * consult that would tell a read-only user from a read-write one without
 * trying -- and inferring write access from read access risks telling a
 * read-only user they may write, only to have the real write fail later.
 * The cleanup delete is best-effort: the write already answered the
 * question, so a delete that fails leaves a harmless leftover key rather
 * than changing the answer.
 *
 * This costs a network round trip (two, when cleanup also succeeds), so
 * it is meant for a one-off check -- gating the Settings page -- and not
 * something to call before every load.
 */
export async function canWriteDataStore(fetcher: Fetcher): Promise<boolean> {
    try {
        await writeDocument(fetcher, PROBE_KEY, null)
    } catch {
        return false
    }
    try {
        await fetcher(keyPath(PROBE_KEY), { method: 'DELETE' })
    } catch {
        // Best-effort cleanup; see doc comment above.
    }
    return true
}
