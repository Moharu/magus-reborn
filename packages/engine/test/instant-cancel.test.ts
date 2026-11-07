import { afterEach, describe, expect, it } from 'vitest'
import { GLOBAL_COOLDOWN, MAX_HP, SPELLS } from '../src'
import { advance, castFull, effectIds, releases, setup, slot } from './helpers'

describe('using an instant mid-cast (#25)', () => {
    afterEach(() => {
        delete SPELLS.SPELL_BLUR.usableWhileCasting
    })

    it('no spell is usable while casting by default', () => {
        expect(Object.values(SPELLS).filter(def => def.usableWhileCasting)).toEqual([])
    })

    it('Haste mid-Fireball cancels the Fireball, applies the buff and hastes the next cast', () => {
        const b = setup()
        const fireball = slot(b, 'player2', 'SPELL_FIREBALL')
        const fullCast = b.state.player2.spells[fireball].castTime
        b.startCast('player2', fireball)
        advance(b, 10)
        expect(b.startCast('player2', slot(b, 'player2', 'SPELL_HASTE'))).toBe(true)

        expect(b.state.player2.cast).toBeNull()
        expect(b.state.player2.castStartingTick).toBeNull()
        expect(b.state.log.at(-2)).toEqual({
            type: 'CANCEL_CAST',
            caster: 'player2',
            spellIndex: fireball,
            tick: b.state.gameTick,
        })
        expect(b.state.log.at(-1)).toMatchObject({ type: 'SPELL_RELEASE', caster: 'player2' })
        expect(effectIds(b, 'player2')).toContain('BUFF_HASTE')

        // releasing the cancelled Fireball later does nothing
        advance(b, fullCast)
        expect(b.stopCast('player2', fireball)).toBe(false)
        expect(b.state.player1.hp).toBe(MAX_HP)
        expect(
            releases(b, 'player2').map(r => r.type === 'SPELL_RELEASE' && b.state.player2.spells[r.spellIndex].id),
        ).toEqual(['SPELL_HASTE'])

        const hasted = b.state.player2.spells[fireball].castTime
        expect(hasted).toBe(Math.ceil(fullCast / 2))
        b.startCast('player2', fireball)
        advance(b, hasted)
        expect(b.stopCast('player2', fireball)).toBe(true)
        expect(b.state.player1.hp).toBeLessThan(MAX_HP)
    })

    it("Counterspell mid-cast cancels the caster's own cast and still resolves", () => {
        const b = setup()
        b.startCast('player1', slot(b, 'player1', 'SPELL_FIREBALL'))
        b.startCast('player2', slot(b, 'player2', 'SPELL_FIREBALL'))
        advance(b, 5)
        expect(b.startCast('player2', slot(b, 'player2', 'SPELL_COUNTERSPELL'))).toBe(true)

        expect(b.state.player2.cast).toBeNull()
        expect(b.state.log.some(l => l.type === 'CANCEL_CAST' && l.caster === 'player2')).toBe(true)
        expect(b.state.player1.cast).toBeNull()
        expect(effectIds(b, 'player1')).toContain('DEBUFF_COUNTERSPELL')
    })

    it('Blur (off-GCD) mid-cast cancels the cast too', () => {
        const b = setup()
        b.startCast('player2', slot(b, 'player2', 'SPELL_FIREBALL'))
        advance(b, 5)
        expect(b.startCast('player2', slot(b, 'player2', 'SPELL_BLUR'))).toBe(true)
        expect(b.state.player2.cast).toBeNull()
        expect(effectIds(b, 'player2')).toContain('BUFF_BLUR')
    })

    it('an instant that fails to go off does not cancel the cast', () => {
        const b = setup()
        const haste = slot(b, 'player2', 'SPELL_HASTE')
        const fireball = slot(b, 'player2', 'SPELL_FIREBALL')
        expect(castFull(b, 'player2', 'SPELL_HASTE')).toBe(true)
        advance(b, GLOBAL_COOLDOWN)
        b.startCast('player2', fireball)
        advance(b, 2)
        expect(b.startCast('player2', haste)).toBe(false) // on cooldown
        expect(b.state.player2.cast).toBe(fireball)
        expect(b.state.log.some(l => l.type === 'CANCEL_CAST')).toBe(false)
    })

    it('with usableWhileCasting, the cast continues and releases normally', () => {
        SPELLS.SPELL_BLUR.usableWhileCasting = true
        const b = setup()
        const fireball = slot(b, 'player2', 'SPELL_FIREBALL')
        const start = b.state.gameTick
        b.startCast('player2', fireball)
        advance(b, 5)
        expect(b.startCast('player2', slot(b, 'player2', 'SPELL_BLUR'))).toBe(true)
        expect(effectIds(b, 'player2')).toContain('BUFF_BLUR')
        expect(b.state.player2.cast).toBe(fireball)
        expect(b.state.player2.castStartingTick).toBe(start)
        expect(b.state.log.some(l => l.type === 'CANCEL_CAST')).toBe(false)

        advance(b, b.state.player2.spells[fireball].castTime - 5)
        expect(b.stopCast('player2', fireball)).toBe(true)
        expect(b.state.player1.hp).toBeLessThan(MAX_HP)
    })
})
