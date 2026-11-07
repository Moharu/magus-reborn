import { isValidLoadout, LOADOUT_SIZE } from './catalog'
import { BEST_OF_OPTIONS, type BestOf, type ClientMessage, type LobbySettings } from './protocol'

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const isSpellIndex = (value: unknown): value is number =>
    Number.isInteger(value) && (value as number) >= 0 && (value as number) < LOADOUT_SIZE

/** Numbers only need to be finite: the lobby clamps them to the allowed range. */
const SETTING_CHECKS: { [K in keyof LobbySettings]: (value: unknown) => boolean } = {
    bestOf: value => BEST_OF_OPTIONS.includes(value as BestOf),
    setupTime: Number.isFinite,
    allowSpellChange: value => typeof value === 'boolean',
    maxSpectators: Number.isFinite,
}

const parseSettings = (raw: unknown): Partial<LobbySettings> | null => {
    if (!isRecord(raw)) return null
    const valid = Object.entries(raw).every(
        ([key, value]) => Object.hasOwn(SETTING_CHECKS, key) && SETTING_CHECKS[key as keyof LobbySettings](value),
    )
    return valid ? { ...raw } : null
}

/**
 * Checks a decoded frame from a client. Returns the message, holding only the fields the protocol defines, or null if
 * it is not a valid message. All of it is valid or none of it is: one bad setting rejects the whole patch.
 */
export const parseClientMessage = (raw: unknown): ClientMessage | null => {
    if (!isRecord(raw)) return null
    switch (raw.t) {
        case 'ready':
        case 'unready':
            return { t: raw.t }
        case 'set_spells':
            return isValidLoadout(raw.spells) ? { t: raw.t, spells: [...raw.spells] } : null
        case 'start_cast':
        case 'stop_cast':
            return isSpellIndex(raw.i) ? { t: raw.t, i: raw.i } : null
        case 'settings': {
            const settings = parseSettings(raw.settings)
            return settings && { t: raw.t, settings }
        }
        case 'ping':
            // 1e999 decodes to Infinity, which wouldn't survive being echoed back as JSON
            return Number.isFinite(raw.at) ? { t: raw.t, at: raw.at as number } : null
        default:
            return null
    }
}
