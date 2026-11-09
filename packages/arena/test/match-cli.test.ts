// Typechecked by tsconfig.scripts.json (node types), not tsconfig.json, which keeps node out of the arena sources.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { archetypeEntrant, EXAMPLE_ENTRANTS, formatSummary, runMatch } from '../src'

const srcDir = fileURLToPath(new URL('../src/', import.meta.url))
const sources = readdirSync(srcDir)
    .filter(file => file.endsWith('.ts'))
    .map(file => ({ file, text: readFileSync(srcDir + file, 'utf8') }))

// CI is slower than a laptop: spawning tsx alone can take seconds, so every test that spawns the CLI gets this long
const TIMEOUT = 120_000

describe('arena sources', () => {
    it('use no unseeded or non-deterministic source', () => {
        expect(sources.length).toBeGreaterThan(0)
        for (const { file, text } of sources) {
            for (const banned of ['Math.random', 'Date.now', 'new Date', 'performance.now', 'crypto', 'process.']) {
                expect(text.includes(banned), `${file} uses ${banned}`).toBe(false)
            }
        }
    })

    it('import the engine only through its public entry, never a spell module', () => {
        for (const { file, text } of sources) {
            for (const [, from] of text.matchAll(/from '([^']+)'/g)) {
                // a sibling module, or a checked-in archetype profile
                const allowed =
                    from === '@magus/engine' || /^\.\/[\w-]+$/.test(from) || /^\.\.\/profiles\/[\w-]+\.json$/.test(from)
                expect(allowed, `${file} imports ${from}`).toBe(true)
            }
        }
    })
})

describe('arena CLI tests', () => {
    const testDir = fileURLToPath(new URL('./', import.meta.url))
    const files = readdirSync(testDir).filter(file => file.endsWith('.test.ts'))

    it('give every test that spawns a CLI process the 120 s timeout, for slow CI runners', () => {
        let spawning = 0
        for (const file of files) {
            const text = readFileSync(testDir + file, 'utf8')
            if (!text.includes('execFileSync(')) continue
            expect(text, file).toMatch(/^const TIMEOUT = 120_000$/m)
            // each `it(` up to the next one: a test that runs a CLI helper or execFileSync must pass TIMEOUT
            for (const block of text.split(/\n\s*it\(/).slice(1)) {
                const test = block.split(/\n\s*(?:describe|it)\(/)[0]
                // (this test names execFileSync without calling it)
                if (test.includes('spawns a CLI process') || !/\b(?:cli|fails|execFileSync)\(/.test(test)) continue
                spawning += 1
                expect(test, `${file}: ${test.split('\n')[0]}`).toMatch(/\}\s*,\s*TIMEOUT,?\s*\)/)
            }
        }
        expect(spawning).toBeGreaterThanOrEqual(10)
    })
})

describe('arena:match CLI', () => {
    it(
        'prints the summary of the example match for --seed',
        () => {
            const script = fileURLToPath(new URL('../scripts/match.ts', import.meta.url))
            const out = execFileSync('npx', ['tsx', script, '--seed', '5'], { encoding: 'utf8' }).trim().split('\n')
            const expected = runMatch({ seed: 5, a: EXAMPLE_ENTRANTS.aggressor, b: EXAMPLE_ENTRANTS.counter })
            expect(out.at(-1)).toBe(formatSummary(expected))
            expect(out.at(-1)).toMatch(/^END winner=(a|b|draw) reason=\w+ ticks=\d+ /)
        },
        TIMEOUT,
    )

    it(
        'plays two archetypes with --a and --b',
        () => {
            const script = fileURLToPath(new URL('../scripts/match.ts', import.meta.url))
            const args = [script, '--seed', '3', '--a', 'bait', '--b', 'patient-counter']
            const out = execFileSync('npx', ['tsx', ...args], { encoding: 'utf8' })
                .trim()
                .split('\n')
            const expected = runMatch({ seed: 3, a: archetypeEntrant('bait'), b: archetypeEntrant('patient-counter') })
            expect(out[0]).toBe('a bait vs b patient-counter')
            expect(out.at(-1)).toBe(formatSummary(expected))
        },
        TIMEOUT,
    )
})
