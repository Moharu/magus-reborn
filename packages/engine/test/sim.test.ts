import { describe, expect, it } from 'vitest'
import { Battle, DEFAULT_SPELLS, DUMMY_HP, parseSimInput, secondsToTicks, simulate, type SimInput } from '../src'
import { CAST as FIREBALL_CAST, DAMAGE as FIREBALL_DAMAGE } from '../src/spells/fire/fireball'
import { DEBUFF_TOTAL_DAMAGE as IGNITE_TOTAL } from '../src/spells/fire/ignite'

const MIXED: SimInput = {
    loadout: ['SPELL_FIREBALL', 'SPELL_IGNITE', 'SPELL_COMBUSTION', 'SPELL_LIVING_BOMB', 'SPELL_HASTE', 'SPELL_BLUR'],
    policy: ['SPELL_HASTE', 'SPELL_IGNITE', 'SPELL_FIREBALL'],
}

describe('simulate', () => {
    it('is deterministic', () => {
        expect(simulate(MIXED)).toEqual(simulate(MIXED))
        const input: SimInput = { loadout: DEFAULT_SPELLS, policy: DEFAULT_SPELLS, durationSeconds: 90 }
        expect(simulate(input)).toEqual(simulate(input))
    })

    it('matches a hand-computed Fireball-only fight', () => {
        // 1.3s cast = 26 ticks, no gcd: releases at ticks 26, 52, ..., 1196 within 1200 ticks
        const casts = Math.floor(secondsToTicks(60) / secondsToTicks(FIREBALL_CAST))
        expect(casts).toBe(46)
        const result = simulate({ loadout: ['SPELL_FIREBALL'], policy: ['SPELL_FIREBALL'] })
        expect(result.durationSeconds).toBe(60)
        expect(result.totalDamage).toBeCloseTo(casts * FIREBALL_DAMAGE, 6)
        expect(result.dps).toBeCloseTo((casts * FIREBALL_DAMAGE) / 60, 5)
        expect(result.perSpell).toEqual({
            SPELL_FIREBALL: { damage: result.totalDamage, casts, share: 1 },
        })
    })

    it('attributes effect ticks to the spell that applied them', () => {
        // one Ignite cast: released at 1.6s, its 10s debuff finishes ticking by 11.6s, inside 12s
        const result = simulate({
            loadout: ['SPELL_IGNITE'],
            policy: ['SPELL_IGNITE'],
            maxCasts: { SPELL_IGNITE: 1 },
            durationSeconds: 12,
        })
        expect(result.perSpell.SPELL_IGNITE).toEqual({ damage: IGNITE_TOTAL, casts: 1, share: 1 })
        expect(result.totalDamage).toBe(IGNITE_TOTAL)
    })

    it('shares sum to 1 and per-spell damage sums to the total', () => {
        const result = simulate(MIXED)
        const rows = Object.values(result.perSpell)
        expect(rows.reduce((a, r) => a + r.damage, 0)).toBeCloseTo(result.totalDamage, 5)
        expect(rows.reduce((a, r) => a + r.share, 0)).toBeCloseTo(1, 5)
    })

    it('rejects policy spells missing from the loadout and unknown ids', () => {
        expect(() => simulate({ loadout: ['SPELL_FIREBALL'], policy: ['SPELL_IGNITE'] })).toThrow(/not in the loadout/)
        expect(() => simulate({ loadout: ['NOPE' as never], policy: [] })).toThrow(/unknown spell/)
    })
})

describe('simulate guards', () => {
    const base: SimInput = { loadout: ['SPELL_FIREBALL'], policy: ['SPELL_FIREBALL'] }
    it.each([Infinity, NaN, 0, -5])('rejects durationSeconds %s', durationSeconds => {
        expect(() => simulate({ ...base, durationSeconds })).toThrow(/finite positive/)
    })
    it('rejects non-integer, negative and out-of-loadout maxCasts', () => {
        expect(() => simulate({ ...base, maxCasts: { SPELL_FIREBALL: 0.5 } })).toThrow(/non-negative integer/)
        expect(() => simulate({ ...base, maxCasts: { SPELL_FIREBALL: -1 } })).toThrow(/non-negative integer/)
        expect(() => simulate({ ...base, maxCasts: { SPELL_IGNITE: 1 } })).toThrow(/not in the loadout/)
    })
})

describe('parseSimInput', () => {
    it('accepts a valid input', () => {
        const raw = { loadout: ['SPELL_FIREBALL'], policy: ['SPELL_FIREBALL'], durationSeconds: 30 }
        expect(parseSimInput(raw)).toEqual(raw)
    })

    it.each([
        [null, /JSON object/],
        [[], /JSON object/],
        [{ policy: ['SPELL_FIREBALL'] }, /"loadout"/],
        [{ loadout: ['SPELL_NOPE'], policy: ['SPELL_FIREBALL'] }, /"loadout"/],
        [{ loadout: ['SPELL_FIREBALL'] }, /"policy"/],
        [{ loadout: ['SPELL_FIREBALL'], policy: 'SPELL_FIREBALL' }, /"policy"/],
        [{ loadout: ['SPELL_FIREBALL'], policy: ['SPELL_FIREBALL'], durationSeconds: '60' }, /"durationSeconds"/],
        [{ loadout: ['SPELL_FIREBALL'], policy: ['SPELL_FIREBALL'], durationSeconds: -1 }, /"durationSeconds"/],
        [{ loadout: ['SPELL_FIREBALL'], policy: ['SPELL_FIREBALL'], maxCasts: { X: 1 } }, /"maxCasts"/],
        [{ loadout: ['SPELL_FIREBALL'], policy: ['SPELL_FIREBALL'], durationSeconds: Infinity }, /"durationSeconds"/],
        [{ loadout: ['SPELL_FIREBALL'], policy: ['SPELL_FIREBALL'], durationSeconds: NaN }, /"durationSeconds"/],
        [{ loadout: ['SPELL_FIREBALL'], policy: ['SPELL_FIREBALL'], maxCasts: { SPELL_FIREBALL: 1.5 } }, /"maxCasts"/],
        [{ loadout: ['SPELL_FIREBALL'], policy: ['SPELL_FIREBALL'], maxCasts: { SPELL_FIREBALL: -1 } }, /"maxCasts"/],
        [
            { loadout: ['SPELL_FIREBALL'], policy: ['SPELL_FIREBALL'], maxCasts: { SPELL_IGNITE: 1 } },
            /SPELL_IGNITE is not in the loadout/,
        ],
    ])('rejects %j', (raw, message) => {
        expect(() => parseSimInput(raw)).toThrow(message)
    })
})

describe('training dummy', () => {
    it('never dies and winner stays null, even over a long fight', () => {
        // simulate throws if the engine ever declares a winner
        expect(() => simulate({ ...MIXED, durationSeconds: 600 })).not.toThrow()

        // and check the engine state directly with the same dummy set-up
        const battle = new Battle(
            { name: 'Caster', spells: ['SPELL_FIREBALL'] },
            { name: 'Dummy', spells: [], hp: DUMMY_HP },
        )
        for (let i = 0; i < secondsToTicks(600); i++) {
            const p = battle.state.player1
            if (p.cast !== null && battle.state.gameTick >= p.castStartingTick! + p.spells[0].castTime)
                battle.stopCast('player1', 0)
            if (p.cast === null) battle.startCast('player1', 0)
            battle.tick()
            expect(battle.state.winner).toBeNull()
        }
        expect(battle.state.player2.hp).toBeGreaterThan(0)
    })
})
