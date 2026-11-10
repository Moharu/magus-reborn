import type { SpellDefinition } from '../../types'
import { gainChilling } from './chilling'
import { frostHit } from './frost-fever'
import { FROST_NUMBERS } from './numbers'

const { castSeconds, damage, chillingGain } = FROST_NUMBERS.glacier

export const Glacier: SpellDefinition = {
    id: 'SPELL_GLACIER',
    school: 'FROST',
    label: 'Glacier',
    description: 'A long cast that deals heavy damage and grants several Chilling stacks.',
    advancedDescription: `Deals ${damage} damage and grants ${chillingGain} Chilling.`,
    castSeconds,
    reducer: (state, ctx) => {
        frostHit(state, ctx, 'SPELL_GLACIER', damage)
        gainChilling(state, ctx.caster, chillingGain)
    },
}
