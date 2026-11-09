import { describe, expect, it } from 'vitest'
import {
    canPrune,
    compareResults,
    DAMAGE_POOL,
    enumerateLoadouts,
    enumeratePolicies,
    enumerateShapeLoadouts,
    evaluateCandidate,
    FIXED_SLOT,
    isTerminalRule,
    isValidLoadout,
    policySpells,
    rankResults,
    search,
    searchCandidates,
    simulate,
    SPELLS,
    type PolicyRule,
    type RuleVariants,
    type SearchResult,
    type SpellId,
} from '../src'

const POOL: SpellId[] = ['SPELL_FIREBALL', 'SPELL_IGNITE', 'SPELL_METEOR']
const FIRE_FOUR: SpellId[] = ['SPELL_FIREBALL', 'SPELL_IGNITE', 'SPELL_COMBUSTION', 'SPELL_METEOR']
/** A real 0.2 loadout holding Fireball, Ignite, Combustion, Meteor and Haste. */
const LOADOUT: SpellId[] = [...FIRE_FOUR, 'SPELL_COUNTERSPELL', 'SPELL_HASTE', 'SPELL_BLUR']
const IGNITE_BELOW_3: PolicyRule = {
    spell: 'SPELL_IGNITE',
    when: [{ type: 'targetEffectsBelow', effect: 'DEBUFF_IGNITE', count: 3 }],
}
const HOLD_METEOR: PolicyRule = { spell: 'SPELL_METEOR', when: [{ type: 'enemyCounterspellOnCooldown' }] }
/** A small menu so unpruned enumerations stay cheap enough to simulate in full. */
const SMALL_VARIANTS: RuleVariants = {
    SPELL_IGNITE: [{ spell: 'SPELL_IGNITE' }, IGNITE_BELOW_3],
    SPELL_METEOR: [{ spell: 'SPELL_METEOR' }, HOLD_METEOR],
}
const spellsOf = (policy: PolicyRule[]) => policy.map(r => r.spell)
/** A policy cut after its first terminal rule: what it behaves like. */
const truncate = (policy: PolicyRule[]) => {
    const end = policy.findIndex(isTerminalRule)
    return end === -1 ? policy : policy.slice(0, end + 1)
}
const withoutEquivalents = ({ equivalents: _, ...rest }: SearchResult) => rest

describe('enumerateLoadouts', () => {
    it('returns every subset of the given size, in pool order', () => {
        expect(enumerateLoadouts(POOL, 2)).toEqual([
            ['SPELL_FIREBALL', 'SPELL_IGNITE'],
            ['SPELL_FIREBALL', 'SPELL_METEOR'],
            ['SPELL_IGNITE', 'SPELL_METEOR'],
        ])
        // C(7, k), over the Fire part of the pool and Haste
        const seven = DAMAGE_POOL.filter(id => SPELLS[id].school !== 'FROST')
        expect(seven).toHaveLength(7)
        expect([0, 1, 2, 3, 4, 5, 6, 7].map(k => enumerateLoadouts(seven, k).length)).toEqual([
            1, 7, 21, 35, 35, 21, 7, 1,
        ])
        // C(13, 4): the whole pool, Fire, Frost and Haste
        expect(enumerateLoadouts(DAMAGE_POOL, 4)).toHaveLength(715)
        expect(enumerateLoadouts(POOL, 4)).toEqual([])
        expect(() => enumerateLoadouts(POOL, -1)).toThrow(/size/)
        expect(() => enumerateLoadouts(['SPELL_FIREBALL', 'SPELL_FIREBALL'], 1)).toThrow(/duplicate/)
    })
})

describe('enumerateShapeLoadouts', () => {
    it('gives the 90 valid 0.2 loadouts: 15 Fire sets x 6 general pairs, Counterspell fixed', () => {
        const loadouts = enumerateShapeLoadouts()
        expect(loadouts).toHaveLength(90)
        expect(new Set(loadouts.map(l => JSON.stringify(l))).size).toBe(90)
        for (const l of loadouts) {
            expect(isValidLoadout(l)).toBe(true)
            expect(l[FIXED_SLOT]).toBe('SPELL_COUNTERSPELL')
        }
        expect(new Set(loadouts.map(l => l.slice(0, FIXED_SLOT).join())).size).toBe(15)
        expect(new Set(loadouts.map(l => l.slice(FIXED_SLOT + 1).join())).size).toBe(6)
        expect(loadouts[0]).toEqual([
            'SPELL_FIREBALL',
            'SPELL_IGNITE',
            'SPELL_COMBUSTION',
            'SPELL_AFTERBURN',
            'SPELL_COUNTERSPELL',
            'SPELL_HASTE',
            'SPELL_TEMPORAL_SHIELD',
        ])
    })

    it('narrows the pools, in spellbook order whatever order they are given in', () => {
        const narrowed = enumerateShapeLoadouts({
            elementSpells: [...FIRE_FOUR].reverse(),
            generalSpells: ['SPELL_BLUR', 'SPELL_HASTE', 'SPELL_TEMPORAL_SHIELD'],
        })
        expect(narrowed).toEqual([
            [...FIRE_FOUR, 'SPELL_COUNTERSPELL', 'SPELL_HASTE', 'SPELL_TEMPORAL_SHIELD'],
            [...FIRE_FOUR, 'SPELL_COUNTERSPELL', 'SPELL_HASTE', 'SPELL_BLUR'],
            [...FIRE_FOUR, 'SPELL_COUNTERSPELL', 'SPELL_TEMPORAL_SHIELD', 'SPELL_BLUR'],
        ])
        expect(() => enumerateShapeLoadouts({ elementSpells: POOL })).toThrow(/at least 4/)
        expect(() => enumerateShapeLoadouts({ generalSpells: ['SPELL_HASTE'] })).toThrow(/at least 2/)
        expect(() => enumerateShapeLoadouts({ elementSpells: [...FIRE_FOUR, 'SPELL_HASTE'] })).toThrow(/not one of/)
        expect(() => enumerateShapeLoadouts({ generalSpells: ['SPELL_HASTE', 'SPELL_COUNTERSPELL'] })).toThrow(
            /not one of/,
        )
    })

    it('lets policies cast the Fire spells and Haste only', () => {
        expect(policySpells(LOADOUT)).toEqual([...FIRE_FOUR, 'SPELL_HASTE'])
        expect(policySpells([...FIRE_FOUR, 'SPELL_COUNTERSPELL', 'SPELL_MAGIC_EATER', 'SPELL_BLUR'])).toEqual(FIRE_FOUR)
    })
})

describe('enumeratePolicies', () => {
    it('lists every subset in every order, depth first, capped on request', () => {
        expect(enumeratePolicies(POOL, { variants: {}, prune: false }).map(spellsOf)).toEqual([
            ['SPELL_FIREBALL'],
            ['SPELL_FIREBALL', 'SPELL_IGNITE'],
            ['SPELL_FIREBALL', 'SPELL_IGNITE', 'SPELL_METEOR'],
            ['SPELL_FIREBALL', 'SPELL_METEOR'],
            ['SPELL_FIREBALL', 'SPELL_METEOR', 'SPELL_IGNITE'],
            ['SPELL_IGNITE'],
            ['SPELL_IGNITE', 'SPELL_FIREBALL'],
            ['SPELL_IGNITE', 'SPELL_FIREBALL', 'SPELL_METEOR'],
            ['SPELL_IGNITE', 'SPELL_METEOR'],
            ['SPELL_IGNITE', 'SPELL_METEOR', 'SPELL_FIREBALL'],
            ['SPELL_METEOR'],
            ['SPELL_METEOR', 'SPELL_FIREBALL'],
            ['SPELL_METEOR', 'SPELL_FIREBALL', 'SPELL_IGNITE'],
            ['SPELL_METEOR', 'SPELL_IGNITE'],
            ['SPELL_METEOR', 'SPELL_IGNITE', 'SPELL_FIREBALL'],
        ])
        const four: SpellId[] = [...POOL, 'SPELL_HASTE']
        // 4 + 12 + 24 + 24
        expect(enumeratePolicies(four, { variants: {}, prune: false })).toHaveLength(64)
        expect(enumeratePolicies(four, { variants: {}, prune: false, cap: 5 })).toEqual(
            enumeratePolicies(four, { variants: {}, prune: false }).slice(0, 5),
        )
        expect(enumeratePolicies(four, { cap: 0 })).toEqual([])
        expect(() => enumeratePolicies(four, { cap: -1 })).toThrow(/cap/)
        expect(() => enumeratePolicies(['SPELL_FIREBALL', 'SPELL_FIREBALL'])).toThrow(/duplicates/)
    })

    it('ends a policy at its first terminal rule, Haste or not', () => {
        // Fireball, Ignite and Meteor bare are all terminal: only the one-rule lists are left
        expect(enumeratePolicies(POOL, { variants: {} })).toEqual([
            [{ spell: 'SPELL_FIREBALL' }],
            [{ spell: 'SPELL_IGNITE' }],
            [{ spell: 'SPELL_METEOR' }],
        ])
        // Haste is off-GCD, but nothing starts the GCD in 0.2, so it no longer turns pruning off
        expect(enumeratePolicies(['SPELL_FIREBALL', 'SPELL_HASTE'], { variants: {} })).toEqual([
            [{ spell: 'SPELL_FIREBALL' }],
            [{ spell: 'SPELL_HASTE' }],
            [{ spell: 'SPELL_HASTE' }, { spell: 'SPELL_FIREBALL' }],
        ])
        for (const policy of enumeratePolicies([...FIRE_FOUR, 'SPELL_HASTE']))
            expect(policy.slice(0, -1).some(isTerminalRule)).toBe(false)
    })

    it('counts the default rule variants per 0.2 loadout', () => {
        // menus: Fireball [bare] (terminal); Ignite [bare, <3, <6]; Meteor [bare, hold].
        // (Ignite cond, Meteor any) = 2 x 2; (Meteor hold, Ignite any) = 1 x 3; plus the 3 + 2 one-rule lists
        expect(enumeratePolicies(['SPELL_IGNITE', 'SPELL_METEOR'])).toHaveLength(12)
        const counts = enumerateShapeLoadouts().map(l => enumeratePolicies(policySpells(l)).length)
        expect(Math.min(...counts)).toBe(74)
        expect(Math.max(...counts)).toBe(2877)
        expect(counts.reduce((a, b) => a + b, 0)).toBe(56661)
    })
})

describe('pruning safety', () => {
    // FB, Ignite (bare, < 3), Meteor (bare, hold), Haste: a 0.2 loadout's damage spells, small menus
    const spells: SpellId[] = ['SPELL_FIREBALL', 'SPELL_IGNITE', 'SPELL_METEOR', 'SPELL_HASTE']
    const options = { durationSeconds: 15 }

    it('is on for every 0.2 loadout: no spell starts the GCD', () => {
        for (const l of enumerateShapeLoadouts()) expect(canPrune(l)).toBe(true)
    })

    it('a pruned policy behaves exactly like its prefix up to the terminal rule', () => {
        const all = enumeratePolicies(spells, { variants: SMALL_VARIANTS, prune: false })
        const pruned = enumeratePolicies(spells, { variants: SMALL_VARIANTS })
        // ordered subsets times variants: 6 + 26 + 3! x 12 + 4! x 4
        expect(all).toHaveLength(200)
        expect(pruned.length).toBeLessThan(all.length / 2)
        const prunedKeys = new Set(pruned.map(p => JSON.stringify(p)))
        const cache = new Map<string, unknown>()
        const run = (policy: PolicyRule[]) => {
            const key = JSON.stringify(policy)
            if (!cache.has(key)) cache.set(key, simulate({ loadout: LOADOUT, policy, ...options }))
            return cache.get(key)
        }
        let skipped = 0
        for (const policy of all) {
            const prefix = truncate(policy)
            expect(prunedKeys.has(JSON.stringify(prefix))).toBe(true)
            if (prefix.length === policy.length) continue
            skipped++
            expect(run(policy)).toEqual(run(prefix))
        }
        expect(skipped).toBe(all.length - pruned.length)
    })

    it('does not change the top results', () => {
        const shape = {
            elementSpells: FIRE_FOUR,
            generalSpells: ['SPELL_HASTE', 'SPELL_BLUR'] as SpellId[],
            variants: SMALL_VARIANTS,
            durationSeconds: 15,
            top: 5,
        }
        const pruned = search(shape)
        const full = search({ ...shape, prune: false })
        expect(full.evaluated).toBeGreaterThan(pruned.evaluated)
        // only how many equivalents got folded in differs
        expect(full.results.map(withoutEquivalents)).toEqual(pruned.results.map(withoutEquivalents))
    })

    it('stays off when an on-GCD instant could hold a terminal rule while an off-GCD spell fires', () => {
        const haste = SPELLS.SPELL_HASTE
        const loadout: SpellId[] = ['SPELL_FIREBALL', 'SPELL_COUNTERSPELL', 'SPELL_HASTE', 'SPELL_BLUR']
        try {
            // a hypothetical on-GCD Haste: no 0.2 spell is, but the engine keeps the rule
            SPELLS.SPELL_HASTE = { ...haste, offGlobalCooldown: false }
            expect(canPrune(['SPELL_FIREBALL', 'SPELL_HASTE', 'SPELL_BLUR'])).toBe(false)
            expect(canPrune(['SPELL_FIREBALL', 'SPELL_HASTE'])).toBe(true)
            const policy: PolicyRule[] = [
                { spell: 'SPELL_HASTE' },
                { spell: 'SPELL_FIREBALL' },
                { spell: 'SPELL_BLUR' },
            ]
            // Blur fires during Haste's GCD, after the terminal Fireball, so the prefix is not equivalent
            expect(simulate({ loadout, policy, durationSeconds: 20 }).perSpell.SPELL_BLUR?.casts).toBeGreaterThan(0)
            expect(
                enumeratePolicies(['SPELL_FIREBALL', 'SPELL_HASTE', 'SPELL_BLUR'], { variants: {} }).map(spellsOf),
            ).toContainEqual(spellsOf(policy))
        } finally {
            SPELLS.SPELL_HASTE = haste
        }
        expect(canPrune(['SPELL_FIREBALL', 'SPELL_HASTE', 'SPELL_BLUR'])).toBe(true)
    })
})

describe('searchCandidates', () => {
    it('simulates each distinct policy once, for every loadout that holds its spells', () => {
        const candidates = searchCandidates()
        expect(candidates).toHaveLength(9749)
        expect(candidates.reduce((n, c) => n + c.loadouts.length, 0)).toBe(56661)
        const fireballOnly = candidates.find(c => JSON.stringify(c.policy) === '[{"spell":"SPELL_FIREBALL"}]')!
        // C(5, 3) Fire sets with Fireball x 6 general pairs
        expect(fireballOnly.loadouts).toHaveLength(60)
        for (const { policy, loadouts } of candidates.slice(0, 500))
            for (const l of loadouts) for (const id of spellsOf(policy)) expect(l).toContain(id)
        // --cap still bounds the policies per loadout
        expect(searchCandidates({ cap: 3 }).every(c => c.loadouts.length >= 1)).toBe(true)
        const capped = searchCandidates({ cap: 3 })
        expect(capped.reduce((n, c) => n + c.loadouts.length, 0)).toBe(90 * 3)
    })

    it('gives the same result for a policy in any loadout that holds its spells', () => {
        const policies: PolicyRule[][] = [
            [IGNITE_BELOW_3, { spell: 'SPELL_FIREBALL' }],
            [{ spell: 'SPELL_HASTE' }, HOLD_METEOR, { spell: 'SPELL_IGNITE' }],
        ]
        for (const policy of policies) {
            const holders = enumerateShapeLoadouts().filter(l => spellsOf(policy).every(id => l.includes(id)))
            expect(holders.length).toBeGreaterThan(2)
            const first = simulate({ loadout: holders[0], policy, durationSeconds: 15 })
            for (const loadout of holders.slice(1))
                expect(simulate({ loadout, policy, durationSeconds: 15 })).toEqual(first)
        }
    })
})

describe('search', () => {
    const shape = {
        elementSpells: FIRE_FOUR,
        generalSpells: ['SPELL_HASTE', 'SPELL_BLUR', 'SPELL_TEMPORAL_SHIELD'] as SpellId[],
        variants: SMALL_VARIANTS,
        durationSeconds: 10,
    }

    it('is deterministic and independent of sharding', () => {
        const options = { ...shape, top: Infinity }
        const first = search(options)
        expect(first.evaluated).toBe(searchCandidates(options).length)
        expect(first.pairs).toBe(searchCandidates(options).reduce((n, c) => n + c.loadouts.length, 0))
        expect(search(options)).toEqual(first)
        const shards = [0, 1, 2].map(index => search({ ...options, shard: { index, count: 3 } }))
        expect(shards.reduce((n, s) => n + s.evaluated, 0)).toBe(first.evaluated)
        expect(shards.reduce((n, s) => n + s.pairs, 0)).toBe(first.pairs)
        expect(
            rankResults(
                shards.flatMap(s => s.results),
                Infinity,
            ),
        ).toEqual(first.results)
        expect(search({ ...options, top: 3 }).results).toEqual(first.results.slice(0, 3))
    })

    it('folds a policy once per loadout, the same as ranking every (loadout, policy) pair', () => {
        const every = search({ ...shape, top: Infinity, dedupe: false })
        expect(every.results).toHaveLength(every.pairs)
        expect(rankResults(every.results, Infinity)).toEqual(search({ ...shape, top: Infinity }).results)
        // and each copy is what simulating that loadout gives
        for (const r of every.results.slice(0, 20)) expect(evaluateCandidate(r, shape)).toEqual(r)
    })

    it('shows the Fire spells, the fixed Counterspell and the general pair of each result', () => {
        const { results } = search({ ...shape, top: 5 })
        expect(results).toHaveLength(5)
        for (const r of results) {
            expect(isValidLoadout(r.loadout)).toBe(true)
            expect(r.elementSpells).toEqual(FIRE_FOUR)
            expect(r.loadout).toEqual([...r.elementSpells, 'SPELL_COUNTERSPELL', ...r.generalSpells])
            expect(r.generalSpells).toHaveLength(2)
        }
    })

    it('ranks by dpsUnderPressure, with dps and risk alongside', () => {
        const { results } = search({ ...shape, top: Infinity, dedupe: false })
        for (let i = 1; i < results.length; i++) {
            expect(results[i - 1].dpsUnderPressure).toBeGreaterThanOrEqual(results[i].dpsUnderPressure)
            expect(compareResults(results[i - 1], results[i])).toBeLessThan(0)
        }
        for (const r of results) expect(r.risk).toBeCloseTo(r.dps - r.dpsUnderPressure, 5)
    })

    it('breaks ties by dps, then fewer rules, then fewer conditions, then the loadout and policy JSON', () => {
        const base: SearchResult = {
            loadout: LOADOUT,
            elementSpells: FIRE_FOUR,
            generalSpells: ['SPELL_HASTE', 'SPELL_BLUR'],
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
        const longer = { ...base, policy: [HOLD_METEOR, { spell: 'SPELL_FIREBALL' as SpellId }] }
        const conditioned = { ...base, policy: [{ spell: 'SPELL_FIREBALL' as SpellId, when: [] }] }
        const withCondition = {
            ...base,
            policy: [{ spell: 'SPELL_FIREBALL' as SpellId, when: [{ type: 'enemyCounterspellOnCooldown' as const }] }],
        }
        const otherLoadout = { ...base, loadout: [...LOADOUT.slice(0, 6), 'SPELL_TEMPORAL_SHIELD'] as SpellId[] }
        expect(compareResults(higherDps, base)).toBeLessThan(0)
        expect(compareResults(base, longer)).toBeLessThan(0)
        expect(compareResults(base, withCondition)).toBeLessThan(0)
        // same everything but the JSON: '{"spell":"SPELL_FIREBALL","when":[]}' sorts before '{"spell":"SPELL_FIREBALL"}'
        expect(compareResults(conditioned, base)).toBeLessThan(0)
        // ...,"SPELL_BLUR"] sorts before ...,"SPELL_TEMPORAL_SHIELD"]
        expect(compareResults(base, otherLoadout)).toBeLessThan(0)
        expect(compareResults(base, { ...base })).toBe(0)
        // dedupe folds identical behaviour into the first-ranked one, adding up equivalents
        const ranked = rankResults([withCondition, { ...longer, equivalents: 2 }, base], 10)
        expect(ranked).toEqual([{ ...base, equivalents: 4 }])
        // same totals but countered at a different moment: a different behaviour, not folded
        const laterCounter = {
            ...longer,
            interrupts: [{ spell: 'SPELL_FIREBALL' as SpellId, startSeconds: 1.3, atSeconds: 1.7 }],
        }
        expect(rankResults([laterCounter, base], 10)).toEqual([base, laterCounter])
    })

    it('validates its bounds', () => {
        expect(() => search({ ...shape, top: 0 })).toThrow(/top/)
        expect(() => search({ ...shape, shard: { index: 3, count: 3 } })).toThrow(/shard/)
        expect(() => search({ elementSpells: ['SPELL_NOPE' as SpellId] })).toThrow(/unknown spell/)
        expect(() => search({ generalSpells: ['SPELL_HASTE'] })).toThrow(/at least 2/)
    })
})
