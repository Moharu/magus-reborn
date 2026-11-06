import { afterEach, describe, expect, it } from 'vitest'
import {
    ALLOWED_ORIGIN,
    ALSO_ALLOWED_ORIGIN,
    closeAllSockets,
    connectRegistry,
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

        const res = await upgrade(`/api/lobbies/${code}?playerId=alice-id`, origin)

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

        const res = await upgrade(`/api/lobbies/${code}?playerId=intruder-id`, origin)

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
        const res = await workerFetch('/api/lobbies', { method: 'POST' })

        expect(res.status).toBe(201)
        expect(await res.json()).toEqual({ code: expect.stringMatching(/^[A-Z2-9]{6}$/) })
    })

    it('refuses a disallowed origin with a 403', async () => {
        const res = await workerFetch('/api/lobbies', { method: 'POST' }, DISALLOWED_ORIGIN)

        expect(res.status).toBe(403)
    })
})
