import {
    FIXED_SLOT,
    isValidLoadout,
    LOADOUT_SLOTS,
    SPELLBOOKS,
    type SlotKind,
    type SpellElement,
    type SpellId,
} from '@magus/engine'

/** What is picked up and waiting for a target: a spellbook spell or a bar slot. */
export type Selection = { kind: 'slot'; index: number } | { kind: 'spell'; id: SpellId } | null

/** What a click or drop lands on. */
export type Target = { kind: 'slot'; index: number } | { kind: 'spell'; id: SpellId }

export interface LoadoutState {
    loadout: SpellId[]
    selection: Selection
}

/** The loadout rules are the engine's; the picker only asks. */
export const loadoutValid = (loadout: unknown, element: SpellElement): boolean => isValidLoadout(loadout, element)

/** Whether a slot can ever hold this spell, ignoring what is there now. */
export const slotAccepts = (kind: SlotKind, id: SpellId, element: SpellElement) => {
    const book = SPELLBOOKS[element]
    return kind === 'element' ? book.elementSpells.includes(id) : kind === 'general' && book.generalSpells.includes(id)
}

/** Which slot kind a spellbook spell belongs to, or null for the fixed Counterspell. */
export const kindOfSpell = (id: SpellId, element: SpellElement): SlotKind | null =>
    slotAccepts('element', id, element) ? 'element' : slotAccepts('general', id, element) ? 'general' : null

/**
 * Puts a spell in a slot. A spell that is already on the bar trades places with the slot's current
 * spell. Anything that would break the loadout rules (fixed slot, wrong section) is refused and
 * returns the same array.
 */
export const placeSpell = (loadout: SpellId[], index: number, id: SpellId, element: SpellElement): SpellId[] => {
    if (index === FIXED_SLOT || !slotAccepts(LOADOUT_SLOTS[index], id, element)) return loadout
    const next = [...loadout]
    const from = next.indexOf(id)
    if (from !== -1) next[from] = next[index]
    next[index] = id
    return loadoutValid(next, element) ? next : loadout
}

/** Swaps two bar slots. Refused when either is the fixed slot or the spells would land in the wrong section. */
export const swapSlots = (loadout: SpellId[], a: number, b: number, element: SpellElement): SpellId[] => {
    if (a === b || a === FIXED_SLOT || b === FIXED_SLOT) return loadout
    const next = [...loadout]
    ;[next[a], next[b]] = [next[b], next[a]]
    return loadoutValid(next, element) ? next : loadout
}

/**
 * Moves `from` onto `to`: spell onto slot places it, slot onto slot swaps them, slot onto spell
 * puts that spell in the slot. Two spellbook spells do nothing.
 */
export const drop = (loadout: SpellId[], from: Target, to: Target, element: SpellElement): SpellId[] => {
    if (from.kind === 'spell') return to.kind === 'slot' ? placeSpell(loadout, to.index, from.id, element) : loadout
    return to.kind === 'slot'
        ? swapSlots(loadout, from.index, to.index, element)
        : placeSpell(loadout, from.index, to.id, element)
}

const sameTarget = (a: Target, b: Target) =>
    a.kind === 'slot' ? b.kind === 'slot' && a.index === b.index : b.kind === 'spell' && a.id === b.id

/** Whether `target` is somewhere the current selection could go. Used to light up valid targets. */
export const canTarget = (loadout: SpellId[], selection: Selection, target: Target, element: SpellElement) => {
    if (!selection) return false
    const from: Target = selection
    return drop(loadout, from, target, element) !== loadout
}

/**
 * Click-then-click. The first click selects (the fixed slot cannot be selected); the second either
 * completes the move or, if it is not a valid target, moves the selection there. Clicking the
 * selected item again clears it.
 */
export const click = (state: LoadoutState, target: Target, element: SpellElement): LoadoutState => {
    const { loadout, selection } = state
    if (target.kind === 'slot' && target.index === FIXED_SLOT) return { loadout, selection: null }
    if (!selection) return { loadout, selection: target }
    if (sameTarget(selection, target)) return { loadout, selection: null }
    const next = drop(loadout, selection, target, element)
    if (next !== loadout) return { loadout: next, selection: null }
    return { loadout, selection: target }
}
