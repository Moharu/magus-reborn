import { describe, expect, it } from 'vitest'
import {
    describePolicy,
    enumeratePolicies,
    evaluateCandidate,
    parseSimInput,
    rankResults,
    simulate,
    type PolicyRule,
    type SimInput,
    type SpellId,
} from '../src'
import { DAMAGE as FIREBALL_DAMAGE } from '../src/spells/fire/fireball'
import { BASE_DAMAGE as AFTERBURN_BASE, DAMAGE_PER_STACK } from '../src/spells/fire/afterburn'
import { DEBUFF_FINAL_DAMAGE, DEBUFF_TOTAL_DAMAGE as BOMB_TICKS } from '../src/spells/fire/living-bomb'
import { fromCenti, toCenti } from '../src/utils'

const HOLD_METEOR: PolicyRule = { spell: 'SPELL_METEOR', when: [{ type: 'enemyCounterspellOnCooldown' }] }

describe('conditional policy rules', () => {
    it('Living Bomb "only if not active" lets each bomb explode', () => {
        const loadout: SpellId[] = ['SPELL_LIVING_BOMB']
        const spam = simulate({ loadout, policy: ['SPELL_LIVING_BOMB'] })
        const smart = simulate({
            loadout,
            policy: [
                {
                    spell: 'SPELL_LIVING_BOMB',
                    when: [{ type: 'targetEffectsBelow', effect: 'DEBUFF_LIVING_BOMB', count: 1 }],
                },
            ],
        })
        // 1.5s cast + 11s bomb = 250 ticks per cycle: releases @30, 280, 530, 780, 1030; four explode by 60s
        expect(smart.perSpell.SPELL_LIVING_BOMB!.casts).toBe(5)
        expect(smart.totalDamage).toBeGreaterThan(4 * (BOMB_TICKS + DEBUFF_FINAL_DAMAGE))
        expect(smart.totalDamage).toBeLessThan(5 * (BOMB_TICKS + DEBUFF_FINAL_DAMAGE))
        // recasting replaces the bomb before it explodes: only ticks land
        expect(spam.perSpell.SPELL_LIVING_BOMB!.casts).toBe(40)
        expect(spam.totalDamage).toBeLessThan(BOMB_TICKS * 6)
    })

    it('caps Ignite stacks with targetEffectsBelow', () => {
        const result = simulate({
            loadout: ['SPELL_IGNITE'],
            policy: [
                { spell: 'SPELL_IGNITE', when: [{ type: 'targetEffectsBelow', effect: 'DEBUFF_IGNITE', count: 3 }] },
            ],
        })
        // three casts (starts @0, 32, 64) then idle until the first Ignite expires @232; period 232 ticks:
        // starts 232k + {0, 32, 64} for k = 0..4, plus @1160 (released @1192); @1192 would land past 1200
        expect(result.perSpell.SPELL_IGNITE!.casts).toBe(16)
    })

    it('gates Afterburn on recent Fireballs', () => {
        // Fireballs released @26, 52, 78, 104; Afterburn starts @104 with 4 in the last 10s and lands @126
        const result = simulate({
            loadout: ['SPELL_FIREBALL', 'SPELL_AFTERBURN'],
            policy: [
                {
                    spell: 'SPELL_AFTERBURN',
                    when: [{ type: 'recentReleasesAtLeast', spell: 'SPELL_FIREBALL', count: 4, seconds: 10 }],
                },
                'SPELL_FIREBALL',
            ],
            maxCasts: { SPELL_AFTERBURN: 1, SPELL_FIREBALL: 4 },
            durationSeconds: 6.3,
        })
        const afterburn = fromCenti(toCenti(AFTERBURN_BASE) + 4 * toCenti(DAMAGE_PER_STACK))
        expect(result.perSpell.SPELL_AFTERBURN).toEqual({ damage: afterburn, casts: 1, share: expect.any(Number) })
        expect(result.perSpell.SPELL_FIREBALL!.casts).toBe(4)
        expect(result.totalDamage).toBe(fromCenti(4 * toCenti(FIREBALL_DAMAGE) + toCenti(afterburn)))
    })

    it('a held Meteor fires freely unpressured, and only while the Counterspell is down under pressure', () => {
        const result = simulate({
            loadout: ['SPELL_FIREBALL', 'SPELL_METEOR'],
            policy: [HOLD_METEOR, 'SPELL_FIREBALL'],
        })
        // unpressured the dummy has no spells, so there is no Counterspell to wait for: Meteor spam
        const spam = simulate({ loadout: ['SPELL_METEOR'], policy: ['SPELL_METEOR'] })
        expect(result.perSpell).toEqual({ SPELL_METEOR: spam.perSpell.SPELL_METEOR })
        expect(result.dps).toBe(spam.dps)
        // under pressure the Counterspells land on Fireballs and the Meteors go out in the safe windows
        expect(result.pressure.interrupts.every(i => i.spell === 'SPELL_FIREBALL')).toBe(true)
        expect(result.pressure.perSpell.SPELL_METEOR!.casts).toBeGreaterThan(0)
    })

    it('bare ids still work and match the equivalent rule objects', () => {
        const ids: SimInput = {
            loadout: ['SPELL_IGNITE', 'SPELL_FIREBALL'],
            policy: ['SPELL_IGNITE', 'SPELL_FIREBALL'],
        }
        const rules: SimInput = { ...ids, policy: [{ spell: 'SPELL_IGNITE' }, { spell: 'SPELL_FIREBALL', when: [] }] }
        expect(simulate(rules)).toEqual(simulate(ids))
    })

    it('validates rules', () => {
        const base = { loadout: ['SPELL_METEOR'] }
        expect(() => parseSimInput({ ...base, policy: [{ spell: 'SPELL_NOPE' }] })).toThrow(/policy\[0\].*"spell"/)
        expect(() => parseSimInput({ ...base, policy: [{ spell: 'SPELL_METEOR', when: {} }] })).toThrow(/"when"/)
        expect(() => parseSimInput({ ...base, policy: [{ spell: 'SPELL_METEOR', when: [{ type: 'x' }] }] })).toThrow(
            /unknown condition/,
        )
        const below = (extra: object) => ({
            ...base,
            policy: [{ spell: 'SPELL_METEOR', when: [{ type: 'targetEffectsBelow', ...extra }] }],
        })
        expect(() => parseSimInput(below({ effect: 'DEBUFF_NOPE', count: 1 }))).toThrow(/"effect"/)
        expect(() => parseSimInput(below({ effect: 'DEBUFF_IGNITE', count: 1.5 }))).toThrow(/"count"/)
        const recent = (seconds: unknown) => ({
            ...base,
            policy: [
                {
                    spell: 'SPELL_METEOR',
                    when: [{ type: 'recentReleasesAtLeast', spell: 'SPELL_METEOR', count: 1, seconds }],
                },
            ],
        })
        expect(() => parseSimInput(recent(0))).toThrow(/"seconds"/)
        expect(() => parseSimInput({ ...base, policy: [{ spell: 'SPELL_FIREBALL' }] })).toThrow(/not in the loadout/)
        expect(() => parseSimInput({ ...base, policy: ['SPELL_NOPE'] })).toThrow(/unknown spell id: SPELL_NOPE/)
        expect(() => simulate({ loadout: ['SPELL_METEOR'], policy: [null as never] })).toThrow(/policy entry/)
        expect(() => simulate({ loadout: ['SPELL_METEOR'], policy: ['SPELL_NOPE' as never] })).toThrow(/unknown spell/)
        expect(() =>
            simulate({
                loadout: ['SPELL_METEOR'],
                policy: [{ spell: 'SPELL_METEOR', when: [{ type: 'nope' } as never] }],
            }),
        ).toThrow(/unknown condition/)
        expect(parseSimInput({ ...base, policy: [HOLD_METEOR, { spell: 'SPELL_METEOR' }] }).policy).toEqual([
            HOLD_METEOR,
            { spell: 'SPELL_METEOR' },
        ])
    })

    it('describes policies compactly', () => {
        expect(
            describePolicy([
                {
                    spell: 'SPELL_COMBUSTION',
                    when: [{ type: 'targetEffectsAtLeast', effect: 'DEBUFF_IGNITE', count: 6 }],
                },
                HOLD_METEOR,
                'SPELL_IGNITE',
            ]),
        ).toBe('combustion [ignite >= 6] > meteor [enemy counterspell on cooldown] > ignite')
    })
})

describe('using the safe window after the enemy Counterspell', () => {
    // Ignite / Combustion / Meteor. The smart policy only starts Meteor while the dummy's Counterspell is on
    // cooldown, so each Counterspell lands on a cheaper Ignite-phase cast and every Meteor lands.
    const loadout: SpellId[] = ['SPELL_IGNITE', 'SPELL_COMBUSTION', 'SPELL_METEOR']
    const smartPolicy: PolicyRule[] = [
        { spell: 'SPELL_COMBUSTION', when: [{ type: 'targetEffectsAtLeast', effect: 'DEBUFF_IGNITE', count: 6 }] },
        HOLD_METEOR,
        { spell: 'SPELL_IGNITE' },
    ]

    it('beats the naive Meteor-first policy and every plain priority order under pressure', () => {
        const smart = simulate({ loadout, policy: smartPolicy })
        const naive = simulate({ loadout, policy: ['SPELL_METEOR', 'SPELL_COMBUSTION', 'SPELL_IGNITE'] })
        expect(smart.dpsUnderPressure).toBeGreaterThan(naive.dpsUnderPressure)
        expect(smart.pressure.interrupts.some(i => i.spell === 'SPELL_METEOR')).toBe(false)
        expect(naive.pressure.interrupts.every(i => i.spell === 'SPELL_METEOR')).toBe(true)

        // the whole old policy space and more: every plain priority list of bare ids (3 + 6 + 3! orders)
        const plain = enumeratePolicies(loadout, { variants: {}, prune: false })
        expect(plain).toHaveLength(15)
        const bestPlain = rankResults(
            plain.map(policy => evaluateCandidate({ loadout, policy })),
            1,
        )[0]
        expect(smart.dpsUnderPressure).toBeGreaterThan(bestPlain.dpsUnderPressure)
    })

    it('needs the hold: the same rules with an unconditional Meteor do worse under pressure', () => {
        const smart = simulate({ loadout, policy: smartPolicy })
        const unheld = simulate({ loadout, policy: [smartPolicy[0], 'SPELL_METEOR', 'SPELL_IGNITE'] })
        expect(smart.dpsUnderPressure).toBeGreaterThan(unheld.dpsUnderPressure)
        // Meteor really lands under pressure: the policy beats itself with the Meteor rule removed
        expect(smart.pressure.perSpell.SPELL_METEOR!.casts).toBeGreaterThan(0)
        const withoutMeteor = simulate({ loadout, policy: [smartPolicy[0], smartPolicy[2]] })
        expect(smart.dpsUnderPressure).toBeGreaterThan(withoutMeteor.dpsUnderPressure)
        // unpressured there is no Counterspell, so the held Meteor is cast like a bare one
        expect(smart.perSpell.SPELL_METEOR!.casts).toBeGreaterThan(0)
        expect(smart.dps).toBe(unheld.dps)
    })
})
