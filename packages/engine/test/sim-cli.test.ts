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
})
