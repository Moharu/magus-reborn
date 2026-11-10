import type { SpellId } from '@magus/engine'
import type { Baseline } from './baseline'
import { parseProfile, type Profile } from './profile'
import { behaviourKey, clampProfile, crossoverProfiles, mutateProfile, parameterChanges } from './profile-params'
import { deriveSeed, isSeed, Rng } from './prng'
import { DEFAULT_MAX_TICKS, runMatch } from './runner'
import {
    DEFAULT_GAMES,
    DEFAULT_GENERAL_PAIRS,
    DEFAULT_SEED,
    DEFAULT_TOP,
    pairList,
    planTournament,
    playPairs,
    type MatchFn,
} from './tournament'
import { percent } from './tournament-format'

/**
 * Evolutionary self-tuning of profile parameters (#104). A population of profiles is scored, generation after
 * generation, against a fixed field (the archetypes by default) on the tournament's top loadouts; the best `elite` pass
 * unchanged and the rest are bred from the ranked population by tournament selection, crossover and mutation of the
 * tunable parameters (`profile-params.ts`) only.
 *
 * A profile's score is its row of the #103 round-robin: the tournament of `[profile, ...field]` on the selected
 * loadouts, restricted to the pairs where one of the profile's entrants meets a field entrant. Those pair indexes and
 * their match seeds (`deriveSeed(selectionSeed, pair, game)`) are the same for every profile in every generation, so a
 * score is a pure function of the profile: an elite keeps its score, and the best score never drops while `elite >= 1`.
 * Only wins count (#103). Every random choice of the search comes from `new Rng(deriveSeed(seed, BREED, generation,
 * index))`, so a run is a pure function of its options.
 */

export const TUNING_FORMAT = 'arena-tuning'
export const DEFAULT_GENERATIONS = 5
export const DEFAULT_POPULATION = 8
export const DEFAULT_ELITE = 2
/** Chance that each tunable value of a child is mutated (at least one always is). */
export const MUTATION_RATE = 0.2
/** Chance that a child is the crossover of two parents rather than a copy of one, before mutation. */
export const CROSSOVER_RATE = 0.5
/** The name a profile plays under while it is scored, so it never clashes with a field profile's name. */
export const CANDIDATE_NAME = '(candidate)'

/** Domain tags for `deriveSeed(seed, tag, ...)`: breeding draws, the selection seed set and the holdout seed set. */
const BREED = 1
const SELECTION = 2
const HOLDOUT = 3

/** The seed of the stream that makes member `index` of `generation` (every draw that member's breeding makes). */
export const breedSeed = (seed: number, generation: number, index: number) => deriveSeed(seed, BREED, generation, index)

export interface TuningOptions {
    readonly baseline: Baseline
    /** Starting profiles: generation 0 holds them (clamped to the parameter bounds), then mutants of them in turn. */
    readonly seeds: readonly Profile[]
    /** The fixed opponents every profile is scored against, on every selected loadout. Distinct names. */
    readonly field: readonly Profile[]
    readonly top?: number
    readonly generalPairs?: number
    /** Games per (profile entrant, field entrant) pair: even, so sides swap equally. */
    readonly games?: number
    readonly maxTicks?: number
    /** Master seed `S`, an integer in [0, 2^32). */
    readonly seed?: number
    /** Generations scored, generation 0 (the starting population) included. */
    readonly generations?: number
    readonly population?: number
    /** Profiles passed unchanged to the next generation: the best `elite`, 0 <= elite < population. */
    readonly elite?: number
    /** Match budget, the holdout re-score included. Reaching it stops the search early (`partial`). */
    readonly maxMatches?: number
    /**
     * Also scores the untuned starting profile that the best one descends from, on the selection seeds and on the holdout
     * seeds, so the result can report the improvement over it (#156). Costs one more holdout re-score of the budget
     * (the start itself is scored in generation 0). Off by default.
     */
    readonly compareToStart?: boolean
    /** Called after each fully scored generation, for progress output. */
    readonly onGeneration?: (generation: GenerationSummary) => void
    /** Only for tests. */
    readonly run?: MatchFn
}

export interface Score {
    readonly wins: number
    readonly draws: number
    readonly games: number
    readonly winRate: number
    /** Per selected loadout, in tournament order. */
    readonly perLoadout: readonly {
        readonly rank: number
        readonly wins: number
        readonly games: number
        readonly winRate: number
    }[]
}

export interface ScoredProfile {
    readonly profile: Profile
    /** The starting profile it descends from (the first parent's line). */
    readonly origin: string
    readonly score: Score
}

export interface GenerationSummary {
    readonly generation: number
    /** Best win rate first; ties keep population order (elites first). */
    readonly ranking: readonly ScoredProfile[]
    readonly best: number
    readonly median: number
    readonly worst: number
    /** Matches played so far in the run. */
    readonly matches: number
}

export interface TuningConfig {
    readonly baselineVersion: string
    readonly seed: number
    readonly generations: number
    readonly population: number
    readonly elite: number
    readonly top: { readonly requested: number; readonly used: number }
    readonly generalPairs: number
    readonly games: number
    readonly maxTicks: number
    readonly maxMatches: number | null
    readonly seeds: readonly string[]
    readonly field: readonly string[]
    readonly loadouts: readonly { readonly rank: number; readonly loadout: readonly SpellId[] }[]
    /** Tournament seeds of the selection and the holdout seed sets, which share no match seed. */
    readonly selectionSeed: number
    readonly holdoutSeed: number
    readonly matchesPerProfile: number
    /** The one starting profile being tuned when the search was limited to it (`--profile`), otherwise null. */
    readonly tunedProfile: string | null
}

export interface TuningResult {
    readonly format: typeof TUNING_FORMAT
    readonly config: TuningConfig
    /** Every fully scored generation. */
    readonly generations: readonly GenerationSummary[]
    /** The last fully scored generation, ranked (if the budget stopped generation 0, the profiles it scored). */
    readonly population: readonly ScoredProfile[]
    /** The best profile seen, its selection score, and its re-score on the holdout seed set. */
    readonly best: ScoredProfile & {
        readonly holdout: Score
        /** Tunable values that differ from the starting profile it descends from. */
        readonly changes: readonly { readonly path: string; readonly from: unknown; readonly to: unknown }[]
    }
    /** With `compareToStart`: the untuned starting profile `best` descends from, and its scores on both seed sets. */
    readonly start: { readonly profile: Profile; readonly score: Score; readonly holdout: Score } | null
    readonly matches: number
    /** True when `maxMatches` stopped the search before its last generation was scored. */
    readonly partial: boolean
    /** Where the budget stopped it: the generation, and how many of its profiles had been scored. */
    readonly stopped: { readonly generation: number; readonly scored: number } | null
}

/** Whether `x` scores above `y` (same number of games for every profile, so wins decide). */
const better = (x: Score, y: Score) => x.wins * y.games > y.wins * x.games

const rate = (wins: number, games: number) => (games === 0 ? 0 : wins / games)

/** The median of win rates, the mean of the two middle ones for an even count. */
const median = (values: readonly number[]) => {
    const sorted = [...values].sort((a, b) => a - b)
    const mid = sorted.length >> 1
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

interface ScoringOptions {
    readonly baseline: Baseline
    readonly field: readonly Profile[]
    readonly top: number
    readonly generalPairs: number
    readonly games: number
    readonly maxTicks: number
    readonly run: MatchFn
}

/**
 * Scores profiles against the field with tournament seed `seed`. The profile is entrant 0 of each loadout's group in
 * `planTournament([profile, ...field])`, so the pairs it plays, and their seeds, never depend on the profile.
 */
export const scorer = (options: ScoringOptions, seed: number) => {
    const { baseline, field, top, generalPairs, games, maxTicks, run } = options
    if (field.some(p => p.name === CANDIDATE_NAME)) throw new Error(`no field profile may be named ${CANDIDATE_NAME}`)
    const plan = (profile: Profile) =>
        planTournament({
            baseline,
            top,
            generalPairs,
            games,
            seed,
            maxTicks,
            profiles: [{ ...profile, name: CANDIDATE_NAME }, ...field],
        })
    const { config } = plan(field[0])
    const stride = field.length + 1
    const mine = (entrant: number) => entrant % stride === 0
    const pairs = pairList(config.entrants.length).flatMap(([a, b], pair) => (mine(a) !== mine(b) ? [pair] : []))
    const ranks = config.loadouts.map(l => l.rank)
    return {
        config,
        pairs,
        matches: pairs.length * games,
        /** Every match seed this scorer uses. */
        seeds: () => new Set(pairs.flatMap(pair => Array.from({ length: games }, (_, g) => deriveSeed(seed, pair, g)))),
        score: (profile: Profile): Score => {
            const wins = ranks.map(() => 0)
            const played = ranks.map(() => 0)
            let draws = 0
            for (const result of playPairs(plan(profile), pairs, run)) {
                const own = mine(result.a) ? result.a : result.b
                const loadout = Math.floor(own / stride)
                wins[loadout] += own === result.a ? result.winsA : result.winsB
                played[loadout] += result.games
                draws += result.draws
            }
            const total = wins.reduce((s, w) => s + w, 0)
            const games = played.reduce((s, g) => s + g, 0)
            return {
                wins: total,
                draws,
                games,
                winRate: rate(total, games),
                perLoadout: ranks.map((rank, i) => ({
                    rank,
                    wins: wins[i],
                    games: played[i],
                    winRate: rate(wins[i], played[i]),
                })),
            }
        },
    }
}

/** The first tournament seed from `deriveSeed(seed, HOLDOUT, attempt)` whose match seeds are all unused by `used`. */
const holdoutSeedFor = (seed: number, matchSeeds: (tournamentSeed: number) => Set<number>, used: Set<number>) => {
    for (let attempt = 0; ; attempt++) {
        const candidate = deriveSeed(seed, HOLDOUT, attempt)
        if (![...matchSeeds(candidate)].some(s => used.has(s))) return candidate
    }
}

const positiveInt = (name: string, value: number) => {
    if (!(Number.isInteger(value) && value >= 1)) throw new Error(`${name} must be a positive integer, got ${value}`)
}

/** Runs the search. See the module comment. */
export const tune = (options: TuningOptions): TuningResult => {
    const {
        baseline,
        seeds,
        field,
        top = DEFAULT_TOP,
        generalPairs = DEFAULT_GENERAL_PAIRS,
        games = DEFAULT_GAMES,
        maxTicks = DEFAULT_MAX_TICKS,
        seed = DEFAULT_SEED,
        generations = DEFAULT_GENERATIONS,
        population = DEFAULT_POPULATION,
        compareToStart = false,
        run = runMatch,
    } = options
    const elite = options.elite ?? Math.min(DEFAULT_ELITE, population - 1)
    const maxMatches = options.maxMatches ?? Infinity
    if (!isSeed(seed)) throw new Error(`seed must be an integer in [0, 2^32), got ${seed}`)
    positiveInt('generations', generations)
    positiveInt('population', population)
    if (!(Number.isInteger(elite) && elite >= 0 && elite < population))
        throw new Error(`elite must be an integer in [0, population), got ${elite}`)
    if (!(maxMatches === Infinity || (Number.isInteger(maxMatches) && maxMatches >= 0)))
        throw new Error(`maxMatches must be a non-negative integer, got ${maxMatches}`)
    if (seeds.length === 0) throw new Error('at least one starting profile is needed')
    if (field.length === 0) throw new Error('at least one field profile is needed')
    if (new Set(seeds.map(p => p.name)).size !== seeds.length) throw new Error('starting profiles need distinct names')

    const scoring = { baseline, field, top, generalPairs, games, maxTicks, run }
    const selectionSeed = deriveSeed(seed, SELECTION)
    const selection = scorer(scoring, selectionSeed)
    const holdoutSeed = holdoutSeedFor(seed, s => scorer(scoring, s).seeds(), selection.seeds())
    const cost = selection.matches
    // the selection score of the profile being tried, then the holdout re-scores of the best (and of the start)
    const reserve = (compareToStart ? 3 : 2) * cost
    if (maxMatches < reserve)
        throw new Error(
            `maxMatches ${maxMatches} is below ${reserve}: scoring one profile and its holdout re-score${compareToStart ? 's' : ''} takes ${cost} matches each`,
        )
    const starts = seeds.map(clampProfile)
    const config: TuningConfig = {
        baselineVersion: baseline.version,
        seed,
        generations,
        population,
        elite,
        top: selection.config.top,
        generalPairs,
        games,
        maxTicks,
        maxMatches: maxMatches === Infinity ? null : maxMatches,
        seeds: seeds.map(p => p.name),
        field: field.map(p => p.name),
        loadouts: selection.config.loadouts.map(({ rank }) => ({
            rank,
            loadout: selection.config.entrants.find(e => e.loadoutRank === rank)!.loadout,
        })),
        selectionSeed,
        holdoutSeed,
        matchesPerProfile: cost,
        tunedProfile: seeds.length === 1 ? seeds[0].name : null,
    }

    // the loadouts being scored: values with no signal on them (Frost entries in a Fire-only run) are not mutated (#163)
    const playedLoadouts = config.loadouts.map(({ loadout }) => loadout)
    const rngFor = (generation: number, index: number) => new Rng(breedSeed(seed, generation, index))
    const named = (profile: Profile, name: string): Profile => ({ ...profile, name })

    // generation 0: the starting profiles, then mutants of them in turn
    let members: { profile: Profile; origin: string }[] = Array.from({ length: population }, (_, i) => {
        const start = starts[i % starts.length]
        if (i < starts.length) return { profile: start, origin: start.name }
        return {
            profile: named(mutateProfile(start, rngFor(0, i), MUTATION_RATE, playedLoadouts), `g0-${i}`),
            origin: start.name,
        }
    })

    const cache = new Map<string, Score>()
    const summaries: GenerationSummary[] = []
    let ranked: ScoredProfile[] = []
    let best: ScoredProfile | undefined
    let matches = 0
    let stopped: TuningResult['stopped'] = null

    for (let generation = 0; generation < generations && !stopped; generation++) {
        if (generation > 0) members = breed(ranked, generation)
        const scored: ScoredProfile[] = []
        for (const member of members) {
            const key = behaviourKey(member.profile)
            let score = cache.get(key)
            if (!score) {
                if (matches + reserve > maxMatches) {
                    // keep room for the holdout re-score(s)
                    stopped = { generation, scored: scored.length }
                    break
                }
                score = selection.score(member.profile)
                matches += cost
                cache.set(key, score)
            }
            const entry = { ...member, score }
            scored.push(entry)
            if (!best || better(score, best.score)) best = entry
        }
        // a stable sort: ties keep population order, so elites stay ahead of equal children
        const order = [...scored].sort((x, y) => y.score.wins * x.score.games - x.score.wins * y.score.games)
        if (stopped) {
            // a partly scored generation is not a population; generation 0's part is all there is
            if (generation === 0) ranked = order
            break
        }
        ranked = order
        const rates = ranked.map(r => r.score.winRate)
        const summary: GenerationSummary = {
            generation,
            ranking: ranked,
            best: rates[0],
            median: median(rates),
            worst: rates[rates.length - 1],
            matches,
        }
        summaries.push(summary)
        options.onGeneration?.(summary)
    }

    function breed(parents: readonly ScoredProfile[], generation: number) {
        // tournament selection of size 2 over the ranking: the better ranked of two uniform draws
        const pick = (rng: Rng) => parents[Math.min(rng.int(parents.length), rng.int(parents.length))]
        const next = parents.slice(0, elite).map(({ profile, origin }) => ({ profile, origin }))
        for (let i = elite; i < population; i++) {
            const rng = rngFor(generation, i)
            const a = pick(rng)
            const child =
                rng.next() < CROSSOVER_RATE
                    ? crossoverProfiles(a.profile, pick(rng).profile, rng, playedLoadouts)
                    : a.profile
            next.push({
                profile: named(mutateProfile(child, rng, MUTATION_RATE, playedLoadouts), `g${generation}-${i}`),
                origin: a.origin,
            })
        }
        return next
    }

    if (!best) throw new Error('the match budget ran out before any profile was scored')
    const holdoutScorer = scorer(scoring, holdoutSeed)
    const holdout = holdoutScorer.score(best.profile)
    matches += cost
    const start = starts.find(p => p.name === best!.origin)!
    let compared: TuningResult['start'] = null
    if (compareToStart) {
        // the start is always scored: it is a generation 0 member, and mutants only come after all the starts
        const startKey = behaviourKey(start)
        const sameAsBest = startKey === behaviourKey(best.profile)
        compared = {
            profile: start,
            score: cache.get(startKey) ?? best.score,
            holdout: sameAsBest ? holdout : holdoutScorer.score(start),
        }
        if (!sameAsBest) matches += cost
    }
    return {
        format: TUNING_FORMAT,
        config,
        generations: summaries,
        population: ranked,
        best: { ...best, holdout, changes: parameterChanges(start, best.profile) },
        start: compared,
        matches,
        partial: stopped !== null,
        stopped,
    }
}

/**
 * The best profile as a plain profile JSON object (what `parseProfile` and `loadProfile` take), named after its origin
 * and the seed, with where it came from and both win rates as its one-line intent.
 */
export const tunedProfile = (result: TuningResult): Profile => {
    const { best, config, partial } = result
    const intent =
        `Tuned from ${best.origin} by arena:tune, seed ${config.seed}: ${percent(best.score.winRate)} on the selection seeds, ` +
        `${percent(best.holdout.winRate)} on fresh seeds${partial ? ' (partial run)' : ''}.`
    const name = `${best.origin}-tuned-s${config.seed}`
    return parseProfile({ ...best.profile, name: name.slice(-200), intent: intent.slice(0, 200) })
}
