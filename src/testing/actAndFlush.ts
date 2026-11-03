import { act } from '@testing-library/react'

/**
 * Runs `callback` in React's async `act()`. After the callback, async act
 * also flushes resolved promises and the work they schedule, which sync
 * `act()` does not. Tests use it where the callback resolves a pending
 * promise or fires an event whose handler awaits something.
 *
 * Returning a promise from a plain function takes the same path in `act()`
 * as an `async` callback, without an `async` function that never awaits.
 */
export function actAndFlush(callback: () => void): Promise<void> {
    return act(() => {
        callback()
        return Promise.resolve()
    })
}
