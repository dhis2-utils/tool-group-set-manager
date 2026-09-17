import config from '@dhis2/config-eslint'
import { defineConfig } from 'eslint/config'
import { includeIgnoreFile } from '@eslint/compat'
import { fileURLToPath } from 'node:url'

const gitignorePath = fileURLToPath(new URL('.gitignore', import.meta.url))

export default defineConfig([
    includeIgnoreFile(gitignorePath, 'Imported .gitignore patterns'),
    {
        extends: [config],
        settings: {
            'import/resolver': {
                typescript: {},
            },
        },
    },
    {
        // The engine's signatures are fixed positional contracts consumed by
        // the worker protocol, so they routinely exceed the default max-params.
        files: ['src/engine/**'],
        rules: {
            'max-params': 'off',
        },
    },
    {
        // writeMemberships' signature (fetcher, objectType, changes,
        // onProgress, batchSize) is the fixed contract Tasks 5, 6, 8 and 9
        // are written against; see task-4-brief.md.
        files: ['src/data/writes.ts'],
        rules: {
            'max-params': 'off',
        },
    },
    {
        // readGroupMembers' signature (fetcher, objectType, groupIds,
        // signal) is the fixed contract task-10-brief.md specifies.
        files: ['src/data/groupMembers.ts'],
        rules: {
            'max-params': 'off',
        },
    },
])
