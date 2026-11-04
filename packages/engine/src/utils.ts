import type { BattleState, EffectState, PlayerKey, PlayerState } from './types'

type Applied<E extends EffectState> = Omit<E, 'startingTick' | 'type'>

export const simpleDamage = (state: BattleState, target: PlayerKey, damage: number) => {
    state[target].hp -= damage
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
