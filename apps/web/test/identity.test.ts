import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SPELLS } from '@magus/engine'

const store = new Map<string, string>()

beforeEach(() => {
    store.clear()
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
    })
    vi.resetModules()
})
afterEach(() => vi.unstubAllGlobals())

describe('stored loadout', () => {
    it('keeps a valid 7-slot loadout', async () => {
        const mine = [...DEFAULT_SPELLS]
        mine[3] = 'SPELL_METEOR'
        store.set('magus.loadout', JSON.stringify(mine))
        const { getLoadout } = await import('../src/identity')
        expect(getLoadout()).toEqual(mine)
    })

    it('discards the old 6-slot loadout and garbage without error', async () => {
        const { getLoadout } = await import('../src/identity')
        store.set('magus.loadout', JSON.stringify(DEFAULT_SPELLS.slice(0, 6)))
        expect(getLoadout()).toEqual(DEFAULT_SPELLS)
        store.set('magus.loadout', '{nope')
        expect(getLoadout()).toEqual(DEFAULT_SPELLS)
    })
})
