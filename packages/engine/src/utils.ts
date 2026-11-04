import { MAX_HP } from './constants'
import type { BattleState, EffectState, PlayerKey, PlayerState } from './types'

/**
 * HP is exposed in HP units but all arithmetic happens in integer hundredths ("centi-HP"), so
 * every HP value sits exactly on the 0.01 grid and sums never drift (13.3 stays 13.3).
 */
export const toCenti = (hp: number) => Math.round(hp * 100)
export const fromCenti = (centi: number) => centi / 100

/**
 * The share of `total` dealt on tick `k` (1-based) of an `n`-tick effect, in HP units. Computed as
 * round(total*k/n) - round(total*(k-1)/n) in centi-HP, so the n ticks sum to exactly `total`.
 */
export const tickShare = (total: number, n: number, k: number) =>
    fromCenti(dealtAfter(total, n, k) - dealtAfter(total, n, k - 1))

/** Centi-HP of `total` already dealt after `k` of `n` ticks. */
const dealtAfter = (total: number, n: number, k: number) =>
    Math.round((toCenti(total) * Math.max(0, Math.min(k, n))) / n)

/** Damage of `total` still to come after `k` of `n` ticks, in HP units; exact complement of the ticks dealt. */
export const remainingShare = (total: number, n: number, k: number) =>
    fromCenti(toCenti(total) - dealtAfter(total, n, k))

type Applied<E extends EffectState> = Omit<E, 'startingTick' | 'type'>

/**
 * The single damage path. `dealer` is the player credited with the damage (for damage over time,
 * whoever applied the effect); the amount actually dealt is credited to the dealer's Magic Eater buffs.
 */
export const simpleDamage = (state: BattleState, target: PlayerKey, damage: number, dealer: PlayerKey) => {
    const before = toCenti(state[target].hp)
    const after = Math.max(0, before - toCenti(damage))
    state[target].hp = fromCenti(after)
    const dealt = before - after
    if (dealt <= 0 || dealer === target) return
    for (const effect of state[dealer].effects) {
        if (effect.id === 'BUFF_MAGIC_EATER') effect.pendingDamage = fromCenti(toCenti(effect.pendingDamage) + dealt)
    }
}

/** Heals up to MAX_HP. Death is final: a player at 0 HP can never be healed back. */
export const simpleHeal = (state: BattleState, target: PlayerKey, amount: number) => {
    const player = state[target]
    if (player.hp <= 0 || amount <= 0) return
    player.hp = fromCenti(Math.min(toCenti(MAX_HP), toCenti(player.hp) + toCenti(amount)))
}

export const simpleDebuff = <E extends EffectState>(state: BattleState, target: PlayerKey, debuff: Applied<E>) => {
    const player = state[target]
    player.effects = [...player.effects, { ...debuff, startingTick: state.gameTick, type: 'negative' } as E]
}

export const uniqueDebuff = <E extends EffectState>(state: BattleState, target: PlayerKey, debuff: Applied<E>) => {
    const player = state[target]
    player.effects = [
        ...player.effects.filter(effect => effect.id !== debuff.id),
        { ...debuff, startingTick: state.gameTick, type: 'negative' } as E,
    ]
}

export const simpleBuff = <E extends EffectState>(state: BattleState, target: PlayerKey, buff: Applied<E>) => {
    const player = state[target]
    player.effects = [...player.effects, { ...buff, startingTick: state.gameTick, type: 'positive' } as E]
}

export const isCasting = (player: PlayerState) => player.cast !== null

export const enemyOf = (player: PlayerKey): PlayerKey => (player === 'player1' ? 'player2' : 'player1')
