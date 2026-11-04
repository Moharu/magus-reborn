import { secondsToTicks } from '../../constants'
import type { EffectReducer, IgniteDebuff, SpellDefinition } from '../../types'
import { simpleDamage, simpleDebuff } from '../../utils'

export const CAST = 1.6
export const DEBUFF_TOTAL_DAMAGE = 13.3
export const DEBUFF_DURATION = 10

export const Ignite: SpellDefinition = {
    id: 'SPELL_IGNITE',
    school: 'FIRE',
    label: 'Ignite',
    description: 'Deals damage over time.',
    advancedDescription: `Deals ${DEBUFF_TOTAL_DAMAGE} damage over ${DEBUFF_DURATION} seconds.`,
    castSeconds: CAST,
    reducer: (state, { target }) =>
        simpleDebuff<IgniteDebuff>(state, target, {
            id: 'DEBUFF_IGNITE',
            label: 'Ignite',
            source: 'SPELL_IGNITE',
            damage: DEBUFF_TOTAL_DAMAGE,
            duration: secondsToTicks(DEBUFF_DURATION),
        }),
}

export const igniteDebuffReducer: EffectReducer<IgniteDebuff> = (state, { target, enemy }, debuff) =>
    simpleDamage(state, target, debuff.damage / debuff.duration, enemy)
