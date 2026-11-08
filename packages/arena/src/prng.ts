/**
 * The arena's only source of randomness: a small seeded PRNG (mulberry32) and a seed mixer. No imports and no global
 * state, so the same seed always gives the same sequence. The engine stays deterministic and never sees this module.
 */

const UINT32_RANGE = 0x1_0000_0000

/** True for an integer in [0, 2^32), the range a seed must be in. */
export const isSeed = (seed: unknown): seed is number =>
    typeof seed === 'number' && Number.isInteger(seed) && seed >= 0 && seed < UINT32_RANGE

/** murmur3's 32-bit finalizer: a bijection on uint32 that spreads every input bit over the output. */
const fmix32 = (h: number) => {
    h ^= h >>> 16
    h = Math.imul(h, 0x85ebca6b)
    h ^= h >>> 13
    h = Math.imul(h, 0xc2b2ae35)
    h ^= h >>> 16
    return h >>> 0
}

/**
 * A seed derived from `seed` and integer `parts` (for example a side, a pair index, a game index). Order matters:
 * `deriveSeed(s, 1, 2)` and `deriveSeed(s, 2, 1)` differ. Each part is taken modulo 2^32.
 */
export const deriveSeed = (seed: number, ...parts: number[]) => {
    let h = fmix32(seed >>> 0)
    for (const part of parts) h = fmix32((h ^ fmix32(((part >>> 0) + 0x9e3779b9) >>> 0)) >>> 0)
    return h
}

/** mulberry32: 32 bits of state, period 2^32, fast enough to sample every tick. */
export class Rng {
    private state: number

    constructor(seed: number) {
        this.state = seed >>> 0
    }

    /** The next integer in [0, 2^32). */
    uint32() {
        this.state = (this.state + 0x6d2b79f5) >>> 0
        let t = this.state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return (t ^ (t >>> 14)) >>> 0
    }

    /** The next float in [0, 1). */
    next() {
        return this.uint32() / UINT32_RANGE
    }

    /** The next integer in [0, n). `n` must be a positive integer. */
    int(n: number) {
        if (!(Number.isInteger(n) && n > 0)) throw new Error(`Rng.int: n must be a positive integer, got ${n}`)
        return Math.floor(this.next() * n)
    }
}
