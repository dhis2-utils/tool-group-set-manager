export function createEngineWorker(): Worker {
    // Vite turns this pattern into a separate worker bundle.
    return new Worker(new URL('./worker.ts', import.meta.url), {
        type: 'module',
    })
}
