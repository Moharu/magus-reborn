/**
 * Returns `origin` if the comma separated `allowedOrigins` lists it exactly, otherwise null. There are no wildcards, so
 * a `*` in the list allows nothing.
 *
 * This only stops other websites from using the server through a visitor's browser. A non-browser client can send any
 * Origin it likes, so it doesn't authenticate anyone.
 */
export const allowedOrigin = (origin: string | null, allowedOrigins: string): string | null => {
    if (!origin || origin === '*') return null
    return allowedOrigins
        .split(',')
        .map(o => o.trim())
        .includes(origin)
        ? origin
        : null
}

/** CORS headers for an `allowedOrigin` result. A request whose origin isn't allowed gets none of them. */
export const corsHeaders = (allowed: string | null): Record<string, string> => ({
    // The response depends on the request's Origin whether or not it's allowed, so caches must always key on it.
    Vary: 'Origin',
    ...(allowed !== null && {
        'Access-Control-Allow-Origin': allowed,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    }),
})
