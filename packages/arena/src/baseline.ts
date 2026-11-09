import { isValidLoadout, type SpellId } from '@magus/engine'
import { fail, isRecord, number, record } from './validate'

/** One setup from the dummy-DPS search (`sim:search`), best first. */
export interface BaselineLoadout {
    /** 1-based position in the table: the search's ranking order. */
    readonly rank: number
    readonly loadout: readonly SpellId[]
    /** Damage per second on a passive dummy, and under the search's Counterspell-pressure model. */
    readonly dps: number
    readonly dpsUnderPressure: number
}

/** A version's small dummy-DPS table, used to choose tournament entrants. File: `baselines/<version>.json`. */
export interface Baseline {
    /** The engine version the table was generated for (`ENGINE_VERSION`). */
    readonly version: string
    readonly loadouts: readonly BaselineLoadout[]
}

const KEYS = ['version', 'generatedBy', 'loadouts']
const LOADOUT_KEYS = ['rank', 'loadout', 'dps', 'dpsUnderPressure']

/**
 * Checks a baseline file: the version it names, and distinct valid loadouts ranked 1, 2, 3, ... in order. Throws a
 * `ProfileError` naming the first bad key.
 */
export const parseBaseline = (raw: unknown, expectedVersion?: string): Baseline => {
    if (!isRecord(raw)) fail('baseline', 'must be an object')
    const value = record(raw, '', KEYS)
    if (typeof value.version !== 'string' || value.version === '') fail('version', 'must be a non-empty string')
    const version = value.version as string
    if (expectedVersion !== undefined && version !== expectedVersion)
        fail('version', `is ${JSON.stringify(version)}, expected ${JSON.stringify(expectedVersion)}`)
    if (!Array.isArray(value.loadouts) || value.loadouts.length === 0) fail('loadouts', 'must be a non-empty array')
    const seen = new Set<string>()
    const loadouts = (value.loadouts as unknown[]).map((entry, i): BaselineLoadout => {
        const path = `loadouts[${i}]`
        const item = record(entry, path, LOADOUT_KEYS)
        if (item.rank !== i + 1) fail(`${path}.rank`, `must be ${i + 1} (the table is in rank order)`)
        if (!isValidLoadout(item.loadout)) fail(`${path}.loadout`, 'is not a valid loadout')
        const key = item.loadout.join()
        if (seen.has(key)) fail(`${path}.loadout`, 'is listed twice')
        seen.add(key)
        return {
            rank: i + 1,
            loadout: Object.freeze([...item.loadout]),
            dps: number(item.dps, `${path}.dps`, 0, Infinity),
            dpsUnderPressure: number(item.dpsUnderPressure, `${path}.dpsUnderPressure`, 0, Infinity),
        }
    })
    return { version, loadouts }
}
