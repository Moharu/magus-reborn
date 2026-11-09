import { secondsToTicks } from '../../constants'
import type { BattleState, CastContext, EffectReducer, FrostFeverDebuff, SpellDefinition, SpellId } from '../../types'
import { simpleDamage, tickShare, uniqueDebuff } from '../../utils'
import { gainChilling } from './chilling'
import { FROST_NUMBERS } from './numbers'

const { castSeconds, damage, durationSeconds, chillingGain } = FROST_NUMBERS.frostFever

/** The Frost Fever bonus `spell`'s hit gets against `target`: its `frostFeverBonus` entry if the target has the debuff. */
export const frostFeverBonus = (state: BattleState, target: CastContext['target'], spell: SpellId) =>
    state[target].effects.some(effect => effect.id === 'DEBUFF_FROST_FEVER')
        ? (FROST_NUMBERS.frostFeverBonus[spell] ?? 0)
        : 0

/** A Frost spell's direct hit: `base` plus the spell's Frost Fever bonus, if any. The one path Frost hits take. */
export const frostHit = (state: BattleState, { caster, target }: CastContext, spell: SpellId, base: number) =>
    simpleDamage(state, target, base + frostFeverBonus(state, target, spell), caster)

export const FrostFever: SpellDefinition = {
    id: 'SPELL_FROST_FEVER',
    school: 'FROST',
    label: 'Frost Fever',
    description: 'Deals damage over time. Recasting it refreshes the duration.',
    advancedDescription: `Deals ${damage} damage over ${durationSeconds} seconds. Recasting it refreshes the duration; it does not stack.`,
    castSeconds,
    reducer: (state, { caster, target }) => {
        uniqueDebuff<FrostFeverDebuff>(state, target, {
            id: 'DEBUFF_FROST_FEVER',
            label: 'Frost Fever',
            source: 'SPELL_FROST_FEVER',
            damage,
            duration: secondsToTicks(durationSeconds),
        })
        gainChilling(state, caster, chillingGain)
    },
}

export const frostFeverDebuffReducer: EffectReducer<FrostFeverDebuff> = (state, { target, enemy }, debuff) =>
    simpleDamage(state, target, tickShare(debuff.damage, debuff.duration, state.gameTick - debuff.startingTick), enemy)
