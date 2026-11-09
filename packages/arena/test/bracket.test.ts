import { describe, expect, it } from 'vitest'
import {
    ARCHETYPES,
    BRACKET_TAG,
    deriveSeed,
    formatBracket,
    formatReport,
    pairList,
    planTournament,
    runBracket,
    runTournament,
    summarize,
    withBracket,
    type Baseline,
    type BracketResult,
    type Entrant,
    type MatchFn,
    type MatchResult,
    type PairResult,
    type TournamentResult,
} from '../src'
import { METEOR_LOADOUT, OTHER_LOADOUT } from './helpers'

// The top-8 double-elimination bracket (#136). 2 loadouts x the 4 archetypes: 8 entrants, all in the bracket.
const baseline: Baseline = {
    version: 'test',
    loadouts: [
        { rank: 1, loadout: METEOR_LOADOUT, dps: 40, dpsUnderPressure: 30 },
        { rank: 2, loadout: OTHER_LOADOUT, dps: 35, dpsUnderPressure: 31 },
    ],
}
const plan = planTournament({
    baseline,
    profiles: Object.values(ARCHETYPES).map(a => a.profile),
    games: 2,
    seed: 5,
    maxTicks: 600,
})
const { entrants } = plan.config

/**
 * A round-robin where entrant `i` (config order) beats every entrant after it: the ranking is the config order, so
 * seed `n` is `entrants[order[n - 1]]`. Here the order is reversed, so seeding is visibly by rank, not by config order.
 */
const order = entrants.map((_, i) => entrants.length - 1 - i)
const result: TournamentResult = summarize(
    plan.config,
    pairList(entrants.length).map(([a, b], pair): PairResult => {
        const aBetter = order.indexOf(a) < order.indexOf(b)
        return { pair, a, b, games: 2, winsA: aBetter ? 2 : 0, winsB: aBetter ? 0 : 2, draws: 0, firstWins: 1 }
    }),
)
/** The bracket seed (1-8) of an entrant a match is given. */
const seedOf = (entrant: Entrant) => {
    const i = entrants.findIndex(e => e.loadout === entrant.loadout && e.profile === entrant.name)
    return order.indexOf(i) + 1
}

const outcome = (seed: number, winner: MatchResult['winner']): MatchResult => ({
    seed,
    winner,
    reason: winner === 'draw' ? 'timeout' : 'death',
    ticks: 1,
    hp: { a: 0, b: 0 },
    stats: {} as MatchResult['stats'],
    log: [],
})

/** A stand-in for runMatch where `beats(x, y)` says whether seed x beats seed y (null: a draw). Records each game. */
const fake = (beats: (x: number, y: number, seed: number) => boolean | null) => {
    const games: { seed: number; first: number; second: number }[] = []
    const run: MatchFn = ({ seed, a, b }) => {
        const [x, y] = [seedOf(a), seedOf(b)]
        games.push({ seed, first: x, second: y })
        const won = beats(x, y, seed)
        return outcome(seed, won === null ? 'draw' : won ? 'a' : 'b')
    }
    return { run, games }
}
const betterSeedWins = (x: number, y: number) => x < y

const places = (bracket: BracketResult) => bracket.placements.map(p => [p.place, p.seeds])

describe('double-elimination bracket (#136)', () => {
    it('seeds the round-robin top 8 by rank: 1v8, 4v5, 2v7, 3v6', () => {
        const bracket = runBracket(result, { run: fake(betterSeedWins).run })
        expect(bracket.seeds.map(s => s.id)).toEqual(order.map(i => entrants[i].id))
        expect(bracket.seeds.map(s => s.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
        expect(bracket.sets.slice(0, 4).map(s => [s.id, s.a, s.b])).toEqual([
            ['UB1', 1, 8],
            ['UB2', 4, 5],
            ['UB3', 2, 7],
            ['UB4', 3, 6],
        ])
    })

    it('plays a full bracket: the better seed always winning gives the seed order, with no reset', () => {
        const { run, games } = fake(betterSeedWins)
        const bracket = runBracket(result, { run })
        expect(bracket.sets.map(s => `${s.id} ${s.a}v${s.b} ${s.winsA}-${s.winsB} ${s.winner}`)).toEqual([
            'UB1 1v8 3-0 1',
            'UB2 4v5 3-0 4',
            'UB3 2v7 3-0 2',
            'UB4 3v6 3-0 3',
            'UB5 1v4 3-0 1',
            'UB6 2v3 3-0 2',
            'LB1 5v8 3-0 5',
            'LB2 6v7 3-0 6',
            // crossed: the loser of the other upper semifinal
            'LB3 3v5 3-0 3',
            'LB4 4v6 3-0 4',
            'UB7 1v2 3-0 1',
            'LB5 3v4 3-0 3',
            'LB6 2v3 3-0 2',
            'GF1 1v2 3-0 1',
        ])
        expect(bracket.reset).toBe(false)
        expect(places(bracket)).toEqual([
            ['1st', [1]],
            ['2nd', [2]],
            ['3rd', [3]],
            ['4th', [4]],
            ['5th-6th', [5, 6]],
            ['7th-8th', [7, 8]],
        ])
        // 14 sets of 3 games, every game with its own seed from the master seed
        expect(games).toHaveLength(42)
        expect(games[0].seed).toBe(deriveSeed(5, BRACKET_TAG, 0, 0))
        expect(games[4].seed).toBe(deriveSeed(5, BRACKET_TAG, 1, 1))
        expect(new Set(games.map(g => g.seed)).size).toBe(42)
    })

    it('alternates sides game by game, the better seed moving first in a set first game', () => {
        // player1 always wins: every set goes the full five, 3-2 to the better seed, which moves first in games 0, 2, 4
        const { run, games } = fake(() => true)
        const bracket = runBracket(result, { run })
        expect(bracket.sets[0]).toMatchObject({ id: 'UB1', winsA: 3, winsB: 2, games: 5, winner: 1 })
        expect(bracket.sets.every(s => s.winsA === 3 && s.winsB === 2)).toBe(true)
        expect(games.slice(0, 5).map(g => [g.first, g.second])).toEqual([
            [1, 8],
            [8, 1],
            [1, 8],
            [8, 1],
            [1, 8],
        ])
    })

    it('has a bracket reset: the lower-bracket winner taking the first grand final forces a second', () => {
        // seed 8 upsets seed 1 in the first round, then the better seed wins every other game
        const bracket = runBracket(result, {
            run: fake((x, y) => ((x === 8 && y === 1) || (x === 1 && y === 8) ? x === 8 : x < y)).run,
        })
        const byId = Object.fromEntries(bracket.sets.map(s => [s.id, s]))
        expect(byId.UB1.winner).toBe(8)
        expect(byId.UB7.winner).toBe(2)
        // 1 comes back through the lower bracket and takes GF1 from the upper winner: GF2 decides
        expect(byId.LB6.winner).toBe(1)
        expect(byId.GF1).toMatchObject({ a: 1, b: 2, winner: 1 })
        expect(bracket.reset).toBe(true)
        expect(bracket.sets.map(s => s.id).at(-1)).toBe('GF2')
        expect(byId.GF2).toMatchObject({ round: 'Grand final (reset)', winner: 1, loser: 2 })
        expect(places(bracket)).toEqual([
            ['1st', [1]],
            ['2nd', [2]],
            ['3rd', [4]],
            ['4th', [6]],
            ['5th-6th', [3, 8]],
            ['7th-8th', [5, 7]],
        ])
        // and when the upper winner takes GF2, it is still first
        const upper = runBracket(result, {
            run: fake((x, y, seed) => {
                if ((x === 8 && y === 1) || (x === 1 && y === 8)) return x === 8
                // GF2 is set 14: the upper winner (2) wins it
                const gf2 = [0, 1, 2, 3, 4].some(g => deriveSeed(5, BRACKET_TAG, 14, g) === seed)
                return gf2 ? x === 2 : x < y
            }).run,
        })
        expect(upper.reset).toBe(true)
        expect(places(upper).slice(0, 2)).toEqual([
            ['1st', [2]],
            ['2nd', [1]],
        ])
    })

    it('replays draws up to the cap, then gives the set to the better seed on equal wins', () => {
        const { run, games } = fake(() => null)
        const bracket = runBracket(result, { run, drawCap: 2 })
        // every set: 3 draws (the cap, then one more), 0-0, to the better seed
        for (const set of bracket.sets)
            expect(set).toMatchObject({ winsA: 0, winsB: 0, draws: 3, games: 3, decidedBy: 'seed' })
        expect(bracket.sets.every(s => s.winner === s.a)).toBe(true)
        expect(places(bracket).map(p => p[1])).toEqual([[1], [2], [3], [4], [5, 6], [7, 8]])
        expect(games).toHaveLength(14 * 3)
    })

    it('draws below the cap are replayed and the set is still a best-of; at the cap more wins decide', () => {
        // the first two games of every set are drawn, then the better seed wins: 2 draws + 3 wins
        const firstTwo = new Set(
            Array.from({ length: 15 }, (_, s) => [0, 1].map(g => deriveSeed(5, BRACKET_TAG, s, g))).flat(),
        )
        const replayed = runBracket(result, { run: fake((x, y, seed) => (firstTwo.has(seed) ? null : x < y)).run })
        for (const set of replayed.sets) expect(set).toMatchObject({ draws: 2, games: 5, winsA: 3, winsB: 0 })
        // the worse seed wins game 0, then every game is drawn: past the cap (1) the set is 0-1, to the worse seed
        const opener = new Set(Array.from({ length: 15 }, (_, s) => deriveSeed(5, BRACKET_TAG, s, 0)))
        const capped = runBracket(result, {
            drawCap: 1,
            run: fake((x, y, seed) => (opener.has(seed) ? x > y : null)).run,
        })
        expect(capped.sets[0]).toMatchObject({ id: 'UB1', winsA: 0, winsB: 1, draws: 2, winner: 8, decidedBy: 'wins' })
    })

    it('is deterministic: the same result and options give the same bracket on the real engine', () => {
        const real = runTournament(plan)
        const a = runBracket(real)
        const b = runBracket(real)
        expect(JSON.stringify(a)).toBe(JSON.stringify(b))
        expect(a.sets.length).toBeGreaterThanOrEqual(14)
        // a set ends at 3 wins, or one draw past the cap (5)
        expect(a.sets.every(s => Math.max(s.winsA, s.winsB) === 3 || s.draws === 6)).toBe(true)
        // its games come from the master seed: another one plays other games
        const reseeded = { ...real, config: { ...real.config, seed: 6 } }
        expect(JSON.stringify(runBracket(reseeded).sets)).not.toBe(JSON.stringify(a.sets))
    })

    it('takes the best-of from the options, and rejects an even one', () => {
        const bracket = runBracket(result, { run: fake(betterSeedWins).run, bestOf: 3 })
        expect(bracket.bestOf).toBe(3)
        expect(bracket.sets.every(s => s.winsA === 2 && s.games === 2)).toBe(true)
        expect(() => runBracket(result, { bestOf: 4 })).toThrow(/bestOf/)
        expect(() => runBracket(result, { drawCap: -1 })).toThrow(/drawCap/)
    })

    it('is skipped, saying why, when fewer than 8 entrants played', () => {
        const small = planTournament({ baseline, profiles: [ARCHETYPES.aggressive.profile, ARCHETYPES.bait.profile] })
        const tiny = summarize(
            small.config,
            pairList(4).map(([a, b], pair) => ({ pair, a, b, games: 2, winsA: 1, winsB: 1, draws: 0, firstWins: 1 })),
        )
        const { result: same, skipped } = withBracket(tiny)
        expect(same.bracket).toBeUndefined()
        expect(skipped).toMatch(/needs 8 entrants that played, the run has 4/)
        expect(() => runBracket(tiny)).toThrow(/needs 8/)
    })

    it('is recorded in the result JSON and listed in the report and the CLI text', () => {
        const { result: withIt } = withBracket(result, { run: fake(betterSeedWins).run })
        const json = JSON.parse(JSON.stringify(withIt)) as TournamentResult
        expect(json.bracket?.sets).toHaveLength(14)
        expect(json.bracket?.placements.map(p => p.place)).toEqual(['1st', '2nd', '3rd', '4th', '5th-6th', '7th-8th'])
        const report = formatReport(withIt, { date: '2026-11-09' })
        const section = report.split('## Bracket')[1].split('## Caveats')[0]
        const id = (n: number) => `${n} ${withIt.bracket!.seeds[n - 1].id}`
        for (const set of withIt.bracket!.sets)
            expect(section).toContain(`| ${set.id} | ${set.round} | ${id(set.a)} | ${id(set.b)} | 3-0 | 0 |`)
        expect(section).toContain(`| 1st | ${id(1)} |`)
        expect(section).toContain(`| 5th-6th | ${id(5)}, ${id(6)} |`)
        expect(formatBracket(withIt.bracket!)).toContain(`GF1  ${id(1)} v ${id(2)}  3-0  -> ${id(1)}`)
        // without a bracket the section says so
        expect(formatReport(result, { date: '2026-11-09', bracketSkipped: 'because' })).toContain('Not run: because.')
    })
})
