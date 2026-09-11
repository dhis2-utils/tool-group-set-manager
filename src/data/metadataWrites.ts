import { ENDPOINTS } from './endpoints'
import { fetchJson, Fetcher } from './sources/DataSource'
import { GroupSetMeta, ObjectType } from '@/engine/types'

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
// sharing rather than throwing"). Metadata-only access for everyone but the
// owner, matching what the Maintenance app itself defaults a new object to.
const DEFAULT_SHARING: Sharing = {
    public: 'rwrw----',
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
 * Creates a catch-all group for objects that are unassigned or need
 * reassigning within `set`, and adds it to the set. The name is
 * set-specific ("Other/unknown <set name>") because a single shared
 * "Other/unknown" group would collide across sets; `shortName` is truncated
 * to the 50 characters DHIS2 allows rather than left to be rejected by the
 * server. Sharing is copied from an existing group in the set so the new
 * group is visible to whoever could already see the others; a set with no
 * groups yet falls back to a sensible default rather than throwing.
 */
export async function createCatchAllGroup(
    fetcher: Fetcher,
    set: GroupSetMeta
): Promise<{ id: string; displayName: string }> {
    const endpoint = ENDPOINTS[set.objectType]
    const displayName = `Other/unknown ${set.displayName}`
    const shortName = displayName.slice(0, MAX_SHORT_NAME_LENGTH)

    const sibling = set.groups[0]
    const [code, sharing] = await Promise.all([
        fetchGroupSetCode(fetcher, endpoint.groupSets, set.id),
        sibling
            ? fetchSiblingSharing(fetcher, endpoint.groups, sibling.id)
            : Promise.resolve(DEFAULT_SHARING),
    ])

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

    const addResponse = await fetcher(
        `${endpoint.groupSets}/${set.id}/groups/${id}`,
        { method: 'POST' }
    )
    if (!addResponse.ok) {
        throw new Error(
            `Failed to add the catch-all group to the set: HTTP ${addResponse.status}`
        )
    }

    return { id, displayName }
}

/**
 * Patches `compulsory` and/or `dataDimension` on a group set with a JSON
 * patch (`application/json-patch+json`), confirmed by
 * docs/superpowers/notes/2026-09-plan2-write-api-findings.md to take effect
 * immediately. `target.objectType` is required even though a group set id
 * alone looks like it should be enough: the four object types each have
 * their own group-set collection (`organisationUnitGroupSets`,
 * `dataElementGroupSets`, ...), and there is no generic endpoint that would
 * let this function find the right one from `setId` alone. It is bundled
 * into one `target` object with `setId`, rather than added as its own
 * parameter, to stay within this project's `max-params` limit.
 */
export async function setGroupSetProperties(
    fetcher: Fetcher,
    target: { objectType: ObjectType; setId: string },
    props: { compulsory?: boolean; dataDimension?: boolean }
): Promise<void> {
    const ops = Object.entries(props)
        .filter((entry): entry is [string, boolean] => entry[1] !== undefined)
        .map(([path, value]) => ({ op: 'replace', path: `/${path}`, value }))
    if (ops.length === 0) {
        return
    }
    const endpoint = ENDPOINTS[target.objectType]
    const response = await fetcher(`${endpoint.groupSets}/${target.setId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json-patch+json' },
        body: JSON.stringify(ops),
    })
    if (!response.ok) {
        throw new Error(
            `Failed to update group set ${target.setId}: HTTP ${response.status}`
        )
    }
}
