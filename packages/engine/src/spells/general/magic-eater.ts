import { secondsToTicks } from '../../constants'
import type { BattleState, EffectReducer, MagicEaterBuff, PlayerKey, SpellDefinition } from '../../types'
import { simpleBuff, simpleHeal } from '../../utils'

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
    reducer: (state, { caster }) =>
        simpleBuff<MagicEaterBuff>(state, caster, {
            id: 'BUFF_MAGIC_EATER',
            label: 'Magic Eater',
            source: 'SPELL_MAGIC_EATER',
            healingPercentage: HEALING_PERCENTAGE,
            duration: secondsToTicks(BUFF_DURATION),
            pendingDamage: 0,
        }),
}

/** Healing is applied by `flushMagicEater` at the end of every tick, so both players are treated alike. */
export const magicEaterBuffReducer: EffectReducer<MagicEaterBuff> = () => {}

/**
 * Heals the owner for a share of the damage they dealt (see `simpleDamage`), never anyone else's.
 * Called by `Battle.tick` after every effect of both players has run, including on the buff's last tick.
 */
export const flushMagicEater = (state: BattleState, target: PlayerKey, buff: MagicEaterBuff) => {
    simpleHeal(state, target, buff.pendingDamage * (buff.healingPercentage / 100))
    buff.pendingDamage = 0
}
