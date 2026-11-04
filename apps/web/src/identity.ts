import { DEFAULT_SPELLS, isValidLoadout, type SpellId } from '@magus/engine'
import { sanitizeName } from '@magus/engine/protocol'

const KEYS = {
    playerId: 'magus.playerId',
    name: 'magus.name',
    loadout: 'magus.loadout',
    advanced: 'magus.advancedDescriptions',
}

const read = (key: string) => {
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}

const write = (key: string, value: string) => {
    try {
        localStorage.setItem(key, value)
    } catch {
        // storage unavailable (private mode); identity just won't persist
    }
}

/** Random per-browser id. Doubles as the reconnect token, so it is never shown to others. */
export const playerId = (() => {
    let id = read(KEYS.playerId)
    if (!id) {
        id = crypto.randomUUID()
        write(KEYS.playerId, id)
    }
    return id
})()

export const getName = () => read(KEYS.name) ?? ''
export const setName = (name: string) => write(KEYS.name, sanitizeName(name, ''))

export const getLoadout = (): SpellId[] => {
    try {
        const stored = JSON.parse(read(KEYS.loadout) ?? 'null')
        if (isValidLoadout(stored)) return stored
    } catch {
        // fall through to defaults
    }
    return [...DEFAULT_SPELLS]
}
export const setLoadout = (spells: SpellId[]) => write(KEYS.loadout, JSON.stringify(spells))

export const getAdvancedDescriptions = () => read(KEYS.advanced) === 'true'
export const setAdvancedDescriptions = (value: boolean) => write(KEYS.advanced, String(value))
