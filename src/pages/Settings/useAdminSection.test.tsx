import { act, renderHook, waitFor } from '@testing-library/react'
import { useAdminSection } from './useAdminSection'

it('checks on mount and exposes the result', async () => {
    const load = jest.fn(async () => ({ ok: true }))
    const { result } = renderHook(() => useAdminSection(load))
    expect(result.current.checking).toBe(true)
    await waitFor(() => expect(result.current.checking).toBe(false))
    expect(result.current.check).toEqual({ ok: true })
    expect(result.current.checkError).toBeNull()
    expect(load).toHaveBeenCalledTimes(1)
})

it('reports a failed check as checkError with no result, and can retry', async () => {
    const load = jest
        .fn<Promise<{ ok: boolean }>, []>()
        .mockRejectedValueOnce(new Error('HTTP 500'))
        .mockResolvedValueOnce({ ok: true })
    const { result } = renderHook(() => useAdminSection(load))
    await waitFor(() => expect(result.current.checkError).toBe('HTTP 500'))
    expect(result.current.check).toBeNull()
    await act(async () => {
        await result.current.refresh()
    })
    expect(result.current.checkError).toBeNull()
    expect(result.current.check).toEqual({ ok: true })
})

it('is busy while an action runs, then re-checks, even when the action throws', async () => {
    // Brief's version (`const load = jest.fn(async () => ({ n:
    // load.mock.calls.length }))`) fails tsc --noEmit under strict mode:
    // TS7022/TS7024, `load` referenced in its own initializer. Annotating
    // the type up front breaks the inference cycle without changing what
    // the mock does.
    const load: jest.Mock<Promise<{ n: number }>, []> = jest.fn(async () => ({
        n: load.mock.calls.length,
    }))
    const { result } = renderHook(() => useAdminSection(load))
    await waitFor(() => expect(result.current.checking).toBe(false))
    let release: () => void = () => undefined
    const action = jest.fn(
        () =>
            new Promise<void>((_, reject) => {
                release = () => reject(new Error('HTTP 403'))
            })
    )
    let running: Promise<void> | undefined
    act(() => {
        running = result.current.run(action)
    })
    expect(result.current.busy).toBe(true)
    await act(async () => {
        release()
        await running
    })
    expect(result.current.busy).toBe(false)
    expect(result.current.actionError).toBe('HTTP 403')
    expect(load).toHaveBeenCalledTimes(2)
})

it('clears a previous action error when the next action starts', async () => {
    const load = jest.fn(async () => ({}))
    const { result } = renderHook(() => useAdminSection(load))
    await waitFor(() => expect(result.current.checking).toBe(false))
    await act(async () => {
        await result.current.run(async () => {
            throw new Error('first')
        })
    })
    expect(result.current.actionError).toBe('first')
    await act(async () => {
        await result.current.run(async () => undefined)
    })
    expect(result.current.actionError).toBeNull()
})
