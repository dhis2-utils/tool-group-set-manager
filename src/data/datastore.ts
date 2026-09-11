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
        (await readDocument<Record<string, number[]>>(
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
        (await readDocument<Record<string, string>>(
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

/**
 * Every change set, newest first. One document per change set
 * (`history-<uid>`) in the same flat key space as the config documents,
 * because the dataStore has no nesting and listing keys is the only way
 * to enumerate what is there.
 */
export async function listChangeSets(fetcher: Fetcher): Promise<ChangeSet[]> {
    const keys = (await listKeys(fetcher)).filter((k) =>
        k.startsWith('history-')
    )
    const changeSets = await Promise.all(
        keys.map((key) => readDocument<ChangeSet>(fetcher, key))
    )
    return changeSets
        .filter((c): c is ChangeSet => c !== undefined)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

export async function saveChangeSet(
    fetcher: Fetcher,
    changeSet: ChangeSet
): Promise<void> {
    await writeDocument(fetcher, `history-${changeSet.id}`, changeSet)
}

/**
 * Whether the current user can write to the namespace. A 403 is the only
 * signal that write access is missing; anything else -- including a 404,
 * which just means the namespace has not been created yet on a fresh
 * instance -- is treated as writable, and a network failure is treated as
 * "cannot write" rather than thrown into a caller deciding whether to show
 * fix actions.
 */
export async function canWriteDataStore(fetcher: Fetcher): Promise<boolean> {
    try {
        const response = await fetcher(`dataStore/${NAMESPACE}`)
        return response.status !== 403
    } catch {
        return false
    }
}
