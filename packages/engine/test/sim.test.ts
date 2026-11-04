import { describe, expect, it } from 'vitest'
import { Battle, DEFAULT_SPELLS, DUMMY_HP, secondsToTicks, simulate, type SimInput } from '../src'
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
        // a single Ignite cast with a 10s debuff, fully ticked out inside 15s
        const result = simulate({ loadout: ['SPELL_IGNITE'], policy: ['SPELL_IGNITE'], durationSeconds: 1.6 })
        expect(result.perSpell.SPELL_IGNITE?.casts).toBe(1)
        const long = simulate({
            loadout: ['SPELL_IGNITE', 'SPELL_HASTE'],
            policy: ['SPELL_HASTE'],
            durationSeconds: 30,
        })
        expect(long.totalDamage).toBe(0)
        const ignite = simulate({ loadout: ['SPELL_IGNITE'], policy: ['SPELL_IGNITE'], durationSeconds: 60 })
        expect(ignite.perSpell.SPELL_IGNITE!.damage).toBeGreaterThan(0)
        expect(ignite.perSpell.SPELL_IGNITE!.damage).toBeLessThanOrEqual(
            ignite.perSpell.SPELL_IGNITE!.casts * IGNITE_TOTAL + 1e-6,
        )
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
