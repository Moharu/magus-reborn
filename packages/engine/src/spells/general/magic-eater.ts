import { MAX_HP, secondsToTicks } from '../../constants'
import type { EffectReducer, MagicEaterBuff, SpellDefinition } from '../../types'
import { simpleBuff } from '../../utils'

export const COOLDOWN = 18
export const BUFF_DURATION = 7.8
export const HEALING_PERCENTAGE = 40

export const MagicEater: SpellDefinition = {
    id: 'SPELL_MAGIC_EATER',
    school: 'GENERAL',
    label: 'Magic Eater',
    description: 'For a moderate duration, you are healed by a percentage of all damage dealt.',
    advancedDescription: `For ${BUFF_DURATION} seconds, you are healed for ${HEALING_PERCENTAGE}% of all damage dealt.`,
    cooldownSeconds: COOLDOWN,
    globalCooldownTicks: 0,
    reducer: (state, { caster, target }) =>
        simpleBuff<MagicEaterBuff>(state, caster, {
            id: 'BUFF_MAGIC_EATER',
            label: 'Magic Eater',
            source: 'SPELL_MAGIC_EATER',
            healingPercentage: HEALING_PERCENTAGE,
            duration: secondsToTicks(BUFF_DURATION),
            lastTargetHp: state[target].hp,
        }),
}

export const magicEaterBuffReducer: EffectReducer<MagicEaterBuff> = (state, { target, enemy }, buff) => {
    const newEnemyHp = state[enemy].hp
    const healing = Math.max(0, (buff.lastTargetHp - newEnemyHp) * (buff.healingPercentage / 100))
    state[target].hp = Math.min(MAX_HP, state[target].hp + healing)
    buff.lastTargetHp = newEnemyHp
}
