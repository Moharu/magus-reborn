import { enemyOf, type LogEntry, type PlayerKey, type SpellId } from '@magus/engine'
import type { Side } from './layout'

/** A cast that was interrupted, resolved to what the view draws and where. */
export interface InterruptTell {
    interruptedSide: Side
    casterSide: Side
    /** The spell that was being cast. */
    spell: SpellId
    /** The spell that interrupted it. */
    source: SpellId
}

/**
 * The interrupts in `newLog`. Reads only the engine's INTERRUPTED entries, which exist only when a cast
 * was really interrupted, so a Counterspell that lands on nothing gives no tell, and neither does a cast
 * that ends in any other way.
 */
export const interruptTells = (newLog: LogEntry[], sides: Record<Side, PlayerKey>): InterruptTell[] => {
    const sideOf = (player: PlayerKey): Side => (sides.left === player ? 'left' : 'right')
    const tells: InterruptTell[] = []
    for (const entry of newLog) {
        if (entry.type !== 'INTERRUPTED') continue
        tells.push({
            interruptedSide: sideOf(entry.player),
            casterSide: sideOf(enemyOf(entry.player)),
            spell: entry.spellId,
            source: entry.source,
        })
    }
    return tells
}
