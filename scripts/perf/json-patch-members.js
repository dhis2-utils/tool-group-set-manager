// JSON Patch membership-write measurement for Plan 8 (docs/superpowers/notes/
// 2026-09-plan8-json-patch.md). Answers whether `PATCH .../<id>` with
// `Content-Type: application/json-patch+json` and a `replace` of
// `/organisationUnits` is a viable alternative to the `POST /api/metadata`
// import shape measured in `2026-09-plan7-write-shapes.md`, for the same
// national-scale membership population on the same instance and group.
//
// Kept in the repository, like write-shapes.js and emis-run.js, so a future
// run is a re-run rather than a re-implementation. This script deliberately
// does NOT reimplement `capture`/`restore` -- reuse write-shapes.js for
// those two (identical member-list capture/metadata-import restore, same
// group, same shape family):
//
//   node scripts/perf/write-shapes.js <groupId> capture > members.json
//   node scripts/perf/write-shapes.js <groupId> restore < members.json
//
// This script adds the one shape write-shapes.js does not have (`patch`),
// plus the non-timed functional checks Plan 8 needs: whether a JSON Patch
// replace preserves a group's other owned properties, and a small
// add-and-remove round trip. None of the `verify`/`set-props`/`read-props`
// modes are timed; only `patch` is.
//
// Usage:
//   node scripts/perf/json-patch-members.js <groupId> empty
//     Untimed: JSON Patch replace organisationUnits with []. Use this to
//     put the group into the "from empty" starting state write-shapes.js's
//     other shapes also start from, before a timed `patch` run.
//
//   node scripts/perf/json-patch-members.js <groupId> patch < members.json
//     Timed: JSON Patch replace organisationUnits with the id list read
//     from stdin (same JSON-array-of-ids shape write-shapes.js's shapes
//     take), then reads the membership back and reports the same
//     {shape, seconds, requestCount, intended, actual, complete} shape
//     write-shapes.js prints, so the two are directly comparable.
//
//   node scripts/perf/json-patch-members.js <groupId> verify [n]
//     Untimed functional check (question 1: does it work at all, for a
//     change that both adds and removes). Reads the group's current
//     members, drops the first n (default 5) and adds n ids of
//     organisation units it does not currently contain, patches, rereads
//     and diffs the result against what was intended, then patches back
//     to the original list. Prints {added, removed, matchedAfterPatch,
//     restoredExactly}.
//
//   node scripts/perf/json-patch-members.js <groupId> set-props <description> <color> <symbol>
//     Untimed. Sets the group's description/color/symbol via JSON Patch
//     `add` (not `replace`: these fields may be entirely absent from the
//     group today, and `replace` requires the path to already exist).
//     Prints the previous values of all three, read before the write, so
//     the caller can restore them afterwards.
//
//   node scripts/perf/json-patch-members.js <groupId> read-props
//     Untimed. Prints the group's current description/color/symbol/name
//     and member count.
//
// Overridable via environment variables, the same convention every script
// in this directory uses:
//   GSI_PERF_BASE_URL   target instance (default: agent-gsi-emis)
//   GSI_PERF_USERNAME   login (default: local_admin)
//   GSI_PERF_PASSWORD   password (default: district)
'use strict'

const BASE_URL =
    process.env.GSI_PERF_BASE_URL || 'http://dhis2-agent-gsi-emis:8080'
const CREDS = {
    username: process.env.GSI_PERF_USERNAME || 'local_admin',
    password: process.env.GSI_PERF_PASSWORD || 'district',
}
const AUTH =
    'Basic ' +
    Buffer.from(`${CREDS.username}:${CREDS.password}`).toString('base64')

let requestCount = 0

async function api(path, init) {
    requestCount += 1
    const response = await fetch(`${BASE_URL}/api/${path}`, {
        ...init,
        headers: {
            Authorization: AUTH,
            ...(init && init.headers),
        },
    })
    return response
}

async function apiJson(path, init) {
    const response = await api(path, init)
    const text = await response.text()
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} on ${path}: ${text.slice(0, 300)}`)
    }
    return text ? JSON.parse(text) : {}
}

async function readMembers(groupId) {
    const body = await apiJson(
        `organisationUnitGroups/${groupId}/organisationUnits?fields=id&paging=false`
    )
    return body.organisationUnits.map((o) => o.id)
}

async function readGroupProps(groupId) {
    return apiJson(
        `organisationUnitGroups/${groupId}?fields=id,name,description,color,symbol,organisationUnits~size`
    )
}

/** The one shape under test: PATCH with a single `replace` of the members array. */
async function jsonPatchReplaceMembers(groupId, memberIds) {
    const response = await api(`organisationUnitGroups/${groupId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json-patch+json' },
        body: JSON.stringify([
            {
                op: 'replace',
                path: '/organisationUnits',
                value: memberIds.map((id) => ({ id })),
            },
        ]),
    })
    const text = await response.text()
    if (!response.ok) {
        throw new Error(
            `json-patch replace failed: HTTP ${response.status}: ${text.slice(0, 500)}`
        )
    }
}

/**
 * A handful of organisation unit ids the group does NOT currently contain,
 * for the add half of the add-and-remove verification. Pulled live rather
 * than hardcoded, since which ids are outside a 91,892-member group is
 * instance-specific and this script must not assume EMIS's data shape.
 */
async function someNonMemberIds(currentMemberIds, n) {
    const current = new Set(currentMemberIds)
    const found = []
    let page = 1
    while (found.length < n && page <= 20) {
        const body = await apiJson(
            `organisationUnits?fields=id&paging=true&pageSize=500&page=${page}`
        )
        const list = body.organisationUnits || []
        if (list.length === 0) {
            break
        }
        for (const o of list) {
            if (!current.has(o.id)) {
                found.push(o.id)
                if (found.length >= n) {
                    break
                }
            }
        }
        page += 1
    }
    if (found.length < n) {
        throw new Error(
            `could not find ${n} non-member organisation units (found ${found.length})`
        )
    }
    return found
}

async function readStdin() {
    const chunks = []
    for await (const chunk of process.stdin) {
        chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
}

async function main() {
    const [groupId, mode, ...rest] = process.argv.slice(2)
    if (!groupId || !mode) {
        throw new Error(
            'usage: node scripts/perf/json-patch-members.js <groupId> <empty|patch|verify|set-props|read-props> [...args]'
        )
    }

    if (mode === 'read-props') {
        const props = await readGroupProps(groupId)
        console.log(JSON.stringify(props))
        return
    }

    if (mode === 'set-props') {
        const [description, color, symbol] = rest
        const before = await readGroupProps(groupId)
        const ops = []
        if (description !== undefined) {
            ops.push({ op: 'add', path: '/description', value: description })
        }
        if (color !== undefined) {
            ops.push({ op: 'add', path: '/color', value: color })
        }
        if (symbol !== undefined) {
            ops.push({ op: 'add', path: '/symbol', value: symbol })
        }
        if (ops.length === 0) {
            throw new Error('set-props needs at least one of description/color/symbol')
        }
        const response = await api(`organisationUnitGroups/${groupId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json-patch+json' },
            body: JSON.stringify(ops),
        })
        const text = await response.text()
        if (!response.ok) {
            throw new Error(`set-props failed: HTTP ${response.status}: ${text.slice(0, 500)}`)
        }
        const after = await readGroupProps(groupId)
        console.log(JSON.stringify({ before, after }))
        return
    }

    if (mode === 'empty') {
        const started = Date.now()
        await jsonPatchReplaceMembers(groupId, [])
        const seconds = (Date.now() - started) / 1000
        const after = await readMembers(groupId)
        console.log(JSON.stringify({ mode: 'empty', seconds, actual: after.length }))
        return
    }

    if (mode === 'verify') {
        const n = rest[0] ? Number(rest[0]) : 5
        const original = await readMembers(groupId)
        const kept = original.slice(n) // drop the first n (the "remove" half)
        const added = await someNonMemberIds(original, n) // the "add" half
        const intended = [...kept, ...added]

        await jsonPatchReplaceMembers(groupId, intended)
        const afterPatch = await readMembers(groupId)
        const intendedSet = new Set(intended)
        const afterSet = new Set(afterPatch)
        const matchedAfterPatch =
            afterPatch.length === intended.length &&
            intended.every((id) => afterSet.has(id)) &&
            afterPatch.every((id) => intendedSet.has(id))
        const removedIds = original.slice(0, n)
        const stillHasRemoved = removedIds.some((id) => afterSet.has(id))
        const hasAdded = added.every((id) => afterSet.has(id))

        // Restore exactly, since this mutates a real group's membership.
        await jsonPatchReplaceMembers(groupId, original)
        const afterRestore = await readMembers(groupId)
        const originalSet = new Set(original)
        const restoredExactly =
            afterRestore.length === original.length &&
            afterRestore.every((id) => originalSet.has(id))

        console.log(
            JSON.stringify({
                mode: 'verify',
                removedCount: n,
                addedCount: added.length,
                removedIds,
                addedIds: added,
                matchedAfterPatch,
                removalTookEffect: !stillHasRemoved,
                additionTookEffect: hasAdded,
                restoredExactly,
            })
        )
        return
    }

    if (mode === 'patch') {
        const memberIds = JSON.parse(await readStdin())
        requestCount = 0
        const started = Date.now()
        await jsonPatchReplaceMembers(groupId, memberIds)
        const seconds = (Date.now() - started) / 1000
        const after = await readMembers(groupId)
        console.log(
            JSON.stringify({
                shape: 'json-patch',
                seconds,
                requestCount,
                intended: memberIds.length,
                actual: after.length,
                complete: after.length === memberIds.length,
            })
        )
        return
    }

    throw new Error(`unknown mode ${mode}`)
}

main().catch((e) => {
    console.error('FAILED:', e.message)
    process.exit(1)
})
