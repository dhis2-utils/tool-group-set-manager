import type { EngineMethod, EngineRequest, EngineResponse } from './protocol'

interface Pending {
    resolve: (v: unknown) => void
    reject: (e: Error) => void
}

export class EngineClient {
    private nextId = 1
    private pending = new Map<number, Pending>()

    constructor(private worker: Worker) {
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the client is the worker's only listener, and client.test.ts's fake worker exposes the on* handlers
        worker.onmessage = (event: MessageEvent<EngineResponse>) => {
            const response = event.data
            const p = this.pending.get(response.id)
            if (!p) {
                return
            }
            this.pending.delete(response.id)
            if (response.ok) {
                p.resolve(response.result)
            } else {
                p.reject(new Error(response.error))
            }
        }
        // A worker that dies (e.g. an out-of-memory crash on a large
        // instance) or sends something the structured-clone algorithm can't
        // deliver otherwise leaves every pending call unresolved forever.
        // Fail them all instead, the same way terminate() does.
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the client is the worker's only listener, and client.test.ts's fake worker exposes the on* handlers
        worker.onerror = (event: ErrorEvent) => {
            this.failAll(new Error(`Engine worker failed: ${event.message}`))
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

    call<T>(method: EngineMethod, ...args: unknown[]): Promise<T> {
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
        this.failAll(new Error('Engine terminated'))
    }
}
