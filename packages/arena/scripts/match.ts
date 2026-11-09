// Usage: npm run arena:match -- --seed N [--max-ticks T] [--log] [--a ARCHETYPE --b ARCHETYPE]
// Plays one match and prints the summary line (and the log with --log): the two built-in example entrants, or with
// --a and --b two of the archetypes in profiles/ (aggressive, patient-counter, bait, defensive).
import {
    ARCHETYPE_NAMES,
    archetypeEntrant,
    EXAMPLE_ENTRANTS,
    formatEvent,
    formatSummary,
    runMatch,
    type ArchetypeName,
    type Entrant,
} from '../src'

const args = process.argv.slice(2)
const flag = (name: string) => {
    const i = args.indexOf(`--${name}`)
    return i === -1 ? undefined : args[i + 1]
}
const integer = (name: string, value: string | undefined, fallback?: number) => {
    if (value === undefined) {
        if (fallback === undefined) throw new Error(`--${name} is required`)
        return fallback
    }
    if (!/^\d+$/.test(value)) throw new Error(`--${name} must be a non-negative integer, got ${value}`)
    return Number(value)
}

const archetype = (side: 'a' | 'b', fallback: Entrant) => {
    const name = flag(side)
    if (name === undefined) return fallback
    if (!(ARCHETYPE_NAMES as string[]).includes(name))
        throw new Error(`--${side} must be one of ${ARCHETYPE_NAMES.join(', ')}, got ${name}`)
    return archetypeEntrant(name as ArchetypeName)
}

try {
    const seed = integer('seed', flag('seed'), 1)
    const maxTicks = flag('max-ticks') === undefined ? undefined : integer('max-ticks', flag('max-ticks'))
    const withLog = args.includes('--log')
    const entrantA = archetype('a', EXAMPLE_ENTRANTS.aggressor)
    const entrantB = archetype('b', EXAMPLE_ENTRANTS.counter)
    const result = runMatch({ seed, a: entrantA, b: entrantB, maxTicks, log: withLog })
    const { a, b } = result.stats
    console.log(`a ${entrantA.name} vs b ${entrantB.name}`)
    if (withLog) for (const event of result.log) console.log(formatEvent(event))
    for (const [side, stats] of [
        ['a', a],
        ['b', b],
    ] as const) {
        console.log(
            `${side} casts=${stats.casts} started=${stats.started} cancelled=${stats.cancelled} ` +
                `interrupts=${stats.interrupts} interrupted=${stats.interrupted} rejected=${stats.rejected} ` +
                `damageTaken=${stats.damageTaken}`,
        )
    }
    console.log(formatSummary(result))
} catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
}
