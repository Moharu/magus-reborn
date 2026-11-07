import type { SpellDefinition } from '../../types'
import { simpleDamage } from '../../utils'

export const CAST = 3.6
export const DAMAGE = 28

export const Meteor: SpellDefinition = {
    id: 'SPELL_METEOR',
    school: 'FIRE',
    label: 'Meteor',
    description: 'Deals massive damage instantly.',
    advancedDescription: `Deals ${DAMAGE} damage instantly.`,
    castSeconds: CAST,
    reducer: (state, { caster, target }) => simpleDamage(state, target, DAMAGE, caster),
}
