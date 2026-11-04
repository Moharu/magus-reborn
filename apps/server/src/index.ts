import { LOBBY_CODE_PATTERN } from '@magus/engine/protocol'
import { lobbyOf, registryOf, type Env } from './env'

export { LobbyRegistry } from './registry'
export { LobbyRoom } from './lobby-room'

const originAllowed = (request: Request, env: Env) => {
    const allowed = env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    if (allowed.includes('*')) return true
    const origin = request.headers.get('Origin')
    return origin !== null && allowed.includes(origin)
}

const corsHeaders = (request: Request, env: Env): Record<string, string> => ({
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGINS.includes('*') ? '*' : (request.headers.get('Origin') ?? ''),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
})

const json = (body: unknown, status: number, headers: Record<string, string>) =>
    new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } })

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url)
        const cors = corsHeaders(request, env)
        const isUpgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket'

        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
        if (url.pathname === '/health') return json({ ok: true }, 200, cors)
        if (!originAllowed(request, env)) return json({ error: 'Origin not allowed' }, 403, cors)

        if (url.pathname === '/api/lobbies') {
            if (isUpgrade) return registryOf(env).fetch(request)
            if (request.method === 'POST') {
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
            return lobbyOf(env, code).fetch(request)
        }

        return json({ error: 'Not found' }, 404, cors)
    },
} satisfies ExportedHandler<Env>
