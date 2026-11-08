import { describe, expect, it } from 'vitest'
import {
    adaptProfile,
    ARCHETYPES,
    checkLoadout,
    deriveSeed,
    formatTable,
    DEFAULT_MAX_TICKS,
    mergeShards,
    pairList,
    parseBaseline,
    planTournament,
    playPair,
    runShard,
    runTournament,
    shardPairs,
    summarize,
    wilsonInterval,
    type Baseline,
    type MatchFn,
    type MatchResult,
    type TournamentPlan,
} from '../src'
import { METEOR_LOADOUT, OTHER_LOADOUT } from './helpers'

const baseline: Baseline = {
    version: 'test',
    loadouts: [
        { rank: 1, loadout: METEOR_LOADOUT, dps: 40, dpsUnderPressure: 30 },
        { rank: 2, loadout: OTHER_LOADOUT, dps: 35, dpsUnderPressure: 31 },
    ],
}
const profiles = [ARCHETYPES.aggressive.profile, ARCHETYPES.bait.profile]
// entrants, in order: 0 L01/aggressive, 1 L01/bait, 2 L02/aggressive, 3 L02/bait
const small = (extra: Partial<Parameters<typeof planTournament>[0]> = {}) =>
    planTournament({ baseline, profiles, games: 2, seed: 7, ...extra })

const fakeResult = (seed: number, winner: MatchResult['winner']): MatchResult => ({
    seed,
    winner,
    reason: winner === 'draw' ? 'timeout' : 'death',
    ticks: 1,
    hp: { a: 0, b: 0 },
    stats: {} as MatchResult['stats'],
    log: [],
})

/** A stand-in for runMatch that decides the winner from the entrants' indexes in `plan` and the call's seed. */
const fake = (plan: TournamentPlan, decide: (a: number, b: number, seed: number) => 'a' | 'b' | 'draw'): MatchFn => {
    const index = (name: string, loadout: readonly string[]) =>
        plan.config.entrants.findIndex(e => e.profile === name && e.loadout.join() === loadout.join())
    return ({ seed, a, b }) => fakeResult(seed, decide(index(a.name, a.loadout), index(b.name, b.loadout), seed))
}

describe('entrants and pairs', () => {
    it('crosses the top loadouts with the profiles, mirror matches included, never an entrant with itself', () => {
        const { config } = small()
        expect(config.entrants.map(e => e.id)).toEqual(['L01/aggressive', 'L01/bait', 'L02/aggressive', 'L02/bait'])
        const pairs = pairList(config.entrants.length)
        expect(pairs).toHaveLength(6)
        // same loadout, different profile
        expect(pairs).toContainEqual([0, 1])
        expect(pairs).toContainEqual([2, 3])
        // same profile, different loadout
        expect(pairs).toContainEqual([0, 2])
        expect(pairs.every(([a, b]) => a < b)).toBe(true)
        expect(new Set(pairs.map(p => p.join())).size).toBe(6)
    })

    it('takes the top 8 by default', () => {
        expect(small().config.top).toEqual({ requested: 8, used: 2 })
    })

    it('clamps --top to the table and reports it', () => {
        expect(small({ top: 99 }).config.top).toEqual({ requested: 99, used: 2 })
        const one = small({ top: 1 })
        expect(one.config.top).toEqual({ requested: 1, used: 1 })
        expect(one.config.entrants.map(e => e.loadoutRank)).toEqual([1, 1])
    })

    it('rejects odd or tiny game counts, bad seeds, repeated profiles and a single entrant', () => {
        expect(() => small({ games: 3 })).toThrow(/even/)
        expect(() => small({ games: 0 })).toThrow(/even/)
        expect(() => small({ seed: -1 })).toThrow(/seed/)
        expect(() => small({ top: 0 })).toThrow(/top/)
        expect(() => small({ profiles: [profiles[0], profiles[0]] })).toThrow(/twice/)
        expect(() => small({ top: 1, profiles: [profiles[0]] })).toThrow(/two entrants/)
    })

    it('adapts a profile to a loadout without its spells and keeps one that fits', () => {
        const aggressive = ARCHETYPES.aggressive.profile
        expect(adaptProfile(aggressive, ARCHETYPES.aggressive.loadout)).toEqual(aggressive)
        // bait: no Meteor, Haste or Blur on OTHER_LOADOUT, so Fireball is all that is left of its rotation
        const adapted = adaptProfile(ARCHETYPES.bait.profile, OTHER_LOADOUT)
        expect(adapted.rotation.map(r => r.spell)).toEqual(['SPELL_FIREBALL'])
        // its fake cast of Meteor moves to the longest cast on the loadout (Ignite, 1.6 s)
        expect(adapted.fakeCast).toEqual({ ...ARCHETYPES.bait.profile.fakeCast, spell: 'SPELL_IGNITE' })
        expect(() => checkLoadout(adapted, OTHER_LOADOUT)).not.toThrow()
        // nothing of the rotation is left: the loadout's own Fire spells, in slot order
        const meteorOnly = { ...ARCHETYPES.bait.profile, rotation: [{ spell: 'SPELL_METEOR' as const, when: [] }] }
        expect(adaptProfile(meteorOnly, OTHER_LOADOUT).rotation.map(r => r.spell)).toEqual(OTHER_LOADOUT.slice(0, 4))
    })
})

describe('games', () => {
    it('swaps sides: each entrant of a pair is player1 in exactly half the games, with a seed per game', () => {
        const plan = small({ games: 6 })
        const calls: { pair: string; first: string; seed: number }[] = []
        const run: MatchFn = ({ seed, a, b }) => {
            calls.push({
                pair: [a.name + a.loadout[0], b.name + b.loadout[0]].sort().join('|'),
                first: a.name + a.loadout[0],
                seed,
            })
            return fakeResult(seed, 'a')
        }
        for (let pair = 0; pair < 6; pair++) playPair(plan, pair, run)
        expect(calls).toHaveLength(36)
        for (let pair = 0; pair < 6; pair++) {
            const mine = calls.slice(pair * 6, pair * 6 + 6)
            const counts = new Map<string, number>()
            for (const c of mine) counts.set(c.first, (counts.get(c.first) ?? 0) + 1)
            expect([...counts.values()]).toEqual([3, 3])
            expect(mine.map(c => c.seed)).toEqual([0, 1, 2, 3, 4, 5].map(g => deriveSeed(7, pair, g)))
            // alternate games: the two entrants take turns
            expect(mine[0].first).toBe(mine[2].first)
            expect(mine[0].first).not.toBe(mine[1].first)
        }
        expect(new Set(calls.map(c => c.seed)).size).toBe(36)
    })

    it('records the first-mover edge: a side-a win is a player1 win whoever that entrant is', () => {
        const plan = small({ games: 4 })
        const always = (winner: 'a' | 'b') => playPair(plan, 0, ({ seed }) => fakeResult(seed, winner))
        expect(always('a')).toMatchObject({ winsA: 2, winsB: 2, draws: 0, firstWins: 4 })
        expect(always('b')).toMatchObject({ winsA: 2, winsB: 2, draws: 0, firstWins: 0 })
    })

    it('plays the real engine through the runner with the time cap from the plan', () => {
        const plan = small({ games: 2, maxTicks: 40 })
        const seen: number[] = []
        const result = playPair(plan, 0, options => {
            seen.push(options.maxTicks ?? -1, options.log === false ? 1 : 0)
            return fakeResult(options.seed, 'draw')
        })
        expect(seen).toEqual([40, 1, 40, 1])
        expect(result.draws).toBe(2)
        expect(small().config.maxTicks).toBe(DEFAULT_MAX_TICKS)
    })
})

describe('scoring', () => {
    // 2 loadouts x 2 profiles, 4 games per pair. The lower entrant index always wins, except pair (2, 3), which is
    // drawn four times, and the first game of pair (1, 2), which is a draw.
    const plan = small({ games: 4 })
    const decide = (a: number, b: number, seed: number) => {
        const [low, high] = [Math.min(a, b), Math.max(a, b)]
        if (low === 2 && high === 3) return 'draw'
        if (low === 1 && high === 2 && seed === deriveSeed(7, 3, 0)) return 'draw'
        return a < b ? 'a' : 'b'
    }

    it('counts only wins: a draw and a loss both score nothing', () => {
        // pair indexes: 0 (0,1) 1 (0,2) 2 (0,3) 3 (1,2) 4 (1,3) 5 (2,3)
        const result = runTournament(plan, fake(plan, decide))
        const [first, second, third, fourth] = result.ranking
        expect([first.id, first.wins, first.draws, first.losses, first.games, first.winRate]).toEqual([
            'L01/aggressive',
            12,
            0,
            0,
            12,
            1,
        ])
        // beats (2) 3 times (one game drawn) and (3) 4 times: 7 of 12
        expect([second.id, second.wins, second.draws, second.losses, second.games, second.winRate]).toEqual([
            'L01/bait',
            7,
            1,
            4,
            12,
            7 / 12,
        ])
        // never wins: draws pair (2,3) and one game vs entrant 1; the tie with entrant 3 is broken by id
        expect([third.id, third.wins, third.draws, third.losses]).toEqual(['L02/aggressive', 0, 5, 7])
        expect([fourth.id, fourth.wins, fourth.draws, fourth.losses]).toEqual(['L02/bait', 0, 4, 8])
        expect(result.ranking.map(r => r.rank)).toEqual([1, 2, 3, 4])
    })

    it('prints the number of matches played in the header', () => {
        const result = runTournament(plan, fake(plan, decide))
        expect(formatTable(result).split('\n')[0]).toMatch(/^24 matches, 4 entrants, 4 games per pair/)
    })

    it('reports the matrix of wins per pair, and the interval of a small sample', () => {
        const result = runTournament(plan, fake(plan, decide))
        expect(result.matrix['L01/bait']['L02/aggressive']).toBe(3)
        expect(result.matrix['L02/aggressive']['L01/bait']).toBe(0)
        expect(result.matrix['L01/aggressive']['L01/aggressive']).toBe(0)
        // 4 + 4 + 4 + 3 + 4 + 0 wins out of 24 game results, counted from both sides
        const total = Object.values(result.matrix).flatMap(row => Object.values(row))
        expect(total.reduce((a, b) => a + b, 0)).toBe(19)
        expect(result.games).toBe(24)
        const perfect = result.ranking[0].ci95
        expect(perfect.high).toBe(1)
        expect(perfect.low).toBeGreaterThan(0.7) // 12 of 12 is not "certainly 100%"
        expect(perfect.low).toBeLessThan(0.8)
    })

    it('ranks by win rate even when the games played differ', () => {
        const config = small().config
        const pairs = pairList(4).map(([a, b], pair) => ({
            pair,
            a,
            b,
            games: 2,
            winsA: 0,
            winsB: 0,
            draws: 2,
            firstWins: 0,
        }))
        const ranked = summarize(
            config,
            pairs.map(p => (p.pair === 5 ? { ...p, winsA: 1, draws: 1 } : p)),
        )
        expect(ranked.ranking[0].id).toBe('L02/aggressive')
    })

    it('rejects an incomplete or inconsistent set of pairs', () => {
        const { config } = small()
        const full = pairList(4).map(([a, b], pair) => ({
            pair,
            a,
            b,
            games: 2,
            winsA: 1,
            winsB: 1,
            draws: 0,
            firstWins: 1,
        }))
        expect(() => summarize(config, full.slice(1))).toThrow(/missing/)
        expect(() => summarize(config, [...full, full[0]])).toThrow(/twice/)
        expect(() => summarize(config, [{ ...full[0], winsA: 2 }, ...full.slice(1)])).toThrow(/inconsistent/)
    })
})

describe('sharding and determinism', () => {
    it('shards cover the pair list exactly once for any count, empty shards included', () => {
        for (const count of [1, 2, 4, 6, 9]) {
            const all = Array.from({ length: count }, (_, i) => shardPairs(6, i, count)).flat()
            expect(all.sort()).toEqual([0, 1, 2, 3, 4, 5])
        }
        expect(shardPairs(6, 1, 4)).toEqual([1, 5])
        expect(() => shardPairs(6, 4, 4)).toThrow(/shard/)
    })

    it('merging the shards of any split equals the unsharded result, whatever order they come in', () => {
        const plan = small()
        const whole = runTournament(plan)
        for (const count of [2, 4, 8]) {
            const shards = Array.from({ length: count }, (_, i) => runShard(plan, i, count)).reverse()
            const merged = mergeShards(JSON.parse(JSON.stringify(shards)))
            expect(merged).toEqual(whole)
            expect(JSON.stringify(merged)).toBe(JSON.stringify(whole))
        }
    })

    it('refuses to merge missing, repeated or foreign shards', () => {
        const plan = small()
        const [s0, s1] = [runShard(plan, 0, 2), runShard(plan, 1, 2)]
        expect(() => mergeShards([s0])).toThrow(/missing shard/)
        expect(() => mergeShards([s0, s0])).toThrow(/twice/)
        expect(() => mergeShards([s0, runShard(small({ seed: 8 }), 1, 2)])).toThrow(/different tournaments/)
        expect(() => mergeShards([s0, { ...s1, pairs: s1.pairs.slice(1) }])).toThrow(/exactly its pairs/)
        expect(() => mergeShards([])).toThrow(/no shards/)
    })

    it('gives the same table for the same inputs, and another for another seed', () => {
        expect(runTournament(small())).toEqual(runTournament(small()))
        const plan = small({ games: 6 })
        // winners decided by the match seed alone: a stand-in whose outcome depends on nothing else
        const bySeed =
            (offset: number): MatchFn =>
            ({ seed }) =>
                fakeResult(seed, (seed + offset) % 3 === 0 ? 'a' : (seed + offset) % 3 === 1 ? 'b' : 'draw')
        expect(runTournament(plan, bySeed(0))).toEqual(runTournament(plan, bySeed(0)))
        const other = small({ games: 6, seed: 8 })
        expect(runTournament(other, bySeed(0)).ranking).not.toEqual(runTournament(plan, bySeed(0)).ranking)
    })
})

describe('wilsonInterval', () => {
    it('is wide for few games, stays inside [0, 1] and matches a worked example', () => {
        expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 })
        expect(wilsonInterval(5, 10)).toEqual({ low: 0.2366, high: 0.7634 })
        expect(wilsonInterval(0, 4).low).toBe(0)
        expect(wilsonInterval(4, 4).high).toBe(1)
        const wide = wilsonInterval(2, 4)
        const narrow = wilsonInterval(200, 400)
        expect(wide.high - wide.low).toBeGreaterThan(narrow.high - narrow.low)
    })
})

describe('parseBaseline', () => {
    const file = (loadouts: unknown) => ({ version: 'v', loadouts })
    const entry = (rank: number, loadout: unknown = METEOR_LOADOUT) => ({ rank, loadout, dps: 1, dpsUnderPressure: 1 })

    it('accepts a ranked table of distinct valid loadouts for its version', () => {
        const parsed = parseBaseline(file([entry(1), entry(2, OTHER_LOADOUT)]), 'v')
        expect(parsed.loadouts.map(l => l.rank)).toEqual([1, 2])
    })

    it('names what is wrong', () => {
        expect(() => parseBaseline(file([entry(1)]), 'w')).toThrow(/version/)
        expect(() => parseBaseline(file([]))).toThrow(/loadouts/)
        expect(() => parseBaseline(file([entry(2)]))).toThrow(/loadouts\[0\]\.rank/)
        expect(() => parseBaseline(file([entry(1), entry(2)]))).toThrow(/listed twice/)
        expect(() => parseBaseline(file([entry(1, ['SPELL_FIREBALL'])]))).toThrow(/valid loadout/)
        expect(() => parseBaseline({ ...file([entry(1)]), extra: 1 })).toThrow(/unknown key/)
    })
})
