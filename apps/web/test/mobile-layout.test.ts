import { describe, expect, it, vi } from 'vitest'
import { Battle, DEFAULT_SPELLS, secondsToTicks } from '@magus/engine'
import { EventBoundary, FederatedPointerEvent } from 'pixi.js'
import { mobileBattleLayout, phoneLandscape } from '../src/game/layout'
import { keybindsVisible } from '../src/game/hotkeys'
import { ActionBar } from '../src/game/hud'

vi.mock('../src/game/textures', async () => {
    const { Texture } = await import('pixi.js')
    return { iconTexture: () => Texture.EMPTY }
})

describe('phone presentation', () => {
    it.each([
        [844, 390, 101],
        [667, 375, 84],
    ])('fits seven targets at %ix%i', (width, height, expected) => {
        const { slots, bar, log } = mobileBattleLayout(width, height)
        expect(slots).toHaveLength(7)
        expect(new Set(slots.map(s => s.width)).size).toBe(1)
        expect(slots[0].width).toBeCloseTo(expected, -1)
        for (const [i, slot] of slots.entries()) {
            expect(slot.width).toBeGreaterThanOrEqual(44)
            expect(slot.height).toBeGreaterThanOrEqual(44)
            expect(slot.y).toBeGreaterThan(bar.y)
            expect(slot.y + slot.height).toBeLessThan(bar.y + bar.height)
            expect(slot.x).toBeGreaterThanOrEqual(0)
            expect(slot.x + slot.width).toBeLessThanOrEqual(width)
            if (i) expect(slot.x - slots[i - 1].x - slot.width).toBeGreaterThanOrEqual(3.999)
        }
        expect(log.y).toBeLessThan(bar.y)
        expect(log.x).toBe(width / 2)
    })

    it('selects compact geometry only on landscape phones', () => {
        expect(phoneLandscape(844, 390)).toBe(true)
        expect(phoneLandscape(667, 375)).toBe(true)
        expect(phoneLandscape(390, 844)).toBe(false)
        expect(phoneLandscape(900, 500)).toBe(true)
        expect(phoneLandscape(901, 500)).toBe(false)
        expect(phoneLandscape(600, 600)).toBe(false)
    })

    it('hides keys with a coarse primary pointer even when hover is available', () => {
        expect(keybindsVisible(query => ({ matches: query === '(pointer: coarse)' }))).toBe(false)
        expect(keybindsVisible(() => ({ matches: false }))).toBe(true)
    })

    it('retains touch owners across resizing and shows a local blocked reason', () => {
        const press = vi.fn()
        const release = vi.fn()
        const bar = new ActionBar(press, release)
        const root = bar.children[1]
        const game = new Battle({ name: 'A', spells: DEFAULT_SPELLS }, { name: 'B', spells: DEFAULT_SPELLS })
        game.state.player1.lockedUntil = secondsToTicks(3)
        bar.update(game.state.player1, 0, new Set())
        bar.fitPhone(667, 375, true)
        const event = new FederatedPointerEvent(new EventBoundary(bar))
        event.pointerType = 'touch'
        root.emit('pointerdown', event)
        expect(bar.pressed.has(0)).toBe(true)
        expect(root.children.at(-1)).toMatchObject({ text: 'Locked' })
        bar.fitPhone(844, 390, true)
        expect(bar.children[1]).toBe(root)
        expect(bar.pressed.has(0)).toBe(true)
        root.emit('pointerup', event)
        root.emit('click', event)
        expect(press).toHaveBeenCalledExactlyOnceWith(0)
        expect(release).toHaveBeenCalledExactlyOnceWith(0)
        expect(bar.pressed.size).toBe(0)
        bar.fitPhone(960, 600, false)
        expect(root.scale.x).toBe(1)
        expect(root.scale.y).toBe(1)
    })

    it('clears the local blocked reason after a second of engine time', () => {
        const bar = new ActionBar(vi.fn(), vi.fn())
        const root = bar.children[1]
        const game = new Battle({ name: 'A', spells: DEFAULT_SPELLS }, { name: 'B', spells: DEFAULT_SPELLS })
        game.state.player1.lockedUntil = secondsToTicks(10)
        bar.update(game.state.player1, 0, new Set())
        const event = new FederatedPointerEvent(new EventBoundary(bar))
        root.emit('pointerdown', event)
        expect(root.children.at(-1)).toMatchObject({ text: 'Locked' })
        bar.update(game.state.player1, 20, new Set())
        expect(root.children.at(-1)).toMatchObject({ text: 'Locked' })
        bar.update(game.state.player1, 21, new Set())
        expect(root.children.at(-1)).toMatchObject({ text: '' })
    })
})
