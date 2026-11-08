import { VERSION_QUERY, type ServerMessage } from '@magus/engine/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    ABUSE_DROP_ALLOWANCE,
    ABUSE_DROPS_FORGIVEN_PER_SECOND,
    ABUSE_RECONNECT_COOLDOWN_SECONDS,
    RATE_LIMIT_BURST,
} from '../../src/rate-limit'
import {
    closeAllSockets,
    connect,
    createLobby,
    join,
    lobbyClientFrom,
    lobbyWithTwoPlayers,
    upgrade,
    type LobbyClient,
} from './helpers'

afterEach(closeAllSockets)

/**
 * Moves `Date.now` ahead, for the Durable Object as well, since it runs in the same isolate as the tests. Timers are
 * left alone, so the lobby's countdowns and forfeit timer still run on real time. Call it while nothing is being waited
 * on, because `waitFor` takes its deadline from `Date.now`.
 */
const realNow = Date.now.bind(Date)
let skipped = 0
const skipAhead = (ms: number) => {
    skipped += ms
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skipped)
}
afterEach(() => {
    vi.restoreAllMocks()
    skipped = 0
})

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
        // the refill would need 5 s to let all of these through, and the waits below time out long before that
        const sent = RATE_LIMIT_BURST + 200

        floodPings(alice, sent)

        const pongs = floodPongs(await alice.syncOverLimit())
        expect(pongs.slice(0, RATE_LIMIT_BURST)).toEqual(
            Array.from({ length: RATE_LIMIT_BURST }, (_, i) => FIRST_FLOOD_AT + i),
        )
        expect(pongs.length).toBeLessThan(sent)
        // still seated and still heard, though the bucket may not hold a token for the first `ready` yet
        await expect(
            alice.sendUntil(
                { t: 'ready' },
                bob.nextLobby(lobby => lobby.player1!.ready),
            ),
        ).resolves.toMatchObject({
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

    it('takes the player out of the lobby even if the peer never completes the close', async () => {
        const code = await createLobby()
        const { client: bob } = await join(code, 'bob-id', 'Bob')

        // such a peer never makes the server's socket fire `close`, so its listeners are withheld for this one upgrade
        const addEventListener = EventTarget.prototype.addEventListener
        const withheld = vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (
            this: EventTarget,
            ...args: Parameters<typeof addEventListener>
        ) {
            if (args[0] !== 'close' && args[0] !== 'error') addEventListener.apply(this, args)
        })
        const res = await upgrade(`/api/lobbies/${code}?playerId=alice-id&name=Alice&${VERSION_QUERY}`).finally(() =>
            withheld.mockRestore(),
        )
        const alice = lobbyClientFrom(res)
        await bob.nextLobby(lobby => lobby.player2 !== null)

        floodPings(alice, FLOOD)

        expect(await alice.closed).toMatchObject(POLICY_VIOLATION)
        await expect(bob.nextLobby(lobby => lobby.player2 === null)).resolves.toMatchObject({
            player1: { name: 'Bob', connected: true },
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

    it('pauses a match in progress', async () => {
        const { alice, bob } = await startedMatch()

        floodPings(alice, FLOOD)

        expect(await alice.closed).toMatchObject(POLICY_VIOLATION)
        expect(await bob.nextLobby(lobby => lobby.paused)).toMatchObject({
            pauseReason: 'Alice disconnected',
            player1: { name: 'Alice', connected: false },
        })
    })
})

describe('across reconnects', () => {
    const COOLDOWN_MS = ABUSE_RECONNECT_COOLDOWN_SECONDS * 1000

    /** Starts a match and gets Alice closed for flooding, which pauses it. */
    const floodedMatch = async () => {
        const match = await startedMatch()
        floodPings(match.alice, FLOOD)
        expect(await match.alice.closed).toMatchObject(POLICY_VIOLATION)
        await match.bob.nextLobby(lobby => lobby.paused)
        return match
    }

    /** Connects as Alice and expects to be turned away without the lobby ever hearing of it. */
    const expectRefused = async (code: string) => {
        const refused = await connect(code, 'alice-id')
        expect(await refused.closed).toMatchObject(POLICY_VIOLATION)
        await expect(refused.next('welcome')).rejects.toThrow('never arrived')
    }

    it('refuses the player during the cooldown, which keeps the match paused', async () => {
        const { code, bob } = await floodedMatch()

        for (let i = 0; i < 3; i++) await expectRefused(code)
        skipAhead(COOLDOWN_MS - 1000)
        await expectRefused(code)

        // nothing resumed it, not even for a moment
        const since = await bob.sync()
        expect(since.filter(message => message.t === 'meta' && !message.lobby.paused)).toEqual([])
    })

    it('lets the player back to their seat after the cooldown, on the allowance their flood left them', async () => {
        const { code, bob } = await floodedMatch()

        skipAhead(COOLDOWN_MS)
        const { client: aliceAgain, welcome } = await join(code, 'alice-id')
        expect(welcome.role).toBe('player1')
        expect(await bob.nextLobby(lobby => !lobby.paused)).toMatchObject({ player1: { connected: true } })

        // The cooldown won back the burst and 100 drops. On top of that, the real time the test takes refills about
        // 10 drops a second, so this closes a kept limit with room to spare. A new limit would only drop the excess.
        const fullAllowance = RATE_LIMIT_BURST + ABUSE_DROP_ALLOWANCE
        const keptAllowance = RATE_LIMIT_BURST + ABUSE_RECONNECT_COOLDOWN_SECONDS * ABUSE_DROPS_FORGIVEN_PER_SECOND
        const secondFlood = fullAllowance - 140
        expect(secondFlood).toBeGreaterThan(keptAllowance + 100)
        floodPings(aliceAgain, secondFlood)

        const outcome = await Promise.race([aliceAgain.closed, aliceAgain.syncOverLimit().then(() => 'still open')])
        expect(outcome).toMatchObject(POLICY_VIOLATION)
        await bob.nextLobby(lobby => lobby.paused)
        // and the cooldown starts again
        await expectRefused(code)
    })

    it('does not touch an honest reconnect under the rate', async () => {
        const { code, alice, bob } = await startedMatch()
        await alice.sync()

        alice.close()
        await bob.nextLobby(lobby => lobby.paused)
        const { client: aliceAgain, welcome } = await join(code, 'alice-id')

        expect(welcome.role).toBe('player1')
        expect(await bob.nextLobby(lobby => !lobby.paused)).toMatchObject({ player1: { connected: true } })
        // `ready` and a sync before the drop leave at least the burst less two, and this sends that many with its sync
        floodPings(aliceAgain, RATE_LIMIT_BURST - 3)
        expect(floodPongs(await aliceAgain.sync())).toHaveLength(RATE_LIMIT_BURST - 3)
    })
})
