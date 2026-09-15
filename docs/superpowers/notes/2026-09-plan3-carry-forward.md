# Carried forward from Plan 3: what was found and deliberately not fixed

Plan 3's final review (Task 11, the app-review pass) confirmed these as real
defects, each independently spotted by at least two agents across the plan's
tasks. None was fixed within Plan 3 — fixing any of them was out of scope for
the plan that found them, per the brief's instruction to record rather than
expand scope at the last step. They should be the first things a future plan
picks up.

- **`ObjectsTable`'s per-row assign never triggers a reload.** The user
  confirms an assignment through `MembershipControl`, the write lands on the
  server, but the control snaps back to "no group" with no success message —
  a successful write looks exactly like a failure. The natural next action
  (re-clicking the control) writes the same change again, adding a second
  History row for one user intent. Found by Task 9's implementer while
  building the e2e suite, confirmed and sharpened by its reviewer.
  `src/components/ObjectsTable/ObjectsTable.tsx`.

- **A bulk apply over the full EMIS population (77,017 objects) extrapolates
  to 8-12 minutes**, against the user's stated budget of roughly 60 seconds.
  The write is 79 sequential batches of 1,000 ids at 6-9 seconds each, and
  that per-batch cost is a floor, not a ceiling — the target group grows
  during its own batches, and DHIS2 re-evaluates the whole collection on
  every write. The dominant cost is DHIS2's own collection-update endpoint,
  not app code, so the remedy is not obvious and belongs to a plan of its
  own — batching strategy, a different write shape, or a scoped-down first
  release of bulk apply. See
  `docs/superpowers/notes/2026-09-plan3-performance.md`.

- **A direct `#/history` navigation briefly renders "This group set no
  longer exists"** on rows whose own Revert then works once the group sets
  finish loading. Pre-existing (not introduced by Plan 3), spotted by
  Task 9's re-reviewer while driving the app directly by URL rather than
  through in-app navigation. `src/pages/History/History.tsx`.

- **`@types/node` was added for a test-only need (the Playwright e2e suite)
  and re-resolved the app-wide transitive version** from 25.0.3 down to
  22.20.2. The pinned version is correct for the Node actually in use here
  and every check passes, but it is an app-wide dependency change made to
  satisfy a `e2e/`-only requirement — worth revisiting if the app's runtime
  Node target ever changes independently of the sandbox's. `package.json`.

## From Task 11's app-review pass

The review recipe's static pass (reading every file Plan 3 touched, not
grepping) and the five-flow Playwright suite (run against **both** live
instances — 2.43.1 and 2.40.12 — all ten runs passing) found nothing beyond
the four items above and the two spec-section-9 items that remain genuinely
open (see the spec). One additional, lower-severity item came out of this
pass:

- **LOW: no regression coverage for the integrity tab or text search.**
  `e2e/flows.spec.ts` (Task 9/10) never drives the DHIS2 integrity overlay
  (open a group set's "DHIS2 integrity" tab, run a check) or the text-search
  filter's own correctness as a feature in its own right (it is only used
  incidentally, as a way to locate a row, inside other flows). Both were
  confirmed working live during Task 11's review (a throwaway probe, not
  committed), so this is not a functional defect — it is a gap in the
  regression net around Plan 3's two headline features that a future plan
  touching either area should close before relying on the suite to catch a
  regression there.

## Resolved in Plan 4

- **`@types/node`**: `grep -rln "@types/node\|NodeJS\.\|process\.env" src e2e
  types` matches only `e2e/fixtures/session.ts` and
  `e2e/playwright.config.ts` (both just `process.env.*`); nothing under
  `src/` or `types/` references Node types. The root `tsconfig.json`
  (`include: ["src", "types"]`) does not set `compilerOptions.types` at all,
  so TypeScript's default behaviour auto-includes every `@types/*` package —
  including `@types/node` — as ambient globals for the app build; in
  practice this is inert because no file under `src/` uses a Node global, so
  `tsc --noEmit` is unaffected by `@types/node`'s version either way. `e2e/`
  has its own `e2e/tsconfig.json` with an explicit `"types": ["node"]` and
  `"include": ["."]`, which is what actually scopes Node-type usage to the
  e2e suite; because this is a single pnpm package (no workspaces), the
  dependency itself still has to live in the one shared `devDependencies`
  list, but its only real consumer is `e2e/`. The installed Node is
  `v22.23.2`, and `pnpm why @types/node` resolves every one of the ~1,100
  entries in the dependency tree to the identical `22.20.2` — nothing
  requires 25.x. The version constraint is therefore left at
  `"@types/node": "^22.20.2"`, unchanged: it already matches the installed
  Node's major version, nothing in the tree pulls in 25.x that would need a
  wider range, and widening to `^22 || ^25` would add flexibility for a
  version nothing currently needs at the cost of an untested resolution
  path. No dependency or lockfile change was made.
