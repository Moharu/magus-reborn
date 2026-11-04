// Usage:
//   npm run sim -w @magus/engine -- input.json
//   npm run sim -w @magus/engine -- --loadout fireball,ignite --policy ignite,fireball [--duration 60]
// Ids may be given with or without the SPELL_ prefix, case-insensitive. --policy defaults to the loadout order.
import { readFileSync } from 'node:fs'
import { simulate, type SimInput, type SpellId } from '../src'

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
    let input: SimInput
    if (args[0] && !args[0].startsWith('--')) {
        input = JSON.parse(readFileSync(args[0], 'utf8')) as SimInput
    } else {
        const loadout = list(flag('loadout'))
        const policy = flag('policy') ? list(flag('policy')) : loadout
        const duration = flag('duration')
        input = { loadout, policy, ...(duration ? { durationSeconds: Number(duration) } : {}) }
    }
    console.log(JSON.stringify(simulate(input), null, 2))
} catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
}
