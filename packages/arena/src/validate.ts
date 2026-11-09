/** Small helpers for the profile loader: every error names the offending key by its path, e.g. `fakeCast.spell`. */

export class ProfileError extends Error {
    constructor(
        /** The key the error is about, as a path such as `counterspell.reaction.meanSeconds` or `rotation[2]`. */
        readonly key: string,
        message: string,
    ) {
        super(`${key}: ${message}`)
        this.name = 'ProfileError'
    }
}

/** A function declaration, not an arrow, so TypeScript narrows after a call to it. */
export function fail(key: string, message: string): never {
    throw new ProfileError(key, message)
}

export const isRecord = (raw: unknown): raw is Record<string, unknown> =>
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)

/** An object with exactly the keys it may have: rejects the first unknown key. */
export const onlyKeys = (raw: Record<string, unknown>, allowed: readonly string[], path: string) => {
    for (const key of Object.keys(raw)) {
        if (!allowed.includes(key)) fail(path ? `${path}.${key}` : key, `unknown key (allowed: ${allowed.join(', ')})`)
    }
}

export const record = (raw: unknown, path: string, allowed: readonly string[]) => {
    if (!isRecord(raw)) fail(path, 'must be an object')
    const value = raw as Record<string, unknown>
    onlyKeys(value, allowed, path)
    return value
}

/** A finite number in [min, max]; an integer if `integer`. */
export const number = (raw: unknown, path: string, min: number, max: number, integer = false) => {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) fail(path, `must be a number, got ${JSON.stringify(raw)}`)
    const value = raw as number
    if (integer && !Number.isInteger(value)) fail(path, `must be an integer, got ${value}`)
    if (value < min || value > max) fail(path, `must be in [${min}, ${max}], got ${value}`)
    return value
}

export const boolean = (raw: unknown, path: string) => {
    if (typeof raw !== 'boolean') fail(path, `must be true or false, got ${JSON.stringify(raw)}`)
    return raw as boolean
}

export const string = (raw: unknown, path: string, maxLength: number) => {
    if (typeof raw !== 'string' || raw.length === 0) fail(path, 'must be a non-empty string')
    const value = raw as string
    if (value.length > maxLength || value.includes('\n')) fail(path, `must be one line of at most ${maxLength} chars`)
    return value
}
