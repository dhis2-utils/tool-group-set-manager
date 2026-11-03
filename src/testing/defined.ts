/**
 * Returns `value`, or fails the test when it is null or undefined. Use it
 * where a test needs a value it has just read back to exist, instead of a
 * non-null assertion that would let a missing value through.
 */
export function defined<T>(value: T | null | undefined): T {
    if (value === null || value === undefined) {
        throw new Error('Expected a value, got ' + String(value))
    }
    return value
}
