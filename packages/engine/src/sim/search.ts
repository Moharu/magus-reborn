import { createSpellState } from '../battle'
import {
    DEFAULT_ELEMENT,
    ELEMENT_SPELL_COUNT,
    FIXED_SPELL,
    GENERAL_SPELL_COUNT,
    isValidLoadout,
    SPELL_IDS,
    SPELLBOOKS,
    SPELLS,
    type SpellElement,
} from '../catalog'
import { LOOKBACK_TIME as AFTERBURN_LOOKBACK } from '../spells/fire/afterburn'
import type { SpellId } from '../types'
import { describePolicy, isTerminalRule, type PolicyRule } from './policy'
import { simulate, type SimInterrupt, type SimPressure } from './index'

/**
 * Spells that can change the damage dealt to a passive dummy: the Fire and Frost spells and Haste. Searched policies
 * only cast these. Counterspell, Temporal Shield, Magic Eater and Blur deal no damage and the dummy never
 * casts at the caster, so casting them only costs the caster a tick; a loadout still equips them.
 */
export const DAMAGE_POOL: SpellId[] = [
    'SPELL_FIREBALL',
    'SPELL_IGNITE',
    'SPELL_COMBUSTION',
    'SPELL_AFTERBURN',
    'SPELL_LIVING_BOMB',
    'SPELL_METEOR',
    'SPELL_FROSTBOLT',
    'SPELL_GLACIER',
    'SPELL_FROST_BOMB',
    'SPELL_ICE_SPEAR',
    'SPELL_ICY_TOUCH',
    'SPELL_FROST_FEVER',
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

const FROST_FEVER = 'DEBUFF_FROST_FEVER' as const
const iceSpearAt = (count: number): PolicyRule => ({
    spell: 'SPELL_ICE_SPEAR',
    when: [{ type: 'casterChillingAtLeast', count }],
})

/**
 * The default variant menu. Kept small on purpose: the number of policies per loadout grows with
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
    SPELL_GLACIER: [
        { spell: 'SPELL_GLACIER' },
        { spell: 'SPELL_GLACIER', when: [{ type: 'enemyCounterspellOnCooldown' }] },
    ],
    SPELL_FROST_BOMB: [
        { spell: 'SPELL_FROST_BOMB' },
        { spell: 'SPELL_FROST_BOMB', when: [{ type: 'targetEffectsBelow', effect: 'DEBUFF_FROST_BOMB', count: 1 }] },
    ],
    SPELL_ICE_SPEAR: [{ spell: 'SPELL_ICE_SPEAR' }, iceSpearAt(3), iceSpearAt(5)],
    // Icy Touch is rejected by the engine without a stack, so the bare rule already waits for one
    SPELL_ICY_TOUCH: [
        { spell: 'SPELL_ICY_TOUCH' },
        { spell: 'SPELL_ICY_TOUCH', when: [{ type: 'targetEffectsAtLeast', effect: FROST_FEVER, count: 1 }] },
    ],
    SPELL_FROST_FEVER: [
        { spell: 'SPELL_FROST_FEVER' },
        { spell: 'SPELL_FROST_FEVER', when: [{ type: 'targetEffectsBelow', effect: FROST_FEVER, count: 1 }] },
    ],
}

/** Every `size`-spell subset of `pool`, each in pool order; subsets in lexicographic order of pool index. */
export const enumerateLoadouts = (pool: readonly SpellId[], size: number): SpellId[][] => {
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

export interface ShapeOptions {
    element?: SpellElement
    /** Element spells to pick the 4 from. Default: the element's whole spellbook. */
    elementSpells?: SpellId[]
    /** General spells to pick the 2 from. Default: every general spell except Counterspell. */
    generalSpells?: SpellId[]
}

/** Keeps the spellbook spells listed in `chosen` (spellbook order), checking `chosen` against the book. */
const narrow = (book: readonly SpellId[], chosen: SpellId[] | undefined, count: number, what: string) => {
    if (chosen === undefined) return [...book]
    for (const id of chosen) if (!book.includes(id)) throw new Error(`${id} is not one of the ${what} spells`)
    const out = book.filter(id => chosen.includes(id))
    if (out.length < count) throw new Error(`need at least ${count} distinct ${what} spells, got ${out.length}`)
    return out
}

/**
 * Every 0.2 loadout: `ELEMENT_SPELL_COUNT` element spells, Counterspell in its fixed slot, then
 * `GENERAL_SPELL_COUNT` general spells, each group in spellbook order. Order within a group does not
 * matter to the simulator (the policy decides what is cast), so only combinations are enumerated, and
 * Counterspell is never permuted. For each element: C(6, 4) = 15 element sets x C(4, 2) = 6 general pairs = 90.
 */
export const enumerateShapeLoadouts = ({
    element = DEFAULT_ELEMENT,
    elementSpells,
    generalSpells,
}: ShapeOptions = {}): SpellId[][] => {
    const book = Object.hasOwn(SPELLBOOKS, element) ? SPELLBOOKS[element] : undefined
    if (!book) throw new Error(`unknown element: ${String(element)}`)
    const own = narrow(book.elementSpells, elementSpells, ELEMENT_SPELL_COUNT, `${element.toLowerCase()}`)
    const general = narrow(book.generalSpells, generalSpells, GENERAL_SPELL_COUNT, 'general')
    const out: SpellId[][] = []
    for (const e of enumerateLoadouts(own, ELEMENT_SPELL_COUNT))
        for (const g of enumerateLoadouts(general, GENERAL_SPELL_COUNT)) {
            const loadout = [...e, FIXED_SPELL, ...g]
            if (!isValidLoadout(loadout, element)) throw new Error(`invalid loadout: ${JSON.stringify(loadout)}`)
            out.push(loadout)
        }
    return out
}

/** The loadout spells a searched policy may cast (see `DAMAGE_POOL`), in loadout order. */
export const policySpells = (loadout: SpellId[]) => loadout.filter(id => DAMAGE_POOL.includes(id))

/** An instant that starts the GCD when released (mirrors `createSpellState`). Icy Touch is the only one shipped. */
const startsGlobalCooldown = (id: SpellId) => createSpellState(id).globalCooldown > 0

/**
 * Whether a rule listed after a terminal rule (see `isTerminalRule`) can never fire, for policies over `spells`.
 * A terminal rule is a cast-time spell with no cooldown and no condition, so `startCast` only rejects it while
 * the battle is over, the caster is locked out (Counterspell's `lockedUntil`) or the GCD runs. The first two
 * block every spell, off-GCD ones included. The GCD lets off-GCD instants through, so it is the only way a
 * later rule could still fire, and it only runs after one of the caster's own on-GCD instants. The simulator
 * also tries rules only while not casting, so an off-GCD instant never fires mid-cast either, and the search
 * sets no `maxCasts`, which would also make the simulator skip a rule.
 * So pruning is safe unless the policy can cast both an on-GCD instant and an off-GCD one. Fire policies never
 * do, so they are always pruned; a Frost policy with Icy Touch (on-GCD) and Haste (off-GCD) is not.
 */
export const canPrune = (spells: SpellId[]) =>
    !(spells.some(startsGlobalCooldown) && spells.some(id => SPELLS[id].offGlobalCooldown))

export interface PolicyEnumerationOptions {
    /** Stop after this many policies (in enumeration order). Default: no cap. */
    cap?: number
    /** Rule variants per spell. Default `DEFAULT_RULE_VARIANTS`; `{}` gives plain priority lists. */
    variants?: RuleVariants
    /**
     * A terminal rule (see `isTerminalRule`) ends the policy: lists that go on after one are skipped,
     * because the rules after it can never fire (see `canPrune`), so each skipped list behaves exactly like
     * its prefix up to the terminal rule, which is enumerated. Only applied when `canPrune(spells)`. Default true.
     */
    prune?: boolean
}

/**
 * Every priority list over `spells` that uses each of them at most once, with one rule variant per listed
 * spell: every non-empty subset, in every order, times every combination of variants. Enumeration order is
 * depth-first: for each first spell (in `spells` order) and variant (menu order), the one-rule list, then
 * every list that starts with it.
 */
export const enumeratePolicies = (spells: SpellId[], options: PolicyEnumerationOptions = {}): PolicyRule[][] => {
    const { cap = Infinity, variants = DEFAULT_RULE_VARIANTS, prune = true } = options
    if (!(cap === Infinity || (Number.isInteger(cap) && cap >= 0)))
        throw new Error('cap must be a non-negative integer')
    if (new Set(spells).size !== spells.length) throw new Error('spells has duplicates')
    const menus = spells.map(id => variants[id] ?? [{ spell: id }])
    const pruning = prune && canPrune(spells)
    const out: PolicyRule[][] = []
    const used = spells.map(() => false)
    const build = (policy: PolicyRule[]) => {
        for (let i = 0; i < spells.length; i++) {
            if (used[i]) continue
            used[i] = true
            for (const rule of menus[i]) {
                if (out.length >= cap) break
                policy.push(rule)
                out.push([...policy])
                if (!(pruning && isTerminalRule(rule))) build(policy)
                policy.pop()
            }
            used[i] = false
        }
    }
    build([])
    return out
}

export interface SearchOptions extends ShapeOptions {
    /** How many results to return. Default 10; `Infinity` keeps all (used when merging shards). */
    top?: number
    durationSeconds?: number
    pressure?: SimPressure
    /** Cap on policies per loadout, see `enumeratePolicies`. */
    cap?: number
    variants?: RuleVariants
    /** See `enumeratePolicies`. Default true; turning it off only makes the search slower. */
    prune?: boolean
    /** Collapse equivalent results, see `rankResults`. Default true. */
    dedupe?: boolean
    /** Only evaluate candidates whose enumeration index is `index` modulo `count` (for parallel runs). */
    shard?: { index: number; count: number }
}

export interface SearchResult {
    /** The full loadout in slot order: element spells, Counterspell, general spells. */
    loadout: SpellId[]
    /** The loadout's element spells, e.g. the four Fire spells (the slots before Counterspell). */
    elementSpells: SpellId[]
    /** The loadout's general pair (the slots after Counterspell). */
    generalSpells: SpellId[]
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
    /** Other (loadout, policy) pairs with identical results that `rankResults` folded into this one. */
    equivalents?: number
}

const keys = new WeakMap<SearchResult, string>()
/** Stable, total order key used as the last tie-break. */
const keyOf = (r: SearchResult) => {
    let key = keys.get(r)
    if (key === undefined) keys.set(r, (key = JSON.stringify([r.loadout, r.policy])))
    return key
}
const conditionCount = (r: SearchResult) => r.policy.reduce((n, rule) => n + (rule.when?.length ?? 0), 0)

/**
 * Ranking: `dpsUnderPressure` desc, then `dps` desc, then fewer rules, then fewer conditions, then the
 * JSON of `[loadout, policy]` ascending (a total order, so the result never depends on enumeration order).
 */
export const compareResults = (a: SearchResult, b: SearchResult) =>
    b.dpsUnderPressure - a.dpsUnderPressure ||
    b.dps - a.dps ||
    a.policy.length - b.policy.length ||
    conditionCount(a) - conditionCount(b) ||
    (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0)

/**
 * Sorts by `compareResults` and keeps the first `top`. With `dedupe`, results that cast the same spells
 * (`cast`, `castUnderPressure`), deal the same damage in both runs and get countered at the same moments
 * (`interrupts`) are treated as one behaviour, even across loadouts and policies that only differ by
 * spells or rules that never fire: only the first in ranking order (so the fewest rules, then the fewest
 * conditions) is kept, and `equivalents` counts the ones folded into it.
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

/** One policy and every loadout whose enumeration produced it. It is simulated once, with `loadouts[0]`. */
export interface SearchCandidate {
    policy: PolicyRule[]
    loadouts: SpellId[][]
}

/**
 * Every distinct policy the search runs, in first-seen order, with the loadouts it covers: for each 0.2
 * loadout (`enumerateShapeLoadouts`), `enumeratePolicies(policySpells(loadout), { cap, variants, prune })`.
 * A policy only casts its own spells, and spells that are equipped but never cast don't change the
 * engine's result, so the same policy in two loadouts that both hold its spells gives the same result:
 * it is simulated once and the result is applied to each loadout.
 */
export const searchCandidates = ({ cap, variants, prune, ...shape }: SearchOptions = {}): SearchCandidate[] => {
    const byPolicy = new Map<string, SearchCandidate>()
    for (const loadout of enumerateShapeLoadouts(shape))
        for (const policy of enumeratePolicies(policySpells(loadout), { cap, variants, prune })) {
            const key = JSON.stringify(policy)
            const seen = byPolicy.get(key)
            if (seen) seen.loadouts.push(loadout)
            else byPolicy.set(key, { policy, loadouts: [loadout] })
        }
    return [...byPolicy.values()]
}

const fixedSlot = (loadout: SpellId[]) => loadout.indexOf(FIXED_SPELL)

/** Runs one (loadout, policy) pair through the real engine (`simulate`). */
export const evaluateCandidate = (
    { loadout, policy }: { loadout: SpellId[]; policy: PolicyRule[] },
    { durationSeconds, pressure }: Pick<SearchOptions, 'durationSeconds' | 'pressure'> = {},
): SearchResult => {
    const r = simulate({ loadout, policy, durationSeconds, pressure })
    const fixed = fixedSlot(loadout)
    return {
        loadout,
        elementSpells: fixed === -1 ? [...loadout] : loadout.slice(0, fixed),
        generalSpells: fixed === -1 ? [] : loadout.slice(fixed + 1),
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

/** `result` as if it had been simulated with `loadout`, which holds every spell its policy casts. */
const inLoadout = (result: SearchResult, loadout: SpellId[]): SearchResult => {
    const fixed = fixedSlot(loadout)
    return {
        ...result,
        loadout,
        elementSpells: loadout.slice(0, fixed),
        generalSpells: loadout.slice(fixed + 1),
        cast: loadout.filter(id => result.cast.includes(id)),
        castUnderPressure: loadout.filter(id => result.castUnderPressure.includes(id)),
    }
}

/**
 * Bounded exhaustive search over the 0.2 loadout shape: every loadout times every policy
 * (`searchCandidates`), ranked by `rankResults`. Each distinct policy is simulated once; its result counts
 * once per loadout it covers (`pairs`). With `dedupe`, those copies would all fold into the one with the
 * smallest loadout JSON, so only that one is kept, with `equivalents` counting the rest: the same output as
 * ranking every copy. Merging every shard's untruncated (`top: Infinity`) results with `rankResults` gives
 * the same output as one unsharded run: the order is total, so each group's first member is also first in
 * its shard, and `equivalents` add up.
 */
export const search = (options: SearchOptions = {}) => {
    const { top = 10, dedupe = true, shard = { index: 0, count: 1 } } = options
    if (!(top === Infinity || (Number.isInteger(top) && top >= 1)))
        throw new Error('top must be a positive integer (or Infinity)')
    if (!(Number.isInteger(shard.count) && shard.count >= 1 && Number.isInteger(shard.index)))
        throw new Error('shard.count must be a positive integer and shard.index an integer')
    if (shard.index < 0 || shard.index >= shard.count) throw new Error('shard.index must be in [0, shard.count)')
    for (const id of [...(options.elementSpells ?? []), ...(options.generalSpells ?? [])])
        if (!SPELL_IDS.includes(id)) throw new Error(`unknown spell id: ${id}`)
    const candidates = searchCandidates(options).filter((_, i) => i % shard.count === shard.index)
    const results: SearchResult[] = []
    let pairs = 0
    for (const { policy, loadouts } of candidates) {
        pairs += loadouts.length
        const result = evaluateCandidate({ loadout: loadouts[0], policy }, options)
        if (!dedupe) {
            for (const loadout of loadouts) results.push(inLoadout(result, loadout))
            continue
        }
        const json = loadouts.map(l => JSON.stringify(l))
        const first = json.indexOf([...json].sort()[0])
        results.push({
            ...inLoadout(result, loadouts[first]),
            ...(loadouts.length > 1 ? { equivalents: loadouts.length - 1 } : {}),
        })
    }
    return { evaluated: candidates.length, pairs, results: rankResults(results, top, dedupe) }
}
