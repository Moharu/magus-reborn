export const GAME_TICK_INTERVAL = 50
export const DEFAULT_GLOBAL_COOLDOWN = 4
export const MAX_HP = 100
export const ENGINE_VERSION = 'reborn-1.0.0'

export const secondsToTicks = (seconds: number) => Math.round((seconds * 1000) / GAME_TICK_INTERVAL)
export const ticksToSeconds = (ticks: number) => (ticks * GAME_TICK_INTERVAL) / 1000
