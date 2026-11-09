import { expect, it } from 'vitest'
import { logFloat } from '../src/game/spell-log'

it('rises at a steady rate for the whole lifetime while fading, clamped at either end', () => {
    expect(logFloat(-1, false).offset).toBeCloseTo(0)
    expect(logFloat(-1, false).alpha).toBe(1)
    for (let age = 0; age <= 4; age += 0.5) {
        const current = logFloat(age, false)
        expect(current.offset).toBe(-6 * age)
        expect(current.alpha).toBe(1 - age / 4)
    }
    expect(logFloat(5, false)).toEqual({ offset: -24, alpha: 0 })
})

it('preserves fade timing without translation for reduced motion', () => {
    for (const age of [0, 0.1, 1, 2, 3.9, 4, 5]) {
        expect(logFloat(age, true)).toEqual({ offset: 0, alpha: logFloat(age, false).alpha })
    }
})
