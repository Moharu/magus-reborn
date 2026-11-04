import { describe, expect, it } from 'vitest'
import { Battle, DamageMeter } from '../src'
import { advance, castFull, FIRE, GENERAL, releases, setup } from './helpers'

describe('battle', () => {
    it('declares a winner when hp drops to 0 and stops ticking', () => {
        const b = setup()
        b.state.player2.hp = 5
        castFull(b, 'player1', 'SPELL_FIREBALL')
        advance(b, 1)
        expect(b.state.winner).toBe('player1')
        expect(b.state.player2.hp).toBe(0)
        const tick = b.state.gameTick
        advance(b, 5)
        expect(b.state.gameTick).toBe(tick)
    })

    it('logs cast start, release and stop', () => {
        const b = setup()
        castFull(b, 'player1', 'SPELL_FIREBALL')
        expect(b.state.log.map(l => l.type)).toEqual(['START_CAST', 'STOP_CAST', 'SPELL_RELEASE'])
        expect(releases(b, 'player1')[0]).toMatchObject({ spellIndex: 0, tick: 36 })
    })

    it('starting a new cast replaces the current one', () => {
        const b = setup()
        b.startCast('player1', 0)
        advance(b, 10)
        b.startCast('player1', 5)
        expect(b.state.player1.cast).toBe(5)
        expect(b.state.player1.castStartingTick).toBe(b.state.gameTick)
    })

    it('rejects unknown spell slots', () => {
        const b = setup()
        expect(b.startCast('player1', 9)).toBe(false)
        expect(b.startCast('player1', -1)).toBe(false)
    })

    it('snapshots without the log, detached from live state', () => {
        const b = setup()
        const snap = b.snapshot()
        expect('log' in snap).toBe(false)
        snap.player1.hp = 1
        expect(b.state.player1.hp).toBe(100)
    })

    it('attributes hp changes to spells and effects', () => {
        const b = setup()
        castFull(b, 'player1', 'SPELL_IGNITE')
        b.drainEvents()
        castFull(b, 'player1', 'SPELL_FIREBALL')
        const events = b.drainEvents()
        expect(events.filter(e => e.source === 'SPELL_IGNITE')).toHaveLength(26)
        expect(events.filter(e => e.source === 'SPELL_FIREBALL')).toEqual([
            {
                tick: b.state.gameTick,
                player: 'player2',
                amount: expect.closeTo(-5.6),
                source: 'SPELL_FIREBALL',
                kind: 'spell',
            },
        ])
    })
})

describe('DamageMeter', () => {
    it('sums damage per spell against a dummy with effectively infinite hp', () => {
        const b = new Battle({ name: 'You', spells: FIRE }, { name: 'Dummy', spells: GENERAL, hp: 1e9 })
        const meter = new DamageMeter('player2')
        advance(b, 10)
        castFull(b, 'player1', 'SPELL_IGNITE')
        castFull(b, 'player1', 'SPELL_METEOR')
        advance(b, 200)
        meter.record(b.drainEvents())
        meter.setTick(b.state.gameTick)
        const summary = meter.summary()
        expect(summary.total).toBeCloseTo(13.3 + 28)
        expect(summary.rows.map(r => r.label)).toEqual(['Meteor', 'Ignite'])
        expect(summary.rows[0].hits).toBe(1)
        expect(summary.seconds).toBeCloseTo((200 + 72 - 1) / 20)
        expect(summary.dps).toBeCloseTo(summary.total / summary.seconds)
        expect(b.state.winner).toBeNull()
    })

    it('resets', () => {
        const meter = new DamageMeter('player2')
        meter.record([{ tick: 1, player: 'player2', amount: -3, source: 'SPELL_FIREBALL', kind: 'spell' }])
        meter.reset()
        expect(meter.summary()).toEqual({ total: 0, dps: 0, seconds: 0, rows: [] })
    })
})
