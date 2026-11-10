import type { SpellDefinition } from '../../types'
import { frostHit } from './frost-fever'
import { FROST_NUMBERS } from './numbers'

const { damage, chillingCost } = FROST_NUMBERS.icyTouch

/**
 * The first shipped on-GCD instant: it starts the GCD and is blocked by it. It needs and spends a Chilling stack
 * (`chillingCost`, checked by `startCast`), and like every instant it cancels the caster's current cast.
 */
export const IcyTouch: SpellDefinition = {
    id: 'SPELL_ICY_TOUCH',
    school: 'FROST',
    label: 'Icy Touch',
    description: 'Instantly deals small damage, more to a target with Frost Fever. Needs and spends a Chilling stack.',
    advancedDescription: `Instantly deals ${damage} damage, plus ${FROST_NUMBERS.frostFeverBonus.SPELL_ICY_TOUCH ?? 0} to a target with Frost Fever. Needs and spends ${chillingCost} Chilling. On the global cooldown.`,
    chillingCost,
    reducer: (state, ctx) => frostHit(state, ctx, 'SPELL_ICY_TOUCH', damage),
}
