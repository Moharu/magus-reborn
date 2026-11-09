// Typechecked by tsconfig.scripts.json (node types), not tsconfig.json, which keeps node out of the arena sources.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENGINE_VERSION } from '@magus/engine'
import { afterAll, describe, expect, it } from 'vitest'
import {
    ARCHETYPES,
    DEFAULT_GENERAL_PAIRS,
    DEFAULT_TOP,
    formatTuning,
    parseBaseline,
    parseProfile,
    runMatch,
    scorer,
    tune,
    tunedProfile,
} from '../src'

const script = fileURLToPath(new URL('../scripts/tune.ts', import.meta.url))
const baselineFile = fileURLToPath(new URL(`../baselines/${ENGINE_VERSION}.json`, import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'arena-tune-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// CI is slower than a laptop: spawning tsx alone can take seconds
const TIMEOUT = 120_000

const cli = (...args: string[]) =>
    execFileSync('npx', ['tsx', script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const fails = (...args: string[]) => {
    try {
        cli(...args)
    } catch (error) {
        return String((error as { stderr: unknown }).stderr)
    }
    throw new Error('expected the CLI to fail')
}
/** 1 loadout, 1 field profile, 2 games: 2 matches per profile, at most 20 s of game time each. */
const small = [
    ...['--top', '1', '--general-pairs', '1', '--field', 'aggressive', '--from', 'aggressive,bait'],
    ...['--games', '2', '--max-ticks', '400', '--seed', '5', '--population', '4', '--generations', '2', '--elite', '1'],
]

/** `small` with one flag's value replaced (the CLI reads the first occurrence of a flag). */
const smallWith = (name: string, value: string) => {
    const args = [...small]
    args[args.indexOf(`--${name}`) + 1] = value
    return args
}

describe('arena:tune CLI', () => {
    it(
        'prints the generation table and both win rates, and writes the best profile as loadable profile JSON',
        () => {
            const out = join(dir, 'best.json')
            const stdout = cli(...small, '--out', out)
            const expected = tune({
                baseline: parseBaseline(JSON.parse(readFileSync(baselineFile, 'utf8')), ENGINE_VERSION),
                seeds: [ARCHETYPES.aggressive.profile, ARCHETYPES.bait.profile],
                field: [ARCHETYPES.aggressive.profile],
                top: 1,
                generalPairs: 1,
                games: 2,
                maxTicks: 400,
                seed: 5,
                population: 4,
                generations: 2,
                elite: 1,
            })
            expect(stdout).toBe(`${formatTuning(expected)}\nBest profile written to ${out}.\n`)
            expect(stdout).toMatch(/^gen +best +median +worst +best profile +L\d\d$/m)
            expect(stdout).toContain('fresh seeds (holdout, not used for selection)')
            const written = JSON.parse(readFileSync(out, 'utf8')) as unknown
            expect(parseProfile(written)).toEqual(tunedProfile(expected))
        },
        TIMEOUT,
    )

    it(
        '--max-matches stops early, still writes the best so far and says the run is partial',
        () => {
            const out = join(dir, 'partial.json')
            // 2 matches a profile: 4 starting profiles (8), then room for the holdout only
            const stdout = cli(...small, '--max-matches', '11', '--out', out)
            expect(stdout).toContain('PARTIAL: the --max-matches budget of 11')
            expect(stdout).toContain('(partial run)')
            expect((parseProfile(JSON.parse(readFileSync(out, 'utf8'))) as { intent?: string }).intent).toContain(
                '(partial run)',
            )
        },
        TIMEOUT,
    )

    it(
        'fails clearly on bad options',
        () => {
            expect(fails(...smallWith('elite', '4'))).toMatch(/elite must be an integer in \[0, population\)/)
            expect(fails(...smallWith('games', '3'))).toMatch(/even/)
            expect(fails(...smallWith('field', 'nope'))).toMatch(/--field: unknown profile nope/)
            expect(fails(...small, '--max-matches', '3')).toMatch(/maxMatches 3 is below 4/)
            expect(fails(...small, '--baseline', 'reborn-9.9.9')).toMatch(/no dummy-DPS baseline/)
        },
        TIMEOUT,
    )
})

describe('tuned profiles', () => {
    const files = (root: string): string[] =>
        readdirSync(root).flatMap(name => {
            const path = join(root, name)
            if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) return []
            return statSync(path).isDirectory() ? files(path) : [path]
        })

    it('are not used by gameplay: nothing under apps/ imports the arena', () => {
        const apps = fileURLToPath(new URL('../../../apps/', import.meta.url))
        const sources = files(apps).filter(f => /\.(ts|tsx|js|mjs|json)$/.test(f) && !f.endsWith('package-lock.json'))
        expect(sources.length).toBeGreaterThan(0)
        for (const file of sources) {
            const text = readFileSync(file, 'utf8')
            expect(text.includes('@magus/arena') || text.includes('packages/arena'), file).toBe(false)
        }
    })
})

describe('arena:tune with the default field (#136)', () => {
    const baseline = parseBaseline(JSON.parse(readFileSync(baselineFile, 'utf8')), ENGINE_VERSION)
    const workflow = readFileSync(
        fileURLToPath(new URL('../../../.github/workflows/arena.yml', import.meta.url)),
        'utf8',
    )

    it('scores a profile on all 48 default loadouts against the 4-archetype field, and the workflow budget fits it', () => {
        const field = Object.values(ARCHETYPES).map(a => a.profile)
        // building the scorer plans the tournament but plays nothing
        const { config, matches } = scorer(
            {
                baseline,
                field,
                top: DEFAULT_TOP,
                generalPairs: DEFAULT_GENERAL_PAIRS,
                games: 2,
                maxTicks: 3600,
                run: runMatch,
            },
            1,
        )
        expect(config.loadouts).toHaveLength(48)
        expect(config.entrants).toHaveLength(48 * 5)
        // each of the candidate's 48 entrants meets the 192 field entrants, 2 games a pair
        expect(matches).toBe(48 * 192 * 2)
        // the tune job's --max-matches covers a selection score and its holdout re-score many times over
        const maxMatches = Number(/--max-matches (\d+)/.exec(workflow)?.[1])
        expect(maxMatches).toBeGreaterThanOrEqual(2 * matches * 10)
    })

    it('the workflow merge job plays the bracket after merging the shards', () => {
        const merge = workflow.slice(workflow.search(/^ {4}merge:$/m), workflow.search(/^ {4}tune:$/m))
        expect(merge).toContain('npm run arena -- merge')
        expect(merge).toContain('--bracket-best-of 5')
        expect(merge).not.toContain('--no-bracket')
    })
})
