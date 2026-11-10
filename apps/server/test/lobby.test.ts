import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GAME_TICK_INTERVAL, LOADOUT_SIZE, viewSnapshot, type SpellId } from '@magus/engine'
import {
    DEFAULT_SETTINGS,
    MAX_SPECTATORS,
    SETUP_TIME_MIN,
    type LobbyListing,
    type LobbySettings,
    type ServerMessage,
} from '@magus/engine/protocol'
import { Lobby, RECONNECT_GRACE, type LobbyTransport } from '../src/lobby'

/** A valid loadout other than the default, with Fireball in slot 0. */
const LOADOUT: SpellId[] = [
    'SPELL_FIREBALL',
    'SPELL_LIVING_BOMB',
    'SPELL_METEOR',
    'SPELL_AFTERBURN',
    'SPELL_COUNTERSPELL',
    'SPELL_BLUR',
    'SPELL_MAGIC_EATER',
]

class FakeTransport implements LobbyTransport {
    sent: { to: string; msg: ServerMessage }[] = []
    broadcasts: ServerMessage[] = []
    /** Per-connection stream messages (the battle), in order. */
    streamed: { to: string; msg: ServerMessage }[] = []
    closedConns: string[] = []
    listings: (LobbyListing | null)[] = []
    wasClosed = false
    send(to: string, msg: ServerMessage) {
        this.sent.push({ to, msg })
    }
    broadcast(msg: ServerMessage) {
        this.broadcasts.push(msg)
    }
    /** Messages that went to each connection separately, such as the battle stream and a per-viewer `meta`. */
    sendEach(messages: Map<string, ServerMessage>) {
        for (const [to, msg] of messages) this.streamed.push({ to, msg })
    }
    clear() {
        this.sent = []
        this.broadcasts = []
        this.streamed = []
    }
    /** What the stream sent to `connId`, which is what that viewer sees of the battle. */
    stream(connId = 'c1') {
        return this.streamed.filter(s => s.to === connId).map(s => s.msg)
    }
    close(connId: string) {
        this.closedConns.push(connId)
    }
    listingChanged(listing: LobbyListing | null) {
        this.listings.push(listing)
    }
    closed() {
        this.wasClosed = true
    }
    to(connId: string) {
        return this.sent.filter(s => s.to === connId).map(s => s.msg)
    }
}

type BattleMessage = Extract<ServerMessage, { t: 'battle' }>

const isBattle = (message: ServerMessage): message is BattleMessage => message.t === 'battle'

const seconds = (s: number) => vi.advanceTimersByTime(s * 1000)

const setup = () => {
    const transport = new FakeTransport()
    const lobby = new Lobby('ABC234', transport)
    return { lobby, transport }
}

/** Two connected players, match started and set up phase entered. */
const startMatch = (settings = {}) => {
    const ctx = setup()
    ctx.lobby.connect('c1', 'alice-id', 'Alice')
    ctx.lobby.connect('c2', 'bob-id', 'Bob')
    ctx.lobby.message('c1', { t: 'settings', settings })
    ctx.lobby.message('c1', { t: 'ready' })
    ctx.lobby.message('c2', { t: 'ready' })
    seconds(3)
    return ctx
}

/** From set up, skip straight to a live battle. */
const toBattle = (lobby: Lobby) => {
    lobby.message('c1', { t: 'ready' })
    lobby.message('c2', { t: 'ready' })
    seconds(3) // set up shortened to 3s
    seconds(3) // battle countdown
    expect(lobby.phase).toBe('battle')
}

/** The first tick decides the winner, the next one ends that tick and with it the round. */
const killPlayer2 = (lobby: Lobby) => {
    lobby.battle!.state.player2.hp = 0
    vi.advanceTimersByTime(100)
}

/** Player 1 starts a Fireball (slot 0) and holds it until it is ready to release. */
const holdFireball = (lobby: Lobby) => {
    lobby.message('c1', { t: 'start_cast', i: 0 })
    vi.advanceTimersByTime(lobby.battle!.state.player1.spells[0].castTime * GAME_TICK_INTERVAL)
}

/** From set up, a live battle where player 1 holds a Fireball that is ready to release. */
const toHeldFireball = (lobby: Lobby) => {
    lobby.message('c1', { t: 'set_spells', spells: LOADOUT })
    toBattle(lobby)
    holdFireball(lobby)
}

/** Player 1 kills player 2 with an action, so its log entries and HP event wait for the next broadcast. */
const killByAction = (lobby: Lobby) => {
    toHeldFireball(lobby)
    lobby.battle!.state.player2.hp = 1
    lobby.message('c1', { t: 'stop_cast', i: 0 })
    expect(lobby.battle!.state.winner).toBe('player1')
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('joining', () => {
    it('seats the first two players and makes the first one admin', () => {
        const { lobby, transport } = setup()
        lobby.connect('c1', 'alice-id', 'Alice')
        lobby.connect('c2', 'bob-id', 'Bob')
        expect(transport.to('c1')[0]).toMatchObject({ t: 'welcome', role: 'player1' })
        expect(transport.to('c2')[0]).toMatchObject({ t: 'welcome', role: 'player2' })
        expect(lobby.info()).toMatchObject({ admin: 'player1', player1: { name: 'Alice' }, player2: { name: 'Bob' } })
    })

    it('never exposes player ids', () => {
        const { lobby } = setup()
        lobby.connect('c1', 'alice-secret-id', 'Alice')
        expect(JSON.stringify(lobby.info())).not.toContain('alice-secret-id')
        expect(JSON.stringify(lobby.listing())).not.toContain('alice-secret-id')
    })

    it('sanitizes names', () => {
        const { lobby } = setup()
        lobby.connect('c1', 'a', '  A\u0007very   long name indeed  ')
        lobby.connect('c2', 'b', '')
        expect(lobby.info().player1!.name).toBe('Avery long name')
        expect(lobby.info().player2!.name).toBe('Player 2')
    })

    it('adds spectators once seats are taken, up to the limit', () => {
        const { lobby, transport } = setup()
        lobby.connect('c1', 'a', 'A')
        lobby.message('c1', { t: 'settings', settings: { maxSpectators: 1 } })
        lobby.connect('c2', 'b', 'B')
        lobby.connect('c3', 'c', 'Carol')
        lobby.connect('c4', 'd', 'Dan')
        expect(transport.to('c3')[0]).toMatchObject({ t: 'welcome', role: 'spectator' })
        expect(transport.to('c4')[0]).toMatchObject({ t: 'error', fatal: true })
        expect(transport.closedConns).toContain('c4')
        expect(lobby.info().spectators).toEqual(['Carol'])
    })

    it('rejects connections without a player id', () => {
        const { lobby, transport } = setup()
        lobby.connect('c1', '', 'A')
        expect(transport.closedConns).toEqual(['c1'])
    })

    it('hands admin to the remaining player when the admin leaves', () => {
        const { lobby } = setup()
        lobby.connect('c1', 'a', 'A')
        lobby.connect('c2', 'b', 'B')
        lobby.message('c2', { t: 'ready' })
        lobby.disconnect('c1')
        expect(lobby.info().admin).toBe('player2')
        expect(lobby.info().player2!.ready).toBe(false)
    })

    it('closes and delists when everyone leaves before the match', () => {
        const { lobby, transport } = setup()
        lobby.connect('c1', 'a', 'A')
        lobby.disconnect('c1')
        expect(transport.wasClosed).toBe(true)
        expect(transport.listings.at(-1)).toBeNull()
    })
})

describe('settings', () => {
    it('only the admin can change them, before the match starts', () => {
        const { lobby } = setup()
        lobby.connect('c1', 'a', 'A')
        lobby.connect('c2', 'b', 'B')
        lobby.message('c2', { t: 'settings', settings: { bestOf: 5 } })
        expect(lobby.settings.bestOf).toBe(3)
        lobby.message('c1', { t: 'settings', settings: { bestOf: 5 } })
        expect(lobby.settings.bestOf).toBe(5)
    })

    it('clamps numbers to the allowed range', () => {
        const { lobby } = setup()
        lobby.connect('c1', 'a', 'A')
        lobby.message('c1', { t: 'settings', settings: { setupTime: 0, maxSpectators: 99 } })
        expect(lobby.settings).toEqual({
            ...DEFAULT_SETTINGS,
            setupTime: SETUP_TIME_MIN,
            maxSpectators: MAX_SPECTATORS,
        })
    })

    /** Two seated players, with the non-admin ready and the transport's record cleared. */
    const adminAndReadyOpponent = () => {
        const ctx = setup()
        ctx.lobby.connect('c1', 'a', 'A')
        ctx.lobby.connect('c2', 'b', 'B')
        ctx.lobby.message('c2', { t: 'ready' })
        ctx.transport.clear()
        ctx.transport.listings = []
        return ctx
    }

    it.each<[string, unknown]>([
        ['no settings', undefined],
        ['settings that are null', null],
        ['settings that are a string', 'nope'],
        ['settings that are a list', [{ bestOf: 5 }]],
        ['an unknown setting', { nope: 1 }],
        ['a best-of that is not an option', { bestOf: 4 }],
        ['a set up time that is not a number', { setupTime: '60' }],
        ['a set up time that is not finite', { setupTime: Number.NaN }],
        ['a spell change flag that is not a boolean', { allowSpellChange: 'yes' }],
        ['a spectator limit that is not a number', { maxSpectators: null }],
        ['a good setting next to a bad one', { bestOf: 5, setupTime: '60' }],
    ])('ignores a message with %s: no state change and no broadcast', (_, settings) => {
        const { lobby, transport } = adminAndReadyOpponent()
        lobby.message('c1', { t: 'settings', settings } as never)
        expect(lobby.settings).toEqual(DEFAULT_SETTINGS)
        expect(lobby.info().player2!.ready).toBe(true)
        expect(transport.broadcasts).toEqual([])
        expect(transport.listings).toEqual([])
    })

    it.each<[string, Partial<LobbySettings>]>([
        ['an empty patch', {}],
        ['the current value', { bestOf: DEFAULT_SETTINGS.bestOf }],
        ['a value that rounds to the current one', { maxSpectators: DEFAULT_SETTINGS.maxSpectators + 0.2 }],
    ])('keeps players ready and broadcasts nothing for %s', (_, settings) => {
        const { lobby, transport } = adminAndReadyOpponent()
        lobby.message('c1', { t: 'settings', settings })
        expect(lobby.settings).toEqual(DEFAULT_SETTINGS)
        expect(lobby.info().player2!.ready).toBe(true)
        expect(transport.broadcasts).toEqual([])
    })

    it('un-readies both players when changed', () => {
        const { lobby } = setup()
        lobby.connect('c1', 'a', 'A')
        lobby.connect('c2', 'b', 'B')
        lobby.message('c2', { t: 'ready' })
        lobby.message('c1', { t: 'settings', settings: { bestOf: 1 } })
        expect(lobby.info().player2!.ready).toBe(false)
    })
})

describe('match flow', () => {
    it('starts 3 seconds after both are ready, then opens set up', () => {
        const { lobby } = setup()
        lobby.connect('c1', 'a', 'A')
        lobby.connect('c2', 'b', 'B')
        lobby.message('c1', { t: 'ready' })
        lobby.message('c2', { t: 'ready' })
        expect(lobby.matchStarted).toBe(true)
        seconds(2)
        expect(lobby.phase).toBe('lobby')
        seconds(1)
        expect(lobby.info()).toMatchObject({ phase: 'set_up', round: 1, countdown: 30 })
    })

    it('set up lasts the configured time', () => {
        const { lobby } = startMatch({ setupTime: 15 })
        seconds(14)
        expect(lobby.phase).toBe('set_up')
        seconds(1)
        expect(lobby.phase).toBe('battle_countdown')
        seconds(3)
        expect(lobby.phase).toBe('battle')
    })

    it('set up drops to 3 seconds once both players are ready', () => {
        const { lobby } = startMatch()
        lobby.message('c1', { t: 'ready' })
        lobby.message('c2', { t: 'ready' })
        expect(lobby.info().countdown).toBe(3)
        seconds(3)
        expect(lobby.phase).toBe('battle_countdown')
    })

    it('uses the chosen spells in battle', () => {
        const { lobby, transport } = startMatch()
        lobby.message('c1', { t: 'set_spells', spells: LOADOUT })
        expect(transport.to('c1').at(-1)).toEqual({ t: 'loadout', spells: LOADOUT })
        toBattle(lobby)
        expect(lobby.battle!.state.player1.spells.map(s => s.id)).toEqual(LOADOUT)
    })

    it('rejects invalid loadouts', () => {
        const { lobby, transport } = startMatch()
        const before = lobby.seats.player1!.spells
        for (const spells of [
            ['SPELL_FIREBALL'],
            [...LOADOUT.slice(0, 6), 'SPELL_FIREBALL'],
            [...LOADOUT.slice(0, 6), 'NOPE'],
            'x',
        ]) {
            lobby.message('c1', { t: 'set_spells', spells } as never)
        }
        expect(lobby.seats.player1!.spells).toEqual(before)
        expect(transport.to('c1').filter(m => m.t === 'error')).toHaveLength(4)
    })

    it.each<[string, unknown]>([
        ['an old 6-slot loadout', LOADOUT.filter(id => id !== 'SPELL_COUNTERSPELL')],
        ['Counterspell in another slot', [LOADOUT[4], ...LOADOUT.slice(1, 4), LOADOUT[0], ...LOADOUT.slice(5)]],
        ['too many element spells', [...LOADOUT.slice(0, 5), 'SPELL_IGNITE', LOADOUT[6]]],
        ['a duplicate', [LOADOUT[0], LOADOUT[0], ...LOADOUT.slice(2)]],
        ['an unknown id', [...LOADOUT.slice(0, 6), 'SPELL_NOPE']],
        ['an extra slot', [...LOADOUT, 'SPELL_HASTE']],
    ])('answers %s with a non-fatal error and keeps the previous loadout', (_, spells) => {
        const { lobby, transport } = startMatch()
        lobby.message('c1', { t: 'set_spells', spells: LOADOUT })
        transport.clear()
        const sentBefore = transport.sent.length
        lobby.message('c1', { t: 'set_spells', spells } as never)
        expect(lobby.seats.player1!.spells).toEqual(LOADOUT)
        expect(transport.sent.slice(sentBefore)).toEqual([
            { to: 'c1', msg: { t: 'error', message: 'Invalid spell selection' } },
        ])
    })

    it('rejects a loadout of names every object inherits', () => {
        const { lobby, transport } = startMatch()
        const before = lobby.seats.player1!.spells
        const spells = ['toString', 'constructor', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', '__proto__']
        lobby.message('c1', { t: 'set_spells', spells } as never)
        expect(lobby.seats.player1!.spells).toEqual(before)
        expect(transport.to('c1').at(-1)).toEqual({ t: 'error', message: 'Invalid spell selection' })
    })

    it('does not answer an invalid loadout from a spectator', () => {
        const { lobby, transport } = startMatch()
        lobby.connect('c3', 'carol', 'Carol')
        lobby.message('c3', { t: 'set_spells', spells: 'x' } as never)
        expect(transport.to('c3').filter(m => m.t === 'error')).toEqual([])
    })

    it('relays casts to the battle and broadcasts state every tick', () => {
        const { lobby, transport } = startMatch()
        toBattle(lobby)
        transport.clear()
        lobby.message('c1', { t: 'start_cast', i: 0 })
        vi.advanceTimersByTime(26 * 50)
        lobby.message('c1', { t: 'stop_cast', i: 0 })
        vi.advanceTimersByTime(50)
        expect(lobby.battle!.state.player2.hp).toBeCloseTo(94.4)
        const battleMessages = transport.stream().filter(isBattle)
        expect(battleMessages).toHaveLength(27)
        // the log is streamed incrementally
        const logs = battleMessages.flatMap(m => (m.t === 'battle' ? m.log : []))
        expect(logs.map(l => l.type)).toEqual(['START_CAST', 'STOP_CAST', 'SPELL_RELEASE'])
    })

    it('ignores casts outside battle and malformed indexes', () => {
        const { lobby } = startMatch()
        lobby.message('c1', { t: 'start_cast', i: 0 })
        toBattle(lobby)
        lobby.message('c1', { t: 'start_cast', i: 'x' } as never)
        lobby.message('c1', { t: 'start_cast', i: 99 })
        expect(lobby.battle!.state.player1.cast).toBeNull()
        expect(lobby.battle!.state.log).toEqual([])
    })

    describe('bad spell indexes during a battle', () => {
        const BAD_INDEXES: [string, unknown][] = [
            ['just below the range', -1],
            ['just above the range', LOADOUT_SIZE],
            ['far above the range', 99],
            ['not an integer', 1.5],
            ['not finite', Number.POSITIVE_INFINITY],
            ['a numeric string', '0'],
            ['null', null],
            ['a list', [0]],
            ['missing', undefined],
        ]

        /** A live battle with player 1 holding a cast of slot 0, which a bad message must leave running. */
        const liveBattle = () => {
            const { lobby, transport } = startMatch()
            toBattle(lobby)
            const battle = lobby.battle!
            battle.startCast('player1', 0)
            transport.sent = []
            return {
                lobby,
                transport,
                battle,
                log: [...battle.state.log],
                startCast: vi.spyOn(battle, 'startCast'),
                stopCast: vi.spyOn(battle, 'stopCast'),
            }
        }

        it.each(BAD_INDEXES)('start_cast with an index that is %s is dropped', (_, i) => {
            const { lobby, transport, battle, log, startCast } = liveBattle()
            lobby.message('c1', { t: 'start_cast', i } as never)
            expect(startCast).not.toHaveBeenCalled()
            expect(battle.state.player1.cast).toBe(0)
            expect(battle.state.log).toEqual(log)
            expect(transport.sent).toEqual([])
        })

        it.each(BAD_INDEXES)('stop_cast with an index that is %s is dropped', (_, i) => {
            const { lobby, transport, battle, log, stopCast } = liveBattle()
            lobby.message('c1', { t: 'stop_cast', i } as never)
            expect(stopCast).not.toHaveBeenCalled()
            expect(battle.state.player1.cast).toBe(0)
            expect(battle.state.log).toEqual(log)
            expect(transport.sent).toEqual([])
        })

        it.each([0, LOADOUT_SIZE - 1])('slot %i, at the edge of the range, still reaches the battle', i => {
            const { lobby, startCast, stopCast } = liveBattle()
            lobby.message('c2', { t: 'start_cast', i })
            lobby.message('c2', { t: 'stop_cast', i })
            expect(startCast).toHaveBeenCalledWith('player2', i)
            expect(stopCast).toHaveBeenCalledWith('player2', i)
        })
    })

    it('spectators cannot act', () => {
        const { lobby } = startMatch()
        lobby.connect('c3', 'carol', 'Carol')
        toBattle(lobby)
        lobby.message('c3', { t: 'start_cast', i: 0 })
        expect(lobby.battle!.state.log).toEqual([])
    })

    it('sends late joiners the full battle state', () => {
        const { lobby, transport } = startMatch()
        toBattle(lobby)
        lobby.message('c1', { t: 'start_cast', i: 0 })
        vi.advanceTimersByTime(100)
        lobby.connect('c3', 'carol', 'Carol')
        const battle = transport.to('c3').find(m => m.t === 'battle')
        expect(battle).toMatchObject({ logFrom: 0, log: [{ type: 'START_CAST' }] })
    })

    it('best of 3: first to 2 wins, with a 10s break between rounds', () => {
        const { lobby, transport } = startMatch({ bestOf: 3 })
        toBattle(lobby)
        killPlayer2(lobby)
        expect(lobby.info()).toMatchObject({ phase: 'round_over', countdown: 10, player1: { wins: 1 } })
        seconds(10)
        expect(lobby.info()).toMatchObject({ phase: 'set_up', round: 2 })
        toBattle(lobby)
        killPlayer2(lobby)
        expect(lobby.info()).toMatchObject({ phase: 'match_over', matchWinner: 'player1' })
        expect(lobby.rounds.map(r => r.winner)).toEqual(['player1', 'player1'])
        expect(transport.listings.at(-1)).toBeNull()
    })

    it('best of 1 ends after one round, best of 5 needs three wins', () => {
        const bo1 = startMatch({ bestOf: 1 })
        toBattle(bo1.lobby)
        killPlayer2(bo1.lobby)
        expect(bo1.lobby.phase).toBe('match_over')

        const bo5 = startMatch({ bestOf: 5 })
        for (let i = 0; i < 2; i++) {
            toBattle(bo5.lobby)
            killPlayer2(bo5.lobby)
            seconds(10)
        }
        expect(bo5.lobby.phase).toBe('set_up')
        toBattle(bo5.lobby)
        killPlayer2(bo5.lobby)
        expect(bo5.lobby.phase).toBe('match_over')
    })

    it('a drawn round counts for nobody', () => {
        const { lobby } = startMatch({ bestOf: 1 })
        toBattle(lobby)
        lobby.battle!.state.player1.hp = 0
        lobby.battle!.state.player2.hp = 0
        vi.advanceTimersByTime(50)
        expect(lobby.info()).toMatchObject({ phase: 'round_over', player1: { wins: 0 }, player2: { wins: 0 } })
    })

    /** Player 2 holds a Fireball (slot 0) that is ready to release, and player 1 is low enough for it to kill. */
    const toReadyFireball = (lobby: Lobby) => {
        lobby.message('c2', { t: 'set_spells', spells: LOADOUT })
        toBattle(lobby)
        const battle = lobby.battle!
        lobby.message('c2', { t: 'start_cast', i: 0 })
        vi.advanceTimersByTime(battle.state.player2.spells[0].castTime * GAME_TICK_INTERVAL)
        battle.state.player1.hp = 1
        return battle
    }

    it('a same-tick release after a winner decided inside the tick makes the round a draw', () => {
        const { lobby } = startMatch()
        const battle = toReadyFireball(lobby)
        battle.state.player2.hp = 0
        vi.advanceTimersByTime(50)
        expect(battle.state.winner).toBe('player1')
        expect(lobby.phase).toBe('battle')

        lobby.message('c2', { t: 'stop_cast', i: 0 })
        expect(battle.state.winner).toBe('draw')
        vi.advanceTimersByTime(50)
        expect(lobby.rounds.map(r => r.winner)).toEqual(['draw'])
        expect(lobby.info()).toMatchObject({ phase: 'round_over', player1: { wins: 0 }, player2: { wins: 0 } })
    })

    it('a same-tick instant after a winner decided inside the tick makes the round a draw', () => {
        const { lobby } = startMatch()
        lobby.message('c2', { t: 'set_spells', spells: LOADOUT })
        toBattle(lobby)
        const battle = lobby.battle!
        battle.state.player2.spells[0].castTime = 0 // no catalog spell is both instant and damaging
        battle.state.player1.hp = 1
        battle.state.player2.hp = 0
        vi.advanceTimersByTime(50)
        expect(battle.state.winner).toBe('player1')

        lobby.message('c2', { t: 'start_cast', i: 0 })
        expect(battle.state.winner).toBe('draw')
        vi.advanceTimersByTime(50)
        expect(lobby.rounds.map(r => r.winner)).toEqual(['draw'])
    })

    it('an action after the tick the winner was decided in changes nothing', () => {
        const { lobby } = startMatch()
        const battle = toReadyFireball(lobby)
        battle.state.player2.hp = 0
        vi.advanceTimersByTime(100)
        expect(lobby.phase).toBe('round_over')

        lobby.message('c2', { t: 'stop_cast', i: 0 })
        expect(battle.state.winner).toBe('player1')
        expect(battle.state.player1.hp).toBe(1)
        expect(lobby.rounds.map(r => r.winner)).toEqual(['player1'])
    })

    it('skips set up after round 1 when spell changes are not allowed', () => {
        const { lobby } = startMatch({ allowSpellChange: false })
        lobby.message('c1', { t: 'set_spells', spells: LOADOUT })
        toBattle(lobby)
        killPlayer2(lobby)
        seconds(10)
        expect(lobby.phase).toBe('battle_countdown')
        lobby.message('c1', { t: 'set_spells', spells: [...LOADOUT.slice(0, 4).reverse(), ...LOADOUT.slice(4)] })
        seconds(3)
        expect(lobby.battle!.state.player1.spells.map(s => s.id)).toEqual(LOADOUT)
    })

    it('locks loadouts once a player is ready in set up', () => {
        const { lobby } = startMatch()
        lobby.message('c1', { t: 'ready' })
        lobby.message('c1', { t: 'set_spells', spells: LOADOUT })
        expect(lobby.seats.player1!.spells).not.toEqual(LOADOUT)
    })
})

describe('disconnects during a match', () => {
    it('pauses and resumes when the player reconnects', () => {
        const { lobby, transport } = startMatch()
        toBattle(lobby)
        vi.advanceTimersByTime(500)
        lobby.disconnect('c2')
        expect(lobby.info()).toMatchObject({
            paused: true,
            pauseReason: 'Bob disconnected',
            player2: { connected: false },
        })
        const tick = lobby.battle!.state.gameTick
        seconds(5)
        expect(lobby.battle!.state.gameTick).toBe(tick)
        lobby.connect('c9', 'bob-id', 'Bob')
        expect(transport.to('c9')[0]).toMatchObject({ t: 'welcome', role: 'player2' })
        expect(lobby.paused).toBe(false)
        vi.advanceTimersByTime(500)
        expect(lobby.battle!.state.gameTick).toBe(tick + 10)
        lobby.message('c9', { t: 'start_cast', i: 0 })
        expect(lobby.battle!.state.player2.cast).toBe(0)
    })

    it('resumes a paused countdown where it left off', () => {
        const { lobby } = startMatch({ setupTime: 20 })
        seconds(5)
        lobby.disconnect('c1')
        seconds(10)
        expect(lobby.info().countdown).toBe(15)
        lobby.connect('c5', 'alice-id', 'Alice')
        seconds(14)
        expect(lobby.phase).toBe('set_up')
        seconds(1)
        expect(lobby.phase).toBe('battle_countdown')
    })

    it('forfeits the match after the reconnect grace period', () => {
        const { lobby } = startMatch()
        toBattle(lobby)
        lobby.disconnect('c2')
        const tick = lobby.battle!.state.gameTick
        seconds(RECONNECT_GRACE)
        expect(lobby.info()).toMatchObject({ phase: 'match_over', matchWinner: 'player1' })
        // only a decided round gets a settling tick
        expect(lobby.battle!.state.gameTick).toBe(tick)
    })

    it('abandons the match if both players leave', () => {
        const { lobby, transport } = startMatch()
        toBattle(lobby)
        lobby.disconnect('c1')
        lobby.disconnect('c2')
        seconds(RECONNECT_GRACE)
        expect(lobby.info()).toMatchObject({ phase: 'match_over', matchWinner: null })
        expect(transport.wasClosed).toBe(true)
    })

    it('a forfeit with no decided winner records no round', () => {
        const { lobby } = startMatch({ bestOf: 1 })
        toBattle(lobby)
        vi.advanceTimersByTime(500)
        lobby.disconnect('c1')
        seconds(RECONNECT_GRACE)
        expect(lobby.info()).toMatchObject({
            phase: 'match_over',
            matchWinner: 'player2',
            rounds: [],
            player1: { wins: 0 },
            player2: { wins: 0 },
        })
    })

    /** Player 2 dies inside `tick()`: player 1 has won, but the round only ends on the next tick. */
    const winInsideTick = (lobby: Lobby) => {
        toBattle(lobby)
        lobby.battle!.state.player2.hp = 0
        vi.advanceTimersByTime(GAME_TICK_INTERVAL)
        expect(lobby.battle!.state.winner).toBe('player1')
        expect(lobby.phase).toBe('battle')
    }

    /** Draw decided by an action in the winner's tick, so the phase is still 'battle' when the disconnect pauses it. */
    const drawByAction = (lobby: Lobby) => {
        lobby.message('c2', { t: 'set_spells', spells: LOADOUT })
        toBattle(lobby)
        const battle = lobby.battle!
        lobby.message('c2', { t: 'start_cast', i: 0 })
        vi.advanceTimersByTime(battle.state.player2.spells[0].castTime * GAME_TICK_INTERVAL)
        battle.state.player1.hp = 1
        battle.state.player2.hp = 0
        vi.advanceTimersByTime(GAME_TICK_INTERVAL)
        lobby.message('c2', { t: 'stop_cast', i: 0 })
        expect(battle.state.winner).toBe('draw')
        expect(lobby.phase).toBe('battle')
    }

    it('gives the match to the actual winner when they disconnect inside the winning tick', () => {
        const { lobby } = startMatch({ bestOf: 1 })
        winInsideTick(lobby)
        lobby.disconnect('c1')
        seconds(RECONNECT_GRACE)
        expect(lobby.info()).toMatchObject({ phase: 'match_over', matchWinner: 'player1', player1: { wins: 1 } })
        expect(lobby.rounds.map(r => r.winner)).toEqual(['player1'])
    })

    it('records the round when the loser disconnects inside the winning tick', () => {
        const { lobby } = startMatch({ bestOf: 1 })
        winInsideTick(lobby)
        lobby.disconnect('c2')
        seconds(RECONNECT_GRACE)
        expect(lobby.info()).toMatchObject({ phase: 'match_over', matchWinner: 'player1', player1: { wins: 1 } })
        expect(lobby.rounds.map(r => r.winner)).toEqual(['player1'])
    })

    it('still gives the match to the actual winner when both players disconnect inside the winning tick', () => {
        const { lobby, transport } = startMatch({ bestOf: 1 })
        winInsideTick(lobby)
        lobby.disconnect('c1')
        lobby.disconnect('c2')
        seconds(RECONNECT_GRACE)
        expect(lobby.info()).toMatchObject({ phase: 'match_over', matchWinner: 'player1', player1: { wins: 1 } })
        expect(lobby.rounds.map(r => r.winner)).toEqual(['player1'])
        expect(transport.wasClosed).toBe(true)
    })

    it('gives the match to the actual winner of a kill made by an action, and shows it to the opponent', () => {
        const { lobby, transport } = startMatch({ bestOf: 1 })
        killByAction(lobby)
        lobby.disconnect('c1')
        const before = transport.stream('c2').length

        seconds(RECONNECT_GRACE)
        expect(lobby.info()).toMatchObject({ phase: 'match_over', matchWinner: 'player1' })
        expect(lobby.rounds.map(r => r.winner)).toEqual(['player1'])
        const battleBroadcasts = transport.stream('c2').slice(before).filter(isBattle)
        expect(battleBroadcasts).toHaveLength(1)
        expect(battleBroadcasts[0]).toMatchObject({ snap: { winner: 'player1', player2: { hp: 0 } } })
    })

    it('when the decided round does not end the match, records it and then forfeits', () => {
        const { lobby } = startMatch({ bestOf: 3 })
        winInsideTick(lobby)
        lobby.disconnect('c1')
        seconds(RECONNECT_GRACE)
        expect(lobby.info()).toMatchObject({
            phase: 'match_over',
            matchWinner: 'player2',
            player1: { wins: 1 },
            player2: { wins: 0 },
        })
        expect(lobby.rounds.map(r => r.winner)).toEqual(['player1'])
        // the next round's countdown must not outlive the match
        expect(vi.getTimerCount()).toBe(0)
        expect(lobby.info().countdown).toBeNull()
    })

    it('ends a decided round exactly once when the player reconnects in time', () => {
        const { lobby } = startMatch({ bestOf: 1 })
        winInsideTick(lobby)
        lobby.disconnect('c1')
        seconds(5)
        expect(lobby.rounds).toEqual([])
        lobby.connect('c9', 'alice-id', 'Alice')
        vi.advanceTimersByTime(GAME_TICK_INTERVAL)
        expect(lobby.info()).toMatchObject({ phase: 'match_over', matchWinner: 'player1' })
        seconds(RECONNECT_GRACE)
        expect(lobby.rounds.map(r => r.winner)).toEqual(['player1'])
    })

    it('a reconnect in time cancels the forfeit, so its deadline cannot end a match still running', () => {
        const { lobby } = startMatch({ bestOf: 3 })
        winInsideTick(lobby)
        lobby.disconnect('c2')
        seconds(5)
        lobby.connect('c9', 'bob-id', 'Bob')
        // past the original deadline: round 1 has ended and round 2's set up is running
        seconds(RECONNECT_GRACE - 5 + 1)
        expect(lobby.phase).not.toBe('match_over')
        expect(lobby.matchWinner).toBeNull()
        expect(lobby.rounds.map(r => r.winner)).toEqual(['player1'])
    })

    it('a draw decided inside the tick is not recorded twice when a disconnect follows', () => {
        const { lobby } = startMatch({ bestOf: 1 })
        toBattle(lobby)
        const battle = lobby.battle!
        battle.state.player1.hp = 0
        battle.state.player2.hp = 0
        vi.advanceTimersByTime(GAME_TICK_INTERVAL)
        // the draw ended the round at once, so no further tick ran
        expect(lobby.phase).toBe('round_over')
        expect(battle.finished).toBe(false)

        lobby.disconnect('c1')
        seconds(RECONNECT_GRACE)
        expect(lobby.rounds.map(r => r.winner)).toEqual(['draw'])
        expect(lobby.info()).toMatchObject({
            phase: 'match_over',
            matchWinner: 'player2',
            player1: { wins: 0 },
            player2: { wins: 0 },
        })
    })

    it('a draw decided by an action is recorded before the forfeit when a disconnect follows', () => {
        const { lobby } = startMatch({ bestOf: 1 })
        drawByAction(lobby)
        lobby.disconnect('c1')
        seconds(RECONNECT_GRACE)
        expect(lobby.rounds.map(r => r.winner)).toEqual(['draw'])
        expect(lobby.info()).toMatchObject({
            phase: 'match_over',
            matchWinner: 'player2',
            player1: { wins: 0 },
            player2: { wins: 0 },
        })
    })

    it('a draw decided by an action leaves no match winner when both players disconnect', () => {
        const { lobby, transport } = startMatch({ bestOf: 1 })
        drawByAction(lobby)
        lobby.disconnect('c1')
        lobby.disconnect('c2')
        seconds(RECONNECT_GRACE)
        expect(lobby.rounds.map(r => r.winner)).toEqual(['draw'])
        expect(lobby.info()).toMatchObject({ phase: 'match_over', matchWinner: null })
        expect(transport.wasClosed).toBe(true)
    })

    it('a second tab for the same player replaces the first', () => {
        const { lobby, transport } = setup()
        lobby.connect('c1', 'a', 'A')
        lobby.connect('c2', 'a', 'A')
        expect(transport.closedConns).toEqual(['c1'])
        expect(lobby.seats.player1!.connId).toBe('c2')
        expect(lobby.seats.player2).toBeNull()
    })
})

describe('joining mid-battle', () => {
    const RELEASE_LOG = ['STOP_CAST', 'SPELL_RELEASE']
    const KILL_EVENTS = [{ player: 'player2', amount: -1, source: 'SPELL_FIREBALL' }]

    /** The one `battle` broadcast after a kill by action and `leaver`'s disconnect, with `meanwhile` run in the pause. */
    const broadcastAfterPausedKill = (leaver: string, meanwhile: (lobby: Lobby) => void = () => {}) => {
        const { lobby, transport } = startMatch({ bestOf: 1 })
        killByAction(lobby)
        lobby.disconnect(leaver)
        transport.clear()
        seconds(5)
        meanwhile(lobby)
        seconds(RECONNECT_GRACE)
        expect(lobby.info()).toMatchObject({ phase: 'match_over', matchWinner: 'player1' })
        const battleBroadcasts = transport.stream(leaver === 'c1' ? 'c2' : 'c1').filter(isBattle)
        expect(battleBroadcasts).toHaveLength(1)
        return { message: battleBroadcasts[0], transport }
    }

    const expectSameAsNoJoin = (message: BattleMessage, leaver: string) => {
        const { message: alone } = broadcastAfterPausedKill(leaver)
        expect(message.log).toEqual(alone.log)
        expect(message.events).toEqual(alone.events)
        expect(message.logFrom).toBe(alone.logFrom)
        // so that two empty broadcasts can't pass as the same
        expect(alone.log.map(l => l.type)).toEqual(RELEASE_LOG)
        expect(alone.events).toMatchObject(KILL_EVENTS)
    }

    it.each(['c1', 'c2'])('a spectator joining the pause after %s left does not change the final broadcast', leaver => {
        const { message, transport } = broadcastAfterPausedKill(leaver, lobby => lobby.connect('c3', 'carol', 'Carol'))
        expect(transport.to('c3').filter(isBattle)).toHaveLength(1)
        expectSameAsNoJoin(message, leaver)
    })

    it.each([
        ['c1', 'alice-id', 'Alice'],
        ['c2', 'bob-id', 'Bob'],
    ])('%s reconnecting during the pause does not change the next broadcast', (leaver, playerId, name) => {
        const { message, transport } = broadcastAfterPausedKill(leaver, lobby => {
            lobby.connect('c9', playerId, name)
            expect(lobby.paused).toBe(false)
        })
        expect(transport.to('c9').filter(isBattle)).toHaveLength(1)
        expectSameAsNoJoin(message, leaver)
    })

    it('a join between ticks leaves the log and events of an action for the next broadcast', () => {
        const { lobby, transport } = startMatch()
        toHeldFireball(lobby)
        const logFrom = lobby.battle!.state.log.length
        lobby.message('c1', { t: 'stop_cast', i: 0 })
        transport.clear()

        lobby.connect('c3', 'carol', 'Carol')
        expect(transport.stream().filter(isBattle)).toEqual([])
        vi.advanceTimersByTime(GAME_TICK_INTERVAL)

        const [next] = transport.stream().filter(isBattle)
        expect(next.logFrom).toBe(logFrom)
        expect(next.log.map(l => l.type)).toEqual(RELEASE_LOG)
        expect(next.events).toEqual([expect.objectContaining({ player: 'player2', source: 'SPELL_FIREBALL' })])
    })

    it('a join between ticks does not lose the Counterspell tell', () => {
        const { lobby, transport } = startMatch()
        toBattle(lobby)
        const counterspell = lobby.battle!.state.player2.spells.findIndex(s => s.id === 'SPELL_COUNTERSPELL')
        lobby.message('c1', { t: 'start_cast', i: 0 })
        vi.advanceTimersByTime(GAME_TICK_INTERVAL)
        lobby.message('c2', { t: 'start_cast', i: counterspell })
        transport.clear()

        lobby.connect('c3', 'carol', 'Carol')
        vi.advanceTimersByTime(GAME_TICK_INTERVAL)

        const [next] = transport.stream().filter(isBattle)
        expect(next.log.filter(l => l.type === 'INTERRUPTED')).toEqual([
            expect.objectContaining({ player: 'player1', spellIndex: 0, source: 'SPELL_COUNTERSPELL' }),
        ])
    })

    it('catches a joiner up with the full log, the current snapshot and no events, which come in the next broadcast', () => {
        const { lobby, transport } = startMatch()
        toHeldFireball(lobby)
        lobby.message('c1', { t: 'stop_cast', i: 0 })
        const battle = lobby.battle!

        lobby.connect('c3', 'carol', 'Carol')

        const catchUp = transport.to('c3').filter(isBattle)
        expect(catchUp).toEqual([
            {
                t: 'battle',
                logFrom: 0,
                log: battle.state.log,
                snap: viewSnapshot(battle.snapshot(), 'spectator'),
                events: [],
            },
        ])
        expect(catchUp[0].log.map(l => l.type)).toEqual(['START_CAST', ...RELEASE_LOG])

        transport.clear()
        vi.advanceTimersByTime(GAME_TICK_INTERVAL)
        expect(transport.stream().filter(isBattle)[0].events).toHaveLength(1)
    })

    it('catches up a joiner in the pause the same way', () => {
        const { lobby, transport } = startMatch({ bestOf: 1 })
        killByAction(lobby)
        lobby.disconnect('c1')
        const battle = lobby.battle!

        lobby.connect('c3', 'carol', 'Carol')

        expect(transport.to('c3').filter(isBattle)).toEqual([
            {
                t: 'battle',
                logFrom: 0,
                log: battle.state.log,
                snap: viewSnapshot(battle.snapshot(), 'spectator'),
                events: [],
            },
        ])
    })

    /** Two Fireball releases, calling `join` at each kind of point a join can land between two broadcasts. */
    const twoReleases = (join: (lobby: Lobby) => void = () => {}) => {
        const { lobby, transport } = startMatch()
        lobby.message('c1', { t: 'set_spells', spells: LOADOUT })
        toBattle(lobby)
        transport.clear()
        for (let release = 0; release < 2; release++) {
            holdFireball(lobby)
            join(lobby) // nothing pending
            lobby.message('c1', { t: 'stop_cast', i: 0 })
            join(lobby) // log entries and an event pending
            join(lobby) // the same entries pending, for a second joiner
            vi.advanceTimersByTime(GAME_TICK_INTERVAL)
        }
        return { battle: lobby.battle!, broadcasts: transport.stream().filter(isBattle), transport }
    }

    it('with joins between broadcasts, each log entry and event is in exactly one broadcast', () => {
        const alone = twoReleases()
        const { battle, broadcasts, transport } = twoReleases(lobby => {
            lobby.connect('c3', 'carol', 'Carol')
            lobby.disconnect('c3')
        })
        expect(transport.to('c3').filter(isBattle)).toHaveLength(6)

        const log = broadcasts.flatMap(m => m.log)
        const events = broadcasts.flatMap(m => m.events)
        expect(log).toEqual(battle.state.log)
        expect(log.filter(l => l.type === 'SPELL_RELEASE')).toHaveLength(2)
        expect(events.filter(e => e.source === 'SPELL_FIREBALL')).toHaveLength(2)
        expect(log).toEqual(alone.broadcasts.flatMap(m => m.log))
        expect(events).toEqual(alone.broadcasts.flatMap(m => m.events))

        // each broadcast picks up the log exactly where the one before it stopped
        let next = 0
        for (const message of broadcasts) {
            expect(message.logFrom).toBe(next)
            next += message.log.length
        }
        expect(next).toBe(battle.state.log.length)
    })
})

/** A second valid loadout, sharing no slot with LOADOUT except Counterspell. */
const LOADOUT_2: SpellId[] = [
    'SPELL_IGNITE',
    'SPELL_FIREBALL',
    'SPELL_COMBUSTION',
    'SPELL_METEOR',
    'SPELL_COUNTERSPELL',
    'SPELL_HASTE',
    'SPELL_TEMPORAL_SHIELD',
]

const errors = (transport: FakeTransport, connId: string) => transport.to(connId).filter(m => m.t === 'error')
const loadoutIds = (lobby: Lobby, key: 'player1' | 'player2') => lobby.battle!.state[key].spells.map(s => s.id)

describe('changing the loadout (#85)', () => {
    it('allows changes between rounds by default, and lets the host turn that off', () => {
        const { lobby } = setup()
        lobby.connect('c1', 'alice-id', 'Alice')
        expect(lobby.settings.allowSpellChange).toBe(true)
        lobby.message('c1', { t: 'settings', settings: { allowSpellChange: false } })
        expect(lobby.settings.allowSpellChange).toBe(false)
    })

    it('accepts a valid loadout and echoes it to its owner only', () => {
        const { lobby, transport } = startMatch()
        transport.clear()
        const before = transport.sent.length
        lobby.message('c1', { t: 'set_spells', spells: LOADOUT })
        expect(lobby.seats.player1!.spells).toEqual(LOADOUT)
        expect(transport.sent.slice(before)).toEqual([{ to: 'c1', msg: { t: 'loadout', spells: LOADOUT } }])
        expect(transport.broadcasts).toEqual([])
    })

    it('accepts a change in the set up of round 1', () => {
        const { lobby } = startMatch()
        expect(lobby.phase).toBe('set_up')
        lobby.message('c2', { t: 'set_spells', spells: LOADOUT_2 })
        expect(lobby.seats.player2!.spells).toEqual(LOADOUT_2)
    })

    it('accepts a change in the set up of a later round when spell changes are allowed', () => {
        const { lobby, transport } = startMatch({ allowSpellChange: true })
        toBattle(lobby)
        killPlayer2(lobby)
        seconds(10)
        expect(lobby).toMatchObject({ phase: 'set_up', round: 2 })
        lobby.message('c1', { t: 'set_spells', spells: LOADOUT })
        expect(lobby.seats.player1!.spells).toEqual(LOADOUT)
        expect(errors(transport, 'c1')).toEqual([])
    })

    it('has no set up after round 1 when spell changes are not allowed, and rejects the change', () => {
        const { lobby, transport } = startMatch({ allowSpellChange: false })
        toBattle(lobby)
        killPlayer2(lobby)
        seconds(10)
        expect(lobby).toMatchObject({ phase: 'battle_countdown', round: 2 })
        lobby.message('c1', { t: 'set_spells', spells: LOADOUT })
        expect(lobby.seats.player1!.spells).not.toEqual(LOADOUT)
        expect(errors(transport, 'c1')).toEqual([{ t: 'error', message: "Spells can't be changed now" }])
    })

    it.each(['battle_countdown', 'battle', 'round_over'] as const)('rejects a change in %s', phase => {
        const { lobby, transport } = startMatch()
        lobby.message('c1', { t: 'set_spells', spells: LOADOUT })
        lobby.message('c1', { t: 'ready' })
        lobby.message('c2', { t: 'ready' })
        seconds(3)
        if (phase !== 'battle_countdown') seconds(3)
        if (phase === 'round_over') killPlayer2(lobby)
        expect(lobby.phase).toBe(phase)
        transport.clear()
        lobby.message('c1', { t: 'set_spells', spells: LOADOUT_2 })
        expect(lobby.seats.player1!.spells).toEqual(LOADOUT)
        expect(errors(transport, 'c1')).toEqual([{ t: 'error', message: "Spells can't be changed now" }])
        expect(transport.to('c1').filter(m => m.t === 'loadout')).toEqual([])
    })

    it('rejects a change after the player is ready, in the lobby and in set up', () => {
        const { lobby, transport } = setup()
        lobby.connect('c1', 'alice-id', 'Alice')
        lobby.connect('c2', 'bob-id', 'Bob')
        lobby.message('c1', { t: 'ready' })
        lobby.message('c1', { t: 'set_spells', spells: LOADOUT })
        expect(errors(transport, 'c1')).toHaveLength(1)
        lobby.message('c1', { t: 'unready' })
        lobby.message('c1', { t: 'set_spells', spells: LOADOUT })
        expect(lobby.seats.player1!.spells).toEqual(LOADOUT)

        lobby.message('c1', { t: 'ready' })
        lobby.message('c2', { t: 'ready' })
        seconds(3)
        expect(lobby.phase).toBe('set_up')
        lobby.message('c1', { t: 'ready' })
        lobby.message('c1', { t: 'set_spells', spells: LOADOUT_2 })
        expect(lobby.seats.player1!.spells).toEqual(LOADOUT)
        expect(errors(transport, 'c1')).toHaveLength(2)
    })

    it('applies a change made in set up to the battle that follows it, and not to one that has started', () => {
        const { lobby } = startMatch()
        lobby.message('c1', { t: 'set_spells', spells: LOADOUT })
        toBattle(lobby)
        const first = lobby.battle!
        expect(loadoutIds(lobby, 'player1')).toEqual(LOADOUT)

        // a change during the battle is refused and leaves the live battle alone
        lobby.message('c1', { t: 'set_spells', spells: LOADOUT_2 })
        expect(loadoutIds(lobby, 'player1')).toEqual(LOADOUT)

        killPlayer2(lobby)
        seconds(10)
        expect(lobby).toMatchObject({ phase: 'set_up', round: 2 })
        lobby.message('c1', { t: 'set_spells', spells: LOADOUT_2 })
        // round 1's battle is finished business
        expect(first.state.player1.spells.map(s => s.id)).toEqual(LOADOUT)

        toBattle(lobby)
        expect(lobby.battle).not.toBe(first)
        expect(loadoutIds(lobby, 'player1')).toEqual(LOADOUT_2)
        expect(loadoutIds(lobby, 'player2')).toEqual(first.state.player2.spells.map(s => s.id))
    })

    it('returns the seat its current loadout on reconnecting, to that seat only', () => {
        const { lobby, transport } = startMatch()
        lobby.message('c1', { t: 'set_spells', spells: LOADOUT })
        lobby.message('c2', { t: 'set_spells', spells: LOADOUT_2 })
        lobby.connect('c3', 'carol-id', 'Carol')
        lobby.connect('c1b', 'alice-id', 'Alice')
        lobby.connect('c2b', 'bob-id', 'Bob')
        expect(transport.to('c1b')[0]).toEqual({ t: 'welcome', role: 'player1', spells: LOADOUT })
        expect(transport.to('c2b')[0]).toEqual({ t: 'welcome', role: 'player2', spells: LOADOUT_2 })
        expect(transport.to('c3')[0]).toEqual({ t: 'welcome', role: 'spectator', spells: null })
    })
})

/**
 * Whether `value` holds, anywhere inside it, a loadout: an array of the spell ids of `loadout`, or of spell states
 * (as a snapshot has them) with those ids.
 */
const holdsLoadout = (value: unknown, loadout: SpellId[]): boolean => {
    if (Array.isArray(value)) {
        const idOf = (v: unknown) => (typeof v === 'object' && v !== null ? (v as { id?: unknown }).id : v)
        if (value.length === loadout.length && value.every((v, i) => idOf(v) === loadout[i])) return true
        return value.some(v => holdsLoadout(v, loadout))
    }
    if (typeof value === 'object' && value !== null) return Object.values(value).some(v => holdsLoadout(v, loadout))
    return false
}

describe('keeping a loadout from the opponent (#86)', () => {
    /** Everything `connId` was sent: its own messages, the stream and the broadcasts. */
    const receivedBy = (transport: FakeTransport, connId: string) => [
        ...transport.to(connId),
        ...transport.stream(connId),
        ...transport.broadcasts,
    ]

    /** A two-round match with distinct loadouts and a spectator, played through a cast and a kill. */
    const play = () => {
        const ctx = startMatch({ bestOf: 3 })
        const { lobby } = ctx
        lobby.connect('c3', 'carol-id', 'Carol')
        lobby.message('c1', { t: 'set_spells', spells: LOADOUT })
        lobby.message('c2', { t: 'set_spells', spells: LOADOUT_2 })
        toBattle(lobby)
        lobby.message('c1', { t: 'start_cast', i: 0 })
        vi.advanceTimersByTime(300)
        lobby.message('c2', { t: 'start_cast', i: 5 }) // Haste, from the second general slot
        vi.advanceTimersByTime(100)
        killPlayer2(lobby)
        seconds(10)
        return ctx
    }

    it('never sends a player the opponent loadout, in any message', () => {
        const { transport } = play()
        expect(receivedBy(transport, 'c2').filter(m => holdsLoadout(m, LOADOUT))).toEqual([])
        expect(receivedBy(transport, 'c1').filter(m => holdsLoadout(m, LOADOUT_2))).toEqual([])
        // so the check can see a loadout when there is one
        expect(receivedBy(transport, 'c1').some(m => holdsLoadout(m, LOADOUT))).toBe(true)
        expect(receivedBy(transport, 'c2').some(m => holdsLoadout(m, LOADOUT_2))).toBe(true)
    })

    it('has no opponent spells in the battle snapshot, but each player has their own', () => {
        const { transport } = play()
        const last = (connId: string) => transport.stream(connId).filter(isBattle).at(-1)!.snap
        expect(last('c1').player1.spells!.map(s => s.id)).toEqual(LOADOUT)
        expect(last('c1').player2).not.toHaveProperty('spells')
        expect(last('c2').player2.spells!.map(s => s.id)).toEqual(LOADOUT_2)
        expect(last('c2').player1).not.toHaveProperty('spells')
    })

    it('lets spectators see both loadouts', () => {
        const { transport } = play()
        const { snap } = transport.stream('c3').filter(isBattle).at(-1)!
        expect(snap.player1.spells!.map(s => s.id)).toEqual(LOADOUT)
        expect(snap.player2.spells!.map(s => s.id)).toEqual(LOADOUT_2)
    })

    it('still names the spell of each cast the opponent can see', () => {
        const { transport } = play()
        const log = transport
            .stream('c2')
            .filter(isBattle)
            .flatMap(m => m.log)
        expect(log.find(l => l.type === 'START_CAST' && l.caster === 'player1')).toMatchObject({
            spellIndex: 0,
            spellId: 'SPELL_FIREBALL',
        })
        const mid = transport
            .stream('c2')
            .filter(isBattle)
            .find(m => m.snap.player1.cast === 0)!
        expect(mid.snap.player1.casting).toMatchObject({ id: 'SPELL_FIREBALL' })
        expect(mid.snap.player1).not.toHaveProperty('spells')
    })

    it("shows spectators each player's spells in the round history, and players only hp", () => {
        const { lobby, transport } = play()
        const base = { round: 1, winner: 'player1', ticks: expect.any(Number) }
        const metaOf = (connId: string) => transport.stream(connId).filter(m => m.t === 'meta')
        const lastRounds = (connId: string) => {
            const meta = metaOf(connId).at(-1)
            return meta?.t === 'meta' ? meta.lobby.rounds : null
        }
        expect(lastRounds('c3')).toEqual([
            { ...base, player1: { hp: 100, spells: LOADOUT }, player2: { hp: 0, spells: LOADOUT_2 } },
        ])
        for (const player of ['c1', 'c2']) {
            expect(lastRounds(player)).toEqual([{ ...base, player1: { hp: 100 }, player2: { hp: 0 } }])
            expect(receivedBy(transport, player).filter(m => m.t === 'meta' && holdsLoadout(m, LOADOUT))).toEqual([])
            expect(receivedBy(transport, player).filter(m => m.t === 'meta' && holdsLoadout(m, LOADOUT_2))).toEqual([])
        }
        expect(lobby.info().rounds[0].player1).toEqual({ hp: 100 })
        expect(lobby.info('spectator').rounds[0].player1.spells).toEqual(LOADOUT)
    })

    it('redacts the catch-up an opponent or spectator gets when joining a battle', () => {
        const { lobby, transport } = startMatch()
        lobby.message('c1', { t: 'set_spells', spells: LOADOUT })
        lobby.message('c2', { t: 'set_spells', spells: LOADOUT_2 })
        toBattle(lobby)
        lobby.disconnect('c2')
        lobby.connect('c2b', 'bob-id', 'Bob')
        lobby.connect('c3', 'carol-id', 'Carol')

        const [bobCatchUp] = transport.to('c2b').filter(isBattle)
        expect(holdsLoadout(bobCatchUp, LOADOUT)).toBe(false)
        expect(bobCatchUp.snap.player2.spells!.map(s => s.id)).toEqual(LOADOUT_2)
        const [carolCatchUp] = transport.to('c3').filter(isBattle)
        expect(holdsLoadout(carolCatchUp, LOADOUT) && holdsLoadout(carolCatchUp, LOADOUT_2)).toBe(true)
        expect(transport.to('c2b').some(m => holdsLoadout(m, LOADOUT))).toBe(false)
    })
})

describe('Frost loadouts (#147)', () => {
    const FROST_LOADOUT: SpellId[] = [
        'SPELL_FROSTBOLT',
        'SPELL_GLACIER',
        'SPELL_ICE_SPEAR',
        'SPELL_ICY_TOUCH',
        'SPELL_COUNTERSPELL',
        'SPELL_HASTE',
        'SPELL_BLUR',
    ]

    it('accepts a Frost loadout and battles with it, one element per player', () => {
        const { lobby, transport } = startMatch()
        lobby.message('c1', { t: 'set_spells', spells: FROST_LOADOUT })
        lobby.message('c2', { t: 'set_spells', spells: LOADOUT })
        expect(transport.to('c1').at(-1)).toEqual({ t: 'loadout', spells: FROST_LOADOUT })
        toBattle(lobby)
        expect(lobby.battle!.state.player1.spells.map(s => s.id)).toEqual(FROST_LOADOUT)
        expect(lobby.battle!.state.player2.spells.map(s => s.id)).toEqual(LOADOUT)
    })

    it.each<[string, unknown]>([
        ['3 Frost spells and 1 Fire spell', ['SPELL_FIREBALL', ...FROST_LOADOUT.slice(1)]],
        ['3 Fire spells and 1 Frost spell', ['SPELL_GLACIER', ...LOADOUT.slice(1)]],
        ['5 Frost spells', [...FROST_LOADOUT.slice(0, 6), 'SPELL_FROST_FEVER']],
        [
            'a Frost loadout without Counterspell',
            [...FROST_LOADOUT.slice(0, 4), 'SPELL_FROST_BOMB', ...FROST_LOADOUT.slice(5)],
        ],
    ])('rejects %s from an untrusted client and keeps the previous loadout', (_, spells) => {
        const { lobby, transport } = startMatch()
        lobby.message('c1', { t: 'set_spells', spells: FROST_LOADOUT })
        transport.clear()
        lobby.message('c1', { t: 'set_spells', spells } as never)
        expect(lobby.seats.player1!.spells).toEqual(FROST_LOADOUT)
        expect(transport.sent).toEqual([{ to: 'c1', msg: { t: 'error', message: 'Invalid spell selection' } }])
    })

    it('resets Chilling at the start of each round', () => {
        const { lobby } = startMatch({ bestOf: 3 })
        lobby.message('c1', { t: 'set_spells', spells: FROST_LOADOUT })
        toBattle(lobby)
        const round1 = lobby.battle!
        lobby.message('c1', { t: 'start_cast', i: 1 })
        vi.advanceTimersByTime(round1.state.player1.spells[1].castTime * GAME_TICK_INTERVAL)
        lobby.message('c1', { t: 'stop_cast', i: 1 })
        expect(round1.state.player1.chilling).toBe(3)
        killPlayer2(lobby)
        seconds(10)
        expect(lobby.info()).toMatchObject({ phase: 'set_up', round: 2 })
        toBattle(lobby)
        expect(lobby.battle).not.toBe(round1)
        expect(lobby.battle!.state.player1.spells.map(s => s.id)).toEqual(FROST_LOADOUT)
        expect(lobby.battle!.state.player1.chilling).toBe(0)
    })
})

describe('keeping class resources from the opponent (#171)', () => {
    const FROST: SpellId[] = [
        'SPELL_FROSTBOLT',
        'SPELL_GLACIER',
        'SPELL_ICE_SPEAR',
        'SPELL_ICY_TOUCH',
        'SPELL_COUNTERSPELL',
        'SPELL_HASTE',
        'SPELL_BLUR',
    ]
    const ROLE: Record<string, 'player1' | 'player2' | 'spectator'> = {
        c1: 'player1',
        c2: 'player2',
        c2b: 'player2',
        c3: 'spectator',
        c4: 'spectator',
    }

    /** Every battle message a connection got, catch-ups (`send`) and stream (`sendEach`) alike. */
    const battlesTo = (transport: FakeTransport, connId: string) =>
        [...transport.to(connId), ...transport.stream(connId), ...transport.broadcasts].filter(isBattle)

    /** Every battle message sent so far: a player's never holds the opponent's Chilling, a spectator's holds both. */
    const expectRedacted = (transport: FakeTransport) => {
        const conns = new Set([...transport.sent, ...transport.streamed].map(s => s.to))
        let checked = 0
        for (const connId of conns) {
            const role = ROLE[connId]
            for (const { snap } of battlesTo(transport, connId)) {
                checked++
                for (const key of ['player1', 'player2'] as const) {
                    if (role === 'spectator' || role === key) expect(snap[key].chilling).toEqual(expect.any(Number))
                    else expect(JSON.stringify(snap[key]), `${connId} sees ${key}`).not.toContain('chilling')
                }
            }
        }
        expect(transport.broadcasts.filter(isBattle)).toEqual([])
        return checked
    }

    /** Player `connId` casts and releases slot `i` (Frostbolt 0, Glacier 1), so its Chilling goes up. */
    const castFrost = (lobby: Lobby, connId: 'c1' | 'c2', i: number) => {
        const key = ROLE[connId] as 'player1' | 'player2'
        lobby.message(connId, { t: 'start_cast', i })
        vi.advanceTimersByTime(lobby.battle!.state[key].spells[i].castTime * GAME_TICK_INTERVAL)
        lobby.message(connId, { t: 'stop_cast', i })
        vi.advanceTimersByTime(GAME_TICK_INTERVAL)
    }

    const frostMatch = (settings = {}) => {
        const ctx = startMatch(settings)
        ctx.lobby.connect('c3', 'carol-id', 'Carol')
        ctx.lobby.message('c1', { t: 'set_spells', spells: FROST })
        ctx.lobby.message('c2', { t: 'set_spells', spells: FROST })
        toBattle(ctx.lobby)
        castFrost(ctx.lobby, 'c1', 1)
        castFrost(ctx.lobby, 'c2', 0)
        expect(ctx.lobby.battle!.state.player1.chilling).toBe(3)
        expect(ctx.lobby.battle!.state.player2.chilling).toBe(1)
        return ctx
    }

    it("never streams a player the opponent's Chilling, from the first snapshot to every tick; a spectator gets both", () => {
        const { transport } = frostMatch()
        const toAlice = transport.stream('c1').filter(isBattle)
        const toBob = transport.stream('c2').filter(isBattle)
        expect(toAlice[0].snap.gameTick).toBe(0)
        expect(toAlice.length).toBeGreaterThan(100)
        expect(expectRedacted(transport)).toBeGreaterThan(300)
        expect(toAlice.at(-1)!.snap.player1.chilling).toBe(3)
        expect(toBob.at(-1)!.snap.player2.chilling).toBe(1)
        const { snap } = transport.stream('c3').filter(isBattle).at(-1)!
        expect([snap.player1.chilling, snap.player2.chilling]).toEqual([3, 1])
    })

    it("leaves the opponent's Chilling out of the catch-up on reconnect, and keeps it in a spectator's", () => {
        const { lobby, transport } = frostMatch()
        lobby.disconnect('c2')
        lobby.connect('c2b', 'bob-id', 'Bob')
        lobby.connect('c4', 'dave-id', 'Dave')
        const [bob] = transport.to('c2b').filter(isBattle)
        expect(bob.snap.player2.chilling).toBe(1)
        expect(bob.snap.player1).not.toHaveProperty('chilling')
        const [dave] = transport.to('c4').filter(isBattle)
        expect([dave.snap.player1.chilling, dave.snap.player2.chilling]).toEqual([3, 1])
        vi.advanceTimersByTime(500)
        expect(transport.stream('c2b').filter(isBattle).length).toBeGreaterThan(0)
        expectRedacted(transport)
    })

    it('redacts the deciding tick, the round over catch-up and the next round', () => {
        const { lobby, transport } = frostMatch({ bestOf: 3 })
        killPlayer2(lobby)
        expect(lobby.phase).toBe('round_over')
        const decided = transport.stream('c1').filter(isBattle).at(-1)!
        expect(decided.snap).toMatchObject({ winner: 'player1', finished: true })
        expect(decided.snap.player2).not.toHaveProperty('chilling')
        // a reconnect between rounds catches up on the finished battle
        lobby.disconnect('c2')
        lobby.connect('c2b', 'bob-id', 'Bob')
        expect(transport.to('c2b').filter(isBattle)).toHaveLength(1)
        seconds(10)
        expect(lobby.info()).toMatchObject({ phase: 'set_up', round: 2 })
        transport.clear()
        lobby.message('c1', { t: 'ready' })
        lobby.message('c2b', { t: 'ready' })
        seconds(3)
        seconds(3)
        expect(lobby.phase).toBe('battle')
        castFrost(lobby, 'c1', 0)
        const round2 = transport.stream('c2b').filter(isBattle)
        expect(round2[0].snap.gameTick).toBe(0)
        expect(lobby.battle!.state.player1.chilling).toBe(1)
        expect(expectRedacted(transport)).toBeGreaterThan(50)
    })

    it('redacts the end of the match, decided by an action', () => {
        const { lobby, transport } = frostMatch({ bestOf: 1 })
        lobby.battle!.state.player2.hp = 1
        castFrost(lobby, 'c1', 0)
        vi.advanceTimersByTime(GAME_TICK_INTERVAL)
        expect(lobby.phase).toBe('match_over')
        const last = transport.stream('c2').filter(isBattle).at(-1)!
        expect(last.snap).toMatchObject({ winner: 'player1', finished: true })
        expect(last.snap.player2.chilling).toBe(1)
        expect(last.snap.player1).not.toHaveProperty('chilling')
        expectRedacted(transport)
    })
})
