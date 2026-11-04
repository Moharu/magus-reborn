import { MAX_HP } from './constants'
import type { BattleState, EffectState, PlayerKey, PlayerState } from './types'

type Applied<E extends EffectState> = Omit<E, 'startingTick' | 'type'>

/**
 * The single damage path. `dealer` is the player credited with the damage (for damage over time,
 * whoever applied the effect); the amount actually dealt is credited to the dealer's Magic Eater buffs.
 */
export const simpleDamage = (state: BattleState, target: PlayerKey, damage: number, dealer: PlayerKey) => {
    const before = state[target].hp
    state[target].hp = Math.max(0, before - damage)
    const dealt = before - state[target].hp
    if (dealt <= 0 || dealer === target) return
    for (const effect of state[dealer].effects) {
        if (effect.id === 'BUFF_MAGIC_EATER') effect.pendingDamage += dealt
    }
}

/** Heals up to MAX_HP. Death is final: a player at 0 HP can never be healed back. */
export const simpleHeal = (state: BattleState, target: PlayerKey, amount: number) => {
    const player = state[target]
    if (player.hp <= 0 || amount <= 0) return
    player.hp = Math.min(MAX_HP, player.hp + amount)
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
