import { secondsToTicks } from '../../constants'
import type { BlurBuff, EffectReducer, SpellDefinition } from '../../types'
import { simpleBuff } from '../../utils'

export const COOLDOWN = 15
export const BUFF_DURATION = 3.9

export const Blur: SpellDefinition = {
    id: 'SPELL_BLUR',
    school: 'GENERAL',
    label: 'Blur',
    description: 'Upon expiry, cleanses harmful effects (except Counterspell) applied while the buff was active.',
    advancedDescription: `Upon expiry, cleanses harmful effects (except Counterspell) applied while the buff was active. Lasts ${BUFF_DURATION} seconds.`,
    cooldownSeconds: COOLDOWN,
    offGlobalCooldown: true,
    reducer: (state, { caster }) =>
        simpleBuff<BlurBuff>(state, caster, {
            id: 'BUFF_BLUR',
            label: 'Blur',
            source: 'SPELL_BLUR',
            duration: secondsToTicks(BUFF_DURATION),
        }),
}

export const blurBuffReducer: EffectReducer<BlurBuff> = (state, { target }, buff) => {
    if (state.gameTick === buff.startingTick + buff.duration) {
        const player = state[target]
        player.effects = player.effects.filter(
            effect =>
                !(effect.startingTick >= buff.startingTick && effect.type === 'negative' && !effect.dispelProtection),
        )
    }
}
