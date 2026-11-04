import { describe, expect, it } from 'vitest'
import { createSpellState } from '../src'
import { advance, castFull, effectIds, FIRE, GENERAL, releases, setup, slot } from './helpers'

const IGNITE_PER_TICK = 13.3 / 200

describe('spell timings', () => {
    it('converts seconds to 50ms ticks', () => {
        expect(createSpellState('SPELL_FIREBALL').castTime).toBe(26)
        expect(createSpellState('SPELL_AFTERBURN').castTime).toBe(22)
        expect(createSpellState('SPELL_METEOR').castTime).toBe(72)
        expect(createSpellState('SPELL_BLUR').cooldown).toBe(300)
        expect(createSpellState('SPELL_COUNTERSPELL').cooldown).toBe(234)
        expect(createSpellState('SPELL_HASTE').castTime).toBe(0)
    })

    it('every spell overrides the global cooldown to 0', () => {
        for (const id of [...FIRE, ...GENERAL]) expect(createSpellState(id).globalCooldown).toBe(0)
    })
})

describe('Fireball', () => {
    it('deals 5.6 damage when released after the full cast', () => {
        const b = setup()
        expect(castFull(b, 'player1', 'SPELL_FIREBALL')).toBe(true)
        expect(b.state.player2.hp).toBeCloseTo(94.4)
    })

    it('fizzles when released early', () => {
        const b = setup()
        b.startCast('player1', 0)
        advance(b, 25)
        expect(b.stopCast('player1', 0)).toBe(false)
        expect(b.state.player2.hp).toBe(100)
        expect(releases(b, 'player1')).toHaveLength(0)
        expect(b.state.player1.cast).toBeNull()
    })

    it('can be held past the cast time and released later', () => {
        const b = setup()
        b.startCast('player1', 0)
        advance(b, 80)
        expect(b.stopCast('player1', 0)).toBe(true)
        expect(b.state.player2.hp).toBeCloseTo(94.4)
    })
})

describe('Ignite', () => {
    it('deals 13.3 damage over 10 seconds then expires', () => {
        const b = setup()
        castFull(b, 'player1', 'SPELL_IGNITE')
        expect(effectIds(b, 'player2')).toEqual(['DEBUFF_IGNITE'])
        advance(b, 199)
        expect(b.state.player2.hp).toBeCloseTo(100 - 199 * IGNITE_PER_TICK)
        expect(effectIds(b, 'player2')).toEqual(['DEBUFF_IGNITE'])
        advance(b, 1)
        expect(b.state.player2.hp).toBeCloseTo(100 - 13.3)
        expect(effectIds(b, 'player2')).toEqual([])
    })

    it('stacks', () => {
        const b = setup()
        castFull(b, 'player1', 'SPELL_IGNITE')
        castFull(b, 'player1', 'SPELL_IGNITE')
        expect(effectIds(b, 'player2')).toEqual(['DEBUFF_IGNITE', 'DEBUFF_IGNITE'])
    })
})

describe('Living Bomb', () => {
    it('deals 7 over 11 seconds and explodes for 21 on expiry', () => {
        const b = setup()
        castFull(b, 'player1', 'SPELL_LIVING_BOMB')
        advance(b, 219)
        expect(b.state.player2.hp).toBeCloseTo(100 - (7 * 219) / 220)
        advance(b, 1)
        expect(b.state.player2.hp).toBeCloseTo(100 - 28)
        expect(effectIds(b, 'player2')).toEqual([])
    })

    it('replaces an existing living bomb and restarts its timer', () => {
        const b = setup()
        castFull(b, 'player1', 'SPELL_LIVING_BOMB')
        castFull(b, 'player1', 'SPELL_LIVING_BOMB')
        expect(effectIds(b, 'player2')).toEqual(['DEBUFF_LIVING_BOMB'])
        const hpAfterSecond = b.state.player2.hp
        advance(b, 219)
        expect(b.state.player2.hp).toBeCloseTo(hpAfterSecond - (7 * 219) / 220)
        advance(b, 1)
        expect(b.state.player2.hp).toBeCloseTo(hpAfterSecond - 28)
    })
})

describe('Combustion', () => {
    it('deals 4.2 with no ignites', () => {
        const b = setup()
        castFull(b, 'player1', 'SPELL_COMBUSTION')
        expect(b.state.player2.hp).toBeCloseTo(95.8)
    })

    it('adds the remaining damage of every ignite, which keep ticking', () => {
        const b = setup()
        castFull(b, 'player1', 'SPELL_IGNITE')
        castFull(b, 'player1', 'SPELL_COMBUSTION')
        // 48 ignite ticks during the combustion cast + 152 remaining ticks + 4.2 base
        expect(b.state.player2.hp).toBeCloseTo(100 - 13.3 - 4.2)
        expect(effectIds(b, 'player2')).toEqual(['DEBUFF_IGNITE'])
    })
})

describe('Afterburn', () => {
    it('deals 2.1 plus 3.5 per fireball cast in the last 10 seconds', () => {
        const b = setup()
        castFull(b, 'player1', 'SPELL_FIREBALL')
        castFull(b, 'player1', 'SPELL_FIREBALL')
        const before = b.state.player2.hp
        castFull(b, 'player1', 'SPELL_AFTERBURN')
        expect(before - b.state.player2.hp).toBeCloseTo(2.1 + 7)
    })

    it('ignores fireballs older than 10 seconds', () => {
        const b = setup()
        castFull(b, 'player1', 'SPELL_FIREBALL')
        advance(b, 200)
        const before = b.state.player2.hp
        castFull(b, 'player1', 'SPELL_AFTERBURN')
        expect(before - b.state.player2.hp).toBeCloseTo(2.1)
    })
})

describe('Meteor', () => {
    it('deals 28 after a 3.6 second cast', () => {
        const b = setup()
        castFull(b, 'player1', 'SPELL_METEOR')
        expect(b.state.player2.hp).toBeCloseTo(72)
    })
})

describe('Haste', () => {
    it('halves cast times (rounded up) and leaves instants alone', () => {
        const b = setup(GENERAL, FIRE)
        castFull(b, 'player1', 'SPELL_HASTE')
        const spells = b.state.player1.spells
        expect(spells[slot(b, 'player1', 'SPELL_FIREBALL')].castTime).toBe(13)
        expect(spells[slot(b, 'player1', 'SPELL_BLUR')].castTime).toBe(0)
        expect(effectIds(b, 'player1')).toEqual(['BUFF_HASTE'])
    })

    it('is not consumed by instants', () => {
        const b = setup(GENERAL, FIRE)
        castFull(b, 'player1', 'SPELL_HASTE')
        advance(b, 1)
        castFull(b, 'player1', 'SPELL_BLUR')
        advance(b, 2)
        expect(effectIds(b, 'player1')).toContain('BUFF_HASTE')
        expect(b.state.player1.spells[slot(b, 'player1', 'SPELL_FIREBALL')].castTime).toBe(13)
    })

    it('is consumed by the next cast-time spell', () => {
        const b = setup(GENERAL, FIRE)
        castFull(b, 'player1', 'SPELL_HASTE')
        const start = b.state.gameTick
        castFull(b, 'player1', 'SPELL_FIREBALL')
        expect(b.state.gameTick - start).toBe(13)
        expect(b.state.player2.hp).toBeCloseTo(94.4)
        advance(b, 1)
        expect(effectIds(b, 'player1')).not.toContain('BUFF_HASTE')
        expect(b.state.player1.spells[slot(b, 'player1', 'SPELL_FIREBALL')].castTime).toBe(26)
    })

    it('expires after 60 seconds', () => {
        const b = setup(GENERAL, FIRE)
        castFull(b, 'player1', 'SPELL_HASTE')
        advance(b, 1200)
        expect(effectIds(b, 'player1')).toEqual([])
        expect(b.state.player1.spells[slot(b, 'player1', 'SPELL_FIREBALL')].castTime).toBe(26)
    })

    it('has a 10 second cooldown', () => {
        const b = setup(GENERAL, FIRE)
        castFull(b, 'player1', 'SPELL_HASTE')
        advance(b, 100)
        expect(castFull(b, 'player1', 'SPELL_HASTE')).toBe(false)
        advance(b, 101)
        expect(castFull(b, 'player1', 'SPELL_HASTE')).toBe(true)
    })
})

describe('Counter Spell', () => {
    it('interrupts the opponent and locks their spells for 3 seconds', () => {
        const b = setup(GENERAL, FIRE)
        b.startCast('player2', slot(b, 'player2', 'SPELL_METEOR'))
        advance(b, 30)
        castFull(b, 'player1', 'SPELL_COUNTERSPELL')
        expect(b.state.player2.cast).toBeNull()
        expect(effectIds(b, 'player2')).toEqual(['DEBUFF_COUNTERSPELL'])
        expect(b.state.player2.globalCooldown).toBe(b.state.gameTick + 60)
        advance(b, 59)
        expect(b.startCast('player2', 0)).toBe(false)
        advance(b, 1)
        expect(effectIds(b, 'player2')).toEqual([])
        expect(b.startCast('player2', 0)).toBe(true)
    })

    it('does nothing to an idle opponent but still goes on cooldown', () => {
        const b = setup(GENERAL, FIRE)
        castFull(b, 'player1', 'SPELL_COUNTERSPELL')
        expect(effectIds(b, 'player2')).toEqual([])
        expect(b.state.player2.globalCooldown).toBe(0)
        expect(castFull(b, 'player1', 'SPELL_COUNTERSPELL')).toBe(false)
    })
})

describe('Temporal Shield', () => {
    it('returns the caster to their hp from when it was applied', () => {
        const b = setup(GENERAL, FIRE)
        b.startCast('player2', slot(b, 'player2', 'SPELL_FIREBALL'))
        advance(b, 10)
        castFull(b, 'player1', 'SPELL_TEMPORAL_SHIELD')
        advance(b, 16)
        b.stopCast('player2', 0)
        expect(b.state.player1.hp).toBeCloseTo(94.4)
        advance(b, 7)
        expect(b.state.player1.hp).toBeCloseTo(94.4)
        advance(b, 1)
        expect(b.state.player1.hp).toBe(100)
        expect(effectIds(b, 'player1')).toEqual([])
    })
})

describe('Magic Eater', () => {
    it('heals for 40% of damage dealt', () => {
        const b = setup(GENERAL, FIRE)
        b.state.player1.hp = 50
        castFull(b, 'player1', 'SPELL_MAGIC_EATER')
        castFull(b, 'player1', 'SPELL_FIREBALL')
        advance(b, 1)
        expect(b.state.player1.hp).toBeCloseTo(50 + 5.6 * 0.4)
    })

    it('never heals above 100', () => {
        const b = setup(GENERAL, FIRE)
        b.state.player1.hp = 99
        castFull(b, 'player1', 'SPELL_MAGIC_EATER')
        castFull(b, 'player1', 'SPELL_FIREBALL')
        advance(b, 1)
        expect(b.state.player1.hp).toBe(100)
    })

    it('expires after 7.8 seconds', () => {
        const b = setup(GENERAL, FIRE)
        castFull(b, 'player1', 'SPELL_MAGIC_EATER')
        advance(b, 156)
        expect(effectIds(b, 'player1')).toEqual([])
    })
})

describe('Blur', () => {
    it('cleanses debuffs applied while active when it expires', () => {
        const b = setup(GENERAL, FIRE)
        castFull(b, 'player2', 'SPELL_IGNITE')
        advance(b, 1)
        castFull(b, 'player1', 'SPELL_BLUR')
        castFull(b, 'player2', 'SPELL_LIVING_BOMB')
        expect(effectIds(b, 'player1')).toEqual(['DEBUFF_IGNITE', 'BUFF_BLUR', 'DEBUFF_LIVING_BOMB'])
        advance(b, 78 - 30)
        // the ignite from before blur stays
        expect(effectIds(b, 'player1')).toEqual(['DEBUFF_IGNITE'])
    })

    it('does not cleanse Counter Spell', () => {
        const b = setup(GENERAL, GENERAL)
        castFull(b, 'player1', 'SPELL_BLUR')
        b.startCast('player1', slot(b, 'player1', 'SPELL_FIREBALL'))
        advance(b, 30)
        castFull(b, 'player2', 'SPELL_COUNTERSPELL')
        advance(b, 48)
        // blur has expired, the 3s lock is still there
        expect(effectIds(b, 'player1')).toEqual(['DEBUFF_COUNTERSPELL'])
    })
})
