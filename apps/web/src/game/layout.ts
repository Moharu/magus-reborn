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

/**
 * The spell bar: 7 equal buttons in three groups (Q W E R | Space | D F), in stage pixels. The battle
 * HUD draws it and the loadout picker lays its DOM version over the same coordinates.
 */
export const BAR = {
    button: 78,
    gap: 10,
    groupGap: 24,
    buttonTop: 482,
    panelTop: 470,
    panelHeight: 122,
    panelPad: 16,
    /** Slot counts of the three groups, in order. */
    groups: [4, 1, 2],
} as const

const BAR_SLOTS = BAR.groups.reduce((sum, n) => sum + n, 0)
export const BAR_WIDTH =
    BAR.button * BAR_SLOTS + BAR.gap * (BAR_SLOTS - BAR.groups.length) + BAR.groupGap * (BAR.groups.length - 1)
export const BAR_LEFT = (WIDTH - BAR_WIDTH) / 2

/** Left edge of spell button `i` in stage pixels. */
export const buttonX = (i: number) => {
    let x = BAR_LEFT
    let index = 0
    for (const size of BAR.groups) {
        if (i < index + size) return x + (i - index) * (BAR.button + BAR.gap)
        x += size * BAR.button + (size - 1) * BAR.gap + BAR.groupGap
        index += size
    }
    throw new RangeError(`no spell button ${i}`)
}
