import { EngineClient } from './client'
import type { EngineRequest, EngineResponse } from './protocol'

class FakeWorker {
    onmessage: ((e: MessageEvent<EngineResponse>) => void) | null = null
    onerror: ((e: ErrorEvent) => void) | null = null
    onmessageerror: ((e: MessageEvent) => void) | null = null
    sent: EngineRequest[] = []
    postMessage(req: EngineRequest) {
        this.sent.push(req)
        const reply = (response: EngineResponse) =>
            this.onmessage?.({ data: response } as MessageEvent<EngineResponse>)
        if (req.method === 'indexesOf') {
            setTimeout(
                () => reply({ id: req.id, ok: true, result: 7, revision: 3 }),
                0
            )
        } else {
            setTimeout(() => reply({ id: req.id, ok: false, error: 'boom' }), 0)
        }
    }
    terminate() {}
}

describe('EngineClient', () => {
    it('resolves with the worker result', async () => {
        const client = new EngineClient(new FakeWorker() as unknown as Worker)
        await expect(
            client.call<number>('indexesOf', 'organisationUnit', ['x'])
        ).resolves.toBe(7)
    })

    it('rejects with the worker error and matches responses by id', async () => {
        const worker = new FakeWorker()
        const client = new EngineClient(worker as unknown as Worker)
        const a = client.call('indexesOf', 'organisationUnit', ['x'])
        const b = client.call('evaluate')
        await expect(b).rejects.toThrow('boom')
        await expect(a).resolves.toBe(7)
        expect(worker.sent.map((r) => r.id)).toEqual([1, 2])
    })

    it('rejects every in-flight call when the worker errors', async () => {
        const worker = new FakeWorker()
        const client = new EngineClient(worker as unknown as Worker)
        const call = client.call('evaluate')
        worker.onerror?.({ message: 'worker crashed' } as ErrorEvent)
        await expect(call).rejects.toThrow(/worker crashed/)
    })

    it('rejects later calls at once after the worker has died', async () => {
        const worker = new FakeWorker()
        const client = new EngineClient(worker as unknown as Worker)
        worker.onerror?.({ message: 'worker crashed' } as ErrorEvent)
        await expect(client.call('evaluate')).rejects.toThrow(/worker crashed/)
        // Nothing was posted to the dead worker, so nothing can hang on it.
        expect(worker.sent).toHaveLength(0)
    })

    it('rejects calls made after terminate()', async () => {
        const worker = new FakeWorker()
        const client = new EngineClient(worker as unknown as Worker)
        client.terminate()
        await expect(client.call('evaluate')).rejects.toThrow(/terminated/)
    })

    it('tells revision listeners when a response carries a new revision', async () => {
        const client = new EngineClient(new FakeWorker() as unknown as Worker)
        const seen: number[] = []
        const unsubscribe = client.onRevision((r) => seen.push(r))
        await client.call('indexesOf', 'organisationUnit', ['x'])
        // Same revision again: no second notification.
        await client.call('indexesOf', 'organisationUnit', ['x'])
        expect(seen).toEqual([3])
        unsubscribe()
    })
})
