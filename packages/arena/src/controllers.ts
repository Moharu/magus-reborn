import { FIXED_SPELL, type SpellId } from '@magus/engine'
import type { Action, ControllerFactory } from './types'

const MAX_CACHED_SLOTS = 16
const cached = (type: Action['type']) =>
    Array.from({ length: MAX_CACHED_SLOTS }, (_, slot): Action => Object.freeze({ type, slot }))
const STARTS = cached('start')
const STOPS = cached('stop')

/** A shared, frozen `start` action, so controllers don't allocate one per tick. */
export const start = (slot: number): Action => STARTS[slot] ?? { type: 'start', slot }
/** A shared, frozen `stop` action. */
export const stop = (slot: number): Action => STOPS[slot] ?? { type: 'stop', slot }

/** Never casts anything. */
export const idle = (): ControllerFactory => () => () => null

export interface PriorityOptions {
    /** Spells to start, highest priority first. Default: the loadout order without Counterspell. */
    order?: readonly SpellId[]
    /**
     * Release a cast this many extra ticks after it completes: a seeded integer in [0, releaseJitterTicks] per cast.
     * Default 0, releasing on the first tick it can.
     */
    releaseJitterTicks?: number
    /** Counterspell every visible enemy cast once this reaction time (in ticks) has passed. Off by default. */
    counter?: {
        reactionTicks: number
        /** Adds a seeded integer in [0, jitterTicks] to the reaction, drawn once per enemy cast. Default 0. */
        jitterTicks?: number
    }
}

const nonNegativeInteger = (name: string, value: number) => {
    if (!(Number.isInteger(value) && value >= 0))
        throw new Error(`${name} must be a non-negative integer, got ${value}`)
    return value
}

/**
 * A trivial example controller to exercise the runner, not a behaviour profile: optionally Counterspell a visible enemy
 * cast after a (seeded) reaction time; otherwise release its own cast once it completes; otherwise start the first
 * spell in `order` that the engine reports ready.
 */
export const priority =
    (options: PriorityOptions = {}): ControllerFactory =>
    ({ loadout, rng }) => {
        const ids = options.order ?? loadout.filter(id => id !== FIXED_SPELL)
        const order = ids.map(id => {
            const slot = loadout.indexOf(id)
            if (slot === -1) throw new Error(`priority: ${id} is not on the loadout`)
            return slot
        })
        const releaseJitter = nonNegativeInteger('releaseJitterTicks', options.releaseJitterTicks ?? 0)
        const counter = options.counter
        const reaction = counter ? nonNegativeInteger('counter.reactionTicks', counter.reactionTicks) : 0
        const reactionJitter = counter ? nonNegativeInteger('counter.jitterTicks', counter.jitterTicks ?? 0) : 0
        const counterSlot = counter ? loadout.indexOf(FIXED_SPELL) : -1

        // keyed by the cast's start tick: one draw per cast, kept across the ticks it lasts
        let releaseFor = -1
        let releaseAt = 0
        let reactFor = -1
        let reactAt = 0

        return ({ tick, self, enemy }) => {
            if (counterSlot !== -1 && enemy.casting) {
                if (reactFor !== enemy.casting.startTick) {
                    reactFor = enemy.casting.startTick
                    reactAt = reactFor + reaction + (reactionJitter ? rng.int(reactionJitter + 1) : 0)
                }
                if (tick >= reactAt && self.spells[counterSlot].ready) return start(counterSlot)
            }
            if (self.casting) {
                if (releaseFor !== self.casting.startTick) {
                    releaseFor = self.casting.startTick
                    releaseAt = self.casting.completesAt + (releaseJitter ? rng.int(releaseJitter + 1) : 0)
                }
                return tick >= releaseAt ? stop(self.casting.slot) : null
            }
            for (const slot of order) if (self.spells[slot].ready) return start(slot)
            return null
        }
    }
