import { describe, expect, it } from 'vitest'
import {
    compareResults,
    DAMAGE_POOL,
    enumerateLoadouts,
    enumeratePolicies,
    rankResults,
    search,
    searchCandidates,
    type SearchResult,
    type SpellId,
} from '../src'

const POOL: SpellId[] = ['SPELL_FIREBALL', 'SPELL_IGNITE', 'SPELL_METEOR']

describe('enumerateLoadouts', () => {
    it('returns every subset of the given size, in pool order', () => {
        expect(enumerateLoadouts(POOL, 2)).toEqual([
            ['SPELL_FIREBALL', 'SPELL_IGNITE'],
            ['SPELL_FIREBALL', 'SPELL_METEOR'],
            ['SPELL_IGNITE', 'SPELL_METEOR'],
        ])
        // C(7, k)
        expect([0, 1, 2, 3, 4, 5, 6, 7].map(k => enumerateLoadouts(DAMAGE_POOL, k).length)).toEqual([
            1, 7, 21, 35, 35, 21, 7, 1,
        ])
        expect(enumerateLoadouts(POOL, 4)).toEqual([])
        expect(() => enumerateLoadouts(POOL, -1)).toThrow(/size/)
        expect(() => enumerateLoadouts(['SPELL_FIREBALL', 'SPELL_FIREBALL'], 1)).toThrow(/duplicate/)
    })
})

describe('enumeratePolicies', () => {
    it('plain priority permutations: k! orders, capped on request', () => {
        const four: SpellId[] = ['SPELL_FIREBALL', 'SPELL_IGNITE', 'SPELL_METEOR', 'SPELL_HASTE']
        expect(enumeratePolicies(four, { variants: {}, prune: false })).toHaveLength(24)
        expect(enumeratePolicies(POOL, { variants: {}, prune: false }).map(p => p.map(r => r.spell))).toEqual([
            ['SPELL_FIREBALL', 'SPELL_IGNITE', 'SPELL_METEOR'],
            ['SPELL_FIREBALL', 'SPELL_METEOR', 'SPELL_IGNITE'],
            ['SPELL_IGNITE', 'SPELL_FIREBALL', 'SPELL_METEOR'],
            ['SPELL_IGNITE', 'SPELL_METEOR', 'SPELL_FIREBALL'],
            ['SPELL_METEOR', 'SPELL_FIREBALL', 'SPELL_IGNITE'],
            ['SPELL_METEOR', 'SPELL_IGNITE', 'SPELL_FIREBALL'],
        ])
        expect(enumeratePolicies(four, { variants: {}, prune: false, cap: 5 })).toHaveLength(5)
        expect(enumeratePolicies(four, { cap: 0 })).toEqual([])
        // with pruning only the last rule may be terminal; Fireball, Ignite and Meteor all are, so no policy
        // uses all four (each behaviour is covered by a smaller loadout instead)
        expect(enumeratePolicies(four, { variants: {} })).toEqual([])
        expect(enumeratePolicies(['SPELL_FIREBALL', 'SPELL_HASTE'], { variants: {} })).toEqual([
            [{ spell: 'SPELL_HASTE' }, { spell: 'SPELL_FIREBALL' }],
        ])
    })

    it('counts the default rule variants with pruning', () => {
        // menus: Fireball [bare] (terminal); Ignite [bare, <3, <6] (1 terminal + 2 conditional);
        // Meteor [bare, hold] (1 terminal + 1 conditional). Only the last rule may be terminal.
        expect(enumeratePolicies(['SPELL_FIREBALL'])).toHaveLength(1)
        expect(enumeratePolicies(['SPELL_IGNITE'])).toHaveLength(3)
        expect(enumeratePolicies(['SPELL_METEOR'])).toHaveLength(2)
        // (Ignite cond, Fireball) = 2; Fireball first is terminal = 0
        expect(enumeratePolicies(['SPELL_FIREBALL', 'SPELL_IGNITE'])).toHaveLength(2)
        // (Meteor hold, Fireball) = 1
        expect(enumeratePolicies(['SPELL_FIREBALL', 'SPELL_METEOR'])).toHaveLength(1)
        // (Ignite cond, Meteor any) = 2 x 2; (Meteor hold, Ignite any) = 1 x 3
        expect(enumeratePolicies(['SPELL_IGNITE', 'SPELL_METEOR'])).toHaveLength(7)
        // Fireball last; (Ignite cond, Meteor hold) = 2, (Meteor hold, Ignite cond) = 2
        expect(enumeratePolicies(POOL)).toHaveLength(4)
        expect(searchCandidates({ size: 2, pool: POOL })).toHaveLength(1 + 3 + 2 + 2 + 1 + 7)
        expect(searchCandidates({ size: 3, pool: POOL })).toHaveLength(16 + 4)
        // without pruning: 3! orders x 1 x 3 x 2 variants
        expect(enumeratePolicies(POOL, { prune: false })).toHaveLength(36)
    })

    it('does not prune when an off-GCD spell could still fire after a terminal rule', () => {
        expect(enumeratePolicies(['SPELL_FIREBALL', 'SPELL_BLUR'], { variants: {} })).toHaveLength(2)
    })
})

describe('search', () => {
    it('is deterministic and independent of sharding', () => {
        const options = { size: 2, pool: POOL, top: Infinity, durationSeconds: 20 }
        const first = search(options)
        expect(first.evaluated).toBe(16)
        expect(search(options)).toEqual(first)
        const shards = [0, 1, 2].map(index => search({ ...options, shard: { index, count: 3 } }))
        expect(shards.reduce((n, s) => n + s.evaluated, 0)).toBe(16)
        expect(
            rankResults(
                shards.flatMap(s => s.results),
                Infinity,
            ),
        ).toEqual(first.results)
        expect(search({ ...options, top: 3 }).results).toEqual(first.results.slice(0, 3))
    })

    it('ranks by dpsUnderPressure, with dps and risk alongside', () => {
        const { results } = search({ size: 2, pool: POOL, durationSeconds: 20, top: Infinity, dedupe: false })
        expect(results).toHaveLength(16)
        for (let i = 1; i < results.length; i++) {
            expect(results[i - 1].dpsUnderPressure).toBeGreaterThanOrEqual(results[i].dpsUnderPressure)
            expect(compareResults(results[i - 1], results[i])).toBeLessThan(0)
        }
        for (const r of results) expect(r.risk).toBeCloseTo(r.dps - r.dpsUnderPressure, 5)
    })

    it('breaks ties by dps, then fewer spells, then fewer conditions, then the policy JSON', () => {
        const base: SearchResult = {
            loadout: ['SPELL_FIREBALL'],
            policy: [{ spell: 'SPELL_FIREBALL' }],
            description: '',
            dps: 5,
            dpsUnderPressure: 4,
            risk: 1,
            totalDamage: 300,
            pressuredDamage: 240,
            cast: ['SPELL_FIREBALL'],
            castUnderPressure: ['SPELL_FIREBALL'],
            interrupts: [{ spell: 'SPELL_FIREBALL', startSeconds: 0, atSeconds: 0.4 }],
        }
        const higherDps = { ...base, dps: 6 }
        const bigger = { ...base, loadout: ['SPELL_FIREBALL', 'SPELL_HASTE'] as SpellId[] }
        const conditioned = { ...base, policy: [{ spell: 'SPELL_FIREBALL' as SpellId, when: [] }] }
        const withCondition = {
            ...base,
            policy: [{ spell: 'SPELL_FIREBALL' as SpellId, when: [{ type: 'enemyCounterspellOnCooldown' as const }] }],
        }
        expect(compareResults(higherDps, base)).toBeLessThan(0)
        expect(compareResults(base, bigger)).toBeLessThan(0)
        expect(compareResults(base, withCondition)).toBeLessThan(0)
        // same everything but the JSON: '{"spell":"SPELL_FIREBALL","when":[]}' sorts before '{"spell":"SPELL_FIREBALL"}'
        expect(compareResults(conditioned, base)).toBeLessThan(0)
        expect(compareResults(base, { ...base })).toBe(0)
        // dedupe folds identical behaviour into the first-ranked one
        const ranked = rankResults([withCondition, bigger, base], 10)
        expect(ranked).toEqual([{ ...base, equivalents: 2 }])
        // same totals but countered at a different moment: a different behaviour, not folded
        const laterCounter = {
            ...bigger,
            interrupts: [{ spell: 'SPELL_FIREBALL' as SpellId, startSeconds: 1.3, atSeconds: 1.7 }],
        }
        expect(rankResults([laterCounter, base], 10)).toEqual([base, laterCounter])
    })

    it('validates its bounds', () => {
        expect(() => search({ size: 0, pool: POOL })).toThrow(/size/)
        expect(() => search({ size: 4, pool: POOL })).toThrow(/size/)
        expect(() => search({ size: 1, pool: POOL, top: 0 })).toThrow(/top/)
        expect(() => search({ size: 1, pool: POOL, shard: { index: 3, count: 3 } })).toThrow(/shard/)
        expect(() => search({ size: 1, pool: ['SPELL_NOPE' as SpellId] })).toThrow(/unknown spell/)
    })
})
