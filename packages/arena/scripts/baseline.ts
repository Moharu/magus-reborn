// Usage: npm run arena:baseline -- [--top K]
// Prints the dummy-DPS baseline table for the current engine version as JSON: the K best distinct loadouts of the
// 0.2 `sim:search` (dpsUnderPressure, then dps; K defaults to 16), best first. Redirect it to
// packages/arena/baselines/<ENGINE_VERSION>.json. One process, about a minute and a half of CPU.
import { ENGINE_VERSION, search } from '@magus/engine'

const args = process.argv.slice(2)
const topIndex = args.indexOf('--top')
const top = topIndex === -1 ? 16 : Number(args[topIndex + 1])
if (!(Number.isInteger(top) && top >= 1)) {
    console.error('--top must be a positive integer')
    process.exit(1)
}

// every loadout, not folded with equivalent ones: loadouts that differ only in spells the dummy never makes use of
// still play differently against a player
const { results } = search({ top: Infinity, dedupe: false })
const seen = new Set<string>()
const loadouts = []
for (const { loadout, dps, dpsUnderPressure } of results) {
    const key = loadout.join()
    if (seen.has(key)) continue // a loadout's best policy is listed first
    seen.add(key)
    loadouts.push({ rank: loadouts.length + 1, loadout, dps, dpsUnderPressure })
    if (loadouts.length === top) break
}
console.log(
    JSON.stringify(
        { version: ENGINE_VERSION, generatedBy: `npm run arena:baseline -- --top ${top}`, loadouts },
        null,
        4,
    ),
)
