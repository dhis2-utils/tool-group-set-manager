export function createEngineWorker(): Worker {
    // Vite turns this pattern into a separate worker bundle.
    // oxlint-disable-next-line unicorn/relative-url-style -- keeps the ./ form Vite documents for bundling a worker; not worth the risk of a worker that silently fails to load
    return new Worker(new URL('./worker.ts', import.meta.url), {
        type: 'module',
    })
}
