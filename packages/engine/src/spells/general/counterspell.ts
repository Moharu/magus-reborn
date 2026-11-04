import { secondsToTicks } from '../../constants'
import type { CounterspellDebuff, SpellDefinition } from '../../types'
import { isCasting, simpleDebuff } from '../../utils'

export const COOLDOWN = 11.7
export const LOCK_DURATION = 3

export const Counterspell: SpellDefinition = {
    id: 'SPELL_COUNTERSPELL',
    school: 'GENERAL',
    label: 'Counter Spell',
    description: "Counters current opponent's cast, disabling all spells for a short time if successfully interrupted.",
    advancedDescription: `Counters current opponent's cast, disabling all spells for ${LOCK_DURATION} seconds if successfully interrupted.`,
    cooldownSeconds: COOLDOWN,
    globalCooldownTicks: 0,
    reducer: (state, { target }) => {
        const player = state[target]
        if (!isCasting(player)) return
        player.cast = null
        player.castStartingTick = null
        player.globalCooldown = state.gameTick + secondsToTicks(LOCK_DURATION)
        simpleDebuff<CounterspellDebuff>(state, target, {
            id: 'DEBUFF_COUNTERSPELL',
            label: 'Spell cast disabled.',
            source: 'SPELL_COUNTERSPELL',
            dispelProtection: true,
            duration: secondsToTicks(LOCK_DURATION),
        })
    },
}
