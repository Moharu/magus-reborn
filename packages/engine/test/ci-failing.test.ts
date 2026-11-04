import { expect, test } from 'vitest'

test('deliberately failing (throwaway, do not merge)', () => {
    expect(1).toBe(2)
})
