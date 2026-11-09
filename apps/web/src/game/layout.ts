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

/** Battle-only geometry; setup/swap keep their existing coordinates until #108. */
export const BATTLE_BAR = { button: 96, gap: 12, groupGap: 18, top: 474, panelTop: 462, panelHeight: 124 }
export const BATTLE_BAR_WIDTH = BATTLE_BAR.button * 7 + BATTLE_BAR.gap * 4 + BATTLE_BAR.groupGap * 2
export const battleButtonX = (i: number) => {
    if (!Number.isInteger(i) || i < 0 || i >= 7) throw new RangeError(`no spell button ${i}`)
    const extraGap = BATTLE_BAR.groupGap - BATTLE_BAR.gap
    return (
        (WIDTH - BATTLE_BAR_WIDTH) / 2 +
        i * (BATTLE_BAR.button + BATTLE_BAR.gap) +
        (i >= 4 ? extraGap : 0) +
        (i >= 5 ? extraGap : 0)
    )
}

export interface Rect {
    x: number
    y: number
    width: number
    height: number
}

/** Desktop composition in canvas pixels. The reserved centre is the seam for #107. */
export const battleLayout = (width: number, height: number) => {
    const sx = width / WIDTH
    const sy = height / HEIGHT
    const rect = (x: number, y: number, w: number, h: number): Rect => ({
        x: x * sx,
        y: y * sy,
        width: w * sx,
        height: h * sy,
    })
    const player = (x: number) => ({
        heading: rect(x, 12, 340, 24),
        hp: rect(x, 40, 340, 24),
        cast: rect(x, 76, 340, 26),
        effects: rect(x, 128, 340, 50),
    })
    return {
        left: player(24),
        right: player(596),
        score: rect(388, 12, 184, 32),
        timer: rect(388, 50, 184, 24),
        fighters: { left: rect(170, 282, 100, 158), right: rect(680, 282, 100, 158) },
        centre: rect(388, 170, 184, 280),
        bar: rect(
            (WIDTH - BATTLE_BAR_WIDTH) / 2 - 16,
            BATTLE_BAR.panelTop,
            BATTLE_BAR_WIDTH + 32,
            BATTLE_BAR.panelHeight,
        ),
        slots: Array.from({ length: 7 }, (_, i) =>
            rect(battleButtonX(i), BATTLE_BAR.top, BATTLE_BAR.button, BATTLE_BAR.button + 14),
        ),
    }
}

/** Phone presentation only; all values are CSS pixels in the safe-area content box. */
export const PHONE_MAX_HEIGHT = 500
/** Landscape phones, including 932x430 Pro Max class; keyed on height so wide phones are not missed. */
export const phoneLandscape = (width: number, height: number) => height <= PHONE_MAX_HEIGHT && width > height

/** Uniform world transform for phones: never stretches fighters or VFX; the backdrop fills the rest. */
export const mobileWorldTransform = (width: number, height: number) => {
    const scale = Math.min(width / WIDTH, (height - 100) / GROUND_Y)
    return { scale, x: (width - WIDTH * scale) / 2, y: height - 100 - GROUND_Y * scale }
}

export const mobileBattleLayout = (width: number, height: number) => {
    const gap = width < 844 ? 4 : 6
    const panelWidth = width * (width < 844 ? 0.96 : 0.92)
    const left = (width - panelWidth) / 2
    const button = (panelWidth - 10 - gap * 6) / 7
    const bar = { x: left, y: height - 96, width: panelWidth, height: 90 }
    return {
        bar,
        slots: Array.from({ length: 7 }, (_, i) => ({
            x: left + 5 + i * (button + gap),
            y: bar.y + 5,
            width: button,
            height: 60,
        })),
        log: { x: width / 2, y: bar.y - 28 },
    }
}

/** Change this one setting to move every class resource, including future polarity UI. */
export type ResourceMeterPosition = 'below-cast' | 'above-wizard'
export const RESOURCE_METER_POSITION: ResourceMeterPosition = 'below-cast'
/** Settable placement seam shared by HUD placement and combat text. */
export const RESOURCE_METER_PLACEMENT: { position: ResourceMeterPosition } = { position: RESOURCE_METER_POSITION }
export const RESOURCE_METER = { width: 126, height: 8, gap: 10 } as const

/** HUD-local slot; renderers supply content without owning placement or viewport transforms. */
export const resourceMeterSlot = (
    side: Side,
    width = WIDTH,
    height = HEIGHT,
    position: ResourceMeterPosition = RESOURCE_METER_PLACEMENT.position,
): Rect => {
    const compact = phoneLandscape(width, height)
    const factor = compact ? Math.min(0.8, (width - 120) / 728) : 1
    const hudX = side === 'right' ? width - WIDTH * factor : 0
    const cast = battleLayout(WIDTH, HEIGHT)[side].cast
    const world = compact ? mobileWorldTransform(width, height) : { x: 0, y: 0, scale: 1 }
    const meterScale = position === 'below-cast' ? 1 : Math.min(1, world.scale / factor)
    // CSS-pixel floors survive the parent HUD scale; keep the narrow alternate lane clear of the log.
    const meterWidth = Math.max(RESOURCE_METER.width * meterScale, (RESOURCE_METER.width * 10) / (22 * factor))
    const meterHeight = Math.max(RESOURCE_METER.height * meterScale, 6 / factor)
    if (position === 'below-cast')
        return {
            x: cast.x + (cast.width - meterWidth) / 2,
            y: cast.y + cast.height + RESOURCE_METER.gap,
            width: meterWidth,
            height: meterHeight,
        }
    return {
        x: (world.x + SIDE_X[side] * world.scale - hudX) / factor - meterWidth / 2,
        // Stay below the effect/lock strip even on short phones.
        y: Math.max(190, (world.y + 190 * world.scale) / factor),
        width: meterWidth,
        height: meterHeight,
    }
}

/** The alternate layout reserves the head lane for the meter; combat text floats over the robe. */
export const resourceCombatTextOffset = (position: ResourceMeterPosition = RESOURCE_METER_PLACEMENT.position) =>
    position === 'above-wizard' ? 100 : 0
