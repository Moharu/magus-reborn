import { SPELLS } from './catalog'
import { ticksToSeconds } from './constants'
import type { HpEvent, PlayerKey, SpellId } from './types'

export interface MeterRow {
    source: SpellId
    label: string
    total: number
    hits: number
    share: number
}

export interface MeterSummary {
    total: number
    dps: number
    seconds: number
    rows: MeterRow[]
}

/** Accumulates damage dealt to a target. The fight timer starts at the first hit. */
export class DamageMeter {
    private totals = new Map<SpellId, { total: number; hits: number }>()
    private firstTick: number | null = null
    private lastTick = 0

    constructor(private readonly target: PlayerKey) {}

    record(events: HpEvent[]) {
        for (const event of events) {
            if (event.player !== this.target || event.amount >= 0) continue
            if (this.firstTick === null) this.firstTick = event.tick
            const row = this.totals.get(event.source) ?? { total: 0, hits: 0 }
            row.total += -event.amount
            if (event.kind === 'spell') row.hits += 1
            this.totals.set(event.source, row)
        }
    }

    setTick(tick: number) {
        this.lastTick = tick
    }

    reset() {
        this.totals.clear()
        this.firstTick = null
    }

    summary(): MeterSummary {
        let total = 0
        for (const row of this.totals.values()) total += row.total
        // at least one second, so a single opening hit doesn't read as absurd dps
        const seconds = this.firstTick === null ? 0 : Math.max(1, ticksToSeconds(this.lastTick - this.firstTick))
        const rows = [...this.totals.entries()]
            .map(([source, row]) => ({
                source,
                label: SPELLS[source].label,
                total: row.total,
                hits: row.hits,
                share: total > 0 ? row.total / total : 0,
            }))
            .sort((a, b) => b.total - a.total)
        return { total, dps: seconds > 0 ? total / seconds : 0, seconds, rows }
    }
}
