import type { SpellDefinition } from '../../types'
import { fromCenti, toCenti } from '../../utils'
import { gainChilling, spendAllChilling } from './chilling'
import { frostHit } from './frost-fever'
import { FROST_NUMBERS } from './numbers'

const { castSeconds, baseDamage, damagePerStack, chillingGain } = FROST_NUMBERS.iceSpear

export const IceSpear: SpellDefinition = {
    id: 'SPELL_ICE_SPEAR',
    school: 'FROST',
    label: 'Ice Spear',
    description: 'Deals damage, spending every Chilling stack for more damage per stack.',
    advancedDescription: `Deals ${baseDamage} damage plus ${damagePerStack} per Chilling stack, and spends every stack.`,
    castSeconds,
    reducer: (state, ctx) => {
        // the stacks held on release, not on cast start
        const stacks = spendAllChilling(state, ctx.caster)
        frostHit(state, ctx, 'SPELL_ICE_SPEAR', fromCenti(toCenti(baseDamage) + stacks * toCenti(damagePerStack)))
        gainChilling(state, ctx.caster, chillingGain)
    },
}
