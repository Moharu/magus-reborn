import { secondsToTicks } from '../../constants'
import type { EffectReducer, LivingBombDebuff, SpellDefinition } from '../../types'
import { simpleDamage, uniqueDebuff } from '../../utils'

export const CAST = 1.5
export const DEBUFF_TOTAL_DAMAGE = 7
export const DEBUFF_FINAL_DAMAGE = 21
export const DEBUFF_DURATION = 11

export const LivingBomb: SpellDefinition = {
    id: 'SPELL_LIVING_BOMB',
    school: 'FIRE',
    label: 'Living Bomb',
    description:
        'Deals low damage over time, upon expiration, explodes in a burst of damage. Replaces existing Living Bomb effects.',
    advancedDescription: `Deals ${DEBUFF_TOTAL_DAMAGE} damage over ${DEBUFF_DURATION} seconds, upon expiration, explodes dealing ${DEBUFF_FINAL_DAMAGE} damage. Replaces existing Living Bomb effects.`,
    castSeconds: CAST,
    globalCooldownTicks: 0,
    reducer: (state, { target }) =>
        uniqueDebuff<LivingBombDebuff>(state, target, {
            id: 'DEBUFF_LIVING_BOMB',
            label: 'Living Bomb',
            source: 'SPELL_LIVING_BOMB',
            damage: DEBUFF_TOTAL_DAMAGE,
            expirationDamage: DEBUFF_FINAL_DAMAGE,
            duration: secondsToTicks(DEBUFF_DURATION),
        }),
}

export const livingBombDebuffReducer: EffectReducer<LivingBombDebuff> = (state, { target, enemy }, debuff) => {
    simpleDamage(state, target, debuff.damage / debuff.duration, enemy)
    if (state.gameTick === debuff.startingTick + debuff.duration) {
        simpleDamage(state, target, debuff.expirationDamage, enemy)
    }
}
