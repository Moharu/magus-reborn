import { ticksToSeconds } from '@magus/engine'
import type { MatchEvent, MatchResult } from './types'

/** `<tick> <side> <TYPE> [spell] [source]`, for example `72 b INTERRUPTED SPELL_FIREBALL SPELL_COUNTERSPELL`. */
export const formatEvent = (event: MatchEvent) =>
    [event.tick, event.side, event.type, event.spellId, event.source].filter(part => part !== undefined).join(' ')

/** The summary line: `END winner=<a|b|draw> reason=<...> ticks=<n> seconds=<s> hp=<a>/<b> casts=<a>/<b> ...`. */
export const formatSummary = (result: MatchResult) => {
    const { a, b } = result.stats
    return [
        'END',
        `winner=${result.winner}`,
        `reason=${result.reason}`,
        `ticks=${result.ticks}`,
        `seconds=${ticksToSeconds(result.ticks)}`,
        `hp=${result.hp.a}/${result.hp.b}`,
        `casts=${a.casts}/${b.casts}`,
        `interrupts=${a.interrupts}/${b.interrupts}`,
        `seed=${result.seed}`,
    ].join(' ')
}

/** The whole match log: one line per event, then the summary line. */
export const formatLog = (result: MatchResult) => [...result.log.map(formatEvent), formatSummary(result)].join('\n')
