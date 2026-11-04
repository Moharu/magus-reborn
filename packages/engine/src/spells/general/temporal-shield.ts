import { secondsToTicks } from '../../constants'
import type { EffectReducer, SpellDefinition, TemporalShieldBuff } from '../../types'
import { simpleBuff } from '../../utils'

export const COOLDOWN = 12
export const BUFF_DURATION = 1.2
export const HEALING_PERCENTAGE = 100

export const TemporalShield: SpellDefinition = {
    id: 'SPELL_TEMPORAL_SHIELD',
    school: 'GENERAL',
    label: 'Temporal Shield',
    description: 'After expiration returns user to the same hp amount as when the effect was applied.',
    advancedDescription: `After expiration returns user to the same hp amount as when the effect was applied. Lasts ${BUFF_DURATION} seconds.`,
    cooldownSeconds: COOLDOWN,
    globalCooldownTicks: 0,
    reducer: (state, { caster }) =>
        simpleBuff<TemporalShieldBuff>(state, caster, {
            id: 'BUFF_TEMPORAL_SHIELD',
            label: 'Temporal Shield',
            source: 'SPELL_TEMPORAL_SHIELD',
            healingPercentage: HEALING_PERCENTAGE,
            duration: secondsToTicks(BUFF_DURATION),
            backup: state[caster].hp,
        }),
}

export const temporalShieldBuffReducer: EffectReducer<TemporalShieldBuff> = (state, { target }, buff) => {
    if (state.gameTick === buff.startingTick + buff.duration) {
        const player = state[target]
        // death is final: expiry never brings a player back from 0 HP
        if (player.hp <= 0) return
        player.hp += (buff.backup - player.hp) * (buff.healingPercentage / 100)
    }
}
