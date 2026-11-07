export const GAME_TICK_INTERVAL = 50
export const MAX_HP = 100
/**
 * What a client and server must agree on to play together. Bump it for any change to the engine state shape, the
 * protocol or simulation behaviour; see `.claude/agents/release-manager.md`.
 */
export const ENGINE_VERSION = 'reborn-0.1.0'

/**
 * The whole tick count nearest to `seconds`; exact ties round up. Every timing goes through here, so a tick rate that
 * doesn't divide a timing evenly rounds it (1.3 s at 40 ms ticks is 33 ticks, 1.32 s). That is accepted.
 * Float noise is snapped off first so an exact tie stays a tie: 1.005 s at 10 ms is 100.5 ticks, not 100.49999999999999.
 */
export const secondsToTicks = (seconds: number, tickInterval = GAME_TICK_INTERVAL) =>
    Math.round(Math.round(((seconds * 1000) / tickInterval) * 1e6) / 1e6)
export const ticksToSeconds = (ticks: number) => (ticks * GAME_TICK_INTERVAL) / 1000

export const GLOBAL_COOLDOWN_SECONDS = 1
/** In ticks. Started by on-GCD instants; derived from the tick rate so it stays 1 s if the rate changes. */
export const GLOBAL_COOLDOWN = secondsToTicks(GLOBAL_COOLDOWN_SECONDS)
