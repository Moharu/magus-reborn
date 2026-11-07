/** Messages per second a connection can keep sending without any being dropped. */
export const RATE_LIMIT_PER_SECOND = 20
/** Messages a connection can send at once, after being quiet for long enough to fill its bucket. */
export const RATE_LIMIT_BURST = 40
/**
 * Dropped messages a connection can run up before it's closed. A stalled network delivers everything the player sent
 * during the stall at once, so this covers 30 s of a player mashing 6 keys a second (366 messages).
 */
export const ABUSE_DROP_ALLOWANCE = 400
/**
 * Dropped messages forgiven per second, so only sustained abuse runs out the allowance. With the rate limit above,
 * a connection has to keep sending more than 30 messages a second to be closed.
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
 * The limit on one connection. Messages over the rate are dropped, and each drop uses up a second bucket, so running
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
