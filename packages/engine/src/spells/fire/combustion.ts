import type { SpellDefinition } from '../../types'
import { simpleDamage } from '../../utils'

export const CAST = 2.4
export const DAMAGE = 4.2

export const Combustion: SpellDefinition = {
    id: 'SPELL_COMBUSTION',
    school: 'FIRE',
    label: 'Combustion',
    description: 'Deals low damage instantly, plus the damage of all remaining ignite effects.',
    advancedDescription: `Deals ${DAMAGE} damage instantly, plus the damage of all remaining ignite effects.`,
    castSeconds: CAST,
    globalCooldownTicks: 0,
    reducer: (state, { target }) => {
        const player = state[target]
        const igniteDamage = player.effects.reduce((dmg, effect) => {
            if (effect.id === 'DEBUFF_IGNITE') {
                return (
                    dmg + (effect.damage / effect.duration) * (effect.duration + effect.startingTick - state.gameTick)
                )
            }
            return dmg
        }, 0)
        simpleDamage(state, target, igniteDamage + DAMAGE)
    },
}
