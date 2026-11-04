import { describe, expect, it } from 'vitest'
import { DEFAULT_SPELLS, parseSimInput, secondsToTicks, simulate, type SimInput } from '../src'
import { CAST as FIREBALL_CAST, DAMAGE as FIREBALL_DAMAGE } from '../src/spells/fire/fireball'
import { CAST as METEOR_CAST, DAMAGE as METEOR_DAMAGE } from '../src/spells/fire/meteor'
import { COOLDOWN, LOCK_DURATION } from '../src/spells/general/counterspell'
import { fromCenti, toCenti } from '../src/utils'

const METEOR: SimInput = { loadout: ['SPELL_METEOR'], policy: ['SPELL_METEOR'] }

describe('simulate under Counterspell pressure', () => {
    it('matches a hand-computed Meteor-only fight', () => {
        // Ticks are 50 ms. Meteor 3.6s = 72 ticks, R 0.4s = 8, lockout 3s = 60, Counterspell cooldown 11.7s = 234,
        // fight 60s = 1200 ticks. Unpressured: floor(1200 / 72) = 16 Meteors = 448 dmg.
        expect([METEOR_CAST, LOCK_DURATION, COOLDOWN]).toEqual([3.6, 3, 11.7])
        // Every Meteor is worth 28, so each window counters the earliest eligible one:
        //   cast @0 countered @8 (8 ticks of progress lost), locked until 68; Counterspell ready again @242.
        //   casts @68, @140, @212 land (releases @140, @212, @284); cast @212 is counterable @220 < 242, so it lands.
        //   cast @284 countered @292, locked until 352, ready @526: casts @352, @424, @496 land.
        //   cast @568 countered @576, locked until 636, ready @810: casts @636, @708, @780 land.
        //   cast @852 countered @860, locked until 920, ready @1094: casts @920, @992, @1064 land.
        //   cast @1136 would land @1208 > 1200, so it deals nothing and is not worth countering.
        // 4 interrupts (4 x 8 ticks of progress lost, 4 x 3s = 12s locked), 12 Meteors land: 12 x 28 = 336 dmg.
        const result = simulate(METEOR)
        expect(result.totalDamage).toBe(16 * METEOR_DAMAGE)
        expect(result.pressure.totalDamage).toBe(12 * METEOR_DAMAGE)
        expect(result.dpsUnderPressure).toBe(5.6)
        expect(result.risk).toBeCloseTo(448 / 60 - 336 / 60, 5)
        expect(result.pressure.interrupts.map(i => secondsToTicks(i.atSeconds))).toEqual([8, 292, 576, 860])
        expect(result.pressure.interrupts.every(i => i.spell === 'SPELL_METEOR')).toBe(true)
    })

    it('never counters instants or casts shorter than R', () => {
        const instants = simulate({
            loadout: ['SPELL_COMBUSTION', 'SPELL_HASTE', 'SPELL_BLUR'],
            policy: ['SPELL_HASTE', 'SPELL_BLUR'],
        })
        expect(instants.dpsUnderPressure).toBe(instants.dps)
        expect(instants.risk).toBe(0)
        expect(instants.pressure.interrupts).toEqual([])

        // Fireball (1.3s) is countered at R = 0.4s and at R = 1.3s (equal is not shorter), immune above it
        const fireball: SimInput = { loadout: ['SPELL_FIREBALL'], policy: ['SPELL_FIREBALL'] }
        expect(simulate(fireball).risk).toBeGreaterThan(0)
        expect(simulate({ ...fireball, pressure: { reactionSeconds: FIREBALL_CAST } }).risk).toBeGreaterThan(0)
        const immune = simulate({ ...fireball, pressure: { reactionSeconds: FIREBALL_CAST + 0.05 } })
        expect(immune.dpsUnderPressure).toBe(immune.dps)
        expect(immune.risk).toBe(0)
        expect(immune.pressure.interrupts).toEqual([])
    })

    it('counters the more valuable of two casts in the same window', () => {
        // Fireball @0-26 then Meteor @26-98: both counterable inside the first window [8, 242).
        // Meteor (28) is worth more than Fireball (5.6), so it is countered @34 even though Fireball comes first.
        // Fireball lands; Meteor restarts after the lock (94) and lands @166; the next window (268) is past the fight.
        const input: SimInput = {
            loadout: ['SPELL_FIREBALL', 'SPELL_METEOR'],
            policy: ['SPELL_FIREBALL', 'SPELL_METEOR'],
            maxCasts: { SPELL_FIREBALL: 1, SPELL_METEOR: 1 },
            durationSeconds: 10,
        }
        const result = simulate(input)
        expect(result.pressure.interrupts).toEqual([{ spell: 'SPELL_METEOR', startSeconds: 1.3, atSeconds: 1.7 }])
        expect(result.pressure.totalDamage).toBe(fromCenti(toCenti(FIREBALL_DAMAGE) + toCenti(METEOR_DAMAGE)))

        // 6s fight: the recast Meteor (94 + 72 = 166 > 120) can't finish, so only the Fireball lands
        const short = simulate({ ...input, durationSeconds: 6 })
        expect(short.pressure.interrupts.map(i => i.spell)).toEqual(['SPELL_METEOR'])
        expect(short.pressure.totalDamage).toBe(FIREBALL_DAMAGE)
        expect(short.totalDamage).toBe(fromCenti(toCenti(FIREBALL_DAMAGE) + toCenti(METEOR_DAMAGE)))
    })

    it('values Afterburn with the full log of recent Fireballs', () => {
        // Fireballs @0, 26, 52, 78, 104 (released by 130), then Afterburn @130-152: all in the first window [8, 242).
        // Afterburn reads the 5 Fireballs from state.log: 2.1 + 5 x 3.5 = 19.6 > Fireball's 5.6, so it is countered @138.
        const result = simulate({
            loadout: ['SPELL_FIREBALL', 'SPELL_AFTERBURN'],
            policy: ['SPELL_FIREBALL', 'SPELL_AFTERBURN'],
            maxCasts: { SPELL_FIREBALL: 5, SPELL_AFTERBURN: 1 },
            durationSeconds: 12,
        })
        expect(result.pressure.interrupts).toEqual([{ spell: 'SPELL_AFTERBURN', startSeconds: 6.5, atSeconds: 6.9 }])
    })

    it('does not spend Counterspell on a cast that would not land before the fight ends', () => {
        // Meteor needs 3.6s; in a 3s fight it never lands, so there is nothing worth countering
        const result = simulate({ ...METEOR, durationSeconds: 3 })
        expect(result.pressure.interrupts).toEqual([])
        expect(result.risk).toBe(0)
        // 6s fight: Meteor @0 lands @3.6 and is countered; the recast @3.4 (lock ends) would land @7, past the fight
        const six = simulate({ ...METEOR, durationSeconds: 6 })
        expect(six.pressure.interrupts.map(i => i.atSeconds)).toEqual([0.4])
    })

    it('is deterministic', () => {
        const inputs: SimInput[] = [
            METEOR,
            { loadout: DEFAULT_SPELLS, policy: DEFAULT_SPELLS, durationSeconds: 90 },
            {
                loadout: ['SPELL_IGNITE', 'SPELL_COMBUSTION', 'SPELL_LIVING_BOMB', 'SPELL_HASTE'],
                policy: ['SPELL_HASTE', 'SPELL_LIVING_BOMB', 'SPELL_IGNITE', 'SPELL_COMBUSTION'],
                maxCasts: { SPELL_LIVING_BOMB: 4, SPELL_IGNITE: 25 },
            },
        ]
        for (const input of inputs) {
            const first = simulate(input)
            for (let i = 0; i < 3; i++) expect(simulate(input)).toEqual(first)
        }
    })

    it('validates the reaction time', () => {
        expect(() => simulate({ ...METEOR, pressure: { reactionSeconds: -1 } })).toThrow(/reactionSeconds/)
        expect(() => simulate({ ...METEOR, pressure: { reactionSeconds: NaN } })).toThrow(/reactionSeconds/)
        // R must be at least one tick: 0 and 0.02s (rounds to 0 ticks) are rejected with a clear error
        expect(() => simulate({ ...METEOR, pressure: { reactionSeconds: 0 } })).toThrow(/at least 0.05s/)
        expect(() => simulate({ ...METEOR, pressure: { reactionSeconds: 0.02 } })).toThrow(/one tick/)
        expect(() => parseSimInput({ ...METEOR, pressure: { reactionSeconds: 0 } })).toThrow(/one tick/)
        expect(simulate({ ...METEOR, pressure: { reactionSeconds: 0.05 } }).pressure.interrupts[0].atSeconds).toBe(0.05)
        expect(() => parseSimInput({ ...METEOR, pressure: { reactionSeconds: '1' } })).toThrow(/reactionSeconds/)
        expect(() => parseSimInput({ ...METEOR, pressure: [] })).toThrow(/"pressure"/)
        expect(parseSimInput({ ...METEOR, pressure: { reactionSeconds: 1 } })).toEqual({
            ...METEOR,
            pressure: { reactionSeconds: 1 },
        })
    })
})
