# Group Set Integrity Tool

> ![Maturity: Experimental](https://img.shields.io/badge/maturity-Experimental-orange)  
> Intended use: Identify and resolve integrity issues of group sets in DHIS2.  
> Maintainers: HISP Centre implementation team.

> [!WARNING]
> This tool is intended for system administrators, not end users. It changes
> group membership in bulk. It has not been through the same testing as the
> DHIS2 core apps, so try it on a copy of your database first.

A DHIS2 app that finds objects in more than one group of a group set, or in
no group of a compulsory or data dimension set, and fixes them in bulk with a
preview and an undo.

User documentation, including the known limitations, is in
[`docs/user/`](docs/user/tool-group-set-manager.md).

## Supported DHIS2 versions

DHIS2 2.40 to 2.43 (`minDHIS2Version` is 2.40 in `d2.config.js`).

## Prerequisites

- Node.js 22 and pnpm 10 (the exact version is pinned in `package.json`
  under `packageManager`; `corepack enable` picks it up).
- A DHIS2 instance to run against. For a local one, see
  [DHIS2 in Docker](https://developers.dhis2.org/docs/tutorials/dhis2-docker/).

## Install and run

```bash
pnpm install
pnpm start --proxy http://localhost:8080
```

`pnpm start` serves the app with hot reload and proxies API calls to the
instance given in `--proxy`. Sign in with a user of that instance.

## Test, lint and build

| Command                  | Purpose                                                 |
| ------------------------ | ------------------------------------------------------- |
| `pnpm test`              | Jest unit and component tests                           |
| `pnpm run lint`          | Ultracite (Oxlint and Oxfmt) over the DHIS2 house style |
| `pnpm exec tsc --noEmit` | Type check                                              |
| `pnpm run build`         | Production bundle in `build/bundle/`                    |
| `e2e/run.sh`             | End-to-end suite against a throwaway instance           |

The end-to-end suite installs the built bundle, seeds and deletes its own
metadata, and must only run against a throwaway instance. See
[`e2e/README.md`](e2e/README.md).

## How it works

Validation runs in a Web Worker over typed arrays, not in React. The whole
population is loaded once, indexed by a depth-first numbering of the
hierarchy, and every count, filter and drill-down after that is answered in
memory. The engine (`src/engine`) is pure TypeScript with no React and no
DHIS2 imports, and is tested directly.

On large instances the app reads organisation units through `GSI_*` SQL
views, which Settings can create. Writes are batched, and each batch is
reconciled against the counts the server reports, because DHIS2 silently
drops invalid ids from a collection update.

`CLAUDE.md` records the architecture decisions and code conventions.
`docs/developer/` records the measured DHIS2 behaviour the code relies on and
the formats the app stores on the server.

## Release

Releases follow the
[release procedure](https://github.com/dhis2-utils/reference-tool-conventions/blob/main/RELEASE-WORKFLOW.md)
of the tool conventions: bump `version` in `package.json`, add a section to
`CHANGELOG.md`, merge to `main`, then push a `vX.Y.Z` tag. The release
workflow builds the bundle and attaches it to a GitHub release.

## License

BSD-3-Clause. See `LICENSE`.
