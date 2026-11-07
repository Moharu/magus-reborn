import { ENGINE_VERSION } from '@magus/engine'
import {
    LOBBY_CODE_PATTERN,
    NEW_VERSION_MESSAGE,
    VERSION_MISMATCH,
    VERSION_PARAM,
    type ServerMessage,
} from '@magus/engine/protocol'
import { lobbyOf, registryOf, type Env } from './env'
import { allowedOrigin, corsHeaders } from './origin'

export { LobbyRegistry } from './registry'
export { LobbyRoom } from './lobby-room'

const json = (body: unknown, status: number, headers: Record<string, string>) =>
    new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } })

/** The WebSocket close code for a client on a different version. */
const CLOSE_VERSION_MISMATCH = 4426

/**
 * Accepts the upgrade only to say why the connection is over. A browser hides the response to a refused upgrade, so the
 * client would see a dropped connection and keep reconnecting. The room is never involved, which is what keeps a stale
 * tab from taking a seat or a spectator slot, or from replacing the same player's live connection.
 */
const versionMismatchSocket = () => {
    const { 0: client, 1: server } = new WebSocketPair()
    server.accept()
    server.send(
        JSON.stringify({
            t: 'error',
            code: VERSION_MISMATCH,
            message: NEW_VERSION_MESSAGE,
            fatal: true,
        } satisfies ServerMessage),
    )
    server.close(CLOSE_VERSION_MISMATCH, NEW_VERSION_MESSAGE)
    return new Response(null, { status: 101, webSocket: client })
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url)
        const origin = allowedOrigin(request.headers.get('Origin'), env.ALLOWED_ORIGINS)
        const cors = corsHeaders(origin)
        const isUpgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
        const versionMatches = url.searchParams.get(VERSION_PARAM) === ENGINE_VERSION

        // Open to any origin, because the deploy workflow checks it with curl, which sends no Origin.
        if (url.pathname === '/health' && request.method !== 'OPTIONS') return json({ ok: true }, 200, cors)
        if (origin === null) return json({ error: 'Origin not allowed' }, 403, cors)
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })

        if (url.pathname === '/api/lobbies') {
            if (isUpgrade) return registryOf(env).fetch(request)
            if (request.method === 'POST') {
                // `errorCode`, because `code` is the lobby code in this response
                if (!versionMatches) {
                    return json({ error: NEW_VERSION_MESSAGE, errorCode: VERSION_MISMATCH }, 409, cors)
                }
                const code = await registryOf(env).reserveCode()
                if (!code) return json({ error: 'Too many open lobbies, try again later' }, 503, cors)
                await lobbyOf(env, code).init(code)
                return json({ code }, 201, cors)
            }
        }

        const match = url.pathname.match(/^\/api\/lobbies\/([^/]+)$/)
        if (match && isUpgrade) {
            const code = match[1].toUpperCase()
            if (!LOBBY_CODE_PATTERN.test(code)) return json({ error: 'Invalid lobby code' }, 400, cors)
            if (!versionMatches) return versionMismatchSocket()
            return lobbyOf(env, code).fetch(request)
        }

        return json({ error: 'Not found' }, 404, cors)
    },
} satisfies ExportedHandler<Env>
