// Usage: npm run arena:baseline -- [--element fire|frost] [--top K] [--out FILE]
// Prints the dummy-DPS baseline table for the current engine version and one element (default Fire) as JSON: the K best
// distinct loadouts of that element's `sim:search` (dpsUnderPressure, then dps; K defaults to 16), best first. --out FILE
// writes it there (use packages/arena/baselines/<ENGINE_VERSION>.json for Fire and
// packages/arena/baselines/<ENGINE_VERSION>-frost.json for Frost, #150; don't redirect stdout through npm, whose banner
// would corrupt the JSON), otherwise it is printed. One process, about a minute and a half of CPU per element.
import { writeFileSync } from 'node:fs'
import { DEFAULT_ELEMENT, ELEMENTS, ENGINE_VERSION, search, type SpellElement } from '@magus/engine'

const args = process.argv.slice(2)
const topIndex = args.indexOf('--top')
const top = topIndex === -1 ? 16 : Number(args[topIndex + 1])
const outIndex = args.indexOf('--out')
const out = outIndex === -1 ? undefined : args[outIndex + 1]
const elementIndex = args.indexOf('--element')
const element = (elementIndex === -1 ? DEFAULT_ELEMENT : args[elementIndex + 1]?.toUpperCase()) as SpellElement
if (outIndex !== -1 && (out === undefined || out.startsWith('--'))) {
    console.error('--out needs a file')
    process.exit(1)
}
if (!(Number.isInteger(top) && top >= 1)) {
    console.error('--top must be a positive integer')
    process.exit(1)
}
if (!ELEMENTS.includes(element)) {
    console.error(`--element must be one of ${ELEMENTS.map(e => e.toLowerCase()).join(', ')}`)
    process.exit(1)
}

// every loadout, not folded with equivalent ones: loadouts that differ only in spells the dummy never makes use of
// still play differently against a player
const { results } = search({ top: Infinity, dedupe: false, element })
const seen = new Set<string>()
const loadouts = []
for (const { loadout, dps, dpsUnderPressure } of results) {
    const key = loadout.join()
    if (seen.has(key)) continue // a loadout's best policy is listed first
    seen.add(key)
    loadouts.push({ rank: loadouts.length + 1, loadout, dps, dpsUnderPressure })
    if (loadouts.length === top) break
}
const command = `npm run arena:baseline -- ${element === DEFAULT_ELEMENT ? '' : `--element ${element.toLowerCase()} `}--top ${top}`
// the Fire table keeps its pre-#150 shape (no `element` key: a table without one is Fire)
const table = {
    version: ENGINE_VERSION,
    ...(element === DEFAULT_ELEMENT ? {} : { element }),
    generatedBy: command,
    loadouts,
}
const text = JSON.stringify(table, null, 4) + '\n'
if (out === undefined) process.stdout.write(text)
else writeFileSync(out, text)
