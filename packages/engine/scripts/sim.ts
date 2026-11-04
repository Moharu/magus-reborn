// Usage:
//   npm run sim -w @magus/engine -- input.json
//   npm run sim -w @magus/engine -- --loadout fireball,ignite --policy ignite,fireball [--duration 60]
// Ids may be given with or without the SPELL_ prefix, case-insensitive. --policy defaults to the loadout order.
import { readFileSync } from 'node:fs'
import { parseSimInput, simulate, type SpellId } from '../src'

const toId = (s: string) => {
    const upper = s.trim().toUpperCase().replace(/-/g, '_')
    return (upper.startsWith('SPELL_') ? upper : `SPELL_${upper}`) as SpellId
}
const list = (s: string | undefined) => (s ?? '').split(',').filter(Boolean).map(toId)

const args = process.argv.slice(2)
const flag = (name: string) => {
    const i = args.indexOf(`--${name}`)
    return i === -1 ? undefined : args[i + 1]
}

try {
    let raw: unknown
    if (args[0] && !args[0].startsWith('--')) {
        raw = JSON.parse(readFileSync(args[0], 'utf8'))
    } else {
        const loadout = list(flag('loadout'))
        const policy = flag('policy') ? list(flag('policy')) : loadout
        const duration = flag('duration')
        raw = { loadout, policy, ...(duration !== undefined ? { durationSeconds: Number(duration) } : {}) }
    }
    console.log(JSON.stringify(simulate(parseSimInput(raw)), null, 2))
} catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
}
