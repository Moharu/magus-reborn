import type { EffectReducers, School, SpellDefinition, SpellId } from './types'
import { Afterburn } from './spells/fire/afterburn'
import { Combustion } from './spells/fire/combustion'
import { Fireball } from './spells/fire/fireball'
import { Ignite, igniteDebuffReducer } from './spells/fire/ignite'
import { LivingBomb, livingBombDebuffReducer } from './spells/fire/living-bomb'
import { Meteor } from './spells/fire/meteor'
import { Blur, blurBuffReducer } from './spells/general/blur'
import { Counterspell } from './spells/general/counterspell'
import { Haste, hasteBuffReducer } from './spells/general/haste'
import { MagicEater, magicEaterBuffReducer } from './spells/general/magic-eater'
import { TemporalShield, temporalShieldBuffReducer } from './spells/general/temporal-shield'

/** Grimoire order matches the original game. */
export const SPELLS: Record<SpellId, SpellDefinition> = {
    SPELL_FIREBALL: Fireball,
    SPELL_IGNITE: Ignite,
    SPELL_COMBUSTION: Combustion,
    SPELL_AFTERBURN: Afterburn,
    SPELL_LIVING_BOMB: LivingBomb,
    SPELL_METEOR: Meteor,
    SPELL_HASTE: Haste,
    SPELL_COUNTERSPELL: Counterspell,
    SPELL_TEMPORAL_SHIELD: TemporalShield,
    SPELL_MAGIC_EATER: MagicEater,
    SPELL_BLUR: Blur,
}

export const SPELL_IDS = Object.keys(SPELLS) as SpellId[]

export const EFFECT_REDUCERS: EffectReducers = {
    DEBUFF_IGNITE: igniteDebuffReducer,
    DEBUFF_LIVING_BOMB: livingBombDebuffReducer,
    DEBUFF_COUNTERSPELL: () => {},
    BUFF_HASTE: hasteBuffReducer,
    BUFF_BLUR: blurBuffReducer,
    BUFF_MAGIC_EATER: magicEaterBuffReducer,
    BUFF_TEMPORAL_SHIELD: temporalShieldBuffReducer,
}

/**
 * An element is a spell school a player builds around (Fire, later Frost). It is chosen per match;
 * every school other than GENERAL is one.
 */
export type SpellElement = Exclude<School, 'GENERAL'>

/** The spells one element offers: its own school, and the general pool that every element shares. */
export interface Spellbook {
    element: SpellElement
    elementSpells: readonly SpellId[]
    generalSpells: readonly SpellId[]
}

/** Every player carries Counterspell, in the same slot, whatever their element. */
export const FIXED_SPELL: SpellId = 'SPELL_COUNTERSPELL'
export const ELEMENT_SPELL_COUNT = 4
export const GENERAL_SPELL_COUNT = 2

const spellbook = (element: SpellElement): Spellbook => ({
    element,
    elementSpells: SPELL_IDS.filter(id => SPELLS[id].school === element),
    generalSpells: SPELL_IDS.filter(id => SPELLS[id].school === 'GENERAL' && id !== FIXED_SPELL),
})

export const SPELLBOOKS: Record<SpellElement, Spellbook> = {
    FIRE: spellbook('FIRE'),
}

export const DEFAULT_ELEMENT: SpellElement = 'FIRE'

export type SlotKind = 'element' | 'fixed' | 'general'

/** What each loadout slot holds, in hotkey order: the element spells, then Counterspell, then the general spells. */
export const LOADOUT_SLOTS: readonly SlotKind[] = [
    ...Array<SlotKind>(ELEMENT_SPELL_COUNT).fill('element'),
    'fixed',
    ...Array<SlotKind>(GENERAL_SPELL_COUNT).fill('general'),
]

export const LOADOUT_SIZE = LOADOUT_SLOTS.length
export const FIXED_SLOT = LOADOUT_SLOTS.indexOf('fixed')
/** Default hotkey labels per slot. Counterspell's is Space (the key's `KeyboardEvent.code`). */
export const HOTKEYS = ['Q', 'W', 'E', 'R', 'Space', 'D', 'F'] as const

/** Placeholder until the owner picks a 0.2 default: the 0.1 default plus Afterburn as the 4th Fire spell. */
export const DEFAULT_SPELLS: SpellId[] = [
    'SPELL_FIREBALL',
    'SPELL_IGNITE',
    'SPELL_COMBUSTION',
    'SPELL_AFTERBURN',
    'SPELL_COUNTERSPELL',
    'SPELL_HASTE',
    'SPELL_TEMPORAL_SHIELD',
]

export const isSpellId = (id: unknown): id is SpellId => typeof id === 'string' && Object.hasOwn(SPELLS, id)

const slotAccepts = (book: Spellbook, kind: SlotKind, id: SpellId) =>
    kind === 'fixed' ? id === FIXED_SPELL : (kind === 'element' ? book.elementSpells : book.generalSpells).includes(id)

/**
 * A loadout is valid for an element when it has one distinct, known spell per slot and each slot
 * holds its kind: an element spell, Counterspell, or a general spell.
 */
export const isValidLoadout = (spells: unknown, element: SpellElement = DEFAULT_ELEMENT): spells is SpellId[] =>
    Object.hasOwn(SPELLBOOKS, element) &&
    Array.isArray(spells) &&
    spells.length === LOADOUT_SIZE &&
    spells.every(isSpellId) &&
    new Set(spells).size === LOADOUT_SIZE &&
    LOADOUT_SLOTS.every((kind, i) => slotAccepts(SPELLBOOKS[element], kind, spells[i]))
