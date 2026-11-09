import type { EffectId, EffectType, SpellId } from '@magus/engine'
import type { Rng } from './prng'

/** `a` plays as the engine's `player1`, `b` as `player2`. */
export type Side = 'a' | 'b'

/** One of the player's own loadout slots. Every number is read from the engine; the arena computes none of them. */
export interface SpellView {
    readonly id: SpellId
    /** Current cast time in ticks (Haste shortens it), 0 for instants. */
    readonly castTime: number
    /** Ticks until the spell is off cooldown (engine `cooldownRemaining`), 0 if ready. */
    readonly cooldownRemaining: number
    /** Ticks the GCD or a Counterspell lock still blocks it (engine `lockRemaining`), 0 if free. */
    readonly lockRemaining: number
    /** Both of the above are 0: the engine would accept `startCast` for it this tick. */
    readonly ready: boolean
}

/** A cast in progress, as the cast bar shows it. */
export interface CastView {
    readonly spellId: SpellId
    readonly startTick: number
    /** The cast time in ticks the engine holds for it. */
    readonly castTime: number
    /** `startTick + castTime`: the first tick `stopCast` releases it rather than cancelling it. */
    readonly completesAt: number
}

/**
 * A buff or debuff as the buff bar shows it, on either player: which effect, whether it is harmful, and its timer. Never
 * an effect's internal fields (Haste's saved cast times, Temporal Shield's saved HP, Magic Eater's pending heal).
 * Every Ignite is its own entry, so the Ignite stacks on a player are the entries with id `DEBUFF_IGNITE`.
 */
export interface EffectView {
    readonly id: EffectId
    readonly type: EffectType
    readonly startingTick: number
    /** `startingTick + duration`: the tick the effect ends on. Views from that tick on no longer show it. */
    readonly expiresAt: number
}

export interface OwnCastView extends CastView {
    readonly slot: number
}

export interface SelfView {
    readonly hp: number
    readonly casting: OwnCastView | null
    readonly gcdUntil: number
    readonly lockedUntil: number
    /** The player's own buffs and debuffs, in the order the engine applied them. */
    readonly effects: readonly EffectView[]
    /** The player's own loadout, in slot order. */
    readonly spells: readonly SpellView[]
}

/**
 * One entry of the opponent's spell log (#126), as the client's spell log shows it: what the opponent started,
 * stopped, released or had cancelled, and its casts we interrupted. Only the spell id and the tick, the same as the
 * engine log the server streams to both clients; never a loadout slot.
 */
export interface EnemyLogEntry {
    readonly tick: number
    readonly type: MatchEvent['type']
    /** The spell started, stopped (the cast in progress), released, cancelled or interrupted. */
    readonly spellId: SpellId
}

/**
 * What a player sees of their opponent, as a real client shows it: HP, the spell being cast (if any), a Counterspell
 * lock, their buffs and debuffs, and their spell log. Never the loadout, cooldowns, GCD or any effect's internal fields.
 */
export interface EnemyView {
    readonly hp: number
    readonly casting: CastView | null
    readonly lockedUntil: number
    /** The opponent's buffs and debuffs (for example the Ignites on them, Haste, Blur, Temporal Shield). */
    readonly effects: readonly EffectView[]
    /**
     * The opponent's spell log so far, oldest first (#126): every entry the engine logged for the opponent before
     * this tick's decisions, instants included, so a Counterspell that hit an empty cast bar shows as its
     * SPELL_RELEASE. The array only grows, and an entry never changes once added, so a controller may keep entries.
     */
    readonly log: readonly EnemyLogEntry[]
}

/**
 * Everything a controller sees on one tick. The runner reuses the same objects every tick (no per-tick allocation),
 * so a controller that wants to keep a value across ticks must copy it (entries of `enemy.log` excepted).
 */
export interface ArenaView {
    readonly tick: number
    readonly self: SelfView
    readonly enemy: EnemyView
}

/** `start` calls `Battle.startCast(slot)`; `stop` calls `Battle.stopCast(slot)`, which releases or cancels the cast. */
export interface Action {
    readonly type: 'start' | 'stop'
    readonly slot: number
}

/** What a controller does this tick: nothing, one action, or several applied in order. */
export type Decision = Action | readonly Action[] | null

/** Called once per tick with that player's view. */
export type Controller = (view: ArenaView) => Decision

export interface ControllerInit {
    /** The controller's own loadout, in slot order. */
    readonly loadout: readonly SpellId[]
    /** This player's own seeded stream: the other player's draws never shift it. */
    readonly rng: Rng
}

/** Builds a fresh controller for one match, so per-match state lives in its closure. */
export type ControllerFactory = (init: ControllerInit) => Controller

export interface Entrant {
    readonly name: string
    /** A valid loadout for the default element (engine `isValidLoadout`). */
    readonly loadout: readonly SpellId[]
    readonly controller: ControllerFactory
}

/** One engine log entry, with the player as a side. For INTERRUPTED, `side` is the interrupted player. */
export interface MatchEvent {
    readonly tick: number
    readonly side: Side
    readonly type: 'START_CAST' | 'STOP_CAST' | 'SPELL_RELEASE' | 'CANCEL_CAST' | 'INTERRUPTED'
    /** The spell started, stopped, released, cancelled or interrupted. */
    readonly spellId?: SpellId
    /** INTERRUPTED only: the interrupter's spell. */
    readonly source?: SpellId
}

export interface SideStats {
    /** Spells that went off (SPELL_RELEASE), instants included. */
    casts: number
    /** Cast-time casts started (START_CAST). */
    started: number
    /** Own casts cancelled: by an instant, by starting another cast, or by a `stop` before the cast completed. */
    cancelled: number
    /** Enemy casts this player interrupted. */
    interrupts: number
    /** Own casts the enemy interrupted. */
    interrupted: number
    /** Actions the engine rejected (cooldown, GCD, lock, wrong slot, nothing to stop). */
    rejected: number
    /** HP lost, in HP units (exact hundredths), before any heal. */
    damageTaken: number
}

export type MatchEndReason = 'death' | 'mutual' | 'timeout'

export interface MatchResult {
    readonly seed: number
    readonly winner: Side | 'draw'
    /** `death`: one player reached 0 HP; `mutual`: both did in the same tick; `timeout`: `maxTicks` was reached. */
    readonly reason: MatchEndReason
    /** The tick the match ended on: the winner's tick, or `maxTicks` on a timeout. */
    readonly ticks: number
    readonly hp: Readonly<Record<Side, number>>
    readonly stats: Readonly<Record<Side, Readonly<SideStats>>>
    /** Empty when `runMatch` was called with `log: false`. */
    readonly log: readonly MatchEvent[]
}
