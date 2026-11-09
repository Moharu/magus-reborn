import {
    DEFAULT_ELEMENT,
    ELEMENT_SPELL_COUNT,
    FIXED_SPELL,
    isSpellId,
    loadoutElement,
    type SpellElement,
    type SpellId,
} from '@magus/engine'
import { adaptProfile } from './adapt'
import { baselineElement, type Baseline } from './baseline'
import type { GeneralSpell, Profile } from './profile'
import { profileEntrant } from './profile-controller'
import { deriveSeed, isSeed } from './prng'
import { DEFAULT_MAX_TICKS, runMatch } from './runner'
import { wilsonInterval } from './stats'
import { shardPairs, type MatchFn } from './tournament'
import type { Entrant } from './types'

/**
 * The strategy tournament (#137). The round-robin of #103 changes the loadout and the profile together, so a win rate
 * mixes loadout strength with strategy. Here every game is a mirror: both players get the same fixed loadout, and the
 * only thing that varies is the profile (the strategy model).
 *
 * Setups are one Fire set (by default the best set of the dummy-DPS baseline, or the `--fire-set` ones, which may
 * also be Frost sets, #150: every game is a mirror, so each setup plays one element) combined with
 * each of the 6 pairs of the four non-Counterspell general spells, Counterspell always included. On every setup each
 * profile plays every profile, itself included (`matchupList`): `seeds` derived seeds, `games` games each, sides
 * alternating game by game, so each profile moves first (is `player1`) in half the games.
 *
 * The unit of work is a job, one (setup, matchup, derived seed). Everything is a pure function of the options: the
 * derived seed is `deriveSeed(seed, setup, matchup, k)` and game `g` of it is seeded `deriveSeed(derived, g)`. A shard
 * plays the jobs whose index is its index modulo its count; `mergeStrategyShards` of all shards equals the unsharded
 * `runStrategy`. The games run on the real engine through `runMatch`.
 */

export const STRATEGY_FORMAT = 'arena-strategy'
export const STRATEGY_SHARD_FORMAT = 'arena-strategy-shard'

/**
 * Derived seeds per cell and games per derived seed (even). 30 x 36 = 1080 games per cell: the widest 95% Wilson
 * interval of a cell (at 50%) is then +/- 3.0%.
 */
export const DEFAULT_STRATEGY_SEEDS = 30
export const DEFAULT_STRATEGY_GAMES = 36

/** The six pairs of the four non-Counterspell general spells, in the order the report lists them (Haste first). */
export const STRATEGY_GENERAL_PAIRS: readonly (readonly [GeneralSpell, GeneralSpell])[] = [
    ['SPELL_HASTE', 'SPELL_BLUR'],
    ['SPELL_HASTE', 'SPELL_MAGIC_EATER'],
    ['SPELL_HASTE', 'SPELL_TEMPORAL_SHIELD'],
    ['SPELL_BLUR', 'SPELL_MAGIC_EATER'],
    ['SPELL_BLUR', 'SPELL_TEMPORAL_SHIELD'],
    ['SPELL_MAGIC_EATER', 'SPELL_TEMPORAL_SHIELD'],
]

/** `SPELL_MAGIC_EATER` as `magic-eater`. */
const shortName = (id: string) =>
    id
        .replace(/^SPELL_/, '')
        .toLowerCase()
        .replaceAll('_', '-')
/** A general pair as `haste+blur`. */
export const pairName = (pair: readonly SpellId[]) => pair.map(shortName).join('+')

/** The element of a set of four element spells (with Counterspell and a general pair, as a loadout), or null. */
const setElement = (spells: readonly SpellId[]) =>
    loadoutElement([...spells, FIXED_SPELL, ...STRATEGY_GENERAL_PAIRS[0]])

/**
 * A `--fire-set` (or `--set`) value: four distinct spells of one element separated by commas, Fire or Frost (#150), as
 * spell ids (`SPELL_FIREBALL`) or short names (`fireball`, `living-bomb`, `ice-spear`), in any case. Throws when a name
 * is unknown or the four are not a valid set of one element.
 */
export const parseFireSet = (raw: string): SpellId[] => {
    const spells = raw
        .split(',')
        .map(part => part.trim())
        .filter(Boolean)
        .map(part => {
            const id = part.toUpperCase().replace(/[\s-]+/g, '_')
            const spell = isSpellId(id) ? id : `SPELL_${id}`
            if (!isSpellId(spell)) throw new Error(`--fire-set: unknown spell ${JSON.stringify(part)}`)
            return spell
        })
    if (spells.length !== ELEMENT_SPELL_COUNT)
        throw new Error(`--fire-set needs ${ELEMENT_SPELL_COUNT} Fire spells separated by commas, got ${spells.length}`)
    // the same check the engine applies to a loadout, with the first valid general pair filling the other slots
    if (setElement(spells) === null)
        throw new Error(`--fire-set: ${spells.join(', ')} are not four distinct Fire spells (nor four Frost spells)`)
    return spells
}

/** `parseFireSet` under its element-neutral name (#150): a Fire or a Frost set. */
export const parseElementSet = parseFireSet

/** A set's label: `F<n>` for a Fire set, `I<n>` (Ice) for a Frost one (#150), `n` its position from 1. */
export const setLabel = (set: { element?: SpellElement }, index: number) =>
    `${(set.element ?? DEFAULT_ELEMENT) === DEFAULT_ELEMENT ? 'F' : 'I'}${index + 1}`

/** The sorted spell ids of a Fire set: the identity of a set, whatever the slot order. */
const fireKey = (spells: readonly SpellId[]) => [...spells].sort().join()

export interface StrategyOptions {
    readonly baseline: Baseline
    /** The Frost table (#150): where a Frost set's dummy baseline comes from. */
    readonly frostBaseline?: Baseline
    /**
     * The sets (4 spells of one element each, Fire or Frost, #150) to play. Default: the best set of the baseline, i.e.
     * that of its rank 1.
     */
    readonly fireSets?: readonly (readonly SpellId[])[]
    /** The profiles, by distinct `name`. At least 2. */
    readonly profiles: readonly Profile[]
    /** Derived seeds per cell (default `DEFAULT_STRATEGY_SEEDS`). */
    readonly seeds?: number
    /** Games per derived seed: even, so each profile is `player1` in exactly half (default `DEFAULT_STRATEGY_GAMES`). */
    readonly games?: number
    /** Master seed, an integer in [0, 2^32). */
    readonly seed?: number
    readonly maxTicks?: number
}

export interface StrategyFireSet {
    readonly spells: readonly SpellId[]
    /** `baseline`: the default, the best set of the baseline; `override`: given with `--fire-set`. */
    readonly source: 'baseline' | 'override'
    /** `FROST` for a Frost set (#150); absent for Fire. */
    readonly element?: SpellElement
    /** The best loadout of the baseline with this Fire set, when the baseline has one. */
    readonly baseline?: { readonly rank: number; readonly dps: number; readonly dpsUnderPressure: number }
}

/** One mirror setup: both players play `loadout`. */
export interface StrategySetup {
    /** `F<set, from 1>/<pair>` for a Fire set, `I<set>/<pair>` for a Frost one (#150): `F1/haste+blur`, `I2/haste+blur`. */
    readonly id: string
    /** Index into `config.fireSets`. */
    readonly fireSet: number
    readonly pair: readonly [GeneralSpell, GeneralSpell]
    /** The 7 slots: the Fire set, Counterspell, the pair. */
    readonly loadout: readonly SpellId[]
}

/** Everything that decides the result. Shards must agree on it to be merged. */
export interface StrategyConfig {
    readonly baselineVersion: string
    readonly fireSets: readonly StrategyFireSet[]
    readonly seeds: number
    /** Games per derived seed. */
    readonly games: number
    readonly seed: number
    readonly maxTicks: number
    readonly profiles: readonly Profile[]
    /** Fire set 0 with the 6 pairs, then fire set 1, ... */
    readonly setups: readonly StrategySetup[]
}

/** The profile pairs `[a, b]` with `a <= b` (indexes into the profiles): each profile against every profile, itself included. */
export const matchupList = (profiles: number): [number, number][] => {
    const pairs: [number, number][] = []
    for (let a = 0; a < profiles; a++) for (let b = a; b < profiles; b++) pairs.push([a, b])
    return pairs
}

/** Jobs: setup-major, then matchup, then derived seed. */
export const jobCount = (config: StrategyConfig) =>
    config.setups.length * matchupList(config.profiles.length).length * config.seeds

/** Where job `job` sits: its setup, its matchup (`a <= b`, profile indexes) and its derived seed's index. */
export const jobAt = (config: StrategyConfig, job: number) => {
    const matchups = matchupList(config.profiles.length)
    const seed = job % config.seeds
    const matchup = Math.floor(job / config.seeds) % matchups.length
    const setup = Math.floor(job / config.seeds / matchups.length)
    if (!(Number.isInteger(job) && job >= 0 && setup < config.setups.length)) throw new Error(`no job ${job}`)
    const [a, b] = matchups[matchup]
    return { job, setup, matchup, a, b, seed }
}

/** The derived seed `k` of a cell, from the master seed. Game `g` of it is seeded `deriveSeed(derived, g)`. */
export const derivedSeed = (config: StrategyConfig, setup: number, matchup: number, k: number) =>
    deriveSeed(config.seed, setup, matchup, k)

/** The outcome of one job's games. `winsA` counts wins of the matchup's profile `a`, `winsB` those of `b`. */
export interface StrategyJobResult {
    readonly job: number
    readonly games: number
    readonly winsA: number
    readonly winsB: number
    readonly draws: number
    /** Games won by whoever was `player1`: the first-mover edge. In a mirror matchup (`a === b`) the only figure that says anything. */
    readonly firstWins: number
}

export interface StrategyPlan {
    readonly config: StrategyConfig
    /** `make[setup][profile]` builds a fresh controller for that profile on that setup's loadout. */
    readonly make: readonly (readonly (() => Entrant)[])[]
}

export interface StrategyShardResult {
    readonly format: typeof STRATEGY_SHARD_FORMAT
    readonly config: StrategyConfig
    readonly shard: { readonly index: number; readonly count: number }
    /** Present (`true`) only when the time budget stopped the shard before it played all its jobs. */
    readonly partial?: true
    readonly jobs: readonly StrategyJobResult[]
}

/** Counts of one (setup, matchup) cell, over all its derived seeds: the raw numbers every rate comes from. */
export interface StrategyCell {
    /** Setup id. */
    readonly setup: string
    /** Profile names; `a` is `player1` in the even games of every job. `a === b` is the mirror of a profile. */
    readonly a: string
    readonly b: string
    readonly games: number
    readonly winsA: number
    readonly winsB: number
    readonly draws: number
    readonly firstWins: number
}

export interface RankedProfile {
    readonly rank: number
    readonly profile: string
    readonly wins: number
    readonly draws: number
    readonly losses: number
    readonly games: number
    readonly winRate: number
    /** 95% Wilson interval on the win rate. */
    readonly ci95: { readonly low: number; readonly high: number }
}

export interface PairSummary {
    /** `haste+blur`. */
    readonly pair: string
    readonly spells: readonly [GeneralSpell, GeneralSpell]
    /** Every profile pooled over the Fire sets, best first. */
    readonly ranking: readonly RankedProfile[]
    /** The best profile, and whether its interval lies clear of the runner-up's (false when the intervals overlap). */
    readonly best: string
    readonly separated: boolean
}

export interface StrategyPartial {
    readonly jobsPlayed: number
    readonly jobsTotal: number
    /** Merged with `allowMissing`: the shards that were not given, as `i/n`. */
    readonly missingShards?: readonly string[]
}

export interface StrategyResult {
    readonly format: typeof STRATEGY_FORMAT
    readonly config: StrategyConfig
    /** The raw counts: every (setup, matchup) cell, in job order. */
    readonly cells: readonly StrategyCell[]
    /** Per setup, the profiles ranked by win rate against the other profiles (mirror games do not count). */
    readonly rankings: readonly { readonly setup: string; readonly ranking: readonly RankedProfile[] }[]
    /** Per general pair, pooled over the Fire sets. */
    readonly pairs: readonly PairSummary[]
    readonly games: number
    readonly partial?: StrategyPartial
}

const isPositive = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1

/**
 * Validates the options and builds the setups (each Fire set with the 6 general pairs) and the controllers of every
 * profile on every setup.
 */
export const planStrategy = (options: StrategyOptions): StrategyPlan => {
    const { baseline, profiles, seeds = DEFAULT_STRATEGY_SEEDS, games = DEFAULT_STRATEGY_GAMES } = options
    const seed = options.seed ?? 1
    const maxTicks = options.maxTicks ?? DEFAULT_MAX_TICKS
    if (!isPositive(seeds)) throw new Error(`seeds must be a positive integer, got ${seeds}`)
    if (!(isPositive(games) && games >= 2 && games % 2 === 0))
        throw new Error(`games must be an even integer of at least 2 (so sides swap equally), got ${games}`)
    if (!isSeed(seed)) throw new Error(`seed must be an integer in [0, 2^32), got ${seed}`)
    if (!isPositive(maxTicks)) throw new Error(`maxTicks must be a positive integer`)
    if (profiles.length < 2) throw new Error('at least two profiles are needed')
    const names = new Set<string>()
    for (const { name } of profiles) {
        if (names.has(name)) throw new Error(`profile ${JSON.stringify(name)} is listed twice`)
        names.add(name)
    }

    const given = options.fireSets
    if (given !== undefined && given.length === 0) throw new Error('at least one Fire set is needed')
    const sets = (given ?? [baseline.loadouts[0].loadout.slice(0, ELEMENT_SPELL_COUNT)]).map(set => [...set])
    const keys = new Set<string>()
    for (const set of sets) {
        if (setElement(set) === null)
            throw new Error(
                `${set.join(', ')} is not a valid Fire set (four distinct Fire spells) nor a valid Frost set`,
            )
        if (keys.has(fireKey(set))) throw new Error(`Fire set ${set.join(', ')} is listed twice`)
        keys.add(fireKey(set))
    }
    const tables = [baseline, ...(options.frostBaseline ? [options.frostBaseline] : [])]
    const fireSets = sets.map((spells): StrategyFireSet => {
        const element = setElement(spells)!
        // the set's own element's table: a Frost set is looked up in the Frost table (#150)
        const table = tables.find(t => baselineElement(t) === element)
        const best = table?.loadouts.find(l => fireKey(l.loadout.slice(0, ELEMENT_SPELL_COUNT)) === fireKey(spells))
        return {
            spells,
            source: given === undefined ? 'baseline' : 'override',
            ...(element === DEFAULT_ELEMENT ? {} : { element }),
            ...(best ? { baseline: { rank: best.rank, dps: best.dps, dpsUnderPressure: best.dpsUnderPressure } } : {}),
        }
    })

    const setups: StrategySetup[] = []
    const make: (() => Entrant)[][] = []
    fireSets.forEach((set, fireSet) => {
        const { spells } = set
        for (const pair of STRATEGY_GENERAL_PAIRS) {
            const loadout = [...spells, FIXED_SPELL, ...pair]
            if (loadoutElement(loadout) === null)
                throw new Error(`invalid loadout for ${spells.join(', ')} with ${pairName(pair)}`)
            setups.push({ id: `${setLabel(set, fireSet)}/${pairName(pair)}`, fireSet, pair, loadout })
            make.push(
                profiles.map(profile => {
                    const adapted = adaptProfile(profile, loadout)
                    return () => profileEntrant(adapted, loadout)
                }),
            )
        }
    })
    return {
        config: {
            baselineVersion: baseline.version,
            fireSets,
            seeds,
            games,
            seed,
            maxTicks,
            profiles,
            setups,
        },
        make,
    }
}

/** Plays one job: `games` mirror games of its matchup on its setup. Profile `a` is `player1` on even games. */
const playJob = (plan: StrategyPlan, job: number, run: MatchFn): StrategyJobResult => {
    const { config } = plan
    const { setup, matchup, a, b, seed } = jobAt(config, job)
    const derived = derivedSeed(config, setup, matchup, seed)
    let winsA = 0
    let winsB = 0
    let draws = 0
    let firstWins = 0
    for (let game = 0; game < config.games; game++) {
        const aFirst = game % 2 === 0
        const result = run({
            seed: deriveSeed(derived, game),
            a: plan.make[setup][aFirst ? a : b](),
            b: plan.make[setup][aFirst ? b : a](),
            maxTicks: config.maxTicks,
            log: false,
        })
        if (result.winner === 'draw') draws++
        else {
            if (result.winner === 'a') firstWins++
            if ((result.winner === 'a') === aFirst) winsA++
            else winsB++
        }
    }
    return { job, games: config.games, winsA, winsB, draws, firstWins }
}

/**
 * Plays the given job indexes in order. `stop`, checked before each job, ends the run early (the time budget): the jobs
 * played so far are returned. A job is never interrupted halfway. `run` is only for tests.
 */
export const playJobs = (
    plan: StrategyPlan,
    jobs: readonly number[],
    run: MatchFn = runMatch,
    stop?: () => boolean,
): StrategyJobResult[] => {
    const played: StrategyJobResult[] = []
    for (const job of jobs) {
        if (stop?.()) break
        jobAt(plan.config, job) // rejects an index outside the plan
        played.push(playJob(plan, job, run))
    }
    return played
}

/** Plays one shard: the jobs with `job % count === index`. With `stop`, a shard stopped early is `partial`. */
export const runStrategyShard = (
    plan: StrategyPlan,
    index: number,
    count: number,
    run: MatchFn = runMatch,
    stop?: () => boolean,
): StrategyShardResult => {
    const mine = shardPairs(jobCount(plan.config), index, count)
    const jobs = playJobs(plan, mine, run, stop)
    return {
        format: STRATEGY_SHARD_FORMAT,
        config: plan.config,
        shard: { index, count },
        ...(jobs.length < mine.length ? { partial: true as const } : {}),
        jobs,
    }
}

const compareRates = (x: PooledProfile, y: PooledProfile) =>
    // entrants with no games rank last; the rest by wins/games, compared by cross-multiplication so no float rounding
    // decides a tie; then by name
    Number(x.games === 0) - Number(y.games === 0) ||
    y.wins * x.games - x.wins * y.games ||
    (x.profile < y.profile ? -1 : x.profile > y.profile ? 1 : 0)

interface PooledProfile {
    profile: string
    wins: number
    draws: number
    games: number
}

const rank = (pooled: readonly PooledProfile[]): RankedProfile[] =>
    pooled
        .map(p => ({
            ...p,
            losses: p.games - p.wins - p.draws,
            winRate: p.games === 0 ? 0 : p.wins / p.games,
            ci95: wilsonInterval(p.wins, p.games),
        }))
        .sort(compareRates)
        .map((p, i) => ({ rank: i + 1, ...p }))

/**
 * Scores a set of job results into the cells' raw counts, the per-setup rankings and the per-pair summary. Every job
 * must be present, unless `allowPartial` is set (a run stopped by its time budget): the result then covers the jobs
 * given and says so in `partial`.
 */
export const summarizeStrategy = (
    config: StrategyConfig,
    jobs: readonly StrategyJobResult[],
    allowPartial = false,
    missingShards?: readonly string[],
): StrategyResult => {
    const total = jobCount(config)
    const byJob = new Map<number, StrategyJobResult>()
    for (const result of jobs) {
        if (!Number.isInteger(result.job) || result.job < 0 || result.job >= total)
            throw new Error(`job ${result.job} is not one of the ${total} jobs`)
        if (byJob.has(result.job)) throw new Error(`job ${result.job} appears twice`)
        const counts = [result.winsA, result.winsB, result.draws, result.firstWins]
        if (
            result.games !== config.games ||
            !counts.every(n => Number.isInteger(n) && n >= 0) ||
            result.winsA + result.winsB + result.draws !== result.games ||
            result.firstWins > result.winsA + result.winsB
        )
            throw new Error(`job ${result.job} has inconsistent counts`)
        byJob.set(result.job, result)
    }
    if (byJob.size < total && !allowPartial) {
        const missing = Array.from({ length: total }, (_, i) => i).find(i => !byJob.has(i))
        throw new Error(`job ${missing} of ${total} is missing`)
    }

    const matchups = matchupList(config.profiles.length)
    const names = config.profiles.map(p => p.name)
    const cells: StrategyCell[] = []
    config.setups.forEach((setup, s) => {
        matchups.forEach(([a, b], m) => {
            const cell = {
                setup: setup.id,
                a: names[a],
                b: names[b],
                games: 0,
                winsA: 0,
                winsB: 0,
                draws: 0,
                firstWins: 0,
            }
            for (let k = 0; k < config.seeds; k++) {
                const result = byJob.get((s * matchups.length + m) * config.seeds + k)
                if (!result) continue
                cell.games += result.games
                cell.winsA += result.winsA
                cell.winsB += result.winsB
                cell.draws += result.draws
                cell.firstWins += result.firstWins
            }
            cells.push(cell)
        })
    })
    return finish(config, cells, byJob.size, total, missingShards)
}

/** The rankings and pair summaries of a set of cells (also what a test builds a result from). */
const finish = (
    config: StrategyConfig,
    cells: readonly StrategyCell[],
    jobsPlayed: number,
    jobsTotal: number,
    missingShards?: readonly string[],
): StrategyResult => {
    const pooled = (filter: (cell: StrategyCell) => boolean): PooledProfile[] =>
        config.profiles.map(({ name }) => {
            const p: PooledProfile = { profile: name, wins: 0, draws: 0, games: 0 }
            for (const cell of cells) {
                // mirror games say nothing about which profile is better: a profile's games are those against the others
                if (cell.a === cell.b || !filter(cell)) continue
                if (cell.a !== name && cell.b !== name) continue
                p.wins += cell.a === name ? cell.winsA : cell.winsB
                p.draws += cell.draws
                p.games += cell.games
            }
            return p
        })
    const rankings = config.setups.map(setup => ({
        setup: setup.id,
        ranking: rank(pooled(cell => cell.setup === setup.id)),
    }))
    const pairs = STRATEGY_GENERAL_PAIRS.map((pair): PairSummary => {
        const ids = new Set(config.setups.filter(s => pairName(s.pair) === pairName(pair)).map(s => s.id))
        const ranking = rank(pooled(cell => ids.has(cell.setup)))
        const [first, second] = ranking
        return {
            pair: pairName(pair),
            spells: pair,
            ranking,
            best: first.profile,
            separated: first.games > 0 && second.games > 0 && first.ci95.low > second.ci95.high,
        }
    })
    return {
        format: STRATEGY_FORMAT,
        config,
        cells,
        rankings,
        pairs,
        games: cells.reduce((sum, c) => sum + c.games, 0),
        ...(jobsPlayed === jobsTotal
            ? {}
            : { partial: { jobsPlayed, jobsTotal, ...(missingShards ? { missingShards } : {}) } }),
    }
}

/** The whole strategy tournament, unsharded. With `stop` (the time budget) it may end early and returns a partial result. */
export const runStrategy = (plan: StrategyPlan, run: MatchFn = runMatch, stop?: () => boolean): StrategyResult =>
    summarizeStrategy(
        plan.config,
        playJobs(plan, shardPairs(jobCount(plan.config), 0, 1), run, stop),
        stop !== undefined,
    )

/**
 * Combines the shards of one strategy tournament into its result, the same one `runStrategy` gives. They must share a
 * config and a count and cover every index once, in any order. With `allowMissing`, shards that were not given (a job
 * that failed) are named in `partial.missingShards` and the result is partial.
 */
export const mergeStrategyShards = (
    shards: readonly StrategyShardResult[],
    { allowMissing = false }: { allowMissing?: boolean } = {},
): StrategyResult => {
    if (shards.length === 0) throw new Error('no shards to merge')
    for (const shard of shards)
        if (shard?.format !== STRATEGY_SHARD_FORMAT)
            throw new Error(`not a strategy tournament shard (format ${shard?.format})`)
    const [first] = shards
    const config = JSON.stringify(first.config)
    const { count } = first.shard
    const total = jobCount(first.config)
    const seen = new Set<number>()
    for (const shard of shards) {
        if (JSON.stringify(shard.config) !== config) throw new Error('shards come from different tournaments')
        if (shard.shard.count !== count)
            throw new Error(`shards disagree on the shard count (${count} and ${shard.shard.count})`)
        if (seen.has(shard.shard.index)) throw new Error(`shard ${shard.shard.index}/${count} is given twice`)
        seen.add(shard.shard.index)
        const expected = shardPairs(total, shard.shard.index, count)
        const own = shard.jobs.every(j => j.job % count === shard.shard.index)
        if (
            shard.partial === true
                ? shard.jobs.length > expected.length || !own
                : shard.jobs.length !== expected.length || !own
        )
            throw new Error(`shard ${shard.shard.index}/${count} does not hold exactly its jobs`)
    }
    const absent = Array.from({ length: count }, (_, i) => i).filter(i => !seen.has(i))
    if (absent.length > 0 && !allowMissing)
        throw new Error(`missing shard(s) ${absent.map(i => `${i}/${count}`).join(', ')}`)
    return summarizeStrategy(
        first.config,
        shards.flatMap(shard => shard.jobs),
        absent.length > 0 || shards.some(shard => shard.partial === true),
        absent.length > 0 ? absent.map(i => `${i}/${count}`) : undefined,
    )
}
