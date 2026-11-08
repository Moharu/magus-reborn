import { describe, expect, it, vi } from 'vitest'
import { Battle, DEFAULT_SPELLS, secondsToTicks, ticksToSeconds } from '@magus/engine'
import { battleLayout, HEIGHT, sidesFor, WIDTH, type Rect } from '../src/game/layout'
import { ActionBar, PlayerHud } from '../src/game/hud'
import { BattleView } from '../src/game/battle-view'

vi.mock('../src/game/textures', async () => {
    const { Texture } = await import('pixi.js')
    return { iconTexture: () => Texture.EMPTY, particleTexture: () => Texture.EMPTY }
})

const overlaps = (a: Rect, b: Rect) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

const battle = () => new Battle({ name: 'Alice', spells: DEFAULT_SPELLS }, { name: 'Bob', spells: DEFAULT_SPELLS })

describe('Split Console desktop geometry', () => {
    it.each([
        [960, 600],
        [1200, 720],
    ])('fits at %ix%i without overlapping controls', (width, height) => {
        const layout = battleLayout(width, height)
        const rectangles = [
            ...Object.values(layout.left),
            ...Object.values(layout.right),
            layout.score,
            layout.timer,
            ...Object.values(layout.fighters),
            layout.centre,
            ...layout.slots,
        ]
        for (const r of [...rectangles, layout.bar]) {
            expect(r.x).toBeGreaterThanOrEqual(0)
            expect(r.y).toBeGreaterThanOrEqual(0)
            expect(r.x + r.width).toBeLessThanOrEqual(width)
            expect(r.y + r.height).toBeLessThanOrEqual(height)
        }
        for (let i = 0; i < rectangles.length; i++)
            for (let j = i + 1; j < rectangles.length; j++) expect(overlaps(rectangles[i], rectangles[j])).toBe(false)
        expect(layout.slots).toHaveLength(7)
        expect(new Set(layout.slots.map(r => r.width)).size).toBe(1)
        for (const r of layout.slots) {
            expect(r.x).toBeGreaterThan(layout.bar.x)
            expect(r.x + r.width).toBeLessThan(layout.bar.x + layout.bar.width)
            expect(r.y + r.height).toBeLessThanOrEqual(layout.bar.y + layout.bar.height)
        }
    })

    it('keeps the local seat on the left', () => {
        expect(sidesFor('player1')).toEqual({ left: 'player1', right: 'player2' })
        expect(sidesFor('player2')).toEqual({ left: 'player2', right: 'player1' })
    })
})

// Inspect the actual Pixi tree without a browser or a GPU.
interface Slot {
    root: { x: number; y: number; accessibleHint: string }
    name: { text: string }
    key: { text: string; visible: boolean }
    center: { text: string }
}

describe('Split Console elements', () => {
    it('draws only seven own buttons in loadout order, with desktop keys and no status captions', () => {
        const bar = new ActionBar(
            () => {},
            () => {},
        )
        const player = battle().state.player1
        bar.update(player, 0, new Set())
        const slots = (bar as unknown as { buttons: Slot[] }).buttons
        expect(slots).toHaveLength(7)
        expect(slots.map(b => b.key.text)).toEqual(['Q', 'W', 'E', 'R', 'Space', 'D', 'F'])
        expect(slots.every(b => b.key.visible)).toBe(true)
        expect(slots.map(b => b.name.text)).toEqual([
            'Fireball',
            'Ignite',
            'Combustion',
            'Afterburn',
            'Counter Spell',
            'Haste',
            'Temporal Shield',
        ])
        expect(slots.every(b => b.center.text === '')).toBe(true)
        const layout = battleLayout(WIDTH, HEIGHT)
        slots.forEach((b, i) => expect(b.root.x).toBe(layout.slots[i].x + layout.slots[i].width / 2))
    })

    it('shows a lock glyph and lock seconds on all seven icons even with a longer cooldown', () => {
        const bar = new ActionBar(
            () => {},
            () => {},
        )
        const player = battle().state.player1
        player.lockedUntil = secondsToTicks(3)
        player.spells[4].lastCast = 0
        bar.update(player, 1, new Set())
        const slots = (bar as unknown as { buttons: Slot[] }).buttons
        expect(slots.every(b => b.center.text === '🔒 3.0s')).toBe(true)
        expect(slots[4].root.accessibleHint).toContain(
            `Personal cooldown ${ticksToSeconds(player.spells[4].cooldown - 1).toFixed(1)} seconds`,
        )
        bar.update(player, player.lockedUntil, new Set())
        expect(slots.every(b => !b.center.text.includes('🔒'))).toBe(true)
        expect(slots[4].center.text).toBe(
            `${ticksToSeconds(player.spells[4].cooldown - player.lockedUntil).toFixed(1)}s`,
        )
    })

    it('places numeric HP above each green bar', () => {
        const hud = new PlayerHud('right')
        hud.update(battle().snapshot().player2, 0, 1 / 60)
        const text = (hud as unknown as { hpText: { text: string; y: number } }).hpText
        expect(text.text).toBe('100.0 / 100 HP')
        expect(text.y).toBeLessThan(battleLayout(WIDTH, HEIGHT).right.hp.y)
    })

    it('handles Space only in active combat, preventing scrolling when handled', () => {
        const Ctor = BattleView as unknown as new (
            container: unknown,
            options: unknown,
        ) => {
            update: BattleView['update']
            setFrozen: BattleView['setFrozen']
            onKeyDown(event: unknown): void
            overlay: { visible: boolean }
        }
        const press = vi.fn()
        const view = new Ctor({}, { me: 'player1', onPress: press })
        const event = { code: 'Space', preventDefault: vi.fn() }
        view.onKeyDown(event)
        expect(event.preventDefault).not.toHaveBeenCalled()
        view.update(battle().snapshot(), [], [])
        view.overlay.visible = false
        view.setFrozen(true)
        view.onKeyDown(event)
        expect(press).not.toHaveBeenCalled()
        view.setFrozen(false)
        view.onKeyDown(event)
        expect(press).toHaveBeenCalledWith(4)
        expect(event.preventDefault).toHaveBeenCalledOnce()
        view.onKeyDown({ ...event, repeat: true })
        expect(event.preventDefault).toHaveBeenCalledTimes(2)
        expect(press).toHaveBeenCalledTimes(1)
    })
})
