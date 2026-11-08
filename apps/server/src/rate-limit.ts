/**
 * Messages per second a connection can keep sending without any being dropped. A key press is two messages, so this is
 * 20 keys a second. Players mash to land a spell the moment a GCD, lockout or cooldown ends, and the presses the engine
 * rejects until then cost the same as any other, so this has to sit above what a player can do, not what a rotation needs.
 */
export const RATE_LIMIT_PER_SECOND = 40
/** Messages a connection can send at once, after being quiet for long enough to fill its bucket. */
export const RATE_LIMIT_BURST = 40
/**
 * Dropped messages a connection can run up before it's closed. A stalled network delivers everything the player sent
 * during the stall at once, so this covers 30 s of a player mashing 6 keys a second (366 messages).
 */
export const ABUSE_DROP_ALLOWANCE = 400
/**
 * Dropped messages forgiven per second, so only sustained abuse runs out the allowance. With the rate limit above,
 * a connection has to keep sending more than 50 messages a second to be closed.
 */
export const ABUSE_DROPS_FORGIVEN_PER_SECOND = 10

export type Clock = () => number

/** Counts in thousandths of a token, which keeps the refill in exact integers for a clock in whole milliseconds. */
export class TokenBucket {
    private milliTokens: number
    private lastRefill: number

    constructor(
        private readonly perSecond: number,
        private readonly capacity: number,
        private readonly now: Clock = Date.now,
    ) {
        this.milliTokens = capacity * 1000
        this.lastRefill = now()
    }

    /** Takes a token if one is available. */
    take(): boolean {
        const now = this.now()
        // a clock that steps back grants nothing, and refilling resumes from its new reading
        const elapsed = Math.max(0, now - this.lastRefill)
        this.lastRefill = now
        this.milliTokens = Math.min(this.capacity * 1000, this.milliTokens + elapsed * this.perSecond)
        if (this.milliTokens < 1000) return false
        this.milliTokens -= 1000
        return true
    }
}

export type RateLimitVerdict = 'allow' | 'drop' | 'close'

/**
 * The limit on one player's connections (see PlayerLimiters). Messages over the rate are dropped, and each drop uses up a second bucket, so running
 * that one out means the connection is closed. Counting drops rather than timing them closes a flood within a fraction
 * of a second, which matters because the frames compete with the battle's 50 ms ticks for the Durable Object's thread.
 */
export class ConnectionLimiter {
    private readonly messages: TokenBucket
    private readonly drops: TokenBucket

    constructor(now: Clock = Date.now) {
        this.messages = new TokenBucket(RATE_LIMIT_PER_SECOND, RATE_LIMIT_BURST, now)
        this.drops = new TokenBucket(ABUSE_DROPS_FORGIVEN_PER_SECOND, ABUSE_DROP_ALLOWANCE, now)
    }

    /** Call once for each incoming message. */
    check(): RateLimitVerdict {
        if (this.messages.take()) return 'allow'
        return this.drops.take() ? 'drop' : 'close'
    }
}

/**
 * How long a player closed for flooding is refused when they connect to the same lobby again. A seated player can only
 * pause and resume a match by connecting, so this caps a flood, close and reconnect loop at one pause and resume per
 * cooldown. It's shorter than the reconnect grace (RECONNECT_GRACE in lobby.ts), so a player closed by mistake still
 * gets back to their seat before they forfeit.
 */
export const ABUSE_RECONNECT_COOLDOWN_SECONDS = 10
/**
 * How long a player's limit is kept once they have no connection. By then both buckets are full again and any cooldown
 * is over, so forgetting it gives the player nothing a new limit wouldn't.
 */
export const IDLE_LIMIT_KEPT_MS =
    Math.max(
        RATE_LIMIT_BURST / RATE_LIMIT_PER_SECOND,
        ABUSE_DROP_ALLOWANCE / ABUSE_DROPS_FORGIVEN_PER_SECOND,
        ABUSE_RECONNECT_COOLDOWN_SECONDS,
    ) * 1000
/** Limits kept for players with no connection, past which the longest idle are forgotten early. */
export const MAX_IDLE_LIMITS = 32

interface KeptLimit {
    limiter: ConnectionLimiter
    connections: number
    /** When the last connection went. Only meaningful with no connections. */
    idleSince: number
    refusedUntil: number
}

/**
 * The limits of one lobby, one per player rather than per connection, so a reconnect picks up the buckets the last
 * connection left. Connections of the same player share one limit.
 *
 * The store is bounded: a player's limit is forgotten once it has been idle for IDLE_LIMIT_KEPT_MS, and if more than
 * `maxIdle` are idle, the longest idle are forgotten early. A pinned player's limit is never forgotten early, so a
 * seated player can't get theirs reset by connecting under a stream of made-up player ids. Limits in use are never
 * forgotten; there is one per connected player.
 */
export class PlayerLimiters {
    private readonly kept = new Map<string, KeptLimit>()

    constructor(
        private readonly isPinned: (playerId: string) => boolean = () => false,
        // read through a closure, so a test that replaces `Date.now` moves this clock too
        private readonly now: Clock = () => Date.now(),
        private readonly maxIdle = MAX_IDLE_LIMITS,
    ) {}

    /** How many milliseconds are left before this player can connect again, or 0 if they can now. */
    refusedFor(playerId: string): number {
        this.prune()
        const entry = this.kept.get(playerId)
        return entry ? Math.max(0, entry.refusedUntil - this.now()) : 0
    }

    /** The limit for a new connection of this player. Pair each call with one `release`. */
    acquire(playerId: string): ConnectionLimiter {
        this.prune()
        let entry = this.kept.get(playerId)
        if (!entry) {
            entry = { limiter: new ConnectionLimiter(this.now), connections: 0, idleSince: 0, refusedUntil: 0 }
            this.kept.set(playerId, entry)
        }
        entry.connections++
        return entry.limiter
    }

    /** Gives back a connection's limit. `closedForAbuse` starts the player's cooldown. */
    release(playerId: string, closedForAbuse: boolean) {
        const entry = this.kept.get(playerId)
        if (!entry || entry.connections === 0) return
        const now = this.now()
        entry.connections--
        if (closedForAbuse) entry.refusedUntil = now + ABUSE_RECONNECT_COOLDOWN_SECONDS * 1000
        if (entry.connections === 0) entry.idleSince = now
        this.prune()
    }

    /** Forgets every limit, for a lobby that closed. */
    clear() {
        this.kept.clear()
    }

    /** How many limits are kept, in use or idle. */
    get size() {
        return this.kept.size
    }

    private prune() {
        const now = this.now()
        const idle: [string, KeptLimit][] = []
        for (const [playerId, entry] of this.kept) {
            if (entry.connections > 0) continue
            if (now - entry.idleSince >= IDLE_LIMIT_KEPT_MS && now >= entry.refusedUntil) this.kept.delete(playerId)
            else idle.push([playerId, entry])
        }
        let excess = idle.length - this.maxIdle
        if (excess <= 0) return
        idle.sort((a, b) => a[1].idleSince - b[1].idleSince)
        for (const [playerId] of idle) {
            if (excess === 0) return
            if (this.isPinned(playerId)) continue
            this.kept.delete(playerId)
            excess--
        }
    }
}
