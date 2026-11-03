import dhis2 from '@dhis2/config-prettier'
import { defineConfig } from 'oxfmt'
import ultracite from 'ultracite/oxfmt'

// Template from dhis2-utils/reference-tool-conventions
// (app-platform/lint/oxfmt.config.mts; see LINTING.md there).
//
// Ultracite complements the DHIS2 house style, it does not replace it: the
// options from @dhis2/config-prettier are spread last, so they win.
// rangeStart/rangeEnd are Prettier-only and Oxfmt rejects them.
const PRETTIER_ONLY = new Set(['rangeStart', 'rangeEnd'])
const dhis2Options = Object.fromEntries(
    Object.entries(dhis2).filter(([key]) => !PRETTIER_ONLY.has(key))
)

export default defineConfig({
    ...ultracite,
    ...dhis2Options,
    // DHIS2 import/order: eslint-plugin-import's default groups (anything
    // else, such as the @/ alias, last), alphabetical, case-insensitive, no
    // blank lines between groups.
    sortImports: {
        groups: [
            'builtin',
            'external',
            'parent',
            'sibling',
            'index',
            'unknown',
        ],
        ignoreCase: true,
        newlinesBetween: false,
        order: 'asc',
    },
    // Keep package.json in the order people wrote it.
    sortPackageJson: false,
})
