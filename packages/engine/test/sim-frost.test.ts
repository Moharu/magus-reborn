import { describe, expect, it } from 'vitest'
import {
    canPrune,
    DAMAGE_POOL,
    DEFAULT_RULE_VARIANTS,
    describePolicy,
    enumerateShapeLoadouts,
    FROST_NUMBERS,
    isValidLoadout,
    parseCondition,
    parseSimInput,
    policySpells,
    search,
    simulate,
    SPELLBOOKS,
    type SpellId,
} from '../src'

const N = FROST_NUMBERS
const FOUR: SpellId[] = ['SPELL_FROSTBOLT', 'SPELL_ICE_SPEAR', 'SPELL_ICY_TOUCH', 'SPELL_FROST_FEVER']

describe('the simulator drives the real engine for Frost (#147)', () => {
    it('Frostbolt deals its damage per release', () => {
        // releases at ticks 30 and 60, the end of a 3 s fight
        const r = simulate({ loadout: ['SPELL_FROSTBOLT'], policy: ['SPELL_FROSTBOLT'], durationSeconds: 3 })
        expect(r.perSpell.SPELL_FROSTBOLT).toMatchObject({ casts: 2, damage: 2 * N.frostbolt.damage })
    })

    it('Ice Spear at 5 Chilling: five Frostbolts build the stacks, the spear spends them all', () => {
        // 5 Frostbolts (30 ticks each) to tick 150, then Ice Spear (40 ticks) released at tick 190
        const r = simulate({
            loadout: ['SPELL_FROSTBOLT', 'SPELL_ICE_SPEAR'],
            policy: [
                { spell: 'SPELL_ICE_SPEAR', when: [{ type: 'casterChillingAtLeast', count: 5 }] },
                'SPELL_FROSTBOLT',
            ],
            durationSeconds: 9.5,
        })
        expect(r.perSpell.SPELL_FROSTBOLT?.casts).toBe(5)
        expect(r.perSpell.SPELL_ICE_SPEAR).toMatchObject({
            casts: 1,
            damage: N.iceSpear.baseDamage + 5 * N.iceSpear.damagePerStack,
        })
    })

    it('Icy Touch waits for a stack and its GCD delays the next cast', () => {
        // Frostbolt releases at 30, Icy Touch at 30 starts the GCD to 50, so the next Frostbolt ends at 80 > 70
        const r = simulate({
            loadout: ['SPELL_FROSTBOLT', 'SPELL_ICY_TOUCH'],
            policy: ['SPELL_ICY_TOUCH', 'SPELL_FROSTBOLT'],
            durationSeconds: 3.5,
        })
        expect(r.perSpell.SPELL_FROSTBOLT?.casts).toBe(1)
        expect(r.perSpell.SPELL_ICY_TOUCH).toMatchObject({ casts: 1, damage: N.icyTouch.damage })
    })

    it('Icy Touch gets its Frost Fever bonus while the fever is kept up', () => {
        const r = simulate({
            loadout: ['SPELL_FROSTBOLT', 'SPELL_ICY_TOUCH', 'SPELL_FROST_FEVER'],
            policy: [
                {
                    spell: 'SPELL_FROST_FEVER',
                    when: [{ type: 'targetEffectsBelow', effect: 'DEBUFF_FROST_FEVER', count: 1 }],
                },
                'SPELL_ICY_TOUCH',
                'SPELL_FROSTBOLT',
            ],
            durationSeconds: 12,
        })
        const icy = r.perSpell.SPELL_ICY_TOUCH!
        expect(icy.casts).toBeGreaterThan(0)
        expect(icy.damage).toBeCloseTo(icy.casts * (N.icyTouch.damage + N.frostFeverBonus.SPELL_ICY_TOUCH!), 6)
    })

    it('counts Frost Bomb pulses toward Frost Bomb', () => {
        const r = simulate({ loadout: ['SPELL_FROST_BOMB'], policy: ['SPELL_FROST_BOMB'], durationSeconds: 1.5 })
        // released on the last tick: the idle-free fight ends before any pulse
        expect(r.perSpell.SPELL_FROST_BOMB).toMatchObject({ casts: 1, damage: 0 })
        const longer = simulate({
            loadout: ['SPELL_FROST_BOMB'],
            policy: [
                {
                    spell: 'SPELL_FROST_BOMB',
                    when: [{ type: 'targetEffectsBelow', effect: 'DEBUFF_FROST_BOMB', count: 1 }],
                },
            ],
            durationSeconds: 1.5 + 3 * N.frostBomb.pulseSeconds,
        })
        expect(longer.perSpell.SPELL_FROST_BOMB?.damage).toBe(3 * N.frostBomb.pulseDamage)
    })
})

describe('the casterChillingAtLeast condition', () => {
    it('parses, describes and rejects bad counts', () => {
        expect(parseCondition({ type: 'casterChillingAtLeast', count: 3 })).toEqual({
            type: 'casterChillingAtLeast',
            count: 3,
        })
        expect(() => parseCondition({ type: 'casterChillingAtLeast', count: -1 })).toThrow(/non-negative integer/)
        expect(() => parseCondition({ type: 'casterChillingAtLeast' })).toThrow(/non-negative integer/)
        expect(
            describePolicy([{ spell: 'SPELL_ICE_SPEAR', when: [{ type: 'casterChillingAtLeast', count: 5 }] }]),
        ).toBe('ice_spear [chilling >= 5]')
        const input = parseSimInput({
            loadout: ['SPELL_ICE_SPEAR'],
            policy: [{ spell: 'SPELL_ICE_SPEAR', when: [{ type: 'casterChillingAtLeast', count: 2 }] }],
        })
        expect(input.policy).toHaveLength(1)
    })
})

describe('sim:search covers Frost (#147)', () => {
    it('gives the 90 valid Frost loadouts: 15 Frost sets x 6 general pairs', () => {
        const loadouts = enumerateShapeLoadouts({ element: 'FROST' })
        expect(loadouts).toHaveLength(90)
        for (const l of loadouts) {
            expect(isValidLoadout(l, 'FROST')).toBe(true)
            expect(l.slice(0, 4).every(id => SPELLBOOKS.FROST.elementSpells.includes(id))).toBe(true)
        }
    })

    it('lets policies cast every Frost spell, with Frost rule variants', () => {
        for (const id of SPELLBOOKS.FROST.elementSpells) expect(DAMAGE_POOL).toContain(id)
        expect(policySpells([...FOUR, 'SPELL_COUNTERSPELL', 'SPELL_HASTE', 'SPELL_BLUR'])).toEqual([
            ...FOUR,
            'SPELL_HASTE',
        ])
        expect(DEFAULT_RULE_VARIANTS.SPELL_ICE_SPEAR).toContainEqual({
            spell: 'SPELL_ICE_SPEAR',
            when: [{ type: 'casterChillingAtLeast', count: 5 }],
        })
    })

    it('does not prune a policy that can cast both the on-GCD Icy Touch and the off-GCD Haste', () => {
        expect(canPrune(['SPELL_FROSTBOLT', 'SPELL_ICY_TOUCH', 'SPELL_HASTE'])).toBe(false)
        expect(canPrune(['SPELL_FROSTBOLT', 'SPELL_ICY_TOUCH'])).toBe(true)
        expect(canPrune(['SPELL_FROSTBOLT', 'SPELL_HASTE'])).toBe(true)
    })

    it('searches Frost loadouts through the real engine', () => {
        const { results, evaluated } = search({
            element: 'FROST',
            elementSpells: FOUR,
            generalSpells: ['SPELL_HASTE', 'SPELL_BLUR'],
            cap: 30,
            durationSeconds: 8,
            top: 3,
        })
        expect(evaluated).toBe(30)
        expect(results.length).toBeGreaterThan(0)
        for (const r of results) {
            expect(isValidLoadout(r.loadout, 'FROST')).toBe(true)
            expect(r.elementSpells).toEqual(FOUR)
            expect(r.dps).toBeGreaterThan(0)
            // the result is the simulator's own, rerun
            expect(simulate({ loadout: r.loadout, policy: r.policy, durationSeconds: 8 }).dps).toBe(r.dps)
        }
    })

    it('rejects Fire spells for a Frost search', () => {
        expect(() => enumerateShapeLoadouts({ element: 'FROST', elementSpells: ['SPELL_FIREBALL'] })).toThrow(
            /not one of the frost spells/,
        )
    })

    it('the approved numbers give the best Frost set 8.44 pressure DPS (#148, #167)', () => {
        // Frostbolt, Glacier, Frost Bomb, Ice Spear + Haste, the top row of the full search: Bomb (if not active) >
        // Haste > Ice Spear (at 5 Chilling) > Glacier, 60 s against the dummy with a 0.4 s reaction
        const { dps, dpsUnderPressure } = simulate({
            loadout: [
                'SPELL_FROSTBOLT',
                'SPELL_GLACIER',
                'SPELL_FROST_BOMB',
                'SPELL_ICE_SPEAR',
                'SPELL_COUNTERSPELL',
                'SPELL_HASTE',
                'SPELL_BLUR',
            ],
            policy: [
                {
                    spell: 'SPELL_FROST_BOMB',
                    when: [{ type: 'targetEffectsBelow', effect: 'DEBUFF_FROST_BOMB', count: 1 }],
                },
                'SPELL_HASTE',
                { spell: 'SPELL_ICE_SPEAR', when: [{ type: 'casterChillingAtLeast', count: 5 }] },
                'SPELL_GLACIER',
            ],
            durationSeconds: 60,
            pressure: { reactionSeconds: 0.4 },
        })
        expect(dpsUnderPressure).toBeCloseTo(8.441667, 6)
        expect(dpsUnderPressure.toFixed(2)).toBe('8.44')
        expect(dps).toBeCloseTo(9.916667, 6)
    })
})
