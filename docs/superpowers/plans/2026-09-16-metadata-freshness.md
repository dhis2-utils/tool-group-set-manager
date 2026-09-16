# Metadata Freshness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the app ever presenting an unbounded, unlabelled metadata snapshot — bound its age, show that age, let the user refresh it, and guarantee it is current at the moment a bulk fix writes.

**Architecture:** Three layers over one idea. The cache gains a TTL and surfaces the age it already records but never reads. The shared filter bar grows a status slot showing that age, escalating past the TTL but never refetching on its own. The bulk fix re-reads only the groups its plan names immediately before writing, recomputes, and re-confirms with the user only if the plan actually changed — which is also what makes a metadata-import write shape safe, so write shape becomes a per-group choice by change size.

**Tech Stack:** TypeScript, React 18, @dhis2/ui 10.17.0, @dhis2/app-runtime, TanStack Query v4, Jest + @testing-library/react, Playwright for e2e, Vite via the DHIS2 App Platform, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-16-metadata-freshness-design.md`. It amends `docs/superpowers/specs/2026-09-15-manual-review-1-design.md` §4.4, §6.3 and §6.4 — Task 10 writes those amendments.

## Global Constraints

- Supported DHIS2 versions: **2.40 and newer**.
- `src/engine` is pure TypeScript with typed arrays, runs in a Web Worker, imports nothing from React or DHIS2. Test it with plain Jest.
- Every user-facing string goes through a single, **argument-free** `i18n.t('…')` call. Any second argument makes the call invisible to this project's i18next-scanner, so it never reaches `i18n/en.pot`.
- **A sentence is translated whole.** Never join translated fragments around a value; put a `{name}` placeholder inside the one complete string and fill it with `interpolate()` from `src/utils/interpolate.ts`. Single braces, never `{{…}}`.
- **No colon inside an `i18n.t()` string** — the scanner reads it as a namespace separator and drops the key.
- Counts are two complete strings chosen on `count === 1`, with the number in a `{count}` placeholder.
- **"Metadata", never "Data."** In DHIS2 "data" means data values; this snapshot is organisation units, groups, group sets and memberships (spec §4.3).
- Data fetching goes through `useApiDataQuery` (TanStack Query v4), never `useDataQuery` directly. The write path (`src/data/writes.ts`) uses `createFetcher` directly, as it already does.
- Jest maps every `.css` import to an empty object, so a component's own CSS-module class names are `undefined` in tests. Do not assert on one without a scoped per-file mock.
- Run `pnpm exec d2-app-scripts i18n extract` after adding or changing any string; commit `i18n/en.pot` and check the output for scanner warnings.
- Gates before every commit: `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm exec eslint src`, and `pnpm exec tsc -p e2e --noEmit` when `e2e/` is touched.
- **Commit message trailer:** end every commit message with exactly `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Never a `Claude-Session:` or session-URL trailer.
- **e2e browser path:** `e2e/playwright.config.ts` pins a Chromium build that no longer exists in this image. Export `PLAYWRIGHT_CHROME_PATH=/opt/playwright-browsers/chromium-1234/chrome-linux/chrome` before any Playwright run, or every test fails at launch.
- Broker instances are shared. Keep **one running at a time**; never reset or delete one you did not create; restore the state you found.

---

## File Structure

| File | Responsibility after this plan |
| --- | --- |
| `scripts/perf/reread-cost.js` | **New.** Measures the §5.4 risk — what re-reading a plan's groups costs on a real population |
| `docs/superpowers/notes/2026-09-plan8-reread-cost.md` | **New.** That measurement, and what it means for Task 9 |
| `src/data/cache.ts` | Exports `CACHE_TTL_MS`; `savedAt`'s doc comment says what now reads it |
| `src/data/loadAll.ts` | `tryCache` gains the TTL gate; `LoadStatus` gains `loadedAt`, set on both the cache-hit and network branches |
| `src/utils/metadataAge.ts` | **New.** One `loadedAt` plus a clock into one whole translated sentence and a `stale` flag |
| `src/components/FilterBar/FilterBar.tsx` | Gains an optional `status` slot, right-aligned |
| `src/components/MetadataFreshness/MetadataFreshness.tsx` | **New.** The indicator and its Refresh button |
| `src/pages/Dashboard/Dashboard.tsx` | Renders the indicator against the **oldest** loaded type |
| `src/pages/GroupSetDetail/GroupSetDetail.tsx` | Renders the indicator against **that set's** object type |
| `src/engine/protocol.ts` | `setGroupMembers` added to `EngineMethod` |
| `src/engine/store.ts` | `setGroupMembers` — absolute membership for named groups, re-evaluating only affected sets |
| `src/data/writes.ts` | Per-group shape selection at `DEFAULT_BATCH_SIZE`; the import path |
| `src/hooks/useMembershipWrite.ts` | Carries `completeMembers` from the dialog to the writer |
| `src/components/BulkFixDialog/BulkFixDialog.tsx` | Pre-write refresh, recompute, re-confirm |
| `e2e/flows.spec.ts` | A flow covering the indicator and Refresh |

**Dependency order:** Task 1 first — it can invalidate Task 9's design and nothing else depends on it. Tasks 2 and 3 are independent of each other and of Task 1. Task 4 → Task 5 → Task 6. Task 7 and Task 8 are independent of each other; Task 9 needs both plus Task 3. Task 10 needs Tasks 8 and 9 to have landed. Task 11 needs Task 6.

---

### Task 1: Measure what the pre-write re-read costs

**Files:**
- Create: `scripts/perf/reread-cost.js`
- Create: `docs/superpowers/notes/2026-09-plan8-reread-cost.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a number Task 9 needs, and a documented go/no-go on spec §5.1's design. No app code.

**Why this is first.** Spec §5.4 names this as the design's one unmeasured risk and requires it settled before the check is wired in. A "move to catch-all" plan can name every group in a set; on `agent-gsi-emis` a single set's total membership runs to hundreds of thousands of ids, and all of it would land on the Apply button. If that is ten seconds, §5.1 needs rethinking rather than shipping behind a spinner.

**The instance.** `agent-gsi-emis` (2.41, 266,396 organisation units). Start it and run nothing else concurrently — `docs/superpowers/notes/2026-09plan7-write-shapes.md` §3 records a measurement distorted 2.4× by competing work on the same host.

- [ ] **Step 1: Write the measurement script**

Create `scripts/perf/reread-cost.js`:

```js
// Measures spec 2026-09-16 section 5.4: what re-reading a plan's groups
// costs, which is what the bulk fix's pre-write freshness check will pay on
// every Apply. Kept in the repository so a future run is a re-run.
//
// Usage: node scripts/perf/reread-cost.js <groupSetId>
// Overridable: GSI_PERF_BASE_URL, GSI_PERF_USERNAME, GSI_PERF_PASSWORD
'use strict'

const BASE_URL =
    process.env.GSI_PERF_BASE_URL || 'http://dhis2-agent-gsi-emis:8080'
const AUTH =
    'Basic ' +
    Buffer.from(
        `${process.env.GSI_PERF_USERNAME || 'local_admin'}:${
            process.env.GSI_PERF_PASSWORD || 'district'
        }`
    ).toString('base64')

async function api(path) {
    const r = await fetch(`${BASE_URL}/api/${path}`, {
        headers: { Authorization: AUTH },
        cache: 'no-store',
    })
    if (!r.ok) {
        throw new Error(`HTTP ${r.status} on ${path}`)
    }
    return r.json()
}

async function main() {
    const setId = process.argv[2]
    if (!setId) {
        throw new Error('usage: node scripts/perf/reread-cost.js <groupSetId>')
    }
    const set = await api(
        `organisationUnitGroupSets/${setId}?fields=name,organisationUnitGroups%5Bid,name%5D`
    )
    const groups = set.organisationUnitGroups

    // Worst case: every group in the set, which is what "move to catch-all"
    // over an unfiltered population produces. Read them sequentially, the
    // way the app will.
    const started = Date.now()
    let totalIds = 0
    for (const g of groups) {
        const body = await api(
            `organisationUnitGroups/${g.id}/organisationUnits?fields=id&paging=false`
        )
        totalIds += body.organisationUnits.length
    }
    const seconds = (Date.now() - started) / 1000

    console.log(
        JSON.stringify(
            {
                set: set.name,
                groups: groups.length,
                totalIds,
                seconds,
                secondsPerGroup: seconds / groups.length,
            },
            null,
            2
        )
    )
}

main().catch((e) => {
    console.error('FAILED:', e.message)
    process.exit(1)
})
```

- [ ] **Step 2: Run it against the largest and a typical set**

```bash
curl -s -X POST -H "Authorization: Bearer $DHIS2_BROKER_TOKEN" \
  "$DHIS2_BROKER_URL/instances/agent-gsi-emis/start"
# wait for the job to leave "running", then:
node scripts/perf/reread-cost.js Ibw8YdnSCJq   # Geo-Political Zone, 6 groups
node scripts/perf/reread-cost.js kqEaTzvdL6D   # School Level, 4 groups
node scripts/perf/reread-cost.js K2HBmy0JOC2   # Location Rural/Urban, 2 groups
```

Run each twice and record both, so a single slow run is not mistaken for the cost.

- [ ] **Step 3: Write the note, with a verdict**

Create `docs/superpowers/notes/2026-09-plan8-reread-cost.md`: the instance, each set, groups, total ids, seconds, and seconds per group. Then a plain verdict against these thresholds, which are the ones §5.4's mitigations are pitched at:

- **under ~2s** — wire it in as specified; no progress indicator needed beyond the existing button-disabled state.
- **2–6s** — wire it in, and Task 9 must show progress while it runs.
- **over ~6s** — **stop and report.** §5.1 needs revisiting (read only the groups with *deletions* rather than every named group, or check counts before reading ids). Do not proceed to Task 9 with a workaround.

- [ ] **Step 4: Stop the instance and commit**

```bash
curl -s -X POST -H "Authorization: Bearer $DHIS2_BROKER_TOKEN" \
  "$DHIS2_BROKER_URL/instances/agent-gsi-emis/stop"
git add scripts/perf/reread-cost.js docs/superpowers/notes/2026-09-plan8-reread-cost.md
git commit -m "Measure what the pre-write metadata re-read costs"
```

---

### Task 2: Give the cache a TTL

**Files:**
- Modify: `src/data/cache.ts`, `src/data/loadAll.ts`
- Test: `src/data/loadAll.test.ts`

**Interfaces:**
- Consumes: `CachedType.savedAt`, which already exists.
- Produces: `CACHE_TTL_MS` exported from `src/data/cache.ts`. Task 4's tests use it to build ages either side of the boundary.

**Why.** `savedAt` is written on every cache put and read by nothing, and there is no expiry. Combined with the `lastUpdated` gate being blind to membership moves on 2.41–2.43 (`2026-09-plan7-lastupdated-guard.md`), a browser can serve a snapshot of arbitrary age with nothing able to notice.

- [ ] **Step 1: Write the failing test**

In `src/data/loadAll.test.ts`, alongside the existing cache tests:

```ts
it('does not reuse a cache entry older than the TTL, even when every other gate passes', async () => {
    // The gates that exist today all pass here -- same group ids, same
    // object total, same lastUpdated stamps. On 2.41-2.43 that is exactly
    // the state a membership move leaves behind, which is why age has to
    // be a gate of its own.
    const cache = makeCache()
    await cache.put('organisationUnit', {
        ...cachedFixture(),
        savedAt: Date.now() - CACHE_TTL_MS - 1,
    })
    const fetcher = countingFetcher()
    await loadAll({ ...deps(cache, fetcher), forceRefresh: false })
    expect(fetcher.calls.some((p) => p.includes('/organisationUnits'))).toBe(
        true
    )
})

it('reuses a cache entry inside the TTL', async () => {
    const cache = makeCache()
    await cache.put('organisationUnit', {
        ...cachedFixture(),
        savedAt: Date.now() - 1000,
    })
    const status = await loadAll({ ...deps(cache), forceRefresh: false })
    expect(status.fromCache.organisationUnit).toBe(true)
})
```

Match the existing file's own fixture helpers rather than the placeholder names above — `src/data/loadAll.test.ts` already builds a cache, a fetcher and a `deps` object for its current cache tests; reuse them.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm test -- loadAll`
Expected: the first FAILS (the stale entry is reused), the second PASSES already.

- [ ] **Step 3: Export the constant**

In `src/data/cache.ts`, above `CachedType`:

```ts
/**
 * How long a cached payload may be reused before it is re-read regardless
 * of what the server's own signals say.
 *
 * This is not belt-and-braces on top of a working check. On 2.41 through
 * 2.43 a group's `lastUpdated` does not move when its membership changes
 * (docs/superpowers/notes/2026-09-plan7-lastupdated-guard.md), and neither
 * the group id list nor the object total can see an object moving between
 * groups -- so on three of four supported versions every gate spec 4.4
 * defines is blind to the one change this tool exists to watch. Age cannot
 * make them see it; it bounds how long they can be wrong.
 *
 * Ten minutes is a starting value chosen to match "a few minutes old is
 * fine", not a tuned one.
 */
export const CACHE_TTL_MS = 10 * 60 * 1000
```

Update `savedAt`'s own doc comment in `CachedType` to say `tryCache` now reads it, so the next reader does not rediscover that it was dead.

- [ ] **Step 4: Add the gate**

In `src/data/loadAll.ts`, import `CACHE_TTL_MS` and make it the **first** check in `tryCache`:

```ts
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
```

Extend `tryCache`'s doc comment with a sentence naming the TTL and why it is not redundant.

- [ ] **Step 5: Run the gates and commit**

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src
git add src/data/cache.ts src/data/loadAll.ts src/data/loadAll.test.ts
git commit -m "Expire a cached metadata payload after ten minutes"
```

---

### Task 3: Carry the age out of the loader

**Files:**
- Modify: `src/data/loadAll.ts`
- Test: `src/data/loadAll.test.ts`

**Interfaces:**
- Consumes: `CachedType.savedAt`.
- Produces: `LoadStatus.loadedAt: Partial<Record<ObjectType, number>>` — epoch ms of the **underlying server read** per type, not of the page load. Tasks 5 and 6 read it off `useEngine().status`.

- [ ] **Step 1: Write the failing tests**

In `src/data/loadAll.test.ts`:

```ts
it('reports loadedAt as the time of the server read on a fresh load', async () => {
    const before = Date.now()
    const status = await loadAll({ ...deps(), forceRefresh: false })
    expect(status.loadedAt.organisationUnit).toBeGreaterThanOrEqual(before)
})

it('reports the cached savedAt, not now, when a type is served from cache', async () => {
    // The age the user is shown must be the age of the data, not of the
    // page load -- a cache hit that reported `now` would claim freshness it
    // does not have, which is the whole defect this feature exists to fix.
    const savedAt = Date.now() - 5 * 60 * 1000
    const cache = makeCache()
    await cache.put('organisationUnit', { ...cachedFixture(), savedAt })
    const status = await loadAll({ ...deps(cache), forceRefresh: false })
    expect(status.fromCache.organisationUnit).toBe(true)
    expect(status.loadedAt.organisationUnit).toBe(savedAt)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test -- loadAll`
Expected: FAIL — `loadedAt` does not exist.

- [ ] **Step 3: Add the field**

In `src/data/loadAll.ts`, on `LoadStatus`:

```ts
    /**
     * When each type's payload was actually read from the server, epoch ms.
     * A cache hit carries the stored `savedAt` forward unchanged, so this is
     * always the age of the *data* and never of the page load -- a cache hit
     * reporting `now` would claim a freshness it does not have.
     */
    loadedAt: Partial<Record<ObjectType, number>>
```

Initialise it in the `const status: LoadStatus = { … }` literal (around line 200) as `loadedAt: {}`, and add it to `emit`'s defensive spread alongside `fromCache`, `errors` and `namesErrors`:

```ts
        deps.onStatus({
            ...status,
            fromCache: { ...status.fromCache },
            loadedAt: { ...status.loadedAt },
            errors: { ...status.errors },
            namesErrors: { ...status.namesErrors },
        })
```

- [ ] **Step 4: Set it on both branches**

On the cache-hit branch, beside `status.fromCache[type] = true`:

```ts
                status.fromCache[type] = true
                status.loadedAt[type] = reused.savedAt
```

On the network branch, set it from the same value written into the cache entry, so the two can never disagree. The cache write already computes `savedAt: Date.now()` — hoist it:

```ts
            const savedAt = Date.now()
            status.loadedAt[type] = savedAt
            if (!namesFailed) {
                const entry: CachedType = {
                    // … unchanged …
                    savedAt,
                }
                await deps.cache.put(type, entry)
            }
```

Note the placement: `loadedAt` is set **outside** the `namesFailed` guard. A names failure deliberately skips the cache write (see that block's own comment), but the objects and memberships were still read just now, and the age shown must reflect that rather than reverting to whatever a previous load left.

- [ ] **Step 5: Run the gates and commit**

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src
git add src/data/loadAll.ts src/data/loadAll.test.ts
git commit -m "Report when each type's metadata was actually read"
```

---

### Task 4: Turn an age into a sentence

**Files:**
- Create: `src/utils/metadataAge.ts`
- Test: `src/utils/metadataAge.test.ts`

**Interfaces:**
- Consumes: `CACHE_TTL_MS` from `@/data/cache`; `interpolate` from `@/utils/interpolate`.
- Produces:
  ```ts
  export interface MetadataAge {
      /** One complete translated sentence, ready to render. */
      label: string
      /** Past CACHE_TTL_MS -- drives the amber treatment. */
      stale: boolean
  }
  export function metadataAge(loadedAt: number, now: number): MetadataAge
  ```
  `now` is a parameter, not `Date.now()` read inside, so the tests are not clock-dependent.

**The string rule this task exists to respect.** The stale variants are a **parallel set of whole sentences**, never the fresh sentence wrapped in a second one. Nesting a translated fragment inside another translated sentence is what CLAUDE.md forbids — a translator cannot reorder it. Twelve short strings is the price and it is the right one.

- [ ] **Step 1: Write the failing tests**

Create `src/utils/metadataAge.test.ts`:

```ts
import { CACHE_TTL_MS } from '@/data/cache'
import { metadataAge } from '@/utils/metadataAge'

const NOW = 1_700_000_000_000

describe('metadataAge', () => {
    it('reads as just now under a minute', () => {
        expect(metadataAge(NOW - 59_000, NOW).label).toBe(
            'Metadata from just now'
        )
    })

    it('uses the singular string at exactly one minute', () => {
        expect(metadataAge(NOW - 60_000, NOW).label).toBe(
            'Metadata from 1 minute ago'
        )
    })

    it('uses the plural string for several minutes', () => {
        expect(metadataAge(NOW - 5 * 60_000, NOW).label).toBe(
            'Metadata from 5 minutes ago'
        )
    })

    it('switches to hours at sixty minutes', () => {
        expect(metadataAge(NOW - 60 * 60_000, NOW).label).toBe(
            'Metadata from 1 hour ago'
        )
    })

    it('stops at over a day rather than counting days', () => {
        expect(metadataAge(NOW - 50 * 60 * 60_000, NOW).label).toBe(
            'Metadata from over a day ago'
        )
    })

    it('is not stale inside the TTL', () => {
        expect(metadataAge(NOW - CACHE_TTL_MS + 1, NOW).stale).toBe(false)
    })

    it('is stale past the TTL, and says so in one whole sentence', () => {
        const { label, stale } = metadataAge(NOW - 2 * 60 * 60_000, NOW)
        expect(stale).toBe(true)
        expect(label).toBe(
            'Metadata from 2 hours ago and may be out of date'
        )
    })

    // A clock skew, or a savedAt written by a machine slightly ahead, must
    // not produce "Metadata from -3 minutes ago".
    it('treats a future timestamp as just now', () => {
        expect(metadataAge(NOW + 10_000, NOW).label).toBe(
            'Metadata from just now'
        )
    })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test -- metadataAge`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement it**

Create `src/utils/metadataAge.ts`:

```ts
import i18n from '@dhis2/d2-i18n'
import { CACHE_TTL_MS } from '@/data/cache'
import { interpolate } from '@/utils/interpolate'

export interface MetadataAge {
    /** One complete translated sentence, ready to render. */
    label: string
    /** Past CACHE_TTL_MS -- drives the amber treatment. */
    stale: boolean
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * The age of a metadata snapshot as one whole translated sentence.
 *
 * Every branch below is a complete sentence in its own right, and the stale
 * variants are a parallel set rather than the fresh sentence with a suffix
 * glued on. Building "…and may be out of date" by wrapping an already
 * translated string would put a translated fragment inside a translated
 * sentence, which no translator can reorder -- see CLAUDE.md. Twelve short
 * strings is the cost of getting that right.
 *
 * Granularity stops at "over a day": days, weeks and months would be more
 * strings for a number nobody acts on differently.
 *
 * `now` is a parameter rather than a `Date.now()` call inside, so callers
 * can drive it from a ticking clock and tests need no fake timers.
 */
export function metadataAge(loadedAt: number, now: number): MetadataAge {
    // A negative age (clock skew, or a savedAt from a machine running
    // ahead) must never render as "-3 minutes ago".
    const elapsed = Math.max(0, now - loadedAt)
    const stale = elapsed > CACHE_TTL_MS
    return { label: stale ? staleLabel(elapsed) : freshLabel(elapsed), stale }
}

function freshLabel(elapsed: number): string {
    if (elapsed < MINUTE) {
        return i18n.t('Metadata from just now')
    }
    if (elapsed < HOUR) {
        const count = Math.floor(elapsed / MINUTE)
        return count === 1
            ? i18n.t('Metadata from 1 minute ago')
            : interpolate(i18n.t('Metadata from {count} minutes ago'), {
                  count,
              })
    }
    if (elapsed < DAY) {
        const count = Math.floor(elapsed / HOUR)
        return count === 1
            ? i18n.t('Metadata from 1 hour ago')
            : interpolate(i18n.t('Metadata from {count} hours ago'), { count })
    }
    return i18n.t('Metadata from over a day ago')
}

function staleLabel(elapsed: number): string {
    if (elapsed < MINUTE) {
        return i18n.t('Metadata from just now and may be out of date')
    }
    if (elapsed < HOUR) {
        const count = Math.floor(elapsed / MINUTE)
        return count === 1
            ? i18n.t('Metadata from 1 minute ago and may be out of date')
            : interpolate(
                  i18n.t('Metadata from {count} minutes ago and may be out of date'),
                  { count }
              )
    }
    if (elapsed < DAY) {
        const count = Math.floor(elapsed / HOUR)
        return count === 1
            ? i18n.t('Metadata from 1 hour ago and may be out of date')
            : interpolate(
                  i18n.t('Metadata from {count} hours ago and may be out of date'),
                  { count }
              )
    }
    return i18n.t('Metadata from over a day ago and may be out of date')
}
```

`staleLabel`'s sub-minute and one-minute branches are unreachable while `CACHE_TTL_MS` is ten minutes. They exist so the function stays total if the TTL is lowered — which its own doc comment invites — rather than silently falling through to a wrong sentence.

- [ ] **Step 4: Run the tests, extract strings, commit**

```bash
pnpm test -- metadataAge
pnpm exec d2-app-scripts i18n extract
```

Check the extract output names all twelve new strings and emits no scanner warning. Then:

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src
git add src/utils/metadataAge.ts src/utils/metadataAge.test.ts i18n/en.pot
git commit -m "Render a metadata snapshot's age as one whole sentence"
```

---

### Task 5: The indicator component

**Files:**
- Modify: `src/components/FilterBar/FilterBar.tsx`, `src/components/FilterBar/FilterBar.module.css`
- Create: `src/components/MetadataFreshness/MetadataFreshness.tsx`, `src/components/MetadataFreshness/MetadataFreshness.module.css`
- Test: `src/components/MetadataFreshness/MetadataFreshness.test.tsx`

**Interfaces:**
- Consumes: `metadataAge` (Task 4); `useEngine()`'s `reload`.
- Produces:
  ```tsx
  <FilterBar status={<MetadataFreshness loadedAt={n} />}>…</FilterBar>
  <MetadataFreshness loadedAt={number | null} />
  ```
  `loadedAt` is `null` while nothing has loaded, and the component renders nothing then — Task 6 passes it straight through without its own guard.

- [ ] **Step 1: Write the failing tests**

Create `src/components/MetadataFreshness/MetadataFreshness.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { MetadataFreshness } from './MetadataFreshness'
import { CACHE_TTL_MS } from '@/data/cache'

const mockReload = jest.fn(async () => undefined)
jest.mock('@/hooks/useEngine', () => ({
    useEngine: () => ({ reload: mockReload }),
}))

beforeEach(() => jest.clearAllMocks())

it('renders nothing before anything has loaded', () => {
    const { container } = render(<MetadataFreshness loadedAt={null} />)
    expect(container).toBeEmptyDOMElement()
})

it('shows the age of the data', () => {
    render(<MetadataFreshness loadedAt={Date.now() - 2 * 60_000} />)
    expect(screen.getByText('Metadata from 2 minutes ago')).toBeInTheDocument()
})

it('says the data may be out of date once past the TTL', () => {
    render(<MetadataFreshness loadedAt={Date.now() - CACHE_TTL_MS - 60_000} />)
    expect(
        screen.getByText(/may be out of date/)
    ).toBeInTheDocument()
})

it('forces a reload when refreshed -- never a cache-reusing one', () => {
    render(<MetadataFreshness loadedAt={Date.now()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(mockReload).toHaveBeenCalledWith(true)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test -- MetadataFreshness`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Add the FilterBar slot**

In `src/components/FilterBar/FilterBar.tsx`:

```tsx
export const FilterBar = ({
    children,
    status,
}: {
    children: React.ReactNode
    /**
     * Right-aligned, and deliberately not a `FilterBarField`: everything
     * else in this row is label-above because it is something you set, and
     * being the one thing shaped differently is what makes this read as
     * status rather than as another control (spec 2026-09-16 section 4.1).
     */
    status?: React.ReactNode
}) => (
    <div className={styles.bar} data-test="filter-bar">
        <div className={styles.row}>{children}</div>
        {status && <div className={styles.status}>{status}</div>}
    </div>
)
```

In `FilterBar.module.css`, make `.bar` a `space-between` flex row and add `.status { margin-left: auto; }` so the slot sits right regardless of how many fields the page has.

- [ ] **Step 4: Implement the component**

Create `src/components/MetadataFreshness/MetadataFreshness.tsx`:

```tsx
import i18n from '@dhis2/d2-i18n'
import { Button } from '@dhis2/ui'
import React, { useEffect, useState } from 'react'
import styles from './MetadataFreshness.module.css'
import { useEngine } from '@/hooks/useEngine'
import { metadataAge } from '@/utils/metadataAge'

/** How often the rendered age catches up with the clock. */
const TICK_MS = 30_000

/**
 * Spec 2026-09-16 section 4: how old the metadata on screen is, and a way to
 * replace it.
 *
 * It never refetches on its own. Past the TTL it turns amber and changes
 * what it says, and that is all -- silently re-reading would change counts
 * under someone half way through setting up a bulk fix, which is worse than
 * an honest label. Correctness at the point it matters is the bulk fix's own
 * pre-write check (section 5), not this.
 */
export const MetadataFreshness = ({ loadedAt }: { loadedAt: number | null }) => {
    const { reload } = useEngine()
    const [busy, setBusy] = useState(false)
    // Re-render on a timer so "2 minutes ago" does not sit there reading
    // "just now" for the life of the page. Half a minute is well inside the
    // coarsest granularity the label has.
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), TICK_MS)
        return () => clearInterval(id)
    }, [])

    if (loadedAt === null) {
        return null
    }
    const { label, stale } = metadataAge(loadedAt, now)

    const onRefresh = async () => {
        setBusy(true)
        try {
            await reload(true)
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className={styles.freshness}>
            <span
                className={`${styles.dot} ${
                    busy ? styles.busy : stale ? styles.stale : styles.fresh
                }`}
            />
            <span className={stale ? styles.staleText : undefined}>
                {busy ? i18n.t('Reloading metadata…') : label}
            </span>
            <Button small disabled={busy} onClick={() => void onRefresh()}>
                {i18n.t('Refresh')}
            </Button>
        </div>
    )
}
```

Create `MetadataFreshness.module.css` with `.freshness` as a small-gap flex row, `.dot` a 7px circle, and `.fresh` / `.stale` / `.busy` / `.staleText` carrying the colours (green `#4caf50`, amber `#ff9302`, grey `#a0adba`, amber text `#8a5a00`).

- [ ] **Step 5: Run the tests, extract strings, commit**

```bash
pnpm exec d2-app-scripts i18n extract
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src
git add src/components/FilterBar src/components/MetadataFreshness i18n/en.pot
git commit -m "Add a metadata freshness indicator with its own refresh"
```

---

### Task 6: Put the indicator on both pages

**Files:**
- Modify: `src/pages/Dashboard/Dashboard.tsx`, `src/pages/GroupSetDetail/GroupSetDetail.tsx`
- Test: `src/pages/Dashboard/Dashboard.test.tsx`, `src/pages/GroupSetDetail/GroupSetDetail.test.tsx`

**Interfaces:**
- Consumes: `LoadStatus.loadedAt` (Task 3) via `useEngine().status`; `MetadataFreshness` (Task 5).
- Produces: nothing other tasks import.

**The rule for which age.** The group set page shows the age of **that set's own object type** — the only type on screen, so it is exact. The dashboard shows the **oldest** across the types it renders: a summary built from four snapshots is only as current as its stalest one.

- [ ] **Step 1: Write the failing tests**

In `src/pages/GroupSetDetail/GroupSetDetail.test.tsx`:

```tsx
it("shows the age of this set's own object type", async () => {
    mockStatus = {
        ...baseStatus,
        loadedAt: {
            organisationUnit: Date.now() - 3 * 60_000,
            dataElement: Date.now() - 90 * 60_000,
        },
    }
    renderDetail({ objectType: 'organisationUnit' })
    expect(
        await screen.findByText('Metadata from 3 minutes ago')
    ).toBeInTheDocument()
})
```

In `src/pages/Dashboard/Dashboard.test.tsx`:

```tsx
it('shows the oldest type\'s age, never the newest', async () => {
    // A dashboard is only as current as its stalest section; reporting the
    // freshest would overstate the whole page.
    mockStatus = {
        ...baseStatus,
        loadedAt: {
            organisationUnit: Date.now() - 2 * 60_000,
            dataElement: Date.now() - 45 * 60_000,
        },
    }
    renderDashboard()
    expect(
        await screen.findByText(/45 minutes ago/)
    ).toBeInTheDocument()
})
```

Both files already mock `useEngine`; extend that mock's return value with `status` rather than adding a second mock.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test -- "Dashboard|GroupSetDetail"`
Expected: FAIL — nothing renders the text.

- [ ] **Step 3: Wire up the group set page**

In `GroupSetDetail.tsx`, take `status` from `useEngine()` (it is already destructured there) and pass the slot:

```tsx
<FilterBar
    status={
        <MetadataFreshness
            loadedAt={status?.loadedAt[set.objectType] ?? null}
        />
    }
>
```

- [ ] **Step 4: Wire up the dashboard**

In `Dashboard.tsx`:

```tsx
// The oldest of the loaded types, not the newest: a dashboard built from
// four snapshots is only as current as its stalest one, and reporting the
// freshest would overstate the page as a whole.
const oldestLoadedAt = useMemo(() => {
    const stamps = Object.values(status?.loadedAt ?? {}).filter(
        (n): n is number => typeof n === 'number'
    )
    return stamps.length > 0 ? Math.min(...stamps) : null
}, [status])
```

and pass `<MetadataFreshness loadedAt={oldestLoadedAt} />` as `FilterBar`'s `status`.

- [ ] **Step 5: Run the gates and commit**

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src
git add src/pages/Dashboard src/pages/GroupSetDetail
git commit -m "Show metadata age on the dashboard and the group set page"
```

---

### Task 7: `setGroupMembers` on the engine

**Files:**
- Modify: `src/engine/protocol.ts`, `src/engine/store.ts`
- Test: `src/engine/store.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  setGroupMembers(
      objectType: ObjectType,
      groups: { groupId: string; memberIds: string[] }[]
  ): void
  ```
  Called over the worker as `client.call('setGroupMembers', objectType, groups)`. Task 9 uses it.

**Why it is needed.** `planAssignment` computes against the engine's own membership, so fresh data has to reach the engine before a plan can be recomputed — and `loadMemberships` only takes a whole type's payload. This is `applyChangeSet`'s machinery with absolute values instead of a delta: it patches `membersByGroup` and re-evaluates only the sets containing a touched group, exactly as that method already does for the same reason (a full rebuild of seven sets over 266,000 org units is not something to pay per Apply).

The worker dispatches by method name off the store instance, so nothing beyond the `EngineMethod` union and the method itself is needed.

- [ ] **Step 1: Write the failing tests**

In `src/engine/store.test.ts`:

```ts
describe('EngineStore.setGroupMembers', () => {
    it('replaces a group\'s membership absolutely rather than merging', () => {
        const s = storeWithFixture() // reuse this file's existing builder
        s.setGroupMembers('organisationUnit', [
            { groupId: 'g1', memberIds: ['ou2'] },
        ])
        const result = s.objectsFor('own', anyScope, { group: 0 }, 0, 100)
        expect(result.items.map((i) => i.id)).toEqual(['ou2'])
    })

    it('ignores ids the type has never loaded, as applyChangeSet does', () => {
        const s = storeWithFixture()
        s.setGroupMembers('organisationUnit', [
            { groupId: 'g1', memberIds: ['ou1', 'nosuchobject'] },
        ])
        const result = s.objectsFor('own', anyScope, { group: 0 }, 0, 100)
        expect(result.items.map((i) => i.id)).toEqual(['ou1'])
    })

    it('ignores a group the type has never loaded', () => {
        const s = storeWithFixture()
        expect(() =>
            s.setGroupMembers('organisationUnit', [
                { groupId: 'nosuchgroup', memberIds: ['ou1'] },
            ])
        ).not.toThrow()
    })

    it('re-evaluates status for the set it touched', () => {
        // Emptying a group must move its former members into whatever
        // "no group" means for this set -- proving evaluateOne ran, not
        // just that membersByGroup changed.
        const s = storeWithFixture()
        s.setGroupMembers('organisationUnit', [
            { groupId: 'g1', memberIds: [] },
        ])
        const result = s.objectsFor('own', anyScope, { group: 0 }, 0, 100)
        expect(result.total).toBe(0)
    })
})
```

Use the fixture builder `src/engine/store.test.ts` already has for `applyChangeSet`'s tests rather than inventing one.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test -- store`
Expected: FAIL — `setGroupMembers` is not a function.

- [ ] **Step 3: Add the protocol entry**

In `src/engine/protocol.ts`, add `| 'setGroupMembers'` to the `EngineMethod` union, next to `'applyChangeSet'`.

- [ ] **Step 4: Implement it**

In `src/engine/store.ts`, directly after `applyChangeSet`:

```ts
/**
 * Replaces the named groups' membership with exactly `memberIds`, then
 * re-evaluates the sets that contain them.
 *
 * The absolute counterpart to `applyChangeSet`, and it exists for the bulk
 * fix's pre-write freshness check (spec 2026-09-16 section 5.2): a plan can
 * only be recomputed against fresh data once that data is in the engine,
 * and `loadMemberships` replaces a whole type rather than named groups.
 *
 * Unknown ids and unknown groups are ignored rather than fabricated, the
 * same reading `applyChangeSet` applies -- a group the type never loaded is
 * not this method's to invent, and an object id that no longer exists must
 * not become a member of anything.
 */
setGroupMembers(
    objectType: ObjectType,
    groups: { groupId: string; memberIds: string[] }[]
): void {
    const t = this.types.get(objectType)
    if (!t) {
        return // Nothing loaded for this type; nothing to set.
    }
    const touchedGroups = new Set<string>()
    groups.forEach(({ groupId, memberIds }) => {
        if (!t.membersByGroup.has(groupId)) {
            return
        }
        t.membersByGroup.set(
            groupId,
            memberIds.filter((id) => t.indexOf.has(id))
        )
        touchedGroups.add(groupId)
    })
    // Same narrowing as applyChangeSet, and for the same reason: only the
    // sets containing one of these groups can have changed, and a full
    // rebuild of every set of the type is not something to pay per Apply.
    this.groupSets.forEach((set) => {
        if (
            set.objectType === objectType &&
            set.groups.some((g) => touchedGroups.has(g.id))
        ) {
            this.evaluateOne(set)
        }
    })
}
```

- [ ] **Step 5: Run the gates and commit**

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src
git add src/engine/protocol.ts src/engine/store.ts src/engine/store.test.ts
git commit -m "Let the engine take fresh membership for named groups"
```

---

### Task 8: Choose the write shape by change size

**Files:**
- Modify: `src/data/writes.ts`
- Test: `src/data/writes.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_BATCH_SIZE`, already exported from `src/data/writes.ts`.
- Produces: `writeMemberships` gains a fifth parameter, after `batchSize`:
  ```ts
  completeMembers?: Map<string, string[]>
  ```
  the **current** complete membership of a group, by group id. `WriteResult` is unchanged and callers cannot tell which route ran.

**The rule (spec §6.1).** Per group: delta ≤ `DEFAULT_BATCH_SIZE` → collection endpoint as today; delta > it → one metadata import carrying that group's complete intended membership.

**Why the parameter is what gates the import.** The import replaces a group's whole collection, which is only safe when the membership it is built from was just re-read (spec §5). Making the import route *depend on the caller supplying that membership* means a caller who has not done the refresh cannot obtain replace-all semantics — enforced by the signature rather than by a comment. Above the threshold with no `completeMembers` entry, the code falls back to batched.

- [ ] **Step 1: Write the failing tests**

In `src/data/writes.test.ts`:

```ts
const bigChange = (n: number) => ({
    groupId: 'g1',
    additions: Array.from({ length: n }, (_, i) => `ou${i}`),
    deletions: [] as string[],
})

it('uses the collection endpoint for a change at the threshold', async () => {
    const calls: string[] = []
    const fetcher = async (path: string, init?: RequestInit) => {
        calls.push(path)
        const body = JSON.parse(String(init?.body)) as { additions: unknown[] }
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
    expect(calls).toEqual(['organisationUnitGroups/g1/organisationUnits'])
})

it('uses a metadata import for a change above the threshold', async () => {
    const calls: { path: string; body: unknown }[] = []
    const fetcher = async (path: string, init?: RequestInit) => {
        calls.push({ path, body: JSON.parse(String(init?.body)) })
        return json({ status: 'OK', stats: { updated: 1 } })
    }
    await writeMemberships(
        fetcher,
        'organisationUnit',
        [bigChange(DEFAULT_BATCH_SIZE + 1)],
        () => undefined,
        DEFAULT_BATCH_SIZE,
        new Map([['g1', ['existing1']]])
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].path).toBe('metadata?importStrategy=UPDATE')
})

it('sends the complete intended membership, not a delta', async () => {
    let body: { organisationUnitGroups: { organisationUnits: { id: string }[] }[] } | undefined
    const fetcher = async (_path: string, init?: RequestInit) => {
        body = JSON.parse(String(init?.body))
        return json({ status: 'OK', stats: { updated: 1 } })
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
    const sent = body!.organisationUnitGroups[0].organisationUnits.map(
        (o) => o.id
    )
    expect(sent).toContain('keep1')
    expect(sent).toContain('new0')
    expect(sent).not.toContain('gone1')
    expect(sent).toHaveLength(DEFAULT_BATCH_SIZE + 2)
})

// The structural safety property: no fresh membership, no replace-all.
it('falls back to batched above the threshold when no complete membership is given', async () => {
    const calls: string[] = []
    const fetcher = async (path: string, init?: RequestInit) => {
        calls.push(path)
        const body = JSON.parse(String(init?.body)) as { additions: unknown[] }
        return okStats(body.additions.length)
    }
    await writeMemberships(
        fetcher,
        'organisationUnit',
        [bigChange(DEFAULT_BATCH_SIZE + 1)],
        () => undefined
    )
    expect(calls.every((p) => !p.startsWith('metadata'))).toBe(true)
    expect(calls).toHaveLength(2)
})

it('reports an import group in WriteResult exactly as a batched one', async () => {
    const fetcher = async () => json({ status: 'OK', stats: { updated: 1 } })
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
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test -- writes`
Expected: FAIL — the sixth argument does not exist and every change goes to the collection endpoint.

- [ ] **Step 3: Implement the routing**

In `src/data/writes.ts`, add the parameter and split the loop. Route per **change**, before `splitChange` runs:

```ts
export async function writeMemberships(
    fetcher: Fetcher,
    objectType: ObjectType,
    changes: GroupChange[],
    onProgress: (done: number, total: number) => void,
    batchSize = DEFAULT_BATCH_SIZE,
    completeMembers?: Map<string, string[]>
): Promise<WriteResult> {
```

Partition `changes` into those taking the import route and those taking the batched one:

```ts
// Spec 2026-09-16 section 6.1. DHIS2 re-reads a group's whole collection on
// every collection write, so the batched path costs roughly (requests x
// collection size) while an import costs one pass. The two are equal at one
// request -- which is `batchSize` ids -- and the import wins beyond it.
// Below it, batched costs the same single re-read and sends far fewer ids,
// so a small fix must never take the import route.
//
// The `completeMembers` requirement is the safety property, not a
// convenience: an import replaces the group's whole collection, which is
// only sound when the membership it is built from was just re-read (section
// 5). A caller that has not done that refresh has no entry here and
// therefore cannot reach this route at all.
const takesImport = (change: GroupChange): boolean =>
    change.additions.length + change.deletions.length > batchSize &&
    completeMembers?.has(change.groupId) === true
```

For an import change, build the intended membership from the current list plus additions minus deletions, POST it, and translate the response into exactly one `BatchOutcome` plus an `applied`/`unaccounted` entry so `WriteResult` is indistinguishable from the batched route:

```ts
async function importChange(
    fetcher: Fetcher,
    objectType: ObjectType,
    change: GroupChange,
    current: string[]
): Promise<{ outcome: BatchOutcome; ok: boolean }> {
    const endpoint = ENDPOINTS[objectType]
    const requested = change.additions.length + change.deletions.length
    const deletions = new Set(change.deletions)
    const intended = [
        ...current.filter((id) => !deletions.has(id)),
        ...change.additions.filter((id) => !current.includes(id)),
    ]
    try {
        const response = await fetcher('metadata?importStrategy=UPDATE', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                [endpoint.groups]: [
                    {
                        id: change.groupId,
                        [endpoint.members]: intended.map((id) => ({ id })),
                    },
                ],
            }),
        })
        if (!response.ok) {
            return {
                outcome: {
                    groupId: change.groupId,
                    requested,
                    accepted: 0,
                    error: `HTTP ${response.status}`,
                },
                ok: false,
            }
        }
        const body = (await response.json()) as { status?: string }
        // An import reports objects touched, never memberships, so its
        // stats cannot be reconciled against `requested` the way a
        // collection response is. A non-OK status is the only failure
        // signal available, so that is what is trusted -- and the caller
        // re-reads this group before the next write anyway (section 5).
        const ok = body.status === 'OK' || body.status === 'SUCCESS'
        return {
            outcome: {
                groupId: change.groupId,
                requested,
                accepted: ok ? requested : 0,
                error: ok ? undefined : UNPARSEABLE_RESPONSE,
            },
            ok,
        }
    } catch (error) {
        return {
            outcome: {
                groupId: change.groupId,
                requested,
                accepted: 0,
                error: error instanceof Error ? error.message : String(error),
            },
            ok: false,
        }
    }
}
```

Each import change counts as **one** unit of `onProgress`'s total, the same as one batch, so the progress bar stays meaningful across a mixed write.

Update `writeMemberships`'s own doc comment: it currently promises "one request per group per batch, strictly sequential", which is no longer the whole truth.

- [ ] **Step 4: Plumb the parameter through the hook**

`writeMemberships`'s new argument is useless until its only production
caller can supply it. In `src/hooks/useMembershipWrite.ts`, extend
`MembershipWriteInput`:

```ts
    /**
     * The current complete membership of each group in `changes`, by group
     * id, read fresh immediately before this call. Supplying it is what
     * makes `writeMemberships`'s import route available for a large
     * per-group change -- and withholding it is what makes that route
     * unreachable for a caller that has not re-read (spec 2026-09-16
     * section 6.3). Optional, so every existing caller keeps working and
     * keeps the batched path.
     */
    completeMembers?: Map<string, string[]>
```

and pass it as the sixth argument, keeping the measured default in between:

```ts
                const result = await writeMemberships(
                    fetcher,
                    objectType,
                    input.changes,
                    input.onProgress ?? (() => undefined),
                    DEFAULT_BATCH_SIZE,
                    input.completeMembers
                )
```

Add a test in `src/hooks/useMembershipWrite.test.tsx` that `completeMembers`
reaches `writeMemberships`, and that omitting it still writes — the second
matters more, since it is every existing caller's path.

- [ ] **Step 5: Run the tests and the gates, then commit**

```bash
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src
git add src/data/writes.ts src/data/writes.test.ts \
        src/hooks/useMembershipWrite.ts src/hooks/useMembershipWrite.test.tsx
git commit -m "Choose the write shape per group by how much is changing"
```

---

### Task 9: The bulk fix's pre-write freshness check

**Files:**
- Modify: `src/components/BulkFixDialog/BulkFixDialog.tsx`
- Test: `src/components/BulkFixDialog/BulkFixDialog.test.tsx`

**Interfaces:**
- Consumes: `setGroupMembers` (Task 7); `writeMemberships`'s `completeMembers` (Task 8); `createFetcher`; `ENDPOINTS`.
- Produces: nothing other tasks import.

**Read Task 1's note first.** `docs/superpowers/notes/2026-09-plan8-reread-cost.md` carries a verdict. If it says **over ~6s**, stop and report rather than implementing this task as written — spec §5.4 requires the design to be revisited, not worked around.

- [ ] **Step 1: Write the failing tests**

In `src/components/BulkFixDialog/BulkFixDialog.test.tsx`. These use a
`renderAndReachApply()` helper — **extract it from the apply-step tests this
file already has**, which render the dialog, choose an action, click `Next`
to reach the preview, and click through to apply. Do not write a second
navigation path alongside the existing one; the tests below depend on it
behaving identically.

```tsx
it('re-reads the plan\'s groups and writes straight through when nothing changed', async () => {
    // The common case, and always the case when one person is using the
    // app: the check must be invisible.
    mockUseEngineQuery.mockImplementation((method: string) =>
        method === 'planAssignment'
            ? { data: plan({ affected: 3 }), isLoading: false, error: null }
            : { data: { total: 0, offset: 0, items: [] }, isLoading: false, error: null }
    )
    mockClientCall.mockResolvedValue(plan({ affected: 3 }))
    renderAndReachApply()
    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Apply/ }))
    })
    expect(mockWrite).toHaveBeenCalled()
    expect(
        screen.queryByText('The metadata changed while you were reviewing')
    ).not.toBeInTheDocument()
})

it('blocks and re-confirms when the recomputed plan differs', async () => {
    mockUseEngineQuery.mockImplementation((method: string) =>
        method === 'planAssignment'
            ? { data: plan({ affected: 45 }), isLoading: false, error: null }
            : { data: { total: 0, offset: 0, items: [] }, isLoading: false, error: null }
    )
    // setGroupMembers resolves, then the recomputed plan comes back smaller.
    mockClientCall.mockImplementation((method: string) =>
        method === 'planAssignment'
            ? Promise.resolve(plan({ affected: 44 }))
            : Promise.resolve(undefined)
    )
    renderAndReachApply()
    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Apply/ }))
    })
    expect(
        await screen.findByText('The metadata changed while you were reviewing')
    ).toBeInTheDocument()
    expect(mockWrite).not.toHaveBeenCalled()
})

it('writes the recalculated plan, not the previewed one, after re-confirming', async () => {
    // … same setup as above, then:
    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Apply 44 changes' }))
    })
    expect(mockWrite).toHaveBeenCalledWith(
        expect.objectContaining({
            changes: plan({ affected: 44 }).changes,
        })
    )
})

it('passes the freshly read membership to the writer', async () => {
    // Task 8's import route is unreachable without this, by design.
    renderAndReachApply()
    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Apply/ }))
    })
    expect(mockWrite).toHaveBeenCalledWith(
        expect.objectContaining({ completeMembers: expect.any(Map) })
    )
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test -- BulkFixDialog`
Expected: FAIL — Apply writes immediately with no re-read.

- [ ] **Step 3: Implement the re-read**

Add a helper in `BulkFixDialog.tsx` that reads the membership of the groups the plan names, and only those:

```tsx
/**
 * The membership of every group this plan touches, read fresh from the
 * server. Only the groups the plan names -- reading the whole set would
 * cost far more and buy nothing, since a group the plan does not touch
 * cannot change what the plan does.
 */
const readPlanGroups = async (
    planChanges: GroupChange[]
): Promise<Map<string, string[]>> => {
    const endpoint = ENDPOINTS[set.objectType]
    const ids = Array.from(new Set(planChanges.map((c) => c.groupId)))
    const entries = await Promise.all(
        ids.map(async (groupId) => {
            const response = await fetcher(
                `${endpoint.groups}/${groupId}/${endpoint.members}?fields=id&paging=false`,
                { cache: 'no-store' }
            )
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`)
            }
            const body = (await response.json()) as Record<
                string,
                { id: string }[]
            >
            return [
                groupId,
                (body[endpoint.members] ?? []).map((o) => o.id),
            ] as const
        })
    )
    return new Map(entries)
}
```

`cache: 'no-store'` is not optional here: this read exists precisely to defeat any cached copy, and the SQL-view caching defect Plan 7 fixed is the standing reminder of what a cached read costs (`2026-09-plan7-e2e-write-flows.md`).

- [ ] **Step 4: Implement the check and the re-confirmation**

On Apply, before writing: call `readPlanGroups`, push the result into the engine with `setGroupMembers`, recompute via `planAssignment`, and compare `affected` plus the change lists. Hold the recomputed plan and the previewed count in state:

```tsx
const [recheck, setRecheck] = useState<{
    previewed: number
    recomputed: AssignmentPlan
} | null>(null)
```

When they match, write immediately, passing `completeMembers` through to `write()`. When they differ, set `recheck` and render a `NoticeBox` — *"The metadata changed while you were reviewing"* — the previewed count struck through beside the new one, one sentence naming what moved, and three actions: `Cancel`, `Review changes` (back to the preview step carrying the recomputed plan), and `Apply {n} changes`.

Strings, each whole and argument-free:

```
The metadata changed while you were reviewing
Someone else has changed this group set since the preview was calculated. The plan below has been recalculated against the current metadata — check it before applying.
Previewed
Will now change
Review changes
```

and the button, count-aware:

```
Apply 1 change  /  Apply {count} changes
```

If Task 1's note put the re-read in the **2–6s** band, show progress while `readPlanGroups` runs: disable the actions and render `i18n.t('Checking the metadata is up to date…')` in place of the notice.

- [ ] **Step 5: Run the tests, extract strings, run the gates, commit**

```bash
pnpm exec d2-app-scripts i18n extract
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint src
git add src/components/BulkFixDialog i18n/en.pot
git commit -m "Check the metadata is current before a bulk fix writes"
```

---

### Task 10: Amend the earlier spec

**Files:**
- Modify: `docs/superpowers/specs/2026-09-15-manual-review-1-design.md`

**Interfaces:**
- Consumes: Tasks 8 and 9 having landed.
- Produces: no code.

Three edits, each short — the new spec carries the reasoning, these are pointers so a reader of the old document is not misled.

- [ ] **Step 1: §4.4**

Add that the `lastUpdated` gate cannot see a membership move on 2.41–2.43 (citing `2026-09-plan7-lastupdated-guard.md`), and that `CACHE_TTL_MS` bounds rather than fixes this.

- [ ] **Step 2: §6.3**

Replace the `lastUpdated` guard with the freshness check: re-read the affected groups, recompute, re-confirm if the plan changed. Note that it is version-independent because it observes content rather than a timestamp three of four supported versions do not maintain.

- [ ] **Step 3: §6.4**

Replace the flat "batch size 5000" outcome with the per-group threshold rule, and record the correction plainly: Plan 7's seven runs all wrote a group's entire population, which flattered a shape that always sends the complete membership, and a realistic few-hundred-violation fix would have been markedly worse by import.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-15-manual-review-1-design.md
git commit -m "Amend spec 4.4, 6.3 and 6.4 for the freshness design"
```

---

### Task 11: End-to-end coverage for the indicator

**Files:**
- Modify: `e2e/flows.spec.ts`

**Interfaces:**
- Consumes: `authedApp` from `e2e/fixtures/session.ts`. Note `authedApp.root()` **re-resolves the app root and must be called again after every navigation** — on 2.43 the app runs inside the Global App Shell's iframe, which the shell recreates on some route changes.
- Produces: nothing other tasks import.

Only the indicator and Refresh are covered here. The changed-plan path is a unit concern (Task 9): provoking a real cross-client change mid-flow would mean a second session writing between the preview and the Apply, which is not worth the suite's complexity for a path four unit tests already pin.

- [ ] **Step 1: Add the flow**

```ts
test('metadata freshness: the age is shown and Refresh reloads', async ({
    authedApp,
}) => {
    const { page } = authedApp
    const root = await openGroupSet(page, AREA_SET_NAME)

    // A freshly opened app has just read, so this is the "just now" or
    // small-minutes wording -- matched loosely, since the exact number
    // depends on how long the load took.
    const freshness = root.locator('[data-test="filter-bar"]')
    await expect(freshness.getByText(/^Metadata from /)).toBeVisible({
        timeout: 20_000,
    })

    await root.getByRole('button', { name: 'Refresh' }).click()
    // The load runs again: the button is disabled while it does, and the
    // age line comes back afterwards.
    await expect(root.getByRole('button', { name: 'Refresh' })).toBeEnabled({
        timeout: 30_000,
    })
    await expect(freshness.getByText(/^Metadata from /)).toBeVisible()
})
```

Add `data-test="metadata-freshness"` to `MetadataFreshness`'s root element if the filter-bar scoping proves ambiguous against the matrix's own column headers.

- [ ] **Step 2: Run against both projects, one instance at a time**

Rebuild and reinstall first — the installed zip will not carry Tasks 2–9 otherwise.

```bash
pnpm build
curl -s -u local_admin:district -X POST \
  -F "file=@build/bundle/group-set-integrity-tool-1.0.0.zip" \
  "http://dhis2-agent-gsi-p2:8080/api/apps"
export PLAYWRIGHT_CHROME_PATH=/opt/playwright-browsers/chromium-1234/chrome-linux/chrome
pnpm exec playwright test --config e2e/playwright.config.ts --project 2.43.1
# then stop that instance, start the other, reinstall, and:
pnpm exec playwright test --config e2e/playwright.config.ts --project 2.40.12
```

The whole suite, not just the new flow: Task 9 changes the bulk fix's apply path, which `bulk move` drives.

- [ ] **Step 3: Restore the instances, typecheck and commit**

```bash
pnpm exec tsc -p e2e --noEmit
git add e2e/flows.spec.ts
git commit -m "Cover the metadata freshness indicator end to end"
```

---

## What this plan deliberately does not do

- **No multi-tab coordination.** A second tab stays stale until it reloads. `BroadcastChannel` would address it, but that is live invalidation between clients — a different problem, and the TTL plus Task 9's check bound the damage.
- **No auto-refresh of a live session.** Rejected in design: changing counts under a user mid-task is worse than an honest label.
- **No freshness check on inline assign or revert.** Inline assign changes one object, visibly and revertibly. `planRevert` already performs a content-based check (`stillHolds`), which is why the Revert dialog can report "Nothing to revert".
- **It does not fix `2026-09-plan6-carry-forward.md`.** Those items stay carried forward.

## Self-review

- **§3.1** (age source) — Task 3.
- **§3.2** (which age shown) — Task 6, both rules tested.
- **§3.3** (TTL) — Task 2.
- **§3.4** (escalation, no auto-refresh) — Task 4's `stale` flag, Task 5's rendering.
- **§4.1** (placement) — Task 5's `FilterBar` slot.
- **§4.2** (four states) — Task 5.
- **§4.3** ("Metadata", not "Data") — a global constraint, and every string in Tasks 4, 5 and 9.
- **§4.4** (parallel whole sentences) — Task 4, with the reason in the source.
- **§5.1–5.3** (re-read, `setGroupMembers`, re-confirm) — Tasks 7 and 9.
- **§5.4** (the unmeasured risk) — Task 1, with a stated verdict that can stop Task 9.
- **§6.1–6.3** (threshold, self-routing, structural safety) — Task 8, the fallback test being the safety property.
- **§7** (testing) — each task's own tests; the e2e half is Task 11.
- **§8** (amendments) — Task 10.
- **§9** (out of scope) — the section above.
