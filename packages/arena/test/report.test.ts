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
