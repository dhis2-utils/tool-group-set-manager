# Group Set Integrity Tool

> ![Maturity: Experimental](https://img.shields.io/badge/maturity-Experimental-orange).  
> Intended use: Identify and resolve integrity issues of group sets in DHIS2.  
> Maintainers: HISP Centre implementation team.
>
> **WARNING**  
> This tool is intended to be used by system administrators, not end users. It is available as a DHIS2 app, but has not been through the same rigorous testing as normal core apps. It should be used with care, and always tested in a development environment.

A DHIS2 application for finding and fixing broken group set membership.

Group sets carry two properties that make membership a correctness question
rather than a matter of taste. A **compulsory** set requires every object of
its type to be in one of its groups. A **data dimension** set is used to
aggregate, so an object in two of its groups is counted twice and an object
in none disappears from the total. Neither property is enforced on write, so
a large instance accumulates violations quietly: an org unit in both `Public`
and `Private` of an ownership set, a facility in no ownership group at all.

This tool finds those objects, shows them in the scope a user actually works
in, and fixes them in bulk — with a preview before anything is written and an
undo afterwards.

## What it does

- **Dashboard** — one card per group set, per object type, with conflict,
  missing and OK counts for the selected scope. For users holding the
  maintenance authority, DHIS2's own data integrity result is shown beside
  the app's count, labelled with when it last ran.
- **Group set detail** — a summary matrix of org units against groups; a
  virtualised, searchable object list with an inline membership control; and,
  for admins, a tab reconciling DHIS2's national integrity numbers against
  the app's own scoped ones.
- **Bulk fix** — pick an action, preview exactly what will change (with a CSV
  of the full list), then apply it in batches, each reconciled against what
  the server says it accepted. A catch-all "Other/unknown" group can be
  created for a set that lacks one.
- **History** — every change set the app wrote, revertible. A revert previews
  against current state and skips objects that have since moved elsewhere.
- **Settings** — required levels per set, the catch-all mapping, the tracker
  toggle, SQL view status with create and repair, and a cache reset.

## Requirements

DHIS2 **2.40 or later**; verified on 2.40, 2.41, 2.42 and 2.43.

On large instances the app reads organisation units through three SQL views
(`GSI_*`), which Settings can create for you. They are effectively a
prerequisite past a few tens of thousands of org units: on a 266,000 org unit
instance the metadata API path did not finish in 640 seconds, while the SQL
view path loads in about 45 seconds cold and 5 warm.

## How it works

Validation runs in a Web Worker over typed arrays, not in React. The whole
population is loaded once, indexed by a depth-first numbering of the
hierarchy, and every count, filter and drill-down after that is answered
in-memory. The engine (`src/engine`) is pure TypeScript with no React and no
DHIS2 imports, so it can be tested directly and can be reasoned about
independently of the UI.

Writes are batched and each batch is reconciled against the server's reported
counts, because DHIS2 silently drops invalid ids from a collection update: a
batch is treated as applied only when the server confirms every id in it.

See `CLAUDE.md` for the architecture decisions and the conventions this
codebase follows, `docs/superpowers/specs/` for the design, and
`docs/superpowers/notes/` for what was measured against live servers —
version compatibility, write semantics, the integrity API's differences
across versions, and performance at scale.

## Development

```bash
pnpm install
pnpm start --proxy https://your-dhis2-instance/
```

| Command         | Purpose                                  |
| --------------- | ---------------------------------------- |
| `pnpm start`    | Development server with hot reload       |
| `pnpm test`     | Jest unit and component tests            |
| `pnpm lint`     | ESLint, Prettier and the e2e type-check  |
| `pnpm test:e2e` | Playwright suite against a live instance |
| `pnpm build`    | Production bundle in `build/bundle/`     |

The Playwright suite expects a DHIS2 instance to test against; see
`e2e/playwright.config.ts` for the environment variables it reads.

## Known limitations

Recorded in `docs/superpowers/notes/2026-09-plan3-carry-forward.md`, and worth
reading before relying on the app for a large migration. The significant one:
a bulk apply over tens of thousands of objects takes minutes, dominated by
DHIS2's own collection-update endpoint rather than by this app.

## License

BSD-3-Clause. See `LICENSE`.
