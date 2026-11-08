import { HOTKEYS } from '@magus/engine'

/** `KeyboardEvent.code` of the key for a hotkey label: 'Q' is KeyQ, 'Space' stays Space. */
const codeOf = (label: string) => (label.length === 1 ? `Key${label}` : label)

/** Maps a pressed key to its spell slot. Derived from `HOTKEYS`, so labels and input cannot drift apart. */
export const KEY_CODES: Record<string, number> = Object.fromEntries(HOTKEYS.map((label, i) => [codeOf(label), i]))

interface HotkeyTarget {
    tagName?: string
    isContentEditable?: boolean
    closest?: (selector: string) => unknown
}

export interface KeyLike {
    code: string
    repeat?: boolean
    ctrlKey?: boolean
    metaKey?: boolean
    altKey?: boolean
    target?: EventTarget | HotkeyTarget | null
}

/** The slot a key press should cast, or undefined for modified keys, repeats and typing in a field. */
export const hotkeyFor = (event: KeyLike): number | undefined => {
    const index = KEY_CODES[event.code]
    if (index === undefined || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return undefined
    const target = event.target as HotkeyTarget | null | undefined
    // keys typed into a dialog or the loadout picker belong to its buttons (Space activates them)
    if (target?.closest?.('dialog, .picker')) return undefined
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable))
        return undefined
    return index
}

/** Keybind labels only make sense with a keyboard: hide them where the primary input is touch. */
export const keybindsVisible = (
    match: ((query: string) => { matches: boolean }) | undefined = globalThis.matchMedia?.bind(globalThis),
) => !match || !match('(pointer: coarse)').matches
