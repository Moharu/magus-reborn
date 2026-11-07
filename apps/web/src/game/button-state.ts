import {
    cooldownRemaining,
    gcdRemaining,
    GLOBAL_COOLDOWN,
    SPELLS,
    type PlayerState,
    type SpellState,
} from '@magus/engine'

/** What a spell button shows on this frame. */
export interface ButtonState {
    /** Share of the cooldown fader to fill, from 0 (no fader) to 1 (full). */
    fader: number
    /** Whether to draw the Counterspell lock tint. */
    locked: boolean
    /** Ticks to show as the timer text, 0 for no text. */
    timer: number
}

/**
 * Picks the display for one spell button. In order of priority:
 * - Counterspell lock: tint and timer, over the spell's cooldown fader or a full fill.
 * - GCD, if it outlasts the spell's own cooldown: fader only, no text. Off-GCD spells never show it.
 * - The spell's own cooldown: fader and timer.
 *
 * `tick` may be fractional: the battle view interpolates it between snapshots.
 */
export const buttonState = (player: PlayerState, spell: SpellState, tick: number): ButtonState => {
    const cooldown = cooldownRemaining(spell, tick)
    const cooldownFader = cooldown > 0 ? cooldown / spell.cooldown : 0

    const lock = Math.max(0, player.lockedUntil - tick)
    if (lock > 0) return { fader: cooldownFader || 1, locked: true, timer: Math.max(cooldown, lock) }

    const gcd = SPELLS[spell.id].offGlobalCooldown ? 0 : gcdRemaining(player, tick)
    if (gcd > cooldown) return { fader: gcd / GLOBAL_COOLDOWN, locked: false, timer: 0 }

    return { fader: cooldownFader, locked: false, timer: cooldown }
}
