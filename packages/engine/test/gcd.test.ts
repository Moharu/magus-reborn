import { afterEach, describe, expect, it } from 'vitest'
import {
    GLOBAL_COOLDOWN,
    GLOBAL_COOLDOWN_SECONDS,
    lockRemaining,
    secondsToTicks,
    simulate,
    SPELLS,
    type SpellId,
} from '../src'
import { advance, castFull, effectIds, FIRE, GENERAL, releases, setup, slot } from './helpers'

const ON_GCD: SpellId[] = ['SPELL_HASTE', 'SPELL_TEMPORAL_SHIELD', 'SPELL_MAGIC_EATER']
const OFF_GCD: SpellId[] = ['SPELL_COUNTERSPELL', 'SPELL_BLUR']

const cancels = (b: ReturnType<typeof setup>) => b.state.log.filter(l => l.type === 'CANCEL_CAST')

describe('global cooldown (#7)', () => {
    it('is 1 second, derived from the tick rate', () => {
        expect(GLOBAL_COOLDOWN_SECONDS).toBe(1)
        expect(GLOBAL_COOLDOWN).toBe(secondsToTicks(1))
        expect(GLOBAL_COOLDOWN).toBe(20)
    })

    it('only Counterspell and Blur are flagged off-GCD', () => {
        const flagged = Object.values(SPELLS)
            .filter(def => def.offGlobalCooldown)
            .map(def => def.id)
        expect(flagged.sort()).toEqual([...OFF_GCD].sort())
    })

    for (const first of ON_GCD) {
        it(`after ${first}, an on-GCD instant is rejected for 19 ticks and accepted at tick 20`, () => {
            const b = setup(GENERAL, FIRE)
            expect(castFull(b, 'player1', first)).toBe(true)
            const next = ON_GCD.find(id => id !== first)!
            const index = slot(b, 'player1', next)
            for (let t = 1; t < GLOBAL_COOLDOWN; t++) {
                advance(b, 1)
                expect(b.startCast('player1', index)).toBe(false)
            }
            advance(b, 1)
            expect(b.startCast('player1', index)).toBe(true)
        })
    }

    for (const id of OFF_GCD) {
        it(`${id} can be cast during the GCD and does not start one`, () => {
            const b = setup(GENERAL, FIRE)
            castFull(b, 'player1', 'SPELL_HASTE')
            advance(b, 1)
            const gcdEnd = b.state.player1.globalCooldown
            expect(b.startCast('player1', slot(b, 'player1', id))).toBe(true)
            expect(b.state.player1.globalCooldown).toBe(gcdEnd)

            // from an idle state it leaves the player free
            const c = setup(GENERAL, FIRE)
            expect(castFull(c, 'player1', id)).toBe(true)
            expect(c.state.player1.globalCooldown).toBe(0)
            expect(c.startCast('player1', slot(c, 'player1', 'SPELL_HASTE'))).toBe(true)
        })
    }

    it('off-GCD spells are still blocked by a Counterspell lock', () => {
        const b = setup(GENERAL, GENERAL)
        b.startCast('player2', slot(b, 'player2', 'SPELL_FIREBALL'))
        advance(b, 5)
        castFull(b, 'player1', 'SPELL_COUNTERSPELL')
        expect(effectIds(b, 'player2')).toContain('DEBUFF_COUNTERSPELL')
        const blur = slot(b, 'player2', 'SPELL_BLUR')
        expect(lockRemaining(b.state.player2, b.state.player2.spells[blur], b.state.gameTick)).toBe(60)
        expect(b.startCast('player2', blur)).toBe(false)
        advance(b, 60)
        expect(b.startCast('player2', blur)).toBe(true)
    })

    it('releasing a cast-time spell does not start a GCD', () => {
        const b = setup(GENERAL, FIRE)
        expect(castFull(b, 'player1', 'SPELL_FIREBALL')).toBe(true)
        expect(b.state.player1.globalCooldown).toBe(0)
        expect(b.startCast('player1', slot(b, 'player1', 'SPELL_HASTE'))).toBe(true)
    })

    it('after Haste, starting Fireball fails until the GCD ends, then succeeds', () => {
        const b = setup(GENERAL, FIRE)
        castFull(b, 'player1', 'SPELL_HASTE')
        const fireball = slot(b, 'player1', 'SPELL_FIREBALL')
        for (let t = 0; t < GLOBAL_COOLDOWN; t++) {
            expect(b.startCast('player1', fireball)).toBe(false)
            advance(b, 1)
        }
        expect(b.startCast('player1', fireball)).toBe(true)
        expect(b.state.player1.cast).toBe(fireball)
    })
})

describe('global cooldown and instant-cancel (#25)', () => {
    afterEach(() => {
        delete SPELLS.SPELL_HASTE.usableWhileCasting
    })

    it('an on-GCD instant mid-cast cancels the cast and starts the GCD', () => {
        const b = setup(GENERAL, FIRE)
        const fireball = slot(b, 'player1', 'SPELL_FIREBALL')
        b.startCast('player1', fireball)
        advance(b, 5)
        expect(b.startCast('player1', slot(b, 'player1', 'SPELL_MAGIC_EATER'))).toBe(true)
        expect(b.state.player1.cast).toBeNull()
        expect(cancels(b)).toHaveLength(1)
        expect(b.state.player1.globalCooldown).toBe(b.state.gameTick + GLOBAL_COOLDOWN)
        expect(b.startCast('player1', fireball)).toBe(false)
    })

    it('an off-GCD instant mid-cast cancels the cast without a GCD', () => {
        const b = setup(GENERAL, FIRE)
        const fireball = slot(b, 'player1', 'SPELL_FIREBALL')
        b.startCast('player1', fireball)
        advance(b, 5)
        expect(b.startCast('player1', slot(b, 'player1', 'SPELL_BLUR'))).toBe(true)
        expect(b.state.player1.cast).toBeNull()
        expect(cancels(b)).toHaveLength(1)
        expect(b.state.player1.globalCooldown).toBe(0)
        expect(b.startCast('player1', fireball)).toBe(true)
    })

    it('an instant rejected by the GCD does not cancel the cast', () => {
        const b = setup(GENERAL, FIRE)
        // no shipped instant keeps a cast going, so enable it for Haste to have a cast in progress under a GCD
        SPELLS.SPELL_HASTE.usableWhileCasting = true
        const fireball = slot(b, 'player1', 'SPELL_FIREBALL')
        b.startCast('player1', fireball)
        advance(b, 2)
        expect(b.startCast('player1', slot(b, 'player1', 'SPELL_HASTE'))).toBe(true)
        expect(b.state.player1.cast).toBe(fireball)
        advance(b, 1)
        expect(b.startCast('player1', slot(b, 'player1', 'SPELL_TEMPORAL_SHIELD'))).toBe(false)
        expect(b.state.player1.cast).toBe(fireball)
        expect(cancels(b)).toHaveLength(0)
        advance(b, b.state.player1.spells[fireball].castTime)
        expect(b.stopCast('player1', fireball)).toBe(true)
        expect(releases(b, 'player1')).toHaveLength(2)
    })
})

describe('simulator and the GCD', () => {
    it('waits out the GCD after Haste before starting Fireball', () => {
        // Haste at tick 0, GCD until 20, hasted Fireball (13 ticks) releases at 33; the next needs 26 more
        const result = simulate({
            loadout: ['SPELL_HASTE', 'SPELL_FIREBALL'],
            policy: ['SPELL_HASTE', 'SPELL_FIREBALL'],
            maxCasts: { SPELL_HASTE: 1 },
            durationSeconds: 2,
        })
        expect(result.perSpell.SPELL_FIREBALL?.casts).toBe(1)
    })
})
