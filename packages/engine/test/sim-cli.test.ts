// Typechecked by tsconfig.scripts.json (node types), not tsconfig.json, which keeps node out of the engine.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('sim CLI', () => {
    it('prints dps, dpsUnderPressure and risk', () => {
        const script = fileURLToPath(new URL('../scripts/sim.ts', import.meta.url))
        const out = JSON.parse(
            execFileSync('npx', ['tsx', script, '--loadout', 'meteor', '--reaction', '0.4'], { encoding: 'utf8' }),
        )
        expect(out.dps).toBe(7.466667)
        expect(out.dpsUnderPressure).toBe(5.6)
        expect(out.risk).toBe(1.866667)
    }, 30_000)

    it('sim:search prints the top K by dpsUnderPressure, the same with any --jobs', () => {
        const script = fileURLToPath(new URL('../scripts/sim-search.ts', import.meta.url))
        const run = (jobs: string) =>
            execFileSync(
                'npx',
                [
                    'tsx',
                    script,
                    '--size',
                    '2',
                    '--pool',
                    'fireball,ignite,meteor',
                    '--duration',
                    '20',
                    '--top',
                    '4',
                    '--jobs',
                    jobs,
                ],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
            )
        const single = run('1')
        expect(run('3')).toBe(single)
        const out = JSON.parse(single)
        expect(out.evaluated).toBe(16)
        expect(out.options).toMatchObject({ size: 2, top: 4, durationSeconds: 20, reactionSeconds: 0.4 })
        expect(out.results).toHaveLength(4)
        for (const r of out.results)
            expect(Object.keys(r)).toEqual(expect.arrayContaining(['dps', 'dpsUnderPressure', 'risk']))
        const ranks = out.results.map((r: { dpsUnderPressure: number }) => r.dpsUnderPressure)
        expect(ranks).toEqual([...ranks].sort((a, b) => b - a))
    }, 60_000)

    it('sim:search rejects a missing --size or flag value', () => {
        const script = fileURLToPath(new URL('../scripts/sim-search.ts', import.meta.url))
        expect(() => execFileSync('npx', ['tsx', script], { encoding: 'utf8', stdio: 'pipe' })).toThrow(
            /--size is required/,
        )
        // a flag never swallows the next flag as its value
        expect(() =>
            execFileSync('npx', ['tsx', script, '--pool', '--size', '2'], { encoding: 'utf8', stdio: 'pipe' }),
        ).toThrow(/--pool needs a value/)
    }, 30_000)
})
