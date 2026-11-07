import { GAME_TICK_INTERVAL, secondsToTicks } from '../../constants'
import type { EffectReducer, HasteBuff, SpellDefinition } from '../../types'

export const BUFF_DURATION = 60
export const COOLDOWN = 10
export const BUFF_CAST_REDUCTION_PERCENTAGE = 50

/**
 * A hasted cast in ticks: the tick nearest to the reduced base cast time, ties round up (33 ticks -> 16.5 -> 17).
 * Starts from the base seconds, not `castTime`, which is already rounded to the tick rate: at 40 ms ticks a 1.3 s cast
 * is 33 ticks, but its hasted 0.65 s is 16 ticks (16.25), where halving 33 would give 17. A cast never becomes instant.
 */
export const hastedCastTime = (castSeconds: number, tickInterval = GAME_TICK_INTERVAL) =>
    Math.max(1, secondsToTicks((castSeconds * (100 - BUFF_CAST_REDUCTION_PERCENTAGE)) / 100, tickInterval))

export const Haste: SpellDefinition = {
    id: 'SPELL_HASTE',
    school: 'GENERAL',
    label: 'Haste',
    description: 'Enhances cast speed of next spell',
    advancedDescription: `Enhances cast speed of next spell by ${BUFF_CAST_REDUCTION_PERCENTAGE}%.`,
    cooldownSeconds: COOLDOWN,
    reducer: (state, { caster }) => {
        const player = state[caster]
        // refresh rather than stack: restore the un-hasted cast times first
        const existing = player.effects.find(effect => effect.id === 'BUFF_HASTE')
        if (existing) {
            player.spells = player.spells.map((spell, i) => ({ ...spell, castTime: existing.backup[i] }))
            player.effects = player.effects.filter(effect => effect !== existing)
        }
        const buff: HasteBuff = {
            id: 'BUFF_HASTE',
            label: 'Haste',
            source: 'SPELL_HASTE',
            type: 'positive',
            startingTick: state.gameTick,
            duration: secondsToTicks(BUFF_DURATION),
            logIndex: state.log.length,
            backup: player.spells.map(spell => spell.castTime),
        }
        player.effects = [...player.effects, buff]
        player.spells = player.spells.map(spell => ({
            ...spell,
            castTime: spell.castTime ? hastedCastTime(spell.castSeconds) : spell.castTime,
        }))
    },
}

export const hasteBuffReducer: EffectReducer<HasteBuff> = (state, { target }, buff) => {
    const player = state[target]
    // instants don't consume haste
    const shouldRemoveBuff = state.log
        .slice(buff.logIndex)
        .some(
            log => log.type === 'SPELL_RELEASE' && log.caster === target && player.spells[log.spellIndex].castTime > 0,
        )
    buff.logIndex = state.log.length
    if (shouldRemoveBuff || state.gameTick === buff.startingTick + buff.duration) {
        player.spells = player.spells.map((spell, i) => ({ ...spell, castTime: buff.backup[i] }))
        player.effects = player.effects.filter(effect => effect.id !== buff.id)
    }
}
