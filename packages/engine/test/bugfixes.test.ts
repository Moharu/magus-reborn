import { describe, expect, it } from 'vitest'
import { Battle, cooldownRemaining, GLOBAL_COOLDOWN, SPELLS, type SpellId } from '../src'
import { advance, castFull, effectIds, FIRE, GENERAL, setup, slot } from './helpers'

describe('fixed original bugs', () => {
    it('recasting Haste refreshes it instead of stacking', () => {
        const b = setup(GENERAL, FIRE)
        castFull(b, 'player1', 'SPELL_HASTE')
        advance(b, 201)
        castFull(b, 'player1', 'SPELL_HASTE')
        const fireball = slot(b, 'player1', 'SPELL_FIREBALL')
        expect(b.state.player1.spells[fireball].castTime).toBe(13)
        expect(effectIds(b, 'player1')).toEqual(['BUFF_HASTE'])
    })

    it('cast times recover after a double Haste is consumed', () => {
        const b = setup(GENERAL, FIRE)
        castFull(b, 'player1', 'SPELL_HASTE')
        advance(b, 201)
        castFull(b, 'player1', 'SPELL_HASTE')
        advance(b, GLOBAL_COOLDOWN)
        castFull(b, 'player1', 'SPELL_FIREBALL')
        advance(b, 1)
        expect(effectIds(b, 'player1')).toEqual([])
        expect(b.state.player1.spells[slot(b, 'player1', 'SPELL_FIREBALL')].castTime).toBe(26)
    })

    it('Haste is consumed when an instant and a cast-time spell release on the same tick', () => {
        const b = setup(GENERAL, FIRE)
        castFull(b, 'player1', 'SPELL_HASTE')
        advance(b, GLOBAL_COOLDOWN)
        const fireball = slot(b, 'player1', 'SPELL_FIREBALL')
        b.startCast('player1', fireball)
        advance(b, 13)
        // release first: Blur mid-cast would cancel the Fireball (#25)
        b.stopCast('player1', fireball)
        b.startCast('player1', slot(b, 'player1', 'SPELL_BLUR'))
        advance(b, 1)
        expect(effectIds(b, 'player1')).not.toContain('BUFF_HASTE')
        expect(b.state.player1.spells[fireball].castTime).toBe(26)
    })

    it('a spell cast on tick 0 still goes on cooldown', () => {
        const b = new Battle({ name: 'A', spells: GENERAL }, { name: 'B', spells: FIRE })
        const blur = slot(b, 'player1', 'SPELL_BLUR')
        expect(b.startCast('player1', blur)).toBe(true)
        advance(b, 1)
        expect(cooldownRemaining(b.state.player1.spells[blur], b.state.gameTick)).toBe(299)
        expect(b.startCast('player1', blur)).toBe(false)
    })

    it('a spell is castable exactly when its cooldown display reaches 0', () => {
        const b = setup(GENERAL, FIRE)
        const blur = slot(b, 'player1', 'SPELL_BLUR')
        castFull(b, 'player1', 'SPELL_BLUR')
        advance(b, 299)
        expect(cooldownRemaining(b.state.player1.spells[blur], b.state.gameTick)).toBe(1)
        expect(b.startCast('player1', blur)).toBe(false)
        advance(b, 1)
        expect(cooldownRemaining(b.state.player1.spells[blur], b.state.gameTick)).toBe(0)
        expect(b.startCast('player1', blur)).toBe(true)
    })

    it("releasing an instant's key does not fire the spell being charged", () => {
        const b = setup(GENERAL, FIRE)
        const fireball = slot(b, 'player1', 'SPELL_FIREBALL')
        const blur = slot(b, 'player1', 'SPELL_BLUR')
        // since #25 an instant cancels the cast; opt Blur in to keep testing the key-release path
        SPELLS.SPELL_BLUR.usableWhileCasting = true
        try {
            b.startCast('player1', fireball)
            advance(b, 30)
            b.startCast('player1', blur)
            b.stopCast('player1', blur)
            expect(b.state.player2.hp).toBe(100)
            expect(b.state.player1.cast).toBe(fireball)
            b.stopCast('player1', fireball)
            expect(b.state.player2.hp).toBeCloseTo(94.4)
        } finally {
            delete SPELLS.SPELL_BLUR.usableWhileCasting
        }
    })

    it('Afterburn deals its base damage without Fireball equipped', () => {
        const loadout: SpellId[] = [
            'SPELL_AFTERBURN',
            'SPELL_IGNITE',
            'SPELL_COMBUSTION',
            'SPELL_LIVING_BOMB',
            'SPELL_METEOR',
            'SPELL_HASTE',
        ]
        const b = setup(loadout, GENERAL)
        castFull(b, 'player1', 'SPELL_AFTERBURN')
        expect(b.state.player2.hp).toBeCloseTo(100 - 2.1)
    })

    it('simultaneous deaths are a draw instead of a win for player 2', () => {
        const b = setup(FIRE, GENERAL)
        b.state.player1.hp = 5
        b.state.player2.hp = 5
        b.startCast('player1', slot(b, 'player1', 'SPELL_FIREBALL'))
        b.startCast('player2', slot(b, 'player2', 'SPELL_FIREBALL'))
        advance(b, 26)
        b.stopCast('player1', slot(b, 'player1', 'SPELL_FIREBALL'))
        b.stopCast('player2', slot(b, 'player2', 'SPELL_FIREBALL'))
        advance(b, 1)
        expect(b.state.winner).toBe('draw')
        expect(b.state.player1.hp).toBe(0)
        expect(b.state.player2.hp).toBe(0)
    })

    it('effects cleansed by Blur do not tick on the cleanse tick', () => {
        const b = setup(GENERAL, FIRE)
        castFull(b, 'player1', 'SPELL_BLUR')
        castFull(b, 'player2', 'SPELL_IGNITE')
        advance(b, 78 - 32 - 1)
        const hp = b.state.player1.hp
        advance(b, 1)
        expect(effectIds(b, 'player1')).toEqual([])
        expect(b.state.player1.hp).toBe(hp)
    })

    it('no spells can be cast once the battle has a winner', () => {
        const b = setup(FIRE, GENERAL)
        b.state.player2.hp = 5
        castFull(b, 'player1', 'SPELL_FIREBALL')
        advance(b, 1)
        expect(b.state.winner).toBe('player1')
        expect(b.startCast('player2', slot(b, 'player2', 'SPELL_TEMPORAL_SHIELD'))).toBe(false)
        expect(b.startCast('player1', slot(b, 'player1', 'SPELL_FIREBALL'))).toBe(false)
    })
})
