import { ENDPOINTS } from './endpoints'
import type { Fetcher } from './sources/DataSource'
import { fetchJson } from './sources/DataSource'
import type { GroupSetMeta, ObjectType } from '@/engine/types'

const MAX_SHORT_NAME_LENGTH = 50

// The catch-all group's code is the set's own code with this suffix, chosen
// to read as "the overflow bucket for this group set" without colliding
// with a real code a site might already use. A set with no code produces a
// group with no code, rather than inventing one from the set's id or name.
const CATCH_ALL_CODE_SUFFIX = '_OTHER'

/** DHIS2's sharing object shape, copied wholesale rather than modelled field by field. */
type Sharing = Record<string, unknown>

// Used only when the set has no existing group to copy sharing from (spec:
// "a set with no existing groups producing a group with sensible default
// sharing rather than throwing"). `rw------`: metadata read+write for the
// owner only, and nothing -- neither metadata nor data -- for anyone else,
// matching the Maintenance app's own default for a new object. (An earlier
// version of this used `rwrw----`, which is metadata *and data* read+write
// for every user; that granted public write on a group this app created and
// was wrong, not merely permissive.)
const DEFAULT_SHARING: Sharing = {
    public: 'rw------',
    users: {},
    userGroups: {},
}

interface GroupSetCodeResponse {
    code?: string
}

interface GroupSharingResponse {
    sharing?: Sharing
}

interface CreateResponse {
    response?: { uid?: string }
}

/** A DHIS2 list response keys its array by the collection's own resource name. */
type ListResponse = Record<
    string,
    { id: string; groupSets?: { id: string }[] }[] | undefined
>

async function fetchGroupSetCode(
    fetcher: Fetcher,
    groupSetsEndpoint: string,
    setId: string
): Promise<string | undefined> {
    const body = await fetchJson<GroupSetCodeResponse>(
        fetcher,
        `${groupSetsEndpoint}/${setId}?fields=code`
    )
    return body.code
}

async function fetchSiblingSharing(
    fetcher: Fetcher,
    groupsEndpoint: string,
    siblingGroupId: string
): Promise<Sharing> {
    const body = await fetchJson<GroupSharingResponse>(
        fetcher,
        `${groupsEndpoint}/${siblingGroupId}?fields=sharing`
    )
    return body.sharing ?? DEFAULT_SHARING
}

/**
 * Sentinel `error`, like writes.ts's UNPARSEABLE_RESPONSE: a name the user
 * typed is already held by a group belonging to a *different* group set, and
 * reusing it would quietly put one group in two sets -- which spec 5.2
 * forbids outright. Not English prose, because this module has no i18n.t and
 * is not where a user-facing sentence should be built; the dialog
 * recognises this exact value and renders a translated sentence in its
 * place.
 */
export const NAME_OWNED_BY_ANOTHER_SET = 'name-owned-by-another-set'

/**
 * The names `createCatchAllGroup` uses when the caller supplies none --
 * exported because the dialog must prefill its editable fields with exactly
 * what the server would otherwise have generated, and a second
 * implementation of this rule would drift from this one.
 *
 * The name is set-specific ("Other/unknown <set name>") because a single
 * shared "Other/unknown" group would collide across sets.
 *
 * `shortName` is capped at the 50 characters DHIS2 allows, but a plain
 * truncation is not safe: the server also enforces `shortName` uniqueness,
 * and two group sets whose names agree in their first ~40-something
 * characters would otherwise truncate to the *same* `shortName` and trade
 * one rejected create for a different one. When the full name is too long,
 * the tail is reserved for `set.id` instead: MAX_SHORT_NAME_LENGTH minus
 * the id's own length minus one (for the separating space) characters of
 * the name, then a space, then the id itself, for exactly
 * MAX_SHORT_NAME_LENGTH -- unique by construction, since group set ids are
 * unique, and correct for an id of any length (a standard 11-character uid
 * leaves 38, but nothing here assumes 11).
 */
export function generateCatchAllNames(set: GroupSetMeta): {
    displayName: string
    shortName: string
} {
    const displayName = `Other/unknown ${set.displayName}`
    // The tail reserved for the id is the id's own length plus one space,
    // never a hardcoded 38 -- 38 is only correct for the 11-character uid
    // DHIS2 itself generates, and this function never validates that
    // set.id actually is one. Deriving it keeps the result exactly
    // MAX_SHORT_NAME_LENGTH regardless of how long the id turns out to be.
    const shortName =
        displayName.length <= MAX_SHORT_NAME_LENGTH
            ? displayName
            : `${displayName.slice(0, MAX_SHORT_NAME_LENGTH - set.id.length - 1)} ${set.id}`
    return { displayName, shortName }
}

/**
 * Looks up a group named exactly `displayName` in the collection, so a
 * retry after a failed add-to-set (see the doc comment on
 * `createCatchAllGroup`) finds the group the previous attempt already
 * created instead of creating a duplicate and failing a second time on
 * `shortName`'s server-side uniqueness constraint.
 *
 * Returns the group's group set membership alongside its id, because the
 * caller cannot decide whether reusing it is safe without that: the lookup
 * is global (a name is unique across the whole collection, not within a
 * set), so once the name is user-editable this can just as easily find
 * *another set's* group as the half-made one it was written to recover.
 * See `createCatchAllGroup`'s own doc comment for the three cases.
 */
async function findExistingGroup(
    fetcher: Fetcher,
    groupsEndpoint: string,
    displayName: string
): Promise<{ id: string; groupSets?: { id: string }[] } | undefined> {
    const filter = encodeURIComponent(`name:eq:${displayName}`)
    const body = await fetchJson<ListResponse>(
        fetcher,
        `${groupsEndpoint}?filter=${filter}&fields=id,groupSets%5Bid%5D&paging=false`
    )
    const matches = body[groupsEndpoint]
    return matches && matches.length > 0 ? matches[0] : undefined
}

/**
 * Creates a catch-all group for objects that are unassigned or need
 * reassigning within `set`, and adds it to the set.
 *
 * `names` is what the user typed, when they typed anything; omitted, the
 * pair `generateCatchAllNames` would have produced is used instead, so
 * every existing caller keeps its previous behaviour exactly.
 *
 * **The lookup below is global, and that matters once the name is
 * editable.** It exists because the create step is not idempotent (see
 * further down), so a retry after a failed add-to-set must find the group
 * the previous attempt made rather than 409 forever. While the name was
 * generated it embedded the set's own name, so anything it found was this
 * set's. A name the user chose has no such guarantee: two users typing
 * `Other` on two different sets would otherwise end up sharing one group
 * between both sets, which spec 5.2 forbids outright. So the three cases
 * are distinguished rather than collapsed:
 *
 * | existing group with this name | meaning              | behaviour |
 * | ----------------------------- | -------------------- | --------- |
 * | belongs to no group set       | the retry case       | reuse it  |
 * | belongs to *this* set         | already done         | reuse it  |
 * | belongs to *another* set      | the hazard           | refuse    |
 *
 * A group that belongs to this set *and* another is refused too: it is
 * still shared, and adding it here again would not make it less so.
 *
 * Sharing is copied from an existing group in the set so the new group is
 * visible to whoever could already see the others; a set with no groups
 * yet falls back to a sensible default (`DEFAULT_SHARING`) rather than
 * throwing.
 *
 * The create step is genuinely not idempotent -- DHIS2 enforces uniqueness
 * on a group's `name`, `shortName` and `code`, and a retry rebuilds all
 * three identically -- so a create that succeeds followed by an add-to-set
 * that fails (a dropped connection, a 403 on the set) must not be retried
 * by calling this function again naively: the second create would 409
 * forever, orphaning the first group for good. Instead, every call looks
 * up a group with this exact name *before* creating one, and reuses it if
 * found. A retry after a failed add-to-set therefore skips the create
 * entirely and only repeats the add, which DHIS2's collection endpoint
 * accepts idempotently (adding an existing member again is a no-op, not
 * an error).
 *
 * Thrown errors carry only an HTTP status and are not user-facing text;
 * see the module doc comment on `setGroupSetProperties` for the same note
 * about translating them before display.
 */
export async function createCatchAllGroup(
    fetcher: Fetcher,
    set: GroupSetMeta,
    names?: { displayName: string; shortName: string }
): Promise<{ id: string; displayName: string }> {
    const endpoint = ENDPOINTS[set.objectType]
    const { displayName, shortName } = names ?? generateCatchAllNames(set)

    const existing = await findExistingGroup(
        fetcher,
        endpoint.groups,
        displayName
    )
    if (existing) {
        const owners = existing.groupSets ?? []
        const ownedElsewhere = owners.some((s) => s.id !== set.id)
        if (ownedElsewhere) {
            throw new Error(NAME_OWNED_BY_ANOTHER_SET)
        }
    }

    const id =
        existing?.id ??
        (await createGroup(fetcher, endpoint, { set, displayName, shortName }))

    const addResponse = await fetcher(
        `${endpoint.groupSets}/${set.id}/${endpoint.groups}/${id}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } }
    )
    if (!addResponse.ok) {
        throw new Error(
            `Failed to add the catch-all group ${id} to the set: HTTP ${addResponse.status}`
        )
    }

    return { id, displayName }
}

async function createGroup(
    fetcher: Fetcher,
    endpoint: (typeof ENDPOINTS)[ObjectType],
    names: { set: GroupSetMeta; displayName: string; shortName: string }
): Promise<string> {
    const { set, displayName, shortName } = names
    const sibling = set.groups[0]
    // Fetched only when actually creating: a reused group (found by
    // findExistingGroup) needs neither, since it already has both.
    const codePromise = fetchGroupSetCode(fetcher, endpoint.groupSets, set.id)
    const sharingPromise = sibling
        ? fetchSiblingSharing(fetcher, endpoint.groups, sibling.id)
        : Promise.resolve(DEFAULT_SHARING)
    // Promise.all surfaces only the first rejection; without these, a
    // failure of the *other* promise would additionally log as an
    // unhandled rejection when both reject.
    codePromise.catch(() => undefined)
    sharingPromise.catch(() => undefined)
    const [code, sharing] = await Promise.all([codePromise, sharingPromise])

    const body: Record<string, unknown> = {
        name: displayName,
        shortName,
        sharing,
    }
    if (code) {
        body.code = `${code}${CATCH_ALL_CODE_SUFFIX}`
    }

    const createResponse = await fetcher(endpoint.groups, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
    if (!createResponse.ok) {
        throw new Error(
            `Failed to create catch-all group: HTTP ${createResponse.status}`
        )
    }
    const created = (await createResponse.json()) as CreateResponse
    const id = created.response?.uid
    if (!id) {
        throw new Error('Group create did not return an id')
    }
    return id
}

/**
 * Patches `compulsory` and/or `dataDimension` on a group set with a JSON
 * patch (`application/json-patch+json`), confirmed by
 * docs/superpowers/notes/2026-09-plan2-write-api-findings.md to take effect
 * immediately. `set.objectType` is required even though a group set id
 * alone looks like it should be enough: the four object types each have
 * their own group-set collection (`organisationUnitGroupSets`,
 * `dataElementGroupSets`, ...), and there is no generic endpoint that would
 * let this function find the right one from an id alone. It takes the same
 * `Pick<GroupSetMeta, 'id' | 'objectType'>` shape `createCatchAllGroup`
 * takes as `set`, so a caller holding a `GroupSetMeta` passes it to either
 * function the same way.
 *
 * Thrown errors carry only an HTTP status, not user-facing text; a caller
 * that surfaces `e.message` in a dialog must translate it first rather than
 * display it raw (this project's strings must all go through `i18n.t()`).
 */
export async function setGroupSetProperties(
    fetcher: Fetcher,
    set: Pick<GroupSetMeta, 'id' | 'objectType'>,
    props: { compulsory?: boolean; dataDimension?: boolean }
): Promise<void> {
    const ops = Object.entries(props)
        .filter((entry): entry is [string, boolean] => entry[1] !== undefined)
        .map(([path, value]) => ({ op: 'replace', path: `/${path}`, value }))
    if (ops.length === 0) {
        return
    }
    const endpoint = ENDPOINTS[set.objectType]
    const response = await fetcher(`${endpoint.groupSets}/${set.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json-patch+json' },
        body: JSON.stringify(ops),
    })
    if (!response.ok) {
        throw new Error(
            `Failed to update group set ${set.id}: HTTP ${response.status}`
        )
    }
}
