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

    it('sim:search prints the top K 0.2 loadouts by dpsUnderPressure, the same with any --jobs', () => {
        const script = fileURLToPath(new URL('../scripts/sim-search.ts', import.meta.url))
        const run = (jobs: string) =>
            execFileSync(
                'npx',
                [
                    'tsx',
                    script,
                    '--fire',
                    'meteor,fireball,ignite,combustion',
                    '--general',
                    'haste,blur',
                    '--duration',
                    '10',
                    '--cap',
                    '40',
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
        // one loadout, its first 40 policies
        expect(out.evaluated).toBe(40)
        expect(out.pairs).toBe(40)
        expect(out.options).toMatchObject({
            element: 'FIRE',
            loadouts: 1,
            top: 4,
            cap: 40,
            durationSeconds: 10,
            reactionSeconds: 0.4,
        })
        expect(out.results).toHaveLength(4)
        for (const r of out.results) {
            expect(Object.keys(r)).toEqual(expect.arrayContaining(['dps', 'dpsUnderPressure', 'risk']))
            expect(r.loadout).toEqual([
                'SPELL_FIREBALL',
                'SPELL_IGNITE',
                'SPELL_COMBUSTION',
                'SPELL_METEOR',
                'SPELL_COUNTERSPELL',
                'SPELL_HASTE',
                'SPELL_BLUR',
            ])
            expect(r.elementSpells).toEqual(r.loadout.slice(0, 4))
            expect(r.generalSpells).toEqual(['SPELL_HASTE', 'SPELL_BLUR'])
        }
        const ranks = out.results.map((r: { dpsUnderPressure: number }) => r.dpsUnderPressure)
        expect(ranks).toEqual([...ranks].sort((a, b) => b - a))
    }, 60_000)

    it('sim:search searches Frost with --frost or --element frost (#147)', () => {
        const script = fileURLToPath(new URL('../scripts/sim-search.ts', import.meta.url))
        const run = (...flags: string[]) =>
            JSON.parse(
                execFileSync(
                    'npx',
                    [
                        'tsx',
                        script,
                        ...flags,
                        '--general',
                        'haste,blur',
                        '--duration',
                        '5',
                        '--cap',
                        '10',
                        '--top',
                        '2',
                        '--jobs',
                        '1',
                    ],
                    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
                ),
            )
        const out = run('--frost', 'frostbolt,ice_spear,icy_touch,frost_fever')
        expect(out.options).toMatchObject({ element: 'FROST', fire: null, loadouts: 1, cap: 10 })
        expect(out.evaluated).toBe(10)
        for (const r of out.results)
            expect(r.elementSpells).toEqual([
                'SPELL_FROSTBOLT',
                'SPELL_ICE_SPEAR',
                'SPELL_ICY_TOUCH',
                'SPELL_FROST_FEVER',
            ])
        // every Frost set, narrowed by --element instead
        expect(run('--element', 'frost').options).toMatchObject({ element: 'FROST', loadouts: 15 })
    }, 60_000)

    it('sim:search rejects a mismatched or unknown element', () => {
        const script = fileURLToPath(new URL('../scripts/sim-search.ts', import.meta.url))
        const fail = (...args: string[]) =>
            expect(() => execFileSync('npx', ['tsx', script, ...args], { encoding: 'utf8', stdio: 'pipe' }))
        fail('--element', 'water').toThrow(/--element must be one of: fire, frost/)
        fail('--element', 'fire', '--frost', 'frostbolt,glacier,ice_spear,icy_touch').toThrow(/another element/)
        fail('--fire', 'fireball,ignite,combustion,meteor', '--frost', 'frostbolt').toThrow(/give one of them/)
        fail('--frost', 'fireball,glacier,ice_spear,icy_touch').toThrow(/not one of the frost spells/)
    }, 30_000)

    it('sim:search rejects the removed --size and --pool, bad pools and a missing flag value', () => {
        const script = fileURLToPath(new URL('../scripts/sim-search.ts', import.meta.url))
        const fail = (...args: string[]) =>
            expect(() => execFileSync('npx', ['tsx', script, ...args], { encoding: 'utf8', stdio: 'pipe' }))
        fail('--size', '2').toThrow(/--size was removed/)
        fail('--pool', 'fireball').toThrow(/--pool was removed/)
        fail('--fire', 'fireball,ignite').toThrow(/at least 4/)
        fail('--general', 'haste,counterspell').toThrow(/not one of the general spells/)
        // a flag never swallows the next flag as its value
        fail('--fire', '--top', '2').toThrow(/--fire needs a value/)
    }, 30_000)
})
