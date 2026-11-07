import type { EffectReducers, SpellDefinition, SpellId } from './types'
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

export const DEFAULT_SPELLS: SpellId[] = [
    'SPELL_FIREBALL',
    'SPELL_IGNITE',
    'SPELL_COMBUSTION',
    'SPELL_HASTE',
    'SPELL_COUNTERSPELL',
    'SPELL_TEMPORAL_SHIELD',
]

export const LOADOUT_SIZE = 6
export const HOTKEYS = ['Q', 'W', 'E', 'A', 'S', 'D'] as const

export const isSpellId = (id: unknown): id is SpellId => typeof id === 'string' && Object.hasOwn(SPELLS, id)

export const isValidLoadout = (spells: unknown): spells is SpellId[] =>
    Array.isArray(spells) &&
    spells.length === LOADOUT_SIZE &&
    spells.every(isSpellId) &&
    new Set(spells).size === LOADOUT_SIZE
