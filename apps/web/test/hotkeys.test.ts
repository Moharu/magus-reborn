import { describe, expect, it } from 'vitest'
import { HOTKEYS, LOADOUT_SIZE } from '@magus/engine'
import { hotkeyFor, createKeybindVisibility, KEY_CODES } from '../src/game/hotkeys'
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

    it('leaves keys to buttons inside a dialog or the picker', () => {
        const inside = (selector: string) => ({ tagName: 'BUTTON', closest: (s: string) => s.includes(selector) })
        expect(hotkeyFor({ code: 'Space', target: inside('dialog') })).toBeUndefined()
        expect(hotkeyFor({ code: 'Space', target: inside('.picker') })).toBeUndefined()
        expect(hotkeyFor({ code: 'Space', target: { tagName: 'BODY', closest: () => null } })).toBe(4)
    })

    it('ignores repeats, modified keys and typing in fields', () => {
        expect(hotkeyFor({ code: 'KeyQ', repeat: true })).toBeUndefined()
        expect(hotkeyFor({ code: 'KeyQ', ctrlKey: true })).toBeUndefined()
        expect(hotkeyFor({ code: 'Space', target: { tagName: 'INPUT' } })).toBeUndefined()
        expect(hotkeyFor({ code: 'KeyS' })).toBeUndefined()
    })
})

describe('keybind visibility', () => {
    const setup = (matching: string[] = []) => {
        const events = new EventTarget()
        const queries = new Map<string, EventTarget & { matches: boolean }>()
        const state = createKeybindVisibility(query => {
            const media = Object.assign(new EventTarget(), { matches: matching.includes(query) })
            queries.set(query, media)
            return media
        }, events as Window)
        const touch = (pointerType: string) =>
            events.dispatchEvent(Object.assign(new Event('pointerdown'), { pointerType }))
        return { state, queries, touch }
    }

    it.each([
        ['touch-only', ['(pointer: coarse)', '(any-pointer: coarse)', '(hover: none)'], false],
        ['hybrid with a fine primary mouse', ['(any-pointer: coarse)'], false],
        ['Android with a fine pointer but no hover', ['(hover: none)'], false],
        ['mouse-only', [], true],
    ] as const)('%s', (_name, matching, expected) => {
        expect(setup([...matching]).state.visible()).toBe(expected)
    })

    it('updates existing subscribers on the first touch, even when all media queries report a mouse', () => {
        const { state, touch } = setup()
        const seen: boolean[] = []
        const unsubscribe = state.subscribe(value => seen.push(value))
        touch('mouse')
        touch('pen')
        expect(seen).toEqual([true])
        touch('touch')
        expect(seen).toEqual([true, false])
        touch('mouse')
        touch('touch')
        expect(state.visible()).toBe(false)
        expect(seen).toEqual([true, false])
        unsubscribe()
    })

    it('updates subscribers when pointer capabilities change', () => {
        const { state, queries } = setup()
        const seen: boolean[] = []
        const unsubscribe = state.subscribe(value => seen.push(value))
        const media = queries.get('(any-pointer: coarse)')!
        media.matches = true
        media.dispatchEvent(new Event('change'))
        media.matches = false
        media.dispatchEvent(new Event('change'))
        expect(seen).toEqual([true, false, true])
        unsubscribe()
        media.matches = true
        media.dispatchEvent(new Event('change'))
        expect(seen).toEqual([true, false, true])
    })
})
