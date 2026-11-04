import type { Fetcher } from './DataSource'
import { fetchJson } from './DataSource'
import { USABLE_SQL_VIEW_TYPES } from './sqlViewSource'
import { NAMESPACE } from '@/data/datastore'

/**
 * Who may read the app's SQL views (the three `GSI_*` views and the usage
 * view). Their rows are every organisation unit group's membership and the
 * usage counts of every favourite, including groups and favourites that are
 * not shared with the reader, so an administrator chooses:
 *
 * - `public`: every logged-in user can read them. The app is fast for
 *   everyone, and anyone can also read the rows through the API.
 * - `userGroup`: only members of one user group can. Everyone else does not
 *   see the views at all, so `findSqlViews` picks the metadata API for them
 *   and the app works for them as it does on a server with no views.
 *
 * Stored in the dataStore so that repairing a view puts back the sharing the
 * administrator chose, instead of reopening it to everyone.
 */
export type SqlViewSharing =
    | { kind: 'public' }
    | { kind: 'userGroup'; userGroupId: string }

export const DEFAULT_SQL_VIEW_SHARING: SqlViewSharing = { kind: 'public' }

/**
 * Metadata read *and* data read. `r-------` is metadata read alone, and
 * reading a SQL view's rows needs the data-read bit: without it the server
 * answers every read with 409 E4312 ("Current user is not authorised to
 * read data from SQL view"), including for the administrator who created
 * the view a second earlier, unless that user holds ALL. See
 * docs/developer/dhis2-behavior.md.
 */
export const SQL_VIEW_READ_ACCESS = 'r-r-----'
export const SQL_VIEW_NO_ACCESS = '--------'

const SHARING_KEY = 'config-sql-view-sharing'
const sharingPath = `dataStore/${NAMESPACE}/${SHARING_KEY}`

/**
 * A missing document (404) is the default, public sharing: that is what
 * every view was created with before this choice existed. Any other failure
 * is thrown, never read as "public": repairing with the wrong default would
 * reopen views an administrator restricted to one group.
 */
export async function loadSqlViewSharing(
    fetcher: Fetcher
): Promise<SqlViewSharing> {
    const response = await fetcher(sharingPath)
    if (response.status === 404) {
        return DEFAULT_SQL_VIEW_SHARING
    }
    if (!response.ok) {
        throw new Error(
            `Failed to read the SQL view sharing setting: HTTP ${response.status}`
        )
    }
    const body = (await response.json()) as Partial<{
        kind: string
        userGroupId: string
    }>
    if (body.kind === 'userGroup' && typeof body.userGroupId === 'string') {
        return { kind: 'userGroup', userGroupId: body.userGroupId }
    }
    return DEFAULT_SQL_VIEW_SHARING
}

/** POST creates the key; the dataStore answers 409 when it exists, then PUT. */
export async function saveSqlViewSharing(
    fetcher: Fetcher,
    sharing: SqlViewSharing
): Promise<void> {
    const body = JSON.stringify(sharing)
    const headers = { 'Content-Type': 'application/json' }
    const created = await fetcher(sharingPath, {
        method: 'POST',
        body,
        headers,
    })
    const response =
        created.status === 409
            ? await fetcher(sharingPath, { method: 'PUT', body, headers })
            : created
    if (!response.ok) {
        throw new Error(
            `Failed to save the SQL view sharing setting: HTTP ${response.status}`
        )
    }
}

interface AccessEntry {
    id?: string
    access?: string
}

/** The `sharing` object a sqlView carries on 2.36 and later. */
export interface ServerSharing {
    public?: string
    userGroups?: Record<string, AccessEntry>
}

/** Positions 0 and 2 of an access string: metadata read and data read. */
const readsData = (access: string | undefined) =>
    access !== undefined && access[0] === 'r' && access[2] === 'r'

/**
 * Whether a view's sharing is what the administrator chose -- judged on the
 * view itself, never on whether the *current* user can read it: a superuser
 * reads every view whatever its sharing says, and would see "usable" while
 * every other user got 409.
 *
 * In group mode the public string must not grant data read, or the
 * restriction would mean nothing.
 */
export function sharingMatches(
    sharing: SqlViewSharing,
    actual: ServerSharing | undefined
): boolean {
    if (sharing.kind === 'public') {
        return readsData(actual?.public)
    }
    return (
        !readsData(actual?.public) &&
        readsData(actual?.userGroups?.[sharing.userGroupId]?.access)
    )
}

/** The `sharing` property to create a view with. */
export function sharingBody(sharing: SqlViewSharing): ServerSharing {
    if (sharing.kind === 'public') {
        return { public: SQL_VIEW_READ_ACCESS }
    }
    return {
        public: SQL_VIEW_NO_ACCESS,
        userGroups: {
            [sharing.userGroupId]: {
                id: sharing.userGroupId,
                access: SQL_VIEW_READ_ACCESS,
            },
        },
    }
}

export interface JsonPatchOp {
    op: 'add' | 'replace'
    path: string
    value: unknown
}

/**
 * Whitespace and a trailing semicolon are not differences anyone made on
 * purpose, and the server may normalise either.
 */
export function sameSql(a: string | undefined, b: string): boolean {
    const norm = (s: string) =>
        s.replace(/\s+/g, ' ').trim().replace(/;$/, '').trim()
    return a !== undefined && norm(a) === norm(b)
}

/**
 * Why an action on an existing view failed, for Settings to say in words:
 *
 * - `forbidden`: the server refused with 403. On a view that exists this
 *   almost always means another administrator owns it and this user may
 *   not change it.
 * - `conflicting`: the view could not be set back to the app's definition
 *   (the patch was refused, or the view still would not execute after it).
 *   The remedy is to delete it in the Maintenance app and create it again.
 * - `hiddenDuplicate`: a create was refused because a view with the same
 *   code already exists (409 E5003). It is one this user cannot see,
 *   because it is not shared with them.
 * - `other`: anything else; `message` carries the detail.
 */
export type SqlViewFailureReason =
    | 'forbidden'
    | 'conflicting'
    | 'hiddenDuplicate'
    | 'other'

/**
 * A create refused because the code is taken. Measured on 2.42.7: a user
 * the view is not shared with does not see it in the lookup, and the
 * create then fails with 409 and an E5003 error report ("Property `code`
 * ... already exists").
 */
async function isDuplicateCode(response: Response): Promise<boolean> {
    if (response.status !== 409) {
        return false
    }
    try {
        const body = (await response.json()) as {
            response?: { errorReports?: { errorCode?: string }[] }
        }
        return (
            body.response?.errorReports?.some((r) => r.errorCode === 'E5003') ??
            false
        )
    } catch {
        return false
    }
}

export class SqlViewActionError extends Error {
    readonly reason: SqlViewFailureReason

    constructor(reason: SqlViewFailureReason, message: string) {
        super(message)
        this.name = 'SqlViewActionError'
        this.reason = reason
    }
}

/** The error for a refused create, telling a hidden duplicate apart. */
export async function createError(
    response: Response,
    message: string
): Promise<SqlViewActionError> {
    return new SqlViewActionError(
        (await isDuplicateCode(response)) ? 'hiddenDuplicate' : 'other',
        message
    )
}

export function failureReason(e: unknown): SqlViewFailureReason {
    return e instanceof SqlViewActionError ? e.reason : 'other'
}

export function failureMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
}

export async function patchView(
    fetcher: Fetcher,
    id: string,
    ops: JsonPatchOp[]
): Promise<void> {
    const response = await fetcher(`sqlViews/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json-patch+json' },
        body: JSON.stringify(ops),
    })
    if (response.status === 403) {
        throw new SqlViewActionError(
            'forbidden',
            `Not allowed to change SQL view ${id}: HTTP 403`
        )
    }
    if (!response.ok) {
        throw new SqlViewActionError(
            'conflicting',
            `Failed to update SQL view ${id}: HTTP ${response.status}`
        )
    }
}

/** The `object` of the `/api/sharing` endpoint, kept whole except what is changed. */
interface LegacySharingObject {
    publicAccess?: string
    userGroupAccesses?: { id: string; access: string }[]
    [field: string]: unknown
}

/**
 * Puts a view's sharing back to the choice, through `/api/sharing`, read
 * then written back whole: the owner and the user accesses stay as they
 * are. Public mode changes only the public string. Group mode sets the user
 * groups to exactly the chosen one: that is the whole of who may read the
 * rows.
 *
 * Not a JSON patch of `/sharing`: on 2.40.12 that answers 200 and changes
 * nothing (it works from 2.41). The result is read back, so a server that
 * ignores the change is reported rather than shown as done.
 */
export async function applySharing(
    fetcher: Fetcher,
    id: string,
    sharing: SqlViewSharing
): Promise<void> {
    const path = `sharing?type=sqlView&id=${id}`
    const current = await fetcher(path)
    if (current.status === 403) {
        throw new SqlViewActionError(
            'forbidden',
            `Not allowed to read the sharing of SQL view ${id}: HTTP 403`
        )
    }
    if (!current.ok) {
        throw new SqlViewActionError(
            'other',
            `Failed to read the sharing of SQL view ${id}: HTTP ${current.status}`
        )
    }
    const { object } = (await current.json()) as {
        object: LegacySharingObject
    }
    const body = sharingBody(sharing)
    const next: LegacySharingObject = { ...object, publicAccess: body.public }
    if (body.userGroups) {
        next.userGroupAccesses = Object.entries(body.userGroups).map(
            ([groupId, entry]) => ({
                id: groupId,
                access: entry.access ?? SQL_VIEW_READ_ACCESS,
            })
        )
    }
    const written = await fetcher(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ object: next }),
    })
    if (written.status === 403) {
        throw new SqlViewActionError(
            'forbidden',
            `Not allowed to change the sharing of SQL view ${id}: HTTP 403`
        )
    }
    if (!written.ok) {
        throw new SqlViewActionError(
            'conflicting',
            `Failed to change the sharing of SQL view ${id}: HTTP ${written.status}`
        )
    }
    const after = await fetchJson<{ sharing?: ServerSharing }>(
        fetcher,
        `sqlViews/${id}?fields=sharing`
    )
    if (!sharingMatches(sharing, after.sharing)) {
        throw new SqlViewActionError(
            'conflicting',
            `The server accepted the sharing of SQL view ${id} but did not change it`
        )
    }
}

/**
 * The database view does not exist until this succeeds; a second execute on
 * an already-executed view is a safe no-op server-side. `afterPatch` marks
 * an execute that follows a definition patch: if the view still will not
 * run then, it is a view the app cannot fix, not a passing hiccup.
 */
export async function executeView(
    fetcher: Fetcher,
    id: string,
    afterPatch = false
): Promise<void> {
    const response = await fetcher(`sqlViews/${id}/execute`, {
        method: 'POST',
    })
    if (response.ok) {
        return
    }
    let reason: SqlViewFailureReason = 'other'
    if (response.status === 403) {
        reason = 'forbidden'
    } else if (afterPatch) {
        reason = 'conflicting'
    }
    throw new SqlViewActionError(
        reason,
        `Failed to execute SQL view ${id}: HTTP ${response.status}`
    )
}

/** The fields the Settings checks need, on top of the shared lookup. */
export interface AdminSqlViewRow {
    id: string
    code?: string
    type?: string
    sqlQuery?: string
    sharing?: ServerSharing
    access: { data?: { read?: boolean } }
}

export interface RepairTarget {
    /** the type a view of an unusable type is patched to */
    type: string
    sqlQuery: string
    /** more than one body may be acceptable (the usage view's candidates) */
    acceptQuery: (sql: string | undefined) => boolean
    sharing: SqlViewSharing
}

export const typeUsable = (type: string | undefined): boolean =>
    type !== undefined && USABLE_SQL_VIEW_TYPES.includes(type)

/**
 * The type an existing view of an unusable type is patched to.
 *
 * A MATERIALIZED_VIEW becomes a QUERY, not a VIEW. Measured on 2.42.7:
 * after patching its type to VIEW, execute fails with 409 E1004 ("relation
 * _view_<name> already exists"), because the server drops the old database
 * object as a plain view and the materialised one survives. Worse, a read
 * of the now VIEW-typed object then serves that surviving materialised
 * relation: the old, unrefreshed rows the type check exists to keep out. A
 * QUERY runs its SQL on every read, so it is always current, and needs no
 * database object at all (execute on one answers 409 "SQL view is a query,
 * no view to create").
 */
function patchedType(view: AdminSqlViewRow, target: RepairTarget): string {
    return view.type === 'MATERIALIZED_VIEW' ? 'QUERY' : target.type
}

/** The type the view has once `repairPatch` is applied. */
function typeAfterRepair(view: AdminSqlViewRow, target: RepairTarget): string {
    return typeUsable(view.type)
        ? (view.type as string)
        : patchedType(view, target)
}

/**
 * The patch that sets an existing view back to the app's definition, and
 * whether its sharing differs from the choice. A definition change is told
 * apart because a failing execute after one means the view cannot be fixed.
 */
export function repairPatch(
    view: AdminSqlViewRow,
    target: RepairTarget
): { definition: JsonPatchOp[]; sharingDiffers: boolean } {
    const definition: JsonPatchOp[] = []
    if (!typeUsable(view.type)) {
        definition.push({
            op: 'replace',
            path: '/type',
            value: patchedType(view, target),
        })
    }
    if (!target.acceptQuery(view.sqlQuery)) {
        definition.push({
            op: 'replace',
            path: '/sqlQuery',
            value: target.sqlQuery,
        })
    }
    return {
        definition,
        sharingDiffers: !sharingMatches(target.sharing, view.sharing),
    }
}

/**
 * Repairs one existing view: patch its definition and sharing back where
 * they differ, then execute it (re)creating the database view. A QUERY has
 * no database view and refuses an execute, so it is not executed. Never
 * deletes the view -- it may be someone else's.
 */
export async function repairExistingView(
    fetcher: Fetcher,
    view: AdminSqlViewRow,
    target: RepairTarget
): Promise<void> {
    const patch = repairPatch(view, target)
    if (patch.definition.length > 0) {
        await patchView(fetcher, view.id, patch.definition)
    }
    if (patch.sharingDiffers) {
        await applySharing(fetcher, view.id, target.sharing)
    }
    if (typeAfterRepair(view, target) !== 'QUERY') {
        await executeView(fetcher, view.id, patch.definition.length > 0)
    }
}
