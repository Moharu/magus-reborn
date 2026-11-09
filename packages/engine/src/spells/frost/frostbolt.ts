import type { SpellDefinition } from '../../types'
import { gainChilling } from './chilling'
import { frostHit } from './frost-fever'
import { FROST_NUMBERS } from './numbers'

const { castSeconds, damage, chillingGain } = FROST_NUMBERS.frostbolt

export const Frostbolt: SpellDefinition = {
    id: 'SPELL_FROSTBOLT',
    school: 'FROST',
    label: 'Frostbolt',
    description: 'Deals moderate damage and grants a Chilling stack.',
    advancedDescription: `Deals ${damage} damage and grants ${chillingGain} Chilling.`,
    castSeconds,
    reducer: (state, ctx) => {
        frostHit(state, ctx, 'SPELL_FROSTBOLT', damage)
        gainChilling(state, ctx.caster, chillingGain)
    },
}
