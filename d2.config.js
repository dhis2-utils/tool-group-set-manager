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
