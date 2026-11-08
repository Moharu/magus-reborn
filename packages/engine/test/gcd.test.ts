import { afterEach, describe, expect, it } from 'vitest'
import {
    GLOBAL_COOLDOWN,
    GLOBAL_COOLDOWN_SECONDS,
    gcdRemaining,
    lockRemaining,
    secondsToTicks,
    simulate,
    SPELLS,
    type SpellId,
} from '../src'
import { advance, castFull, effectIds, FIRE, GENERAL, putOnGcd, releases, restoreOffGcd, setup, slot } from './helpers'

/** Every GENERAL school spell is off the GCD since #84. */
const OFF_GCD: SpellId[] = [
    'SPELL_HASTE',
    'SPELL_COUNTERSPELL',
    'SPELL_TEMPORAL_SHIELD',
    'SPELL_MAGIC_EATER',
    'SPELL_BLUR',
]
/** General spells the tests put back on the GCD (`putOnGcd`) to get on-GCD instants; none ship. */
const ON_GCD_FIXTURES: SpellId[] = ['SPELL_HASTE', 'SPELL_TEMPORAL_SHIELD', 'SPELL_MAGIC_EATER']

/** An on-GCD fixture other than `id`, to start a GCD while `id` stays off it. */
const gcdTrigger = (id: SpellId): SpellId => (id === 'SPELL_HASTE' ? 'SPELL_TEMPORAL_SHIELD' : 'SPELL_HASTE')

const cancels = (b: ReturnType<typeof setup>) => b.state.log.filter(l => l.type === 'CANCEL_CAST')

afterEach(restoreOffGcd)

describe('global cooldown (#7)', () => {
    it('is 1 second, derived from the tick rate', () => {
        expect(GLOBAL_COOLDOWN_SECONDS).toBe(1)
        expect(GLOBAL_COOLDOWN).toBe(secondsToTicks(1))
        expect(GLOBAL_COOLDOWN).toBe(20)
    })

    it('the five GENERAL school spells, and only they, are flagged off-GCD (#84)', () => {
        const flagged = Object.values(SPELLS)
            .filter(def => def.offGlobalCooldown)
            .map(def => def.id)
        expect(flagged.sort()).toEqual([...OFF_GCD].sort())
        const general = Object.values(SPELLS)
            .filter(def => def.school === 'GENERAL')
            .map(def => def.id)
        expect(general.sort()).toEqual([...OFF_GCD].sort())
    })

    for (const first of ON_GCD_FIXTURES) {
        it(`after an on-GCD ${first}, an on-GCD instant is rejected for 19 ticks and accepted at tick 20`, () => {
            putOnGcd(...ON_GCD_FIXTURES)
            const b = setup(GENERAL, FIRE)
            expect(castFull(b, 'player1', first)).toBe(true)
            expect(b.state.player1.gcdUntil).toBe(b.state.gameTick + GLOBAL_COOLDOWN)
            const next = ON_GCD_FIXTURES.find(id => id !== first)!
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
        it(`${id} can be cast during the GCD and does not change it`, () => {
            const trigger = gcdTrigger(id)
            putOnGcd(trigger)
            const b = setup(GENERAL, FIRE)
            castFull(b, 'player1', trigger)
            advance(b, 1)
            const gcdEnd = b.state.player1.gcdUntil
            expect(gcdRemaining(b.state.player1, b.state.gameTick)).toBe(GLOBAL_COOLDOWN - 1)
            expect(b.startCast('player1', slot(b, 'player1', id))).toBe(true)
            expect(releases(b, 'player1')).toHaveLength(2)
            expect(b.state.player1.gcdUntil).toBe(gcdEnd)
        })

        it(`${id} does not start a GCD: an on-GCD instant and a cast are accepted on the next tick`, () => {
            const trigger = gcdTrigger(id)
            putOnGcd(trigger)
            const b = setup(GENERAL, FIRE)
            expect(castFull(b, 'player1', id)).toBe(true)
            expect(b.state.player1.gcdUntil).toBe(0)
            advance(b, 1)
            expect(b.startCast('player1', slot(b, 'player1', trigger))).toBe(true)

            const c = setup(GENERAL, FIRE)
            expect(castFull(c, 'player1', id)).toBe(true)
            advance(c, 1)
            const fireball = slot(c, 'player1', 'SPELL_FIREBALL')
            expect(c.startCast('player1', fireball)).toBe(true)
            expect(c.state.player1.cast).toBe(fireball)
        })

        it(`${id} is still rejected by its own cooldown during the GCD`, () => {
            const trigger = gcdTrigger(id)
            putOnGcd(trigger)
            const b = setup(GENERAL, FIRE)
            castFull(b, 'player1', id)
            advance(b, 1)
            castFull(b, 'player1', trigger)
            expect(gcdRemaining(b.state.player1, b.state.gameTick)).toBe(GLOBAL_COOLDOWN)
            expect(b.startCast('player1', slot(b, 'player1', id))).toBe(false)
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
        expect(b.state.player1.gcdUntil).toBe(0)
        expect(b.startCast('player1', slot(b, 'player1', 'SPELL_MAGIC_EATER'))).toBe(true)
    })

    it('after an on-GCD instant, starting Fireball fails until the GCD ends, then succeeds', () => {
        putOnGcd('SPELL_MAGIC_EATER')
        const b = setup(GENERAL, FIRE)
        castFull(b, 'player1', 'SPELL_MAGIC_EATER')
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
        delete SPELLS.SPELL_TEMPORAL_SHIELD.usableWhileCasting
    })

    for (const id of OFF_GCD) {
        it(`${id} mid-cast cancels the cast without a GCD (#84)`, () => {
            const b = setup(GENERAL, FIRE)
            const fireball = slot(b, 'player1', 'SPELL_FIREBALL')
            b.startCast('player1', fireball)
            advance(b, 5)
            expect(b.startCast('player1', slot(b, 'player1', id))).toBe(true)
            expect(b.state.player1.cast).toBeNull()
            expect(b.state.player1.castStartingTick).toBeNull()
            expect(cancels(b)).toEqual([
                { type: 'CANCEL_CAST', caster: 'player1', spellIndex: fireball, tick: b.state.gameTick },
            ])
            expect(b.state.player1.gcdUntil).toBe(0)
            expect(b.startCast('player1', fireball)).toBe(true)
        })
    }

    it('an on-GCD instant mid-cast cancels the cast and starts the GCD', () => {
        putOnGcd('SPELL_MAGIC_EATER')
        const b = setup(GENERAL, FIRE)
        const fireball = slot(b, 'player1', 'SPELL_FIREBALL')
        b.startCast('player1', fireball)
        advance(b, 5)
        expect(b.startCast('player1', slot(b, 'player1', 'SPELL_MAGIC_EATER'))).toBe(true)
        expect(b.state.player1.cast).toBeNull()
        expect(cancels(b)).toHaveLength(1)
        expect(b.state.player1.gcdUntil).toBe(b.state.gameTick + GLOBAL_COOLDOWN)
        expect(b.startCast('player1', fireball)).toBe(false)
    })

    it('Haste during a GCD still cancels the cast: it is not usable while casting (#84)', () => {
        const b = setup(GENERAL, FIRE)
        const fireball = slot(b, 'player1', 'SPELL_FIREBALL')
        b.startCast('player1', fireball)
        advance(b, 2)
        b.state.player1.gcdUntil = b.state.gameTick + GLOBAL_COOLDOWN
        expect(b.startCast('player1', slot(b, 'player1', 'SPELL_HASTE'))).toBe(true)
        expect(b.state.player1.cast).toBeNull()
        expect(cancels(b)).toHaveLength(1)
        advance(b, b.state.player1.spells[fireball].castTime)
        expect(b.stopCast('player1', fireball)).toBe(false)
        expect(releases(b, 'player1')).toHaveLength(1)
    })

    it('an on-GCD instant rejected by the GCD does not cancel the cast', () => {
        // a cast in progress under a GCD needs a usable-while-casting on-GCD instant; none ship
        putOnGcd('SPELL_TEMPORAL_SHIELD', 'SPELL_MAGIC_EATER')
        SPELLS.SPELL_TEMPORAL_SHIELD.usableWhileCasting = true
        const b = setup(GENERAL, FIRE)
        const fireball = slot(b, 'player1', 'SPELL_FIREBALL')
        b.startCast('player1', fireball)
        advance(b, 2)
        expect(b.startCast('player1', slot(b, 'player1', 'SPELL_TEMPORAL_SHIELD'))).toBe(true)
        expect(b.state.player1.cast).toBe(fireball)
        advance(b, 1)
        expect(b.startCast('player1', slot(b, 'player1', 'SPELL_MAGIC_EATER'))).toBe(false)
        expect(b.state.player1.cast).toBe(fireball)
        expect(cancels(b)).toHaveLength(0)
        advance(b, b.state.player1.spells[fireball].castTime)
        expect(b.stopCast('player1', fireball)).toBe(true)
        expect(releases(b, 'player1')).toHaveLength(2)
    })
})

describe('simulator and the GCD', () => {
    it('starts Fireball right after Haste, with no GCD to wait out (#84)', () => {
        // Haste at tick 0 starts no GCD; hasted Fireball (13 ticks) releases at 13, the next (26) at 39
        const result = simulate({
            loadout: ['SPELL_HASTE', 'SPELL_FIREBALL'],
            policy: ['SPELL_HASTE', 'SPELL_FIREBALL'],
            maxCasts: { SPELL_HASTE: 1 },
            durationSeconds: 2,
        })
        expect(result.perSpell.SPELL_FIREBALL?.casts).toBe(2)
    })
})

describe('GCD and Counterspell lock are independent (#37)', () => {
    /** player1 counterspells player2's Fireball, locking player2 for 60 ticks. */
    const lockPlayer2 = () => {
        const b = setup(GENERAL, GENERAL)
        b.startCast('player2', slot(b, 'player2', 'SPELL_FIREBALL'))
        advance(b, 5)
        castFull(b, 'player1', 'SPELL_COUNTERSPELL')
        return b
    }

    it('removing DEBUFF_COUNTERSPELL early does not shorten or remove the lock', () => {
        const b = lockPlayer2()
        const lockEnd = b.state.player2.lockedUntil
        expect(lockEnd).toBe(b.state.gameTick + 60)
        b.state.player2.effects = b.state.player2.effects.filter(e => e.id !== 'DEBUFF_COUNTERSPELL')
        advance(b, 1)
        expect(b.state.player2.lockedUntil).toBe(lockEnd)
        for (const id of GENERAL) {
            const i = slot(b, 'player2', id)
            expect(lockRemaining(b.state.player2, b.state.player2.spells[i], b.state.gameTick)).toBe(59)
            expect(b.startCast('player2', i)).toBe(false)
        }
        advance(b, 58)
        expect(b.startCast('player2', slot(b, 'player2', 'SPELL_BLUR'))).toBe(false)
        advance(b, 1)
        expect(b.startCast('player2', slot(b, 'player2', 'SPELL_BLUR'))).toBe(true)
    })

    it('a lock does not change the GCD', () => {
        const b = lockPlayer2()
        expect(b.state.player2.gcdUntil).toBe(0)
        expect(gcdRemaining(b.state.player2, b.state.gameTick)).toBe(0)
    })

    it('a GCD started while a lock is active does not extend the lock', () => {
        putOnGcd('SPELL_HASTE')
        const b = lockPlayer2()
        const lockEnd = b.state.player2.lockedUntil
        advance(b, 60)
        // lock expires exactly now; the first on-GCD spell starts a GCD without touching the lock
        expect(b.startCast('player2', slot(b, 'player2', 'SPELL_HASTE'))).toBe(true)
        expect(b.state.player2.gcdUntil).toBe(b.state.gameTick + GLOBAL_COOLDOWN)
        expect(b.state.player2.lockedUntil).toBe(lockEnd)

        // and a GCD started by player1 while player2 is locked leaves player2's lock alone
        const c = lockPlayer2()
        const cLockEnd = c.state.player2.lockedUntil
        advance(c, 1)
        expect(c.startCast('player1', slot(c, 'player1', 'SPELL_HASTE'))).toBe(true)
        expect(c.state.player2.lockedUntil).toBe(cLockEnd)
        expect(c.state.player2.gcdUntil).toBe(0)
    })

    for (const id of OFF_GCD) {
        it(`${id} is blocked by a lock but not by the GCD`, () => {
            const trigger = gcdTrigger(id)
            putOnGcd(trigger)
            const g = setup(GENERAL, GENERAL)
            castFull(g, 'player2', trigger)
            expect(gcdRemaining(g.state.player2, g.state.gameTick)).toBe(GLOBAL_COOLDOWN)
            const gi = slot(g, 'player2', id)
            expect(lockRemaining(g.state.player2, g.state.player2.spells[gi], g.state.gameTick)).toBe(0)
            expect(g.startCast('player2', gi)).toBe(true)

            const b = lockPlayer2()
            const i = slot(b, 'player2', id)
            expect(lockRemaining(b.state.player2, b.state.player2.spells[i], b.state.gameTick)).toBe(60)
            expect(b.startCast('player2', i)).toBe(false)
        })
    }
})
