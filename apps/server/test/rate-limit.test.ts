import { describe, expect, it } from 'vitest'
import { RECONNECT_GRACE } from '../src/lobby'
import {
    ABUSE_DROP_ALLOWANCE,
    ABUSE_DROPS_FORGIVEN_PER_SECOND,
    ABUSE_RECONNECT_COOLDOWN_SECONDS,
    ConnectionLimiter,
    IDLE_LIMIT_KEPT_MS,
    MAX_IDLE_LIMITS,
    PlayerLimiters,
    RATE_LIMIT_BURST,
    RATE_LIMIT_PER_SECOND,
    TokenBucket,
    type RateLimitVerdict,
} from '../src/rate-limit'

const fakeClock = () => {
    const clock = { ms: 1_000_000, now: () => clock.ms }
    return clock
}

describe('TokenBucket', () => {
    const bucket = (perSecond = 20, capacity = 40) => {
        const clock = fakeClock()
        return { clock, bucket: new TokenBucket(perSecond, capacity, clock.now) }
    }
    const drain = (b: TokenBucket) => {
        let taken = 0
        while (b.take()) taken++
        return taken
    }

    it('starts full and refuses once empty', () => {
        const { bucket: b } = bucket()

        expect(drain(b)).toBe(40)
        expect(b.take()).toBe(false)
    })

    it('refills one token per 1/rate of a second, not before', () => {
        const { bucket: b, clock } = bucket()
        drain(b)

        clock.ms += 49
        expect(b.take()).toBe(false)
        clock.ms += 1
        expect(b.take()).toBe(true)
        expect(b.take()).toBe(false)
    })

    it('keeps the fraction of a token from refills too small to take', () => {
        const { bucket: b, clock } = bucket()
        drain(b)

        for (let i = 0; i < 4; i++) {
            clock.ms += 10
            expect(b.take()).toBe(false)
        }
        clock.ms += 10
        expect(b.take()).toBe(true)
    })

    it('stays exact over many refills', () => {
        const { bucket: b, clock } = bucket(3, 2)
        drain(b)

        // 0.003 of a token per millisecond, which floats can't add up exactly
        let taken = 0
        for (let ms = 0; ms < 3_000_000; ms++) {
            clock.ms += 1
            if (b.take()) taken++
        }

        expect(taken).toBe(9000)
    })

    it('never holds more than its capacity, however long it sat idle', () => {
        const { bucket: b, clock } = bucket()
        drain(b)

        clock.ms += 3_600_000

        expect(drain(b)).toBe(40)
    })

    it('grants nothing when the clock steps back, then refills from the new reading', () => {
        const { bucket: b, clock } = bucket()
        drain(b)

        clock.ms -= 60_000
        expect(b.take()).toBe(false)
        clock.ms += 50
        expect(b.take()).toBe(true)
        expect(b.take()).toBe(false)
    })
})

describe('ConnectionLimiter', () => {
    const setup = () => {
        const clock = fakeClock()
        return { clock, limiter: new ConnectionLimiter(clock.now) }
    }

    /** Sends at a steady rate, returning how many got each verdict and when the connection would have been closed. */
    const send = (
        { clock, limiter }: ReturnType<typeof setup>,
        perSecond: number,
        seconds: number,
    ): Record<RateLimitVerdict, number> & { closedAfterMs: number | null } => {
        const start = clock.ms
        const tally = { allow: 0, drop: 0, close: 0, closedAfterMs: null as number | null }
        for (let i = 0; i < perSecond * seconds; i++) {
            clock.ms = start + Math.round((i * 1000) / perSecond)
            const verdict = limiter.check()
            tally[verdict]++
            if (verdict === 'close') {
                tally.closedAfterMs = clock.ms - start
                break
            }
        }
        return tally
    }

    /** Sends this many at the same instant. */
    const burst = ({ limiter }: ReturnType<typeof setup>, count: number) => {
        const verdicts: RateLimitVerdict[] = []
        for (let i = 0; i < count; i++) verdicts.push(limiter.check())
        return verdicts
    }

    describe('over the limit', () => {
        it('allows the burst, drops the allowance, and closes on the next one', () => {
            const verdicts = burst(setup(), RATE_LIMIT_BURST + ABUSE_DROP_ALLOWANCE + 1)

            expect(verdicts.slice(0, RATE_LIMIT_BURST)).toEqual(Array(RATE_LIMIT_BURST).fill('allow'))
            expect(verdicts.slice(RATE_LIMIT_BURST, -1)).toEqual(Array(ABUSE_DROP_ALLOWANCE).fill('drop'))
            expect(verdicts.at(-1)).toBe('close')
        })

        it('lets through no more than the rate while dropping', () => {
            const ctx = setup()
            burst(ctx, RATE_LIMIT_BURST)

            const { allow, drop } = send(ctx, 50, 10)

            // the last of the 500 goes out 9.98 s in, which is 399 whole tokens
            expect(allow).toBe(RATE_LIMIT_PER_SECOND * 10 - 1)
            expect(drop).toBe(101)
        })

        it('recovers from a burst that stops short of being closed', () => {
            const ctx = setup()
            burst(ctx, RATE_LIMIT_BURST + ABUSE_DROP_ALLOWANCE)

            // forgives the whole allowance and refills the bucket
            ctx.clock.ms += (ABUSE_DROP_ALLOWANCE / ABUSE_DROPS_FORGIVEN_PER_SECOND) * 1000

            expect(burst(ctx, RATE_LIMIT_BURST + ABUSE_DROP_ALLOWANCE)).not.toContain('close')
        })

        it('closes a flood within a fraction of a second', () => {
            expect(send(setup(), 1000, 60).closedAfterMs).toBeLessThan(500)
        })

        it('closes 100 messages a second within seconds', () => {
            expect(send(setup(), 100, 60).closedAfterMs).toBeLessThan(10_000)
        })

        it('closes a connection only just past 50 messages a second, in the end', () => {
            const { closedAfterMs } = send(setup(), 51, 600)

            expect(closedAfterMs).toBeGreaterThan(390_000)
            expect(closedAfterMs).toBeLessThan(420_000)
        })

        it('keeps 50 messages a second open, since dropping the excess is enough', () => {
            const { close, drop } = send(setup(), 50, 3600)

            expect(close).toBe(0)
            expect(drop).toBeGreaterThan(0)
        })

        it('keeps the limits of each connection separate', () => {
            const clock = fakeClock()
            const noisy = new ConnectionLimiter(clock.now)
            const quiet = new ConnectionLimiter(clock.now)

            for (let i = 0; i < RATE_LIMIT_BURST; i++) noisy.check()

            expect(noisy.check()).toBe('drop')
            expect(quiet.check()).toBe('allow')
        })
    })

    /**
     * Rates for a real client. A key press is two messages, a start and a release: the client ignores `event.repeat`
     * and only sends again once the key is back up. It pings every 5 s (PING_INTERVAL in the web client's lobby screen).
     *
     * It sends every press with no gate, and the engine doesn't queue one it rejects. So mashing is how a player lands a
     * spell the moment a GCD, lockout or cooldown ends, and the rates to allow are mashing rates.
     */
    describe('normal play', () => {
        const PING = 1 / 5
        const messagesPerSecond = (keyPressesPerSecond: number) => keyPressesPerSecond * 2 + PING

        it('never drops a player rolling 16 keys a second for 10 minutes', () => {
            const { allow, drop, close } = send(setup(), messagesPerSecond(16), 600)

            expect(drop + close).toBe(0)
            expect(allow).toBeGreaterThan(19_000)
        })

        it('does not drop a player mashing 20 keys a second for 3 minutes', () => {
            const { drop, close } = send(setup(), messagesPerSecond(20), 180)

            expect(drop + close).toBe(0)
        })

        it('does not drop a player mashing 24 keys a second for 4 s', () => {
            const { drop, close } = send(setup(), messagesPerSecond(24), 4)

            expect(drop + close).toBe(0)
        })

        it('never closes a player mashing 24 keys a second for 10 minutes, though some are dropped', () => {
            const { drop, close } = send(setup(), messagesPerSecond(24), 600)

            expect(close).toBe(0)
            expect(drop).toBeGreaterThan(0)
        })

        it('does not drop the releases sent when the window loses focus with every key held', () => {
            const ctx = setup()
            send(ctx, messagesPerSecond(6), 60)

            // six spells, each held by both a key and the pointer
            expect(burst(ctx, 12)).toEqual(Array(12).fill('allow'))
        })

        it('does not drop what a 3 s network stall replays at 6 keys a second', () => {
            const ctx = setup()
            send(ctx, messagesPerSecond(6), 60)

            const replay = burst(ctx, Math.ceil(messagesPerSecond(6) * 3))

            expect(replay).toEqual(Array(replay.length).fill('allow'))
        })

        it('does not close over what a 30 s stall replays at 6 keys a second', () => {
            const ctx = setup()
            send(ctx, messagesPerSecond(6), 60)

            expect(burst(ctx, Math.ceil(messagesPerSecond(6) * 30))).not.toContain('close')
        })
    })
})

describe('PlayerLimiters', () => {
    const COOLDOWN_MS = ABUSE_RECONNECT_COOLDOWN_SECONDS * 1000
    const setup = (pinned: string[] = []) => {
        const clock = fakeClock()
        return { clock, limits: new PlayerLimiters(id => pinned.includes(id), clock.now) }
    }
    const checks = (limiter: ConnectionLimiter, count: number) => {
        const verdicts: RateLimitVerdict[] = []
        for (let i = 0; i < count; i++) verdicts.push(limiter.check())
        return verdicts
    }
    /** Runs the limiter out, as a flood that gets the connection closed. */
    const floodUntilClosed = (limiter: ConnectionLimiter) => {
        while (limiter.check() !== 'close');
    }
    const PING = 1 / 5
    const messagesPerSecond = (keyPressesPerSecond: number) => keyPressesPerSecond * 2 + PING
    /** Sends at a steady rate on one limiter. */
    const steady = (
        clock: ReturnType<typeof fakeClock>,
        limiter: ConnectionLimiter,
        perSecond: number,
        seconds: number,
    ) => {
        const start = clock.ms
        const verdicts: RateLimitVerdict[] = []
        for (let i = 0; i < perSecond * seconds; i++) {
            clock.ms = start + Math.round((i * 1000) / perSecond)
            verdicts.push(limiter.check())
        }
        return verdicts
    }

    describe('across a reconnect', () => {
        it('hands the same player the buckets their last connection left', () => {
            const { limits } = setup()
            const first = limits.acquire('alice')
            checks(first, RATE_LIMIT_BURST)
            limits.release('alice', false)

            const again = limits.acquire('alice')

            expect(again).toBe(first)
            expect(again.check()).toBe('drop')
        })

        it('gives a different player their own buckets', () => {
            const { limits } = setup()
            checks(limits.acquire('alice'), RATE_LIMIT_BURST)

            expect(limits.acquire('bob').check()).toBe('allow')
        })

        it('shares one limit between connections of the same player', () => {
            const { limits } = setup()
            const tab = limits.acquire('alice')
            const otherTab = limits.acquire('alice')

            checks(tab, RATE_LIMIT_BURST)

            expect(otherTab.check()).toBe('drop')
        })

        it('starts a reconnect after a close on the allowance it has won back, not a full one', () => {
            const { clock, limits } = setup()
            floodUntilClosed(limits.acquire('alice'))
            limits.release('alice', true)

            clock.ms += COOLDOWN_MS
            const verdicts = checks(limits.acquire('alice'), RATE_LIMIT_BURST + ABUSE_DROP_ALLOWANCE + 1)

            // a full burst back, and 10 s of the allowance forgiven
            const regained = ABUSE_RECONNECT_COOLDOWN_SECONDS * ABUSE_DROPS_FORGIVEN_PER_SECOND
            expect(verdicts.indexOf('close')).toBe(RATE_LIMIT_BURST + regained)
        })
    })

    describe('the cooldown after a close', () => {
        it('refuses the player for the cooldown after a close for flooding', () => {
            const { clock, limits } = setup()
            limits.acquire('alice')
            limits.release('alice', true)

            expect(limits.refusedFor('alice')).toBe(COOLDOWN_MS)
            clock.ms += COOLDOWN_MS - 1
            expect(limits.refusedFor('alice')).toBe(1)
            clock.ms += 1
            expect(limits.refusedFor('alice')).toBe(0)
        })

        it('refuses nobody else', () => {
            const { limits } = setup()
            limits.acquire('alice')
            limits.release('alice', true)

            expect(limits.refusedFor('bob')).toBe(0)
        })

        it('never refuses a player who left normally', () => {
            const { limits } = setup()
            checks(limits.acquire('alice'), RATE_LIMIT_BURST + 10)
            limits.release('alice', false)

            expect(limits.refusedFor('alice')).toBe(0)
        })

        it('lets a loop of flood, close and reconnect in at most once per cooldown', () => {
            const { clock, limits } = setup()
            let admitted = 0
            // a client that tries again every 100 ms for a minute, and floods each time it gets in
            for (let ms = 0; ms < 60_000; ms += 100) {
                clock.ms += 100
                if (limits.refusedFor('alice') > 0) continue
                admitted++
                floodUntilClosed(limits.acquire('alice'))
                limits.release('alice', true)
            }

            expect(admitted).toBe(60 / ABUSE_RECONNECT_COOLDOWN_SECONDS)
        })

        it('ends well inside the reconnect grace, so a seated player closed by mistake keeps the match', () => {
            expect(ABUSE_RECONNECT_COOLDOWN_SECONDS).toBeLessThan(RECONNECT_GRACE / 2)
        })
    })

    describe('normal play across a reconnect', () => {
        it('does not drop the inputs of a player who reconnects after a drop at 6 keys a second', () => {
            const { clock, limits } = setup()
            steady(clock, limits.acquire('alice'), messagesPerSecond(6), 60)
            limits.release('alice', false)

            clock.ms += 1000
            const verdicts = steady(clock, limits.acquire('alice'), messagesPerSecond(16), 60)

            expect(limits.refusedFor('alice')).toBe(0)
            expect(verdicts).not.toContain('drop')
            expect(verdicts).not.toContain('close')
        })

        it('does not close over what a 30 s stall replays on reconnecting at 6 keys a second', () => {
            const { clock, limits } = setup()
            steady(clock, limits.acquire('alice'), messagesPerSecond(6), 60)
            limits.release('alice', false)

            const replay = checks(limits.acquire('alice'), Math.ceil(messagesPerSecond(6) * 30))

            expect(replay).not.toContain('close')
        })

        it('does not close a player who replays a 30 s stall, reconnects at once and plays on', () => {
            const { clock, limits } = setup()
            const first = limits.acquire('alice')
            steady(clock, first, messagesPerSecond(6), 60)
            expect(checks(first, Math.ceil(messagesPerSecond(6) * 30))).not.toContain('close')
            limits.release('alice', false)

            const after = steady(clock, limits.acquire('alice'), messagesPerSecond(6), 60)

            expect(after).not.toContain('close')
        })
    })

    describe('bounds on what is kept', () => {
        it('keeps a limit while a connection holds it, however long', () => {
            const { clock, limits } = setup()
            const limiter = limits.acquire('alice')

            clock.ms += IDLE_LIMIT_KEPT_MS * 10
            limits.acquire('bob')

            expect(limits.acquire('alice')).toBe(limiter)
        })

        it('keeps a limit until a connection of the player is gone for as long as a full refill takes', () => {
            const { clock, limits } = setup()
            const limiter = limits.acquire('alice')
            limits.acquire('alice')
            limits.release('alice', false)

            clock.ms += IDLE_LIMIT_KEPT_MS
            expect(limits.size).toBe(1)
            limits.release('alice', false)
            clock.ms += IDLE_LIMIT_KEPT_MS - 1
            expect(limits.refusedFor('alice')).toBe(0)
            expect(limits.size).toBe(1)
            expect(limits.acquire('alice')).toBe(limiter)
        })

        it('forgets an idle limit once it has refilled, which gives back nothing a new one would not', () => {
            const { clock, limits } = setup()
            const limiter = limits.acquire('alice')
            floodUntilClosed(limiter)
            limits.release('alice', true)

            clock.ms += IDLE_LIMIT_KEPT_MS
            expect(limits.refusedFor('alice')).toBe(0)
            expect(limits.size).toBe(0)
            // the one it forgot had refilled all the way
            expect(checks(limiter, RATE_LIMIT_BURST + ABUSE_DROP_ALLOWANCE + 1).indexOf('close')).toBe(
                RATE_LIMIT_BURST + ABUSE_DROP_ALLOWANCE,
            )
        })

        it('keeps the cooldown for as long as it lasts', () => {
            expect(IDLE_LIMIT_KEPT_MS).toBeGreaterThanOrEqual(ABUSE_RECONNECT_COOLDOWN_SECONDS * 1000)
        })

        it('keeps no more idle limits than the cap, forgetting the longest idle first', () => {
            const { clock, limits } = setup()
            for (let i = 0; i < MAX_IDLE_LIMITS + 5; i++) {
                limits.acquire(`player-${i}`)
                limits.release(`player-${i}`, true)
                clock.ms += 1
            }

            expect(limits.size).toBe(MAX_IDLE_LIMITS)
            expect(limits.refusedFor('player-4')).toBe(0)
            expect(limits.refusedFor('player-5')).toBeGreaterThan(0)
        })

        it('never forgets a limit in use to make room', () => {
            const { limits } = setup()
            const limiter = limits.acquire('alice')
            for (let i = 0; i < MAX_IDLE_LIMITS * 2; i++) {
                limits.acquire(`player-${i}`)
                limits.release(`player-${i}`, false)
            }

            expect(limits.size).toBe(MAX_IDLE_LIMITS + 1)
            expect(limits.acquire('alice')).toBe(limiter)
        })

        it('never forgets a pinned limit early, so a seated player cannot reset theirs under made-up ids', () => {
            const { clock, limits } = setup(['alice'])
            limits.acquire('alice')
            limits.release('alice', true)
            for (let i = 0; i < MAX_IDLE_LIMITS * 2; i++) {
                clock.ms += 1
                limits.acquire(`made-up-${i}`)
                limits.release(`made-up-${i}`, false)
            }

            expect(limits.size).toBe(MAX_IDLE_LIMITS)
            expect(limits.refusedFor('alice')).toBeGreaterThan(0)
        })

        it('still forgets a pinned limit once it has refilled', () => {
            const { clock, limits } = setup(['alice'])
            limits.acquire('alice')
            limits.release('alice', true)

            clock.ms += IDLE_LIMIT_KEPT_MS

            expect(limits.refusedFor('alice')).toBe(0)
            expect(limits.size).toBe(0)
        })

        it('forgets everything on clear', () => {
            const { limits } = setup()
            limits.acquire('alice')
            limits.acquire('bob')
            limits.release('bob', true)

            limits.clear()

            expect(limits.size).toBe(0)
            expect(limits.refusedFor('bob')).toBe(0)
        })

        it('ignores a release with no connection to give back', () => {
            const { limits } = setup()
            const limiter = limits.acquire('alice')
            limits.release('alice', false)
            limits.release('alice', true)
            limits.release('bob', true)

            expect(limits.refusedFor('alice')).toBe(0)
            expect(limits.refusedFor('bob')).toBe(0)
            expect(limits.acquire('alice')).toBe(limiter)
        })
    })
})
