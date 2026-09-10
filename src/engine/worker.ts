/// <reference lib="webworker" />
import { EngineRequest, EngineResponse } from './protocol'
import { EngineStore } from './store'

const store = new EngineStore()

self.onmessage = (event: MessageEvent<EngineRequest>) => {
    const { id, method, args } = event.data
    let response: EngineResponse
    try {
        const fn = (
            store as unknown as Record<string, (...a: unknown[]) => unknown>
        )[method]
        if (typeof fn !== 'function') {
            throw new Error(`Unknown engine method ${method}`)
        }
        const result = fn.apply(store, args)
        response = { id, ok: true, result }
    } catch (error) {
        response = {
            id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        }
    }
    self.postMessage(response)
}
