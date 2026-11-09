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

/** Hide reminders for any touch-capable pointer, including hybrids and misreported Android pointers.
 * Observed touch wins for the rest of the session; synthetic mouse events cannot restore labels.
 */
export const createKeybindVisibility = (
    match: ((query: string) => Pick<MediaQueryList, 'matches' | 'addEventListener'>) | undefined,
    events: Pick<Window, 'addEventListener'>,
) => {
    const queries = ['(pointer: coarse)', '(any-pointer: coarse)', '(hover: none)'].map(q => match?.(q))
    let touched = false
    const listeners = new Set<(visible: boolean) => void>()
    const visible = () => !touched && !queries.some(q => q?.matches)
    const notify = () => listeners.forEach(listener => listener(visible()))
    queries.forEach(q => q?.addEventListener('change', notify))
    events.addEventListener(
        'pointerdown',
        event => {
            if (event.pointerType !== 'touch' || touched) return
            touched = true
            notify()
        },
        { capture: true, passive: true },
    )
    return {
        visible,
        subscribe(listener: (visible: boolean) => void) {
            listeners.add(listener)
            listener(visible())
            return () => {
                listeners.delete(listener)
            }
        },
    }
}

const visibility =
    typeof window === 'undefined' ? undefined : createKeybindVisibility(window.matchMedia?.bind(window), window)

export const keybindsVisible = () => visibility?.visible() ?? true
export const onKeybindVisibilityChange = (listener: (visible: boolean) => void) =>
    visibility?.subscribe(listener) ?? (() => {})

// CSS updates existing picker labels without replacing focused buttons or drag/input owners.
if (typeof document !== 'undefined') {
    onKeybindVisibilityChange(visible => {
        document.documentElement?.classList.toggle('touch-keybinds', !visible)
    })
}
