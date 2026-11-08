import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('pixi.js', () => {
    class Container {
        visible = true
        y = 0
        position = { set: vi.fn() }
        children: Container[] = []
        addChild(...children: Container[]) {
            this.children.push(...children)
        }
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

import { Battle, viewSnapshot } from '@magus/engine'

const history = {
    children: [] as { textContent: string }[],
    append(node: { textContent: string }) {
        this.children.push(node)
    },
    replaceChildren() {
        this.children = []
    },
    setAttribute: vi.fn(),
    className: '',
}
const host = { append: vi.fn(), querySelector: () => history }
beforeEach(() => {
    vi.stubGlobal('document', { createElement: () => ({ textContent: '' }) })
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
})
afterEach(() => vi.unstubAllGlobals())
const makeView = () => new SpellLogView('player1', host as unknown as HTMLElement)
const release = { type: 'SPELL_RELEASE', caster: 'player1', spellId: 'SPELL_HASTE', spellIndex: 1, tick: 0 } as const
const snapshot = () =>
    viewSnapshot(
        new Battle(
            { name: 'a', spells: ['SPELL_FIREBALL', 'SPELL_HASTE'] },
            { name: 'b', spells: ['SPELL_HASTE'] },
        ).snapshot(),
        'player1',
    )

it('seeds catch-up without old announcements, deduplicates the next broadcast and resets each round', () => {
    const view = makeView()
    const snap = snapshot()
    view.update([release], 0, false, 1, snap)
    expect(history.children).toHaveLength(0)
    expect(view.children.every(row => !row.visible)).toBe(true)
    view.update([release, release], 0, true, 1, snap)
    expect(history.children.map(node => node.textContent)).toEqual(['YOU: Haste'])
    view.update([release], 1, true, 1, snap)
    expect(history.children).toHaveLength(1)
    view.update([], 0, true, 2, snap)
    expect(history.children).toHaveLength(0)
    expect(view.children.every(row => !row.visible)).toBe(true)
    view.update([release], 0, true, 2, snap)
    expect(history.children).toHaveLength(1)
    makeView()
    expect(history.children).toHaveLength(0)
})

it('recovers the public cast for an early stop after catch-up', () => {
    const battle = new Battle({ name: 'a', spells: ['SPELL_FIREBALL'] }, { name: 'b', spells: ['SPELL_HASTE'] })
    battle.startCast('player1', 0)
    const view = makeView()
    view.update(battle.state.log, 0, false, 1, viewSnapshot(battle.snapshot(), 'player1'))
    const from = battle.state.log.length
    battle.stopCast('player1', 0)
    view.update(battle.state.log.slice(from), from, true, 1, viewSnapshot(battle.snapshot(), 'player1'))
    expect(history.children.map(node => node.textContent)).toEqual(['YOU: CANCELLED Fireball'])
})

it('animates public display rows, reuses four children and expires them after four seconds', () => {
    const view = makeView()
    const rows = [...view.children]
    view.feed([release])
    view.feed([release])
    view.advance(0.075)
    expect(view.children.filter(row => row.visible).map(row => row.y)).toEqual([-15, 0])
    view.advance(0.075)
    expect(view.children.filter(row => row.visible).map(row => row.y)).toEqual([-30, 0])
    for (let i = 0; i < 8; i++) view.feed([release])
    expect(view.children).toEqual(rows)
    expect(view.children.filter(row => row.visible)).toHaveLength(4)
    expect(history.children).toHaveLength(10)
    view.advance(3.99)
    expect(view.children.some(row => row.visible)).toBe(true)
    view.advance(0.01)
    expect(view.children.every(row => !row.visible)).toBe(true)
})

it('snaps rows with reduced motion', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const view = makeView()
    view.feed([release, release])
    expect(view.children.filter(row => row.visible).map(row => row.y)).toEqual([-30, 0])
})
