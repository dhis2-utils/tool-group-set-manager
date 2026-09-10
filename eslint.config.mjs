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
])
