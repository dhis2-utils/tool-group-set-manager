/// <reference lib="webworker" />
import { EngineRequest, EngineResponse } from './protocol'
import { EngineStore } from './store'

const store = new EngineStore()

self.onmessage = (event: MessageEvent<EngineRequest>) => {
    // The id is read inside the try along with everything else: a malformed
    // message (e.g. one that fails structured clone validation, or is
    // missing fields) is then reported back as a failed response for that
    // id rather than throwing outside the handler. If the id itself can't
    // be read, there is no id to answer with, so that case is rethrown to
    // surface via the worker's own onerror instead.
    let id: number | undefined
    let response: EngineResponse
    try {
        const request = event.data
        id = request.id
        const { method, args } = request
        const fn = (
            store as unknown as Record<string, (...a: unknown[]) => unknown>
        )[method]
        if (typeof fn !== 'function') {
            throw new Error(`Unknown engine method ${method}`)
        }
        const result = fn.apply(store, args)
        response = { id, ok: true, result }
    } catch (error) {
        if (id === undefined) {
            throw error
        }
        response = {
            id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        }
    }
    self.postMessage(response)
}
