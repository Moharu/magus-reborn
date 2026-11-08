import { HOTKEYS } from '@magus/engine'

/** `KeyboardEvent.code` of the key for a hotkey label: 'Q' is KeyQ, 'Space' stays Space. */
const codeOf = (label: string) => (label.length === 1 ? `Key${label}` : label)

/** Maps a pressed key to its spell slot. Derived from `HOTKEYS`, so labels and input cannot drift apart. */
export const KEY_CODES: Record<string, number> = Object.fromEntries(HOTKEYS.map((label, i) => [codeOf(label), i]))
