import { DEFAULT_SPELLS, type SpellId } from '@magus/engine'
import type { LobbyListing } from '@magus/engine/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { closeAllSockets, connect, connectRegistry, createLobby, join, lobbyWithTwoPlayers, upgrade } from './helpers'

afterEach(closeAllSockets)

/** Valid, and different from the default, so a restored loadout can't pass by accident. */
const CUSTOM_LOADOUT: SpellId[] = [...DEFAULT_SPELLS].reverse()

describe('joining a lobby', () => {
    it('seats two clients and tells both about each other', async () => {
        const code = await createLobby()

        const { client: alice, welcome: aliceWelcome } = await join(code, 'alice-id', 'Alice')
        expect(aliceWelcome).toEqual({ t: 'welcome', role: 'player1', spells: DEFAULT_SPELLS })
        expect(await alice.nextLobby(lobby => lobby.player1 !== null)).toMatchObject({
            code,
            phase: 'lobby',
            admin: 'player1',
            player1: { name: 'Alice', ready: false, connected: true },
            player2: null,
        })

        const { client: bob, welcome: bobWelcome } = await join(code, 'bob-id', 'Bob')
        expect(bobWelcome).toEqual({ t: 'welcome', role: 'player2', spells: DEFAULT_SPELLS })

        const seated = {
            code,
            admin: 'player1',
            player1: { name: 'Alice', connected: true },
            player2: { name: 'Bob', connected: true },
            spectators: [],
        }
        expect(await alice.nextLobby(lobby => lobby.player2 !== null)).toMatchObject(seated)
        expect(await bob.nextLobby(lobby => lobby.player2 !== null)).toMatchObject(seated)
    })

    it('gives clients that connect at the same moment different seats', async () => {
        const code = await createLobby()

        const [first, second] = await Promise.all([join(code, 'alice-id', 'Alice'), join(code, 'bob-id', 'Bob')])

        expect([first.welcome.role, second.welcome.role].sort()).toEqual(['player1', 'player2'])
    })

    it('makes a third client a spectator without touching the seats', async () => {
        const { code, alice } = await lobbyWithTwoPlayers()

        const { welcome } = await join(code, 'carol-id', 'Carol')

        expect(welcome).toEqual({ t: 'welcome', role: 'spectator', spells: null })
        expect(await alice.nextLobby(lobby => lobby.spectators.length > 0)).toMatchObject({
            player1: { name: 'Alice' },
            player2: { name: 'Bob' },
            spectators: ['Carol'],
        })
    })

    it('finds the lobby when the code in the URL is lowercase', async () => {
        const code = await createLobby()

        const { welcome } = await join(code.toLowerCase(), 'alice-id')

        expect(welcome.role).toBe('player1')
    })

    it('rejects a connection with no playerId, with a fatal error and a close', async () => {
        const code = await createLobby()

        const client = await connect(code)

        expect(await client.next('error')).toEqual({ t: 'error', message: 'Missing player id', fatal: true })
        expect(await client.closed).toMatchObject({ code: 4000, reason: 'Missing player id' })
    })

    it('rejects a lobby that was never created, with a fatal error and a close', async () => {
        const client = await connect('AAAAAA', 'alice-id')

        expect(await client.next('error')).toEqual({ t: 'error', message: 'Lobby not found', fatal: true })
        expect(await client.closed).toMatchObject({ code: 4404, reason: 'Lobby not found' })
    })

    it('answers a code that could never exist with a 400 instead of upgrading', async () => {
        const res = await upgrade('/api/lobbies/not-a-code?playerId=alice-id')

        expect(res.status).toBe(400)
        expect(res.webSocket).toBeNull()
    })

    it('publishes the lobby to the public list once a player joins', async () => {
        const registry = await connectRegistry()
        const code = await createLobby()

        await join(code, 'alice-id', 'Alice')

        const update = await registry.waitFor(message => message.lobbies.some(listing => listing.code === code))
        expect(update.lobbies.find(listing => listing.code === code)).toMatchObject({
            code,
            player1: 'Alice',
            player2: null,
            phase: 'lobby',
        } satisfies Partial<LobbyListing>)
    })
})

describe('reconnecting with the same playerId', () => {
    /** Seats lock as soon as both players are ready, so this needs no countdown to run out. Bob has a custom loadout. */
    const startedMatch = async () => {
        const { code, alice, bob } = await lobbyWithTwoPlayers()
        bob.send({ t: 'set_spells', spells: CUSTOM_LOADOUT })
        await bob.next('loadout')
        alice.send({ t: 'ready' })
        bob.send({ t: 'ready' })
        await alice.nextLobby(lobby => lobby.matchStarted)
        return { code, alice, bob }
    }

    it('restores the seat, name and loadout after a drop mid-match, and resumes', async () => {
        const { code, alice, bob } = await startedMatch()

        bob.close()
        expect(await alice.nextLobby(lobby => lobby.paused)).toMatchObject({
            pauseReason: 'Bob disconnected',
            player2: { name: 'Bob', connected: false },
        })

        const { welcome } = await join(code, 'bob-id', 'Impostor')

        expect(welcome).toEqual({ t: 'welcome', role: 'player2', spells: CUSTOM_LOADOUT })
        expect(await alice.nextLobby(lobby => !lobby.paused)).toMatchObject({
            pauseReason: null,
            matchStarted: true,
            player1: { name: 'Alice', connected: true },
            player2: { name: 'Bob', connected: true },
            spectators: [],
        })
    })

    it('does not give a dropped player seat to a different playerId', async () => {
        const { code, alice, bob } = await startedMatch()
        bob.close()
        await alice.nextLobby(lobby => lobby.paused)

        const { welcome } = await join(code, 'mallory-id', 'Mallory')

        expect(welcome.role).toBe('spectator')
        expect(await alice.nextLobby(lobby => lobby.spectators.length > 0)).toMatchObject({
            paused: true,
            player2: { name: 'Bob', connected: false },
        })
    })

    it('keeps the seat when a second tab takes over a live connection, and closes the old tab', async () => {
        const { code, alice, bob } = await lobbyWithTwoPlayers()
        bob.send({ t: 'set_spells', spells: CUSTOM_LOADOUT })
        await bob.next('loadout')

        const { client: bobNewTab, welcome } = await join(code, 'bob-id')

        expect(welcome).toEqual({ t: 'welcome', role: 'player2', spells: CUSTOM_LOADOUT })
        expect(await bob.closed).toMatchObject({ code: 4000, reason: 'Connected from another tab' })
        // the old socket going away must not count as Bob leaving
        await bobNewTab.sync()
        const sinceTakeover = await alice.sync()
        expect(sinceTakeover.length).toBeGreaterThan(0)
        for (const message of sinceTakeover) {
            expect(message).toMatchObject({ t: 'meta', lobby: { player2: { name: 'Bob', connected: true } } })
        }
    })

    it('gives a player their seat back before the match if it is still free', async () => {
        const { code, alice, bob } = await lobbyWithTwoPlayers()

        bob.close()
        await alice.nextLobby(lobby => lobby.player2 === null)
        const { welcome } = await join(code, 'bob-id', 'Bob')

        expect(welcome.role).toBe('player2')
        expect(await alice.nextLobby(lobby => lobby.player2 !== null)).toMatchObject({
            player2: { name: 'Bob', connected: true },
        })
    })
})

describe('malformed messages', () => {
    const MAX_MESSAGE_LENGTH = 2048

    /** A valid `ready` message, padded to exactly `length` characters. */
    const readyOfLength = (length: number) => {
        const empty = JSON.stringify({ t: 'ready', pad: '' })
        return JSON.stringify({ t: 'ready', pad: 'x'.repeat(length - empty.length) })
    }

    it.each<[string, string | ArrayBuffer]>([
        ['text that is not JSON', 'not json'],
        ['truncated JSON', '{"t":"ready"'],
        ['an empty frame', ''],
        ['JSON null', 'null'],
        ['a JSON number', '42'],
        ['a JSON string', '"ready"'],
        ['a JSON array', '["ready"]'],
        ['an object with no type', '{}'],
        ['an unknown type', '{"t":"self_destruct"}'],
        ['a type that is not a string', '{"t":1}'],
        ['a ping whose timestamp is not a number', '{"t":"ping","at":"soon"}'],
        ['a ping whose timestamp is not finite', '{"t":"ping","at":1e999}'],
        ['a type hidden behind the prototype key', '{"__proto__":{"t":"ready"}}'],
        ['a binary frame holding a valid message', new TextEncoder().encode('{"t":"ready"}').buffer as ArrayBuffer],
        ['a valid message over the size limit', readyOfLength(MAX_MESSAGE_LENGTH + 1)],
    ])('ignores %s and keeps the connection', async (_, frame) => {
        const { alice, bob } = await lobbyWithTwoPlayers()

        alice.sendRaw(frame)

        // no reply, no broadcast
        expect(await alice.sync()).toEqual([])
        expect(await bob.sync()).toEqual([])
        // still seated and still heard, and the frame changed nothing before this
        alice.send({ t: 'ready' })
        expect(await bob.nextLobby(lobby => lobby.player1!.ready)).toMatchObject({
            phase: 'lobby',
            matchStarted: false,
            player1: { name: 'Alice', ready: true, connected: true },
            player2: { name: 'Bob', ready: false, connected: true },
        })
    })

    it('still handles a message of exactly the size limit', async () => {
        const { alice, bob } = await lobbyWithTwoPlayers()

        alice.sendRaw(readyOfLength(MAX_MESSAGE_LENGTH))

        expect(await bob.nextLobby(lobby => lobby.player1!.ready)).toBeDefined()
    })

    it.each<[string, unknown]>([
        ['an unknown spell', ['SPELL_NOPE', ...DEFAULT_SPELLS.slice(1)]],
        ['too few spells', DEFAULT_SPELLS.slice(1)],
        ['spells that are not a list', 'SPELL_FIREBALL'],
        [
            'names every object inherits',
            ['toString', 'constructor', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', '__proto__'],
        ],
    ])('answers a loadout with %s with a non-fatal error and keeps the old one', async (_, spells) => {
        const { code, alice, bob } = await lobbyWithTwoPlayers()

        alice.sendRaw(JSON.stringify({ t: 'set_spells', spells }))

        expect(await alice.sync()).toEqual([{ t: 'error', message: 'Invalid spell selection' }])
        expect(await bob.sync()).toEqual([])
        const { welcome } = await join(code, 'alice-id')
        expect(welcome.spells).toEqual(DEFAULT_SPELLS)
    })

    describe('settings from the admin', () => {
        /** Bob is ready, and each client has read everything up to that. */
        const lobbyWithBobReady = async () => {
            const { alice, bob } = await lobbyWithTwoPlayers()
            bob.send({ t: 'ready' })
            await alice.nextLobby(lobby => lobby.player2!.ready)
            await bob.nextLobby(lobby => lobby.player2!.ready)
            return { alice, bob }
        }

        it.each<[string, string]>([
            ['with no settings', '{"t":"settings"}'],
            ['whose settings are null', '{"t":"settings","settings":null}'],
            ['whose settings are a list', '{"t":"settings","settings":[]}'],
            ['with an unknown setting', '{"t":"settings","settings":{"nope":1}}'],
            ['with a best-of that is not an option', '{"t":"settings","settings":{"bestOf":2}}'],
            ['with a set up time of the wrong type', '{"t":"settings","settings":{"setupTime":"60"}}'],
            ['with a set up time that is not finite', '{"t":"settings","settings":{"setupTime":1e999}}'],
            ['with a good setting next to a bad one', '{"t":"settings","settings":{"bestOf":5,"setupTime":"60"}}'],
        ])('ignores a message %s, leaving Bob ready and broadcasting nothing', async (_, frame) => {
            const { alice, bob } = await lobbyWithBobReady()

            alice.sendRaw(frame)

            expect(await alice.sync()).toEqual([])
            expect(await bob.sync()).toEqual([])
            // the next real change shows the settings the frame left behind
            alice.send({ t: 'settings', settings: { setupTime: 45 } })
            expect(await bob.nextLobby(lobby => lobby.settings.setupTime === 45)).toMatchObject({
                settings: { bestOf: 3, setupTime: 45 },
                player2: { ready: false },
            })
        })

        it('leaves Bob ready and broadcasts nothing when a valid message changes nothing', async () => {
            const { alice, bob } = await lobbyWithBobReady()

            alice.send({ t: 'settings', settings: { bestOf: 3 } })

            expect(await alice.sync()).toEqual([])
            expect(await bob.sync()).toEqual([])
        })

        it('still un-readies Bob and tells everyone when a setting changes', async () => {
            const { alice, bob } = await lobbyWithBobReady()

            alice.send({ t: 'settings', settings: { bestOf: 5 } })

            expect(await bob.nextLobby(lobby => lobby.settings.bestOf === 5)).toMatchObject({
                player2: { ready: false },
            })
        })
    })
})
