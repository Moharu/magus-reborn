import { describe, expect, it } from 'vitest'
import {
    ABUSE_DROP_ALLOWANCE,
    ABUSE_DROPS_FORGIVEN_PER_SECOND,
    ConnectionLimiter,
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

            const { allow, drop } = send(ctx, 25, 10)

            // the last of the 250 goes out 9.96 s in, which is 199 whole tokens
            expect(allow).toBe(RATE_LIMIT_PER_SECOND * 10 - 1)
            expect(drop).toBe(51)
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

        it('closes 100 messages a second within a few seconds', () => {
            expect(send(setup(), 100, 60).closedAfterMs).toBeLessThan(7000)
        })

        it('closes a connection only just past 30 messages a second, in the end', () => {
            const { closedAfterMs } = send(setup(), 31, 600)

            expect(closedAfterMs).toBeGreaterThan(390_000)
            expect(closedAfterMs).toBeLessThan(420_000)
        })

        it('keeps 30 messages a second open, since dropping the excess is enough', () => {
            const { close, drop } = send(setup(), 30, 3600)

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
     */
    describe('normal play', () => {
        const PING = 1 / 5
        const messagesPerSecond = (keyPressesPerSecond: number) => keyPressesPerSecond * 2 + PING

        // the GCD is 1 s, so this is already far more than a spell rotation needs
        it('never drops a player spamming 6 keys a second for 10 minutes', () => {
            const { allow, drop, close } = send(setup(), messagesPerSecond(6), 600)

            expect(drop + close).toBe(0)
            expect(allow).toBeGreaterThan(7000)
        })

        it('does not drop a player mashing 10 keys a second for 3 minutes', () => {
            const { drop, close } = send(setup(), messagesPerSecond(10), 180)

            expect(drop + close).toBe(0)
        })

        it('does not drop a player mashing 12 keys a second for 5 s', () => {
            const { drop, close } = send(setup(), messagesPerSecond(12), 5)

            expect(drop + close).toBe(0)
        })

        it('never closes a player mashing 12 keys a second for 10 minutes, though some are dropped', () => {
            const { drop, close } = send(setup(), messagesPerSecond(12), 600)

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
