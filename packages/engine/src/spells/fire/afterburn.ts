import { secondsToTicks } from '../../constants'
import type { SpellDefinition } from '../../types'
import { simpleDamage } from '../../utils'

export const CAST = 1.1
export const LOOKBACK_TIME = 10
export const BASE_DAMAGE = 2.1
export const DAMAGE_PER_STACK = 3.5

export const Afterburn: SpellDefinition = {
    id: 'SPELL_AFTERBURN',
    school: 'FIRE',
    label: 'Afterburn',
    description: 'Deals damage according to the number of fireballs cast recently.',
    advancedDescription: `Deals ${BASE_DAMAGE} damage plus ${DAMAGE_PER_STACK} times the number of Fireballs cast in the last ${LOOKBACK_TIME} seconds.`,
    castSeconds: CAST,
    reducer: (state, { caster, target }) => {
        const fireballIndex = state[caster].spells.findIndex(spell => spell.id === 'SPELL_FIREBALL')
        const fromTick = Math.max(state.gameTick - secondsToTicks(LOOKBACK_TIME), 0)
        const fireballsCast = state.log.filter(
            log =>
                log.type === 'SPELL_RELEASE' &&
                log.caster === caster &&
                log.spellIndex === fireballIndex &&
                log.tick >= fromTick,
        )
        simpleDamage(state, target, BASE_DAMAGE + DAMAGE_PER_STACK * fireballsCast.length, caster)
    },
}
