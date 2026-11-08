// Typechecked by tsconfig.scripts.json (node types), not tsconfig.json, which keeps node out of the arena sources.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EXAMPLE_ENTRANTS, formatSummary, runMatch } from '../src'

const srcDir = fileURLToPath(new URL('../src/', import.meta.url))
const sources = readdirSync(srcDir)
    .filter(file => file.endsWith('.ts'))
    .map(file => ({ file, text: readFileSync(srcDir + file, 'utf8') }))

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
                expect(from === '@magus/engine' || /^\.\/[\w-]+$/.test(from), `${file} imports ${from}`).toBe(true)
            }
        }
    })
})

describe('arena:match CLI', () => {
    it('prints the summary of the example match for --seed', () => {
        const script = fileURLToPath(new URL('../scripts/match.ts', import.meta.url))
        const out = execFileSync('npx', ['tsx', script, '--seed', '5'], { encoding: 'utf8' }).trim().split('\n')
        const expected = runMatch({ seed: 5, a: EXAMPLE_ENTRANTS.aggressor, b: EXAMPLE_ENTRANTS.counter })
        expect(out.at(-1)).toBe(formatSummary(expected))
        expect(out.at(-1)).toMatch(/^END winner=(a|b|draw) reason=\w+ ticks=\d+ /)
    }, 30_000)
})
