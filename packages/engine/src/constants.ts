export const GAME_TICK_INTERVAL = 50
export const MAX_HP = 100
/**
 * What a client and server must agree on to play together. Bump it for any change to the engine state shape, the
 * protocol or simulation behaviour; see `.claude/agents/release-manager.md`.
 */
export const ENGINE_VERSION = 'reborn-1.0.0'

export const secondsToTicks = (seconds: number) => Math.round((seconds * 1000) / GAME_TICK_INTERVAL)
export const ticksToSeconds = (ticks: number) => (ticks * GAME_TICK_INTERVAL) / 1000

export const GLOBAL_COOLDOWN_SECONDS = 1
/** In ticks. Started by on-GCD instants; derived from the tick rate so it stays 1 s if the rate changes. */
export const GLOBAL_COOLDOWN = secondsToTicks(GLOBAL_COOLDOWN_SECONDS)
