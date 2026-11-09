// Typechecked by tsconfig.scripts.json (node types), not tsconfig.json, which keeps node out of the arena sources.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { REPORT_SECTIONS, type TournamentResult } from '../src'

// The `npm run arena` entry point (#105). Every config here is tiny: 8 entrants, 28 pairs, 2 games.
const script = fileURLToPath(new URL('../scripts/tournament.ts', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'arena-cli-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// CI is slower than a laptop: spawning tsx alone can take seconds, so every test that spawns the CLI gets this long
const TIMEOUT = 120_000

const noDate = ['--top', '2', '--general-pairs', '1', '--games', '2', '--seed', '7']
const tiny = [...noDate, '--date', '2026-11-09']
const run = (...args: string[]) =>
    execFileSync('npx', ['tsx', script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
/** Stdout and stderr of a run that succeeds. */
const both = (...args: string[]) => {
    const err = join(dir, 'stderr.txt')
    const out = execFileSync('sh', ['-c', 'exec "$@" 2>"$ERR"', 'sh', 'npx', 'tsx', script, ...args], {
        encoding: 'utf8',
        env: { ...process.env, ERR: err },
    })
    return { out, err: readFileSync(err, 'utf8') }
}
const text = (name: string) => readFileSync(join(dir, name), 'utf8')
const json = (name: string) => JSON.parse(text(name)) as TournamentResult
const fails = (...args: string[]) => {
    try {
        run(...args)
    } catch (error) {
        return String((error as { stderr: unknown }).stderr)
    }
    throw new Error('expected the CLI to fail')
}

describe('arena CLI: --jobs', () => {
    it(
        'clamps a value above 4 to 4 with a warning, and the output does not change',
        () => {
            const clamped = both(...tiny, '--jobs', '9', '--out', join(dir, 'jobs9.json'))
            expect(clamped.err).toContain('warning: --jobs 9 is above the maximum of 4: using 4')
            expect(clamped.err).toContain('with 4 job(s)')
            run(...tiny, '--jobs', '1', '--out', join(dir, 'jobs1.json'))
            expect(text('jobs9.json')).toBe(text('jobs1.json'))
            expect(both(...tiny, '--jobs', '3').err).not.toContain('warning')
            expect(fails(...tiny, '--jobs', '0')).toMatch(/--jobs must be at least 1/)
        },
        TIMEOUT,
    )

    it(
        'uses 4 jobs when --jobs is not given',
        () => {
            expect(both(...tiny).err).toContain('with 4 job(s)')
        },
        TIMEOUT,
    )
})

describe('arena CLI: --time-budget', () => {
    it(
        'stops when the budget is reached and marks the table, the JSON and the report partial',
        () => {
            // a worker starts after the budget has already elapsed (the budget is 1 ms), so nothing is played
            const { out, err } = both(
                ...tiny,
                '--jobs',
                '2',
                '--time-budget',
                '0.001',
                '--out',
                join(dir, 'partial.json'),
                '--report',
                join(dir, 'partial.md'),
            )
            expect(err).toContain('warning: the time budget ended the run after 0 of 28 pairs')
            expect(out).toContain('PARTIAL: the time budget ended the run after 0 of 28 pairs')
            expect(json('partial.json').partial).toEqual({ pairsPlayed: 0, pairsTotal: 28, played: [] })
            expect(text('partial.md')).toContain('**Status:** PARTIAL: 0 of 28 pairs played')
        },
        TIMEOUT,
    )

    it(
        'stops a single process too, and a partial shard still merges into a partial report',
        () => {
            run(...tiny, '--jobs', '1', '--shard', '0/2', '--time-budget', '0.001', '--out', join(dir, 'p0.json'))
            run(...tiny, '--jobs', '1', '--shard', '1/2', '--out', join(dir, 'p1.json'))
            expect(JSON.parse(text('p0.json'))).toMatchObject({ partial: true, pairs: [] })
            run(
                'merge',
                join(dir, 'p1.json'),
                join(dir, 'p0.json'),
                '--report',
                join(dir, 'pm.md'),
                '--date',
                '2026-11-09',
            )
            expect(text('pm.md')).toContain('**Status:** PARTIAL: 14 of 28 pairs played')
        },
        TIMEOUT,
    )

    it(
        'a generous budget changes nothing: the run is complete and identical to one without',
        () => {
            run(...tiny, '--jobs', '2', '--time-budget', '600', '--out', join(dir, 'budget.json'))
            run(...tiny, '--jobs', '1', '--out', join(dir, 'nobudget.json'))
            expect(text('budget.json')).toBe(text('nobudget.json'))
            expect(json('budget.json').partial).toBeUndefined()
        },
        TIMEOUT,
    )

    it(
        'rejects a budget that is not a positive number',
        () => {
            for (const bad of ['0', '-5', 'soon', '1e3'])
                expect(fails(...tiny, '--time-budget', bad)).toMatch(/--time-budget must be a positive number/)
        },
        TIMEOUT,
    )
})

describe('arena CLI: report', () => {
    it(
        'writes the Markdown report with the fixed sections, the same from a local run and from merged shards',
        () => {
            run(
                ...tiny,
                '--jobs',
                '2',
                '--commit',
                'abc1234',
                '--out',
                join(dir, 'full.json'),
                '--report',
                join(dir, 'full.md'),
            )
            for (const i of [0, 1, 2, 3])
                run(...tiny, '--jobs', '2', '--shard', `${i}/4`, '--out', join(dir, `s${i}.json`))
            run(
                'merge',
                ...[3, 1, 0, 2].map(i => join(dir, `s${i}.json`)),
                '--out',
                join(dir, 'merged.json'),
                '--report',
                join(dir, 'merged.md'),
                '--date',
                '2026-11-09',
                '--commit',
                'abc1234',
            )
            expect(text('merged.json')).toBe(text('full.json'))
            expect(text('merged.md')).toBe(text('full.md'))
            expect([...text('full.md').matchAll(/^## (.+)$/gm)].map(m => m[1])).toEqual([...REPORT_SECTIONS])
            expect(text('full.md')).toContain('**Date:** 2026-11-09 (UTC)')
            expect(text('full.md')).toContain('**Status:** complete')
            // the top-8 bracket (#136), played after the round-robin by default, the same after a merge
            const { bracket } = json('full.json')
            expect(bracket?.bestOf).toBe(5)
            expect(bracket?.seeds.map(s => s.id)).toEqual(
                json('full.json')
                    .ranking.slice(0, 8)
                    .map(r => r.id),
            )
            expect(bracket?.placements.map(p => p.place)).toEqual(['1st', '2nd', '3rd', '4th', '5th-6th', '7th-8th'])
            const section = text('full.md').split('## Bracket')[1]
            for (const set of bracket!.sets) expect(section).toContain(`| ${set.id} | ${set.round} |`)
        },
        TIMEOUT,
    )

    it(
        'takes the bracket best-of from --bracket-best-of, skips it with --no-bracket, and rejects an even best-of',
        () => {
            run(...tiny, '--jobs', '1', '--bracket-best-of', '3', '--out', join(dir, 'bo3.json'))
            expect(json('bo3.json').bracket?.bestOf).toBe(3)
            const { out } = both(
                ...tiny,
                '--jobs',
                '1',
                '--no-bracket',
                '--out',
                join(dir, 'nob.json'),
                '--report',
                join(dir, 'nob.md'),
            )
            expect(json('nob.json').bracket).toBeUndefined()
            expect(out).not.toContain('Bracket:')
            expect(text('nob.md')).toContain('Not run: --no-bracket was given.')
            // --no-bracket takes no value: the file after it is still a shard to merge
            run(...tiny, '--jobs', '1', '--shard', '0/1', '--out', join(dir, 'one.json'))
            run('merge', '--no-bracket', join(dir, 'one.json'), '--out', join(dir, 'one-merged.json'))
            expect(json('one-merged.json').bracket).toBeUndefined()
            expect(fails(...tiny, '--bracket-best-of', '4')).toMatch(
                /--bracket-best-of must be an odd positive integer/,
            )
        },
        TIMEOUT,
    )

    it(
        'rejects a bad date or commit, and --report on a shard',
        () => {
            const report = ['--report', join(dir, 'x.md')]
            expect(fails(...noDate, '--date', 'today', ...report)).toMatch(/--date must look like YYYY-MM-DD/)
            expect(fails(...noDate, '--commit', 'not-a-sha', ...report)).toMatch(/--commit must be a hex commit id/)
            expect(fails(...noDate, '--shard', '0/2', '--out', join(dir, 'y.json'), ...report)).toMatch(
                /--report needs a whole run/,
            )
        },
        TIMEOUT,
    )
})

describe('arena CLI: file paths and missing shards', () => {
    const inDir = (cwd: string, ...args: string[]) =>
        // node directly: npx would set INIT_CWD itself
        execFileSync(process.execPath, ['--import', 'tsx', script, ...args], {
            encoding: 'utf8',
            stdio: 'pipe',
            env: { ...process.env, INIT_CWD: cwd },
        })

    it(
        'resolves relative --out, --report and merge files against INIT_CWD, where npm was invoked',
        () => {
            const there = mkdtempSync(join(dir, 'init-'))
            inDir(there, ...tiny, '--jobs', '1', '--out', 'rel.json', '--report', 'rel.md')
            expect(existsSync(join(there, 'rel.json'))).toBe(true)
            expect(existsSync(join(there, 'rel.md'))).toBe(true)
            inDir(there, ...tiny, '--jobs', '1', '--shard', '0/1', '--out', 'shard.json')
            inDir(there, 'merge', 'shard.json', '--out', 'merged.json', '--report', 'merged.md', '--date', '2026-11-09')
            expect(readFileSync(join(there, 'merged.json'), 'utf8')).toBe(readFileSync(join(there, 'rel.json'), 'utf8'))
        },
        TIMEOUT,
    )

    it(
        'through the root `npm run arena` script, a relative --out lands where the command was typed',
        () => {
            // npm runs the workspace script from packages/arena; the file must still appear in the invoking directory
            const name = `arena-path-test-${process.pid}.json`
            const target = join(process.cwd(), name)
            try {
                execFileSync('npm', ['run', '-s', 'arena', '--', ...tiny, '--jobs', '1', '--out', name], {
                    encoding: 'utf8',
                    stdio: 'pipe',
                })
                expect(existsSync(target)).toBe(true)
                expect(existsSync(join(process.cwd(), 'packages', 'arena', name))).toBe(false)
            } finally {
                rmSync(target, { force: true })
            }
        },
        TIMEOUT,
    )

    it(
        'merge --allow-missing reports the missing shard as partial; without it merge fails',
        () => {
            for (const i of [0, 2]) run(...tiny, '--jobs', '1', '--shard', `${i}/3`, '--out', join(dir, `m${i}.json`))
            const files = [join(dir, 'm0.json'), join(dir, 'm2.json')]
            expect(fails('merge', ...files)).toMatch(/missing shard\(s\) 1\/3/)
            run('merge', ...files, '--allow-missing', '--report', join(dir, 'missing.md'), '--date', '2026-11-09')
            expect(text('missing.md')).toContain('**Status:** PARTIAL: 19 of 28 pairs played, missing shards 1/3')
        },
        TIMEOUT,
    )
})
