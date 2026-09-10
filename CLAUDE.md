# Group Set Integrity Tool

DHIS2 App Platform app (TypeScript, Vite, pnpm). Spec: docs/superpowers/specs/2026-09-10-group-set-integrity-tool-design.md. Plans: docs/superpowers/plans/.

## Commands

- `pnpm start` dev server (bind to `$SANDBOX_HOST_PORT` in the sandbox: `pnpm start --port $SANDBOX_HOST_PORT --proxy http://dhis2-<instance>:8080`)
- `pnpm test` Jest; `pnpm exec tsc --noEmit`; `pnpm exec eslint src`
- `pnpm build` produces build/bundle/\*.zip

## Architecture decisions

- `src/engine` is pure TypeScript with typed arrays, runs in a Web Worker, no React or DHIS2 imports. Test it with plain Jest.
- Data comes from SQL views when present (`GSI_*` codes) else from the metadata API; both produce the same payloads (`src/data/types.ts`).
- Conflict = in more than one group of a set: always an error. Membership counted per set.
- Data fetching through `useApiDataQuery` (TanStack Query v4), never `useDataQuery` directly.
- Group sets are loaded per type with `Promise.allSettled`; a type that fails is recorded in `LoadStatus.errors` and the rest of the dashboard still loads (spec 6.4).
- The IndexedDB cache is reused only when the group ids, the object total **and** every group's `lastUpdated` match the server (spec 4.4). The first two are blind to an object moving between groups, which is the change this tool exists to watch.
- SQL views are used only when the server reports a type other than `MATERIALIZED_VIEW`; a materialised view serves arbitrarily old rows with no signal, so the app falls back to the metadata API. `SQL_VIEW_DEFINITIONS` pins `type: 'VIEW'`.
- The scope carries its org unit level (`useScope().rootLevel`), taken from the tree's `path`. Only a scope stored before that existed lacks one, and then `levelOf` on the engine resolves it.
- Hash router; every route under `SyncUrlWithGlobalShell`.
- Object lists are paged from the worker (`objectsFor` with offset/limit) and virtualised with @tanstack/react-virtual; text search is client-side over loaded rows until Plan 3.
- MembershipControl is a segmented single-select for <= 5 groups, a SingleSelect above. Editing is wired in Plan 2.
- Matrix and summary buckets come from `Status`, never from membership alone: `perGroup` + `unassigned` + `missing` + `conflict` = `total`. `unassigned` is "in no group, and spec 3.2 allows that here", shown (as "No group (not required)") only for a set that is neither compulsory nor a data dimension, and drilled into with `{ group: -1, statuses: [Status.Ok] }`.
- The objects table pages by **offset** with a fixed limit and appends; it never re-requests loaded rows with a bigger limit, and never auto-pages while the text search is active (the search only looks at loaded rows).

## Translatable strings

- Every user-facing string goes through a single, argument-free `i18n.t('…')` call. Any second argument makes the call invisible to this project's i18next-scanner, so it never reaches `i18n/en.pot`.
- **A sentence is translated whole.** Never join translated fragments around a value. Put a `{name}` placeholder inside the one complete string and fill it in afterwards with `interpolate()` from `src/utils/interpolate.ts`:
  `interpolate(i18n.t('Includes organisation units above the {level} level'), { level })`.
  Single braces, not `{{…}}`: i18next interpolates its own double braces even with no options passed and replaces the unknown variable with an empty string, so a `{{…}}` placeholder is gone before `interpolate` sees it.
- Counts stay two complete strings chosen on `count === 1`, with the number in a placeholder (`'1 object'` / `'{count} objects'`).
- **No colon inside an `i18n.t()` string**: the scanner reads it as its namespace separator and drops the key (confirmed -- `'Scope: {name}'` extracted as namespace `Scope`, key `' {name}'`). Put the colon in JSX, or word the string without one.
- Punctuation that belongs to a sentence belongs inside the translated string, not glued on in JS.
- Run `pnpm exec d2-app-scripts i18n extract` after adding strings and check the output for scanner warnings.
