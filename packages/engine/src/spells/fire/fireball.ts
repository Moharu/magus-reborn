import type { SpellDefinition } from '../../types'
import { simpleDamage } from '../../utils'

export const CAST = 1.3
export const DAMAGE = 5.6

export const Fireball: SpellDefinition = {
    id: 'SPELL_FIREBALL',
    school: 'FIRE',
    label: 'Fireball',
    description: 'Deals moderate damage instantly.',
    advancedDescription: `Deals ${DAMAGE} damage instantly.`,
    castSeconds: CAST,
    reducer: (state, { caster, target }) => simpleDamage(state, target, DAMAGE, caster),
}
