# Group Set Integrity Tool, Plan 1: Foundation (read-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A DHIS2 App Platform app that loads group set metadata and memberships for all four object types, evaluates the rules in a Web Worker, and shows the dashboard, summary matrix and object list read-only, fast enough for a 266K org unit instance.

**Architecture:** Pure TypeScript engine (`src/engine`) with typed-array indexes runs in a Web Worker; a data layer (`src/data`) loads objects and memberships from SQL views when present or from the metadata API otherwise, and caches raw arrays in IndexedDB; React pages (`src/pages`) talk to the worker through a promise-based client. Writes, history and the integrity overlay are Plans 2 and 3.

**Tech Stack:** `@dhis2/cli-app-scripts` 12 (Vite), TypeScript, pnpm, React 18, `@dhis2/ui` 10, `@dhis2/app-runtime` 3, react-router-dom (hash router), `@tanstack/react-query@4`, `@tanstack/react-virtual@3`, `idb` 8, Jest + React Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-10-group-set-integrity-tool-design.md`

## Global Constraints

- Minimum DHIS2 version 2.40; every API call must work on 2.40 to 2.43.
- App name in the DHIS2 menu: "Group Set Integrity Tool"; package name `group-set-integrity-tool`.
- React 18 only; no Suspense for data, no React 19 APIs. Loading states are explicit.
- UI components only from `@dhis2/ui`; styling with CSS Modules and DHIS2 design tokens (`var(--spacers-dp16)`, `var(--colors-grey900)`).
- All user-facing strings through `i18n.t()` from `@dhis2/d2-i18n`.
- Use `displayName`, never `name`, for DHIS2 objects shown to users.
- TanStack Query must be v4. Never call `useDataQuery` directly; use `useApiDataQuery` from `src/utils/useApiDataQuery.ts`.
- `src/engine` must not import React, `@dhis2/*`, or anything from `src/data` or `src/pages`.
- Conflict (in more than one group of a set) is always an error, for every set, regardless of `dataDimension`.
- Membership is counted per set, never per group (a group may belong to several sets).
- Commits: linear history, no merge commits, no `Claude-Session` trailer. End commit messages with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- After each task run `pnpm exec tsc --noEmit` and `pnpm exec eslint src` and fix everything before committing.
- Test instances: Sierra Leone seeds via the d2-broker for functional checks; `agent-gsi-emis` (DHIS2 2.41.10, 266,396 org units, login `local_admin` / `district`, URL `http://dhis2-agent-gsi-emis:8080` from the sandbox) for performance. Check it is running with `GET $DHIS2_BROKER_URL/instances` before use.

## File structure

```
d2.config.js                      app config: name, entry point, minDHIS2Version, viteConfigExtensions
vite.config.mts                   '@' alias
jest.config.js                    '@' alias mapper, setup file
jest.setup.js                     jest-dom, data-test id attribute
tsconfig.json                     jsx react-jsx, paths
CLAUDE.md                         decisions for future sessions
src/App.tsx                       providers + router
src/utils/SyncUrlWithGlobalShell.tsx
src/utils/useApiDataQuery.ts
src/interfaces/apiQueryTypes.ts
src/engine/types.ts               ObjectType, GroupMeta, GroupSetMeta, Status, EngineConfig
src/engine/hierarchy.ts           buildHierarchy, isInSubtree, ancestorAtLevel
src/engine/membership.ts          buildSetMembership, groupsOf
src/engine/population.ts          populationFor (per type rules)
src/engine/rules.ts               evaluateSet -> Status array
src/engine/queries.ts             summarize, matrix, listObjects
src/engine/store.ts               EngineStore: holds indexes for all types/sets; load/eval/query entry points
src/engine/protocol.ts            request/response message types
src/engine/worker.ts              worker entry: dispatches protocol messages to EngineStore
src/engine/client.ts              EngineClient: promise API over postMessage
src/engine/perf.test.ts           300K synthetic tree budget test
src/data/endpoints.ts             ENDPOINTS: collection/group/member/groupSet paths per type
src/data/csv.ts                   parseCsv (3 plain columns)
src/data/sources/DataSource.ts    interface
src/data/sources/metadataSource.ts
src/data/sources/sqlViewSource.ts
src/data/sources/selectSource.ts  picks sqlView when views exist and readable
src/data/groupSets.ts             group sets + groups + access for all types
src/data/cache.ts                 IndexedDB cache with idb
src/data/loadAll.ts               orchestrates: cache -> source -> engine, reports progress
src/hooks/useEngine.tsx           EngineProvider + useEngine (client, load state, progress)
src/hooks/useUserScope.ts         me.organisationUnits, authorities
src/pages/Dashboard/*
src/pages/GroupSetDetail/*        OverviewTab, ObjectsTab (read-only in Plan 1)
src/components/ScopeSelector/*
src/components/GroupSetCard/*
src/components/SummaryMatrix/*
src/components/ObjectsTable/*
src/components/MembershipControl/* (display only in Plan 1; editing in Plan 2)
src/components/LoadProgress/*
```

---

### Task 1: Scaffold the app and tooling

**Files:**
- Create: everything the scaffold produces, then `d2.config.js`, `vite.config.mts`, `jest.config.js`, `jest.setup.js`, `src/utils/SyncUrlWithGlobalShell.tsx`, `src/interfaces/apiQueryTypes.ts`, `src/utils/useApiDataQuery.ts`, `src/App.tsx`, `CLAUDE.md`
- Modify: `tsconfig.json`, `package.json`

**Interfaces:**
- Produces: `useApiDataQuery({ query, queryKey, ...options })` used by every data hook; `@/` alias; `pnpm test` running Jest.

- [ ] **Step 1: Scaffold into the current directory**

The directory contains only `docs/` and `.git/`, so the scaffolder needs a temporary target:

```bash
cd /Users/olavpo/Repos/tool-groupset-manager
pnpm create @dhis2/app@latest gsi-scaffold --typescript --yes
# move everything (including dotfiles) up one level, but do not overwrite .git or docs
rsync -a --exclude .git --exclude docs gsi-scaffold/ ./ && rm -rf gsi-scaffold
```

- [ ] **Step 2: Update platform libraries and install the stack**

```bash
pnpm update --latest @dhis2/app-runtime @dhis2/ui @dhis2/cli-app-scripts
pnpm add --save-dev @dhis2/api-types @testing-library/jest-dom @testing-library/react @testing-library/user-event @types/jest eslint-import-resolver-typescript
pnpm add @tanstack/react-query@4 @tanstack/react-virtual@3 react-router-dom idb
```

If native binaries fail to load later (`@rollup/rollup-linux-*` missing), add to `pnpm-workspace.yaml`:

```yaml
supportedArchitectures:
    os: [darwin, linux]
    cpu: [arm64, x64]
```

then `pnpm install --force`.

- [ ] **Step 3: Write `d2.config.js`**

```javascript
/** @type {import('@dhis2/cli-app-scripts').D2Config} */
const config = {
    type: 'app',
    name: 'group-set-integrity-tool',
    title: 'Group Set Integrity Tool',
    minDHIS2Version: '2.40',
    entryPoints: {
        app: './src/App.tsx',
    },
    viteConfigExtensions: './vite.config.mts',
}

module.exports = config
```

- [ ] **Step 4: Write `vite.config.mts`**

```typescript
import path from 'path'
import { defineConfig } from 'vite'

export default defineConfig({
    resolve: {
        alias: {
            '@': path.resolve(__dirname, 'src'),
        },
    },
    worker: {
        format: 'es',
    },
})
```

- [ ] **Step 5: Merge into `tsconfig.json`**

Keep the scaffolder's options and add or overwrite:

```json
{
    "compilerOptions": {
        "jsx": "react-jsx",
        "lib": ["DOM", "DOM.Iterable", "ES2020", "WebWorker"],
        "paths": {
            "@/*": ["./src/*"]
        }
    }
}
```

- [ ] **Step 6: Write `jest.config.js` and `jest.setup.js`**

`jest.config.js`:

```javascript
// The platform merges this object over its own defaults with a shallow
// spread, so a key set here replaces the default wholesale. That is why
// the CSS mock from the defaults is repeated in moduleNameMapper.
module.exports = {
    setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
    moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
        '\\.(css|less)$': require.resolve(
            '@dhis2/cli-app-scripts/config/jest.identity.mock.js'
        ),
    },
    testEnvironment: 'jsdom',
}
```

`jest.setup.js`:

```javascript
import '@testing-library/jest-dom'
import { configure } from '@testing-library/react'

configure({ testIdAttribute: 'data-test' })
```

- [ ] **Step 7: Create `src/utils/SyncUrlWithGlobalShell.tsx`**

```tsx
import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'

/*
 * In the DHIS2 Global Shell, react-router no longer fires "popstate" on
 * pushState/replaceState. The shell listens for "popstate" to keep the
 * browser URL in sync, so we dispatch it on every route change.
 */
export const SyncUrlWithGlobalShell = () => {
    const location = useLocation()

    useEffect(() => {
        dispatchEvent(new PopStateEvent('popstate'))
    }, [location.key])

    return <Outlet />
}
```

- [ ] **Step 8: Create `src/interfaces/apiQueryTypes.ts`**

```typescript
export type PossiblyDynamic<Type, InputType> =
    | Type
    | ((input: InputType) => Type)
export type QueryVariables = Record<string, unknown>

type QueryParameterSingularValue = string | number | boolean
interface QueryParameterAliasedValue {
    [name: string]: QueryParameterSingularValue
}
type QueryParameterSingularOrAliasedValue =
    | QueryParameterSingularValue
    | QueryParameterAliasedValue
type QueryParameterMultipleValue = QueryParameterSingularOrAliasedValue[]
export type QueryParameterValue =
    | QueryParameterSingularValue
    | QueryParameterAliasedValue
    | QueryParameterMultipleValue
    | undefined

export interface QueryParameters {
    pageSize?: number
    [key: string]: QueryParameterValue
}

export interface ResourceQuery {
    resource: string
    id?: PossiblyDynamic<string, QueryVariables>
    data?: PossiblyDynamic<unknown, QueryVariables>
    params?: PossiblyDynamic<QueryParameters, QueryVariables>
}
```

- [ ] **Step 9: Create `src/utils/useApiDataQuery.ts`**

```typescript
import { useDataEngine } from '@dhis2/app-runtime'
import {
    useQuery,
    QueryFunction,
    UseQueryOptions,
    QueryKey,
} from '@tanstack/react-query'
import { ResourceQuery } from '@/interfaces/apiQueryTypes'

type UseApiDataQueryProps<
    TResultData,
    TError = Error,
    TData = TResultData,
    TQueryKey extends QueryKey = QueryKey,
> = Omit<UseQueryOptions<TResultData, TError, TData, TQueryKey>, 'queryFn'> & {
    query: ResourceQuery
}

export const useApiDataQuery = <
    TResultData,
    TError = Error,
    TData = TResultData,
    TQueryKey extends QueryKey = QueryKey,
>({
    query,
    queryKey,
    ...options
}: UseApiDataQueryProps<TResultData, TError, TData, TQueryKey>) => {
    const dataEngine = useDataEngine()

    const queryFn: QueryFunction<TResultData, TQueryKey> = async () => {
        const response = await dataEngine.query({ apiDataQuery: query })
        return response.apiDataQuery as TResultData
    }

    return useQuery<TResultData, TError, TData, TQueryKey>({
        queryKey,
        queryFn,
        ...options,
    })
}
```

- [ ] **Step 10: Replace `src/App.tsx`**

```tsx
import React from 'react'
import { createHashRouter, RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CssReset, CssVariables } from '@dhis2/ui'
import { SyncUrlWithGlobalShell } from '@/utils/SyncUrlWithGlobalShell'

const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
})

const router = createHashRouter([
    {
        element: <SyncUrlWithGlobalShell />,
        children: [{ path: '/', element: <div>Group Set Integrity Tool</div> }],
    },
])

const App = () => (
    <QueryClientProvider client={queryClient}>
        <CssReset />
        <CssVariables theme spacers colors elevations />
        <RouterProvider router={router} />
    </QueryClientProvider>
)

export default App
```

Delete the scaffolded `src/App.test.tsx` (or `.js`) and `src/App.module.css` if present; they test the placeholder.

- [ ] **Step 11: Write a smoke test `src/App.test.tsx`**

```tsx
import React from 'react'
import { render, screen } from '@testing-library/react'
import App from './App'

it('renders the app title', () => {
    render(<App />)
    expect(screen.getByText('Group Set Integrity Tool')).toBeInTheDocument()
})
```

- [ ] **Step 12: Run checks**

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm exec eslint src
```

Expected: 1 test passes, no type or lint errors. If ESLint reports `import/named` for exports that exist, add to the ESLint config:

```json
{ "settings": { "import/resolver": { "typescript": {} } } }
```

- [ ] **Step 13: Write `CLAUDE.md`**

```markdown
# Group Set Integrity Tool

DHIS2 App Platform app (TypeScript, Vite, pnpm). Spec: docs/superpowers/specs/2026-09-10-group-set-integrity-tool-design.md. Plans: docs/superpowers/plans/.

## Commands
- `pnpm start` dev server (bind to `$SANDBOX_HOST_PORT` in the sandbox: `pnpm start --port $SANDBOX_HOST_PORT --proxy http://dhis2-<instance>:8080`)
- `pnpm test` Jest; `pnpm exec tsc --noEmit`; `pnpm exec eslint src`
- `pnpm build` produces build/bundle/*.zip

## Architecture decisions
- `src/engine` is pure TypeScript with typed arrays, runs in a Web Worker, no React or DHIS2 imports. Test it with plain Jest.
- Data comes from SQL views when present (`GSI_*` codes) else from the metadata API; both produce the same payloads (`src/data/types.ts`).
- Conflict = in more than one group of a set: always an error. Membership counted per set.
- Data fetching through `useApiDataQuery` (TanStack Query v4), never `useDataQuery` directly.
- Hash router; every route under `SyncUrlWithGlobalShell`.
```

- [ ] **Step 14: Commit**

```bash
git add -A
git commit -m "Scaffold Group Set Integrity Tool app with platform tooling

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Engine types and hierarchy index

**Files:**
- Create: `src/engine/types.ts`, `src/engine/hierarchy.ts`
- Test: `src/engine/hierarchy.test.ts`

**Interfaces:**
- Produces:
  - `type ObjectType = 'organisationUnit' | 'dataElement' | 'indicator' | 'categoryOption'`
  - `interface GroupMeta { id: string; displayName: string; code?: string; canWrite: boolean }`
  - `interface GroupSetMeta { id: string; displayName: string; objectType: ObjectType; compulsory: boolean; dataDimension: boolean; groups: GroupMeta[]; canWrite: boolean }`
  - `enum Status { NotApplicable = 0, Ok = 1, MissingWarning = 2, MissingError = 3, Conflict = 4 }`
  - `interface EngineConfig { requiredLevels: Record<string, number[]>; includeTracker: boolean }`
  - `interface Hierarchy { n: number; level: Uint8Array; parent: Int32Array; order: Int32Array; subtreeEnd: Int32Array; byOrder: Int32Array }`
  - `buildHierarchy(parent: Int32Array, level: Uint8Array): Hierarchy`
  - `isInSubtree(h: Hierarchy, root: number, idx: number): boolean` (root itself counts)
  - `ancestorAtLevel(h: Hierarchy, idx: number, level: number): number` (returns idx itself when its level matches, -1 when none)

- [ ] **Step 1: Write `src/engine/types.ts`**

```typescript
export type ObjectType =
    | 'organisationUnit'
    | 'dataElement'
    | 'indicator'
    | 'categoryOption'

export const OBJECT_TYPES: ObjectType[] = [
    'organisationUnit',
    'dataElement',
    'indicator',
    'categoryOption',
]

export interface GroupMeta {
    id: string
    displayName: string
    code?: string
    canWrite: boolean
}

export interface GroupSetMeta {
    id: string
    displayName: string
    objectType: ObjectType
    compulsory: boolean
    dataDimension: boolean
    groups: GroupMeta[]
    canWrite: boolean
}

export enum Status {
    NotApplicable = 0,
    Ok = 1,
    MissingWarning = 2,
    MissingError = 3,
    Conflict = 4,
}

export interface EngineConfig {
    /** group set id -> org unit levels at which membership is required */
    requiredLevels: Record<string, number[]>
    includeTracker: boolean
}

export const DEFAULT_CONFIG: EngineConfig = {
    requiredLevels: {},
    includeTracker: false,
}
```

- [ ] **Step 2: Write the failing tests `src/engine/hierarchy.test.ts`**

```typescript
import {
    ancestorAtLevel,
    buildHierarchy,
    isInSubtree,
} from './hierarchy'

// Tree (index: level):
// 0 root (1)
// ├─ 1 A (2)
// │  ├─ 3 A1 (3)
// │  └─ 4 A2 (3)
// └─ 2 B (2)
//    └─ 5 B1 (3)
//       └─ 6 B1x (4)
const parent = Int32Array.from([-1, 0, 0, 1, 1, 2, 5])
const level = Uint8Array.from([1, 2, 2, 3, 3, 3, 4])

describe('buildHierarchy', () => {
    const h = buildHierarchy(parent, level)

    it('assigns a depth-first order where children follow their parent', () => {
        expect(h.order[0]).toBe(0)
        expect(h.order[1]).toBeLessThan(h.order[3])
        expect(h.order[1]).toBeLessThan(h.order[4])
        expect(h.order[2]).toBeLessThan(h.order[5])
        expect(h.order[5]).toBeLessThan(h.order[6])
    })

    it('subtreeEnd covers exactly the descendants', () => {
        expect(h.subtreeEnd[0] - h.order[0]).toBe(7)
        expect(h.subtreeEnd[1] - h.order[1]).toBe(3)
        expect(h.subtreeEnd[2] - h.order[2]).toBe(3)
        expect(h.subtreeEnd[6] - h.order[6]).toBe(1)
    })

    it('byOrder inverts order', () => {
        for (let i = 0; i < 7; i++) {
            expect(h.byOrder[h.order[i]]).toBe(i)
        }
    })

    it('handles a forest with several roots', () => {
        const f = buildHierarchy(
            Int32Array.from([-1, -1, 0, 1]),
            Uint8Array.from([1, 1, 2, 2])
        )
        expect(f.subtreeEnd[0] - f.order[0]).toBe(2)
        expect(f.subtreeEnd[1] - f.order[1]).toBe(2)
    })

    it('does not depend on input order (children before parents)', () => {
        const p = Int32Array.from([1, -1])
        const l = Uint8Array.from([2, 1])
        const h2 = buildHierarchy(p, l)
        expect(isInSubtree(h2, 1, 0)).toBe(true)
        expect(isInSubtree(h2, 0, 1)).toBe(false)
    })
})

describe('isInSubtree', () => {
    const h = buildHierarchy(parent, level)
    it('includes the root itself and all descendants', () => {
        expect(isInSubtree(h, 2, 2)).toBe(true)
        expect(isInSubtree(h, 2, 5)).toBe(true)
        expect(isInSubtree(h, 2, 6)).toBe(true)
        expect(isInSubtree(h, 2, 3)).toBe(false)
        expect(isInSubtree(h, 0, 6)).toBe(true)
    })
})

describe('ancestorAtLevel', () => {
    const h = buildHierarchy(parent, level)
    it('walks up to the requested level', () => {
        expect(ancestorAtLevel(h, 6, 2)).toBe(2)
        expect(ancestorAtLevel(h, 6, 3)).toBe(5)
        expect(ancestorAtLevel(h, 6, 4)).toBe(6)
        expect(ancestorAtLevel(h, 3, 1)).toBe(0)
    })
    it('returns -1 when the object is above the requested level', () => {
        expect(ancestorAtLevel(h, 1, 3)).toBe(-1)
    })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test -- src/engine/hierarchy`
Expected: FAIL, cannot find module './hierarchy'.

- [ ] **Step 4: Write `src/engine/hierarchy.ts`**

```typescript
export interface Hierarchy {
    n: number
    level: Uint8Array
    parent: Int32Array
    /** position of each object in depth-first order */
    order: Int32Array
    /** exclusive end (in order positions) of each object's subtree */
    subtreeEnd: Int32Array
    /** object index at each order position */
    byOrder: Int32Array
}

/**
 * Builds a depth-first numbering so that "idx is in the subtree of root"
 * becomes a range check on order positions. Iterative, so a 266K-node tree
 * does not overflow the call stack. Input order is arbitrary.
 */
export function buildHierarchy(
    parent: Int32Array,
    level: Uint8Array
): Hierarchy {
    const n = parent.length
    // Build child adjacency as CSR arrays (firstChild offsets + children list).
    const childCount = new Int32Array(n + 1)
    for (let i = 0; i < n; i++) {
        const p = parent[i]
        if (p >= 0) {
            childCount[p + 1]++
        }
    }
    for (let i = 0; i < n; i++) {
        childCount[i + 1] += childCount[i]
    }
    const children = new Int32Array(n)
    const fill = childCount.slice(0, n)
    for (let i = 0; i < n; i++) {
        const p = parent[i]
        if (p >= 0) {
            children[fill[p]++] = i
        }
    }

    const order = new Int32Array(n)
    const subtreeEnd = new Int32Array(n)
    const byOrder = new Int32Array(n)
    const stack = new Int32Array(n)
    let position = 0

    for (let root = 0; root < n; root++) {
        if (parent[root] >= 0) {
            continue
        }
        let top = 0
        stack[top++] = root
        // A negative marker on the stack means "post-visit": set subtreeEnd.
        while (top > 0) {
            const node = stack[--top]
            if (node < 0) {
                subtreeEnd[~node] = position
                continue
            }
            order[node] = position
            byOrder[position] = node
            position++
            stack[top++] = ~node
            for (let c = childCount[node + 1] - 1; c >= childCount[node]; c--) {
                stack[top++] = children[c]
            }
        }
    }

    return { n, level, parent, order, subtreeEnd, byOrder }
}

export function isInSubtree(h: Hierarchy, root: number, idx: number): boolean {
    const pos = h.order[idx]
    return pos >= h.order[root] && pos < h.subtreeEnd[root]
}

export function ancestorAtLevel(
    h: Hierarchy,
    idx: number,
    level: number
): number {
    let node = idx
    while (node >= 0 && h.level[node] > level) {
        node = h.parent[node]
    }
    return node >= 0 && h.level[node] === level ? node : -1
}
```

Note on the stack size: each node is pushed at most twice (pre and post marker) but the post marker is pushed only after its pre entry was popped, so the live stack never exceeds `n` entries.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test -- src/engine/hierarchy`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add src/engine/types.ts src/engine/hierarchy.ts src/engine/hierarchy.test.ts
git commit -m "Add engine types and depth-first hierarchy index

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Per-set membership index

**Files:**
- Create: `src/engine/membership.ts`
- Test: `src/engine/membership.test.ts`

**Interfaces:**
- Produces:
  - `interface SetMembership { groupOf: Int32Array; memberCount: Uint8Array; groupMembers: Int32Array[] }` where `groupOf[i]` is the group position within the set (0-based), `-1` when in no group, `-2` when in more than one; `groupMembers[g]` is the sorted member index list of group `g`.
  - `buildSetMembership(n: number, groupMembers: Int32Array[]): SetMembership`
  - `groupsOf(m: SetMembership, idx: number): number[]` all group positions containing `idx` (binary search per group; used only for conflict rows).

- [ ] **Step 1: Write the failing tests `src/engine/membership.test.ts`**

```typescript
import { buildSetMembership, groupsOf } from './membership'

describe('buildSetMembership', () => {
    // 6 objects; group 0 = {0,1,4}, group 1 = {1,2}, group 2 = {} 
    const m = buildSetMembership(6, [
        Int32Array.from([4, 0, 1]),
        Int32Array.from([2, 1]),
        Int32Array.from([]),
    ])

    it('counts memberships per object', () => {
        expect(Array.from(m.memberCount)).toEqual([1, 2, 1, 0, 1, 0])
    })

    it('resolves the single group, -1 for none and -2 for conflicts', () => {
        expect(Array.from(m.groupOf)).toEqual([0, -2, 1, -1, 0, -1])
    })

    it('stores sorted member lists', () => {
        expect(Array.from(m.groupMembers[0])).toEqual([0, 1, 4])
    })

    it('lists all groups of a conflicting object', () => {
        expect(groupsOf(m, 1)).toEqual([0, 1])
        expect(groupsOf(m, 3)).toEqual([])
        expect(groupsOf(m, 4)).toEqual([0])
    })

    it('saturates memberCount at 255 without wrapping', () => {
        const groups = Array.from({ length: 300 }, () => Int32Array.from([0]))
        const big = buildSetMembership(1, groups)
        expect(big.memberCount[0]).toBe(255)
        expect(big.groupOf[0]).toBe(-2)
    })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- src/engine/membership`
Expected: FAIL, cannot find module './membership'.

- [ ] **Step 3: Write `src/engine/membership.ts`**

```typescript
export interface SetMembership {
    /** group position in the set, -1 = none, -2 = more than one */
    groupOf: Int32Array
    /** number of groups of this set the object belongs to, saturating at 255 */
    memberCount: Uint8Array
    /** sorted member object indexes per group position */
    groupMembers: Int32Array[]
}

export function buildSetMembership(
    n: number,
    groupMembers: Int32Array[]
): SetMembership {
    const groupOf = new Int32Array(n).fill(-1)
    const memberCount = new Uint8Array(n)
    const sorted = groupMembers.map((members) => members.slice().sort())

    sorted.forEach((members, g) => {
        for (let k = 0; k < members.length; k++) {
            const idx = members[k]
            if (memberCount[idx] < 255) {
                memberCount[idx]++
            }
            groupOf[idx] = memberCount[idx] === 1 ? g : -2
        }
    })

    return { groupOf, memberCount, groupMembers: sorted }
}

function contains(sortedMembers: Int32Array, idx: number): boolean {
    let lo = 0
    let hi = sortedMembers.length - 1
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1
        const v = sortedMembers[mid]
        if (v === idx) {
            return true
        }
        if (v < idx) {
            lo = mid + 1
        } else {
            hi = mid - 1
        }
    }
    return false
}

export function groupsOf(m: SetMembership, idx: number): number[] {
    if (m.memberCount[idx] === 0) {
        return []
    }
    if (m.groupOf[idx] >= 0) {
        return [m.groupOf[idx]]
    }
    const result: number[] = []
    m.groupMembers.forEach((members, g) => {
        if (contains(members, idx)) {
            result.push(g)
        }
    })
    return result
}
```

`Int32Array.prototype.sort()` without a comparator sorts numerically, which is what we want.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- src/engine/membership`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/membership.ts src/engine/membership.test.ts
git commit -m "Add per-set membership index with conflict detection

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Population and rule evaluation

**Files:**
- Create: `src/engine/population.ts`, `src/engine/rules.ts`
- Test: `src/engine/population.test.ts`, `src/engine/rules.test.ts`

**Interfaces:**
- Consumes: `Status`, `GroupSetMeta`, `EngineConfig` (Task 2), `SetMembership` (Task 3).
- Produces:
  - `interface ObjectAttributes { domainType?: Uint8Array /* 1 aggregate, 2 tracker */; categoryOfOption?: Int32Array[] /* per option, category indexes */ }`
  - `populationFor(set: GroupSetMeta, n: number, membership: SetMembership, attrs: ObjectAttributes, config: EngineConfig): Uint8Array` (1 = in population)
  - `evaluateSet(set: GroupSetMeta, membership: SetMembership, population: Uint8Array, level: Uint8Array | null, config: EngineConfig): Uint8Array` of `Status` values.

- [ ] **Step 1: Write the failing tests `src/engine/population.test.ts`**

```typescript
import { buildSetMembership } from './membership'
import { populationFor } from './population'
import { DEFAULT_CONFIG, GroupSetMeta } from './types'

const set = (partial: Partial<GroupSetMeta>): GroupSetMeta => ({
    id: 's',
    displayName: 'S',
    objectType: 'organisationUnit',
    compulsory: false,
    dataDimension: false,
    groups: [],
    canWrite: true,
    ...partial,
})

describe('populationFor', () => {
    it('org units: everything is in the population', () => {
        const m = buildSetMembership(3, [])
        expect(
            Array.from(populationFor(set({}), 3, m, {}, DEFAULT_CONFIG))
        ).toEqual([1, 1, 1])
    })

    it('indicators: everything is in the population', () => {
        const m = buildSetMembership(2, [])
        expect(
            Array.from(
                populationFor(set({ objectType: 'indicator' }), 2, m, {}, DEFAULT_CONFIG)
            )
        ).toEqual([1, 1])
    })

    it('data elements: aggregate only unless includeTracker', () => {
        const m = buildSetMembership(3, [])
        const attrs = { domainType: Uint8Array.from([1, 2, 1]) }
        const de = set({ objectType: 'dataElement' })
        expect(Array.from(populationFor(de, 3, m, attrs, DEFAULT_CONFIG))).toEqual([1, 0, 1])
        expect(
            Array.from(
                populationFor(de, 3, m, attrs, { ...DEFAULT_CONFIG, includeTracker: true })
            )
        ).toEqual([1, 1, 1])
    })

    it('category options: all options of categories touched by the set', () => {
        // options 0,1 in category 0; options 2,3 in category 1; option 4 in category 2
        // set groups contain option 0 and 2 only
        const m = buildSetMembership(5, [Int32Array.from([0]), Int32Array.from([2])])
        const attrs = {
            categoryOfOption: [
                Int32Array.from([0]),
                Int32Array.from([0]),
                Int32Array.from([1]),
                Int32Array.from([1]),
                Int32Array.from([2]),
            ],
        }
        expect(
            Array.from(
                populationFor(set({ objectType: 'categoryOption' }), 5, m, attrs, DEFAULT_CONFIG)
            )
        ).toEqual([1, 1, 1, 1, 0])
    })
})
```

- [ ] **Step 2: Write the failing tests `src/engine/rules.test.ts`**

```typescript
import { buildSetMembership } from './membership'
import { evaluateSet } from './rules'
import { DEFAULT_CONFIG, GroupSetMeta, Status } from './types'

const set = (partial: Partial<GroupSetMeta>): GroupSetMeta => ({
    id: 's',
    displayName: 'S',
    objectType: 'organisationUnit',
    compulsory: false,
    dataDimension: false,
    groups: [],
    canWrite: true,
    ...partial,
})

// objects: 0 in group A, 1 in A and B, 2 in none, 3 in none (outside population), 4 in B
const m = buildSetMembership(5, [Int32Array.from([0, 1]), Int32Array.from([1, 4])])
const population = Uint8Array.from([1, 1, 1, 0, 1])
const level = Uint8Array.from([3, 3, 3, 2, 2])

describe('evaluateSet', () => {
    it('conflict is always an error, even for plain sets', () => {
        const s = evaluateSet(set({}), m, population, level, DEFAULT_CONFIG)
        expect(s[1]).toBe(Status.Conflict)
        expect(s[0]).toBe(Status.Ok)
        expect(s[2]).toBe(Status.Ok) // missing but set is neither compulsory nor dimension
        expect(s[3]).toBe(Status.NotApplicable)
    })

    it('missing is an error when the set is compulsory', () => {
        const s = evaluateSet(set({ compulsory: true }), m, population, level, DEFAULT_CONFIG)
        expect(s[2]).toBe(Status.MissingError)
        expect(s[3]).toBe(Status.NotApplicable)
    })

    it('missing is a warning when the set is a dimension but not compulsory', () => {
        const s = evaluateSet(set({ dataDimension: true }), m, population, level, DEFAULT_CONFIG)
        expect(s[2]).toBe(Status.MissingWarning)
    })

    it('required levels make missing an error at those levels only', () => {
        const config = { ...DEFAULT_CONFIG, requiredLevels: { s: [2] } }
        // object 2 is level 3 -> not required; add object 5? use population where idx 4 missing:
        const m2 = buildSetMembership(5, [Int32Array.from([0, 1]), Int32Array.from([1])])
        const s = evaluateSet(set({ dataDimension: true }), m2, population, level, config)
        expect(s[4]).toBe(Status.MissingError) // level 2, required
        expect(s[2]).toBe(Status.MissingWarning) // level 3, dimension warning still applies
    })

    it('required levels do not downgrade a compulsory set', () => {
        const config = { ...DEFAULT_CONFIG, requiredLevels: { s: [2] } }
        const s = evaluateSet(set({ compulsory: true }), m, population, level, config)
        expect(s[2]).toBe(Status.MissingError)
    })

    it('works without levels for flat object types', () => {
        const s = evaluateSet(
            set({ objectType: 'dataElement', compulsory: true }),
            m,
            population,
            null,
            DEFAULT_CONFIG
        )
        expect(s[2]).toBe(Status.MissingError)
    })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test -- src/engine/population src/engine/rules`
Expected: FAIL, modules not found.

- [ ] **Step 4: Write `src/engine/population.ts`**

```typescript
import { SetMembership } from './membership'
import { EngineConfig, GroupSetMeta } from './types'

export interface ObjectAttributes {
    /** data elements: 1 = AGGREGATE, 2 = TRACKER */
    domainType?: Uint8Array
    /** category options: category indexes each option belongs to */
    categoryOfOption?: Int32Array[]
}

/**
 * Which objects a group set applies to (spec 3.1). 1 = in population.
 */
export function populationFor(
    set: GroupSetMeta,
    n: number,
    membership: SetMembership,
    attrs: ObjectAttributes,
    config: EngineConfig
): Uint8Array {
    const population = new Uint8Array(n)

    switch (set.objectType) {
        case 'organisationUnit':
        case 'indicator':
            population.fill(1)
            return population

        case 'dataElement': {
            const domainType = attrs.domainType
            if (!domainType) {
                population.fill(1)
                return population
            }
            for (let i = 0; i < n; i++) {
                const isAggregate = domainType[i] === 1
                population[i] = isAggregate || config.includeTracker ? 1 : 0
            }
            return population
        }

        case 'categoryOption': {
            const categoryOfOption = attrs.categoryOfOption
            if (!categoryOfOption) {
                population.fill(1)
                return population
            }
            // Categories touched by the set: every category of every current member.
            const touched = new Set<number>()
            for (let i = 0; i < n; i++) {
                if (membership.memberCount[i] > 0) {
                    categoryOfOption[i].forEach((c) => touched.add(c))
                }
            }
            for (let i = 0; i < n; i++) {
                population[i] = categoryOfOption[i].some((c) => touched.has(c)) ? 1 : 0
            }
            return population
        }
    }
}
```

- [ ] **Step 5: Write `src/engine/rules.ts`**

```typescript
import { SetMembership } from './membership'
import { EngineConfig, GroupSetMeta, Status } from './types'

/**
 * Spec 3.2. Returns one Status per object.
 * - Conflict (count > 1) is always an error.
 * - Missing (count == 0) is an error when the set is compulsory, or when the
 *   object's level is in the set's required levels; a warning when the set
 *   is a data dimension; otherwise Ok.
 */
export function evaluateSet(
    set: GroupSetMeta,
    membership: SetMembership,
    population: Uint8Array,
    level: Uint8Array | null,
    config: EngineConfig
): Uint8Array {
    const n = population.length
    const status = new Uint8Array(n)
    const requiredLevels = config.requiredLevels[set.id] ?? []
    const requiredMask = new Uint8Array(64)
    requiredLevels.forEach((l) => {
        if (l >= 0 && l < 64) {
            requiredMask[l] = 1
        }
    })
    const hasRequiredLevels = level !== null && requiredLevels.length > 0

    for (let i = 0; i < n; i++) {
        if (population[i] === 0) {
            status[i] = Status.NotApplicable
            continue
        }
        const count = membership.memberCount[i]
        if (count > 1) {
            status[i] = Status.Conflict
        } else if (count === 1) {
            status[i] = Status.Ok
        } else if (set.compulsory) {
            status[i] = Status.MissingError
        } else if (hasRequiredLevels && requiredMask[level![i]] === 1) {
            status[i] = Status.MissingError
        } else if (set.dataDimension) {
            status[i] = Status.MissingWarning
        } else {
            status[i] = Status.Ok
        }
    }
    return status
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test -- src/engine/population src/engine/rules`
Expected: PASS, 10 tests.

- [ ] **Step 7: Commit**

```bash
git add src/engine/population.ts src/engine/rules.ts src/engine/population.test.ts src/engine/rules.test.ts
git commit -m "Add population and rule evaluation for group sets

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Engine queries: summary, matrix, object list

**Files:**
- Create: `src/engine/queries.ts`
- Test: `src/engine/queries.test.ts`

**Interfaces:**
- Consumes: `Hierarchy`, `isInSubtree`, `ancestorAtLevel` (Task 2); `SetMembership` (Task 3); `Status` (Task 2).
- Produces:
  - `interface SetSummary { population: number; ok: number; missingError: number; missingWarning: number; conflict: number }`
  - `summarize(status: Uint8Array, h: Hierarchy | null, scopeRoot: number): SetSummary` (scopeRoot ignored when `h` is null; -1 means whole forest)
  - `interface MatrixRow { object: number /* -1 for "above row level" */; perGroup: number[]; missing: number; conflict: number; total: number }`
  - `matrix(status: Uint8Array, m: SetMembership, h: Hierarchy | null, scopeRoot: number, rowLevel: number, groupCount: number): MatrixRow[]` (flat types: single row with object -1)
  - `interface ObjectFilter { statuses?: Status[]; level?: number; group?: number /* -1 none, -2 conflict, >=0 group */; ancestor?: number }`
  - `listObjects(status: Uint8Array, m: SetMembership, h: Hierarchy | null, scopeRoot: number, filter: ObjectFilter): Int32Array` (indexes in depth-first order for hierarchies, index order otherwise)

- [ ] **Step 1: Write the failing tests `src/engine/queries.test.ts`**

```typescript
import { buildHierarchy } from './hierarchy'
import { buildSetMembership } from './membership'
import { listObjects, matrix, summarize } from './queries'
import { Status } from './types'

// 0 root(1) -> 1 A(2) -> 3,4 (3) ; 0 -> 2 B(2) -> 5 (3)
const h = buildHierarchy(
    Int32Array.from([-1, 0, 0, 1, 1, 2]),
    Uint8Array.from([1, 2, 2, 3, 3, 3])
)
// groups: G0 = {3}, G1 = {4, 5}, and 4 also in G0 -> conflict
const m = buildSetMembership(6, [Int32Array.from([3, 4]), Int32Array.from([4, 5])])
// status computed as a compulsory set would: 0,1,2 missing (error), 3 ok, 4 conflict, 5 ok
const status = Uint8Array.from([
    Status.MissingError,
    Status.MissingError,
    Status.MissingError,
    Status.Ok,
    Status.Conflict,
    Status.Ok,
])

describe('summarize', () => {
    it('counts within the scope subtree', () => {
        expect(summarize(status, h, 0)).toEqual({
            population: 6,
            ok: 2,
            missingError: 3,
            missingWarning: 0,
            conflict: 1,
        })
        expect(summarize(status, h, 1)).toEqual({
            population: 3,
            ok: 1,
            missingError: 1,
            missingWarning: 0,
            conflict: 1,
        })
    })

    it('ignores NotApplicable objects', () => {
        const s = Uint8Array.from([Status.NotApplicable, Status.Ok])
        expect(summarize(s, null, -1).population).toBe(1)
    })
})

describe('matrix', () => {
    it('one row per org unit at the row level, plus an "above" row', () => {
        const rows = matrix(status, m, h, 0, 2, 2)
        expect(rows).toEqual([
            { object: 1, perGroup: [1, 0], missing: 1, conflict: 1, total: 3 },
            { object: 2, perGroup: [0, 1], missing: 1, conflict: 0, total: 2 },
            { object: -1, perGroup: [0, 0], missing: 1, conflict: 0, total: 1 },
        ])
    })

    it('flat types produce a single row', () => {
        const rows = matrix(status, m, null, -1, 0, 2)
        expect(rows).toEqual([
            { object: -1, perGroup: [1, 1], missing: 3, conflict: 1, total: 6 },
        ])
    })
})

describe('listObjects', () => {
    it('returns indexes in the scope in depth-first order', () => {
        expect(Array.from(listObjects(status, m, h, 0, {}))).toEqual([0, 1, 3, 4, 2, 5])
    })
    it('filters by status, level, group and ancestor', () => {
        expect(Array.from(listObjects(status, m, h, 0, { statuses: [Status.Conflict] }))).toEqual([4])
        expect(Array.from(listObjects(status, m, h, 0, { level: 2 }))).toEqual([1, 2])
        expect(Array.from(listObjects(status, m, h, 0, { group: 1 }))).toEqual([5])
        expect(Array.from(listObjects(status, m, h, 0, { group: -1 }))).toEqual([0, 1, 2])
        expect(Array.from(listObjects(status, m, h, 0, { ancestor: 2 }))).toEqual([2, 5])
    })
    it('works for flat types', () => {
        expect(Array.from(listObjects(status, m, null, -1, { statuses: [Status.Ok] }))).toEqual([3, 5])
    })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- src/engine/queries`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/engine/queries.ts`**

```typescript
import { ancestorAtLevel, Hierarchy, isInSubtree } from './hierarchy'
import { SetMembership } from './membership'
import { Status } from './types'

export interface SetSummary {
    population: number
    ok: number
    missingError: number
    missingWarning: number
    conflict: number
}

/** Visits every object index in scope, in depth-first order for hierarchies. */
function forEachInScope(
    n: number,
    h: Hierarchy | null,
    scopeRoot: number,
    visit: (idx: number) => void
): void {
    if (h === null || scopeRoot < 0) {
        if (h === null) {
            for (let i = 0; i < n; i++) {
                visit(i)
            }
        } else {
            for (let pos = 0; pos < n; pos++) {
                visit(h.byOrder[pos])
            }
        }
        return
    }
    const start = h.order[scopeRoot]
    const end = h.subtreeEnd[scopeRoot]
    for (let pos = start; pos < end; pos++) {
        visit(h.byOrder[pos])
    }
}

export function summarize(
    status: Uint8Array,
    h: Hierarchy | null,
    scopeRoot: number
): SetSummary {
    const s: SetSummary = { population: 0, ok: 0, missingError: 0, missingWarning: 0, conflict: 0 }
    forEachInScope(status.length, h, scopeRoot, (i) => {
        switch (status[i]) {
            case Status.Ok:
                s.ok++
                break
            case Status.MissingError:
                s.missingError++
                break
            case Status.MissingWarning:
                s.missingWarning++
                break
            case Status.Conflict:
                s.conflict++
                break
            default:
                return
        }
        s.population++
    })
    return s
}

export interface MatrixRow {
    /** org unit index of the row, or -1 for objects above the row level */
    object: number
    perGroup: number[]
    missing: number
    conflict: number
    total: number
}

function newRow(object: number, groupCount: number): MatrixRow {
    return { object, perGroup: new Array(groupCount).fill(0), missing: 0, conflict: 0, total: 0 }
}

function addToRow(row: MatrixRow, status: number, groupOf: number): void {
    if (status === Status.NotApplicable) {
        return
    }
    row.total++
    if (status === Status.Conflict) {
        row.conflict++
    } else if (groupOf >= 0) {
        row.perGroup[groupOf]++
    } else {
        row.missing++
    }
}

export function matrix(
    status: Uint8Array,
    m: SetMembership,
    h: Hierarchy | null,
    scopeRoot: number,
    rowLevel: number,
    groupCount: number
): MatrixRow[] {
    const above = newRow(-1, groupCount)
    if (h === null) {
        for (let i = 0; i < status.length; i++) {
            addToRow(above, status[i], m.groupOf[i])
        }
        return [above]
    }
    const rows = new Map<number, MatrixRow>()
    forEachInScope(status.length, h, scopeRoot, (i) => {
        const rowObject = ancestorAtLevel(h, i, rowLevel)
        if (rowObject < 0) {
            addToRow(above, status[i], m.groupOf[i])
            return
        }
        let row = rows.get(rowObject)
        if (!row) {
            row = newRow(rowObject, groupCount)
            rows.set(rowObject, row)
        }
        addToRow(row, status[i], m.groupOf[i])
    })
    // Map preserves insertion order, which is depth-first order.
    const result = Array.from(rows.values())
    if (above.total > 0) {
        result.push(above)
    }
    return result
}

export interface ObjectFilter {
    statuses?: Status[]
    level?: number
    /** -1 = no group, -2 = conflict, >= 0 = that group position */
    group?: number
    ancestor?: number
}

export function listObjects(
    status: Uint8Array,
    m: SetMembership,
    h: Hierarchy | null,
    scopeRoot: number,
    filter: ObjectFilter
): Int32Array {
    const statusMask = new Uint8Array(8)
    if (filter.statuses) {
        filter.statuses.forEach((s) => (statusMask[s] = 1))
    } else {
        statusMask.fill(1)
        statusMask[Status.NotApplicable] = 0
    }
    const out: number[] = []
    forEachInScope(status.length, h, scopeRoot, (i) => {
        if (statusMask[status[i]] === 0) {
            return
        }
        if (filter.level !== undefined && (h === null || h.level[i] !== filter.level)) {
            return
        }
        if (filter.group !== undefined && m.groupOf[i] !== filter.group) {
            return
        }
        if (filter.ancestor !== undefined && (h === null || !isInSubtree(h, filter.ancestor, i))) {
            return
        }
        out.push(i)
    })
    return Int32Array.from(out)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- src/engine/queries`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/queries.ts src/engine/queries.test.ts
git commit -m "Add engine queries for summary, matrix and object lists

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Engine store, worker protocol, worker and client

**Files:**
- Create: `src/engine/store.ts`, `src/engine/protocol.ts`, `src/engine/worker.ts`, `src/engine/client.ts`
- Test: `src/engine/store.test.ts`, `src/engine/client.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2 to 5.
- Produces:
  - Payloads (shared with the data layer; defined in `protocol.ts` so `src/data` can import them without touching engine internals):
    - `interface ObjectsPayload { objectType: ObjectType; ids: string[]; names: string[] | null; level: Uint8Array | null; parentIds: (string | null)[] | null; domainType: Uint8Array | null; categoryIdsOfOption: string[][] | null }`
    - `interface MembershipsPayload { objectType: ObjectType; groups: { groupId: string; memberIds: string[] }[] }`
  - `class EngineStore` with `loadObjects(p: ObjectsPayload)`, `loadMemberships(p: MembershipsPayload)`, `setGroupSets(sets: GroupSetMeta[])`, `setConfig(c: EngineConfig)`, `setNames(objectType, names: string[])`, `evaluate(): void`, `dashboard(scope: ScopeRef): DashboardEntry[]`, `matrixFor(setId, scope, rowLevel): MatrixResult`, `objectsFor(setId, scope, filter, offset, limit): ObjectsResult`, `resolve(objectType, indexes): ObjectRef[]`, `indexOf(objectType, id): number`.
  - `type ScopeRef = { objectType: ObjectType; rootId: string | null }`
  - `interface ObjectRef { index: number; id: string; displayName: string | null; level: number | null; parentId: string | null }`
  - `interface DashboardEntry { set: GroupSetMeta; summary: SetSummary; hasData: boolean }`
  - `interface MatrixResult { rows: (MatrixRow & { row: ObjectRef | null })[]; groups: GroupMeta[] }`
  - `interface ObjectsResult { total: number; items: (ObjectRef & { status: Status; groups: number[] })[] }`
  - `protocol.ts`: `type EngineRequest = { id: number; method: keyof EngineStore-like API; args: unknown[] }`, `type EngineResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }`
  - `class EngineClient { constructor(worker: Worker); call<T>(method, ...args): Promise<T>; terminate() }` plus `createEngineWorker(): Worker`.

- [ ] **Step 1: Write `src/engine/protocol.ts`**

```typescript
import { ObjectType } from './types'

export interface ObjectsPayload {
    objectType: ObjectType
    ids: string[]
    names: string[] | null
    /** org units only */
    level: Uint8Array | null
    /** org units only, same length as ids, null for roots */
    parentIds: (string | null)[] | null
    /** data elements only: 1 aggregate, 2 tracker */
    domainType: Uint8Array | null
    /** category options only: category ids per option */
    categoryIdsOfOption: string[][] | null
}

export interface MembershipsPayload {
    objectType: ObjectType
    groups: { groupId: string; memberIds: string[] }[]
}

export type EngineMethod =
    | 'loadObjects'
    | 'loadMemberships'
    | 'setGroupSets'
    | 'setConfig'
    | 'setNames'
    | 'evaluate'
    | 'dashboard'
    | 'matrixFor'
    | 'objectsFor'
    | 'resolve'
    | 'indexOf'
    | 'reset'

export interface EngineRequest {
    id: number
    method: EngineMethod
    args: unknown[]
}

export type EngineResponse =
    | { id: number; ok: true; result: unknown }
    | { id: number; ok: false; error: string }
```

- [ ] **Step 2: Write the failing tests `src/engine/store.test.ts`**

```typescript
import { EngineStore } from './store'
import { GroupSetMeta, Status } from './types'

const ownership: GroupSetMeta = {
    id: 'own',
    displayName: 'Ownership',
    objectType: 'organisationUnit',
    compulsory: true,
    dataDimension: true,
    canWrite: true,
    groups: [
        { id: 'pub', displayName: 'Public', canWrite: true },
        { id: 'priv', displayName: 'Private', canWrite: true },
    ],
}

function loadedStore(): EngineStore {
    const store = new EngineStore()
    store.loadObjects({
        objectType: 'organisationUnit',
        ids: ['root', 'A', 'B', 'a1', 'a2', 'b1'],
        names: ['Root', 'A', 'B', 'a1', 'a2', 'b1'],
        level: Uint8Array.from([1, 2, 2, 3, 3, 3]),
        parentIds: [null, 'root', 'root', 'A', 'A', 'B'],
        domainType: null,
        categoryIdsOfOption: null,
    })
    store.setGroupSets([ownership])
    store.loadMemberships({
        objectType: 'organisationUnit',
        groups: [
            { groupId: 'pub', memberIds: ['a1', 'a2', 'unknown-id'] },
            { groupId: 'priv', memberIds: ['a2', 'b1'] },
        ],
    })
    store.evaluate()
    return store
}

describe('EngineStore', () => {
    it('produces dashboard summaries for the scope', () => {
        const store = loadedStore()
        const [entry] = store.dashboard({ objectType: 'organisationUnit', rootId: 'A' })
        expect(entry.set.id).toBe('own')
        expect(entry.summary).toEqual({ population: 3, ok: 1, missingError: 1, missingWarning: 0, conflict: 1 })
    })

    it('ignores member ids that are not loaded objects', () => {
        const store = loadedStore()
        const [entry] = store.dashboard({ objectType: 'organisationUnit', rootId: null })
        expect(entry.summary.population).toBe(6)
    })

    it('returns a matrix with resolved row objects', () => {
        const store = loadedStore()
        const result = store.matrixFor('own', { objectType: 'organisationUnit', rootId: 'root' }, 2)
        expect(result.groups.map((g) => g.id)).toEqual(['pub', 'priv'])
        expect(result.rows[0].row?.displayName).toBe('A')
        expect(result.rows[0].perGroup).toEqual([1, 0])
        expect(result.rows[0].conflict).toBe(1)
        expect(result.rows[2].row).toBeNull()
    })

    it('pages object lists and includes status and groups', () => {
        const store = loadedStore()
        const page = store.objectsFor(
            'own',
            { objectType: 'organisationUnit', rootId: 'root' },
            { statuses: [Status.Conflict, Status.Ok] },
            0,
            10
        )
        expect(page.total).toBe(3)
        expect(page.items.map((i) => i.id)).toEqual(['a1', 'a2', 'b1'])
        expect(page.items[1].status).toBe(Status.Conflict)
        expect(page.items[1].groups).toEqual([0, 1])
        expect(page.items[0].parentId).toBe('A')
    })

    it('reports hasData false for sets whose type is not loaded', () => {
        const store = new EngineStore()
        store.setGroupSets([{ ...ownership, id: 'x', objectType: 'indicator' }])
        const [entry] = store.dashboard({ objectType: 'indicator', rootId: null })
        expect(entry.hasData).toBe(false)
    })

    it('setNames fills names after the fact', () => {
        const store = loadedStore()
        store.setNames('organisationUnit', ['R', 'AA', 'BB', 'x', 'y', 'z'])
        expect(store.resolve('organisationUnit', [1])[0].displayName).toBe('AA')
    })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test -- src/engine/store`
Expected: FAIL, module not found.

- [ ] **Step 4: Write `src/engine/store.ts`**

```typescript
import { buildHierarchy, Hierarchy } from './hierarchy'
import { buildSetMembership, groupsOf, SetMembership } from './membership'
import { ObjectAttributes, populationFor } from './population'
import { MembershipsPayload, ObjectsPayload } from './protocol'
import { listObjects, matrix, MatrixRow, ObjectFilter, SetSummary, summarize } from './queries'
import { evaluateSet } from './rules'
import { DEFAULT_CONFIG, EngineConfig, GroupMeta, GroupSetMeta, ObjectType, Status } from './types'

export interface ScopeRef {
    objectType: ObjectType
    /** org unit id, or null for everything */
    rootId: string | null
}

export interface ObjectRef {
    index: number
    id: string
    displayName: string | null
    level: number | null
    parentId: string | null
}

export interface DashboardEntry {
    set: GroupSetMeta
    summary: SetSummary
    hasData: boolean
}

export interface MatrixResult {
    rows: (MatrixRow & { row: ObjectRef | null })[]
    groups: GroupMeta[]
}

export interface ObjectsResult {
    total: number
    items: (ObjectRef & { status: Status; groups: number[] })[]
}

interface TypeIndex {
    ids: string[]
    names: string[] | null
    indexOf: Map<string, number>
    hierarchy: Hierarchy | null
    attrs: ObjectAttributes
    /** raw member id lists per group id, kept so evaluate() can re-run after config changes */
    membersByGroup: Map<string, string[]>
}

interface SetState {
    set: GroupSetMeta
    membership: SetMembership
    status: Uint8Array
}

const EMPTY_SUMMARY: SetSummary = { population: 0, ok: 0, missingError: 0, missingWarning: 0, conflict: 0 }

export class EngineStore {
    private types = new Map<ObjectType, TypeIndex>()
    private groupSets: GroupSetMeta[] = []
    private config: EngineConfig = DEFAULT_CONFIG
    private sets = new Map<string, SetState>()

    reset(): void {
        this.types.clear()
        this.sets.clear()
    }

    loadObjects(p: ObjectsPayload): void {
        const indexOf = new Map<string, number>()
        p.ids.forEach((id, i) => indexOf.set(id, i))

        let hierarchy: Hierarchy | null = null
        if (p.level && p.parentIds) {
            const parent = new Int32Array(p.ids.length)
            p.parentIds.forEach((pid, i) => {
                const parentIndex = pid === null ? -1 : indexOf.get(pid) ?? -1
                parent[i] = parentIndex
            })
            hierarchy = buildHierarchy(parent, p.level)
        }

        const attrs: ObjectAttributes = {}
        if (p.domainType) {
            attrs.domainType = p.domainType
        }
        if (p.categoryIdsOfOption) {
            const categoryIndex = new Map<string, number>()
            attrs.categoryOfOption = p.categoryIdsOfOption.map((cats) =>
                Int32Array.from(
                    cats.map((c) => {
                        if (!categoryIndex.has(c)) {
                            categoryIndex.set(c, categoryIndex.size)
                        }
                        return categoryIndex.get(c) as number
                    })
                )
            )
        }

        const existing = this.types.get(p.objectType)
        this.types.set(p.objectType, {
            ids: p.ids,
            names: p.names,
            indexOf,
            hierarchy,
            attrs,
            membersByGroup: existing?.membersByGroup ?? new Map(),
        })
    }

    setNames(objectType: ObjectType, names: string[]): void {
        const t = this.types.get(objectType)
        if (t) {
            t.names = names
        }
    }

    loadMemberships(p: MembershipsPayload): void {
        const t = this.types.get(p.objectType)
        if (!t) {
            throw new Error(`loadMemberships before loadObjects for ${p.objectType}`)
        }
        p.groups.forEach((g) => t.membersByGroup.set(g.groupId, g.memberIds))
    }

    setGroupSets(sets: GroupSetMeta[]): void {
        this.groupSets = sets
    }

    setConfig(config: EngineConfig): void {
        this.config = config
    }

    /** Rebuilds membership and status for every set whose object type is loaded. */
    evaluate(): void {
        this.sets.clear()
        this.groupSets.forEach((set) => {
            const t = this.types.get(set.objectType)
            if (!t) {
                return
            }
            const groupMembers = set.groups.map((g) => {
                const ids = t.membersByGroup.get(g.id) ?? []
                const out: number[] = []
                ids.forEach((id) => {
                    const idx = t.indexOf.get(id)
                    if (idx !== undefined) {
                        out.push(idx)
                    }
                })
                return Int32Array.from(out)
            })
            const membership = buildSetMembership(t.ids.length, groupMembers)
            const population = populationFor(set, t.ids.length, membership, t.attrs, this.config)
            const level = t.hierarchy ? t.hierarchy.level : null
            const status = evaluateSet(set, membership, population, level, this.config)
            this.sets.set(set.id, { set, membership, status })
        })
    }

    private scopeRoot(t: TypeIndex, scope: ScopeRef): number {
        if (!t.hierarchy || scope.rootId === null) {
            return -1
        }
        return t.indexOf.get(scope.rootId) ?? -1
    }

    dashboard(scope: ScopeRef): DashboardEntry[] {
        return this.groupSets
            .filter((set) => set.objectType === scope.objectType)
            .map((set) => {
                const state = this.sets.get(set.id)
                const t = this.types.get(set.objectType)
                if (!state || !t) {
                    return { set, summary: EMPTY_SUMMARY, hasData: false }
                }
                return {
                    set,
                    summary: summarize(state.status, t.hierarchy, this.scopeRoot(t, scope)),
                    hasData: true,
                }
            })
    }

    resolve(objectType: ObjectType, indexes: ArrayLike<number>): ObjectRef[] {
        const t = this.types.get(objectType)
        if (!t) {
            return []
        }
        return Array.from(indexes, (index) => this.ref(t, index))
    }

    private ref(t: TypeIndex, index: number): ObjectRef {
        const h = t.hierarchy
        const parentIndex = h ? h.parent[index] : -1
        return {
            index,
            id: t.ids[index],
            displayName: t.names ? t.names[index] : null,
            level: h ? h.level[index] : null,
            parentId: parentIndex >= 0 ? t.ids[parentIndex] : null,
        }
    }

    indexOf(objectType: ObjectType, id: string): number {
        return this.types.get(objectType)?.indexOf.get(id) ?? -1
    }

    private setState(setId: string): { state: SetState; t: TypeIndex } {
        const state = this.sets.get(setId)
        if (!state) {
            throw new Error(`Unknown or unevaluated group set ${setId}`)
        }
        const t = this.types.get(state.set.objectType) as TypeIndex
        return { state, t }
    }

    matrixFor(setId: string, scope: ScopeRef, rowLevel: number): MatrixResult {
        const { state, t } = this.setState(setId)
        const rows = matrix(
            state.status,
            state.membership,
            t.hierarchy,
            this.scopeRoot(t, scope),
            rowLevel,
            state.set.groups.length
        )
        return {
            groups: state.set.groups,
            rows: rows.map((r) => ({ ...r, row: r.object >= 0 ? this.ref(t, r.object) : null })),
        }
    }

    objectsFor(
        setId: string,
        scope: ScopeRef,
        filter: ObjectFilter,
        offset: number,
        limit: number
    ): ObjectsResult {
        const { state, t } = this.setState(setId)
        const all = listObjects(state.status, state.membership, t.hierarchy, this.scopeRoot(t, scope), filter)
        const slice = all.subarray(offset, offset + limit)
        return {
            total: all.length,
            items: Array.from(slice, (index) => ({
                ...this.ref(t, index),
                status: state.status[index] as Status,
                groups: groupsOf(state.membership, index),
            })),
        }
    }
}
```

- [ ] **Step 5: Run the store tests**

Run: `pnpm test -- src/engine/store`
Expected: PASS, 6 tests.

- [ ] **Step 6: Write `src/engine/worker.ts`**

```typescript
/// <reference lib="webworker" />
import { EngineRequest, EngineResponse } from './protocol'
import { EngineStore } from './store'

const store = new EngineStore()

self.onmessage = (event: MessageEvent<EngineRequest>) => {
    const { id, method, args } = event.data
    let response: EngineResponse
    try {
        const fn = (store as unknown as Record<string, (...a: unknown[]) => unknown>)[method]
        if (typeof fn !== 'function') {
            throw new Error(`Unknown engine method ${method}`)
        }
        const result = fn.apply(store, args)
        response = { id, ok: true, result }
    } catch (error) {
        response = { id, ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    self.postMessage(response)
}
```

- [ ] **Step 7: Write the failing test `src/engine/client.test.ts`**

```typescript
import { EngineClient } from './client'
import { EngineRequest, EngineResponse } from './protocol'

class FakeWorker {
    onmessage: ((e: MessageEvent<EngineResponse>) => void) | null = null
    sent: EngineRequest[] = []
    postMessage(req: EngineRequest) {
        this.sent.push(req)
        const reply = (response: EngineResponse) =>
            this.onmessage?.({ data: response } as MessageEvent<EngineResponse>)
        if (req.method === 'indexOf') {
            setTimeout(() => reply({ id: req.id, ok: true, result: 7 }), 0)
        } else {
            setTimeout(() => reply({ id: req.id, ok: false, error: 'boom' }), 0)
        }
    }
    terminate() {}
}

describe('EngineClient', () => {
    it('resolves with the worker result', async () => {
        const client = new EngineClient(new FakeWorker() as unknown as Worker)
        await expect(client.call<number>('indexOf', 'organisationUnit', 'x')).resolves.toBe(7)
    })

    it('rejects with the worker error and matches responses by id', async () => {
        const worker = new FakeWorker()
        const client = new EngineClient(worker as unknown as Worker)
        const a = client.call('indexOf', 'organisationUnit', 'x')
        const b = client.call('evaluate')
        await expect(b).rejects.toThrow('boom')
        await expect(a).resolves.toBe(7)
        expect(worker.sent.map((r) => r.id)).toEqual([1, 2])
    })
})
```

- [ ] **Step 8: Write `src/engine/client.ts`**

```typescript
import { EngineMethod, EngineRequest, EngineResponse } from './protocol'

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

export class EngineClient {
    private nextId = 1
    private pending = new Map<number, Pending>()

    constructor(private worker: Worker) {
        worker.onmessage = (event: MessageEvent<EngineResponse>) => {
            const response = event.data
            const p = this.pending.get(response.id)
            if (!p) {
                return
            }
            this.pending.delete(response.id)
            if (response.ok) {
                p.resolve(response.result)
            } else {
                p.reject(new Error(response.error))
            }
        }
    }

    call<T>(method: EngineMethod, ...args: unknown[]): Promise<T> {
        const id = this.nextId++
        const request: EngineRequest = { id, method, args }
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
            this.worker.postMessage(request)
        })
    }

    terminate(): void {
        this.worker.terminate()
        this.pending.forEach((p) => p.reject(new Error('Engine terminated')))
        this.pending.clear()
    }
}

export function createEngineWorker(): Worker {
    // Vite turns this pattern into a separate worker bundle.
    return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
}
```

`import.meta.url` is not available under Jest's CommonJS transform; the test never calls `createEngineWorker`, and Babel leaves `import.meta` alone only when the file is ESM. If Jest fails to parse the file, move `createEngineWorker` into `src/engine/createWorker.ts` and keep it out of any test import path.

- [ ] **Step 9: Run all engine tests, types and lint**

```bash
pnpm test -- src/engine
pnpm exec tsc --noEmit
pnpm exec eslint src
```

Expected: all pass. Typed arrays crossing `postMessage` are structured-cloned, which is fine for these sizes.

- [ ] **Step 10: Commit**

```bash
git add src/engine
git commit -m "Add engine store, worker protocol and promise client

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: CSV parser and the two object/membership sources

**Files:**
- Create: `src/data/csv.ts`, `src/data/sources/DataSource.ts`, `src/data/sources/metadataSource.ts`, `src/data/sources/sqlViewSource.ts`, `src/data/sources/selectSource.ts`
- Test: `src/data/csv.test.ts`, `src/data/sources/metadataSource.test.ts`, `src/data/sources/sqlViewSource.test.ts`

**Interfaces:**
- Consumes: `ObjectsPayload`, `MembershipsPayload` from `src/engine/protocol.ts`; `ObjectType` from `src/engine/types.ts`.
- Produces:
  - `parseCsv(text: string): string[][]` (RFC 4180 subset: quoted fields with doubled quotes, `\r\n` or `\n`, header row included as row 0)
  - `type Fetcher = (path: string, init?: RequestInit) => Promise<Response>` (path relative to `/api/`, e.g. `organisationUnits?fields=...`)
  - `interface DataSource { kind: 'sqlView' | 'metadata'; loadObjects(type: ObjectType, onProgress: (p: Progress) => void): Promise<ObjectsPayload>; loadNames(type: ObjectType): Promise<NamedId[]>; loadMemberships(type: ObjectType, groupIds: string[], onProgress): Promise<MembershipsPayload> }`
  - `interface Progress { label: string; done: number; total: number | null }`
  - `interface NamedId { id: string; displayName: string }` (names are realigned to `ids` by the caller with a Map, since two unpaged requests are not guaranteed the same order)
  - `createMetadataSource(fetcher: Fetcher): DataSource`
  - `createSqlViewSource(fetcher: Fetcher, views: SqlViewIds): DataSource` where `interface SqlViewIds { orgUnits: string; orgUnitNames: string; orgUnitMemberships: string }`
  - `selectSource(fetcher: Fetcher): Promise<{ source: DataSource; sqlViews: SqlViewIds | null }>` looks up SQL views by code `GSI_ORGUNITS`, `GSI_ORGUNIT_NAMES`, `GSI_ORGUNIT_MEMBERSHIPS` and requires `access.data.read` on all three; otherwise metadata.
  - `SQL_VIEW_DEFINITIONS: { code: string; name: string; sqlQuery: string }[]` (used by Plan 3's Settings page to create the views).
  - Endpoint map per type (metadata source):

| ObjectType | collection | group collection | member field |
| --- | --- | --- | --- |
| organisationUnit | `organisationUnits` | `organisationUnitGroups` | `organisationUnits` |
| dataElement | `dataElements` | `dataElementGroups` | `dataElements` |
| indicator | `indicators` | `indicatorGroups` | `indicators` |
| categoryOption | `categoryOptions` | `categoryOptionGroups` | `categoryOptions` |

  exported as `ENDPOINTS: Record<ObjectType, { collection: string; groups: string; members: string; groupSets: string }>` from `src/data/endpoints.ts` (`groupSets`: `organisationUnitGroupSets`, `dataElementGroupSets`, `indicatorGroupSets`, `categoryOptionGroupSets`).

- [ ] **Step 1: Write the failing test `src/data/csv.test.ts`**

```typescript
import { parseCsv } from './csv'

describe('parseCsv', () => {
    it('splits rows and columns', () => {
        expect(parseCsv('a,b,c\n1,2,3\n')).toEqual([['a', 'b', 'c'], ['1', '2', '3']])
    })
    it('handles CRLF and quoted fields with commas and doubled quotes', () => {
        expect(parseCsv('uid,name\r\nx1,"Clinic, ""A"""\r\n')).toEqual([
            ['uid', 'name'],
            ['x1', 'Clinic, "A"'],
        ])
    })
    it('keeps empty fields', () => {
        expect(parseCsv('a,,c\n')).toEqual([['a', '', 'c']])
    })
})
```

- [ ] **Step 2: Write `src/data/csv.ts`**

```typescript
/** Minimal RFC 4180 parser; fast enough for a few hundred thousand short rows. */
export function parseCsv(text: string): string[][] {
    const rows: string[][] = []
    let row: string[] = []
    let field = ''
    let i = 0
    const n = text.length
    while (i < n) {
        const ch = text[i]
        if (ch === '"') {
            i++
            while (i < n) {
                const c = text[i]
                if (c === '"') {
                    if (text[i + 1] === '"') {
                        field += '"'
                        i += 2
                        continue
                    }
                    i++
                    break
                }
                field += c
                i++
            }
            continue
        }
        if (ch === ',') {
            row.push(field)
            field = ''
            i++
            continue
        }
        if (ch === '\n' || ch === '\r') {
            row.push(field)
            field = ''
            rows.push(row)
            row = []
            i++
            if (ch === '\r' && text[i] === '\n') {
                i++
            }
            continue
        }
        // Unquoted run: find the next delimiter in one step.
        let j = i
        while (j < n && text[j] !== ',' && text[j] !== '\n' && text[j] !== '\r' && text[j] !== '"') {
            j++
        }
        field += text.slice(i, j)
        i = j
    }
    if (field.length > 0 || row.length > 0) {
        row.push(field)
        rows.push(row)
    }
    return rows
}
```

- [ ] **Step 3: Run the CSV tests**

Run: `pnpm test -- src/data/csv`
Expected: PASS, 3 tests.

- [ ] **Step 4: Write `src/data/endpoints.ts` and `src/data/sources/DataSource.ts`**

`src/data/endpoints.ts`:

```typescript
import { ObjectType } from '@/engine/types'

export const ENDPOINTS: Record<
    ObjectType,
    { collection: string; groups: string; members: string; groupSets: string }
> = {
    organisationUnit: {
        collection: 'organisationUnits',
        groups: 'organisationUnitGroups',
        members: 'organisationUnits',
        groupSets: 'organisationUnitGroupSets',
    },
    dataElement: {
        collection: 'dataElements',
        groups: 'dataElementGroups',
        members: 'dataElements',
        groupSets: 'dataElementGroupSets',
    },
    indicator: {
        collection: 'indicators',
        groups: 'indicatorGroups',
        members: 'indicators',
        groupSets: 'indicatorGroupSets',
    },
    categoryOption: {
        collection: 'categoryOptions',
        groups: 'categoryOptionGroups',
        members: 'categoryOptions',
        groupSets: 'categoryOptionGroupSets',
    },
}
```

`src/data/sources/DataSource.ts`:

```typescript
import { MembershipsPayload, ObjectsPayload } from '@/engine/protocol'
import { ObjectType } from '@/engine/types'

export type Fetcher = (path: string, init?: RequestInit) => Promise<Response>

export interface Progress {
    label: string
    done: number
    total: number | null
}

export interface NamedId {
    id: string
    displayName: string
}

export interface DataSource {
    kind: 'sqlView' | 'metadata'
    loadObjects(type: ObjectType, onProgress: (p: Progress) => void): Promise<ObjectsPayload>
    loadNames(type: ObjectType): Promise<NamedId[]>
    loadMemberships(
        type: ObjectType,
        groupIds: string[],
        onProgress: (p: Progress) => void
    ): Promise<MembershipsPayload>
}

export async function fetchJson<T>(fetcher: Fetcher, path: string): Promise<T> {
    const response = await fetcher(path)
    if (!response.ok) {
        throw new Error(`${path} failed with HTTP ${response.status}`)
    }
    return (await response.json()) as T
}
```

- [ ] **Step 5: Write the failing test `src/data/sources/metadataSource.test.ts`**

```typescript
import { createMetadataSource } from './metadataSource'

const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

describe('metadataSource', () => {
    it('loads org units with level and parent and ignores paging', async () => {
        const calls: string[] = []
        const fetcher = async (path: string) => {
            calls.push(path)
            return jsonResponse({
                organisationUnits: [
                    { id: 'r', level: 1 },
                    { id: 'a', level: 2, parent: { id: 'r' } },
                ],
            })
        }
        const source = createMetadataSource(fetcher)
        const payload = await source.loadObjects('organisationUnit', () => undefined)
        expect(calls[0]).toBe('organisationUnits?fields=id,level,parent&paging=false')
        expect(payload.ids).toEqual(['r', 'a'])
        expect(Array.from(payload.level ?? [])).toEqual([1, 2])
        expect(payload.parentIds).toEqual([null, 'r'])
        expect(payload.names).toBeNull()
    })

    it('loads data elements with names and domain type in one request', async () => {
        const fetcher = async () =>
            jsonResponse({
                dataElements: [
                    { id: 'd1', displayName: 'D1', domainType: 'AGGREGATE' },
                    { id: 'd2', displayName: 'D2', domainType: 'TRACKER' },
                ],
            })
        const payload = await createMetadataSource(fetcher).loadObjects('dataElement', () => undefined)
        expect(payload.names).toEqual(['D1', 'D2'])
        expect(Array.from(payload.domainType ?? [])).toEqual([1, 2])
    })

    it('loads category options with their categories', async () => {
        const fetcher = async () =>
            jsonResponse({
                categoryOptions: [{ id: 'o1', displayName: 'O1', categories: [{ id: 'c1' }, { id: 'c2' }] }],
            })
        const payload = await createMetadataSource(fetcher).loadObjects('categoryOption', () => undefined)
        expect(payload.categoryIdsOfOption).toEqual([['c1', 'c2']])
    })

    it('loads memberships one group per request and reports progress', async () => {
        const calls: string[] = []
        const fetcher = async (path: string) => {
            calls.push(path)
            return jsonResponse({ organisationUnits: [{ id: 'a' }, { id: 'b' }] })
        }
        const progress: number[] = []
        const payload = await createMetadataSource(fetcher).loadMemberships(
            'organisationUnit',
            ['g1', 'g2'],
            (p) => progress.push(p.done)
        )
        expect(calls).toEqual([
            'organisationUnitGroups/g1/organisationUnits?fields=id&paging=false',
            'organisationUnitGroups/g2/organisationUnits?fields=id&paging=false',
        ])
        expect(payload.groups).toEqual([
            { groupId: 'g1', memberIds: ['a', 'b'] },
            { groupId: 'g2', memberIds: ['a', 'b'] },
        ])
        expect(progress).toEqual([1, 2])
    })
})
```

- [ ] **Step 6: Write `src/data/sources/metadataSource.ts`**

```typescript
import { MembershipsPayload, ObjectsPayload } from '@/engine/protocol'
import { ObjectType } from '@/engine/types'
import { ENDPOINTS } from '../endpoints'
import { DataSource, fetchJson, Fetcher, NamedId, Progress } from './DataSource'

interface OrgUnitRow { id: string; level: number; parent?: { id: string } }
interface DataElementRow { id: string; displayName: string; domainType: 'AGGREGATE' | 'TRACKER' }
interface NamedRow { id: string; displayName: string }
interface CategoryOptionRow extends NamedRow { categories: { id: string }[] }

const emptyPayload = (objectType: ObjectType, ids: string[]): ObjectsPayload => ({
    objectType,
    ids,
    names: null,
    level: null,
    parentIds: null,
    domainType: null,
    categoryIdsOfOption: null,
})

export function createMetadataSource(fetcher: Fetcher): DataSource {
    const loadObjects = async (
        type: ObjectType,
        onProgress: (p: Progress) => void
    ): Promise<ObjectsPayload> => {
        const ep = ENDPOINTS[type]
        onProgress({ label: ep.collection, done: 0, total: null })
        switch (type) {
            case 'organisationUnit': {
                // Names are deliberately left out: on 266K org units they add 15 MB
                // and 20+ seconds; loadNames fetches them afterwards.
                const body = await fetchJson<{ organisationUnits: OrgUnitRow[] }>(
                    fetcher,
                    `${ep.collection}?fields=id,level,parent&paging=false`
                )
                const rows = body.organisationUnits
                const payload = emptyPayload(type, rows.map((r) => r.id))
                payload.level = Uint8Array.from(rows, (r) => r.level)
                payload.parentIds = rows.map((r) => r.parent?.id ?? null)
                onProgress({ label: ep.collection, done: 1, total: 1 })
                return payload
            }
            case 'dataElement': {
                const body = await fetchJson<{ dataElements: DataElementRow[] }>(
                    fetcher,
                    `${ep.collection}?fields=id,displayName,domainType&paging=false`
                )
                const rows = body.dataElements
                const payload = emptyPayload(type, rows.map((r) => r.id))
                payload.names = rows.map((r) => r.displayName)
                payload.domainType = Uint8Array.from(rows, (r) => (r.domainType === 'TRACKER' ? 2 : 1))
                onProgress({ label: ep.collection, done: 1, total: 1 })
                return payload
            }
            case 'indicator': {
                const body = await fetchJson<{ indicators: NamedRow[] }>(
                    fetcher,
                    `${ep.collection}?fields=id,displayName&paging=false`
                )
                const payload = emptyPayload(type, body.indicators.map((r) => r.id))
                payload.names = body.indicators.map((r) => r.displayName)
                onProgress({ label: ep.collection, done: 1, total: 1 })
                return payload
            }
            case 'categoryOption': {
                const body = await fetchJson<{ categoryOptions: CategoryOptionRow[] }>(
                    fetcher,
                    `${ep.collection}?fields=id,displayName,categories[id]&paging=false`
                )
                const rows = body.categoryOptions
                const payload = emptyPayload(type, rows.map((r) => r.id))
                payload.names = rows.map((r) => r.displayName)
                payload.categoryIdsOfOption = rows.map((r) => r.categories.map((c) => c.id))
                onProgress({ label: ep.collection, done: 1, total: 1 })
                return payload
            }
        }
    }

    const loadNames = async (type: ObjectType): Promise<NamedId[]> => {
        const ep = ENDPOINTS[type]
        const body = await fetchJson<Record<string, NamedRow[]>>(
            fetcher,
            `${ep.collection}?fields=id,displayName&paging=false`
        )
        return body[ep.collection]
    }

    const loadMemberships = async (
        type: ObjectType,
        groupIds: string[],
        onProgress: (p: Progress) => void
    ): Promise<MembershipsPayload> => {
        const ep = ENDPOINTS[type]
        const groups: MembershipsPayload['groups'] = []
        for (let i = 0; i < groupIds.length; i++) {
            const groupId = groupIds[i]
            const body = await fetchJson<Record<string, { id: string }[]>>(
                fetcher,
                `${ep.groups}/${groupId}/${ep.members}?fields=id&paging=false`
            )
            groups.push({ groupId, memberIds: body[ep.members].map((m) => m.id) })
            onProgress({ label: ep.groups, done: i + 1, total: groupIds.length })
        }
        return { objectType: type, groups }
    }

    return { kind: 'metadata', loadObjects, loadNames, loadMemberships }
}
```

- [ ] **Step 7: Write the failing test `src/data/sources/sqlViewSource.test.ts`**

```typescript
import { createSqlViewSource } from './sqlViewSource'

const csvResponse = (text: string) => new Response(text, { status: 200 })

describe('sqlViewSource', () => {
    const views = { orgUnits: 'V1', orgUnitNames: 'V2', orgUnitMemberships: 'V3' }

    it('loads org units from the hierarchy view', async () => {
        const calls: string[] = []
        const fetcher = async (path: string) => {
            calls.push(path)
            return csvResponse('uid,level,parent\nr,1,\na,2,r\n')
        }
        const payload = await createSqlViewSource(fetcher, views).loadObjects('organisationUnit', () => undefined)
        expect(calls[0]).toBe('sqlViews/V1/data.csv?paging=false')
        expect(payload.ids).toEqual(['r', 'a'])
        expect(Array.from(payload.level ?? [])).toEqual([1, 2])
        expect(payload.parentIds).toEqual([null, 'r'])
    })

    it('loads memberships from the membership view and keeps only requested groups', async () => {
        const fetcher = async () => csvResponse('groupid,ouid\ng1,a\ng1,b\ng9,a\n')
        const payload = await createSqlViewSource(fetcher, views).loadMemberships(
            'organisationUnit',
            ['g1', 'g2'],
            () => undefined
        )
        expect(payload.groups).toEqual([
            { groupId: 'g1', memberIds: ['a', 'b'] },
            { groupId: 'g2', memberIds: [] },
        ])
    })

    it('falls back to the metadata source for other object types', async () => {
        const calls: string[] = []
        const fetcher = async (path: string) => {
            calls.push(path)
            return new Response(JSON.stringify({ indicators: [{ id: 'i', displayName: 'I' }] }), { status: 200 })
        }
        const payload = await createSqlViewSource(fetcher, views).loadObjects('indicator', () => undefined)
        expect(calls[0]).toContain('indicators?fields=')
        expect(payload.ids).toEqual(['i'])
    })
})
```

- [ ] **Step 8: Write `src/data/sources/sqlViewSource.ts`**

```typescript
import { MembershipsPayload, ObjectsPayload } from '@/engine/protocol'
import { ObjectType } from '@/engine/types'
import { parseCsv } from '../csv'
import { DataSource, Fetcher, Progress } from './DataSource'
import { createMetadataSource } from './metadataSource'

export interface SqlViewIds {
    orgUnits: string
    orgUnitNames: string
    orgUnitMemberships: string
}

export const SQL_VIEW_CODES = {
    orgUnits: 'GSI_ORGUNITS',
    orgUnitNames: 'GSI_ORGUNIT_NAMES',
    orgUnitMemberships: 'GSI_ORGUNIT_MEMBERSHIPS',
} as const

export const SQL_VIEW_DEFINITIONS = [
    {
        code: SQL_VIEW_CODES.orgUnits,
        name: 'GSI org unit hierarchy',
        sqlQuery:
            'select ou.uid, ou.hierarchylevel as level, p.uid as parent from organisationunit ou left join organisationunit p on p.organisationunitid = ou.parentid',
    },
    {
        code: SQL_VIEW_CODES.orgUnitNames,
        name: 'GSI org unit names',
        sqlQuery: 'select uid, name from organisationunit',
    },
    {
        code: SQL_VIEW_CODES.orgUnitMemberships,
        name: 'GSI org unit group memberships',
        sqlQuery:
            'select g.uid as groupid, ou.uid as ouid from orgunitgroupmembers m join orgunitgroup g on g.orgunitgroupid = m.orgunitgroupid join organisationunit ou on ou.organisationunitid = m.organisationunitid where g.orgunitgroupid in (select orgunitgroupid from orgunitgroupsetmembers)',
    },
]

async function fetchCsv(fetcher: Fetcher, viewId: string): Promise<string[][]> {
    const response = await fetcher(`sqlViews/${viewId}/data.csv?paging=false`)
    if (!response.ok) {
        throw new Error(`SQL view ${viewId} failed with HTTP ${response.status}`)
    }
    const rows = parseCsv(await response.text())
    return rows.slice(1) // drop header
}

export function createSqlViewSource(fetcher: Fetcher, views: SqlViewIds): DataSource {
    const metadata = createMetadataSource(fetcher)

    const loadObjects = async (type: ObjectType, onProgress: (p: Progress) => void): Promise<ObjectsPayload> => {
        if (type !== 'organisationUnit') {
            return metadata.loadObjects(type, onProgress)
        }
        onProgress({ label: 'organisationUnits', done: 0, total: 1 })
        const rows = await fetchCsv(fetcher, views.orgUnits)
        const payload: ObjectsPayload = {
            objectType: type,
            ids: rows.map((r) => r[0]),
            names: null,
            level: Uint8Array.from(rows, (r) => Number(r[1])),
            parentIds: rows.map((r) => (r[2] === '' ? null : r[2])),
            domainType: null,
            categoryIdsOfOption: null,
        }
        onProgress({ label: 'organisationUnits', done: 1, total: 1 })
        return payload
    }

    const loadNames = async (type: ObjectType) => {
        if (type !== 'organisationUnit') {
            return metadata.loadNames(type)
        }
        const rows = await fetchCsv(fetcher, views.orgUnitNames)
        return rows.map((r) => ({ id: r[0], displayName: r[1] }))
    }

    const loadMemberships = async (
        type: ObjectType,
        groupIds: string[],
        onProgress: (p: Progress) => void
    ): Promise<MembershipsPayload> => {
        if (type !== 'organisationUnit') {
            return metadata.loadMemberships(type, groupIds, onProgress)
        }
        onProgress({ label: 'organisationUnitGroups', done: 0, total: 1 })
        const rows = await fetchCsv(fetcher, views.orgUnitMemberships)
        const byGroup = new Map<string, string[]>(groupIds.map((g) => [g, []]))
        rows.forEach((r) => byGroup.get(r[0])?.push(r[1]))
        onProgress({ label: 'organisationUnitGroups', done: 1, total: 1 })
        return {
            objectType: type,
            groups: groupIds.map((groupId) => ({ groupId, memberIds: byGroup.get(groupId) ?? [] })),
        }
    }

    return { kind: 'sqlView', loadObjects, loadNames, loadMemberships }
}
```

- [ ] **Step 9: Write `src/data/sources/selectSource.ts`**

```typescript
import { DataSource, fetchJson, Fetcher } from './DataSource'
import { createMetadataSource } from './metadataSource'
import { createSqlViewSource, SQL_VIEW_CODES, SqlViewIds } from './sqlViewSource'

interface SqlViewRow {
    id: string
    code?: string
    access: { data?: { read?: boolean } }
}

export async function findSqlViews(fetcher: Fetcher): Promise<SqlViewIds | null> {
    const codes = Object.values(SQL_VIEW_CODES)
    const body = await fetchJson<{ sqlViews: SqlViewRow[] }>(
        fetcher,
        `sqlViews?fields=id,code,access[data[read]]&filter=code:in:[${codes.join(',')}]&paging=false`
    )
    const byCode = new Map(body.sqlViews.map((v) => [v.code, v]))
    const pick = (code: string) => {
        const v = byCode.get(code)
        return v && v.access.data?.read ? v.id : null
    }
    const orgUnits = pick(SQL_VIEW_CODES.orgUnits)
    const orgUnitNames = pick(SQL_VIEW_CODES.orgUnitNames)
    const orgUnitMemberships = pick(SQL_VIEW_CODES.orgUnitMemberships)
    if (orgUnits && orgUnitNames && orgUnitMemberships) {
        return { orgUnits, orgUnitNames, orgUnitMemberships }
    }
    return null
}

export async function selectSource(
    fetcher: Fetcher
): Promise<{ source: DataSource; sqlViews: SqlViewIds | null }> {
    let sqlViews: SqlViewIds | null = null
    try {
        sqlViews = await findSqlViews(fetcher)
    } catch {
        sqlViews = null // a failing lookup must never block the metadata path
    }
    return sqlViews
        ? { source: createSqlViewSource(fetcher, sqlViews), sqlViews }
        : { source: createMetadataSource(fetcher), sqlViews: null }
}
```

- [ ] **Step 10: Run the data tests, types and lint**

```bash
pnpm test -- src/data
pnpm exec tsc --noEmit
pnpm exec eslint src
```

Expected: PASS (10 tests).

- [ ] **Step 11: Commit**

```bash
git add src/data
git commit -m "Add CSV parser and SQL view / metadata API data sources

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Group set metadata loader

**Files:**
- Create: `src/data/groupSets.ts`
- Test: `src/data/groupSets.test.ts`

**Interfaces:**
- Consumes: `ENDPOINTS` (Task 7), `Fetcher`, `fetchJson` (Task 7), `GroupSetMeta`, `GroupMeta`, `ObjectType`, `OBJECT_TYPES` (Task 2).
- Produces: `loadGroupSets(fetcher: Fetcher): Promise<GroupSetMeta[]>` for all four types in parallel; `groupIdsFor(sets: GroupSetMeta[], type: ObjectType): string[]` (unique group ids of that type's sets, in first-seen order).

- [ ] **Step 1: Write the failing test `src/data/groupSets.test.ts`**

```typescript
import { groupIdsFor, loadGroupSets } from './groupSets'

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

describe('loadGroupSets', () => {
    it('maps every type, its flags and write access', async () => {
        const fetcher = async (path: string) => {
            if (path.startsWith('organisationUnitGroupSets')) {
                return json({
                    organisationUnitGroupSets: [
                        {
                            id: 'own',
                            displayName: 'Ownership',
                            compulsory: true,
                            dataDimension: true,
                            access: { write: true },
                            organisationUnitGroups: [
                                { id: 'pub', displayName: 'Public', code: 'PUB', access: { write: true } },
                                { id: 'priv', displayName: 'Private', access: { write: false } },
                            ],
                        },
                    ],
                })
            }
            if (path.startsWith('indicatorGroupSets')) {
                return json({
                    indicatorGroupSets: [
                        { id: 'igs', displayName: 'IGS', compulsory: false, access: { write: false }, indicatorGroups: [] },
                    ],
                })
            }
            if (path.startsWith('categoryOptionGroupSets')) {
                return json({
                    categoryOptionGroupSets: [
                        { id: 'cogs', displayName: 'COGS', dataDimension: true, access: { write: true }, categoryOptionGroups: [] },
                    ],
                })
            }
            return json({ dataElementGroupSets: [] })
        }
        const sets = await loadGroupSets(fetcher)
        expect(sets.map((s) => [s.id, s.objectType, s.compulsory, s.dataDimension, s.canWrite])).toEqual([
            ['own', 'organisationUnit', true, true, true],
            ['igs', 'indicator', false, false, false],
            ['cogs', 'categoryOption', false, true, true],
        ])
        expect(sets[0].groups).toEqual([
            { id: 'pub', displayName: 'Public', code: 'PUB', canWrite: true },
            { id: 'priv', displayName: 'Private', code: undefined, canWrite: false },
        ])
    })
})

describe('groupIdsFor', () => {
    it('returns unique group ids of the type, in order', () => {
        const sets = [
            { id: 'a', objectType: 'organisationUnit', groups: [{ id: 'g1' }, { id: 'g2' }] },
            { id: 'b', objectType: 'organisationUnit', groups: [{ id: 'g2' }, { id: 'g3' }] },
            { id: 'c', objectType: 'indicator', groups: [{ id: 'g9' }] },
        ] as never
        expect(groupIdsFor(sets, 'organisationUnit')).toEqual(['g1', 'g2', 'g3'])
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- src/data/groupSets`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/data/groupSets.ts`**

```typescript
import { GroupMeta, GroupSetMeta, OBJECT_TYPES, ObjectType } from '@/engine/types'
import { ENDPOINTS } from './endpoints'
import { fetchJson, Fetcher } from './sources/DataSource'

interface GroupRow {
    id: string
    displayName: string
    code?: string
    access: { write: boolean }
}

interface GroupSetRow {
    id: string
    displayName: string
    compulsory?: boolean
    dataDimension?: boolean
    access: { write: boolean }
    [groupsField: string]: unknown
}

async function loadType(fetcher: Fetcher, type: ObjectType): Promise<GroupSetMeta[]> {
    const ep = ENDPOINTS[type]
    const fields = `id,displayName,compulsory,dataDimension,access,${ep.groups}[id,displayName,code,access]`
    const body = await fetchJson<Record<string, GroupSetRow[]>>(
        fetcher,
        `${ep.groupSets}?fields=${fields}&paging=false`
    )
    return body[ep.groupSets].map((row) => {
        const groups = (row[ep.groups] as GroupRow[] | undefined) ?? []
        return {
            id: row.id,
            displayName: row.displayName,
            objectType: type,
            // Indicator sets have no dataDimension and category option sets no
            // compulsory; the API omits unknown fields, so default to false.
            compulsory: row.compulsory === true,
            dataDimension: row.dataDimension === true,
            canWrite: row.access.write === true,
            groups: groups.map(
                (g): GroupMeta => ({
                    id: g.id,
                    displayName: g.displayName,
                    code: g.code,
                    canWrite: g.access.write === true,
                })
            ),
        }
    })
}

export async function loadGroupSets(fetcher: Fetcher): Promise<GroupSetMeta[]> {
    const perType = await Promise.all(OBJECT_TYPES.map((type) => loadType(fetcher, type)))
    return perType.flat()
}

export function groupIdsFor(sets: GroupSetMeta[], type: ObjectType): string[] {
    const seen = new Set<string>()
    const ids: string[] = []
    sets.filter((s) => s.objectType === type).forEach((s) =>
        s.groups.forEach((g) => {
            if (!seen.has(g.id)) {
                seen.add(g.id)
                ids.push(g.id)
            }
        })
    )
    return ids
}
```

Requesting the `compulsory` field on a type whose schema lacks it (category option group sets) is harmless: DHIS2 ignores unknown fields in `fields=`. Verify once on 2.40 during Task 14.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- src/data/groupSets`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/data/groupSets.ts src/data/groupSets.test.ts
git commit -m "Load group sets, groups and access for all object types

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: IndexedDB cache and load orchestration

**Files:**
- Create: `src/data/cache.ts`, `src/data/loadAll.ts`
- Test: `src/data/cache.test.ts`, `src/data/loadAll.test.ts`

**Interfaces:**
- Consumes: `DataSource`, `Progress`, `NamedId` (Task 7); `loadGroupSets`, `groupIdsFor` (Task 8); `EngineClient` (Task 6); payload types (Task 6).
- Produces:
  - `interface CachedType { objects: ObjectsPayload; memberships: MembershipsPayload; names: string[] | null; groupIds: string[]; objectTotal: number; savedAt: number }`
  - `interface Cache { get(type: ObjectType): Promise<CachedType | undefined>; put(type: ObjectType, value: CachedType): Promise<void>; clear(): Promise<void> }`
  - `openCache(serverUrl: string): Cache` (database name `gsi-cache`, store `types`, key `${serverUrl}|${type}`); `createMemoryCache(): Cache` for tests.
  - `type LoadPhase = 'groupSets' | 'objects' | 'memberships' | 'names' | 'evaluate' | 'done'`
  - `interface LoadStatus { phase: LoadPhase; type: ObjectType | null; progress: Progress | null; fromCache: Partial<Record<ObjectType, boolean>>; errors: Partial<Record<ObjectType, string>> }`
  - `loadAll(deps: { source: DataSource; fetcher: Fetcher; cache: Cache; engine: EngineClient; onStatus: (s: LoadStatus) => void; forceRefresh?: boolean }): Promise<{ groupSets: GroupSetMeta[] }>`
  - Cache validity rule: a cached type is reused when the current group id list equals the cached one **and** the object total from `GET <collection>?fields=id&pageSize=1` (`pager.total`) equals `objectTotal`. Otherwise reload that type. `forceRefresh` bypasses the cache.
  - Type independence: a failure in one type is recorded in `errors[type]` and the others continue.

- [ ] **Step 1: Write the failing test `src/data/cache.test.ts`**

```typescript
import { createMemoryCache } from './cache'

describe('memory cache', () => {
    it('stores and returns values per type', async () => {
        const cache = createMemoryCache()
        expect(await cache.get('indicator')).toBeUndefined()
        const value = {
            objects: { objectType: 'indicator', ids: ['i'], names: ['I'], level: null, parentIds: null, domainType: null, categoryIdsOfOption: null },
            memberships: { objectType: 'indicator', groups: [] },
            names: ['I'],
            groupIds: [],
            objectTotal: 1,
            savedAt: 1,
        } as const
        await cache.put('indicator', value)
        expect(await cache.get('indicator')).toEqual(value)
        await cache.clear()
        expect(await cache.get('indicator')).toBeUndefined()
    })
})
```

- [ ] **Step 2: Write `src/data/cache.ts`**

```typescript
import { openDB } from 'idb'
import { MembershipsPayload, ObjectsPayload } from '@/engine/protocol'
import { ObjectType } from '@/engine/types'

export interface CachedType {
    objects: ObjectsPayload
    memberships: MembershipsPayload
    names: string[] | null
    groupIds: string[]
    objectTotal: number
    savedAt: number
}

export interface Cache {
    get(type: ObjectType): Promise<CachedType | undefined>
    put(type: ObjectType, value: CachedType): Promise<void>
    clear(): Promise<void>
}

const DB_NAME = 'gsi-cache'
const STORE = 'types'

export function openCache(serverUrl: string): Cache {
    const db = openDB(DB_NAME, 1, {
        upgrade(database) {
            database.createObjectStore(STORE)
        },
    })
    const key = (type: ObjectType) => `${serverUrl}|${type}`
    return {
        async get(type) {
            try {
                return (await (await db).get(STORE, key(type))) as CachedType | undefined
            } catch {
                return undefined // private mode or blocked storage: behave as empty
            }
        },
        async put(type, value) {
            try {
                await (await db).put(STORE, value, key(type))
            } catch {
                // Storage failures must never break loading.
            }
        },
        async clear() {
            try {
                await (await db).clear(STORE)
            } catch {
                // ignore
            }
        },
    }
}

export function createMemoryCache(): Cache {
    const map = new Map<ObjectType, CachedType>()
    return {
        async get(type) {
            return map.get(type)
        },
        async put(type, value) {
            map.set(type, value)
        },
        async clear() {
            map.clear()
        },
    }
}
```

- [ ] **Step 3: Write the failing test `src/data/loadAll.test.ts`**

```typescript
import { MembershipsPayload, ObjectsPayload } from '@/engine/protocol'
import { EngineStore } from '@/engine/store'
import { createMemoryCache } from './cache'
import { loadAll, LoadStatus } from './loadAll'
import { DataSource } from './sources/DataSource'

/** Engine client that runs the real store synchronously, no worker. */
function inlineEngine() {
    const store = new EngineStore()
    return {
        calls: [] as string[],
        store,
        call<T>(method: string, ...args: unknown[]): Promise<T> {
            this.calls.push(method)
            const fn = (store as unknown as Record<string, (...a: unknown[]) => unknown>)[method]
            return Promise.resolve(fn.apply(store, args) as T)
        },
        terminate() {},
    }
}

const ouObjects: ObjectsPayload = {
    objectType: 'organisationUnit',
    ids: ['r', 'a'],
    names: null,
    level: Uint8Array.from([1, 2]),
    parentIds: [null, 'r'],
    domainType: null,
    categoryIdsOfOption: null,
}
const ouMembers: MembershipsPayload = { objectType: 'organisationUnit', groups: [{ groupId: 'pub', memberIds: ['a'] }] }

function fakeSource(): DataSource & { loads: string[] } {
    const loads: string[] = []
    return {
        kind: 'metadata',
        loads,
        async loadObjects(type) {
            loads.push(`objects:${type}`)
            if (type === 'organisationUnit') {
                return ouObjects
            }
            return { objectType: type, ids: [], names: [], level: null, parentIds: null, domainType: null, categoryIdsOfOption: null }
        },
        async loadNames(type) {
            loads.push(`names:${type}`)
            return [{ id: 'a', displayName: 'A' }, { id: 'r', displayName: 'Root' }]
        },
        async loadMemberships(type) {
            loads.push(`memberships:${type}`)
            return type === 'organisationUnit' ? ouMembers : { objectType: type, groups: [] }
        },
    }
}

const groupSetsBody = {
    organisationUnitGroupSets: [
        {
            id: 'own', displayName: 'Ownership', compulsory: true, dataDimension: true, access: { write: true },
            organisationUnitGroups: [{ id: 'pub', displayName: 'Public', access: { write: true } }],
        },
    ],
    dataElementGroupSets: [],
    // An indicator set with a group is needed so the indicator type is actually
    // loaded; types without group sets are skipped before any request is made.
    indicatorGroupSets: [
        { id: 'igs', displayName: 'IGS', compulsory: false, access: { write: false }, indicatorGroups: [{ id: 'ig1', displayName: 'IG1', access: { write: false } }] },
    ],
    categoryOptionGroupSets: [],
}

const fetcher = async (path: string) => {
    if (path.includes('GroupSets?')) {
        return new Response(JSON.stringify(groupSetsBody), { status: 200 })
    }
    // object totals: organisationUnits has 2, everything else 0
    const total = path.startsWith('organisationUnits') ? 2 : 0
    return new Response(JSON.stringify({ pager: { total } }), { status: 200 })
}

describe('loadAll', () => {
    it('loads from the source, evaluates, realigns names and fills the cache', async () => {
        const source = fakeSource()
        const cache = createMemoryCache()
        const engine = inlineEngine()
        const statuses: LoadStatus[] = []
        const { groupSets } = await loadAll({ source, fetcher, cache, engine, onStatus: (s) => statuses.push(s) })

        expect(groupSets.map((s) => s.id)).toEqual(['own'])
        expect(source.loads).toContain('objects:organisationUnit')
        expect(source.loads).toContain('names:organisationUnit')
        expect(engine.calls).toContain('evaluate')
        expect(engine.store.resolve('organisationUnit', [0, 1]).map((r) => r.displayName)).toEqual(['Root', 'A'])
        expect((await cache.get('organisationUnit'))?.names).toEqual(['Root', 'A'])
        expect(statuses[statuses.length - 1].phase).toBe('done')
    })

    it('reuses the cache when group ids and totals match', async () => {
        const source = fakeSource()
        const cache = createMemoryCache()
        await loadAll({ source, fetcher, cache, engine: inlineEngine(), onStatus: () => undefined })
        const second = fakeSource()
        const status: LoadStatus[] = []
        await loadAll({ source: second, fetcher, cache, engine: inlineEngine(), onStatus: (s) => status.push(s) })
        expect(second.loads.filter((l) => l.endsWith('organisationUnit'))).toEqual([])
        expect(status[status.length - 1].fromCache.organisationUnit).toBe(true)
        // The indicator type has a group set too, so it is loaded, not skipped.
        expect(second.loads).toContain('objects:indicator')
    })

    it('records an error for a failing type and still loads the others', async () => {
        const source = fakeSource()
        source.loadObjects = async (type) => {
            if (type === 'indicator') {
                throw new Error('nope')
            }
            return type === 'organisationUnit' ? ouObjects : { objectType: type, ids: [], names: [], level: null, parentIds: null, domainType: null, categoryIdsOfOption: null }
        }
        const status: LoadStatus[] = []
        await loadAll({ source, fetcher, cache: createMemoryCache(), engine: inlineEngine(), onStatus: (s) => status.push(s) })
        const last = status[status.length - 1]
        expect(last.errors.indicator).toBe('nope')
        expect(last.errors.organisationUnit).toBeUndefined()
    })
})
```

- [ ] **Step 4: Write `src/data/loadAll.ts`**

```typescript
import { EngineClient } from '@/engine/client'
import { GroupSetMeta, OBJECT_TYPES, ObjectType } from '@/engine/types'
import { Cache, CachedType } from './cache'
import { ENDPOINTS } from './endpoints'
import { groupIdsFor, loadGroupSets } from './groupSets'
import { DataSource, fetchJson, Fetcher, NamedId, Progress } from './sources/DataSource'

export type LoadPhase = 'groupSets' | 'objects' | 'memberships' | 'names' | 'evaluate' | 'done'

export interface LoadStatus {
    phase: LoadPhase
    type: ObjectType | null
    progress: Progress | null
    fromCache: Partial<Record<ObjectType, boolean>>
    errors: Partial<Record<ObjectType, string>>
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

async function objectTotal(fetcher: Fetcher, type: ObjectType): Promise<number> {
    const body = await fetchJson<{ pager: { total: number } }>(
        fetcher,
        `${ENDPOINTS[type].collection}?fields=id&pageSize=1`
    )
    return body.pager.total
}

/** Names come back keyed by id; align them to the payload's id order. */
export function alignNames(ids: string[], named: NamedId[]): string[] {
    const byId = new Map(named.map((n) => [n.id, n.displayName]))
    return ids.map((id) => byId.get(id) ?? id)
}

export async function loadAll(deps: Deps): Promise<{ groupSets: GroupSetMeta[] }> {
    const status: LoadStatus = { phase: 'groupSets', type: null, progress: null, fromCache: {}, errors: {} }
    const emit = (patch: Partial<LoadStatus>) => {
        Object.assign(status, patch)
        deps.onStatus({ ...status, fromCache: { ...status.fromCache }, errors: { ...status.errors } })
    }

    emit({ phase: 'groupSets' })
    const groupSets = await loadGroupSets(deps.fetcher)
    await deps.engine.call('setGroupSets', groupSets)

    // Org units are the heavy type; load them first so the dashboard can show
    // their numbers while the small types finish.
    for (const type of OBJECT_TYPES) {
        const groupIds = groupIdsFor(groupSets, type)
        if (groupIds.length === 0) {
            continue // no group sets of this type: nothing to evaluate
        }
        try {
            const reused = deps.forceRefresh ? undefined : await tryCache(deps, type, groupIds)
            if (reused) {
                await deps.engine.call('loadObjects', reused.objects)
                await deps.engine.call('loadMemberships', reused.memberships)
                if (reused.names) {
                    await deps.engine.call('setNames', type, reused.names)
                }
                status.fromCache[type] = true
                emit({ type })
                continue
            }

            emit({ phase: 'objects', type, progress: null })
            const objects = await deps.source.loadObjects(type, (p) => emit({ phase: 'objects', type, progress: p }))
            await deps.engine.call('loadObjects', objects)

            emit({ phase: 'memberships', type, progress: null })
            const memberships = await deps.source.loadMemberships(type, groupIds, (p) =>
                emit({ phase: 'memberships', type, progress: p })
            )
            await deps.engine.call('loadMemberships', memberships)
            emit({ phase: 'evaluate', type })
            await deps.engine.call('evaluate')

            let names = objects.names
            if (!names) {
                emit({ phase: 'names', type, progress: null })
                names = alignNames(objects.ids, await deps.source.loadNames(type))
                await deps.engine.call('setNames', type, names)
            }

            const total = await objectTotal(deps.fetcher, type).catch(() => objects.ids.length)
            const entry: CachedType = { objects, memberships, names, groupIds, objectTotal: total, savedAt: Date.now() }
            await deps.cache.put(type, entry)
        } catch (error) {
            status.errors[type] = error instanceof Error ? error.message : String(error)
            emit({ type })
        }
    }

    emit({ phase: 'evaluate', type: null, progress: null })
    await deps.engine.call('evaluate')
    emit({ phase: 'done', type: null, progress: null })
    return { groupSets }
}

async function tryCache(deps: Deps, type: ObjectType, groupIds: string[]): Promise<CachedType | undefined> {
    const cached = await deps.cache.get(type)
    if (!cached || !sameIds(cached.groupIds, groupIds)) {
        return undefined
    }
    const total = await objectTotal(deps.fetcher, type).catch(() => -1)
    return total === cached.objectTotal ? cached : undefined
}
```

- [ ] **Step 5: Run the tests, types and lint**

```bash
pnpm test -- src/data
pnpm exec tsc --noEmit
pnpm exec eslint src
```

Expected: PASS (14 tests in `src/data`). If Jest complains about `Response` being undefined under jsdom, add `import 'whatwg-fetch'` to `jest.setup.js` after installing it with `pnpm add -D whatwg-fetch`.

- [ ] **Step 6: Commit**

```bash
git add src/data
git commit -m "Add IndexedDB cache and load orchestration with per-type errors

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Fetcher, engine provider and user scope hooks

**Files:**
- Create: `src/data/fetcher.ts`, `src/hooks/useEngine.tsx`, `src/hooks/useUserScope.ts`
- Test: `src/data/fetcher.test.ts`, `src/hooks/useEngine.test.tsx`

**Interfaces:**
- Consumes: `EngineClient`, `createEngineWorker` (Task 6); `loadAll`, `LoadStatus` (Task 9); `selectSource` (Task 7); `openCache` (Task 9); `useApiDataQuery` (Task 1).
- Produces:
  - `createFetcher(baseUrl: string, apiVersion: number): Fetcher` — requests `${baseUrl}/api/${apiVersion}/${path}` with `credentials: 'include'` and `Accept: application/json` unless the path ends in `.csv`.
  - `EngineProvider` (React context) and `useEngine(): { client: EngineClient; status: LoadStatus | null; groupSets: GroupSetMeta[]; sourceKind: 'sqlView' | 'metadata' | null; reload(force: boolean): Promise<void>; error: string | null }`. Loading starts on mount.
  - `useUserScope(): { isLoading: boolean; roots: { id: string; displayName: string; level: number }[]; authorities: Set<string>; hasAuthority(a: string): boolean }` from `me?fields=organisationUnits[id,displayName,level],authorities`; `hasAuthority` returns true when the set contains `ALL`.

- [ ] **Step 1: Write the failing test `src/data/fetcher.test.ts`**

```typescript
import { createFetcher } from './fetcher'

describe('createFetcher', () => {
    it('builds versioned API urls and sends cookies', async () => {
        const spy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
        const fetcher = createFetcher('https://play.example/dhis', 41)
        await fetcher('organisationUnits?fields=id')
        expect(spy).toHaveBeenCalledWith(
            'https://play.example/dhis/api/41/organisationUnits?fields=id',
            expect.objectContaining({ credentials: 'include', headers: { Accept: 'application/json' } })
        )
        await fetcher('sqlViews/x/data.csv?paging=false')
        expect(spy).toHaveBeenLastCalledWith(
            'https://play.example/dhis/api/41/sqlViews/x/data.csv?paging=false',
            expect.objectContaining({ headers: { Accept: 'text/csv' } })
        )
        spy.mockRestore()
    })
})
```

- [ ] **Step 2: Write `src/data/fetcher.ts`**

```typescript
import { Fetcher } from './sources/DataSource'

export function createFetcher(baseUrl: string, apiVersion: number): Fetcher {
    const root = baseUrl.replace(/\/$/, '')
    return (path, init) => {
        const isCsv = /\.csv(\?|$)/.test(path)
        return fetch(`${root}/api/${apiVersion}/${path}`, {
            credentials: 'include',
            ...init,
            headers: { Accept: isCsv ? 'text/csv' : 'application/json', ...(init?.headers ?? {}) },
        })
    }
}
```

- [ ] **Step 3: Write `src/hooks/useUserScope.ts`**

```typescript
import { useMemo } from 'react'
import { useApiDataQuery } from '@/utils/useApiDataQuery'

interface Me {
    organisationUnits: { id: string; displayName: string; level: number }[]
    authorities: string[]
}

export function useUserScope() {
    const { data, isLoading } = useApiDataQuery<Me>({
        queryKey: ['me', 'scope'],
        query: {
            resource: 'me',
            params: { fields: 'organisationUnits[id,displayName,level],authorities' },
        },
        staleTime: Infinity,
    })
    const authorities = useMemo(() => new Set(data?.authorities ?? []), [data])
    return {
        isLoading,
        roots: data?.organisationUnits ?? [],
        authorities,
        hasAuthority: (authority: string) => authorities.has('ALL') || authorities.has(authority),
    }
}
```

- [ ] **Step 4: Write the failing test `src/hooks/useEngine.test.tsx`**

```tsx
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { EngineProvider, useEngine } from './useEngine'

jest.mock('@dhis2/app-runtime', () => ({
    useConfig: () => ({ baseUrl: 'http://localhost:8080', apiVersion: 41 }),
}))

const loadAll = jest.fn(async ({ onStatus }) => {
    onStatus({ phase: 'done', type: null, progress: null, fromCache: {}, errors: {} })
    return { groupSets: [{ id: 's1' }] }
})
jest.mock('@/data/loadAll', () => ({ loadAll: (deps: unknown) => loadAll(deps) }))
jest.mock('@/data/sources/selectSource', () => ({
    selectSource: async () => ({ source: { kind: 'metadata' }, sqlViews: null }),
}))
jest.mock('@/data/cache', () => ({ openCache: () => ({ get: async () => undefined, put: async () => undefined, clear: async () => undefined }) }))
jest.mock('@/engine/client', () => ({
    EngineClient: class { call = jest.fn(); terminate = jest.fn() },
    createEngineWorker: () => ({}),
}))

const Probe = () => {
    const { status, groupSets, sourceKind } = useEngine()
    return (
        <div>
            <span>{status?.phase ?? 'none'}</span>
            <span>{groupSets.length}</span>
            <span>{sourceKind ?? 'unknown'}</span>
        </div>
    )
}

it('loads on mount and exposes status, group sets and source kind', async () => {
    render(
        <EngineProvider>
            <Probe />
        </EngineProvider>
    )
    await waitFor(() => expect(screen.getByText('done')).toBeInTheDocument())
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('metadata')).toBeInTheDocument()
    expect(loadAll).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 5: Write `src/hooks/useEngine.tsx`**

```tsx
import { useConfig } from '@dhis2/app-runtime'
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { openCache } from '@/data/cache'
import { createFetcher } from '@/data/fetcher'
import { loadAll, LoadStatus } from '@/data/loadAll'
import { selectSource } from '@/data/sources/selectSource'
import { createEngineWorker, EngineClient } from '@/engine/client'
import { GroupSetMeta } from '@/engine/types'

interface EngineContextValue {
    client: EngineClient
    status: LoadStatus | null
    groupSets: GroupSetMeta[]
    sourceKind: 'sqlView' | 'metadata' | null
    error: string | null
    reload: (force: boolean) => Promise<void>
}

const EngineContext = createContext<EngineContextValue | null>(null)

export const EngineProvider = ({ children }: { children: React.ReactNode }) => {
    const { baseUrl, apiVersion } = useConfig()
    const clientRef = useRef<EngineClient | null>(null)
    if (clientRef.current === null) {
        clientRef.current = new EngineClient(createEngineWorker())
    }
    const [status, setStatus] = useState<LoadStatus | null>(null)
    const [groupSets, setGroupSets] = useState<GroupSetMeta[]>([])
    const [sourceKind, setSourceKind] = useState<'sqlView' | 'metadata' | null>(null)
    const [error, setError] = useState<string | null>(null)

    const reload = useCallback(
        async (force: boolean) => {
            const client = clientRef.current as EngineClient
            setError(null)
            try {
                const fetcher = createFetcher(baseUrl, apiVersion)
                const { source } = await selectSource(fetcher)
                setSourceKind(source.kind)
                if (force) {
                    await client.call('reset')
                }
                const result = await loadAll({
                    source,
                    fetcher,
                    cache: openCache(baseUrl),
                    engine: client,
                    onStatus: setStatus,
                    forceRefresh: force,
                })
                setGroupSets(result.groupSets)
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e))
            }
        },
        [baseUrl, apiVersion]
    )

    useEffect(() => {
        void reload(false)
    }, [reload])

    // Terminate the worker only when the provider unmounts, not when reload changes identity.
    useEffect(() => () => clientRef.current?.terminate(), [])

    const value = useMemo<EngineContextValue>(
        () => ({ client: clientRef.current as EngineClient, status, groupSets, sourceKind, error, reload }),
        [status, groupSets, sourceKind, error, reload]
    )
    return <EngineContext.Provider value={value}>{children}</EngineContext.Provider>
}

export function useEngine(): EngineContextValue {
    const ctx = useContext(EngineContext)
    if (!ctx) {
        throw new Error('useEngine must be used inside EngineProvider')
    }
    return ctx
}
```

- [ ] **Step 6: Run the tests, types and lint**

```bash
pnpm test -- src/hooks src/data/fetcher
pnpm exec tsc --noEmit
pnpm exec eslint src
```

Expected: PASS. If `createEngineWorker`'s `import.meta.url` breaks Jest parsing even with the mock in place (mocks are hoisted but the module still gets parsed when imported by `useEngine`), move `createEngineWorker` to `src/engine/createWorker.ts` and mock that path instead.

- [ ] **Step 7: Commit**

```bash
git add src/data/fetcher.ts src/data/fetcher.test.ts src/hooks
git commit -m "Add fetcher, engine provider and user scope hooks

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: App shell, scope selector, load progress and dashboard

**Files:**
- Create: `src/components/LoadProgress/LoadProgress.tsx`, `src/components/ScopeSelector/ScopeSelector.tsx`, `src/components/GroupSetCard/GroupSetCard.tsx`, `src/components/GroupSetCard/GroupSetCard.module.css`, `src/pages/Dashboard/Dashboard.tsx`, `src/pages/Dashboard/Dashboard.module.css`, `src/hooks/useScope.tsx`
- Modify: `src/App.tsx`
- Test: `src/components/GroupSetCard/GroupSetCard.test.tsx`, `src/pages/Dashboard/Dashboard.test.tsx`

**Interfaces:**
- Consumes: `useEngine` (Task 10), `useUserScope` (Task 10), `DashboardEntry`, `ScopeRef` (Task 6), `Status` (Task 2).
- Produces:
  - `ScopeProvider` / `useScope(): { rootId: string | null; rootName: string; setRoot(id: string, name: string): void; isReady: boolean }` — defaults to the first user root once `useUserScope` resolves; persisted in `sessionStorage` key `gsi.scope`.
  - `<LoadProgress status={LoadStatus | null} />` renders a `LinearLoader` with phase text, or nothing when phase is `done`.
  - `<ScopeSelector />` shows current root name and a "Change" button opening a `Modal` with `@dhis2/ui` `OrganisationUnitTree` rooted at the user's roots.
  - `<GroupSetCard entry={DashboardEntry} onOpen={() => void} />`.
  - Route `/` renders `Dashboard`; route `/sets/:setId` is added in Task 12.
  - Dashboard calls `client.call<DashboardEntry[]>('dashboard', { objectType, rootId })` for each of the four types whenever `status.phase` changes or the scope changes, and renders sections per type with the "only sets with issues" checkbox (default on) and a type filter.

- [ ] **Step 1: Write `src/hooks/useScope.tsx`**

```tsx
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useUserScope } from './useUserScope'

interface ScopeValue {
    rootId: string | null
    rootName: string
    setRoot: (id: string, name: string) => void
    isReady: boolean
}

const ScopeContext = createContext<ScopeValue | null>(null)
const KEY = 'gsi.scope'

export const ScopeProvider = ({ children }: { children: React.ReactNode }) => {
    const { roots, isLoading } = useUserScope()
    const [root, setRootState] = useState<{ id: string; name: string } | null>(() => {
        try {
            const raw = sessionStorage.getItem(KEY)
            return raw ? (JSON.parse(raw) as { id: string; name: string }) : null
        } catch {
            return null
        }
    })

    useEffect(() => {
        if (root === null && roots.length > 0) {
            setRootState({ id: roots[0].id, name: roots[0].displayName })
        }
    }, [root, roots])

    const setRoot = useCallback((id: string, name: string) => {
        setRootState({ id, name })
        try {
            sessionStorage.setItem(KEY, JSON.stringify({ id, name }))
        } catch {
            // ignore storage failures
        }
    }, [])

    const value = useMemo<ScopeValue>(
        () => ({ rootId: root?.id ?? null, rootName: root?.name ?? '', setRoot, isReady: !isLoading && root !== null }),
        [root, setRoot, isLoading]
    )
    return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>
}

export function useScope(): ScopeValue {
    const ctx = useContext(ScopeContext)
    if (!ctx) {
        throw new Error('useScope must be used inside ScopeProvider')
    }
    return ctx
}
```

- [ ] **Step 2: Write `src/components/LoadProgress/LoadProgress.tsx`**

```tsx
import i18n from '@dhis2/d2-i18n'
import { LinearLoader, NoticeBox } from '@dhis2/ui'
import React from 'react'
import { LoadStatus } from '@/data/loadAll'

const PHASE_LABEL: Record<LoadStatus['phase'], string> = {
    groupSets: i18n.t('Loading group sets'),
    objects: i18n.t('Loading objects'),
    memberships: i18n.t('Loading group memberships'),
    names: i18n.t('Loading names'),
    evaluate: i18n.t('Checking rules'),
    done: i18n.t('Done'),
}

export const LoadProgress = ({ status }: { status: LoadStatus | null }) => {
    if (!status) {
        return <LinearLoader amount={0} />
    }
    const errors = Object.entries(status.errors)
    if (status.phase === 'done') {
        return errors.length === 0 ? null : (
            <NoticeBox error title={i18n.t('Some data could not be loaded')}>
                {errors.map(([type, message]) => (
                    <div key={type}>
                        {type}: {message}
                    </div>
                ))}
            </NoticeBox>
        )
    }
    const p = status.progress
    const amount = p && p.total ? Math.round((100 * p.done) / p.total) : 0
    const detail = p ? ` (${p.label} ${p.total ? `${p.done}/${p.total}` : ''})` : ''
    return (
        <div>
            <LinearLoader amount={amount} />
            <small>
                {PHASE_LABEL[status.phase]}
                {status.type ? `: ${status.type}` : ''}
                {detail}
            </small>
        </div>
    )
}
```

- [ ] **Step 3: Write `src/components/ScopeSelector/ScopeSelector.tsx`**

```tsx
import i18n from '@dhis2/d2-i18n'
import { Button, Modal, ModalActions, ModalContent, ModalTitle, OrganisationUnitTree } from '@dhis2/ui'
import React, { useState } from 'react'
import { useScope } from '@/hooks/useScope'
import { useUserScope } from '@/hooks/useUserScope'

export const ScopeSelector = () => {
    const { rootName, setRoot } = useScope()
    const { roots } = useUserScope()
    const [open, setOpen] = useState(false)

    return (
        <div>
            <span>{i18n.t('Scope')}: </span>
            <strong>{rootName}</strong>{' '}
            <Button small onClick={() => setOpen(true)}>
                {i18n.t('Change')}
            </Button>
            {open && (
                <Modal onClose={() => setOpen(false)} position="middle">
                    <ModalTitle>{i18n.t('Choose the organisation unit to work in')}</ModalTitle>
                    <ModalContent>
                        <OrganisationUnitTree
                            roots={roots.map((r) => r.id)}
                            singleSelection
                            onChange={({ id, displayName }) => {
                                setRoot(id, displayName)
                                setOpen(false)
                            }}
                        />
                    </ModalContent>
                    <ModalActions>
                        <Button onClick={() => setOpen(false)}>{i18n.t('Cancel')}</Button>
                    </ModalActions>
                </Modal>
            )}
        </div>
    )
}
```

Check the exact `OrganisationUnitTree` props in `node_modules/@dhis2/ui/` (the `onChange` payload shape and whether `singleSelection` exists in the installed version) before relying on this snippet.

- [ ] **Step 4: Write the failing test `src/components/GroupSetCard/GroupSetCard.test.tsx`**

```tsx
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { GroupSetCard } from './GroupSetCard'

const entry = {
    set: {
        id: 'own', displayName: 'Ownership', objectType: 'organisationUnit' as const,
        compulsory: true, dataDimension: true, canWrite: true,
        groups: [{ id: 'a', displayName: 'A', canWrite: true }, { id: 'b', displayName: 'B', canWrite: false }],
    },
    summary: { population: 100, ok: 80, missingError: 12, missingWarning: 0, conflict: 8 },
    hasData: true,
}

it('shows name, properties, counts and a lock when some groups are read-only', async () => {
    const onOpen = jest.fn()
    render(<GroupSetCard entry={entry} onOpen={onOpen} />)
    expect(screen.getByText('Ownership')).toBeInTheDocument()
    expect(screen.getByText('Compulsory')).toBeInTheDocument()
    expect(screen.getByText('Data dimension')).toBeInTheDocument()
    expect(screen.getByText('8')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText(/1 group read-only/)).toBeInTheDocument()
    await userEvent.click(screen.getByText('Ownership'))
    expect(onOpen).toHaveBeenCalled()
})

it('shows a loading state when the type has no data yet', () => {
    render(<GroupSetCard entry={{ ...entry, hasData: false }} onOpen={() => undefined} />)
    expect(screen.getByText(/Loading/)).toBeInTheDocument()
})
```

- [ ] **Step 5: Write `src/components/GroupSetCard/GroupSetCard.tsx` and its CSS module**

```tsx
import i18n from '@dhis2/d2-i18n'
import { Card, Tag } from '@dhis2/ui'
import React from 'react'
import { DashboardEntry } from '@/engine/store'
import styles from './GroupSetCard.module.css'

interface Props {
    entry: DashboardEntry
    onOpen: () => void
}

export const GroupSetCard = ({ entry, onOpen }: Props) => {
    const { set, summary, hasData } = entry
    const readOnlyGroups = set.groups.filter((g) => !g.canWrite).length
    return (
        <Card>
            <div className={styles.card} role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
                <div className={styles.name}>{set.displayName}</div>
                <div className={styles.badges}>
                    {set.compulsory && <Tag positive>{i18n.t('Compulsory')}</Tag>}
                    {set.dataDimension && <Tag positive>{i18n.t('Data dimension')}</Tag>}
                    <Tag neutral>{i18n.t('{{count}} groups', { count: set.groups.length, defaultValue_plural: '{{count}} groups' })}</Tag>
                </div>
                {hasData ? (
                    <div className={styles.stats}>
                        <div className={styles.error}>
                            <div className={styles.value}>{summary.conflict}</div>
                            <div className={styles.label}>{i18n.t('Conflicts')}</div>
                        </div>
                        <div className={summary.missingError > 0 ? styles.error : styles.warning}>
                            <div className={styles.value}>{summary.missingError + summary.missingWarning}</div>
                            <div className={styles.label}>{i18n.t('Missing')}</div>
                        </div>
                        <div className={styles.ok}>
                            <div className={styles.value}>{summary.ok}</div>
                            <div className={styles.label}>{i18n.t('OK')}</div>
                        </div>
                    </div>
                ) : (
                    <div className={styles.meta}>{i18n.t('Loading…')}</div>
                )}
                <div className={styles.meta}>
                    {readOnlyGroups > 0
                        ? i18n.t('{{count}} group read-only for you', { count: readOnlyGroups, defaultValue_plural: '{{count}} groups read-only for you' })
                        : i18n.t('You can edit all groups')}
                </div>
            </div>
        </Card>
    )
}
```

`GroupSetCard.module.css`:

```css
.card { padding: var(--spacers-dp16); cursor: pointer; display: flex; flex-direction: column; gap: var(--spacers-dp8); }
.name { font-size: 15px; font-weight: 500; color: var(--colors-grey900); }
.badges { display: flex; gap: var(--spacers-dp4); flex-wrap: wrap; }
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--spacers-dp8); font-variant-numeric: tabular-nums; }
.value { font-size: 20px; font-weight: 500; line-height: 1.1; }
.label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--colors-grey600); }
.error { border-left: 3px solid var(--colors-red600); padding-left: var(--spacers-dp8); }
.error .value { color: var(--colors-red600); }
.warning { border-left: 3px solid var(--colors-yellow700); padding-left: var(--spacers-dp8); }
.warning .value { color: var(--colors-yellow700); }
.ok { border-left: 3px solid var(--colors-green700); padding-left: var(--spacers-dp8); }
.ok .value { color: var(--colors-green700); }
.meta { font-size: 12px; color: var(--colors-grey600); }
```

- [ ] **Step 6: Write the failing test `src/pages/Dashboard/Dashboard.test.tsx`**

```tsx
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Dashboard } from './Dashboard'

const entries = {
    organisationUnit: [
        {
            set: { id: 'own', displayName: 'Ownership', objectType: 'organisationUnit', compulsory: true, dataDimension: true, canWrite: true, groups: [] },
            summary: { population: 5, ok: 4, missingError: 1, missingWarning: 0, conflict: 0 },
            hasData: true,
        },
        {
            set: { id: 'clean', displayName: 'Clean set', objectType: 'organisationUnit', compulsory: false, dataDimension: false, canWrite: true, groups: [] },
            summary: { population: 5, ok: 5, missingError: 0, missingWarning: 0, conflict: 0 },
            hasData: true,
        },
    ],
    dataElement: [],
    indicator: [],
    categoryOption: [],
}

jest.mock('@/hooks/useEngine', () => ({
    useEngine: () => ({
        client: { call: async (_m: string, scope: { objectType: keyof typeof entries }) => entries[scope.objectType] },
        status: { phase: 'done', type: null, progress: null, fromCache: {}, errors: {} },
        groupSets: [],
        sourceKind: 'metadata',
        error: null,
        reload: async () => undefined,
    }),
}))
jest.mock('@/hooks/useScope', () => ({ useScope: () => ({ rootId: 'root', rootName: 'Root', setRoot: () => undefined, isReady: true }) }))
jest.mock('@/components/ScopeSelector/ScopeSelector', () => ({ ScopeSelector: () => <div>scope</div> }))

it('lists sets with issues and hides clean ones by default', async () => {
    render(
        <MemoryRouter>
            <Dashboard />
        </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByText('Ownership')).toBeInTheDocument())
    expect(screen.queryByText('Clean set')).not.toBeInTheDocument()
    expect(screen.getByText(/1 .*without issues/)).toBeInTheDocument()
})
```

- [ ] **Step 7: Write `src/pages/Dashboard/Dashboard.tsx` and CSS**

```tsx
import i18n from '@dhis2/d2-i18n'
import { Checkbox, NoticeBox } from '@dhis2/ui'
import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { GroupSetCard } from '@/components/GroupSetCard/GroupSetCard'
import { LoadProgress } from '@/components/LoadProgress/LoadProgress'
import { ScopeSelector } from '@/components/ScopeSelector/ScopeSelector'
import { DashboardEntry } from '@/engine/store'
import { OBJECT_TYPES, ObjectType } from '@/engine/types'
import { useEngine } from '@/hooks/useEngine'
import { useScope } from '@/hooks/useScope'
import styles from './Dashboard.module.css'

const TYPE_LABEL: Record<ObjectType, string> = {
    organisationUnit: i18n.t('Organisation unit group sets'),
    dataElement: i18n.t('Data element group sets'),
    indicator: i18n.t('Indicator group sets'),
    categoryOption: i18n.t('Category option group sets'),
}

const hasIssues = (e: DashboardEntry) =>
    e.summary.conflict + e.summary.missingError + e.summary.missingWarning > 0

export const Dashboard = () => {
    const { client, status, error } = useEngine()
    const { rootId, isReady } = useScope()
    const navigate = useNavigate()
    const [onlyIssues, setOnlyIssues] = useState(true)
    const [entries, setEntries] = useState<Partial<Record<ObjectType, DashboardEntry[]>>>({})

    useEffect(() => {
        if (!isReady) {
            return
        }
        let cancelled = false
        Promise.all(
            OBJECT_TYPES.map((objectType) =>
                client.call<DashboardEntry[]>('dashboard', {
                    objectType,
                    rootId: objectType === 'organisationUnit' ? rootId : null,
                })
            )
        ).then((results) => {
            if (!cancelled) {
                setEntries(Object.fromEntries(OBJECT_TYPES.map((t, i) => [t, results[i]])))
            }
        })
        return () => {
            cancelled = true
        }
    }, [client, rootId, isReady, status?.phase, status?.type])

    return (
        <div className={styles.page}>
            <div className={styles.toolbar}>
                <ScopeSelector />
                <Checkbox
                    checked={onlyIssues}
                    label={i18n.t('Only sets with issues')}
                    onChange={({ checked }) => setOnlyIssues(checked)}
                />
            </div>
            {error && <NoticeBox error title={i18n.t('Loading failed')}>{error}</NoticeBox>}
            <LoadProgress status={status} />
            {OBJECT_TYPES.map((type) => {
                const all = entries[type] ?? []
                const shown = onlyIssues ? all.filter((e) => hasIssues(e) || !e.hasData) : all
                const hidden = all.length - shown.length
                if (all.length === 0) {
                    return null
                }
                return (
                    <section key={type}>
                        <h2 className={styles.heading}>{TYPE_LABEL[type]}</h2>
                        <div className={styles.cards}>
                            {shown.map((entry) => (
                                <GroupSetCard key={entry.set.id} entry={entry} onOpen={() => navigate(`/sets/${entry.set.id}`)} />
                            ))}
                        </div>
                        {hidden > 0 && (
                            <p className={styles.note}>
                                {i18n.t('{{count}} set without issues hidden', { count: hidden, defaultValue_plural: '{{count}} sets without issues hidden' })}
                            </p>
                        )}
                    </section>
                )
            })}
        </div>
    )
}
```

`Dashboard.module.css`:

```css
.page { padding: var(--spacers-dp16); display: flex; flex-direction: column; gap: var(--spacers-dp16); }
.toolbar { display: flex; gap: var(--spacers-dp16); align-items: center; flex-wrap: wrap; }
.heading { font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--colors-grey600); font-weight: 500; margin: var(--spacers-dp8) 0; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: var(--spacers-dp12); }
.note { font-size: 12px; color: var(--colors-grey600); }
```

- [ ] **Step 8: Wire providers and routes in `src/App.tsx`**

Replace the router and providers:

```tsx
import React from 'react'
import { createHashRouter, RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CssReset, CssVariables } from '@dhis2/ui'
import { EngineProvider } from '@/hooks/useEngine'
import { ScopeProvider } from '@/hooks/useScope'
import { Dashboard } from '@/pages/Dashboard/Dashboard'
import { SyncUrlWithGlobalShell } from '@/utils/SyncUrlWithGlobalShell'

const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
})

const router = createHashRouter([
    {
        element: <SyncUrlWithGlobalShell />,
        children: [{ path: '/', element: <Dashboard /> }],
    },
])

const App = () => (
    <QueryClientProvider client={queryClient}>
        <CssReset />
        <CssVariables theme spacers colors elevations />
        <ScopeProvider>
            <EngineProvider>
                <RouterProvider router={router} />
            </EngineProvider>
        </ScopeProvider>
    </QueryClientProvider>
)

export default App
```

Update `src/App.test.tsx` to mock `@/hooks/useEngine` and `@/hooks/useScope` the same way as the Dashboard test, and assert the "Only sets with issues" checkbox renders.

- [ ] **Step 9: Run tests, types, lint, and start the app against a Sierra Leone instance**

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm exec eslint src
```

Then create (or reuse) a Sierra Leone instance through the broker, for example `agent-gsi-sl43` with `version: "43"` and the `dhis2-db-sierra-leone_v43.sql.gz` seed, and start the dev server in the background:

```bash
pnpm start --port "$SANDBOX_HOST_PORT" --proxy http://dhis2-agent-gsi-sl43:8080
```

Open `http://localhost:$SANDBOX_HOST_PORT`, log in as `admin` / `district`, and confirm: progress bar, then cards for the Sierra Leone org unit group sets (Facility Type, Facility Ownership, Location Rural/Urban, Area) and data element / indicator sets, with plausible counts. Use Playwright (webapp-testing skill) to take a screenshot for the task record.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "Add dashboard with scope selector, load progress and group set cards

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Group set detail page with the summary matrix

**Files:**
- Create: `src/pages/GroupSetDetail/GroupSetDetail.tsx`, `src/pages/GroupSetDetail/GroupSetDetail.module.css`, `src/pages/GroupSetDetail/OverviewTab.tsx`, `src/components/SummaryMatrix/SummaryMatrix.tsx`, `src/components/SummaryMatrix/SummaryMatrix.module.css`, `src/hooks/useEngineQuery.ts`
- Modify: `src/App.tsx` (add route `/sets/:setId`)
- Test: `src/components/SummaryMatrix/SummaryMatrix.test.tsx`, `src/hooks/useEngineQuery.test.tsx`

**Interfaces:**
- Consumes: `useEngine` (Task 10), `useScope` (Task 11), `MatrixResult`, `ScopeRef` (Task 6).
- Produces:
  - `useEngineQuery<T>(method: EngineMethod, args: unknown[], enabled = true): { data: T | undefined; isLoading: boolean; error: string | null }` — re-runs when `args` (JSON-compared) or the engine `status.phase`/`status.type` change.
  - `<SummaryMatrix result={MatrixResult} onCell={(row: ObjectRef | null, column: MatrixColumn) => void} />` where `type MatrixColumn = { kind: 'group'; index: number } | { kind: 'missing' } | { kind: 'conflict' } | { kind: 'total' }`.
  - `GroupSetDetail` reads `:setId`, finds the set in `groupSets`, shows header (name, property tags, group names, scope), a `TabBar` with Overview and Objects (Objects tab filled in Task 13; Integrity tab is Plan 3), and a "Back to dashboard" link. It holds the shared `objectsFilter` state so a matrix cell click switches to the Objects tab with `{ ancestor, group | statuses }` applied.
  - Row level selector: levels from `scopeLevel + 1` to the deepest level present; default `scopeLevel + 1`. The org unit levels list comes from `organisationUnitLevels?fields=level,displayName&paging=false` via `useApiDataQuery`; for flat types the selector is hidden.

- [ ] **Step 1: Write the failing test `src/hooks/useEngineQuery.test.tsx`**

```tsx
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { useEngineQuery } from './useEngineQuery'

const call = jest.fn(async (_m: string, ...args: unknown[]) => `result:${JSON.stringify(args)}`)
let phase = 'objects'
jest.mock('./useEngine', () => ({
    useEngine: () => ({ client: { call }, status: { phase, type: null, progress: null, fromCache: {}, errors: {} } }),
}))

const Probe = ({ x }: { x: number }) => {
    const { data, isLoading } = useEngineQuery<string>('indexOf', ['organisationUnit', x])
    return <div>{isLoading ? 'loading' : data}</div>
}

it('calls the engine and re-runs when args change', async () => {
    const { rerender } = render(<Probe x={1} />)
    await waitFor(() => expect(screen.getByText('result:["organisationUnit",1]')).toBeInTheDocument())
    rerender(<Probe x={2} />)
    await waitFor(() => expect(screen.getByText('result:["organisationUnit",2]')).toBeInTheDocument())
    expect(call).toHaveBeenCalledTimes(2)
})
```

- [ ] **Step 2: Write `src/hooks/useEngineQuery.ts`**

```typescript
import { useEffect, useState } from 'react'
import { EngineMethod } from '@/engine/protocol'
import { useEngine } from './useEngine'

export function useEngineQuery<T>(method: EngineMethod, args: unknown[], enabled = true) {
    const { client, status } = useEngine()
    const [state, setState] = useState<{ data: T | undefined; isLoading: boolean; error: string | null }>({
        data: undefined,
        isLoading: enabled,
        error: null,
    })
    const argsKey = JSON.stringify(args)

    useEffect(() => {
        if (!enabled) {
            return
        }
        let cancelled = false
        setState((s) => ({ ...s, isLoading: true }))
        client
            .call<T>(method, ...(JSON.parse(argsKey) as unknown[]))
            .then((data) => !cancelled && setState({ data, isLoading: false, error: null }))
            .catch((e: Error) => !cancelled && setState({ data: undefined, isLoading: false, error: e.message }))
        return () => {
            cancelled = true
        }
        // status.phase/type re-run the query as data arrives in the worker.
    }, [client, method, argsKey, enabled, status?.phase, status?.type])

    return state
}
```

- [ ] **Step 3: Write the failing test `src/components/SummaryMatrix/SummaryMatrix.test.tsx`**

```tsx
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SummaryMatrix } from './SummaryMatrix'

const result = {
    groups: [{ id: 'pub', displayName: 'Public', canWrite: true }, { id: 'priv', displayName: 'Private', canWrite: true }],
    rows: [
        { object: 1, row: { index: 1, id: 'A', displayName: 'Abaji', level: 3, parentId: 'r' }, perGroup: [210, 388], missing: 61, conflict: 12, total: 671 },
        { object: -1, row: null, perGroup: [0, 0], missing: 7, conflict: 0, total: 7 },
    ],
}

it('renders group columns, rows, totals and fires onCell', async () => {
    const onCell = jest.fn()
    render(<SummaryMatrix result={result} onCell={onCell} />)
    expect(screen.getByText('Public')).toBeInTheDocument()
    expect(screen.getByText('Abaji')).toBeInTheDocument()
    expect(screen.getByText(/Above the row level/)).toBeInTheDocument()
    // Total row: 210, 388, 68, 12, 678
    expect(screen.getByText('678')).toBeInTheDocument()
    await userEvent.click(screen.getByText('61'))
    expect(onCell).toHaveBeenCalledWith(result.rows[0].row, { kind: 'missing' })
})
```

- [ ] **Step 4: Write `src/components/SummaryMatrix/SummaryMatrix.tsx` and CSS**

```tsx
import i18n from '@dhis2/d2-i18n'
import { DataTable, DataTableBody, DataTableCell, DataTableColumnHeader, DataTableHead, DataTableRow } from '@dhis2/ui'
import React from 'react'
import { MatrixResult, ObjectRef } from '@/engine/store'
import styles from './SummaryMatrix.module.css'

export type MatrixColumn =
    | { kind: 'group'; index: number }
    | { kind: 'missing' }
    | { kind: 'conflict' }
    | { kind: 'total' }

interface Props {
    result: MatrixResult
    onCell: (row: ObjectRef | null, column: MatrixColumn) => void
}

const fmt = (n: number) => n.toLocaleString()

export const SummaryMatrix = ({ result, onCell }: Props) => {
    const totals = {
        perGroup: result.groups.map((_, g) => result.rows.reduce((s, r) => s + r.perGroup[g], 0)),
        missing: result.rows.reduce((s, r) => s + r.missing, 0),
        conflict: result.rows.reduce((s, r) => s + r.conflict, 0),
        total: result.rows.reduce((s, r) => s + r.total, 0),
    }
    const cell = (value: number, row: ObjectRef | null, column: MatrixColumn, tone?: 'error') => (
        <DataTableCell align="right" className={styles.cell} onClick={() => onCell(row, column)}>
            <span className={tone === 'error' && value > 0 ? styles.error : value === 0 ? styles.zero : undefined}>{fmt(value)}</span>
        </DataTableCell>
    )
    return (
        <div className={styles.wrap}>
            <DataTable>
                <DataTableHead>
                    <DataTableRow>
                        <DataTableColumnHeader>{i18n.t('Organisation unit')}</DataTableColumnHeader>
                        {result.groups.map((g) => (
                            <DataTableColumnHeader key={g.id} align="right">{g.displayName}</DataTableColumnHeader>
                        ))}
                        <DataTableColumnHeader align="right">{i18n.t('Missing')}</DataTableColumnHeader>
                        <DataTableColumnHeader align="right">{i18n.t('Conflict')}</DataTableColumnHeader>
                        <DataTableColumnHeader align="right">{i18n.t('Total')}</DataTableColumnHeader>
                    </DataTableRow>
                </DataTableHead>
                <DataTableBody>
                    {result.rows.map((r) => (
                        <DataTableRow key={r.object}>
                            <DataTableCell>{r.row ? r.row.displayName ?? r.row.id : i18n.t('Above the row level')}</DataTableCell>
                            {r.perGroup.map((v, g) => cell(v, r.row, { kind: 'group', index: g }))}
                            {cell(r.missing, r.row, { kind: 'missing' }, 'error')}
                            {cell(r.conflict, r.row, { kind: 'conflict' }, 'error')}
                            {cell(r.total, r.row, { kind: 'total' })}
                        </DataTableRow>
                    ))}
                    <DataTableRow className={styles.totalRow}>
                        <DataTableCell>{i18n.t('Total')}</DataTableCell>
                        {totals.perGroup.map((v, g) => <DataTableCell key={g} align="right">{fmt(v)}</DataTableCell>)}
                        <DataTableCell align="right">{fmt(totals.missing)}</DataTableCell>
                        <DataTableCell align="right">{fmt(totals.conflict)}</DataTableCell>
                        <DataTableCell align="right">{fmt(totals.total)}</DataTableCell>
                    </DataTableRow>
                </DataTableBody>
            </DataTable>
        </div>
    )
}
```

`SummaryMatrix.module.css`:

```css
.wrap { overflow-x: auto; }
.cell { cursor: pointer; font-variant-numeric: tabular-nums; }
.cell:hover { background: var(--colors-blue050); }
.error { color: var(--colors-red600); font-weight: 500; }
.zero { color: var(--colors-grey500); }
.totalRow td { font-weight: 500; background: var(--colors-grey100); }
```

Check the installed `@dhis2/ui` `DataTableCell` props (`onClick`, `className`, `align`) in `node_modules/@dhis2/ui/` before finishing; if `onClick` is not supported, wrap the content in a `<button className={styles.cellButton}>`.

- [ ] **Step 5: Write `src/pages/GroupSetDetail/OverviewTab.tsx`**

```tsx
import i18n from '@dhis2/d2-i18n'
import { CircularLoader, NoticeBox, SingleSelectField, SingleSelectOption } from '@dhis2/ui'
import React from 'react'
import { MatrixColumn, SummaryMatrix } from '@/components/SummaryMatrix/SummaryMatrix'
import { MatrixResult, ObjectRef, ScopeRef } from '@/engine/store'
import { GroupSetMeta } from '@/engine/types'
import { useEngineQuery } from '@/hooks/useEngineQuery'

interface Props {
    set: GroupSetMeta
    scope: ScopeRef
    rowLevel: number
    levels: { level: number; displayName: string }[]
    onRowLevel: (level: number) => void
    onCell: (row: ObjectRef | null, column: MatrixColumn) => void
}

export const OverviewTab = ({ set, scope, rowLevel, levels, onRowLevel, onCell }: Props) => {
    const { data, isLoading, error } = useEngineQuery<MatrixResult>('matrixFor', [set.id, scope, rowLevel])
    const isHierarchical = set.objectType === 'organisationUnit'
    return (
        <div>
            {isHierarchical && (
                <SingleSelectField
                    label={i18n.t('Rows')}
                    selected={String(rowLevel)}
                    onChange={({ selected }) => onRowLevel(Number(selected))}
                    inputWidth="280px"
                >
                    {levels.map((l) => (
                        <SingleSelectOption key={l.level} value={String(l.level)} label={`${l.displayName} (${i18n.t('level {{level}}', { level: l.level })})`} />
                    ))}
                </SingleSelectField>
            )}
            {error && <NoticeBox error>{error}</NoticeBox>}
            {isLoading || !data ? <CircularLoader small /> : <SummaryMatrix result={data} onCell={onCell} />}
        </div>
    )
}
```

- [ ] **Step 6: Write `src/pages/GroupSetDetail/GroupSetDetail.tsx` and CSS**

```tsx
import i18n from '@dhis2/d2-i18n'
import { Button, Tab, TabBar, Tag } from '@dhis2/ui'
import React, { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { MatrixColumn } from '@/components/SummaryMatrix/SummaryMatrix'
import { ObjectFilter } from '@/engine/queries'
import { ObjectRef, ScopeRef } from '@/engine/store'
import { Status } from '@/engine/types'
import { useEngine } from '@/hooks/useEngine'
import { useScope } from '@/hooks/useScope'
import { useUserScope } from '@/hooks/useUserScope'
import { useApiDataQuery } from '@/utils/useApiDataQuery'
import { ObjectsTab } from './ObjectsTab'
import { OverviewTab } from './OverviewTab'
import styles from './GroupSetDetail.module.css'

interface LevelsResponse {
    organisationUnitLevels: { level: number; displayName: string }[]
}

export const GroupSetDetail = () => {
    const { setId = '' } = useParams()
    const { groupSets } = useEngine()
    const { rootId, rootName } = useScope()
    const { roots } = useUserScope()
    const set = groupSets.find((s) => s.id === setId)
    const [tab, setTab] = useState<'overview' | 'objects'>('overview')
    const [filter, setFilter] = useState<ObjectFilter>({})

    const scopeLevel = roots.find((r) => r.id === rootId)?.level ?? 1
    const [rowLevel, setRowLevel] = useState(scopeLevel + 1)
    const { data: levelsData } = useApiDataQuery<LevelsResponse>({
        queryKey: ['organisationUnitLevels'],
        query: { resource: 'organisationUnitLevels', params: { fields: 'level,displayName', paging: false } },
        staleTime: Infinity,
    })
    const levels = useMemo(
        () => (levelsData?.organisationUnitLevels ?? []).filter((l) => l.level > scopeLevel).sort((a, b) => a.level - b.level),
        [levelsData, scopeLevel]
    )

    if (!set) {
        return <p>{i18n.t('Group set not found or not loaded yet.')}</p>
    }
    const scope: ScopeRef = { objectType: set.objectType, rootId: set.objectType === 'organisationUnit' ? rootId : null }

    const onCell = (row: ObjectRef | null, column: MatrixColumn) => {
        const next: ObjectFilter = {}
        if (row) {
            next.ancestor = row.index
        }
        if (column.kind === 'group') {
            next.group = column.index
        } else if (column.kind === 'missing') {
            next.statuses = [Status.MissingError, Status.MissingWarning]
        } else if (column.kind === 'conflict') {
            next.statuses = [Status.Conflict]
        }
        setFilter(next)
        setTab('objects')
    }

    return (
        <div className={styles.page}>
            <Link to="/">{i18n.t('Dashboard')}</Link>
            <div className={styles.header}>
                <div>
                    <h1 className={styles.title}>{set.displayName}</h1>
                    <div className={styles.badges}>
                        {set.compulsory && <Tag positive>{i18n.t('Compulsory')}</Tag>}
                        {set.dataDimension && <Tag positive>{i18n.t('Data dimension')}</Tag>}
                        <Tag neutral>{set.groups.map((g) => g.displayName).join(' · ')}</Tag>
                        {set.objectType === 'organisationUnit' && <Tag neutral>{i18n.t('Scope: {{name}}', { name: rootName })}</Tag>}
                    </div>
                </div>
                <div className={styles.actions}>
                    <Button small disabled>{i18n.t('Set properties…')}</Button>
                    <Button small disabled>{i18n.t('Fix issues…')}</Button>
                </div>
            </div>
            <TabBar>
                <Tab selected={tab === 'overview'} onClick={() => setTab('overview')}>{i18n.t('Overview')}</Tab>
                <Tab selected={tab === 'objects'} onClick={() => setTab('objects')}>{i18n.t('Objects')}</Tab>
            </TabBar>
            {tab === 'overview' ? (
                <OverviewTab set={set} scope={scope} rowLevel={rowLevel} levels={levels} onRowLevel={setRowLevel} onCell={onCell} />
            ) : (
                <ObjectsTab set={set} scope={scope} filter={filter} onFilter={setFilter} levels={levels} />
            )}
        </div>
    )
}
```

The two disabled buttons are placeholders for Plan 2's actions; leaving them disabled keeps the layout stable and signals the coming features. `ObjectsTab` is created in Task 13; for this task create `src/pages/GroupSetDetail/ObjectsTab.tsx` exporting a component with the props above that renders `<p>{i18n.t('Objects list coming next')}</p>`, so the page compiles.

`GroupSetDetail.module.css`:

```css
.page { padding: var(--spacers-dp16); display: flex; flex-direction: column; gap: var(--spacers-dp12); }
.header { display: flex; gap: var(--spacers-dp12); align-items: flex-start; flex-wrap: wrap; }
.title { font-size: 20px; font-weight: 500; margin: 0 0 var(--spacers-dp4); }
.badges { display: flex; gap: var(--spacers-dp4); flex-wrap: wrap; }
.actions { margin-left: auto; display: flex; gap: var(--spacers-dp8); }
```

- [ ] **Step 7: Add the route in `src/App.tsx`**

```tsx
children: [
    { path: '/', element: <Dashboard /> },
    { path: '/sets/:setId', element: <GroupSetDetail /> },
],
```

with `import { GroupSetDetail } from '@/pages/GroupSetDetail/GroupSetDetail'`.

- [ ] **Step 8: Run tests, types, lint, and check in the browser**

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm exec eslint src
```

In the running dev server (Task 11 step 9), click the Facility Ownership card, confirm the matrix lists Sierra Leone's districts with counts per group, change the row level to chiefdom, and click a Missing cell to land on the Objects tab placeholder.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "Add group set detail page with summary matrix

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Objects tab with virtualised table and read-only membership display

**Files:**
- Create: `src/components/ObjectsTable/ObjectsTable.tsx`, `src/components/ObjectsTable/ObjectsTable.module.css`, `src/components/MembershipControl/MembershipControl.tsx`, `src/components/MembershipControl/MembershipControl.module.css`, `src/components/StatusPill/StatusPill.tsx`
- Modify: `src/pages/GroupSetDetail/ObjectsTab.tsx`
- Test: `src/components/MembershipControl/MembershipControl.test.tsx`, `src/components/ObjectsTable/ObjectsTable.test.tsx`

**Interfaces:**
- Consumes: `useEngineQuery` (Task 12), `ObjectsResult` (Task 6), `ObjectFilter` (Task 5), `Status` (Task 2), `GroupSetMeta`.
- Produces:
  - `<StatusPill status={Status} />`: OK (green), Missing (red for error, yellow for warning), Conflict (red).
  - `<MembershipControl groups={GroupMeta[]} current={number[]} disabled onChange={(groupIndex: number) => void} />`: segmented single-select when `groups.length <= 5`, `SingleSelect` otherwise; groups in `current` are highlighted, and when `current.length > 1` they are styled as conflicts. In Plan 1 `disabled` is always true and `onChange` is a no-op; Plan 2 wires the writes.
  - `<ObjectsTable set scope filter pageSize=200 />`: pages through `objectsFor` with `offset`/`limit`, renders with `@tanstack/react-virtual` inside a fixed-height scroll container, columns: name, parent (org units only), level (org units only), status, membership. Fetches the next page when the last virtual row is within 50 rows of the loaded end.
  - `ObjectsTab` renders the filter bar (status `SingleSelect`, level `SingleSelect` for org units, group `SingleSelect`, text search `InputField`) and the table. Text search is applied client-side to the loaded rows only in Plan 1 (full search is a Plan 3 refinement); show a "matches loaded rows only" hint when a search is active.

- [ ] **Step 1: Write the failing test `src/components/MembershipControl/MembershipControl.test.tsx`**

```tsx
import React from 'react'
import { render, screen } from '@testing-library/react'
import { MembershipControl } from './MembershipControl'

const groups = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `g${i}`, displayName: `Group ${i}`, canWrite: true }))

it('renders a segmented control for up to five groups and marks conflicts', () => {
    render(<MembershipControl groups={groups(3)} current={[0, 2]} disabled onChange={() => undefined} />)
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(3)
    expect(buttons[0]).toHaveAttribute('data-state', 'conflict')
    expect(buttons[1]).toHaveAttribute('data-state', 'none')
    expect(buttons[2]).toHaveAttribute('data-state', 'conflict')
})

it('marks the single current group as selected', () => {
    render(<MembershipControl groups={groups(2)} current={[1]} disabled onChange={() => undefined} />)
    expect(screen.getAllByRole('button')[1]).toHaveAttribute('data-state', 'selected')
})

it('renders a dropdown for more than five groups', () => {
    render(<MembershipControl groups={groups(6)} current={[]} disabled onChange={() => undefined} />)
    expect(screen.queryAllByRole('button').filter((b) => b.dataset.state)).toHaveLength(0)
    expect(screen.getByText(/choose group/i)).toBeInTheDocument()
})
```

- [ ] **Step 2: Write `src/components/MembershipControl/MembershipControl.tsx` and CSS**

```tsx
import i18n from '@dhis2/d2-i18n'
import { SingleSelect, SingleSelectOption } from '@dhis2/ui'
import React from 'react'
import { GroupMeta } from '@/engine/types'
import styles from './MembershipControl.module.css'

interface Props {
    groups: GroupMeta[]
    /** group positions the object currently belongs to */
    current: number[]
    disabled: boolean
    onChange: (groupIndex: number) => void
}

const SEGMENTED_MAX = 5

export const MembershipControl = ({ groups, current, disabled, onChange }: Props) => {
    const isConflict = current.length > 1
    if (groups.length <= SEGMENTED_MAX) {
        return (
            <span className={styles.seg} role="group">
                {groups.map((g, i) => {
                    const state = current.includes(i) ? (isConflict ? 'conflict' : 'selected') : 'none'
                    return (
                        <button
                            key={g.id}
                            type="button"
                            className={styles.segButton}
                            data-state={state}
                            disabled={disabled}
                            title={isConflict ? i18n.t('Keep {{name}} and remove the others', { name: g.displayName }) : g.displayName}
                            onClick={() => onChange(i)}
                        >
                            {g.displayName}
                        </button>
                    )
                })}
            </span>
        )
    }
    const selected = current.length === 1 ? String(current[0]) : ''
    return (
        <SingleSelect
            dense
            disabled={disabled}
            selected={selected}
            placeholder={isConflict ? i18n.t('Conflict: choose group to keep') : i18n.t('Choose group')}
            onChange={({ selected: value }) => onChange(Number(value))}
            filterable={groups.length > 10}
            noMatchText={i18n.t('No group matches')}
        >
            {groups.map((g, i) => (
                <SingleSelectOption key={g.id} value={String(i)} label={current.includes(i) && isConflict ? `${g.displayName} (${i18n.t('current')})` : g.displayName} />
            ))}
        </SingleSelect>
    )
}
```

`MembershipControl.module.css`:

```css
.seg { display: inline-flex; border: 1px solid var(--colors-grey400); border-radius: 3px; overflow: hidden; background: var(--colors-white); }
.segButton { font: inherit; font-size: 12px; border: 0; border-right: 1px solid var(--colors-grey400); background: var(--colors-white); color: var(--colors-grey700); padding: 3px 10px; cursor: pointer; }
.segButton:last-child { border-right: 0; }
.segButton:disabled { cursor: default; }
.segButton[data-state='selected'] { background: var(--colors-blue600); color: var(--colors-white); }
.segButton[data-state='conflict'] { background: var(--colors-red050); color: var(--colors-red700); font-weight: 500; }
.segButton[data-state='conflict']:not(:disabled):hover { background: var(--colors-red600); color: var(--colors-white); }
.segButton:focus-visible { outline: 2px solid var(--colors-blue600); outline-offset: -2px; }
```

- [ ] **Step 3: Write `src/components/StatusPill/StatusPill.tsx`**

```tsx
import i18n from '@dhis2/d2-i18n'
import { Tag } from '@dhis2/ui'
import React from 'react'
import { Status } from '@/engine/types'

export const StatusPill = ({ status }: { status: Status }) => {
    switch (status) {
        case Status.Ok:
            return <Tag positive>{i18n.t('OK')}</Tag>
        case Status.MissingError:
            return <Tag negative>{i18n.t('Missing')}</Tag>
        case Status.MissingWarning:
            return <Tag>{i18n.t('Missing (warning)')}</Tag>
        case Status.Conflict:
            return <Tag negative>{i18n.t('Conflict')}</Tag>
        default:
            return <Tag neutral>{i18n.t('Not applicable')}</Tag>
    }
}
```

- [ ] **Step 4: Write the failing test `src/components/ObjectsTable/ObjectsTable.test.tsx`**

```tsx
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { ObjectsTable } from './ObjectsTable'

const items = Array.from({ length: 3 }, (_, i) => ({
    index: i, id: `ou${i}`, displayName: `Facility ${i}`, level: 4, parentId: 'p',
    status: i === 1 ? 4 : 1, groups: i === 1 ? [0, 1] : [0],
}))
jest.mock('@/hooks/useEngineQuery', () => ({
    useEngineQuery: () => ({ data: { total: 3, items }, isLoading: false, error: null }),
}))

const set = {
    id: 'own', displayName: 'Ownership', objectType: 'organisationUnit' as const, compulsory: true, dataDimension: true, canWrite: true,
    groups: [{ id: 'a', displayName: 'Public', canWrite: true }, { id: 'b', displayName: 'Private', canWrite: true }],
}

it('renders rows with status and membership', async () => {
    render(<ObjectsTable set={set} scope={{ objectType: 'organisationUnit', rootId: 'r' }} filter={{}} search="" />)
    await waitFor(() => expect(screen.getByText('Facility 1')).toBeInTheDocument())
    expect(screen.getByText('Conflict')).toBeInTheDocument()
    expect(screen.getByText(/3 objects/)).toBeInTheDocument()
})
```

`@tanstack/react-virtual` measures a scroll container; jsdom reports zero heights, so the virtualizer renders nothing unless `initialRect` is given. Pass `initialRect: { width: 800, height: 600 }` in the component so tests and first paint both show rows.

- [ ] **Step 5: Write `src/components/ObjectsTable/ObjectsTable.tsx` and CSS**

```tsx
import i18n from '@dhis2/d2-i18n'
import { CircularLoader, NoticeBox } from '@dhis2/ui'
import { useVirtualizer } from '@tanstack/react-virtual'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { MembershipControl } from '@/components/MembershipControl/MembershipControl'
import { StatusPill } from '@/components/StatusPill/StatusPill'
import { ObjectFilter } from '@/engine/queries'
import { ObjectsResult, ScopeRef } from '@/engine/store'
import { GroupSetMeta } from '@/engine/types'
import { useEngineQuery } from '@/hooks/useEngineQuery'
import styles from './ObjectsTable.module.css'

interface Props {
    set: GroupSetMeta
    scope: ScopeRef
    filter: ObjectFilter
    search: string
}

const PAGE = 200
const ROW_HEIGHT = 36

export const ObjectsTable = ({ set, scope, filter, search }: Props) => {
    const [limit, setLimit] = useState(PAGE)
    const { data, isLoading, error } = useEngineQuery<ObjectsResult>('objectsFor', [set.id, scope, filter, 0, limit])
    const filterKey = JSON.stringify([set.id, scope, filter])
    useEffect(() => setLimit(PAGE), [filterKey])

    const rows = useMemo(() => {
        const items = data?.items ?? []
        const q = search.trim().toLowerCase()
        return q ? items.filter((r) => (r.displayName ?? r.id).toLowerCase().includes(q)) : items
    }, [data, search])

    const parentRef = useRef<HTMLDivElement>(null)
    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 20,
        initialRect: { width: 800, height: 600 },
    })
    const virtualItems = virtualizer.getVirtualItems()
    const lastVisible = virtualItems[virtualItems.length - 1]?.index ?? 0

    useEffect(() => {
        if (data && lastVisible >= rows.length - 50 && limit < data.total) {
            setLimit((l) => l + PAGE)
        }
    }, [lastVisible, rows.length, limit, data])

    if (error) {
        return <NoticeBox error>{error}</NoticeBox>
    }
    if (!data) {
        return <CircularLoader small />
    }
    const isOrgUnit = set.objectType === 'organisationUnit'
    return (
        <div>
            <p className={styles.count}>
                {i18n.t('{{count}} objects', { count: data.total, defaultValue_plural: '{{count}} objects' })}
                {search && ` · ${i18n.t('search matches loaded rows only')}`}
                {isLoading && ` · ${i18n.t('updating…')}`}
            </p>
            <div className={styles.head}>
                <span>{i18n.t('Name')}</span>
                {isOrgUnit && <span>{i18n.t('Parent')}</span>}
                {isOrgUnit && <span>{i18n.t('Level')}</span>}
                <span>{i18n.t('Status')}</span>
                <span>{i18n.t('Group in this set')}</span>
            </div>
            <div ref={parentRef} className={styles.scroll}>
                <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                    {virtualItems.map((v) => {
                        const r = rows[v.index]
                        return (
                            <div key={r.id} className={styles.row} style={{ transform: `translateY(${v.start}px)` }}>
                                <span title={r.id}>{r.displayName ?? r.id}</span>
                                {isOrgUnit && <span>{r.parentId ?? ''}</span>}
                                {isOrgUnit && <span>{r.level}</span>}
                                <span><StatusPill status={r.status} /></span>
                                <span>
                                    <MembershipControl groups={set.groups} current={r.groups} disabled onChange={() => undefined} />
                                </span>
                            </div>
                        )
                    })}
                </div>
            </div>
        </div>
    )
}
```

The parent column shows the parent id in Plan 1; resolving parent names (a second `resolve` call for the visible rows' parents) is added in Plan 2 together with the editing controls, to keep this task small.

`ObjectsTable.module.css`:

```css
.count { font-size: 12px; color: var(--colors-grey600); margin: 0 0 var(--spacers-dp8); }
.head, .row { display: grid; grid-template-columns: 2fr 1.5fr 60px 130px 2fr; gap: var(--spacers-dp8); align-items: center; padding: 0 var(--spacers-dp8); }
.head { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--colors-grey600); font-weight: 500; background: var(--colors-grey100); height: 32px; }
.scroll { height: 600px; overflow: auto; border: 1px solid var(--colors-grey300); }
.row { position: absolute; top: 0; left: 0; right: 0; height: 36px; border-bottom: 1px solid var(--colors-grey200); font-size: 13px; }
.row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

For flat object types the grid has fewer columns; set `style={{ gridTemplateColumns: isOrgUnit ? undefined : '3fr 130px 2fr' }}` on both `.head` and `.row` elements.

- [ ] **Step 6: Fill in `src/pages/GroupSetDetail/ObjectsTab.tsx`**

```tsx
import i18n from '@dhis2/d2-i18n'
import { InputField, SingleSelectField, SingleSelectOption } from '@dhis2/ui'
import React, { useState } from 'react'
import { ObjectsTable } from '@/components/ObjectsTable/ObjectsTable'
import { ObjectFilter } from '@/engine/queries'
import { ScopeRef } from '@/engine/store'
import { GroupSetMeta, Status } from '@/engine/types'
import styles from './GroupSetDetail.module.css'

interface Props {
    set: GroupSetMeta
    scope: ScopeRef
    filter: ObjectFilter
    onFilter: (f: ObjectFilter) => void
    levels: { level: number; displayName: string }[]
}

type StatusChoice = 'all' | 'ok' | 'missing' | 'conflict'

const statusChoiceOf = (f: ObjectFilter): StatusChoice => {
    if (!f.statuses) {
        return 'all'
    }
    if (f.statuses.includes(Status.Conflict)) {
        return 'conflict'
    }
    if (f.statuses.includes(Status.Ok)) {
        return 'ok'
    }
    return 'missing'
}

const statusesOf = (c: StatusChoice): Status[] | undefined => {
    switch (c) {
        case 'ok':
            return [Status.Ok]
        case 'missing':
            return [Status.MissingError, Status.MissingWarning]
        case 'conflict':
            return [Status.Conflict]
        default:
            return undefined
    }
}

export const ObjectsTab = ({ set, scope, filter, onFilter, levels }: Props) => {
    const [search, setSearch] = useState('')
    const isOrgUnit = set.objectType === 'organisationUnit'
    return (
        <div>
            <div className={styles.filters}>
                <SingleSelectField dense label={i18n.t('Status')} selected={statusChoiceOf(filter)}
                    onChange={({ selected }) => onFilter({ ...filter, statuses: statusesOf(selected as StatusChoice) })}>
                    <SingleSelectOption value="all" label={i18n.t('All')} />
                    <SingleSelectOption value="ok" label={i18n.t('OK')} />
                    <SingleSelectOption value="missing" label={i18n.t('Missing')} />
                    <SingleSelectOption value="conflict" label={i18n.t('Conflict')} />
                </SingleSelectField>
                {isOrgUnit && (
                    <SingleSelectField dense label={i18n.t('Level')} selected={filter.level === undefined ? 'all' : String(filter.level)}
                        onChange={({ selected }) => onFilter({ ...filter, level: selected === 'all' ? undefined : Number(selected) })}>
                        <SingleSelectOption value="all" label={i18n.t('All levels')} />
                        {levels.map((l) => <SingleSelectOption key={l.level} value={String(l.level)} label={l.displayName} />)}
                    </SingleSelectField>
                )}
                <SingleSelectField dense label={i18n.t('Group')} selected={filter.group === undefined ? 'all' : String(filter.group)}
                    onChange={({ selected }) => onFilter({ ...filter, group: selected === 'all' ? undefined : Number(selected) })}>
                    <SingleSelectOption value="all" label={i18n.t('Any')} />
                    <SingleSelectOption value="-1" label={i18n.t('No group')} />
                    <SingleSelectOption value="-2" label={i18n.t('Several groups (conflict)')} />
                    {set.groups.map((g, i) => <SingleSelectOption key={g.id} value={String(i)} label={g.displayName} />)}
                </SingleSelectField>
                <InputField dense label={i18n.t('Search loaded rows')} value={search} onChange={({ value }) => setSearch(value ?? '')} />
                {filter.ancestor !== undefined && (
                    <button type="button" className={styles.clear} onClick={() => onFilter({ ...filter, ancestor: undefined })}>
                        {i18n.t('Clear area filter')}
                    </button>
                )}
            </div>
            <ObjectsTable set={set} scope={scope} filter={filter} search={search} />
        </div>
    )
}
```

Add to `GroupSetDetail.module.css`:

```css
.filters { display: flex; gap: var(--spacers-dp8); align-items: flex-end; flex-wrap: wrap; margin-bottom: var(--spacers-dp8); }
.clear { font: inherit; font-size: 12px; background: none; border: 0; color: var(--colors-blue700); cursor: pointer; text-decoration: underline; }
```

- [ ] **Step 7: Run tests, types, lint and check in the browser**

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm exec eslint src
```

In the dev server: open Facility Ownership, Objects tab, filter Status = Conflict and Missing, scroll a long list and confirm more rows load, and confirm that clicking a matrix cell in Overview lands here with the filters applied. Take a Playwright screenshot.

- [ ] **Step 8: Update `CLAUDE.md`**

Add under Architecture decisions:

```markdown
- Object lists are paged from the worker (`objectsFor` with offset/limit) and virtualised with @tanstack/react-virtual; text search is client-side over loaded rows until Plan 3.
- MembershipControl is a segmented single-select for <= 5 groups, a SingleSelect above. Editing is wired in Plan 2.
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "Add objects tab with virtualised list and membership display

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Performance budget test and EMIS measurement

**Files:**
- Create: `src/engine/perf.test.ts`, `docs/superpowers/notes/2026-09-plan1-emis-measurements.md`

**Interfaces:**
- Consumes: `EngineStore` (Task 6).
- Produces: a Jest test that fails if engine load or query time regresses, and a written record of real EMIS timings.

- [ ] **Step 1: Write `src/engine/perf.test.ts`**

```typescript
import { EngineStore } from './store'
import { GroupSetMeta, Status } from './types'

/** 300K org units: 1 root, 40 states, 800 LGAs, 20K wards, ~279K schools. */
function synthetic() {
    const ids: string[] = ['root']
    const level: number[] = [1]
    const parentIds: (string | null)[] = [null]
    const add = (id: string, l: number, parent: string) => {
        ids.push(id)
        level.push(l)
        parentIds.push(parent)
    }
    for (let s = 0; s < 40; s++) {
        add(`s${s}`, 2, 'root')
        for (let d = 0; d < 20; d++) {
            add(`s${s}d${d}`, 3, `s${s}`)
            for (let w = 0; w < 25; w++) {
                add(`s${s}d${d}w${w}`, 4, `s${s}d${d}`)
                for (let f = 0; f < 14; f++) {
                    add(`s${s}d${d}w${w}f${f}`, 5, `s${s}d${d}w${w}`)
                }
            }
        }
    }
    const pub: string[] = []
    const priv: string[] = []
    ids.forEach((id, i) => {
        if (level[i] !== 5) {
            return
        }
        if (i % 7 === 0) {
            return // missing
        }
        if (i % 2 === 0) {
            pub.push(id)
        } else {
            priv.push(id)
        }
        if (i % 97 === 0) {
            pub.push(id)
            priv.push(id) // conflict
        }
    })
    return { ids, level: Uint8Array.from(level), parentIds, pub, priv }
}

const ownership: GroupSetMeta = {
    id: 'own', displayName: 'Ownership', objectType: 'organisationUnit', compulsory: true, dataDimension: true, canWrite: true,
    groups: [{ id: 'pub', displayName: 'Public', canWrite: true }, { id: 'priv', displayName: 'Private', canWrite: true }],
}

describe('engine performance on 300K org units', () => {
    const data = synthetic()

    it('loads, evaluates and answers queries within budget', () => {
        const store = new EngineStore()
        const t0 = performance.now()
        store.loadObjects({ objectType: 'organisationUnit', ids: data.ids, names: null, level: data.level, parentIds: data.parentIds, domainType: null, categoryIdsOfOption: null })
        store.setGroupSets([ownership])
        store.loadMemberships({ objectType: 'organisationUnit', groups: [{ groupId: 'pub', memberIds: data.pub }, { groupId: 'priv', memberIds: data.priv }] })
        store.evaluate()
        const tLoad = performance.now() - t0

        const t1 = performance.now()
        const dash = store.dashboard({ objectType: 'organisationUnit', rootId: 'root' })
        const m = store.matrixFor('own', { objectType: 'organisationUnit', rootId: 'root' }, 2)
        const page = store.objectsFor('own', { objectType: 'organisationUnit', rootId: 's3' }, { statuses: [Status.Conflict] }, 0, 200)
        const tQuery = performance.now() - t1

        expect(data.ids.length).toBeGreaterThan(280000)
        expect(dash[0].summary.conflict).toBeGreaterThan(0)
        expect(m.rows.length).toBe(41) // 40 states + "above" row
        expect(page.total).toBeGreaterThan(0)
        // Budgets are generous for CI machines; the point is catching 10x regressions.
        expect(tLoad).toBeLessThan(5000)
        expect(tQuery).toBeLessThan(500)
        // eslint-disable-next-line no-console
        console.info(`perf: load+evaluate ${tLoad.toFixed(0)} ms, three queries ${tQuery.toFixed(0)} ms`)
    })
})
```

- [ ] **Step 2: Run it**

Run: `pnpm test -- src/engine/perf`
Expected: PASS with the timing line in the output. Record the numbers.

- [ ] **Step 3: Measure on EMIS**

Confirm `agent-gsi-emis` is running (`GET $DHIS2_BROKER_URL/instances`; start it if stopped). Start the dev server against it:

```bash
pnpm start --port "$SANDBOX_HOST_PORT" --proxy http://dhis2-agent-gsi-emis:8080
```

Log in as `local_admin` / `district`. Using Playwright (webapp-testing skill), record with `performance.now()` around the load: time from app open to dashboard cards showing numbers, (a) metadata API path (no `GSI_*` views exist yet), (b) after creating the three SQL views by hand with the `SQL_VIEW_DEFINITIONS` bodies through `POST /api/sqlViews` with `code` set and sharing `public: 'r-------'`, then reloading with the cache cleared (DevTools > Application > IndexedDB > delete `gsi-cache`), (c) a warm reload from cache. Also note browser memory (Performance monitor > JS heap) after load, and the server-side request durations from the Network tab.

- [ ] **Step 4: Write `docs/superpowers/notes/2026-09-plan1-emis-measurements.md`**

Record a table with: path (metadata / SQL view / cache), wall time to first counts, total bytes transferred, JS heap after load, and the longest single request. State whether the 60 second budget from the spec holds and whether names arrive within a further 30 seconds. If the metadata path exceeds 60 seconds, add a note to Plan 3 to make the Settings page's "create SQL views" the first thing an admin is prompted to do.

- [ ] **Step 5: Commit**

```bash
git add src/engine/perf.test.ts docs/superpowers/notes
git commit -m "Add engine performance budget test and EMIS measurements

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Plans that follow

- **Plan 2: Fixing.** Membership writes (assign, move to catch-all, bulk fix dialog with preview), catch-all group creation, set properties and required levels, dataStore client, change sets with History page and revert, parent name resolution in the objects table.
- **Plan 3: Admin and integrity.** DHIS2 data integrity overlay, Settings page (SQL view creation, tracker toggle default, cache clear), full-text search over all objects, Playwright end-to-end suite against Sierra Leone 2.40 and 2.43 and EMIS, app review pass.
