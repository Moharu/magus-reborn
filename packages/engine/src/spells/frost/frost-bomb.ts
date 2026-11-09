import { secondsToTicks } from '../../constants'
import type { EffectReducer, FrostBombDebuff, SpellDefinition } from '../../types'
import { simpleDamage, uniqueDebuff } from '../../utils'
import { gainChilling } from './chilling'
import { FROST_NUMBERS } from './numbers'

const { castSeconds, pulseSeconds, pulseDamage, chillingGain } = FROST_NUMBERS.frostBomb
export const FROST_BOMB_PULSES = 3

export const FrostBomb: SpellDefinition = {
    id: 'SPELL_FROST_BOMB',
    school: 'FROST',
    label: 'Frost Bomb',
    description: 'A long debuff that pulses 3 times for heavy damage. Replaces an existing Frost Bomb.',
    advancedDescription: `Pulses ${FROST_BOMB_PULSES} times, every ${pulseSeconds} seconds, dealing ${pulseDamage} damage each. Replaces an existing Frost Bomb.`,
    castSeconds,
    reducer: (state, { caster, target }) => {
        const interval = secondsToTicks(pulseSeconds)
        uniqueDebuff<FrostBombDebuff>(state, target, {
            id: 'DEBUFF_FROST_BOMB',
            label: 'Frost Bomb',
            source: 'SPELL_FROST_BOMB',
            pulseDamage,
            // evenly spaced: the battle runs the reducer every `tickInterval` ticks, the last on the expiry tick
            tickInterval: interval,
            duration: interval * FROST_BOMB_PULSES,
        })
        gainChilling(state, caster, chillingGain)
    },
}

export const frostBombDebuffReducer: EffectReducer<FrostBombDebuff> = (state, { target, enemy }, debuff) =>
    simpleDamage(state, target, debuff.pulseDamage, enemy)
