import { EFFECT_REDUCERS, isSpellId, secondsToTicks, type EffectId, type SpellId } from '@magus/engine'
import type { ArenaView, EffectView } from './types'
import { fail, isRecord, number, onlyKeys } from './validate'

/**
 * A condition a profile rule needs, as data. Conditions read only the `ArenaView` (what a real client shows) and the
 * profile's own decision this tick (`nextCastIs`); never the engine. Thresholds are in HP, counts in effects, times in
 * seconds.
 */
export type Condition =
    /** Own HP strictly below `hp`. */
    | { type: 'selfHpBelow'; hp: number }
    /** Own HP at or above `hp`. */
    | { type: 'selfHpAtLeast'; hp: number }
    /** Enemy HP strictly below `hp`. */
    | { type: 'enemyHpBelow'; hp: number }
    /** Enemy HP at or above `hp`. */
    | { type: 'enemyHpAtLeast'; hp: number }
    /** At least `count` effects with id `effect` on yourself, e.g. 2+ Ignites before Blur. */
    | { type: 'selfEffectsAtLeast'; effect: EffectId; count: number }
    /** Fewer than `count` effects with id `effect` on yourself. */
    | { type: 'selfEffectsBelow'; effect: EffectId; count: number }
    /** At least `count` effects with id `effect` on the enemy, e.g. Combustion at 6+ Ignites. */
    | { type: 'enemyEffectsAtLeast'; effect: EffectId; count: number }
    /** Fewer than `count` effects with id `effect` on the enemy. */
    | { type: 'enemyEffectsBelow'; effect: EffectId; count: number }
    /** You have a cast in progress (one you are not releasing or cancelling this tick). */
    | { type: 'selfCasting' }
    /** You have no cast in progress, so an instant would not cancel anything. */
    | { type: 'selfNotCasting' }
    /** The enemy's cast bar shows a cast, of one of `spells` if given. */
    | { type: 'enemyCasting'; spells?: SpellId[] }
    /** The enemy's cast bar is empty. */
    | { type: 'enemyNotCasting' }
    /** The enemy's visible cast (of one of `spells` if given) completes within `seconds`, e.g. Temporal Shield. */
    | { type: 'enemyCastEndsWithin'; seconds: number; spells?: SpellId[] }
    /** The enemy is under a Counterspell lock. */
    | { type: 'enemyLocked' }
    /** The cast this profile is about to start this tick is one of `spells`, e.g. Haste before Meteor. */
    | { type: 'nextCastIs'; spells: SpellId[] }

export type ConditionType = Condition['type']

/** What a condition may read: the player's view, and the cast the profile itself decided to start this tick. */
export interface ConditionInput {
    readonly view: ArenaView
    /** Whether the player still has a cast in progress after this tick's release or cancel. */
    readonly casting: boolean
    /** The spell the profile starts this tick, or null. */
    readonly nextCast: SpellId | null
}

const EFFECT_IDS = Object.keys(EFFECT_REDUCERS) as EffectId[]
const MAX_COUNT = 100
const MAX_SECONDS = 10

const count = (effects: readonly EffectView[], id: EffectId) => {
    let n = 0
    for (let i = 0; i < effects.length; i++) if (effects[i].id === id) n += 1
    return n
}

/** Whether `condition` holds. A pure read of `input`. */
export const conditionHolds = (condition: Condition, { view, casting, nextCast }: ConditionInput): boolean => {
    const { self, enemy, tick } = view
    switch (condition.type) {
        case 'selfHpBelow':
            return self.hp < condition.hp
        case 'selfHpAtLeast':
            return self.hp >= condition.hp
        case 'enemyHpBelow':
            return enemy.hp < condition.hp
        case 'enemyHpAtLeast':
            return enemy.hp >= condition.hp
        case 'selfEffectsAtLeast':
            return count(self.effects, condition.effect) >= condition.count
        case 'selfEffectsBelow':
            return count(self.effects, condition.effect) < condition.count
        case 'enemyEffectsAtLeast':
            return count(enemy.effects, condition.effect) >= condition.count
        case 'enemyEffectsBelow':
            return count(enemy.effects, condition.effect) < condition.count
        case 'selfCasting':
            return casting
        case 'selfNotCasting':
            return !casting
        case 'enemyCasting':
            return enemy.casting !== null && (!condition.spells || condition.spells.includes(enemy.casting.spellId))
        case 'enemyNotCasting':
            return enemy.casting === null
        case 'enemyCastEndsWithin':
            return (
                enemy.casting !== null &&
                (!condition.spells || condition.spells.includes(enemy.casting.spellId)) &&
                enemy.casting.completesAt - tick <= secondsToTicks(condition.seconds)
            )
        case 'enemyLocked':
            return enemy.lockedUntil > tick
        case 'nextCastIs':
            return nextCast !== null && condition.spells.includes(nextCast)
    }
}

/** Every condition in `when` holds (an empty list always holds). */
export const allHold = (when: readonly Condition[], input: ConditionInput) => {
    for (let i = 0; i < when.length; i++) if (!conditionHolds(when[i], input)) return false
    return true
}

const hp = (raw: Record<string, unknown>, path: string) => number(raw.hp, `${path}.hp`, 0, 100)

const effectCount = (raw: Record<string, unknown>, path: string) => {
    if (!(EFFECT_IDS as unknown[]).includes(raw.effect))
        fail(`${path}.effect`, `must be an effect id (${EFFECT_IDS.join(', ')})`)
    return { effect: raw.effect as EffectId, count: number(raw.count, `${path}.count`, 0, MAX_COUNT, true) }
}

/** A non-empty list of distinct spell ids. */
export const spellList = (raw: unknown, path: string): SpellId[] => {
    if (!Array.isArray(raw) || raw.length === 0) fail(path, 'must be a non-empty array of spell ids')
    raw.forEach((id, i) => {
        if (!isSpellId(id)) fail(`${path}[${i}]`, `unknown spell id ${JSON.stringify(id)}`)
        if (raw.indexOf(id) !== i) fail(`${path}[${i}]`, `${id} is listed twice`)
    })
    return [...(raw as SpellId[])]
}

const KEYS: Record<ConditionType, readonly string[]> = {
    selfHpBelow: ['hp'],
    selfHpAtLeast: ['hp'],
    enemyHpBelow: ['hp'],
    enemyHpAtLeast: ['hp'],
    selfEffectsAtLeast: ['effect', 'count'],
    selfEffectsBelow: ['effect', 'count'],
    enemyEffectsAtLeast: ['effect', 'count'],
    enemyEffectsBelow: ['effect', 'count'],
    selfCasting: [],
    selfNotCasting: [],
    enemyCasting: ['spells'],
    enemyNotCasting: [],
    enemyCastEndsWithin: ['seconds', 'spells'],
    enemyLocked: [],
    nextCastIs: ['spells'],
}

/** Throws an error naming the key unless `raw` is a valid condition. */
export const parseCondition = (raw: unknown, path: string): Condition => {
    if (!isRecord(raw)) fail(path, 'must be a condition object')
    const type = raw.type as ConditionType
    if (typeof type !== 'string' || !Object.hasOwn(KEYS, type))
        fail(`${path}.type`, `unknown condition type ${JSON.stringify(raw.type)} (${Object.keys(KEYS).join(', ')})`)
    onlyKeys(raw, ['type', ...KEYS[type]], path)
    const spells = (key: 'spells', optional: boolean) =>
        raw[key] === undefined && optional ? undefined : spellList(raw[key], `${path}.${key}`)
    switch (type) {
        case 'selfHpBelow':
        case 'selfHpAtLeast':
        case 'enemyHpBelow':
        case 'enemyHpAtLeast':
            return { type, hp: hp(raw, path) }
        case 'selfEffectsAtLeast':
        case 'selfEffectsBelow':
        case 'enemyEffectsAtLeast':
        case 'enemyEffectsBelow':
            return { type, ...effectCount(raw, path) }
        case 'selfCasting':
        case 'selfNotCasting':
        case 'enemyNotCasting':
        case 'enemyLocked':
            return { type }
        case 'enemyCasting': {
            const list = spells('spells', true)
            return list ? { type, spells: list } : { type }
        }
        case 'enemyCastEndsWithin': {
            const seconds = number(raw.seconds, `${path}.seconds`, 0, MAX_SECONDS)
            const list = spells('spells', true)
            return list ? { type, seconds, spells: list } : { type, seconds }
        }
        case 'nextCastIs':
            return { type, spells: spells('spells', false)! }
    }
}

/** A `when` list: an array of conditions, all of which must hold. */
export const parseWhen = (raw: unknown, path: string): Condition[] => {
    if (!Array.isArray(raw)) fail(path, 'must be an array of conditions')
    return raw.map((condition, i) => parseCondition(condition, `${path}[${i}]`))
}
