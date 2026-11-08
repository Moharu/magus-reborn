import { describe, expect, it } from 'vitest'
import { HOTKEYS, LOADOUT_SIZE } from '@magus/engine'
import { hotkeyFor, KEY_CODES } from '../src/game/hotkeys'
import { BAR, BAR_LEFT, BAR_WIDTH, buttonX, WIDTH } from '../src/game/layout'

describe('hotkeys', () => {
    it('maps the keyboard to slots in bar order, Counterspell on Space', () => {
        expect(HOTKEYS).toEqual(['Q', 'W', 'E', 'R', 'Space', 'D', 'F'])
        expect(KEY_CODES).toEqual({ KeyQ: 0, KeyW: 1, KeyE: 2, KeyR: 3, Space: 4, KeyD: 5, KeyF: 6 })
    })

    it('S no longer casts Counterspell', () => {
        expect(KEY_CODES.KeyS).toBeUndefined()
    })
})

describe('7 button bar layout', () => {
    const xs = Array.from({ length: LOADOUT_SIZE }, (_, i) => buttonX(i))

    it('has one equal-width button per slot, in order, without overlap', () => {
        expect(xs).toHaveLength(7)
        for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(BAR.button + BAR.gap)
    })

    it('groups Q W E R | Space | D F with wider gaps between groups', () => {
        expect(xs[4] - xs[3]).toBe(BAR.button + BAR.groupGap)
        expect(xs[5] - xs[4]).toBe(BAR.button + BAR.groupGap)
        expect(xs[1] - xs[0]).toBe(BAR.button + BAR.gap)
    })

    it('fits the 960 wide stage, centred', () => {
        expect(xs[0]).toBe(BAR_LEFT)
        expect(xs[6] + BAR.button).toBe(BAR_LEFT + BAR_WIDTH)
        expect(BAR_LEFT - BAR.panelPad).toBeGreaterThan(0)
        expect(BAR_LEFT * 2 + BAR_WIDTH).toBe(WIDTH)
    })

    it('rejects a slot that does not exist', () => {
        expect(() => buttonX(7)).toThrow()
    })
})

describe('hotkeyFor', () => {
    it('maps Space to the Counterspell slot', () => {
        expect(hotkeyFor({ code: 'Space', target: { tagName: 'BUTTON' } })).toBe(4)
    })

    it('ignores repeats, modified keys and typing in fields', () => {
        expect(hotkeyFor({ code: 'KeyQ', repeat: true })).toBeUndefined()
        expect(hotkeyFor({ code: 'KeyQ', ctrlKey: true })).toBeUndefined()
        expect(hotkeyFor({ code: 'Space', target: { tagName: 'INPUT' } })).toBeUndefined()
        expect(hotkeyFor({ code: 'KeyS' })).toBeUndefined()
    })
})
