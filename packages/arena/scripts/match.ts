// Usage: npm run arena:match -- --seed N [--max-ticks T] [--log]
// Plays one match between the two built-in example entrants and prints the summary line (and the log with --log).
import { EXAMPLE_ENTRANTS, formatEvent, formatSummary, runMatch } from '../src'

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

try {
    const seed = integer('seed', flag('seed'), 1)
    const maxTicks = flag('max-ticks') === undefined ? undefined : integer('max-ticks', flag('max-ticks'))
    const withLog = args.includes('--log')
    const result = runMatch({
        seed,
        a: EXAMPLE_ENTRANTS.aggressor,
        b: EXAMPLE_ENTRANTS.counter,
        maxTicks,
        log: withLog,
    })
    const { a, b } = result.stats
    console.log(`a ${EXAMPLE_ENTRANTS.aggressor.name} vs b ${EXAMPLE_ENTRANTS.counter.name}`)
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
