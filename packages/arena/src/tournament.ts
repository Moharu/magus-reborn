import { ELEMENT_SPELL_COUNT, SPELLS, type SpellId } from '@magus/engine'
import type { Baseline, BaselineLoadout } from './baseline'
import { profileEntrant } from './profile-controller'
import { checkLoadout, type Profile } from './profile'
import { deriveSeed, isSeed } from './prng'
import { DEFAULT_MAX_TICKS, runMatch } from './runner'
import { wilsonInterval } from './stats'
import type { Entrant, MatchResult } from './types'

/**
 * Round-robin tournaments (#103). An entrant is a (loadout, profile) pair: the loadouts are the top N distinct Fire
 * sets of the dummy-DPS baseline, each with its best K general pairs (`selectLoadouts`), crossed with the behaviour
 * profiles. Every unordered pair of distinct entrants plays `games` best-of-1 matches, half
 * of them with each entrant as `player1` (which acts first within a tick). The score is each entrant's win rate over all
 * its games: only wins count, a draw (time cap or mutual lethal) and a loss are both non-wins.
 *
 * Everything here is a pure function of the options: per-match seeds come from the master seed, the pair index and the
 * game index. A shard plays the pairs whose index is its index modulo its count; `mergeShards` of all shards equals the
 * unsharded `runTournament`.
 */

export const TOURNAMENT_FORMAT = 'arena-tournament'
export const SHARD_FORMAT = 'arena-tournament-shard'

export const DEFAULT_TOP = 8
export const DEFAULT_GENERAL_PAIRS = 2
export const DEFAULT_GAMES = 2
export const DEFAULT_SEED = 1

export interface TournamentOptions {
    readonly baseline: Baseline
    /** How many distinct Fire sets to take, best first. Clamped to the table's size (reported in `config.top`). */
    readonly top?: number
    /** How many general pairs each Fire set plays with, best first (default 2). Fewer if the table has fewer. */
    readonly generalPairs?: number
    /** The profiles each loadout plays, by distinct `name`. */
    readonly profiles: readonly Profile[]
    /** Matches per pair: even, so each entrant is `player1` in exactly half. */
    readonly games?: number
    /** Master seed, an integer in [0, 2^32). */
    readonly seed?: number
    readonly maxTicks?: number
}

export interface EntrantInfo {
    /** `L<baseline rank, 2 digits>/<profile name>`: unique, and the last tie-break of the ranking. */
    readonly id: string
    readonly loadoutRank: number
    readonly loadout: readonly SpellId[]
    readonly profile: string
}

/** Everything that decides the result. Shards must agree on it to be merged. */
export interface TournamentConfig {
    readonly baselineVersion: string
    /** Fire sets: how many were asked for and how many the baseline had. */
    readonly top: { readonly requested: number; readonly used: number }
    /** General pairs asked for per Fire set. */
    readonly generalPairs: number
    readonly games: number
    readonly seed: number
    readonly maxTicks: number
    readonly profiles: readonly Profile[]
    readonly entrants: readonly EntrantInfo[]
    /** Baseline numbers per used loadout, to read the results against. */
    readonly loadouts: readonly { rank: number; dps: number; dpsUnderPressure: number }[]
}

/** The outcome of one pair's games. `a` and `b` are indexes into `config.entrants`, `a < b`. */
export interface PairResult {
    /** Position in the full pair list: (0,1), (0,2), ..., (1,2), ... */
    readonly pair: number
    readonly a: number
    readonly b: number
    readonly games: number
    readonly winsA: number
    readonly winsB: number
    readonly draws: number
    /** Games won by whoever was `player1`, whichever entrant that was: the first-mover edge, for information. */
    readonly firstWins: number
}

export interface TournamentPlan {
    readonly config: TournamentConfig
    /** The same entrants as `config.entrants`, with the controllers to play them. */
    readonly make: readonly (() => Entrant)[]
}

export interface ShardResult {
    readonly format: typeof SHARD_FORMAT
    readonly config: TournamentConfig
    readonly shard: { readonly index: number; readonly count: number }
    readonly pairs: readonly PairResult[]
}

export interface RankedEntrant extends EntrantInfo {
    readonly rank: number
    readonly wins: number
    readonly draws: number
    readonly losses: number
    readonly games: number
    readonly winRate: number
    /** 95% Wilson interval on the win rate. */
    readonly ci95: { readonly low: number; readonly high: number }
}

export interface TournamentResult {
    readonly format: typeof TOURNAMENT_FORMAT
    readonly config: TournamentConfig
    /** Best win rate first; ties by entrant id. */
    readonly ranking: readonly RankedEntrant[]
    /** `matrix[row][column]` is the number of games `row` won against `column` (0 on the diagonal). */
    readonly matrix: Readonly<Record<string, Readonly<Record<string, number>>>>
    /** Games won by `player1` over all games, for information on the first-mover edge. */
    readonly firstWins: number
    readonly games: number
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/**
 * Makes `profile` playable on `loadout` (which `checkLoadout` requires): drops rotation entries whose spell is not on
 * the loadout (with no entry left, the loadout's own Fire spells in slot order), the same for the free-cast window's
 * rotation (with no entry left, the adapted rotation), and, when the fake-cast spell is
 * missing, retargets the fake to the loadout's longest cast-time spell (the first in slot order on a tie), turning
 * fake-casting off only if the loadout has no cast-time spell. Everything else is kept, and a profile that already fits
 * comes back unchanged.
 */
export const adaptProfile = (profile: Profile, loadout: readonly SpellId[]): Profile => {
    let rotation = profile.rotation.filter(({ spell }) => loadout.includes(spell))
    if (rotation.length === 0) rotation = loadout.slice(0, ELEMENT_SPELL_COUNT).map(spell => ({ spell, when: [] }))
    const windowRotation = profile.lockoutWindow.rotation.filter(({ spell }) => loadout.includes(spell))
    const lockoutWindow =
        windowRotation.length === profile.lockoutWindow.rotation.length
            ? profile.lockoutWindow
            : { rotation: windowRotation.length > 0 ? windowRotation : rotation }
    let fakeCast = profile.fakeCast
    if (fakeCast.enabled && !loadout.includes(fakeCast.spell)) {
        let longest: SpellId | undefined
        for (const id of loadout)
            if (SPELLS[id].castSeconds && (!longest || SPELLS[id].castSeconds > (SPELLS[longest].castSeconds ?? 0)))
                longest = id
        fakeCast = longest ? { ...fakeCast, spell: longest } : { ...fakeCast, enabled: false }
    }
    return checkLoadout({ ...profile, rotation, lockoutWindow, fakeCast }, loadout)
}

/** Spell ids of a loadout's Fire set, in a canonical (sorted) order: slot order does not make a different set. */
const fireKey = (loadout: readonly SpellId[]) => [...loadout.slice(0, ELEMENT_SPELL_COUNT)].sort().join()
/** The loadout with its Fire set and its general pair each in canonical order, the identity of a full loadout. */
const loadoutKey = (loadout: readonly SpellId[]) =>
    [fireKey(loadout), loadout[ELEMENT_SPELL_COUNT], [...loadout.slice(ELEMENT_SPELL_COUNT + 1)].sort().join()].join(
        '|',
    )

/**
 * The tournament's loadouts: the first `sets` distinct 4-spell Fire sets in baseline order (a set ranks where its best
 * loadout does), and for each its first `generalPairs` loadouts, i.e. its best general pairs. A loadout that only
 * reorders the slots of one already taken is skipped, so no full loadout is repeated. Returns them grouped by set,
 * sets best first and pairs best first within a set, and how many sets the table had room for.
 */
export const selectLoadouts = (
    baseline: Baseline,
    sets: number,
    generalPairs: number,
): { loadouts: BaselineLoadout[]; sets: number } => {
    const bySet = new Map<string, BaselineLoadout[]>()
    const taken = new Set<string>()
    for (const entry of baseline.loadouts) {
        const key = fireKey(entry.loadout)
        let group = bySet.get(key)
        if (!group && bySet.size === sets) continue
        const full = loadoutKey(entry.loadout)
        if (taken.has(full)) continue
        taken.add(full)
        if (!group) bySet.set(key, (group = []))
        if (group.length < generalPairs) group.push(entry)
    }
    return { loadouts: [...bySet.values()].flat(), sets: bySet.size }
}

/**
 * Validates the options and builds the entrants: the selected loadouts (`selectLoadouts`), each with the profiles in the
 * given order.
 */
export const planTournament = (options: TournamentOptions): TournamentPlan => {
    const { baseline, profiles, top = DEFAULT_TOP, games = DEFAULT_GAMES, seed = DEFAULT_SEED } = options
    const generalPairs = options.generalPairs ?? DEFAULT_GENERAL_PAIRS
    const maxTicks = options.maxTicks ?? DEFAULT_MAX_TICKS
    if (!(Number.isInteger(top) && top >= 1)) throw new Error(`top must be a positive integer, got ${top}`)
    if (!(Number.isInteger(generalPairs) && generalPairs >= 1))
        throw new Error(`generalPairs must be a positive integer, got ${generalPairs}`)
    if (!(Number.isInteger(games) && games >= 2 && games % 2 === 0))
        throw new Error(`games must be an even integer of at least 2 (so sides swap equally), got ${games}`)
    if (!isSeed(seed)) throw new Error(`seed must be an integer in [0, 2^32), got ${seed}`)
    if (!(Number.isInteger(maxTicks) && maxTicks >= 1)) throw new Error(`maxTicks must be a positive integer`)
    if (profiles.length === 0) throw new Error('at least one profile is needed')
    const names = new Set<string>()
    for (const { name } of profiles) {
        if (names.has(name)) throw new Error(`profile ${JSON.stringify(name)} is listed twice`)
        names.add(name)
    }
    const { loadouts: chosen, sets: used } = selectLoadouts(baseline, top, generalPairs)
    if (chosen.length * profiles.length < 2) throw new Error('a tournament needs at least two entrants')
    const entrants: EntrantInfo[] = []
    const make: (() => Entrant)[] = []
    for (const { rank, loadout } of chosen) {
        for (const profile of profiles) {
            const adapted = adaptProfile(profile, loadout)
            entrants.push({ id: `L${pad2(rank)}/${profile.name}`, loadoutRank: rank, loadout, profile: profile.name })
            make.push(() => profileEntrant(adapted, loadout))
        }
    }
    return {
        config: {
            baselineVersion: baseline.version,
            top: { requested: top, used },
            generalPairs,
            games,
            seed,
            maxTicks,
            profiles,
            entrants,
            loadouts: chosen.map(({ rank, dps, dpsUnderPressure }) => ({ rank, dps, dpsUnderPressure })),
        },
        make,
    }
}

/** Every unordered pair of distinct entrants as `[a, b]` with `a < b`, in a fixed order. */
export const pairList = (entrants: number): [number, number][] => {
    const pairs: [number, number][] = []
    for (let a = 0; a < entrants; a++) for (let b = a + 1; b < entrants; b++) pairs.push([a, b])
    return pairs
}

/** The pair indexes shard `index` of `count` plays: those with `pair % count === index`. */
export const shardPairs = (total: number, index: number, count: number): number[] => {
    if (!(Number.isInteger(count) && count >= 1 && Number.isInteger(index) && index >= 0 && index < count))
        throw new Error(`shard must be i/n with 0 <= i < n, got ${index}/${count}`)
    const out: number[] = []
    for (let pair = index; pair < total; pair += count) out.push(pair)
    return out
}

export type MatchFn = (options: Parameters<typeof runMatch>[0]) => MatchResult

/**
 * Plays one pair. Game `g` is seeded `deriveSeed(seed, pair, g)`; entrant `a` is `player1` on even games and `b` on odd
 * ones, so each is `player1` in exactly `games / 2`. `run` is only for tests.
 */
export const playPair = (plan: TournamentPlan, pair: number, run: MatchFn = runMatch): PairResult =>
    playPairs(plan, [pair], run)[0]

const playPairOf = (plan: TournamentPlan, pair: number, a: number, b: number, run: MatchFn): PairResult => {
    const { games, seed, maxTicks } = plan.config
    let winsA = 0
    let winsB = 0
    let draws = 0
    let firstWins = 0
    for (let game = 0; game < games; game++) {
        const aFirst = game % 2 === 0
        const result = run({
            seed: deriveSeed(seed, pair, game),
            a: plan.make[aFirst ? a : b](),
            b: plan.make[aFirst ? b : a](),
            maxTicks,
            log: false,
        })
        if (result.winner === 'draw') draws++
        else {
            if (result.winner === 'a') firstWins++
            if ((result.winner === 'a') === aFirst) winsA++
            else winsB++
        }
    }
    return { pair, a, b, games, winsA, winsB, draws, firstWins }
}

/** Plays the given pair indexes (for example one shard, or one worker's share of it), in order. */
export const playPairs = (plan: TournamentPlan, pairs: readonly number[], run: MatchFn = runMatch): PairResult[] => {
    const list = pairList(plan.config.entrants.length)
    return pairs.map(pair => {
        const [a, b] = list[pair] ?? []
        if (a === undefined) throw new Error(`no pair ${pair}`)
        return playPairOf(plan, pair, a, b, run)
    })
}

/** Plays one shard: the pairs with `pair % count === index`. */
export const runShard = (plan: TournamentPlan, index: number, count: number, run: MatchFn = runMatch): ShardResult => {
    const total = pairList(plan.config.entrants.length).length
    return {
        format: SHARD_FORMAT,
        config: plan.config,
        shard: { index, count },
        pairs: playPairs(plan, shardPairs(total, index, count), run),
    }
}

/** Scores a complete set of pair results: win rates, ranking and the matchup matrix. */
export const summarize = (config: TournamentConfig, pairs: readonly PairResult[]): TournamentResult => {
    const n = config.entrants.length
    const list = pairList(n)
    const byPair = new Map<number, PairResult>()
    for (const result of pairs) {
        const expected = list[result.pair]
        if (expected === undefined || expected[0] !== result.a || expected[1] !== result.b)
            throw new Error(`pair ${result.pair} is not (${expected?.join(', ')})`)
        if (byPair.has(result.pair)) throw new Error(`pair ${result.pair} appears twice`)
        if (
            result.games !== config.games ||
            !Number.isInteger(result.winsA) ||
            !Number.isInteger(result.winsB) ||
            !Number.isInteger(result.draws) ||
            !Number.isInteger(result.firstWins) ||
            result.winsA < 0 ||
            result.winsB < 0 ||
            result.draws < 0 ||
            result.winsA + result.winsB + result.draws !== result.games ||
            result.firstWins < 0 ||
            result.firstWins > result.winsA + result.winsB
        )
            throw new Error(`pair ${result.pair} has inconsistent counts`)
        byPair.set(result.pair, result)
    }
    const missing = list.findIndex((_, pair) => !byPair.has(pair))
    if (missing !== -1) throw new Error(`pair ${missing} of ${list.length} is missing`)

    const wins = new Array<number>(n).fill(0)
    const draws = new Array<number>(n).fill(0)
    const games = new Array<number>(n).fill(0)
    const grid = config.entrants.map(() => new Array<number>(n).fill(0))
    let firstWins = 0
    let total = 0
    for (const { a, b, winsA, winsB, draws: d, games: g, firstWins: f } of byPair.values()) {
        wins[a] += winsA
        wins[b] += winsB
        draws[a] += d
        draws[b] += d
        games[a] += g
        games[b] += g
        grid[a][b] = winsA
        grid[b][a] = winsB
        firstWins += f
        total += g
    }

    const ranking = config.entrants
        .map((entrant, i) => ({
            ...entrant,
            wins: wins[i],
            draws: draws[i],
            losses: games[i] - wins[i] - draws[i],
            games: games[i],
            winRate: games[i] === 0 ? 0 : wins[i] / games[i],
            ci95: wilsonInterval(wins[i], games[i]),
        }))
        // wins/games compared by cross-multiplication: no float rounding decides a tie
        .sort((x, y) => y.wins * x.games - x.wins * y.games || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
        .map((entrant, i) => ({ rank: i + 1, ...entrant }))
    const matrix: Record<string, Record<string, number>> = {}
    config.entrants.forEach((row, i) => {
        matrix[row.id] = {}
        config.entrants.forEach((column, j) => (matrix[row.id][column.id] = grid[i][j]))
    })
    return { format: TOURNAMENT_FORMAT, config, ranking, matrix, firstWins, games: total }
}

/** The whole round-robin, unsharded. */
export const runTournament = (plan: TournamentPlan, run: MatchFn = runMatch): TournamentResult =>
    summarize(plan.config, playPairs(plan, shardPairs(pairList(plan.config.entrants.length).length, 0, 1), run))

/**
 * Combines the shards of one tournament into its result, the same one `runTournament` gives. They must share a
 * config and a count and cover every index once, in any order.
 */
export const mergeShards = (shards: readonly ShardResult[]): TournamentResult => {
    if (shards.length === 0) throw new Error('no shards to merge')
    for (const shard of shards)
        if (shard?.format !== SHARD_FORMAT) throw new Error(`not a tournament shard (format ${shard?.format})`)
    const [first] = shards
    const config = JSON.stringify(first.config)
    const { count } = first.shard
    const seen = new Set<number>()
    for (const shard of shards) {
        if (JSON.stringify(shard.config) !== config) throw new Error('shards come from different tournaments')
        if (shard.shard.count !== count)
            throw new Error(`shards disagree on the shard count (${count} and ${shard.shard.count})`)
        if (seen.has(shard.shard.index)) throw new Error(`shard ${shard.shard.index}/${count} is given twice`)
        seen.add(shard.shard.index)
        const total = pairList(first.config.entrants.length).length
        const expected = shardPairs(total, shard.shard.index, count)
        if (shard.pairs.length !== expected.length || shard.pairs.some(p => p.pair % count !== shard.shard.index))
            throw new Error(`shard ${shard.shard.index}/${count} does not hold exactly its pairs`)
    }
    if (seen.size !== count) {
        const absent = Array.from({ length: count }, (_, i) => i).filter(i => !seen.has(i))
        throw new Error(`missing shard(s) ${absent.map(i => `${i}/${count}`).join(', ')}`)
    }
    return summarize(
        first.config,
        shards.flatMap(shard => shard.pairs),
    )
}
