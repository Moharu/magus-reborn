import { describe, expect, it } from 'vitest'
import { deriveSeed, isSeed, Rng } from '../src'

const take = (rng: Rng, n: number) => Array.from({ length: n }, () => rng.uint32())

describe('Rng (mulberry32)', () => {
    it('produces the pinned mulberry32 sequence', () => {
        // seed 0's first value is the reference 0.26642920868471265
        expect(take(new Rng(0), 3)).toEqual([1144304738, 1416247, 958946056])
        expect(new Rng(0).next()).toBe(0.26642920868471265)
        expect(take(new Rng(1), 5)).toEqual([2693262067, 11749833, 2265367787, 4213581821, 4159151403])
    })

    it('repeats for the same seed and differs for another', () => {
        expect(take(new Rng(42), 50)).toEqual(take(new Rng(42), 50))
        expect(take(new Rng(42), 50)).not.toEqual(take(new Rng(43), 50))
    })

    it('keeps next() in [0, 1) and int(n) in [0, n)', () => {
        const rng = new Rng(7)
        const seen = new Set<number>()
        for (let i = 0; i < 1000; i++) {
            const x = rng.next()
            expect(x >= 0 && x < 1).toBe(true)
            const k = rng.int(5)
            expect(Number.isInteger(k) && k >= 0 && k < 5).toBe(true)
            seen.add(k)
        }
        expect(seen.size).toBe(5)
        expect(() => rng.int(0)).toThrow(/positive integer/)
        expect(() => rng.int(1.5)).toThrow(/positive integer/)
    })
})

describe('deriveSeed', () => {
    it('is pinned, order-sensitive and separates sides', () => {
        expect(deriveSeed(1, 1)).toBe(3848424317)
        expect(deriveSeed(1, 2)).toBe(2456025444)
        expect(deriveSeed(1, 1, 2)).toBe(1555042368)
        expect(deriveSeed(1, 2, 1)).toBe(3886469265)
        expect(isSeed(deriveSeed(0xffffffff, 7, 9))).toBe(true)
    })

    it('accepts only integers in [0, 2^32) as seeds', () => {
        expect(isSeed(0)).toBe(true)
        expect(isSeed(0xffffffff)).toBe(true)
        for (const bad of [-1, 0x1_0000_0000, 1.5, Number.NaN, '1']) expect(isSeed(bad)).toBe(false)
    })
})
