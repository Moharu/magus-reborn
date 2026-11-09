import { deriveSeed } from './prng'
import { runMatch } from './runner'
import { entrantMakers, type MatchFn, type TournamentResult } from './tournament'

/**
 * The top-8 double-elimination bracket (#136), played after the round-robin. The round-robin's top 8 (by win rate,
 * entrants that played no game left out) are seeded by rank, 1 the best. Every set is a best-of-`bestOf`; the bracket:
 *
 *   upper round 1   UB1: 1v8, UB2: 4v5, UB3: 2v7, UB4: 3v6
 *   upper semis     UB5: W(UB1) v W(UB2), UB6: W(UB3) v W(UB4)
 *   lower round 1   LB1: L(UB1) v L(UB2), LB2: L(UB3) v L(UB4)        (losers: 7th-8th)
 *   lower round 2   LB3: W(LB1) v L(UB6), LB4: W(LB2) v L(UB5)        (losers: 5th-6th; crossed, so no early rematch)
 *   upper final     UB7: W(UB5) v W(UB6)
 *   lower semi      LB5: W(LB3) v W(LB4)                              (loser: 4th)
 *   lower final     LB6: W(LB5) v L(UB7)                              (loser: 3rd)
 *   grand final     GF1: W(UB7) v W(LB6), and GF2 (the bracket reset) only if the lower-bracket winner takes GF1.
 *
 * In a set, the better seed is `player1` (acts first within a tick) in the set's even games and the other entrant in
 * its odd ones, drawn games included, so each moves first in half the games, give or take one. A draw counts for
 * nobody and the game is replayed, up to `drawCap` draws in a set: on one more draw the set ends, won by whoever has
 * more wins, or by the better seed on equal wins. Game `g` of set `s` (in the order above) is seeded
 * `deriveSeed(seed, BRACKET_TAG, s, g)` from the tournament's master seed, so the bracket is a pure function of the
 * round-robin result and the options.
 */

export const BRACKET_SIZE = 8
export const DEFAULT_BEST_OF = 5
/** Drawn games replayed per set at most; one more ends the set (see the module comment). */
export const DEFAULT_DRAW_CAP = 5
/** Domain tag of the bracket's match seeds: `deriveSeed(seed, BRACKET_TAG, set, game)`. */
export const BRACKET_TAG = 0xb7ac_e7

export const PLACES = ['1st', '2nd', '3rd', '4th', '5th-6th', '7th-8th'] as const
export type Place = (typeof PLACES)[number]

export interface BracketOptions {
    /** Games a set is the best of: odd and at least 1 (default 5). */
    readonly bestOf?: number
    /** Drawn games replayed per set at most (default 5). */
    readonly drawCap?: number
    /** Only for tests. */
    readonly run?: MatchFn
}

export interface BracketSeed {
    /** 1 to 8. */
    readonly seed: number
    /** `config.entrants` id. */
    readonly id: string
    /** Round-robin rank and win rate. */
    readonly rank: number
    readonly winRate: number
}

export interface BracketSet {
    /** `UB1`, ..., `LB6`, `GF1`, `GF2`. */
    readonly id: string
    readonly round: string
    /** Seeds: `a` is the better one, `player1` in the set's even games. */
    readonly a: number
    readonly b: number
    readonly winsA: number
    readonly winsB: number
    readonly draws: number
    /** Games played, draws included. */
    readonly games: number
    readonly winner: number
    readonly loser: number
    /** `seed`: the draw cap ended the set level on wins, and the better seed took it. */
    readonly decidedBy: 'wins' | 'seed'
}

export interface BracketResult {
    readonly bestOf: number
    readonly drawCap: number
    readonly seeds: readonly BracketSeed[]
    /** In play order. */
    readonly sets: readonly BracketSet[]
    /** Best first; each place's seeds best seed first. */
    readonly placements: readonly { readonly place: Place; readonly seeds: readonly number[] }[]
    /** Whether the grand final went to a second set. */
    readonly reset: boolean
}

/** The round labels of the sets, by id. */
const ROUNDS: Record<string, string> = {
    UB1: 'Upper round 1',
    UB2: 'Upper round 1',
    UB3: 'Upper round 1',
    UB4: 'Upper round 1',
    UB5: 'Upper semifinal',
    UB6: 'Upper semifinal',
    LB1: 'Lower round 1',
    LB2: 'Lower round 1',
    LB3: 'Lower round 2',
    LB4: 'Lower round 2',
    UB7: 'Upper final',
    LB5: 'Lower semifinal',
    LB6: 'Lower final',
    GF1: 'Grand final',
    GF2: 'Grand final (reset)',
}

/** The seeds the bracket would take from `result`: the top 8 that played, or fewer when the run had fewer. */
export const bracketSeeds = (result: TournamentResult): BracketSeed[] =>
    result.ranking
        .filter(r => r.games > 0)
        .slice(0, BRACKET_SIZE)
        .map((r, i) => ({ seed: i + 1, id: r.id, rank: r.rank, winRate: r.winRate }))

/**
 * Plays the bracket on `result`'s top 8. Throws when fewer than 8 entrants played (a tiny run): the caller skips it.
 */
export const runBracket = (result: TournamentResult, options: BracketOptions = {}): BracketResult => {
    const { bestOf = DEFAULT_BEST_OF, drawCap = DEFAULT_DRAW_CAP, run = runMatch } = options
    if (!(Number.isInteger(bestOf) && bestOf >= 1 && bestOf % 2 === 1))
        throw new Error(`bestOf must be an odd positive integer, got ${bestOf}`)
    if (!(Number.isInteger(drawCap) && drawCap >= 0))
        throw new Error(`drawCap must be a non-negative integer, got ${drawCap}`)
    const seeds = bracketSeeds(result)
    if (seeds.length < BRACKET_SIZE)
        throw new Error(`the bracket needs ${BRACKET_SIZE} entrants that played, the run has ${seeds.length}`)
    const { config } = result
    const makers = entrantMakers(config)
    const index = new Map(config.entrants.map((e, i) => [e.id, i]))
    const make = (seed: number) => makers[index.get(seeds[seed - 1].id)!]()
    const need = (bestOf + 1) / 2
    const sets: BracketSet[] = []

    const play = (id: string, x: number, y: number): BracketSet => {
        const [a, b] = x < y ? [x, y] : [y, x]
        const setIndex = sets.length
        let winsA = 0
        let winsB = 0
        let draws = 0
        let games = 0
        let decidedBy: BracketSet['decidedBy'] = 'wins'
        while (winsA < need && winsB < need) {
            const aFirst = games % 2 === 0
            const match = run({
                seed: deriveSeed(config.seed, BRACKET_TAG, setIndex, games),
                a: make(aFirst ? a : b),
                b: make(aFirst ? b : a),
                maxTicks: config.maxTicks,
                log: false,
            })
            games++
            if (match.winner === 'draw') {
                draws++
                if (draws > drawCap) {
                    decidedBy = winsA === winsB ? 'seed' : 'wins'
                    break
                }
            } else if ((match.winner === 'a') === aFirst) winsA++
            else winsB++
        }
        // ended by the cap: more wins, else the better seed (a)
        const aWon = winsA >= need || (winsB < need && winsA >= winsB)
        const set: BracketSet = {
            id,
            round: ROUNDS[id],
            a,
            b,
            winsA,
            winsB,
            draws,
            games,
            winner: aWon ? a : b,
            loser: aWon ? b : a,
            decidedBy,
        }
        sets.push(set)
        return set
    }

    const ub1 = play('UB1', 1, 8)
    const ub2 = play('UB2', 4, 5)
    const ub3 = play('UB3', 2, 7)
    const ub4 = play('UB4', 3, 6)
    const ub5 = play('UB5', ub1.winner, ub2.winner)
    const ub6 = play('UB6', ub3.winner, ub4.winner)
    const lb1 = play('LB1', ub1.loser, ub2.loser)
    const lb2 = play('LB2', ub3.loser, ub4.loser)
    const lb3 = play('LB3', lb1.winner, ub6.loser)
    const lb4 = play('LB4', lb2.winner, ub5.loser)
    const ub7 = play('UB7', ub5.winner, ub6.winner)
    const lb5 = play('LB5', lb3.winner, lb4.winner)
    const lb6 = play('LB6', lb5.winner, ub7.loser)
    const gf1 = play('GF1', ub7.winner, lb6.winner)
    const reset = gf1.winner === lb6.winner
    const final = reset ? play('GF2', ub7.winner, lb6.winner) : gf1

    const sorted = (...list: number[]) => [...list].sort((x, y) => x - y)
    return {
        bestOf,
        drawCap,
        seeds,
        sets,
        placements: [
            { place: '1st', seeds: [final.winner] },
            { place: '2nd', seeds: [final.loser] },
            { place: '3rd', seeds: [lb6.loser] },
            { place: '4th', seeds: [lb5.loser] },
            { place: '5th-6th', seeds: sorted(lb3.loser, lb4.loser) },
            { place: '7th-8th', seeds: sorted(lb1.loser, lb2.loser) },
        ],
        reset,
    }
}

/** `result` with its bracket, or as it is (and why not) when fewer than 8 entrants played. */
export const withBracket = (
    result: TournamentResult,
    options: BracketOptions = {},
): { result: TournamentResult; skipped?: string } => {
    const seeds = bracketSeeds(result)
    if (seeds.length < BRACKET_SIZE)
        return {
            result,
            skipped: `the bracket needs ${BRACKET_SIZE} entrants that played, the run has ${seeds.length}`,
        }
    return { result: { ...result, bracket: runBracket(result, options) } }
}
