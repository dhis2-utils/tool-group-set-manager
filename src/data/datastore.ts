import type { Fetcher } from './sources/DataSource'
import { fetchJson } from './sources/DataSource'
import type { ChangeSet } from '@/engine/changeSet'

export const NAMESPACE = 'group-set-integrity'

export interface GsiConfig {
    /** group set id -> the group new/unassigned objects are put in on fix */
    catchAllGroup: Record<string, string>
    includeTracker: boolean
}

const DEFAULT_CONFIG: GsiConfig = {
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
 * Reads one document whose absence and whose unreadability must not be
 * confused. Unlike `readDocument`, only a 404 -- the document genuinely
 * does not exist yet -- is treated as absent here. A transient 403, a 500,
 * or a dropped connection is rethrown: a clear that read "absent" from a
 * briefly unreachable dataStore would skip the tombstone it needs to
 * write, and the cleared value would come back from the legacy document.
 */
async function readOrAbsent<T>(
    fetcher: Fetcher,
    key: string
): Promise<T | undefined> {
    const response = await fetcher(keyPath(key))
    if (response.status === 404) {
        return undefined
    }
    if (!response.ok) {
        throw new Error(`Failed to read ${key}: HTTP ${response.status}`)
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
 * The document every group set's catch-all group was stored in together,
 * keyed by set id, before each set got a key of its own. Still read, so a
 * choice saved by an earlier version keeps working, but never written: two
 * admins saving different sets at once each read it, added their entry and
 * wrote it back, and whichever wrote second erased the other's entry.
 */
const LEGACY_CATCH_ALL_KEY = 'config-catch-all'

/** One group set's catch-all choice lives under `config-catch-all-<setId>`. */
const CATCH_ALL_KEY_PREFIX = `${LEGACY_CATCH_ALL_KEY}-`

function catchAllKey(setId: string): string {
    return `${CATCH_ALL_KEY_PREFIX}${setId}`
}

/**
 * A per-set document. `groupId: null` is a tombstone: the set was cleared
 * while the legacy document still names a group for it, and the per-set
 * key always wins, so the tombstone is what keeps the legacy value from
 * coming back. Rewriting the legacy document to drop the entry instead
 * would reopen the read-modify-write race this layout removes.
 */
interface CatchAllDocument {
    groupId: string | null
}

/**
 * Reads the config documents, merging each over its default. Never throws:
 * a document that is absent, unreadable, or unreachable reads as "not
 * configured yet" rather than a load failure, because a fresh instance has
 * no namespace at all until something is first saved to it.
 *
 * Catch-all groups come from the legacy shared document first, then each
 * per-set document over it, so a set saved since the split wins over what
 * the shared document says about it.
 */
export async function loadConfig(fetcher: Fetcher): Promise<GsiConfig> {
    const perSetKeys = (await listKeys(fetcher)).filter((k) =>
        k.startsWith(CATCH_ALL_KEY_PREFIX)
    )
    const [legacy, general, perSet] = await Promise.all([
        readDocument<Record<string, string>>(fetcher, LEGACY_CATCH_ALL_KEY),
        readDocument<{ includeTracker?: boolean }>(fetcher, 'config-general'),
        Promise.all(
            perSetKeys.map(
                async (key) =>
                    [
                        key.slice(CATCH_ALL_KEY_PREFIX.length),
                        await readDocument<CatchAllDocument>(fetcher, key),
                    ] as const
            )
        ),
    ])
    const catchAllGroup: Record<string, string> = {
        ...DEFAULT_CONFIG.catchAllGroup,
        ...legacy,
    }
    for (const [setId, document] of perSet) {
        if (!document) {
            continue
        }
        if (typeof document.groupId === 'string' && document.groupId) {
            catchAllGroup[setId] = document.groupId
        } else {
            delete catchAllGroup[setId]
        }
    }
    return {
        catchAllGroup,
        includeTracker:
            general?.includeTracker ?? DEFAULT_CONFIG.includeTracker,
    }
}

/**
 * Saves one group set's catch-all group under that set's own key, so two
 * admins saving different sets at the same moment can no longer erase each
 * other's entry: there is no shared document left to read, modify and
 * write back.
 */
export async function saveCatchAllGroup(
    fetcher: Fetcher,
    setId: string,
    groupId: string
): Promise<void> {
    const document: CatchAllDocument = { groupId }
    await writeDocument(fetcher, catchAllKey(setId), document)
}

/**
 * Removes one group set's catch-all choice, leaving every other set's alone.
 *
 * "No catch-all group" is the absence of the entry in `GsiConfig`, not an
 * empty string stored under it: every reader asks
 * `config.catchAllGroup[setId]` and treats `undefined` as "not configured",
 * and the bulk fix dialog then falls back to matching a group by name
 * (`CATCH_ALL_NAME_PATTERN`).
 *
 * When the legacy shared document still names a group for this set, the
 * per-set key is written as a tombstone (`groupId: null`) rather than
 * deleted, so the legacy value does not come back on the next load.
 * Without a legacy entry the per-set key is simply deleted. Neither path
 * writes the shared document.
 */
export async function clearCatchAllGroup(
    fetcher: Fetcher,
    setId: string
): Promise<void> {
    const legacy = await readOrAbsent<Record<string, string>>(
        fetcher,
        LEGACY_CATCH_ALL_KEY
    )
    if (legacy && setId in legacy) {
        const tombstone: CatchAllDocument = { groupId: null }
        await writeDocument(fetcher, catchAllKey(setId), tombstone)
        return
    }
    const response = await fetcher(keyPath(catchAllKey(setId)), {
        method: 'DELETE',
    })
    if (!response.ok && response.status !== 404) {
        throw new Error(
            `Failed to clear ${catchAllKey(setId)}: HTTP ${response.status}`
        )
    }
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

/**
 * Deletes a change set's document. Used only for a pending record that
 * turned out to describe nothing (the write it was saved in front of
 * confirmed no change at all), so a 404 counts as done.
 */
export async function deleteChangeSet(
    fetcher: Fetcher,
    id: string
): Promise<void> {
    const response = await fetcher(keyPath(`history-${id}`), {
        method: 'DELETE',
    })
    if (!response.ok && response.status !== 404) {
        throw new Error(
            `Failed to delete history-${id}: HTTP ${response.status}`
        )
    }
}
