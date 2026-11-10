import { DEFAULT_ELEMENT, ELEMENTS, isValidLoadout, type SpellElement, type SpellId } from '@magus/engine'
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

/**
 * A version's small dummy-DPS table for one element, used to choose tournament entrants (#150: one table per element).
 * Files: `baselines/<version>.json` (Fire) and `baselines/<version>-<element>.json` for the others (`-frost`).
 */
export interface Baseline {
    /** The engine version the table was generated for (`ENGINE_VERSION`). */
    readonly version: string
    /**
     * The element every loadout of the table plays (#150). A file without an `element` key is Fire (the pre-#150
     * tables); `parseBaseline` always sets it, a hand-built table may leave it out (Fire).
     */
    readonly element?: SpellElement
    readonly loadouts: readonly BaselineLoadout[]
}

const KEYS = ['version', 'element', 'generatedBy', 'loadouts']
const LOADOUT_KEYS = ['rank', 'loadout', 'dps', 'dpsUnderPressure']

/** The element of a table: its `element`, or Fire. */
export const baselineElement = (baseline: Baseline): SpellElement => baseline.element ?? DEFAULT_ELEMENT

/** The file name of a version's table for `element`, under `baselines/`. */
export const baselineFile = (version: string, element: SpellElement = DEFAULT_ELEMENT) =>
    element === DEFAULT_ELEMENT ? `${version}.json` : `${version}-${element.toLowerCase()}.json`

/**
 * Checks a baseline file: the version it names, its element (absent: Fire), and distinct loadouts of that element
 * ranked 1, 2, 3, ... in order. With `expectedElement`, a table of another element is rejected. Throws a
 * `ProfileError` naming the first bad key.
 */
export const parseBaseline = (raw: unknown, expectedVersion?: string, expectedElement?: SpellElement): Baseline => {
    if (!isRecord(raw)) fail('baseline', 'must be an object')
    const value = record(raw, '', KEYS)
    if (typeof value.version !== 'string' || value.version === '') fail('version', 'must be a non-empty string')
    const version = value.version as string
    if (expectedVersion !== undefined && version !== expectedVersion)
        fail('version', `is ${JSON.stringify(version)}, expected ${JSON.stringify(expectedVersion)}`)
    const element = (value.element ?? DEFAULT_ELEMENT) as SpellElement
    if (!(ELEMENTS as unknown[]).includes(element)) fail('element', `must be one of ${ELEMENTS.join(', ')}`)
    if (expectedElement !== undefined && element !== expectedElement)
        fail('element', `is ${element}, expected ${expectedElement}`)
    if (!Array.isArray(value.loadouts) || value.loadouts.length === 0) fail('loadouts', 'must be a non-empty array')
    const seen = new Set<string>()
    const loadouts = (value.loadouts as unknown[]).map((entry, i): BaselineLoadout => {
        const path = `loadouts[${i}]`
        const item = record(entry, path, LOADOUT_KEYS)
        if (item.rank !== i + 1) fail(`${path}.rank`, `must be ${i + 1} (the table is in rank order)`)
        if (!isValidLoadout(item.loadout, element)) fail(`${path}.loadout`, `is not a valid ${element} loadout`)
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
    return { version, element, loadouts }
}
