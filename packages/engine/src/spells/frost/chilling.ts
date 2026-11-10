import type { BattleState, PlayerKey } from '../../types'
import { FROST_NUMBERS } from './numbers'

/** Adds `stacks` Chilling to `player`, up to the cap; stacks above it are lost. */
export const gainChilling = (state: BattleState, player: PlayerKey, stacks: number) => {
    const p = state[player]
    p.chilling = Math.min(FROST_NUMBERS.chillingMaxStacks, p.chilling + stacks)
}

/** Removes every Chilling stack from `player` and returns how many there were. */
export const spendAllChilling = (state: BattleState, player: PlayerKey) => {
    const stacks = state[player].chilling
    state[player].chilling = 0
    return stacks
}
