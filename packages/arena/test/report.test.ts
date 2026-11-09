import { describe, expect, it } from 'vitest'
import {
    ARCHETYPES,
    clampJobs,
    DEFAULT_JOBS,
    formatReport,
    formatTable,
    MAX_JOBS,
    mergeShards,
    pairList,
    planTournament,
    REPORT_SECTIONS,
    runShard,
    runTournament,
    summarize,
    type Baseline,
    type MatchFn,
    type MatchResult,
    type PairResult,
    percent,
    wilsonInterval,
} from '../src'
import { METEOR_LOADOUT, OTHER_LOADOUT } from './helpers'

const baseline: Baseline = {
    version: 'test',
    loadouts: [
        { rank: 1, loadout: METEOR_LOADOUT, dps: 40, dpsUnderPressure: 30 },
        { rank: 2, loadout: OTHER_LOADOUT, dps: 35, dpsUnderPressure: 31 },
    ],
}
const plan = planTournament({
    baseline,
    profiles: [ARCHETYPES.aggressive.profile, ARCHETYPES.bait.profile],
    games: 2,
    seed: 7,
})
const total = pairList(plan.config.entrants.length).length

/** A stand-in for runMatch: a deterministic winner from the seed, a draw one time in five. */
const run: MatchFn = ({ seed }): MatchResult => {
    const winner = seed % 5 === 0 ? 'draw' : seed % 2 === 0 ? 'a' : 'b'
    return {
        seed,
        winner,
        reason: winner === 'draw' ? 'timeout' : 'death',
        ticks: 1,
        hp: { a: 0, b: 0 },
        stats: {} as MatchResult['stats'],
        log: [],
    }
}
const options = { date: '2026-11-09', commit: 'abc1234' }

describe('clampJobs', () => {
    it('defaults to 4, keeps 1 to 4 and clamps anything higher to 4 with a warning', () => {
        expect(MAX_JOBS).toBe(4)
        expect(DEFAULT_JOBS).toBe(4)
        expect(clampJobs()).toEqual({ jobs: 4 })
        for (const jobs of [1, 2, 3, 4]) expect(clampJobs(jobs)).toEqual({ jobs })
        for (const jobs of [5, 9, 64]) {
            const clamped = clampJobs(jobs)
            expect(clamped.jobs).toBe(4)
            expect(clamped.warning).toContain(`--jobs ${jobs}`)
            expect(clamped.warning).toContain('using 4')
        }
    })

    it('rejects values that are not a positive integer', () => {
        for (const jobs of [0, -1, 1.5, NaN]) expect(() => clampJobs(jobs)).toThrow(/--jobs must be at least 1/)
    })
})

describe('time budget (stop)', () => {
    it('stops before the next pair and marks the result partial, with the pairs it played', () => {
        let asked = 0
        const result = runTournament(plan, run, () => asked++ >= 3)
        expect(result.partial).toEqual({ pairsPlayed: 3, pairsTotal: total, played: [0, 1, 2] })
        expect(result.games).toBe(3 * plan.config.games)
        expect(formatTable(result)).toContain(`PARTIAL: the time budget ended the run after 3 of ${total} pairs`)
    })

    it('leaves a run that never stops complete, byte-identical to one without a budget', () => {
        const budgeted = runTournament(plan, run, () => false)
        expect(budgeted.partial).toBeUndefined()
        expect(JSON.stringify(budgeted)).toBe(JSON.stringify(runTournament(plan, run)))
    })

    it('merges partial shards into a partial result, and still refuses a short shard that is not marked partial', () => {
        let asked = 0
        const stopped = runShard(plan, 1, 2, run, () => asked++ >= 1)
        expect(stopped.partial).toBe(true)
        expect(stopped.pairs).toHaveLength(1)
        const merged = mergeShards([runShard(plan, 0, 2, run), stopped])
        expect(merged.partial?.pairsPlayed).toBe(total / 2 + 1)
        expect(merged.partial?.played).toEqual([0, 1, 2, 3, 4, 5].filter(p => p % 2 === 0 || p === 1))
        const { partial: _, ...unmarked } = stopped
        expect(() => mergeShards([runShard(plan, 0, 2, run), unmarked])).toThrow(/does not hold exactly its pairs/)
        expect(() => summarize(plan.config, stopped.pairs)).toThrow(/is missing/)
    })
})

describe('formatReport', () => {
    const result = runTournament(plan, run)

    it('has the fixed sections, in order', () => {
        const text = formatReport(result, options)
        expect(text.startsWith('# Arena report: test\n')).toBe(true)
        expect([...text.matchAll(/^## (.+)$/gm)].map(m => m[1])).toEqual([...REPORT_SECTIONS])
    })

    it('puts version, seed, date, commit and entrants in the header', () => {
        const header = formatReport(result, options).split('## Dummy baseline')[0]
        expect(header).toContain('**Version:** `test`')
        expect(header).toContain('**Seed:** 7')
        expect(header).toContain('**Date:** 2026-11-09 (UTC)')
        expect(header).toContain('**Commit:** `abc1234`')
        expect(header).toContain('**Entrants:** 4 (2 loadouts x 2 profiles: aggressive, bait)')
        expect(header).toContain('**Status:** complete')
    })

    it('lists the baseline loadouts and every entrant, and a profile-by-profile matrix with wins/games', () => {
        const text = formatReport(result, options)
        expect(text).toContain('| L01 | Meteor')
        expect(text).toContain('| 40.0 | 30.0 |')
        for (const e of plan.config.entrants) expect(text).toContain(`| ${e.profile} |`)
        const matrix = text.split('## Matchup matrix')[1].split('## Caveats')[0]
        // aggressive against bait: 2 x 2 entrant pairs x 2 games
        expect(matrix).toMatch(/\| aggressive \| - \| \d+\.\d% \(\d+\/8\) \|/)
        expect(matrix).toMatch(/\| bait \| \d+\.\d% \(\d+\/8\) \| - \|/)
    })

    it('shows the win rate by general pair and with vs without Haste, over all profiles and per profile (#136)', () => {
        const text = formatReport(result, options)
        const section = text.split('## General pairs')[1].split('## Matchup matrix')[0]
        // METEOR_LOADOUT holds Haste + Blur, OTHER_LOADOUT Magic Eater + Temporal Shield
        const pooled = (has: (loadout: readonly string[]) => boolean, profile?: string) => {
            const own = result.ranking.filter(r => has(r.loadout) && (!profile || r.profile === profile))
            const wins = own.reduce((sum, r) => sum + r.wins, 0)
            const draws = own.reduce((sum, r) => sum + r.draws, 0)
            const games = own.reduce((sum, r) => sum + r.games, 0)
            return { entrants: own.length, wins, draws, games, ci: wilsonInterval(wins, games) }
        }
        const haste = (l: readonly string[]) => l.includes('SPELL_HASTE')
        const rows = [
            ['Haste + Blur', haste],
            ['Magic Eater + Temporal Shield', (l: readonly string[]) => !haste(l)],
            ['With Haste', haste],
            ['Without Haste', (l: readonly string[]) => !haste(l)],
        ] as const
        for (const [name, has] of rows) {
            const p = pooled(has)
            expect(section).toContain(
                `| ${name} | ${p.entrants} | ${p.wins} | ${p.draws} | ${p.games} | ${percent(p.wins / p.games)} | ${percent(p.ci.low)}-${percent(p.ci.high)} |`,
            )
        }
        // per profile: each cell is that profile's pooled rate with its interval
        const cell = (p: ReturnType<typeof pooled>) =>
            `${percent(p.wins / p.games)} (${percent(p.ci.low)}-${percent(p.ci.high)})`
        expect(section).toContain(
            `| Haste + Blur | ${cell(pooled(haste, 'aggressive'))} | ${cell(pooled(haste, 'bait'))} |`,
        )
        expect(section).toContain(
            `| Without Haste | ${cell(pooled(l => !haste(l), 'aggressive'))} | ${cell(pooled(l => !haste(l), 'bait'))} |`,
        )
        // the six pairs are listed Haste pairs first, whatever order the loadouts come in
        expect(section.indexOf('| Haste + Blur |')).toBeLessThan(section.indexOf('| Magic Eater + Temporal Shield |'))
    })

    it('depends on the date and commit only in the header: the same result gives the same tables', () => {
        const a = formatReport(result, options)
        const b = formatReport(result, { date: '2030-01-01' })
        expect(a).not.toBe(b)
        const tables = (text: string) => text.slice(text.indexOf('## Dummy baseline'))
        expect(tables(a)).toBe(tables(b))
        expect(formatReport(result, options)).toBe(a)
    })

    it('is the same for merged shards of any split as for the unsharded run', () => {
        const merged = mergeShards([2, 0, 1].map(i => runShard(plan, i, 3, run)))
        expect(formatReport(merged, options)).toBe(formatReport(result, options))
    })

    it('marks a partial run in the header and the caveats, and counts only played pairs in the matrix', () => {
        let asked = 0
        const partial = runTournament(plan, run, () => asked++ >= 2)
        const text = formatReport(partial, options)
        expect(text).toContain(`**Status:** PARTIAL: 2 of ${total} pairs played`)
        expect(text).toContain('- **Partial run.**')
        expect(text).not.toContain('This run is complete')
        const matrix = text.split('## Matchup matrix')[1].split('## Caveats')[0]
        // pairs 0 and 1 are (L01/aggressive, L01/bait) and (L01/aggressive, L02/aggressive): one cross-profile pair
        expect(matrix).toMatch(/\(\d+\/2\)/)
        expect(matrix).not.toContain('/8)')
        expect(formatReport(result, options)).toContain('This run is complete')
    })

    it('reports an empty partial run (budget used up before the first pair) without failing', () => {
        const empty = runTournament(plan, run, () => true)
        const text = formatReport(empty, options)
        expect(text).toContain(`PARTIAL: 0 of ${total} pairs played`)
        expect(text).toContain('Each entrant played 0 games')
    })
})

describe('partial runs: entrants with no games', () => {
    // only pair 5, (L02/aggressive, L02/bait), is played: the L01 entrants, whose ids sort first, have no games
    const only: PairResult = { pair: 5, a: 2, b: 3, games: 2, winsA: 2, winsB: 0, draws: 0, firstWins: 1 }
    const partial = summarize(plan.config, [only], true)

    it('ranks them after every entrant that played, even a 0% one', () => {
        expect(partial.ranking.map(r => r.id)).toEqual(['L02/aggressive', 'L02/bait', 'L01/aggressive', 'L01/bait'])
        expect(partial.ranking.map(r => r.rank)).toEqual([1, 2, 3, 4])
    })

    it('shows "no games" instead of a win rate or an interval, in the report and in the table', () => {
        const text = formatReport(partial, options)
        expect(text).toContain('| 3 | L01 | aggressive | 0 | 0 | 0 | no games | no games |')
        expect(text).toContain('| 1 | L02 | aggressive | 2 | 0 | 2 | 100.0% |')
        expect(text).toContain('Entrants with no games show "no games" and rank last')
        expect(formatTable(partial)).toMatch(/L01\s+aggressive\s+0\s+0\s+0\s+no games\s+no games/)
        expect(text).not.toContain('0.0%-100.0%')
    })
})

describe('merging with a missing shard', () => {
    const [s0, , s2] = [0, 1, 2].map(i => runShard(plan, i, 3, run))

    it('is refused by default and, with allowMissing, is partial and names the shard', () => {
        expect(() => mergeShards([s0, s2])).toThrow(/missing shard\(s\) 1\/3/)
        const merged = mergeShards([s2, s0], { allowMissing: true })
        expect(merged.partial).toMatchObject({ pairsPlayed: 4, pairsTotal: total, missingShards: ['1/3'] })
        const text = formatReport(merged, options)
        expect(text).toContain(`**Status:** PARTIAL: 4 of ${total} pairs played, missing shards 1/3`)
        expect(text).toContain('Shards 1/3 were missing')
    })

    it('changes nothing when no shard is missing', () => {
        const all = [0, 1, 2].map(i => runShard(plan, i, 3, run))
        expect(JSON.stringify(mergeShards(all, { allowMissing: true }))).toBe(JSON.stringify(runTournament(plan, run)))
    })
})
