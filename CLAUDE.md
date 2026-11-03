# Group Set Integrity Tool

DHIS2 App Platform app (TypeScript, Vite, pnpm). User documentation: docs/user/. Measured DHIS2 behaviour, stored formats and known open items: docs/developer/. Keep the open items there current: close an item in the same commit as its fix.

## Commands

- `pnpm start --proxy http://localhost:8080` dev server against a DHIS2 instance
- `pnpm test` Jest; `pnpm exec tsc --noEmit`; `pnpm run lint` (Ultracite: Oxlint + Oxfmt)
- `pnpm build` produces build/bundle/\*.zip
- `e2e/run.sh` end-to-end suite (Python + Playwright), throwaway instances only; see e2e/README.md

## Architecture decisions

- `src/engine` is pure TypeScript with typed arrays, runs in a Web Worker, no React or DHIS2 imports. Test it with plain Jest.
- Data comes from SQL views when present (`GSI_*` codes) else from the metadata API; both produce the same payloads (`src/data/types.ts`).
- Conflict = in more than one group of a set: always an error. Membership counted per set.
- Membership is evaluated the same way at every org unit level: conflict is always an error, one group is Ok, and no group is an error when the set is compulsory, a warning when it is a data dimension, and allowed otherwise. There is no per-set "required levels" policy (it was removed).
- Data fetching through `useApiDataQuery` (TanStack Query v4), never `useDataQuery` directly.
- Group sets are loaded per type with `Promise.allSettled`; a type that fails is recorded in `LoadStatus.errors` and the rest of the dashboard still loads.
- The IndexedDB cache is reused only when the group ids, the object total **and** every group's `lastUpdated` match the server. The first two are blind to an object moving between groups, which is the change this tool exists to watch.
- SQL views are used only when the server reports a type other than `MATERIALIZED_VIEW`; a materialised view serves arbitrarily old rows with no signal, so the app falls back to the metadata API. `SQL_VIEW_DEFINITIONS` pins `type: 'VIEW'`.
- The scope carries its org unit level (`useScope().rootLevel`), taken from the tree's `path`. Only a scope stored before that existed lacks one, and then `levelOf` on the engine resolves it.
- Hash router; every route under `SyncUrlWithGlobalShell`.
- Object lists are paged from the worker (`objectsFor` with offset/limit) and virtualised with @tanstack/react-virtual; text search is a predicate on the engine's own filter (`ObjectFilter.text`) over a store-owned lowercase index, not a component concern, so it sees the whole population, not just loaded rows. The search input is debounced 300ms before it reaches the filter.
- MembershipControl is a segmented single-select for <= 5 groups, a SingleSelect above.
- Matrix and summary buckets come from `Status`, never from membership alone: `perGroup` + `unassigned` + `missing` + `conflict` = `total`. `unassigned` is "in no group, and the set allows that", shown (as "No group (not required)") only for a set that is neither compulsory nor a data dimension, and drilled into with `{ group: -1, statuses: [Status.Ok] }`.
- The objects table pages by **offset** with a fixed limit and appends; it never re-requests loaded rows with a bigger limit. A filter change (including a new search term) resets to offset 0 and discards the previous filter's rows, rather than appending onto them.
- The integrity overlay (asking the server to run its own data integrity checks) is read-only and gated on the maintenance authority; the app never writes anything as a result of it.
- Integrity checks resolve by name at runtime, never by code: neither a check's name nor its code is stable across 2.40 to 2.43, and the same code (`OUVEGS`) names a different check on the two versions.

## Translatable strings

- Every user-facing string goes through a single, argument-free `i18n.t('…')` call. Any second argument makes the call invisible to this project's i18next-scanner, so it never reaches `i18n/en.pot`.
- **A sentence is translated whole.** Never join translated fragments around a value. Put a `{name}` placeholder inside the one complete string and fill it in afterwards with `interpolate()` from `src/utils/interpolate.ts`:
  `interpolate(i18n.t('Includes organisation units above the {level} level'), { level })`.
  Single braces, not `{{…}}`: i18next interpolates its own double braces even with no options passed and replaces the unknown variable with an empty string, so a `{{…}}` placeholder is gone before `interpolate` sees it.
- Counts stay two complete strings chosen on `count === 1`, with the number in a placeholder (`'1 object'` / `'{count} objects'`).
- **No colon inside an `i18n.t()` string**: the scanner reads it as its namespace separator and drops the key (confirmed -- `'Scope: {name}'` extracted as namespace `Scope`, key `' {name}'`). Put the colon in JSX, or word the string without one.
- Punctuation that belongs to a sentence belongs inside the translated string, not glued on in JS.
- Run `pnpm exec d2-app-scripts i18n extract` after adding strings and check the output for scanner warnings.

@AGENTS.md
