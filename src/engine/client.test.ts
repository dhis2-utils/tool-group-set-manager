import { EngineClient } from './client'
import { EngineRequest, EngineResponse } from './protocol'

class FakeWorker {
    onmessage: ((e: MessageEvent<EngineResponse>) => void) | null = null
    sent: EngineRequest[] = []
    postMessage(req: EngineRequest) {
        this.sent.push(req)
        const reply = (response: EngineResponse) =>
            this.onmessage?.({ data: response } as MessageEvent<EngineResponse>)
        if (req.method === 'indexOf') {
            setTimeout(() => reply({ id: req.id, ok: true, result: 7 }), 0)
        } else {
            setTimeout(() => reply({ id: req.id, ok: false, error: 'boom' }), 0)
        }
    }
    terminate() {}
}

describe('EngineClient', () => {
    it('resolves with the worker result', async () => {
        const client = new EngineClient(new FakeWorker() as unknown as Worker)
        await expect(client.call<number>('indexOf', 'organisationUnit', 'x')).resolves.toBe(7)
    })

    it('rejects with the worker error and matches responses by id', async () => {
        const worker = new FakeWorker()
        const client = new EngineClient(worker as unknown as Worker)
        const a = client.call('indexOf', 'organisationUnit', 'x')
        const b = client.call('evaluate')
        await expect(b).rejects.toThrow('boom')
        await expect(a).resolves.toBe(7)
        expect(worker.sent.map((r) => r.id)).toEqual([1, 2])
    })
})
