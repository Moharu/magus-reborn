// Typechecked by tsconfig.scripts.json (node types), not tsconfig.json, which keeps node out of the arena sources.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { STRATEGY_REPORT_SECTIONS, type StrategyResult } from '../src'

// The strategy tournament's CLI (#137), through `npm run arena -- --mode strategy` (scripts/arena.ts) and its own script
// (scripts/strategy.ts, `npm run arena:strategy`). Every config is tiny: 2 profiles, 6 setups, a few games.
const entry = fileURLToPath(new URL('../scripts/arena.ts', import.meta.url))
const strategy = fileURLToPath(new URL('../scripts/strategy.ts', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'arena-strategy-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// CI is slower than a laptop: spawning tsx alone can take seconds, so every test that spawns the CLI gets this long
const TIMEOUT = 120_000

const tiny = ['--profiles', 'aggressive,bait', '--seeds', '2', '--games', '2', '--seed', '5']
const run = (script: string, ...args: string[]) =>
    execFileSync('npx', ['tsx', script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const arena = (...args: string[]) => run(entry, ...args)
const fails = (script: string, ...args: string[]) => {
    try {
        run(script, ...args)
    } catch (error) {
        return String((error as { stderr: unknown }).stderr)
    }
    throw new Error('expected the CLI to fail')
}
const text = (name: string) => readFileSync(join(dir, name), 'utf8')
const json = (name: string) => JSON.parse(text(name)) as StrategyResult

describe('arena --mode strategy (#137)', () => {
    it(
        'plays the 6 mirror setups of the default Fire set and writes the result, the table and the report',
        () => {
            const out = join(dir, 'whole.json')
            const report = join(dir, 'whole.md')
            const printed = arena(
                '--mode',
                'strategy',
                ...tiny,
                '--out',
                out,
                '--report',
                report,
                '--date',
                '2026-11-09',
            )
            const result = json('whole.json')
            expect(result.format).toBe('arena-strategy')
            expect(result.config.setups).toHaveLength(6)
            expect(result.config.fireSets).toHaveLength(1)
            // 6 setups x (aggressive/aggressive, aggressive/bait, bait/bait) cells, 2 seeds x 2 games each
            expect(result.cells).toHaveLength(18)
            expect(result.cells.every(c => c.games === 4)).toBe(true)
            expect(printed).toContain('6 mirror setups x 2 profiles')
            expect(printed).toContain('Best profile per general pair:')
            const headings = [...text('whole.md').matchAll(/^## (.+)$/gm)].map(m => m[1])
            expect(headings).toEqual([...STRATEGY_REPORT_SECTIONS])
        },
        TIMEOUT,
    )

    it(
        'is the same command as scripts/strategy.ts (npm run arena:strategy), and --mode tournament is the default',
        () => {
            arena('--mode', 'strategy', ...tiny, '--jobs', '1', '--out', join(dir, 'viaArena.json'))
            run(strategy, ...tiny, '--jobs', '1', '--out', join(dir, 'viaStrategy.json'))
            expect(text('viaArena.json')).toBe(text('viaStrategy.json'))
            const small = ['--top', '1', '--general-pairs', '1', '--profiles', 'aggressive,bait', '--games', '2']
            const plain = arena(...small)
            expect(plain).toContain('entrants')
            expect(plain).not.toContain('mirror setups')
            expect(arena('--mode', 'tournament', ...small)).toBe(plain)
            expect(fails(entry, '--mode', 'bogus')).toMatch(/--mode must be one of tournament, strategy, got bogus/)
            expect(fails(entry, '--mode')).toMatch(/--mode must be one of/)
        },
        TIMEOUT,
    )

    it(
        'repeats --fire-set for several Fire sets, and the worker count does not change the output',
        () => {
            const sets = [
                '--fire-set',
                'fireball,ignite,combustion,meteor',
                '--fire-set',
                'SPELL_FIREBALL,living-bomb,ignite,afterburn',
            ]
            arena('--mode', 'strategy', ...tiny, ...sets, '--jobs', '1', '--out', join(dir, 'sets1.json'))
            arena('--mode', 'strategy', ...tiny, ...sets, '--jobs', '3', '--out', join(dir, 'sets3.json'))
            expect(text('sets1.json')).toBe(text('sets3.json'))
            const result = json('sets1.json')
            expect(result.config.setups).toHaveLength(12)
            expect(result.config.fireSets.map(f => f.source)).toEqual(['override', 'override'])
            expect(result.config.fireSets[1].spells).toEqual([
                'SPELL_FIREBALL',
                'SPELL_LIVING_BOMB',
                'SPELL_IGNITE',
                'SPELL_AFTERBURN',
            ])
            expect(fails(entry, '--mode', 'strategy', '--fire-set', 'fireball,ignite')).toMatch(/needs 4 Fire spells/)
            expect(fails(entry, '--mode', 'strategy', '--fire-set', 'fireball,ignite,combustion,haste')).toMatch(
                /four distinct Fire spells/,
            )
        },
        TIMEOUT,
    )

    it(
        'accepts a Frost set through --set (or --fire-set), labelled I<n> with the Frost table baseline (#150)',
        () => {
            const sets = [
                '--fire-set',
                'fireball,ignite,combustion,meteor',
                '--set',
                'frostbolt,glacier,frost-bomb,ice-spear',
            ]
            arena('--mode', 'strategy', ...tiny, ...sets, '--jobs', '1', '--out', join(dir, 'frost.json'))
            const result = json('frost.json')
            expect(result.config.setups.map(s => s.id)).toContain('I2/haste+blur')
            expect(result.config.fireSets[1]).toMatchObject({
                element: 'FROST',
                spells: ['SPELL_FROSTBOLT', 'SPELL_GLACIER', 'SPELL_FROST_BOMB', 'SPELL_ICE_SPEAR'],
                baseline: { rank: 4 },
            })
            expect(result.games).toBe(12 * 3 * 2 * 2)
            expect(fails(entry, '--mode', 'strategy', '--set', 'frostbolt,glacier,frost-bomb,fireball')).toMatch(
                /four distinct Fire spells \(nor four Frost spells\)/,
            )
        },
        TIMEOUT,
    )

    it(
        'shards merge into the unsharded result, with absolute --out paths, and a missing shard makes it partial',
        () => {
            const whole = join(dir, 'm-whole.json')
            arena('--mode', 'strategy', ...tiny, '--jobs', '1', '--out', whole)
            const shards = [0, 1, 2].map(i => join(dir, `m-shard-${i}.json`))
            shards.forEach((file, i) =>
                arena('--mode', 'strategy', ...tiny, '--shard', `${i}/3`, '--jobs', '2', '--out', file),
            )
            const merged = join(dir, 'm-merged.json')
            arena(
                '--mode',
                'strategy',
                'merge',
                ...shards,
                '--out',
                merged,
                '--report',
                join(dir, 'm-merged.md'),
                '--date',
                '2026-11-09',
            )
            expect(JSON.parse(readFileSync(merged, 'utf8'))).toEqual(JSON.parse(readFileSync(whole, 'utf8')))
            expect(text('m-merged.md')).toContain('- **Status:** complete')

            arena(
                '--mode',
                'strategy',
                'merge',
                shards[0],
                shards[2],
                '--allow-missing',
                '--out',
                join(dir, 'm-part.json'),
            )
            const part = json('m-part.json')
            expect(part.partial?.missingShards).toEqual(['1/3'])
            expect(fails(entry, '--mode', 'strategy', 'merge', shards[0], shards[2])).toMatch(/missing shard\(s\) 1\/3/)
            expect(fails(entry, '--mode', 'strategy', ...tiny, '--shard', '0/2')).toMatch(/--shard needs --out/)
            expect(
                fails(
                    entry,
                    '--mode',
                    'strategy',
                    ...tiny,
                    '--shard',
                    '0/2',
                    '--report',
                    'x.md',
                    '--out',
                    join(dir, 'x.json'),
                ),
            ).toMatch(/--report needs a whole run/)
        },
        TIMEOUT,
    )

    it(
        'a tournament shard is not a strategy shard',
        () => {
            const shard = join(dir, 't-shard.json')
            arena(
                '--top',
                '1',
                '--general-pairs',
                '1',
                '--profiles',
                'aggressive,bait',
                '--games',
                '2',
                '--shard',
                '0/1',
                '--out',
                shard,
            )
            expect(fails(entry, '--mode', 'strategy', 'merge', shard)).toMatch(/not a strategy tournament shard/)
        },
        TIMEOUT,
    )
})

describe('.github/workflows/arena.yml: the mode input (#137)', () => {
    const workflow = readFileSync(
        fileURLToPath(new URL('../../../.github/workflows/arena.yml', import.meta.url)),
        'utf8',
    )

    it('has a mode input that defaults to tournament and offers strategy', () => {
        const input = /^ {12}mode:\n((?: {16}.*\n)+)/m.exec(workflow)?.[1] ?? ''
        expect(input).toMatch(/default: tournament/)
        expect(input).toMatch(/- tournament\n\s+- strategy/)
    })

    it('shards and merges the strategy mode the same way, through absolute paths under arena-out', () => {
        expect(workflow).toMatch(/inputs\.mode == 'strategy'/)
        expect(workflow).toMatch(/inputs\.mode == 'tournament'/)
        const strategyCalls = workflow.split('\n').filter(l => l.includes('--mode strategy'))
        expect(strategyCalls.length).toBeGreaterThanOrEqual(2)
        // every file the CLI reads or writes is absolute under $GITHUB_WORKSPACE, as in the tournament steps
        const files = [...workflow.matchAll(/--(?:out|report) (\S+)/g)].map(m => m[1])
        expect(files.length).toBeGreaterThanOrEqual(6)
        for (const file of files) expect(file, file).toMatch(/^"\$GITHUB_WORKSPACE\/arena-out\//)
        for (const glob of workflow.matchAll(/npm run arena -- (?:--mode strategy )?merge (\S+)/g))
            expect(glob[1]).toMatch(/^"\$GITHUB_WORKSPACE"\/arena-in\//)
        expect([...workflow.matchAll(/npm run arena -- (?:--mode strategy )?merge/g)]).toHaveLength(2)
        // both modes upload the same shard and report files
        expect(workflow).toContain('path: arena-out/arena-shard-${{ matrix.shard }}.json')
        expect(workflow).toContain('arena-out/arena-report.md')
        // the tuning belongs to the tournament mode
        expect(workflow).toContain('"$ARENA_MODE" == "tournament"')
    })
})

describe('.github/workflows/arena.yml: Frost sets (#150)', () => {
    const workflow = readFileSync(
        fileURLToPath(new URL('../../../.github/workflows/arena.yml', import.meta.url)),
        'utf8',
    )

    it('has a frost_top input, checked as an integer and passed to the tournament shards as --frost-top', () => {
        const input = /^ {12}frost_top:\n((?: {16}.*\n)+)/m.exec(workflow)?.[1] ?? ''
        expect(input).toMatch(/default: '8'/)
        expect(workflow).toContain('ARENA_FROST_TOP: ${{ inputs.frost_top }}')
        expect(workflow).toMatch(/for name in [^;]*\bARENA_FROST_TOP\b/)
        expect(workflow).toContain('--frost-top "$ARENA_FROST_TOP"')
        // workflow_dispatch takes at most 10 inputs
        const inputs = /^ {8}inputs:\n((?: {12,}.*\n)+)/m.exec(workflow)?.[1] ?? ''
        expect([...inputs.matchAll(/^ {12}\w+:$/gm)].length).toBeLessThanOrEqual(10)
    })
})
