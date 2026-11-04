import { describe, expect, it } from 'vitest'
import {
    Battle,
    simpleBuff,
    simpleDamage,
    simpleDebuff,
    simpleHeal,
    type IgniteDebuff,
    type MagicEaterBuff,
    type PlayerKey,
    type TemporalShieldBuff,
} from '../src'
import { advance, castFull, FIRE, GENERAL, setup } from './helpers'

const ignite = (b: Battle, on: PlayerKey, damage = 1000) =>
    simpleDebuff<IgniteDebuff>(b.state, on, {
        id: 'DEBUFF_IGNITE',
        label: 'Ignite',
        source: 'SPELL_IGNITE',
        damage,
        duration: 10,
    })

const magicEater = (b: Battle, on: PlayerKey, pendingDamage = 0) =>
    simpleBuff<MagicEaterBuff>(b.state, on, {
        id: 'BUFF_MAGIC_EATER',
        label: 'Magic Eater',
        source: 'SPELL_MAGIC_EATER',
        healingPercentage: 40,
        duration: 100,
        pendingDamage,
    })

/** Expires (and restores HP) on the next tick. */
const expiringShield = (b: Battle, on: PlayerKey, backup: number) =>
    simpleBuff<TemporalShieldBuff>(b.state, on, {
        id: 'BUFF_TEMPORAL_SHIELD',
        label: 'Temporal Shield',
        source: 'SPELL_TEMPORAL_SHIELD',
        healingPercentage: 100,
        duration: 1,
        backup,
    })

describe('Magic Eater damage attribution', () => {
    it('the buff no longer stores an HP snapshot', () => {
        const b = setup(GENERAL, FIRE)
        castFull(b, 'player1', 'SPELL_MAGIC_EATER')
        expect(b.state.player1.effects[0]).not.toHaveProperty('lastTargetHp')
    })

    it("heals 40% of the caster's Fireball damage", () => {
        const b = setup(GENERAL, FIRE)
        b.state.player1.hp = 50
        castFull(b, 'player1', 'SPELL_MAGIC_EATER')
        const before = b.state.player2.hp
        castFull(b, 'player1', 'SPELL_FIREBALL')
        advance(b, 1)
        expect(before - b.state.player2.hp).toBeCloseTo(5.6)
        expect(b.state.player1.hp).toBeCloseTo(50 + 5.6 * 0.4)
    })

    it("heals 40% of the caster's Ignite damage over time", () => {
        const b = setup(FIRE, GENERAL)
        b.state.player1.hp = 50
        ignite(b, 'player2', 13.3) // a debuff on player2 is applied by player1
        magicEater(b, 'player1')
        const before = b.state.player2.hp
        advance(b, 5)
        // drop the ignite and flush the damage dealt after the buff ticked last
        b.state.player2.effects = []
        advance(b, 1)
        const dealt = before - b.state.player2.hp
        expect(dealt).toBeCloseTo(13.3 / 2)
        expect(b.state.player1.hp).toBeCloseTo(50 + dealt * 0.4)
    })

    it('never heals above MAX_HP', () => {
        const b = setup(GENERAL, FIRE)
        b.state.player1.hp = 99
        castFull(b, 'player1', 'SPELL_MAGIC_EATER')
        castFull(b, 'player1', 'SPELL_FIREBALL')
        advance(b, 1)
        expect(b.state.player1.hp).toBe(100)
    })

    it('gives no healing when the enemy heals itself and loses HP again', () => {
        const b = setup(GENERAL, GENERAL)
        b.state.player1.hp = 50
        b.state.player2.hp = 50
        castFull(b, 'player1', 'SPELL_MAGIC_EATER')
        advance(b, 1)
        simpleHeal(b.state, 'player2', 20)
        advance(b, 1)
        b.state.player2.hp = 40
        advance(b, 5)
        expect(b.state.player1.hp).toBe(50)
    })

    it('gives no healing for damage from a source the caster does not own', () => {
        const b = setup(GENERAL, FIRE)
        b.state.player1.hp = 50
        castFull(b, 'player1', 'SPELL_MAGIC_EATER')
        simpleDamage(b.state, 'player2', 10, 'player2')
        b.state.player2.hp -= 5
        // the enemy's damage to the caster does not heal the caster either
        castFull(b, 'player2', 'SPELL_FIREBALL')
        advance(b, 5)
        expect(b.state.player1.hp).toBeCloseTo(50 - 5.6)
    })

    it('gives no healing after the buff expires', () => {
        const b = setup(GENERAL, FIRE)
        b.state.player1.hp = 50
        castFull(b, 'player1', 'SPELL_MAGIC_EATER')
        advance(b, 156)
        expect(b.state.player1.effects).toEqual([])
        castFull(b, 'player1', 'SPELL_FIREBALL')
        advance(b, 5)
        expect(b.state.player1.hp).toBe(50)
    })
})

describe('death is final within a tick', () => {
    it('a DoT tick to 0 followed by a same-tick Magic Eater heal leaves the player dead', () => {
        const b = new Battle({ name: 'A', spells: FIRE, hp: 1 }, { name: 'B', spells: FIRE })
        ignite(b, 'player1')
        magicEater(b, 'player1', 50) // runs after the ignite, would heal 20
        b.tick()
        expect(b.state.player1.hp).toBe(0)
        expect(b.state.winner).toBe('player2')
    })

    it('a DoT tick to 0 followed by a same-tick Temporal Shield expiry leaves the player dead', () => {
        const b = new Battle({ name: 'A', spells: FIRE, hp: 1 }, { name: 'B', spells: FIRE })
        ignite(b, 'player1')
        expiringShield(b, 'player1', 80)
        b.tick()
        expect(b.state.player1.hp).toBe(0)
        expect(b.state.winner).toBe('player2')
    })

    it('Temporal Shield expiry still restores a living player', () => {
        const b = new Battle({ name: 'A', spells: FIRE, hp: 30 }, { name: 'B', spells: FIRE })
        ignite(b, 'player1', 100)
        expiringShield(b, 'player1', 80)
        b.tick()
        expect(b.state.player1.hp).toBe(80)
        expect(b.state.winner).toBeNull()
    })

    it('same-tick lethal damage to both players is still a draw despite later heals', () => {
        const b = new Battle({ name: 'A', spells: FIRE, hp: 1 }, { name: 'B', spells: FIRE, hp: 1 })
        for (const key of ['player1', 'player2'] as const) {
            ignite(b, key)
            magicEater(b, key, 50)
            expiringShield(b, key, 80)
        }
        b.tick()
        expect(b.state.player1.hp).toBe(0)
        expect(b.state.player2.hp).toBe(0)
        expect(b.state.winner).toBe('draw')
    })
})
