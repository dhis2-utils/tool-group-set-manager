import { act, renderHook } from '@testing-library/react'
import { useSessionState } from './useSessionState'

const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean'

beforeEach(() => {
    sessionStorage.clear()
})

test('starts from the initial value when nothing is stored', () => {
    const { result } = renderHook(() => useSessionState('k', true, isBoolean))
    expect(result.current[0]).toBe(true)
})

test('hands a later mount the value an earlier one set', () => {
    const first = renderHook(() => useSessionState('k', true, isBoolean))
    act(() => {
        first.result.current[1](false)
    })
    expect(first.result.current[0]).toBe(false)
    first.unmount()

    const second = renderHook(() => useSessionState('k', true, isBoolean))
    expect(second.result.current[0]).toBe(false)
})

test('falls back to the initial value when the stored value fails the guard', () => {
    sessionStorage.setItem('k', JSON.stringify('not a boolean'))
    const { result } = renderHook(() => useSessionState('k', true, isBoolean))
    expect(result.current[0]).toBe(true)
})

test('falls back to the initial value when the stored value is not JSON', () => {
    sessionStorage.setItem('k', '{oops')
    const { result } = renderHook(() => useSessionState('k', true, isBoolean))
    expect(result.current[0]).toBe(true)
})

test('keeps the value in state when storage refuses the write', () => {
    const spy = jest
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementation(() => {
            throw new Error('quota')
        })
    const { result } = renderHook(() => useSessionState('k', true, isBoolean))
    act(() => {
        result.current[1](false)
    })
    expect(result.current[0]).toBe(false)
    spy.mockRestore()
})
