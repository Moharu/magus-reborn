import { cooldownRemaining } from '../battle'
import { EFFECT_REDUCERS, isSpellId, SPELLS } from '../catalog'
import { secondsToTicks } from '../constants'
import type { BattleState, EffectId, PlayerKey, SpellId } from '../types'

/**
 * A condition a rule needs before its spell is started. Conditions only read engine state (effects on
 * the target, the caster's release log, the enemy's spell cooldowns); they never compute damage.
 */
export type PolicyCondition =
    /** Fewer than `count` effects with id `effect` on the target, e.g. Living Bomb "only if not active" (count 1). */
    | { type: 'targetEffectsBelow'; effect: EffectId; count: number }
    /** At least `count` effects with id `effect` on the target, e.g. Combustion once 5 Ignites are up. */
    | { type: 'targetEffectsAtLeast'; effect: EffectId; count: number }
    /** The caster released `spell` at least `count` times in the last `seconds`, e.g. Afterburn after Fireballs. */
    | { type: 'recentReleasesAtLeast'; spell: SpellId; count: number; seconds: number }
    /** The enemy has no Counterspell ready: it is on cooldown (or not equipped). Holds long casts for the safe window. */
    | { type: 'enemyCounterspellOnCooldown' }

/** Start `spell` if every condition in `when` holds (and the engine accepts it). */
export interface PolicyRule {
    spell: SpellId
    when?: PolicyCondition[]
}

/** A bare spell id is the unconditional rule `{ spell }`. */
export type PolicyEntry = SpellId | PolicyRule

export const toRule = (entry: PolicyEntry): PolicyRule => (typeof entry === 'string' ? { spell: entry } : entry)

const EFFECT_IDS = Object.keys(EFFECT_REDUCERS) as EffectId[]
const isEffectId = (v: unknown): v is EffectId => typeof v === 'string' && (EFFECT_IDS as string[]).includes(v)
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0

/** Throws a readable error unless `raw` is a valid condition. */
export const parseCondition = (raw: unknown): PolicyCondition => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('a condition must be an object')
    const c = raw as Record<string, unknown>
    switch (c.type) {
        case 'targetEffectsBelow':
        case 'targetEffectsAtLeast':
            if (!isEffectId(c.effect)) throw new Error(`${c.type}: "effect" must be an effect id`)
            if (!isCount(c.count)) throw new Error(`${c.type}: "count" must be a non-negative integer`)
            return { type: c.type, effect: c.effect, count: c.count }
        case 'recentReleasesAtLeast':
            if (!isSpellId(c.spell)) throw new Error('recentReleasesAtLeast: "spell" must be a spell id')
            if (!isCount(c.count)) throw new Error('recentReleasesAtLeast: "count" must be a non-negative integer')
            if (!(typeof c.seconds === 'number' && Number.isFinite(c.seconds) && c.seconds > 0))
                throw new Error('recentReleasesAtLeast: "seconds" must be a finite positive number')
            return { type: c.type, spell: c.spell, count: c.count, seconds: c.seconds }
        case 'enemyCounterspellOnCooldown':
            return { type: c.type }
        default:
            throw new Error(`unknown condition type: ${String(c.type)}`)
    }
}

/** Throws a readable error unless `raw` is a spell id or a `{ spell, when? }` rule. */
export const parsePolicyEntry = (raw: unknown): PolicyEntry => {
    if (isSpellId(raw)) return raw
    if (typeof raw === 'string') throw new Error(`unknown spell id: ${raw}`)
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        throw new Error('a policy entry must be a spell id or a { spell, when } rule')
    const { spell, when } = raw as Record<string, unknown>
    if (!isSpellId(spell)) throw new Error('a policy rule needs a valid "spell" id')
    if (when === undefined) return { spell }
    if (!Array.isArray(when)) throw new Error('a policy rule\'s "when" must be an array of conditions')
    return { spell, when: when.map(parseCondition) }
}

/** Whether `condition` holds for `caster` right now. Pure read of the battle state. */
export const conditionHolds = (state: BattleState, caster: PlayerKey, target: PlayerKey, c: PolicyCondition) => {
    switch (c.type) {
        case 'targetEffectsBelow':
        case 'targetEffectsAtLeast': {
            const n = state[target].effects.filter(e => e.id === c.effect).length
            return c.type === 'targetEffectsBelow' ? n < c.count : n >= c.count
        }
        case 'recentReleasesAtLeast': {
            const index = state[caster].spells.findIndex(s => s.id === c.spell)
            if (index === -1) return c.count === 0
            // releases at or after gameTick - seconds, like Afterburn's lookback; but this is read when the
            // cast starts, while Afterburn counts at its release (a heuristic, not an exact prediction)
            const from = Math.max(state.gameTick - secondsToTicks(c.seconds), 0)
            let n = 0
            for (const entry of state.log)
                if (
                    entry.type === 'SPELL_RELEASE' &&
                    entry.caster === caster &&
                    entry.spellIndex === index &&
                    entry.tick >= from
                )
                    n++
            return n >= c.count
        }
        case 'enemyCounterspellOnCooldown':
            return !state[target].spells.some(
                s => s.id === 'SPELL_COUNTERSPELL' && cooldownRemaining(s, state.gameTick) === 0,
            )
    }
}

/**
 * A rule the engine accepts whenever the caster can cast at all: unconditional, cast-time and
 * no cooldown. Anything listed after such a rule can never be reached by a cast-time or on-GCD spell.
 */
export const isTerminalRule = (rule: PolicyRule) => {
    const def = SPELLS[rule.spell]
    return (rule.when ?? []).length === 0 && !!def.castSeconds && !def.cooldownSeconds
}

const short = (id: string) => id.replace(/^(SPELL|DEBUFF|BUFF)_/, '').toLowerCase()

const describeCondition = (c: PolicyCondition) => {
    switch (c.type) {
        case 'targetEffectsBelow':
            return c.count === 1 ? `${short(c.effect)} not active` : `${short(c.effect)} < ${c.count}`
        case 'targetEffectsAtLeast':
            return `${short(c.effect)} >= ${c.count}`
        case 'recentReleasesAtLeast':
            return `${short(c.spell)} x${c.count} in ${c.seconds}s`
        case 'enemyCounterspellOnCooldown':
            return 'enemy counterspell on cooldown'
    }
}

/** Compact, human-readable form, e.g. `ignite [ignite < 4] > combustion [ignite >= 5] > fireball`. */
export const describePolicy = (policy: PolicyEntry[]) =>
    policy
        .map(toRule)
        .map(r => (r.when?.length ? `${short(r.spell)} [${r.when.map(describeCondition).join(', ')}]` : short(r.spell)))
        .join(' > ')
