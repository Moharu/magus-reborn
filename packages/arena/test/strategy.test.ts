import { FIXED_SPELL, isValidLoadout, type SpellId } from '@magus/engine'
import { describe, expect, it } from 'vitest'
import {
    ARCHETYPES,
    DEFAULT_STRATEGY_GAMES,
    DEFAULT_STRATEGY_SEEDS,
    derivedSeed,
    formatStrategyReport,
    formatStrategyTable,
    jobAt,
    jobCount,
    matchupList,
    mergeStrategyShards,
    parseBaseline,
    parseFireSet,
    planStrategy,
    runStrategy,
    runStrategyShard,
    STRATEGY_GENERAL_PAIRS,
    STRATEGY_REPORT_SECTIONS,
    summarizeStrategy,
    wilsonInterval,
    type Baseline,
    type Entrant,
    type MatchFn,
    type MatchResult,
    type StrategyResult,
} from '../src'
import baselineJson from '../baselines/reborn-0.4.1.json'
import { METEOR_LOADOUT, OTHER_LOADOUT } from './helpers'

const baseline: Baseline = {
    version: 'test',
    loadouts: [
        { rank: 1, loadout: METEOR_LOADOUT, dps: 40, dpsUnderPressure: 30 },
        { rank: 2, loadout: OTHER_LOADOUT, dps: 35, dpsUnderPressure: 31 },
    ],
}
const FIRE_METEOR = METEOR_LOADOUT.slice(0, 4)
const FIRE_OTHER = OTHER_LOADOUT.slice(0, 4)
const profiles = [ARCHETYPES.aggressive.profile, ARCHETYPES.bait.profile, ARCHETYPES.defensive.profile]

const small = { baseline, profiles, seeds: 2, games: 4, seed: 7 }

/** A stand-in for runMatch: a deterministic winner from the seed, a draw one time in five. */
const fake: MatchFn = ({ seed }): MatchResult => {
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

describe('strategy setups (#137)', () => {
    it('gives 6 general pairs per Fire set, Counterspell always in, every loadout valid', () => {
        const { config } = planStrategy({ ...small, fireSets: [FIRE_METEOR, FIRE_OTHER] })
        expect(config.setups).toHaveLength(12)
        for (const [fire, spells] of [FIRE_METEOR, FIRE_OTHER].entries()) {
            const own = config.setups.filter(s => s.fireSet === fire)
            expect(own.map(s => s.id)).toEqual(
                [
                    'haste+blur',
                    'haste+magic-eater',
                    'haste+temporal-shield',
                    'blur+magic-eater',
                    'blur+temporal-shield',
                    'magic-eater+temporal-shield',
                ].map(pair => `F${fire + 1}/${pair}`),
            )
            for (const setup of own) {
                expect(isValidLoadout(setup.loadout)).toBe(true)
                expect(setup.loadout.slice(0, 4)).toEqual(spells)
                expect(setup.loadout[4]).toBe(FIXED_SPELL)
                expect(setup.loadout.slice(5)).toEqual(setup.pair)
            }
            // all 6 unordered pairs of the four non-Counterspell generals, each once
            const pairs = own.map(s => [...s.pair].sort().join('+'))
            expect(new Set(pairs).size).toBe(6)
            const generals = new Set(own.flatMap(s => s.pair))
            expect([...generals].sort()).toEqual(
                ['SPELL_BLUR', 'SPELL_HASTE', 'SPELL_MAGIC_EATER', 'SPELL_TEMPORAL_SHIELD'].sort(),
            )
        }
        expect(STRATEGY_GENERAL_PAIRS).toHaveLength(6)
    })

    it('defaults to the best Fire set of the dummy baseline: that of rank 1', () => {
        const { config } = planStrategy(small)
        expect(config.fireSets).toEqual([
            { spells: FIRE_METEOR, source: 'baseline', baseline: { rank: 1, dps: 40, dpsUnderPressure: 30 } },
        ])
        expect(config.setups).toHaveLength(6)
        // the shipped table: its best set, and this is not a hand-picked one
        const shipped = parseBaseline(baselineJson)
        expect(planStrategy({ ...small, baseline: shipped }).config.fireSets[0].spells).toEqual(
            shipped.loadouts[0].loadout.slice(0, 4),
        )
    })

    it('--fire-set overrides the default, and several sets give several groups of 6 setups', () => {
        const one = planStrategy({ ...small, fireSets: [FIRE_OTHER] })
        expect(one.config.fireSets).toEqual([
            { spells: FIRE_OTHER, source: 'override', baseline: { rank: 2, dps: 35, dpsUnderPressure: 31 } },
        ])
        expect(one.config.setups.every(s => s.loadout.slice(0, 4).join() === FIRE_OTHER.join())).toBe(true)
        const unknown = planStrategy({
            ...small,
            fireSets: [['SPELL_FIREBALL', 'SPELL_IGNITE', 'SPELL_METEOR', 'SPELL_AFTERBURN']],
        })
        expect(unknown.config.fireSets[0]).not.toHaveProperty('baseline')
    })

    it('parses --fire-set values as ids or short names, and rejects anything else', () => {
        expect(parseFireSet('fireball,ignite,combustion,meteor')).toEqual([
            'SPELL_FIREBALL',
            'SPELL_IGNITE',
            'SPELL_COMBUSTION',
            'SPELL_METEOR',
        ])
        expect(parseFireSet('SPELL_FIREBALL, Living-Bomb, SPELL_IGNITE, afterburn')).toEqual([
            'SPELL_FIREBALL',
            'SPELL_LIVING_BOMB',
            'SPELL_IGNITE',
            'SPELL_AFTERBURN',
        ])
        expect(() => parseFireSet('fireball,ignite,combustion')).toThrow(/needs 4/)
        expect(() => parseFireSet('fireball,ignite,combustion,nonsense')).toThrow(/unknown spell "nonsense"/)
        expect(() => parseFireSet('fireball,fireball,ignite,meteor')).toThrow(/four distinct/)
        // a general spell is not a Fire spell
        expect(() => parseFireSet('fireball,ignite,meteor,haste')).toThrow(/four distinct/)
    })

    it('rejects bad options', () => {
        expect(() => planStrategy({ ...small, profiles: [profiles[0]] })).toThrow(/two profiles/)
        expect(() => planStrategy({ ...small, profiles: [profiles[0], profiles[0]] })).toThrow(/listed twice/)
        expect(() => planStrategy({ ...small, games: 3 })).toThrow(/even/)
        expect(() => planStrategy({ ...small, seeds: 0 })).toThrow(/seeds/)
        expect(() => planStrategy({ ...small, seed: -1 })).toThrow(/seed/)
        expect(() => planStrategy({ ...small, fireSets: [] })).toThrow(/at least one Fire set/)
        expect(() => planStrategy({ ...small, fireSets: [FIRE_METEOR, [...FIRE_METEOR].reverse()] })).toThrow(
            /listed twice/,
        )
        expect(() => planStrategy({ ...small, fireSets: [['SPELL_FIREBALL']] })).toThrow(/not a valid Fire set/)
    })

    it('defaults to about +/-3% in the widest cell', () => {
        const games = DEFAULT_STRATEGY_SEEDS * DEFAULT_STRATEGY_GAMES
        const { low, high } = wilsonInterval(games / 2, games)
        expect((high - low) / 2).toBeGreaterThan(0.029)
        expect((high - low) / 2).toBeLessThan(0.031)
        expect(DEFAULT_STRATEGY_GAMES % 2).toBe(0)
    })
})

describe('strategy matchups (#137)', () => {
    it('every profile plays every profile on every setup, itself included', () => {
        expect(matchupList(3)).toEqual([
            [0, 0],
            [0, 1],
            [0, 2],
            [1, 1],
            [1, 2],
            [2, 2],
        ])
        const { config } = planStrategy({ ...small, fireSets: [FIRE_METEOR, FIRE_OTHER] })
        expect(jobCount(config)).toBe(12 * 6 * 2)
        const result = runStrategy(planStrategy({ ...small, fireSets: [FIRE_METEOR, FIRE_OTHER] }), fake)
        expect(result.cells).toHaveLength(12 * 6)
        for (const setup of config.setups) {
            const own = result.cells.filter(c => c.setup === setup.id)
            expect(own.map(c => `${c.a}/${c.b}`)).toEqual([
                'aggressive/aggressive',
                'aggressive/bait',
                'aggressive/defensive',
                'bait/bait',
                'bait/defensive',
                'defensive/defensive',
            ])
            // seeds x games per cell, every game counted once
            for (const c of own) {
                expect(c.games).toBe(2 * 4)
                expect(c.winsA + c.winsB + c.draws).toBe(c.games)
            }
        }
    })

    it('every game is a true mirror: both players get the setup loadout, and the sides alternate', () => {
        const plan = planStrategy({ ...small, fireSets: [FIRE_METEOR, FIRE_OTHER] })
        const seen: { a: Entrant; b: Entrant }[] = []
        const spy: MatchFn = options => {
            seen.push({ a: options.a, b: options.b })
            return fake(options)
        }
        runStrategy(plan, spy)
        expect(seen).toHaveLength(jobCount(plan.config) * plan.config.games)
        let game = 0
        for (let job = 0; job < jobCount(plan.config); job++) {
            const { setup, a, b } = jobAt(plan.config, job)
            const { loadout } = plan.config.setups[setup]
            for (let g = 0; g < plan.config.games; g++, game++) {
                const { a: first, b: second } = seen[game]
                // the same loadout on both sides, and it is the setup's
                expect(first.loadout).toEqual(loadout)
                expect(second.loadout).toEqual(first.loadout)
                // the profile of each side: a first on even games, b first on odd ones
                const names = [first.name, second.name]
                const aName = plan.make[setup][a]().name
                const bName = plan.make[setup][b]().name
                expect(names).toEqual(g % 2 === 0 ? [aName, bName] : [bName, aName])
            }
        }
    })

    it('a profile is built for the mirror loadout it plays, never the loadout of another setup', () => {
        const plan = planStrategy({ ...small, fireSets: [FIRE_METEOR, FIRE_OTHER] })
        plan.config.setups.forEach((setup, s) => {
            for (const make of plan.make[s]) expect(make().loadout).toEqual(setup.loadout)
        })
    })

    it('each profile is player1 in exactly half of every job', () => {
        const plan = planStrategy(small)
        let first = 0
        let second = 0
        const count: MatchFn = options => {
            if (options.a.name === 'aggressive' && options.b.name === 'bait') first++
            if (options.a.name === 'bait' && options.b.name === 'aggressive') second++
            return fake(options)
        }
        runStrategy(plan, count)
        // 6 setups x 2 seeds x 4 games, half each way
        expect(first).toBe(6 * 2 * 2)
        expect(second).toBe(first)
    })
})

describe('strategy determinism (#137)', () => {
    const plan = (seed: number) => planStrategy({ ...small, seed, fireSets: [FIRE_METEOR] })

    it('gives an identical result for the same seed, on the real engine', () => {
        const run = (seed: number) => JSON.stringify(runStrategy(planStrategy({ ...small, seeds: 1, games: 2, seed })))
        expect(run(3)).toBe(run(3))
        expect(run(3)).not.toBe(run(4))
    })

    it('derives every match seed from the master seed, the job and the game', () => {
        const seeds: number[] = []
        const record: MatchFn = options => {
            seeds.push(options.seed)
            return fake(options)
        }
        runStrategy(plan(7), record)
        runStrategy(plan(7), record)
        const half = seeds.length / 2
        expect(seeds.slice(0, half)).toEqual(seeds.slice(half))
        expect(new Set(seeds.slice(0, half)).size).toBe(half)
        const other: number[] = []
        runStrategy(plan(8), options => (other.push(options.seed), fake(options)))
        expect(other).not.toEqual(seeds.slice(0, half))
        const { config } = plan(7)
        expect(derivedSeed(config, 0, 0, 0)).not.toBe(derivedSeed(config, 0, 0, 1))
        expect(derivedSeed(config, 0, 0, 0)).not.toBe(derivedSeed(config, 0, 1, 0))
        expect(derivedSeed(config, 0, 0, 0)).not.toBe(derivedSeed(config, 1, 0, 0))
    })

    it('equals the merge of its shards, in any order, and is the same however it is split', () => {
        const whole = runStrategy(plan(5), fake)
        const shards = [0, 1, 2].map(i => runStrategyShard(plan(5), i, 3, fake))
        expect(mergeStrategyShards(shards)).toEqual(whole)
        expect(mergeStrategyShards([shards[2], shards[0], shards[1]])).toEqual(whole)
        const four = [0, 1, 2, 3].map(i => runStrategyShard(plan(5), i, 4, fake))
        expect(mergeStrategyShards(four)).toEqual(whole)
    })

    it('refuses shards that do not belong together, and names a missing shard in a partial result', () => {
        const shards = [0, 1, 2].map(i => runStrategyShard(plan(5), i, 3, fake))
        expect(() => mergeStrategyShards([])).toThrow(/no shards/)
        expect(() => mergeStrategyShards([shards[0], shards[1]])).toThrow(/missing shard\(s\) 2\/3/)
        expect(() => mergeStrategyShards([shards[0], shards[0], shards[1]])).toThrow(/given twice/)
        expect(() => mergeStrategyShards([shards[0], runStrategyShard(plan(6), 1, 3, fake), shards[2]])).toThrow(
            /different tournaments/,
        )
        expect(() =>
            mergeStrategyShards([shards[0], { ...shards[1], jobs: shards[1].jobs.slice(1) }, shards[2]]),
        ).toThrow(/does not hold exactly/)
        const partial = mergeStrategyShards([shards[0], shards[2]], { allowMissing: true })
        expect(partial.partial).toEqual({
            jobsPlayed: shards[0].jobs.length + shards[2].jobs.length,
            jobsTotal: jobCount(plan(5).config),
            missingShards: ['1/3'],
        })
    })

    it('stops at the time budget with whole jobs and a partial result', () => {
        let calls = 0
        const stop = () => ++calls > 5
        const result = runStrategy(plan(5), fake, stop)
        expect(result.partial).toMatchObject({ jobsPlayed: 5, jobsTotal: jobCount(plan(5).config) })
        expect(result.games).toBe(5 * 4)
        const shard = runStrategyShard(plan(5), 0, 2, fake, () => true)
        expect(shard.partial).toBe(true)
        expect(shard.jobs).toEqual([])
    })

    it('rejects job results that do not add up', () => {
        const { config } = plan(5)
        const jobs = runStrategyShard(plan(5), 0, 1, fake).jobs
        expect(() => summarizeStrategy(config, jobs.slice(1))).toThrow(/job 0 of \d+ is missing/)
        expect(() => summarizeStrategy(config, [...jobs, jobs[0]])).toThrow(/appears twice/)
        expect(() => summarizeStrategy(config, [{ ...jobs[0], draws: jobs[0].draws + 1 }, ...jobs.slice(1)])).toThrow(
            /inconsistent/,
        )
        expect(() => summarizeStrategy(config, [{ ...jobs[0], job: 9999 }, ...jobs.slice(1)])).toThrow(/not one of/)
    })
})

describe('strategy scoring (#137)', () => {
    // the seed-driven fake: a deterministic winner per seed, a draw one time in five
    const result: StrategyResult = runStrategy(planStrategy({ ...small, fireSets: [FIRE_METEOR, FIRE_OTHER] }), fake)

    it('counts mirror games in the diagonal cells only, and ranks profiles on their games against the others', () => {
        const { cells, rankings, config } = result
        for (const { setup, ranking } of rankings) {
            const own = cells.filter(c => c.setup === setup)
            for (const r of ranking) {
                const versus = own.filter(c => c.a !== c.b && (c.a === r.profile || c.b === r.profile))
                expect(r.games).toBe(versus.reduce((sum, c) => sum + c.games, 0))
                expect(r.games).toBe((config.profiles.length - 1) * config.seeds * config.games)
                expect(r.wins).toBe(versus.reduce((sum, c) => sum + (c.a === r.profile ? c.winsA : c.winsB), 0))
                expect(r.draws).toBe(versus.reduce((sum, c) => sum + c.draws, 0))
                expect(r.wins + r.draws + r.losses).toBe(r.games)
                expect(r.ci95).toEqual(wilsonInterval(r.wins, r.games))
            }
            expect(ranking.map(r => r.rank)).toEqual([1, 2, 3])
            const rates = ranking.map(r => r.winRate)
            expect(rates).toEqual([...rates].sort((x, y) => y - x))
        }
    })

    it('summarises the best profile per general pair over the Fire sets', () => {
        expect(result.pairs.map(p => p.pair)).toEqual(
            STRATEGY_GENERAL_PAIRS.map(pair =>
                pair.map(id => id.slice(6).toLowerCase().replaceAll('_', '-')).join('+'),
            ),
        )
        for (const p of result.pairs) {
            // pooled over the 2 Fire sets
            for (const r of p.ranking) expect(r.games).toBe(2 * 2 * 2 * 4)
            expect(p.best).toBe(p.ranking[0].profile)
            expect(p.separated).toBe(p.ranking[0].ci95.low > p.ranking[1].ci95.high)
            const ids = result.config.setups.filter(s => s.pair.join() === p.spells.join()).map(s => s.id)
            const wins = (profile: string) =>
                result.rankings
                    .filter(r => ids.includes(r.setup))
                    .reduce((sum, r) => sum + r.ranking.find(x => x.profile === profile)!.wins, 0)
            for (const r of p.ranking) expect(r.wins).toBe(wins(r.profile))
        }
    })

    it('ranks a profile that wins everything first, and a loser last, whatever the names', () => {
        // bait always beats the others and always loses to nobody; the fake sees entrant names
        const rigged: MatchFn = ({ a, b, seed }) => {
            const winner =
                a.name === b.name
                    ? seed % 2 === 0
                        ? 'a'
                        : 'b'
                    : a.name === 'bait'
                      ? 'a'
                      : b.name === 'bait'
                        ? 'b'
                        : a.name === 'aggressive'
                          ? 'a'
                          : 'b'
            return { ...fake({ seed, a, b, maxTicks: 1, log: false }), winner }
        }
        const all = runStrategy(planStrategy(small), rigged)
        for (const { ranking } of all.rankings) {
            expect(ranking.map(r => r.profile)).toEqual(['bait', 'aggressive', 'defensive'])
            expect(ranking[0].winRate).toBe(1)
            expect(ranking[2].winRate).toBe(0)
        }
        for (const p of all.pairs) expect(p.best).toBe('bait')
    })
})

describe('strategy report (#137)', () => {
    const full = runStrategy(planStrategy({ ...small, fireSets: [FIRE_METEOR, FIRE_OTHER] }), fake)
    const text = formatStrategyReport(full, { date: '2026-11-09', commit: 'abcdef1' })

    it('has the fixed sections in order', () => {
        const headings = [...text.matchAll(/^## (.+)$/gm)].map(m => m[1])
        expect(headings).toEqual([...STRATEGY_REPORT_SECTIONS])
        expect(text.startsWith('# Arena strategy report: test\n')).toBe(true)
        expect(text).toContain('- **Date:** 2026-11-09 (UTC)')
        expect(text).toContain('- **Commit:** `abcdef1`')
        expect(text).toContain('- **Status:** complete')
    })

    it('has a matrix and a ranking for every setup, with Wilson intervals', () => {
        const matrices = text.slice(text.indexOf('## Matchup matrices'), text.indexOf('## Caveats'))
        for (const setup of full.config.setups) expect(matrices).toContain(`### ${setup.id}\n`)
        expect(matrices.match(/^### /gm)).toHaveLength(12)
        // every matrix is profiles x profiles, with the row profile's win rate and its 95% interval
        const cell = full.cells.find(c => c.setup === 'F1/haste+blur' && c.a === 'aggressive' && c.b === 'bait')!
        const { low, high } = wilsonInterval(cell.winsA, cell.games)
        const pct = (x: number) => `${(x * 100).toFixed(1)}%`
        expect(matrices).toContain(`${pct(cell.winsA / cell.games)} (${pct(low)}-${pct(high)})`)
        // the diagonal shows the first-mover share
        const mirror = full.cells.find(c => c.setup === 'F1/haste+blur' && c.a === 'bait' && c.b === 'bait')!
        expect(matrices).toContain(
            `1st ${pct(mirror.firstWins / mirror.games)} (${pct(wilsonInterval(mirror.firstWins, mirror.games).low)}-`,
        )
        expect(matrices).toContain('| # | Profile | Wins | Draws | Games | Win rate | 95% CI |')
    })

    it('ranks every profile on every setup, and names the best profile per general pair', () => {
        const ranks = text.slice(text.indexOf('## Rank by setup'), text.indexOf('## Matchup matrices'))
        for (const { setup, ranking } of full.rankings) {
            const row = ranks.split('\n').find(line => line.startsWith(`| ${setup} |`))!
            for (const r of ranking) expect(row).toContain(`${r.rank} (${(r.winRate * 100).toFixed(1)}%)`)
        }
        const best = text.slice(text.indexOf('## Best profile per general pair'), text.indexOf('## Rank by setup'))
        expect(best).toContain('| General pair | Best | Clear | aggressive | bait | defensive |')
        for (const p of full.pairs) {
            const names = p.spells.map(id =>
                id
                    .slice(6)
                    .toLowerCase()
                    .split('_')
                    .map(w => w[0].toUpperCase() + w.slice(1))
                    .join(' '),
            )
            const row = best.split('\n').find(line => line.startsWith(`| ${names.join(' + ')} |`))!
            expect(row, p.pair).toContain(`| ${p.best} |`)
        }
    })

    it('lists the Fire sets with their source and baseline, and every setup', () => {
        const byDefault = formatStrategyReport(runStrategy(planStrategy(small), fake), { date: '2026-11-09' })
        expect(byDefault).toContain(
            '| F1 | Meteor, Fireball, Ignite, Combustion | best set of the dummy baseline | rank 1: 40.0 DPS, 30.0 under pressure |',
        )
        const setups = text.slice(text.indexOf('## Setups'), text.indexOf('## Best profile'))
        for (const setup of full.config.setups) expect(setups).toContain(`| ${setup.id} |`)
        const override = formatStrategyReport(runStrategy(planStrategy({ ...small, fireSets: [FIRE_OTHER] }), fake), {
            date: '2026-11-09',
        })
        expect(override).toContain('| F1 | Fireball, Ignite, Living Bomb, Afterburn | `--fire-set` | rank 2')
    })

    it('is the same for the same result, has no pipe inside a cell, and marks a partial run', () => {
        expect(formatStrategyReport(full, { date: '2026-11-09', commit: 'abcdef1' })).toBe(text)
        for (const line of text.split('\n').filter(l => l.startsWith('|'))) {
            // a table row: its cell count is the header's
            expect(line.split(' | ').length).toBeGreaterThan(1)
        }
        const partial = runStrategy(
            planStrategy(small),
            fake,
            (
                (n = 0) =>
                () =>
                    ++n > 40
            )(),
        )
        const partialText = formatStrategyReport(partial, { date: '2026-11-09' })
        expect(partialText).toContain('- **Status:** PARTIAL: 40 of 72 jobs played')
        expect(partialText).toContain('**Partial run.**')
        expect(formatStrategyTable(partial)).toContain('PARTIAL: 40 of 72 jobs played')
        expect(text).toContain('**Partial runs.** This run is complete')
    })

    it('counts the draws and reports the widest interval and the first-mover edge', () => {
        const draws = full.cells.reduce((sum, c) => sum + c.draws, 0)
        expect(draws).toBeGreaterThan(0)
        expect(text).toContain(`**Draws.** ${draws} of ${full.games} games`)
        expect(text).toContain('Each cell has 8 games (2 derived seeds x 4)')
        expect(text).toContain('**First mover.**')
    })

    it('prints the rank table and the best profile per pair for the CLI', () => {
        const table = formatStrategyTable(full)
        expect(table).toContain('12 mirror setups x 3 profiles')
        for (const setup of full.config.setups) expect(table).toContain(setup.id)
        expect(table).toContain('Best profile per general pair:')
        for (const p of full.pairs) expect(table).toContain(p.pair)
    })
})

describe('the shipped baseline plays all 6 pairs for its best Fire set (#137)', () => {
    it('plans 6 mirror setups with every shipped archetype', () => {
        const shipped = parseBaseline(baselineJson)
        const plan = planStrategy({ baseline: shipped, profiles: Object.values(ARCHETYPES).map(a => a.profile) })
        expect(plan.config.setups).toHaveLength(6)
        expect(jobCount(plan.config)).toBe(6 * 10 * DEFAULT_STRATEGY_SEEDS)
        const spells: SpellId[][] = plan.config.setups.map(s => [...s.loadout])
        expect(new Set(spells.map(l => l.join())).size).toBe(6)
    })
})
