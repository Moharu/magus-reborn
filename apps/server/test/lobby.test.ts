import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpellId } from '@magus/engine'
import type { LobbyListing, ServerMessage } from '@magus/engine/protocol'
import { Lobby, RECONNECT_GRACE, type LobbyTransport } from '../src/lobby'

const FIRE: SpellId[] = [
    'SPELL_FIREBALL',
    'SPELL_IGNITE',
    'SPELL_COMBUSTION',
    'SPELL_AFTERBURN',
    'SPELL_LIVING_BOMB',
    'SPELL_METEOR',
]

class FakeTransport implements LobbyTransport {
    sent: { to: string; msg: ServerMessage }[] = []
    broadcasts: ServerMessage[] = []
    closedConns: string[] = []
    listings: (LobbyListing | null)[] = []
    wasClosed = false
    send(to: string, msg: ServerMessage) {
        this.sent.push({ to, msg })
    }
    broadcast(msg: ServerMessage) {
        this.broadcasts.push(msg)
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

const killPlayer2 = (lobby: Lobby) => {
    lobby.battle!.state.player2.hp = 0
    vi.advanceTimersByTime(50)
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

    it('clamps and ignores invalid values', () => {
        const { lobby } = setup()
        lobby.connect('c1', 'a', 'A')
        lobby.message('c1', {
            t: 'settings',
            settings: { bestOf: 4, setupTime: 0, maxSpectators: 99, allowSpellChange: 'yes' },
        })
        expect(lobby.settings).toEqual({ bestOf: 3, setupTime: 10, allowSpellChange: true, maxSpectators: 8 })
        lobby.message('c1', { t: 'settings', settings: { setupTime: Number.NaN } })
        expect(lobby.settings.setupTime).toBe(10)
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
        lobby.message('c1', { t: 'set_spells', spells: FIRE })
        expect(transport.to('c1').at(-1)).toEqual({ t: 'loadout', spells: FIRE })
        toBattle(lobby)
        expect(lobby.battle!.state.player1.spells.map(s => s.id)).toEqual(FIRE)
    })

    it('rejects invalid loadouts', () => {
        const { lobby, transport } = startMatch()
        const before = lobby.seats.player1!.spells
        for (const spells of [['SPELL_FIREBALL'], [...FIRE.slice(0, 5), 'SPELL_FIREBALL'], [...FIRE.slice(0, 5), 'NOPE'], 'x']) {
            lobby.message('c1', { t: 'set_spells', spells } as never)
        }
        expect(lobby.seats.player1!.spells).toEqual(before)
        expect(transport.to('c1').filter(m => m.t === 'error')).toHaveLength(4)
    })

    it('relays casts to the battle and broadcasts state every tick', () => {
        const { lobby, transport } = startMatch()
        toBattle(lobby)
        transport.broadcasts = []
        lobby.message('c1', { t: 'start_cast', i: 0 })
        vi.advanceTimersByTime(26 * 50)
        lobby.message('c1', { t: 'stop_cast', i: 0 })
        vi.advanceTimersByTime(50)
        expect(lobby.battle!.state.player2.hp).toBeCloseTo(94.4)
        const battleMessages = transport.broadcasts.filter(m => m.t === 'battle')
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

    it('skips set up after round 1 when spell changes are not allowed', () => {
        const { lobby } = startMatch({ allowSpellChange: false })
        lobby.message('c1', { t: 'set_spells', spells: FIRE })
        toBattle(lobby)
        killPlayer2(lobby)
        seconds(10)
        expect(lobby.phase).toBe('battle_countdown')
        lobby.message('c1', { t: 'set_spells', spells: [...FIRE].reverse() })
        seconds(3)
        expect(lobby.battle!.state.player1.spells.map(s => s.id)).toEqual(FIRE)
    })

    it('locks loadouts once a player is ready in set up', () => {
        const { lobby } = startMatch()
        lobby.message('c1', { t: 'ready' })
        lobby.message('c1', { t: 'set_spells', spells: FIRE })
        expect(lobby.seats.player1!.spells).not.toEqual(FIRE)
    })
})

describe('disconnects during a match', () => {
    it('pauses and resumes when the player reconnects', () => {
        const { lobby, transport } = startMatch()
        toBattle(lobby)
        vi.advanceTimersByTime(500)
        lobby.disconnect('c2')
        expect(lobby.info()).toMatchObject({ paused: true, pauseReason: 'Bob disconnected', player2: { connected: false } })
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
        seconds(RECONNECT_GRACE)
        expect(lobby.info()).toMatchObject({ phase: 'match_over', matchWinner: 'player1' })
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

    it('a second tab for the same player replaces the first', () => {
        const { lobby, transport } = setup()
        lobby.connect('c1', 'a', 'A')
        lobby.connect('c2', 'a', 'A')
        expect(transport.closedConns).toEqual(['c1'])
        expect(lobby.seats.player1!.connId).toBe('c2')
        expect(lobby.seats.player2).toBeNull()
    })
})

describe('rate limiting', () => {
    it('drops messages beyond the per-second budget', () => {
        const { lobby, transport } = setup()
        lobby.connect('c1', 'a', 'A')
        for (let i = 0; i < 100; i++) lobby.message('c1', { t: 'ping', at: i })
        expect(transport.to('c1').filter(m => m.t === 'pong')).toHaveLength(40)
    })
})
