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
