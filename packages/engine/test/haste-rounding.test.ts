import { afterEach, describe, expect, it, vi } from 'vitest'
import { secondsToTicks, type SpellId } from '../src'
import { hastedCastTime } from '../src/spells/general/haste'
import { advance, castFull, FIRE, setup, slot } from './helpers'

const LOADOUT: SpellId[] = [...FIRE.slice(0, 5), 'SPELL_HASTE']

/** Gives Fireball a cast time no catalog spell has: at 50 ms ticks, 1.65 s is 33 ticks. */
const withOddFireball = () => {
    const b = setup(LOADOUT)
    const fireball = b.state.player1.spells[slot(b, 'player1', 'SPELL_FIREBALL')]
    fireball.castSeconds = 1.65
    fireball.castTime = secondsToTicks(1.65)
    return { b, fireball }
}

describe('hasted cast time at the real tick rate', () => {
    it('halves an even tick count exactly (32 -> 16)', () => {
        const b = setup(LOADOUT)
        const ignite = slot(b, 'player1', 'SPELL_IGNITE')
        expect(b.state.player1.spells[ignite].castTime).toBe(32)
        castFull(b, 'player1', 'SPELL_HASTE')
        expect(b.state.player1.spells[ignite].castTime).toBe(16)
    })

    it('rounds an odd tick count up (33 -> 17)', () => {
        const { b, fireball } = withOddFireball()
        expect(fireball.castTime).toBe(33)
        castFull(b, 'player1', 'SPELL_HASTE')
        expect(b.state.player1.spells[slot(b, 'player1', 'SPELL_FIREBALL')].castTime).toBe(17)
    })

    it('the rounded-up odd cast really takes 17 ticks, then the base 33 comes back', () => {
        const { b } = withOddFireball()
        const index = slot(b, 'player1', 'SPELL_FIREBALL')
        castFull(b, 'player1', 'SPELL_HASTE')

        advance(b, 20) // past the GCD
        b.startCast('player1', index)
        advance(b, 16)
        expect(b.stopCast('player1', index)).toBe(false)

        b.startCast('player1', index)
        advance(b, 17)
        expect(b.stopCast('player1', index)).toBe(true)

        advance(b, 1)
        expect(b.state.player1.spells[index].castTime).toBe(33)
    })

    it('refreshing Haste on an odd cast does not halve it again', () => {
        const { b } = withOddFireball()
        castFull(b, 'player1', 'SPELL_HASTE')
        advance(b, secondsToTicks(10))
        castFull(b, 'player1', 'SPELL_HASTE')
        expect(b.state.player1.spells[slot(b, 'player1', 'SPELL_FIREBALL')].castTime).toBe(17)
    })

    it('leaves instants instant', () => {
        const b = setup(LOADOUT)
        castFull(b, 'player1', 'SPELL_HASTE')
        expect(b.state.player1.spells[slot(b, 'player1', 'SPELL_HASTE')].castTime).toBe(0)
    })

    it('is ceil(n / 2) for every whole tick count, despite float noise in the seconds', () => {
        for (let n = 1; n <= 400; n++) {
            expect(hastedCastTime((n * 50) / 1000), `${n} ticks`).toBe(Math.ceil(n / 2))
            expect(hastedCastTime(n * 0.05), `${n} ticks via n * 0.05`).toBe(Math.ceil(n / 2))
        }
    })

    it('never rounds a cast down to an instant', () => {
        expect(secondsToTicks(0.04)).toBe(1)
        expect(hastedCastTime(0.04)).toBe(1)
    })
})

describe('rounding rule at any tick interval', () => {
    it('picks the nearest tick', () => {
        expect(hastedCastTime(1.3, 40)).toBe(16) // 16.25
        expect(hastedCastTime(1.1, 40)).toBe(14) // 13.75
    })

    it('rounds exact ties up', () => {
        expect(hastedCastTime(1.3, 100)).toBe(7) // 6.5
        expect(hastedCastTime(1.1, 100)).toBe(6) // 5.5
    })

    it('keeps ties that floats would otherwise land just below', () => {
        expect((1.005 * 1000) / 10).toBeLessThan(100.5)
        expect(secondsToTicks(1.005, 10)).toBe(101)
        expect(hastedCastTime(2.01, 10)).toBe(101) // 100.5
        expect(hastedCastTime(2.01, 30)).toBe(34) // 33.5
        expect(hastedCastTime(1.05, 1000 / 60)).toBe(32) // 31.5, at 60 ticks per second
        expect(hastedCastTime(1.75, 1000 / 60)).toBe(53) // 52.5
    })
})

describe('the engine at a different tick rate', () => {
    /** Loads a fresh engine whose constants run at `interval` ms per tick. */
    const engineAt = async (interval: number) => {
        vi.resetModules()
        vi.doMock('../src/constants', async importOriginal => {
            const actual = await importOriginal<typeof import('../src/constants')>()
            return {
                ...actual,
                GAME_TICK_INTERVAL: interval,
                secondsToTicks: (seconds: number) => actual.secondsToTicks(seconds, interval),
                GLOBAL_COOLDOWN: actual.secondsToTicks(actual.GLOBAL_COOLDOWN_SECONDS, interval),
            }
        })
        return import('../src/battle')
    }

    afterEach(() => {
        vi.doUnmock('../src/constants')
        vi.resetModules()
    })

    // base and hasted ticks per spell, worked out by hand from the cast seconds
    it.each([
        {
            interval: 50,
            expected: {
                SPELL_FIREBALL: [26, 13],
                SPELL_IGNITE: [32, 16],
                SPELL_COMBUSTION: [48, 24],
                SPELL_AFTERBURN: [22, 11],
                SPELL_LIVING_BOMB: [30, 15],
                SPELL_METEOR: [72, 36],
            },
        },
        {
            // 0.65 s = 16.25 ticks -> 16: not half of Fireball's already rounded 33 ticks
            interval: 40,
            expected: {
                SPELL_FIREBALL: [33, 16],
                SPELL_IGNITE: [40, 20],
                SPELL_COMBUSTION: [60, 30],
                SPELL_AFTERBURN: [28, 14],
                SPELL_LIVING_BOMB: [38, 19],
                SPELL_METEOR: [90, 45],
            },
        },
        {
            // odd base tick counts: ties round up
            interval: 100,
            expected: {
                SPELL_FIREBALL: [13, 7],
                SPELL_IGNITE: [16, 8],
                SPELL_COMBUSTION: [24, 12],
                SPELL_AFTERBURN: [11, 6],
                SPELL_LIVING_BOMB: [15, 8],
                SPELL_METEOR: [36, 18],
            },
        },
        {
            // a tick interval that isn't a whole number of milliseconds
            interval: 1000 / 60,
            expected: {
                SPELL_FIREBALL: [78, 39],
                SPELL_IGNITE: [96, 48],
                SPELL_COMBUSTION: [144, 72],
                SPELL_AFTERBURN: [66, 33],
                SPELL_LIVING_BOMB: [90, 45],
                SPELL_METEOR: [216, 108],
            },
        },
    ])('Haste halves every cast at $interval ms per tick', async ({ interval, expected }) => {
        const { Battle } = await engineAt(interval)
        const b = new Battle(
            { name: 'Alice', spells: [...FIRE, 'SPELL_HASTE'] },
            { name: 'Bob', spells: ['SPELL_FIREBALL'] },
        )
        const ticks = () => Object.fromEntries(b.state.player1.spells.map(s => [s.id, s.castTime]))
        const column = (i: 0 | 1) => Object.fromEntries(Object.entries(expected).map(([id, t]) => [id, t[i]]))

        expect(ticks()).toEqual({ ...column(0), SPELL_HASTE: 0 })
        b.startCast('player1', FIRE.length)
        expect(ticks()).toEqual({ ...column(1), SPELL_HASTE: 0 })
    })

    it('a hasted cast releases on the derived tick and the base cast time comes back', async () => {
        const { Battle } = await engineAt(40)
        const b = new Battle(
            { name: 'Alice', spells: ['SPELL_FIREBALL', 'SPELL_HASTE'] },
            { name: 'Bob', spells: ['SPELL_FIREBALL'] },
        )
        const ticks = (n: number) => {
            for (let i = 0; i < n; i++) b.tick()
        }
        b.startCast('player1', 1)
        ticks(25) // past the 1 s GCD, also 25 ticks at this rate

        b.startCast('player1', 0)
        ticks(15)
        expect(b.stopCast('player1', 0)).toBe(false)

        b.startCast('player1', 0)
        ticks(16)
        expect(b.stopCast('player1', 0)).toBe(true)

        b.tick()
        expect(b.state.player1.spells[0].castTime).toBe(33)
    })
})
