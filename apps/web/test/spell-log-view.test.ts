import { expect, it, vi } from 'vitest'

vi.mock('pixi.js', () => {
    class Container {
        visible = true
        y = 0
        position = { set: vi.fn() }
        addChild = vi.fn()
        on = vi.fn()
    }
    class Graphics {
        clear() {
            return this
        }
        roundRect() {
            return this
        }
        rect() {
            return this
        }
        fill() {
            return this
        }
    }
    class Text {
        text = ''
        style = {}
        anchor = { set: vi.fn() }
        x = 0
        get width() {
            return this.text.length * 7
        }
    }
    return { Container, Graphics, Text }
})
import { SpellLogView } from '../src/game/spell-log-view'

it('reuses four objects, expires after four seconds, retains full history and respects reduced motion', () => {
    const nodes: { textContent: string; append: ReturnType<typeof vi.fn> }[] = []
    vi.stubGlobal('document', {
        createElement: () => {
            const node = { textContent: '', append: vi.fn(), setAttribute: vi.fn(), remove: vi.fn() }
            nodes.push(node)
            return node
        },
    })
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    try {
        const host = { append: vi.fn() }
        const view = new SpellLogView('player2', host as unknown as HTMLElement)
        const internal = view as unknown as {
            pool: { root: { visible: boolean; y: number }; text: { text: string } }[]
        }
        const objects = [...internal.pool]
        for (let i = 0; i < 10; i++)
            view.feed([
                { type: 'CANCEL_CAST', caster: 'player1', spellIndex: 999, spellId: 'SPELL_TEMPORAL_SHIELD', tick: i },
            ])
        expect(internal.pool).toHaveLength(4)
        expect(internal.pool.every(slot => objects.includes(slot))).toBe(true)
        expect(internal.pool.map(slot => slot.root.y)).toEqual([-90, -60, -30, 0])
        expect(nodes[0].append).toHaveBeenCalledTimes(10)
        expect(nodes[10].textContent).toBe('RIVAL: CANCELLED Temporal Shield')
        expect(internal.pool[3].text.text).toContain('…')
        view.advance(3.99)
        expect(internal.pool.every(slot => slot.root.visible)).toBe(true)
        view.advance(0.01)
        expect(internal.pool.every(slot => !slot.root.visible)).toBe(true)
    } finally {
        vi.unstubAllGlobals()
    }
})
