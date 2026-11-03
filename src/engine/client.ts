import type { EngineMethod, EngineRequest, EngineResponse } from './protocol'

interface Pending {
    resolve: (v: unknown) => void
    reject: (e: Error) => void
}

export class EngineClient {
    private nextId = 1
    private pending = new Map<number, Pending>()
    /**
     * Set once the worker has failed or been terminated. Every later call
     * rejects with it straight away: posting to a dead worker is a silent
     * no-op, so a call made after the failure would otherwise never settle.
     */
    private dead: Error | null = null
    private revision = 0
    private revisionListeners = new Set<(revision: number) => void>()

    constructor(private worker: Worker) {
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the client is the worker's only listener, and client.test.ts's fake worker exposes the on* handlers
        worker.onmessage = (event: MessageEvent<EngineResponse>) => {
            const response = event.data
            const p = this.pending.get(response.id)
            if (p) {
                this.pending.delete(response.id)
                if (response.ok) {
                    p.resolve(response.result)
                } else {
                    p.reject(new Error(response.error))
                }
            }
            // After the caller's own promise settles, so a caller awaiting
            // a write sees its result before views re-ask their questions.
            this.noteRevision(response.revision)
        }
        // A worker that dies (e.g. an out-of-memory crash on a large
        // instance) or sends something the structured-clone algorithm can't
        // deliver otherwise leaves every pending call unresolved forever.
        // Fail them all instead, the same way terminate() does, and every
        // later call too.
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the client is the worker's only listener, and client.test.ts's fake worker exposes the on* handlers
        worker.onerror = (event: ErrorEvent) => {
            this.dead = new Error(`Engine worker failed: ${event.message}`)
            this.failAll(this.dead)
        }
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the client is the worker's only listener, and client.test.ts's fake worker exposes the on* handlers
        worker.onmessageerror = () => {
            this.failAll(new Error('Engine worker sent an unreadable message'))
        }
    }

    private failAll(error: Error): void {
        this.pending.forEach((p) => p.reject(error))
        this.pending.clear()
    }

    private noteRevision(revision: number | undefined): void {
        if (typeof revision !== 'number' || revision === this.revision) {
            return
        }
        this.revision = revision
        this.revisionListeners.forEach((listener) => listener(revision))
    }

    /**
     * Calls `listener` whenever the engine's data changes (see
     * `EngineStore.revision`), whoever asked for the change. Returns the
     * unsubscribe function.
     */
    onRevision(listener: (revision: number) => void): () => void {
        this.revisionListeners.add(listener)
        return () => {
            this.revisionListeners.delete(listener)
        }
    }

    call<T>(method: EngineMethod, ...args: unknown[]): Promise<T> {
        if (this.dead) {
            return Promise.reject(this.dead)
        }
        const id = this.nextId++
        const request: EngineRequest = { id, method, args }
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, {
                resolve: resolve as (v: unknown) => void,
                reject,
            })
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker#postMessage takes no target origin; that argument is window.postMessage's
            this.worker.postMessage(request)
        })
    }

    terminate(): void {
        this.worker.terminate()
        this.dead = new Error('Engine terminated')
        this.failAll(this.dead)
        this.revisionListeners.clear()
    }
}
