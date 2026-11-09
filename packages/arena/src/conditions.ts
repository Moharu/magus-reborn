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
    /** The real cast this profile starts this tick is one of `spells`, e.g. Haste before Meteor. Never a fake cast. */
    | { type: 'nextCastIs'; spells: SpellId[] }
    /**
     * The real cast this profile starts this tick is the loadout's longest cast (by the public base cast time; any of
     * them on a tie), e.g. Haste on Meteor, or on Combustion for a loadout without Meteor. Never a fake cast.
     */
    | { type: 'nextCastIsLongest' }
    /** An effect with id `effect` on yourself ends within `seconds`, e.g. Temporal Shield before a Living Bomb explodes. */
    | { type: 'selfEffectEndsWithin'; effect: EffectId; seconds: number }
    /** An effect with id `effect` on the enemy ends within `seconds`, e.g. Magic Eater before its Living Bomb explodes. */
    | { type: 'enemyEffectEndsWithin'; effect: EffectId; seconds: number }
    /**
     * At least `count` casts of `spell` released by this player within the last `withinSeconds` (this tick's release
     * included), e.g. Afterburn after a few Fireballs. Counted from the player's own releases, not from the engine.
     */
    | { type: 'selfCastsAtLeast'; spell: SpellId; count: number; withinSeconds: number }
    /** The free-cast window (#123) is open: the enemy can't Counterspell yet, as the profile reads it from the view. */
    | { type: 'inLockoutWindow' }
    /** At least one of the lists in `of` holds (each list: all of its conditions). Lists hold no `anyOf` of their own. */
    | { type: 'anyOf'; of: Condition[][] }

export type ConditionType = Condition['type']

/** One of the player's own releases, as its controller saw it go out. */
export interface OwnRelease {
    readonly spellId: SpellId
    readonly tick: number
}

/**
 * What a condition may read: the player's view, the cast the profile itself decided to start this tick, and what its
 * controller remembers from earlier views (its own releases, whether the free-cast window is open).
 */
export interface ConditionInput {
    readonly view: ArenaView
    /** Whether the player still has a cast in progress after this tick's release or cancel. */
    readonly casting: boolean
    /** The spell the profile starts this tick, or null (also for a fake cast). */
    readonly nextCast: SpellId | null
    /** The loadout's longest casts (`nextCastIsLongest`). Default: none. */
    readonly longest?: readonly SpellId[]
    /** The player's own releases so far, oldest first (`selfCastsAtLeast`). Default: none. */
    readonly releases?: readonly OwnRelease[]
    /** Whether the free-cast window is open (`inLockoutWindow`). Default: false. */
    readonly window?: boolean
}

const EFFECT_IDS = Object.keys(EFFECT_REDUCERS) as EffectId[]
const MAX_COUNT = 100
const MAX_SECONDS = 10

const MAX_WITHIN_SECONDS = 60

const count = (effects: readonly EffectView[], id: EffectId) => {
    let n = 0
    for (let i = 0; i < effects.length; i++) if (effects[i].id === id) n += 1
    return n
}

/** Some effect with id `id` ends within `ticks` of `tick`. */
const endsWithin = (effects: readonly EffectView[], id: EffectId, tick: number, ticks: number) => {
    for (let i = 0; i < effects.length; i++)
        if (effects[i].id === id && effects[i].expiresAt - tick <= ticks) return true
    return false
}

/** Whether `condition` holds. A pure read of `input`. */
export const conditionHolds = (condition: Condition, input: ConditionInput): boolean => {
    const { view, casting, nextCast } = input
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
        case 'nextCastIsLongest':
            return nextCast !== null && (input.longest ?? []).includes(nextCast)
        case 'selfEffectEndsWithin':
            return endsWithin(self.effects, condition.effect, tick, secondsToTicks(condition.seconds))
        case 'enemyEffectEndsWithin':
            return endsWithin(enemy.effects, condition.effect, tick, secondsToTicks(condition.seconds))
        case 'selfCastsAtLeast': {
            const releases = input.releases ?? []
            const from = tick - secondsToTicks(condition.withinSeconds)
            let n = 0
            for (let i = releases.length - 1; i >= 0 && releases[i].tick >= from; i--)
                if (releases[i].spellId === condition.spell) n += 1
            return n >= condition.count
        }
        case 'inLockoutWindow':
            return input.window === true
        case 'anyOf':
            for (const when of condition.of) if (allHold(when, input)) return true
            return false
    }
}

/** Every condition in `when` holds (an empty list always holds). */
export const allHold = (when: readonly Condition[], input: ConditionInput) => {
    for (let i = 0; i < when.length; i++) if (!conditionHolds(when[i], input)) return false
    return true
}

const seconds = (raw: Record<string, unknown>, path: string) => number(raw.seconds, `${path}.seconds`, 0, MAX_SECONDS)

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
    nextCastIsLongest: [],
    selfEffectEndsWithin: ['effect', 'seconds'],
    enemyEffectEndsWithin: ['effect', 'seconds'],
    selfCastsAtLeast: ['spell', 'count', 'withinSeconds'],
    inLockoutWindow: [],
    anyOf: ['of'],
}

/** Throws an error naming the key unless `raw` is a valid condition. Inside an `anyOf`, `nested` forbids another. */
export const parseCondition = (raw: unknown, path: string, nested = false): Condition => {
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
        case 'nextCastIsLongest':
        case 'inLockoutWindow':
            return { type }
        case 'selfEffectEndsWithin':
        case 'enemyEffectEndsWithin': {
            const { effect } = effectCount({ ...raw, count: 0 }, path)
            return { type, effect, seconds: seconds(raw, path) }
        }
        case 'selfCastsAtLeast': {
            if (!isSpellId(raw.spell)) fail(`${path}.spell`, `unknown spell id ${JSON.stringify(raw.spell)}`)
            return {
                type,
                spell: raw.spell as SpellId,
                count: number(raw.count, `${path}.count`, 0, MAX_COUNT, true),
                withinSeconds: number(raw.withinSeconds, `${path}.withinSeconds`, 0, MAX_WITHIN_SECONDS),
            }
        }
        case 'anyOf': {
            if (nested) fail(`${path}.type`, 'an anyOf may not hold another anyOf')
            if (!Array.isArray(raw.of) || raw.of.length === 0) fail(`${path}.of`, 'must be a non-empty array of lists')
            return {
                type,
                of: (raw.of as unknown[]).map((when, i) => {
                    const at = `${path}.of[${i}]`
                    if (!Array.isArray(when) || when.length === 0) fail(at, 'must be a non-empty array of conditions')
                    return (when as unknown[]).map((condition, j) => parseCondition(condition, `${at}[${j}]`, true))
                }),
            }
        }
        case 'enemyCasting': {
            const list = spells('spells', true)
            return list ? { type, spells: list } : { type }
        }
        case 'enemyCastEndsWithin': {
            const within = seconds(raw, path)
            const list = spells('spells', true)
            return list ? { type, seconds: within, spells: list } : { type, seconds: within }
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
