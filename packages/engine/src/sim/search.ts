import { SPELL_IDS, SPELLS } from '../catalog'
import { LOOKBACK_TIME as AFTERBURN_LOOKBACK } from '../spells/fire/afterburn'
import type { SpellId } from '../types'
import { describePolicy, isTerminalRule, type PolicyRule } from './policy'
import { simulate, type SimInterrupt, type SimPressure } from './index'

/**
 * Spells that can change the damage dealt to a passive dummy. Counterspell, Temporal Shield, Magic Eater
 * and Blur deal no damage and the dummy never casts at the caster, so casting them only wastes time;
 * a real 6-slot loadout fills its spare slots with them.
 */
export const DAMAGE_POOL: SpellId[] = [
    'SPELL_FIREBALL',
    'SPELL_IGNITE',
    'SPELL_COMBUSTION',
    'SPELL_AFTERBURN',
    'SPELL_LIVING_BOMB',
    'SPELL_METEOR',
    'SPELL_HASTE',
]

/** Rule variants the search tries for each spell, in order. Spells not listed only get the bare rule. */
export type RuleVariants = Partial<Record<SpellId, PolicyRule[]>>

const IGNITES = 'DEBUFF_IGNITE' as const
const igniteBelow = (count: number): PolicyRule => ({
    spell: 'SPELL_IGNITE',
    when: [{ type: 'targetEffectsBelow', effect: IGNITES, count }],
})
const combustionAt = (count: number): PolicyRule => ({
    spell: 'SPELL_COMBUSTION',
    when: [{ type: 'targetEffectsAtLeast', effect: IGNITES, count }],
})
const afterburnAfter = (count: number): PolicyRule => ({
    spell: 'SPELL_AFTERBURN',
    when: [{ type: 'recentReleasesAtLeast', spell: 'SPELL_FIREBALL', count, seconds: AFTERBURN_LOOKBACK }],
})

/**
 * The default variant menu. Kept small on purpose: the number of policies per loadout is
 * (orderings) x (product of menu sizes), so each extra variant multiplies the search.
 */
export const DEFAULT_RULE_VARIANTS: RuleVariants = {
    SPELL_IGNITE: [{ spell: 'SPELL_IGNITE' }, igniteBelow(3), igniteBelow(6)],
    SPELL_COMBUSTION: [{ spell: 'SPELL_COMBUSTION' }, combustionAt(3), combustionAt(6)],
    SPELL_AFTERBURN: [{ spell: 'SPELL_AFTERBURN' }, afterburnAfter(4), afterburnAfter(6)],
    SPELL_LIVING_BOMB: [
        { spell: 'SPELL_LIVING_BOMB' },
        { spell: 'SPELL_LIVING_BOMB', when: [{ type: 'targetEffectsBelow', effect: 'DEBUFF_LIVING_BOMB', count: 1 }] },
    ],
    SPELL_METEOR: [
        { spell: 'SPELL_METEOR' },
        { spell: 'SPELL_METEOR', when: [{ type: 'enemyCounterspellOnCooldown' }] },
    ],
}

/** Every `size`-spell subset of `pool`, each in pool order; subsets in lexicographic order of pool index. */
export const enumerateLoadouts = (pool: SpellId[], size: number): SpellId[][] => {
    if (!(Number.isInteger(size) && size >= 0)) throw new Error('size must be a non-negative integer')
    if (new Set(pool).size !== pool.length) throw new Error('pool has duplicate spells')
    const out: SpellId[][] = []
    const pick = (from: number, chosen: SpellId[]) => {
        if (chosen.length === size) return void out.push([...chosen])
        for (let i = from; i <= pool.length - (size - chosen.length); i++) pick(i + 1, [...chosen, pool[i]])
    }
    pick(0, [])
    return out
}

export interface PolicyEnumerationOptions {
    /** Stop after this many policies (in enumeration order). Default: no cap. */
    cap?: number
    /** Rule variants per spell. Default `DEFAULT_RULE_VARIANTS`; `{}` gives plain priority permutations. */
    variants?: RuleVariants
    /**
     * Skip policies with a terminal rule (see `isTerminalRule`) before the last position: the rules after it
     * could never fire, so the policy behaves like a shorter one. Not applied when the loadout has an
     * off-GCD spell, which can still fire after a terminal rule. Default true.
     */
    prune?: boolean
}

/**
 * Every policy that uses each loadout spell exactly once: each priority order (permutations, in
 * lexicographic order of loadout index) times each combination of rule variants (menu order).
 */
export const enumeratePolicies = (loadout: SpellId[], options: PolicyEnumerationOptions = {}): PolicyRule[][] => {
    const { cap = Infinity, variants = DEFAULT_RULE_VARIANTS, prune = true } = options
    if (!(cap === Infinity || (Number.isInteger(cap) && cap >= 0)))
        throw new Error('cap must be a non-negative integer')
    const menus = loadout.map(id => variants[id] ?? [{ spell: id }])
    // an off-GCD spell (Counterspell, Blur) can still fire during the GCD, after a terminal rule
    const pruning = prune && loadout.every(id => !SPELLS[id].offGlobalCooldown)
    const out: PolicyRule[][] = []
    const used = loadout.map(() => false)
    const build = (policy: PolicyRule[]) => {
        if (out.length >= cap) return
        if (policy.length === loadout.length) return void out.push([...policy])
        const last = policy.length === loadout.length - 1
        for (let i = 0; i < loadout.length; i++) {
            if (used[i]) continue
            used[i] = true
            for (const rule of menus[i]) {
                if (pruning && !last && isTerminalRule(rule)) continue
                policy.push(rule)
                build(policy)
                policy.pop()
            }
            used[i] = false
        }
    }
    build([])
    return out
}

export interface SearchOptions {
    /** Largest loadout searched; every size from 1 to `size` is included. */
    size: number
    pool?: SpellId[]
    /** How many results to return. Default 10; `Infinity` keeps all (used when merging shards). */
    top?: number
    durationSeconds?: number
    pressure?: SimPressure
    /** Cap on policies per loadout, see `enumeratePolicies`. */
    cap?: number
    variants?: RuleVariants
    /** Collapse equivalent results, see `rankResults`. Default true. */
    dedupe?: boolean
    /** Only evaluate candidates whose enumeration index is `index` modulo `count` (for parallel runs). */
    shard?: { index: number; count: number }
}

export interface SearchResult {
    /** The spells the policy casts, in pool order. */
    loadout: SpellId[]
    policy: PolicyRule[]
    description: string
    dps: number
    dpsUnderPressure: number
    risk: number
    totalDamage: number
    pressuredDamage: number
    /** Spells released at least once in the unpressured run, in loadout order. */
    cast: SpellId[]
    /** Spells released at least once in the pressured run, in loadout order. */
    castUnderPressure: SpellId[]
    /** The Counterspells the pressure model landed, see `SimResult.pressure.interrupts`. */
    interrupts: SimInterrupt[]
    /** Other policies with identical results that `rankResults` folded into this one. */
    equivalents?: number
}

/** Stable, total order key used as the last tie-break. */
const keyOf = (r: SearchResult) => JSON.stringify([r.loadout, r.policy])
const conditionCount = (r: SearchResult) => r.policy.reduce((n, rule) => n + (rule.when?.length ?? 0), 0)

/**
 * Ranking: `dpsUnderPressure` desc, then `dps` desc, then fewer spells, then fewer conditions, then the
 * JSON of `[loadout, policy]` ascending (a total order, so the result never depends on enumeration order).
 */
export const compareResults = (a: SearchResult, b: SearchResult) =>
    b.dpsUnderPressure - a.dpsUnderPressure ||
    b.dps - a.dps ||
    a.loadout.length - b.loadout.length ||
    conditionCount(a) - conditionCount(b) ||
    (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0)

/**
 * Sorts by `compareResults` and keeps the first `top`. With `dedupe`, results that cast the same spells
 * (`cast`, `castUnderPressure`), deal the same damage in both runs and get countered at the same moments
 * (`interrupts`) are treated as one behaviour, even across loadouts that
 * only differ by spells the policy never reaches: only the first in ranking order (so the smallest
 * loadout, then the fewest conditions) is kept, and `equivalents` counts the ones folded into it.
 */
export const rankResults = (results: SearchResult[], top: number, dedupe = true): SearchResult[] => {
    const sorted = [...results].sort(compareResults)
    if (!dedupe) return sorted.slice(0, top)
    const groups = new Map<string, SearchResult>()
    const out: SearchResult[] = []
    for (const r of sorted) {
        const key = JSON.stringify([r.cast, r.castUnderPressure, r.totalDamage, r.pressuredDamage, r.interrupts])
        const first = groups.get(key)
        if (first) {
            first.equivalents = (first.equivalents ?? 0) + 1 + (r.equivalents ?? 0)
            continue
        }
        const copy = { ...r }
        groups.set(key, copy)
        out.push(copy)
    }
    return out.slice(0, top)
}

/** Every (loadout, policy) pair the search will run, in enumeration order. */
export const searchCandidates = ({ size, pool = DAMAGE_POOL, cap, variants }: SearchOptions) => {
    for (const id of pool) if (!SPELL_IDS.includes(id)) throw new Error(`unknown spell id: ${id}`)
    if (!(Number.isInteger(size) && size >= 1 && size <= pool.length))
        throw new Error(`size must be an integer from 1 to ${pool.length} (the pool size)`)
    const out: { loadout: SpellId[]; policy: PolicyRule[] }[] = []
    for (let k = 1; k <= size; k++)
        for (const loadout of enumerateLoadouts(pool, k))
            for (const policy of enumeratePolicies(loadout, { cap, variants })) out.push({ loadout, policy })
    return out
}

/** Runs one candidate through the real engine (`simulate`). */
export const evaluateCandidate = (
    { loadout, policy }: { loadout: SpellId[]; policy: PolicyRule[] },
    { durationSeconds, pressure }: Pick<SearchOptions, 'durationSeconds' | 'pressure'> = {},
): SearchResult => {
    const r = simulate({ loadout, policy, durationSeconds, pressure })
    return {
        loadout,
        policy,
        description: describePolicy(policy),
        dps: r.dps,
        dpsUnderPressure: r.dpsUnderPressure,
        risk: r.risk,
        totalDamage: r.totalDamage,
        pressuredDamage: r.pressure.totalDamage,
        cast: loadout.filter(id => (r.perSpell[id]?.casts ?? 0) > 0),
        castUnderPressure: loadout.filter(id => (r.pressure.perSpell[id]?.casts ?? 0) > 0),
        interrupts: r.pressure.interrupts,
    }
}

/**
 * Bounded exhaustive search: every loadout of 1..`size` pool spells times every policy, each run through
 * `simulate`, ranked by `rankResults`. Merging every shard's untruncated (`top: Infinity`) results with
 * `rankResults` gives the same output as one unsharded run: the order is total, so each group's first member
 * is also first in its shard, and `equivalents` add up.
 */
export const search = (options: SearchOptions) => {
    const { top = 10, dedupe = true, shard = { index: 0, count: 1 } } = options
    if (!(top === Infinity || (Number.isInteger(top) && top >= 1)))
        throw new Error('top must be a positive integer (or Infinity)')
    if (!(Number.isInteger(shard.count) && shard.count >= 1 && Number.isInteger(shard.index)))
        throw new Error('shard.count must be a positive integer and shard.index an integer')
    if (shard.index < 0 || shard.index >= shard.count) throw new Error('shard.index must be in [0, shard.count)')
    const candidates = searchCandidates(options).filter((_, i) => i % shard.count === shard.index)
    const results = candidates.map(c => evaluateCandidate(c, options))
    return { evaluated: candidates.length, results: rankResults(results, top, dedupe) }
}
