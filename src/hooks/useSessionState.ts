import { useCallback, useState } from 'react'

/**
 * `useState` whose value survives leaving and re-entering the page within
 * one browser session. Manual review 2: the dashboard's Show / Object type
 * / Sort by choices were plain component state, so opening a group set and
 * coming back to the dashboard silently put every filter back to its
 * default -- the same loss the scope was already protected from
 * (useScope.tsx's sessionStorage entry), for the same reason.
 *
 * `isValid` is the type guard the stored JSON has to pass; anything else
 * (an older build's value, a hand-edited entry, a corrupt string) falls
 * back to `initial` rather than reaching the page. Storage failures are
 * ignored in both directions: the choice still lives in state for as long
 * as the page does, exactly as it did before.
 */
export function useSessionState<T>(
    key: string,
    initial: T,
    isValid: (value: unknown) => value is T
): [T, (value: T) => void] {
    const [value, setState] = useState<T>(() => {
        try {
            const raw = sessionStorage.getItem(key)
            if (raw === null) {
                return initial
            }
            const parsed: unknown = JSON.parse(raw)
            return isValid(parsed) ? parsed : initial
        } catch {
            return initial
        }
    })
    const setValue = useCallback(
        (next: T) => {
            setState(next)
            try {
                sessionStorage.setItem(key, JSON.stringify(next))
            } catch {
                // ignore storage failures; the choice still lives in state
            }
        },
        [key]
    )
    return [value, setValue]
}
