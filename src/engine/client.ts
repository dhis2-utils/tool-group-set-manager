import { EngineMethod, EngineRequest, EngineResponse } from './protocol'

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

export class EngineClient {
    private nextId = 1
    private pending = new Map<number, Pending>()

    constructor(private worker: Worker) {
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
    }

    call<T>(method: EngineMethod, ...args: unknown[]): Promise<T> {
        const id = this.nextId++
        const request: EngineRequest = { id, method, args }
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, {
                resolve: resolve as (v: unknown) => void,
                reject,
            })
            this.worker.postMessage(request)
        })
    }

    terminate(): void {
        this.worker.terminate()
        this.pending.forEach((p) => p.reject(new Error('Engine terminated')))
        this.pending.clear()
    }
}
