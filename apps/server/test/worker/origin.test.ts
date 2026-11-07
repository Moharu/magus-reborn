import { VERSION_QUERY } from '@magus/engine/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import {
    ALLOWED_ORIGIN,
    ALSO_ALLOWED_ORIGIN,
    closeAllSockets,
    connectRegistry,
    CREATE_LOBBY_PATH,
    createLobby,
    DISALLOWED_ORIGIN,
    join,
    lobbyClientFrom,
    upgrade,
    workerFetch,
} from './helpers'

afterEach(closeAllSockets)

describe('WebSocket upgrade origin check', () => {
    it.each([
        ['the first allowed origin', ALLOWED_ORIGIN],
        ['a later allowed origin', ALSO_ALLOWED_ORIGIN],
    ])('upgrades a lobby connection from %s', async (_, origin) => {
        const code = await createLobby()

        const res = await upgrade(`/api/lobbies/${code}?playerId=alice-id&${VERSION_QUERY}`, origin)

        expect(res.status).toBe(101)
        expect(await lobbyClientFrom(res).next('welcome')).toMatchObject({ role: 'player1' })
    })

    it.each([
        ['a disallowed origin', DISALLOWED_ORIGIN],
        ['a missing origin', null],
        ['an allowed origin with a different scheme', ALLOWED_ORIGIN.replace('https:', 'http:')],
        ['a suffix of an allowed origin', 'https://not-allowed.example'],
    ])('refuses a lobby connection from %s with a 403', async (_, origin) => {
        const code = await createLobby()

        const res = await upgrade(`/api/lobbies/${code}?playerId=intruder-id&${VERSION_QUERY}`, origin)

        expect(res.status).toBe(403)
        expect(res.webSocket).toBeNull()
        expect(await res.json()).toEqual({ error: 'Origin not allowed' })
        // the refused request never reached the room, so it holds no seat
        const { welcome } = await join(code, 'alice-id')
        expect(welcome.role).toBe('player1')
    })

    it('upgrades a lobby list connection from an allowed origin', async () => {
        const registry = await connectRegistry()

        expect(await registry.waitFor(message => message.t === 'lobbies')).toMatchObject({ lobbies: expect.any(Array) })
    })

    it('refuses a lobby list connection from a disallowed origin with a 403', async () => {
        const res = await upgrade('/api/lobbies', DISALLOWED_ORIGIN)

        expect(res.status).toBe(403)
        expect(res.webSocket).toBeNull()
    })
})

describe('lobby creation origin check', () => {
    it('creates a lobby for an allowed origin', async () => {
        const res = await workerFetch(CREATE_LOBBY_PATH, { method: 'POST' })

        expect(res.status).toBe(201)
        expect(await res.json()).toEqual({ code: expect.stringMatching(/^[A-Z2-9]{6}$/) })
    })

    it('refuses a disallowed origin with a 403', async () => {
        const res = await workerFetch(CREATE_LOBBY_PATH, { method: 'POST' }, DISALLOWED_ORIGIN)

        expect(res.status).toBe(403)
    })

    it('refuses a missing origin with a 403', async () => {
        const res = await workerFetch(CREATE_LOBBY_PATH, { method: 'POST' }, null)

        expect(res.status).toBe(403)
    })
})

describe('CORS headers', () => {
    const expectNoCors = (res: Response) => {
        const cors = [...res.headers.keys()].filter(name => name.startsWith('access-control-'))
        expect(cors).toEqual([])
        expect(res.headers.get('Vary')).toBe('Origin')
    }
    const expectCorsFor = (res: Response, origin: string) => {
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin)
        expect(res.headers.get('Vary')).toBe('Origin')
    }

    const refusedOrigins: [string, string | null][] = [
        ['a disallowed origin', DISALLOWED_ORIGIN],
        ['a missing origin', null],
    ]

    describe.each(refusedOrigins)('from %s', (_, origin) => {
        it('refuses a preflight with a 403 and no CORS headers', async () => {
            const res = await workerFetch('/api/lobbies', { method: 'OPTIONS' }, origin)

            expect(res.status).toBe(403)
            expectNoCors(res)
        })

        it('refuses a preflight to /health with a 403 and no CORS headers', async () => {
            const res = await workerFetch('/health', { method: 'OPTIONS' }, origin)

            expect(res.status).toBe(403)
            expectNoCors(res)
        })

        it('sends no CORS headers on a refused POST', async () => {
            const res = await workerFetch(CREATE_LOBBY_PATH, { method: 'POST' }, origin)

            expect(res.status).toBe(403)
            expect(await res.json()).toEqual({ error: 'Origin not allowed' })
            expectNoCors(res)
        })

        it('sends no CORS headers on a refused upgrade', async () => {
            const res = await upgrade('/api/lobbies', origin)

            expect(res.status).toBe(403)
            expectNoCors(res)
        })

        it('refuses an unknown path with a 403 rather than a 404', async () => {
            const res = await workerFetch('/nope', {}, origin)

            expect(res.status).toBe(403)
            expectNoCors(res)
        })

        it('still answers /health, with no CORS headers', async () => {
            const res = await workerFetch('/health', {}, origin)

            expect(res.status).toBe(200)
            expect(await res.json()).toEqual({ ok: true })
            expectNoCors(res)
        })
    })

    describe.each([
        ['the first allowed origin', ALLOWED_ORIGIN],
        ['a later allowed origin', ALSO_ALLOWED_ORIGIN],
    ])('from %s', (_, origin) => {
        it('answers a preflight with its own origin only', async () => {
            const res = await workerFetch('/api/lobbies', { method: 'OPTIONS' }, origin)

            expect(res.status).toBe(204)
            expectCorsFor(res, origin)
            expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS')
            expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type')
        })

        it('lets the client read a created lobby', async () => {
            const res = await workerFetch(CREATE_LOBBY_PATH, { method: 'POST' }, origin)

            expect(res.status).toBe(201)
            expectCorsFor(res, origin)
        })

        it('lets the client read an error', async () => {
            const res = await workerFetch('/nope', {}, origin)

            expect(res.status).toBe(404)
            expectCorsFor(res, origin)
        })

        it('answers /health with its own origin', async () => {
            const res = await workerFetch('/health', {}, origin)

            expect(res.status).toBe(200)
            expectCorsFor(res, origin)
        })
    })
})
