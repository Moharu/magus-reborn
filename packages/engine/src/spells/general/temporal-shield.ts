import { secondsToTicks } from '../../constants'
import type { EffectReducer, SpellDefinition, TemporalShieldBuff } from '../../types'
import { fromCenti, simpleBuff, toCenti } from '../../utils'

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
    offGlobalCooldown: true,
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
        const current = toCenti(player.hp)
        const gap = toCenti(buff.backup) - current
        const restored = Math.round((gap * buff.healingPercentage) / 100)
        // at 100% restored === gap, so HP becomes exactly the backup
        player.hp = fromCenti(current + restored)
    }
}
