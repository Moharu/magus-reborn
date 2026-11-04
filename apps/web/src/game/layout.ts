import type { PlayerKey } from '@magus/engine'

export const WIDTH = 960
export const HEIGHT = 600
export const GROUND_Y = 440
export const SIDE_X = { left: 230, right: 730 } as const
export type Side = keyof typeof SIDE_X

export const PALETTE = {
    left: { robe: 0x3b5bdb, trim: 0x1c2f80, hat: 0x2b45b0 },
    right: { robe: 0xc92a2a, trim: 0x6e1010, hat: 0xa31d1d },
}

export const TEXT_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'

/** Which battle seat is drawn on which side. "Me" is always on the left. */
export const sidesFor = (me: PlayerKey | null): Record<Side, PlayerKey> =>
    me === 'player2' ? { left: 'player2', right: 'player1' } : { left: 'player1', right: 'player2' }
