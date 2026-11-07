import type { ServerMessage } from '@magus/engine/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { ABUSE_DROP_ALLOWANCE, RATE_LIMIT_BURST } from '../../src/rate-limit'
import { closeAllSockets, join, lobbyWithTwoPlayers, type LobbyClient } from './helpers'

afterEach(closeAllSockets)

const POLICY_VIOLATION = { code: 1008, reason: 'Too many messages' }

/** Twice what it takes to be closed, so the refill during the flood can't save the socket on a slow machine. */
const FLOOD = (RATE_LIMIT_BURST + ABUSE_DROP_ALLOWANCE) * 2

/** Kept apart from the `at` values that `sync` uses. */
const FIRST_FLOOD_AT = 1_000_000

const floodPings = (client: LobbyClient, count: number) => {
    for (let i = 0; i < count; i++) client.send({ t: 'ping', at: FIRST_FLOOD_AT + i })
}

const floodPongs = (messages: ServerMessage[]) =>
    messages.flatMap(message => (message.t === 'pong' && message.at >= FIRST_FLOOD_AT ? [message.at] : []))

const startedMatch = async () => {
    const { code, alice, bob } = await lobbyWithTwoPlayers()
    alice.send({ t: 'ready' })
    bob.send({ t: 'ready' })
    await bob.nextLobby(lobby => lobby.matchStarted)
    return { code, alice, bob }
}

describe('messages over the rate limit', () => {
    it('handles a whole burst', async () => {
        const { alice } = await lobbyWithTwoPlayers()

        floodPings(alice, RATE_LIMIT_BURST)

        const pongs = floodPongs(await alice.syncOverLimit())
        expect(pongs).toEqual(Array.from({ length: RATE_LIMIT_BURST }, (_, i) => FIRST_FLOOD_AT + i))
    })

    it('drops what goes past the burst, and keeps the connection', async () => {
        const { alice, bob } = await lobbyWithTwoPlayers()
        const sent = RATE_LIMIT_BURST + 60

        floodPings(alice, sent)

        const pongs = floodPongs(await alice.syncOverLimit())
        expect(pongs.slice(0, RATE_LIMIT_BURST)).toEqual(
            Array.from({ length: RATE_LIMIT_BURST }, (_, i) => FIRST_FLOOD_AT + i),
        )
        expect(pongs.length).toBeLessThan(sent)
        // still seated and still heard
        alice.send({ t: 'ready' })
        await expect(bob.nextLobby(lobby => lobby.player1!.ready)).resolves.toMatchObject({
            player1: { name: 'Alice', connected: true },
        })
    })
})

describe('sustained abuse', () => {
    it('closes the socket with 1008 and takes the player out of the lobby', async () => {
        const { alice, bob } = await lobbyWithTwoPlayers()

        floodPings(alice, FLOOD)

        expect(await alice.closed).toMatchObject(POLICY_VIOLATION)
        // the lobby heard about it, so it isn't left holding the seat for a socket that's gone
        expect(await bob.nextLobby(lobby => lobby.player1 === null)).toMatchObject({
            admin: 'player2',
            player2: { name: 'Bob', connected: true },
        })
    })

    it.each<[string, string | ArrayBuffer]>([
        ['text that is not JSON', 'not json'],
        ['binary frames', new ArrayBuffer(8)],
        ['frames over the size limit', 'x'.repeat(2049)],
        ['valid JSON that is not a message', '{"t":"self_destruct"}'],
    ])('counts %s, which never reach the lobby', async (_, frame) => {
        const { alice } = await lobbyWithTwoPlayers()

        for (let i = 0; i < FLOOD; i++) alice.sendRaw(frame)

        expect(await alice.closed).toMatchObject(POLICY_VIOLATION)
    })

    it('closes a spectator without touching the seats', async () => {
        const { code, alice } = await lobbyWithTwoPlayers()
        const { client: carol } = await join(code, 'carol-id', 'Carol')
        await alice.nextLobby(lobby => lobby.spectators.length > 0)

        floodPings(carol, FLOOD)

        expect(await carol.closed).toMatchObject(POLICY_VIOLATION)
        expect(await alice.nextLobby(lobby => lobby.spectators.length === 0)).toMatchObject({
            player1: { name: 'Alice', connected: true },
            player2: { name: 'Bob', connected: true },
        })
    })

    it('leaves the other connections and their limits alone', async () => {
        const { alice, bob } = await lobbyWithTwoPlayers()

        floodPings(alice, FLOOD)
        await alice.closed

        // Bob's limit is untouched, so a plain sync can't be dropped after these
        floodPings(bob, RATE_LIMIT_BURST - 1)
        const pongs = floodPongs(await bob.sync())
        expect(pongs).toHaveLength(RATE_LIMIT_BURST - 1)
    })

    it('pauses a match in progress, and the player can come back to their seat on a new limit', async () => {
        const { code, alice, bob } = await startedMatch()

        floodPings(alice, FLOOD)

        expect(await alice.closed).toMatchObject(POLICY_VIOLATION)
        expect(await bob.nextLobby(lobby => lobby.paused)).toMatchObject({
            pauseReason: 'Alice disconnected',
            player1: { name: 'Alice', connected: false },
        })

        const { client: aliceAgain, welcome } = await join(code, 'alice-id')

        expect(welcome.role).toBe('player1')
        expect(await bob.nextLobby(lobby => !lobby.paused)).toMatchObject({ player1: { connected: true } })
        floodPings(aliceAgain, RATE_LIMIT_BURST - 1)
        expect(floodPongs(await aliceAgain.sync())).toHaveLength(RATE_LIMIT_BURST - 1)
    })
})
