// Typechecked by tsconfig.scripts.json (node types), not tsconfig.json, which keeps node out of the arena sources.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENGINE_VERSION } from '@magus/engine'
import { afterAll, describe, expect, it } from 'vitest'
import { ARCHETYPES, formatTable, parseBaseline, planTournament, runTournament, type TournamentResult } from '../src'

const script = fileURLToPath(new URL('../scripts/tournament.ts', import.meta.url))
const baselineFile = fileURLToPath(new URL(`../baselines/${ENGINE_VERSION}.json`, import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'arena-tournament-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// CI is slower than a laptop: spawning tsx alone can take seconds, so every test that spawns the CLI gets this long
const TIMEOUT = 120_000

const cli = (...args: string[]) => execFileSync('npx', ['tsx', script, ...args], { encoding: 'utf8' })
const small = ['--top', '2', '--general-pairs', '1', '--profiles', 'aggressive,bait', '--games', '2', '--seed', '3']
const json = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as TournamentResult

describe('baselines/<version>.json', () => {
    const baseline = parseBaseline(JSON.parse(readFileSync(baselineFile, 'utf8')), ENGINE_VERSION)

    it('is a ranked table for this engine version that every archetype profile can play', () => {
        const profiles = Object.values(ARCHETYPES).map(a => a.profile)
        const plan = planTournament({ baseline, top: 99, generalPairs: 99, profiles })
        expect(plan.config.entrants).toHaveLength(baseline.loadouts.length * profiles.length)
        for (const make of plan.make) expect(make().loadout).toHaveLength(7)
        const rates = baseline.loadouts.map(l => l.dpsUnderPressure)
        expect(rates).toEqual([...rates].sort((a, b) => b - a))
    })
})

describe('default entrants', () => {
    const baseline = parseBaseline(JSON.parse(readFileSync(baselineFile, 'utf8')), ENGINE_VERSION)
    const profiles = Object.values(ARCHETYPES).map(a => a.profile)

    it('are 8 distinct Fire sets with 2 general pairs each, from the shipped baseline', () => {
        const { config } = planTournament({ baseline, profiles })
        expect(config.top).toEqual({ requested: 8, used: 8 })
        expect(config.loadouts).toHaveLength(16)
        const loadouts = [...new Map(config.entrants.map(e => [e.loadoutRank, e.loadout] as const)).values()]
        const sets = new Map<string, number>()
        for (const l of loadouts) {
            const key = [...l.slice(0, 4)].sort().join()
            sets.set(key, (sets.get(key) ?? 0) + 1)
        }
        expect(sets.size).toBe(8)
        expect([...sets.values()]).toEqual(Array(8).fill(2))
        expect(new Set(loadouts.map(l => l.join())).size).toBe(16)
    })
})

describe('arena:tournament CLI', () => {
    it(
        '--general-pairs K gives each of the --top Fire sets K loadouts',
        () => {
            const out = join(dir, 'k.json')
            cli(
                '--top',
                '2',
                '--general-pairs',
                '2',
                '--profiles',
                'aggressive',
                '--games',
                '2',
                '--max-ticks',
                '40',
                '--jobs',
                '1',
                '--out',
                out,
            )
            const { config } = json('k.json')
            expect(config.generalPairs).toBe(2)
            expect(config.loadouts).toHaveLength(4)
            expect(new Set(config.entrants.map(e => e.loadout.slice(0, 4).sort().join())).size).toBe(2)
        },
        TIMEOUT,
    )

    it(
        'prints the ranked table and writes the same result as the library',
        () => {
            const table = cli(...small, '--jobs', '1', '--out', join(dir, 'one.json'))
            const expected = runTournament(
                planTournament({
                    baseline: parseBaseline(JSON.parse(readFileSync(baselineFile, 'utf8'))),
                    top: 2,
                    generalPairs: 1,
                    profiles: [ARCHETYPES.aggressive.profile, ARCHETYPES.bait.profile],
                    games: 2,
                    seed: 3,
                }),
            )
            expect(json('one.json')).toEqual(JSON.parse(JSON.stringify(expected)))
            expect(table.trim()).toBe(formatTable(expected))
            expect(table).toContain('win rate')
            expect(table).toContain('95% CI')
        },
        TIMEOUT,
    )

    it(
        'gives the same JSON for any --jobs, and merged shards match too',
        () => {
            cli(...small, '--jobs', '2', '--out', join(dir, 'two.json'))
            expect(readFileSync(join(dir, 'two.json'), 'utf8')).toBe(readFileSync(join(dir, 'one.json'), 'utf8'))
            for (const i of [0, 1, 2])
                cli(...small, '--jobs', '2', '--shard', `${i}/3`, '--out', join(dir, `s${i}.json`))
            cli('merge', ...[2, 1, 0].map(i => join(dir, `s${i}.json`)), '--out', join(dir, 'merged.json'))
            expect(readFileSync(join(dir, 'merged.json'), 'utf8')).toBe(readFileSync(join(dir, 'one.json'), 'utf8'))
        },
        TIMEOUT,
    )

    it(
        'keeps stdout pure JSON with --out -, for a run and for merge',
        () => {
            const run = execFileSync('npx', ['tsx', script, ...small, '--jobs', '1', '--out', '-'], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
            })
            expect(JSON.parse(run)).toEqual(json('one.json'))
            const merged = execFileSync(
                'npx',
                [
                    'tsx',
                    script,
                    'merge',
                    join(dir, 's0.json'),
                    join(dir, 's1.json'),
                    join(dir, 's2.json'),
                    '--out',
                    '-',
                ],
                {
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'pipe'],
                },
            )
            expect(JSON.parse(merged)).toEqual(json('one.json'))
        },
        TIMEOUT,
    )

    it(
        'fails clearly on a missing baseline, a bad profile and an odd game count',
        () => {
            const fails = (...args: string[]) => {
                try {
                    execFileSync('npx', ['tsx', script, ...args], { encoding: 'utf8', stdio: 'pipe' })
                } catch (error) {
                    return String((error as { stderr: unknown }).stderr)
                }
                throw new Error('expected the CLI to fail')
            }
            expect(fails(...small, '--baseline', 'reborn-9.9.9')).toMatch(
                /no dummy-DPS baseline for version reborn-9\.9\.9/,
            )
            expect(fails(...small.slice(0, 2), '--profiles', 'nope')).toMatch(/unknown profile nope/)
            expect(fails('--games', '3')).toMatch(/even/)
            expect(fails('--jobs', '0')).toMatch(/--jobs must be at least 1/)
            expect(fails(...small, '--shard', '0/2')).toMatch(/--out/)
            const baselineScript = fileURLToPath(new URL('../scripts/baseline.ts', import.meta.url))
            try {
                execFileSync('npx', ['tsx', baselineScript, '--out'], { encoding: 'utf8', stdio: 'pipe' })
                throw new Error('expected the baseline CLI to fail')
            } catch (error) {
                expect(String((error as { stderr: unknown }).stderr)).toMatch(/--out needs a file/)
            }
            writeFileSync(join(dir, 'bad.json'), '{}')
            expect(fails('merge', join(dir, 'bad.json'))).toMatch(/not a tournament shard/)
        },
        TIMEOUT,
    )
})
