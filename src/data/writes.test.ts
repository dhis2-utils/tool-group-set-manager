import { ENDPOINTS } from './endpoints'
import {
    DEFAULT_BATCH_SIZE,
    UNPARSEABLE_RESPONSE,
    writeMemberships,
} from './writes'
import { GroupChange } from '@/engine/changeSet'
import { ObjectType } from '@/engine/types'

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status })

const okStats = (total: number) =>
    json({
        response: { stats: { total, updated: total, deleted: 0, ignored: 0 } },
    })

describe('writeMemberships', () => {
    it("sends one group's additions and deletions as a single request", async () => {
        const calls: { path: string; method: string; body: unknown }[] = []
        const fetcher = async (path: string, init?: RequestInit) => {
            calls.push({
                path,
                method: init?.method ?? 'GET',
                body: init?.body ? JSON.parse(init.body as string) : undefined,
            })
            return okStats(2)
        }
        const changes: GroupChange[] = [
            { groupId: 'g1', additions: ['a', 'b'], deletions: ['c'] },
        ]
        await writeMemberships(
            fetcher,
            'organisationUnit',
            changes,
            () => undefined
        )

        expect(calls).toEqual([
            {
                path: 'organisationUnitGroups/g1/organisationUnits',
                method: 'POST',
                body: {
                    additions: [{ id: 'a' }, { id: 'b' }],
                    deletions: [{ id: 'c' }],
                },
            },
        ])
    })

    // Plan 7 Task 5, Branch A. The number is a measurement, not a
    // preference: batch 5000 wrote 91,892 memberships in 47.4s against
    // batch 1000's 192s, and cost 2.9x less server work per object while
    // doing it (19.5 rows fetched per object against 56.1). See
    // docs/superpowers/notes/2026-09-plan7-write-shapes.md and spec 6.4.
    // Pinned here so a future change to it has to be a deliberate one.
    it('defaults to the batch size measured fastest in Plan 7', async () => {
        expect(DEFAULT_BATCH_SIZE).toBe(5000)

        const calls: unknown[] = []
        const fetcher = async (_path: string, init?: RequestInit) => {
            calls.push(JSON.parse(String(init?.body)))
            return okStats(
                (JSON.parse(String(init?.body)) as { additions: unknown[] })
                    .additions.length
            )
        }
        // One more than a single batch's worth, so the split is observable.
        const additions = Array.from(
            { length: DEFAULT_BATCH_SIZE + 1 },
            (_, i) => `ou${i}`
        )
        await writeMemberships(
            fetcher,
            'organisationUnit',
            [{ groupId: 'g1', additions, deletions: [] }],
            () => undefined
        )
        expect(calls).toHaveLength(2)
    })

    it('splits a change larger than the batch size and reports progress once per batch', async () => {
        const calls: unknown[] = []
        const fetcher = async (path: string, init?: RequestInit) => {
            calls.push(JSON.parse(init?.body as string))
            const body = JSON.parse(init?.body as string) as {
                additions: unknown[]
                deletions: unknown[]
            }
            return okStats(body.additions.length + body.deletions.length)
        }
        const changes: GroupChange[] = [
            { groupId: 'g1', additions: ['a', 'b', 'c'], deletions: [] },
        ]
        const progress: [number, number][] = []
        const result = await writeMemberships(
            fetcher,
            'organisationUnit',
            changes,
            (done, total) => progress.push([done, total]),
            2
        )

        expect(calls).toEqual([
            { additions: [{ id: 'a' }, { id: 'b' }], deletions: [] },
            { additions: [{ id: 'c' }], deletions: [] },
        ])
        expect(progress).toEqual([
            [1, 2],
            [2, 2],
        ])
        expect(result.applied).toEqual([
            { groupId: 'g1', additions: ['a', 'b'], deletions: [] },
            { groupId: 'g1', additions: ['c'], deletions: [] },
        ])
    })

    it('reports a partial failure when the server accepts fewer changes than it was sent', async () => {
        const fetcher = async () =>
            new Response(
                JSON.stringify({
                    response: {
                        stats: { total: 1, updated: 1, deleted: 0, ignored: 0 },
                    },
                }),
                { status: 200 }
            )
        const result = await writeMemberships(
            fetcher,
            'organisationUnit',
            [{ groupId: 'g1', additions: ['a', 'b'], deletions: [] }],
            () => undefined
        )
        expect(result.outcomes[0]).toMatchObject({
            groupId: 'g1',
            requested: 2,
            accepted: 1,
        })
        expect(result.unaccounted).toEqual([
            { groupId: 'g1', additions: ['a', 'b'], deletions: [] },
        ])
        expect(result.applied).toEqual([])
    })

    it('treats a response with no stats at all as nothing accepted', async () => {
        const fetcher = async () => json({})
        const result = await writeMemberships(
            fetcher,
            'organisationUnit',
            [{ groupId: 'g1', additions: ['a'], deletions: [] }],
            () => undefined
        )
        expect(result.outcomes[0]).toMatchObject({
            groupId: 'g1',
            requested: 1,
            accepted: 0,
        })
        expect(result.unaccounted).toEqual([
            { groupId: 'g1', additions: ['a'], deletions: [] },
        ])
        expect(result.applied).toEqual([])
    })

    it('records a non-200 response as an error against that group without stopping the rest', async () => {
        const fetcher = async (path: string) => {
            if (path.includes('g1')) {
                return new Response('forbidden', { status: 403 })
            }
            return okStats(1)
        }
        const changes: GroupChange[] = [
            { groupId: 'g1', additions: ['a'], deletions: [] },
            { groupId: 'g2', additions: ['b'], deletions: [] },
        ]
        const result = await writeMemberships(
            fetcher,
            'organisationUnit',
            changes,
            () => undefined
        )

        expect(result.outcomes).toEqual([
            {
                groupId: 'g1',
                requested: 1,
                accepted: 0,
                error: 'HTTP 403',
            },
            { groupId: 'g2', requested: 1, accepted: 1 },
        ])
        expect(result.unaccounted).toEqual([
            { groupId: 'g1', additions: ['a'], deletions: [] },
        ])
        expect(result.applied).toEqual([
            { groupId: 'g2', additions: ['b'], deletions: [] },
        ])
    })

    it('an addition already present (ignored by the server) still counts as accepted', async () => {
        const fetcher = async () =>
            json({
                response: {
                    stats: {
                        total: 1,
                        created: 0,
                        updated: 0,
                        deleted: 0,
                        ignored: 1,
                    },
                },
            })
        const result = await writeMemberships(
            fetcher,
            'organisationUnit',
            [{ groupId: 'g1', additions: ['a'], deletions: [] }],
            () => undefined
        )
        expect(result.outcomes[0]).toMatchObject({ requested: 1, accepted: 1 })
        expect(result.applied).toEqual([
            { groupId: 'g1', additions: ['a'], deletions: [] },
        ])
    })

    it('one request per group, sequential, in the order the changes were given', async () => {
        const order: string[] = []
        const fetcher = async (path: string) => {
            order.push(path)
            return okStats(1)
        }
        const changes: GroupChange[] = [
            { groupId: 'g1', additions: ['a'], deletions: [] },
            { groupId: 'g2', additions: ['b'], deletions: [] },
        ]
        await writeMemberships(
            fetcher,
            'organisationUnit',
            changes,
            () => undefined
        )
        expect(order).toEqual([
            'organisationUnitGroups/g1/organisationUnits',
            'organisationUnitGroups/g2/organisationUnits',
        ])
    })

    it('a group with nothing to change makes no request', async () => {
        const calls: string[] = []
        const fetcher = async (path: string) => {
            calls.push(path)
            return okStats(0)
        }
        const changes: GroupChange[] = [
            { groupId: 'g1', additions: [], deletions: [] },
        ]
        const result = await writeMemberships(
            fetcher,
            'organisationUnit',
            changes,
            () => undefined
        )
        expect(calls).toEqual([])
        expect(result.outcomes).toEqual([])
        expect(result.applied).toEqual([])
        expect(result.unaccounted).toEqual([])
    })

    // A non-200 status and a dropped connection are both handled already
    // (see the tests around this one); this is the third way a batch
    // request can go wrong -- the server answers 200 but with a body
    // that isn't JSON at all (an HTML error page from a proxy, say).
    // `response.json()` throws in that case, and the raw parse error
    // (e.g. "Unexpected token < in JSON at position 0") used to become the
    // outcome's whole `error` -- the right conclusion (this batch did not
    // land) with the wrong wording (a JSON parser's own error message is
    // not something a user should ever see). The raw text must still be
    // somewhere on the outcome for diagnostics.
    it('records a sentinel error (never the raw JSON parse error) for a non-JSON 200, and keeps the raw text on rawError', async () => {
        // Minor 2/3 (fix round 1): `error` must never carry an
        // untranslated English fragment -- this module has no `i18n.t` and
        // could not translate it if it tried -- so it records the
        // `UNPARSEABLE_RESPONSE` sentinel instead; `writeOutcomes.ts`'s
        // `describeError` is what turns that into user-facing prose. The
        // raw parser message still ends up on `rawError`, for whoever
        // reads the console.warn logged alongside it (see writes.ts) or a
        // future caller that wants it for a bug report.
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {
            // silence the expected diagnostic log
        })
        const fetcher = async () =>
            new Response('<html>not json</html>', {
                status: 200,
            })
        const changes: GroupChange[] = [
            { groupId: 'g1', additions: ['a'], deletions: [] },
        ]
        const result = await writeMemberships(
            fetcher,
            'organisationUnit',
            changes,
            () => undefined
        )
        expect(result.outcomes).toHaveLength(1)
        const [outcome] = result.outcomes
        expect(outcome.accepted).toBe(0)
        expect(outcome.error).toBe(UNPARSEABLE_RESPONSE)
        expect(outcome.rawError).toMatch(/Unexpected token|JSON/i)
        expect(warn).toHaveBeenCalled()
        warn.mockRestore()
    })

    it('a network failure on one group is recorded as an error and does not stop the rest', async () => {
        const fetcher = async (path: string) => {
            if (path.includes('g1')) {
                throw new Error('network down')
            }
            return okStats(1)
        }
        const changes: GroupChange[] = [
            { groupId: 'g1', additions: ['a'], deletions: [] },
            { groupId: 'g2', additions: ['b'], deletions: [] },
        ]
        const result = await writeMemberships(
            fetcher,
            'organisationUnit',
            changes,
            () => undefined
        )
        expect(result.outcomes[0]).toMatchObject({
            groupId: 'g1',
            requested: 1,
            accepted: 0,
            error: 'network down',
        })
        expect(result.unaccounted).toEqual([
            { groupId: 'g1', additions: ['a'], deletions: [] },
        ])
        expect(result.applied).toEqual([
            { groupId: 'g2', additions: ['b'], deletions: [] },
        ])
    })

    it("a non-permission failure (500) does not skip the rest of that group's batches", async () => {
        // Unlike a 401/403, a 500 says nothing about the group itself -- the
        // next batch still deserves its own attempt. A single-batch group
        // cannot tell "skipped the rest" apart from "there was no rest to
        // skip", so this uses a group split into three one-id batches.
        const calls: string[] = []
        let requestCount = 0
        const fetcher = async (path: string) => {
            calls.push(path)
            requestCount += 1
            if (requestCount === 1) {
                return new Response('server error', { status: 500 })
            }
            return okStats(1)
        }
        const changes: GroupChange[] = [
            { groupId: 'g1', additions: ['a', 'b', 'c'], deletions: [] },
        ]
        const result = await writeMemberships(
            fetcher,
            'organisationUnit',
            changes,
            () => undefined,
            1
        )

        expect(calls).toEqual([
            'organisationUnitGroups/g1/organisationUnits',
            'organisationUnitGroups/g1/organisationUnits',
            'organisationUnitGroups/g1/organisationUnits',
        ])
        expect(result.outcomes).toEqual([
            { groupId: 'g1', requested: 1, accepted: 0, error: 'HTTP 500' },
            { groupId: 'g1', requested: 1, accepted: 1 },
            { groupId: 'g1', requested: 1, accepted: 1 },
        ])
        expect(result.unaccounted).toEqual([
            { groupId: 'g1', additions: ['a'], deletions: [] },
        ])
        expect(result.applied).toEqual([
            { groupId: 'g1', additions: ['b'], deletions: [] },
            { groupId: 'g1', additions: ['c'], deletions: [] },
        ])
    })

    it("a thrown error does not skip the rest of that group's batches", async () => {
        // Same distinction as the 500 case above, for a request that never
        // got an HTTP response at all (a dropped connection, say).
        const calls: string[] = []
        let requestCount = 0
        const fetcher = async (path: string) => {
            calls.push(path)
            requestCount += 1
            if (requestCount === 1) {
                throw new Error('network down')
            }
            return okStats(1)
        }
        const changes: GroupChange[] = [
            { groupId: 'g1', additions: ['a', 'b', 'c'], deletions: [] },
        ]
        const result = await writeMemberships(
            fetcher,
            'organisationUnit',
            changes,
            () => undefined,
            1
        )

        expect(calls).toEqual([
            'organisationUnitGroups/g1/organisationUnits',
            'organisationUnitGroups/g1/organisationUnits',
            'organisationUnitGroups/g1/organisationUnits',
        ])
        expect(result.outcomes).toEqual([
            {
                groupId: 'g1',
                requested: 1,
                accepted: 0,
                error: 'network down',
            },
            { groupId: 'g1', requested: 1, accepted: 1 },
            { groupId: 'g1', requested: 1, accepted: 1 },
        ])
        expect(result.unaccounted).toEqual([
            { groupId: 'g1', additions: ['a'], deletions: [] },
        ])
        expect(result.applied).toEqual([
            { groupId: 'g1', additions: ['b'], deletions: [] },
            { groupId: 'g1', additions: ['c'], deletions: [] },
        ])
    })

    it("skips a group's remaining batches once one comes back forbidden, but still records an outcome for each", async () => {
        const calls: string[] = []
        const fetcher = async (path: string) => {
            calls.push(path)
            if (path.includes('g1')) {
                return new Response('forbidden', { status: 403 })
            }
            return okStats(1)
        }
        const changes: GroupChange[] = [
            { groupId: 'g1', additions: ['a', 'b', 'c'], deletions: [] },
            { groupId: 'g2', additions: ['d'], deletions: [] },
        ]
        const progress: [number, number][] = []
        const result = await writeMemberships(
            fetcher,
            'organisationUnit',
            changes,
            (done, total) => progress.push([done, total]),
            1
        )

        // Only the first of g1's three one-id batches ever goes over the
        // wire; the other two are skipped once g1 is known to be forbidden.
        expect(calls).toEqual([
            'organisationUnitGroups/g1/organisationUnits',
            'organisationUnitGroups/g2/organisationUnits',
        ])
        expect(result.outcomes).toEqual([
            { groupId: 'g1', requested: 1, accepted: 0, error: 'HTTP 403' },
            { groupId: 'g1', requested: 1, accepted: 0, error: 'HTTP 403' },
            { groupId: 'g1', requested: 1, accepted: 0, error: 'HTTP 403' },
            { groupId: 'g2', requested: 1, accepted: 1 },
        ])
        expect(result.unaccounted).toEqual([
            { groupId: 'g1', additions: ['a'], deletions: [] },
            { groupId: 'g1', additions: ['b'], deletions: [] },
            { groupId: 'g1', additions: ['c'], deletions: [] },
        ])
        expect(result.applied).toEqual([
            { groupId: 'g2', additions: ['d'], deletions: [] },
        ])
        // The skipped batches still count toward progress even though no
        // request was sent for them.
        expect(progress).toEqual([
            [1, 4],
            [2, 4],
            [3, 4],
            [4, 4],
        ])
    })

    it('outcomes has one entry per batch, not one per group', async () => {
        const fetcher = async () => okStats(1)
        const changes: GroupChange[] = [
            { groupId: 'g1', additions: ['a', 'b', 'c'], deletions: [] },
            { groupId: 'g2', additions: ['d'], deletions: [] },
        ]
        const result = await writeMemberships(
            fetcher,
            'organisationUnit',
            changes,
            () => undefined,
            1
        )
        expect(result.outcomes).toHaveLength(4)
        expect(result.outcomes.filter((o) => o.groupId === 'g1')).toHaveLength(
            3
        )
    })

    it.each(Object.entries(ENDPOINTS))(
        'builds the request path from the endpoint map for %s',
        async (objectType, endpoint) => {
            const calls: string[] = []
            const fetcher = async (path: string) => {
                calls.push(path)
                return okStats(1)
            }
            await writeMemberships(
                fetcher,
                objectType as ObjectType,
                [{ groupId: 'g1', additions: ['a'], deletions: [] }],
                () => undefined
            )
            expect(calls).toEqual([`${endpoint.groups}/g1/${endpoint.members}`])
        }
    )

    describe('write shape by change size (spec 6.1)', () => {
        const bigChange = (n: number) => ({
            groupId: 'g1',
            additions: Array.from({ length: n }, (_, i) => `ou${i}`),
            deletions: [] as string[],
        })

        it('uses the collection endpoint for a change at the threshold', async () => {
            const calls: string[] = []
            const fetcher = async (path: string, init?: RequestInit) => {
                calls.push(path)
                const body = JSON.parse(String(init?.body)) as {
                    additions: unknown[]
                }
                return okStats(body.additions.length)
            }
            await writeMemberships(
                fetcher,
                'organisationUnit',
                [bigChange(DEFAULT_BATCH_SIZE)],
                () => undefined,
                DEFAULT_BATCH_SIZE,
                new Map([['g1', []]])
            )
            expect(calls).toEqual([
                'organisationUnitGroups/g1/organisationUnits',
            ])
        })

        // Plan 8: the large-change route is a JSON Patch against the
        // group's own endpoint, not a metadata import -- exact call shape
        // proven by scripts/perf/json-patch-members.js and measured in
        // docs/superpowers/notes/2026-09-plan8-json-patch.md. No pre-read
        // of the group's fields: a patch scoped to the members path cannot
        // touch anything else, so there is nothing to read first.
        it('uses a JSON Patch replacing the members collection for a change above the threshold', async () => {
            const calls: {
                path: string
                method?: string
                headers?: unknown
            }[] = []
            const fetcher = async (path: string, init?: RequestInit) => {
                calls.push({
                    path,
                    method: init?.method,
                    headers: init?.headers,
                })
                return json({})
            }
            await writeMemberships(
                fetcher,
                'organisationUnit',
                [bigChange(DEFAULT_BATCH_SIZE + 1)],
                () => undefined,
                DEFAULT_BATCH_SIZE,
                new Map([['g1', ['existing1']]])
            )
            expect(calls).toEqual([
                {
                    path: 'organisationUnitGroups/g1',
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json-patch+json' },
                },
            ])
        })

        it('sends the complete intended membership, not a delta', async () => {
            let body:
                | { op: string; path: string; value: { id: string }[] }[]
                | undefined
            const fetcher = async (_path: string, init?: RequestInit) => {
                body = JSON.parse(String(init?.body))
                return json({})
            }
            await writeMemberships(
                fetcher,
                'organisationUnit',
                [
                    {
                        groupId: 'g1',
                        additions: Array.from(
                            { length: DEFAULT_BATCH_SIZE + 1 },
                            (_, i) => `new${i}`
                        ),
                        deletions: ['gone1'],
                    },
                ],
                () => undefined,
                DEFAULT_BATCH_SIZE,
                new Map([['g1', ['keep1', 'gone1']]])
            )
            expect(body).toEqual([
                {
                    op: 'replace',
                    path: '/organisationUnits',
                    value: expect.any(Array),
                },
            ])
            const sent = body![0].value.map((o) => o.id)
            expect(sent).toContain('keep1')
            expect(sent).toContain('new0')
            expect(sent).not.toContain('gone1')
            expect(sent).toHaveLength(DEFAULT_BATCH_SIZE + 2)
        })

        // Plan 8 removed the metadata-import shape's owner-field pre-read
        // entirely: a JSON Patch scoped to `/organisationUnits` cannot
        // touch any other property, so there is no field list to keep in
        // sync and nothing to fail fetching. The only failure surface left
        // is the patch request itself.
        it('fails the group cleanly when the JSON Patch request fails, with no other request attempted', async () => {
            // patchChange logs the rejection body it now captures; this
            // response has one, so silence the expected diagnostic.
            const warn = jest.spyOn(console, 'warn').mockImplementation(() => {
                // silence the expected diagnostic log
            })
            const calls: string[] = []
            const fetcher = async (path: string) => {
                calls.push(path)
                return new Response('not found', { status: 404 })
            }
            const result = await writeMemberships(
                fetcher,
                'organisationUnit',
                [bigChange(DEFAULT_BATCH_SIZE + 1)],
                () => undefined,
                DEFAULT_BATCH_SIZE,
                new Map([['g1', []]])
            )
            expect(calls).toEqual(['organisationUnitGroups/g1'])
            expect(result.applied).toHaveLength(0)
            expect(result.unaccounted).toHaveLength(1)
            expect(result.outcomes[0].error).toBe('HTTP 404')
            warn.mockRestore()
        })

        // Plan 9 induced every way DHIS2 refuses a members patch, on all
        // four supported versions: each answers 409 (or 403 for authority)
        // with an ObjectReport saying exactly what was wrong, and with the
        // membership untouched. That explanation used to be discarded,
        // leaving a failed large write diagnosable only as "HTTP 409" --
        // see docs/superpowers/notes/2026-09-plan9-json-patch-rejection.md.
        // It belongs on `rawError`, not `error`: `error` is spliced into
        // translated sentences and must stay locale-neutral.
        it('keeps the server explanation for a rejected patch on rawError, never on error', async () => {
            const warn = jest.spyOn(console, 'warn').mockImplementation(() => {
                // silence the expected diagnostic log
            })
            const fetcher = async () =>
                new Response(
                    JSON.stringify({
                        httpStatus: 'Conflict',
                        httpStatusCode: 409,
                        status: 'ERROR',
                        message:
                            'One or more errors occurred, please see full details in import report.',
                        response: {
                            errorReports: [
                                { message: 'Invalid reference [Zz9GhOsT000]' },
                            ],
                        },
                    }),
                    { status: 409 }
                )
            const result = await writeMemberships(
                fetcher,
                'organisationUnit',
                [bigChange(DEFAULT_BATCH_SIZE + 1)],
                () => undefined,
                DEFAULT_BATCH_SIZE,
                new Map([['g1', []]])
            )
            const [outcome] = result.outcomes
            expect(outcome.error).toBe('HTTP 409')
            expect(outcome.rawError).toContain('Invalid reference')
            expect(warn).toHaveBeenCalled()
            warn.mockRestore()
        })

        // The structural safety property: no fresh membership, no replace-all.
        it('falls back to batched above the threshold when no complete membership is given', async () => {
            const calls: { path: string; method?: string }[] = []
            const fetcher = async (path: string, init?: RequestInit) => {
                calls.push({ path, method: init?.method })
                const body = JSON.parse(String(init?.body)) as {
                    additions: unknown[]
                }
                return okStats(body.additions.length)
            }
            await writeMemberships(
                fetcher,
                'organisationUnit',
                [bigChange(DEFAULT_BATCH_SIZE + 1)],
                () => undefined
            )
            expect(calls.every((c) => c.method !== 'PATCH')).toBe(true)
            expect(calls).toHaveLength(2)
        })

        it('reports a patch group in WriteResult exactly as a batched one', async () => {
            const fetcher = async () => json({})
            const result = await writeMemberships(
                fetcher,
                'organisationUnit',
                [bigChange(DEFAULT_BATCH_SIZE + 1)],
                () => undefined,
                DEFAULT_BATCH_SIZE,
                new Map([['g1', []]])
            )
            expect(result.applied).toHaveLength(1)
            expect(result.unaccounted).toHaveLength(0)
            expect(result.outcomes[0]).toMatchObject({
                groupId: 'g1',
                requested: DEFAULT_BATCH_SIZE + 1,
                accepted: DEFAULT_BATCH_SIZE + 1,
            })
        })
    })
})
