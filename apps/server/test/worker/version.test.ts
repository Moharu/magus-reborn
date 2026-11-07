import { ENGINE_VERSION } from '@magus/engine'
import { VERSION_PARAM } from '@magus/engine/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import {
    ALLOWED_ORIGIN,
    closeAllSockets,
    connectRegistry,
    createLobby,
    DISALLOWED_ORIGIN,
    join,
    lobbyClientFrom,
    lobbyWithTwoPlayers,
    upgrade,
    workerFetch,
    type LobbyClient,
} from './helpers'

afterEach(closeAllSockets)

/** Spelled out rather than the constants: tabs already open depend on this wording and these values. */
const VERSION_ERROR = {
    t: 'error',
    code: 'version_mismatch',
    message: 'A new version is available, please refresh',
    fatal: true,
}

const STALE = 'reborn-0.0.0-stale'

/** The query string each kind of unacceptable client sends. */
const BAD_VERSIONS: [string, string][] = [
    ['no version', ''],
    ['an empty version', `${VERSION_PARAM}=`],
    ['an older version', `${VERSION_PARAM}=${STALE}`],
    ['the right version with extra text', `${VERSION_PARAM}=${ENGINE_VERSION}x`],
    ['the right version in the wrong case', `${VERSION_PARAM}=${ENGINE_VERSION.toUpperCase()}`],
    ['the right version under another name', `version=${ENGINE_VERSION}`],
]

/** Connects with this query string, which is otherwise a normal request for a seat. */
const connectWith = async (code: string, playerId: string, query: string) =>
    lobbyClientFrom(await upgrade(`/api/lobbies/${code}?playerId=${playerId}&name=Stale&${query}`))

const staleClient = (code: string, playerId: string) => connectWith(code, playerId, `${VERSION_PARAM}=${STALE}`)

const expectRefused = async (client: LobbyClient) => {
    expect(await client.next('error')).toEqual(VERSION_ERROR)
    expect(await client.closed).toMatchObject({ code: 4426, reason: VERSION_ERROR.message })
}

describe('creating a lobby', () => {
    it('creates one for a client on the same version', async () => {
        const res = await workerFetch(`/api/lobbies?${VERSION_PARAM}=${ENGINE_VERSION}`, { method: 'POST' })

        expect(res.status).toBe(201)
        expect(await res.json()).toEqual({ code: expect.stringMatching(/^[A-Z2-9]{6}$/) })
    })

    it.each(BAD_VERSIONS)('refuses a client with %s, in a way the browser can read', async (_, query) => {
        const res = await workerFetch(`/api/lobbies?${query}`, { method: 'POST' })

        expect(res.status).toBe(409)
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN)
        // no lobby code, since none was reserved
        expect(await res.json()).toEqual({ error: VERSION_ERROR.message, errorCode: VERSION_ERROR.code })
    })

    it('checks the origin first', async () => {
        const res = await workerFetch(`/api/lobbies?${VERSION_PARAM}=${STALE}`, { method: 'POST' }, DISALLOWED_ORIGIN)

        expect(res.status).toBe(403)
        expect(await res.json()).toEqual({ error: 'Origin not allowed' })
    })
})

describe('joining a lobby', () => {
    it('seats a client on the same version', async () => {
        const code = await createLobby()

        const client = await connectWith(code, 'alice-id', `${VERSION_PARAM}=${ENGINE_VERSION}`)

        expect(await client.next('welcome')).toMatchObject({ role: 'player1' })
    })

    it.each(BAD_VERSIONS)('refuses a client with %s and seats nobody', async (_, query) => {
        const code = await createLobby()
        const { client: alice } = await join(code, 'alice-id', 'Alice')
        await alice.nextLobby(lobby => lobby.player1 !== null)

        await expectRefused(await connectWith(code, 'bob-id', query))

        // nothing reached the room, so nothing was broadcast and the seat is still open
        expect(await alice.sync()).toEqual([])
        const { welcome } = await join(code, 'bob-id', 'Bob')
        expect(welcome.role).toBe('player2')
    })

    it('does not start a match for a player who was refused', async () => {
        const code = await createLobby()
        const { client: alice } = await join(code, 'alice-id', 'Alice')
        await expectRefused(await staleClient(code, 'bob-id'))

        alice.send({ t: 'ready' })

        expect(await alice.nextLobby(lobby => lobby.player1!.ready)).toMatchObject({
            matchStarted: false,
            phase: 'lobby',
            player2: null,
        })
    })

    it('says the same for a lobby that does not exist, since the check comes before the room', async () => {
        await expectRefused(await staleClient('AAAAAA', 'alice-id'))
    })

    it('still answers a code that could never exist with a 400', async () => {
        const res = await upgrade(`/api/lobbies/not-a-code?${VERSION_PARAM}=${STALE}`)

        expect(res.status).toBe(400)
    })

    it('checks the origin first', async () => {
        const code = await createLobby()

        const res = await upgrade(`/api/lobbies/${code}?playerId=x&${VERSION_PARAM}=${STALE}`, DISALLOWED_ORIGIN)

        expect(res.status).toBe(403)
        expect(res.webSocket).toBeNull()
    })
})

describe('spectators', () => {
    it('refuses one on a different version, leaving the spectator slots alone', async () => {
        const { code, alice, bob } = await lobbyWithTwoPlayers()

        await expectRefused(await staleClient(code, 'carol-id'))

        expect(await alice.sync()).toEqual([])
        expect(await bob.sync()).toEqual([])
    })

    it('still lets one on the same version watch', async () => {
        const { code } = await lobbyWithTwoPlayers()

        const { welcome } = await join(code, 'carol-id', 'Carol')

        expect(welcome.role).toBe('spectator')
    })
})

describe('a stale tab next to a running match', () => {
    /** Seats lock as soon as both players are ready, so this needs no countdown to run out. */
    const startedMatch = async () => {
        const { code, alice, bob } = await lobbyWithTwoPlayers()
        alice.send({ t: 'ready' })
        bob.send({ t: 'ready' })
        await alice.nextLobby(lobby => lobby.matchStarted)
        await bob.nextLobby(lobby => lobby.matchStarted)
        return { code, alice, bob }
    }

    it("does not take over the same player's live connection before a match", async () => {
        const code = await createLobby()
        const { client: alice } = await join(code, 'alice-id', 'Alice')
        await alice.nextLobby(lobby => lobby.player1 !== null)

        await expectRefused(await staleClient(code, 'alice-id'))

        // a tab on the right version would have closed this one with "Connected from another tab"
        expect(await alice.sync()).toEqual([])
    })

    it("does not take over or pause a player's live connection during a match", async () => {
        const { code, alice, bob } = await startedMatch()

        await expectRefused(await staleClient(code, 'bob-id'))

        const seen = [...(await alice.sync()), ...(await bob.sync())]
        // the match start countdown may tick here, but nobody dropped and nothing paused
        for (const message of seen) {
            expect(message).toMatchObject({
                t: 'meta',
                lobby: { paused: false, player1: { connected: true }, player2: { connected: true } },
            })
        }
    })

    it('keeps a dropped player from resuming until they refresh, and gives the seat back when they do', async () => {
        const { code, alice, bob } = await startedMatch()
        bob.close()
        await alice.nextLobby(lobby => lobby.paused)

        await expectRefused(await staleClient(code, 'bob-id'))

        // the same pause and the same grace period as any other drop: the refused attempt changed nothing
        expect(await alice.sync()).toEqual([])

        const { welcome } = await join(code, 'bob-id', 'Bob')

        expect(welcome.role).toBe('player2')
        expect(await alice.nextLobby(lobby => !lobby.paused)).toMatchObject({
            matchStarted: true,
            player2: { name: 'Bob', connected: true },
        })
    })
})

describe('what the check leaves open', () => {
    it('serves the public lobby list without a version', async () => {
        const registry = await connectRegistry()

        expect(await registry.waitFor(message => message.t === 'lobbies')).toMatchObject({ lobbies: expect.any(Array) })
    })

    it('answers a preflight without a version, which the deploy check relies on', async () => {
        const res = await workerFetch('/api/lobbies', { method: 'OPTIONS' })

        expect(res.status).toBe(204)
    })

    it('answers /health without a version', async () => {
        const res = await workerFetch('/health', {}, null)

        expect(res.status).toBe(200)
    })
})
