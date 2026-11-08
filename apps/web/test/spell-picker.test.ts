import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_SPELLS } from '@magus/engine'
import { battleLayout, HEIGHT, WIDTH } from '../src/game/layout'
import { spellPicker } from '../src/ui/spell-picker'
import { FakeElement, FakeNode } from './fake-dom'

vi.mock('../src/game/icons', () => ({ iconUrl: () => 'icon.png' }))
vi.mock('../src/identity', () => ({ getAdvancedDescriptions: () => false, setAdvancedDescriptions: vi.fn() }))
beforeEach(() => {
    vi.stubGlobal('Node', FakeNode)
    vi.stubGlobal('document', { createElement: (tag: string) => new FakeElement(tag) })
})
afterEach(() => vi.unstubAllGlobals())

const target = (root: FakeElement, value: string) => root.find(el => el.attrs.get('data-target') === value)!

it('commits each valid replacement immediately, without a Confirm step', () => {
    const save = vi.fn()
    const picker = spellPicker([...DEFAULT_SPELLS], save)
    const root = picker.el as unknown as FakeElement
    target(root, 'spell:SPELL_AFTERBURN').click()
    expect(save).not.toHaveBeenCalled()
    target(root, 'slot:0').click()
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0][0]).toBe('SPELL_AFTERBURN')
    expect(root.textContent).not.toContain('Confirm')
})

it('Ready clears selection and prevents further changes', () => {
    const save = vi.fn()
    const picker = spellPicker([...DEFAULT_SPELLS], save)
    const root = picker.el as unknown as FakeElement
    target(root, 'spell:SPELL_AFTERBURN').click()
    picker.setLocked(true)
    target(root, 'slot:0').click()
    target(root, 'spell:SPELL_AFTERBURN').click()
    target(root, 'slot:0').click()
    expect(save).not.toHaveBeenCalled()
    expect(root.textContent).not.toContain('Edit loadout')
})

it('shows disabled teaser cards only before the match', () => {
    const save = vi.fn()
    const picker = spellPicker([...DEFAULT_SPELLS], save)
    const root = picker.el as unknown as FakeElement
    for (const name of ['Frost', 'Lightning']) {
        const card = root.find(el => el.tag === 'button' && el.textContent.includes(name))!
        expect((card as unknown as HTMLButtonElement).disabled).toBe(true)
        expect(card.textContent).toContain('Locked · coming later')
        card.click()
    }
    expect(save).not.toHaveBeenCalled()
    const swap = spellPicker([...DEFAULT_SPELLS], save, { elementLocked: true }).el as unknown as FakeElement
    expect(swap.textContent).not.toContain('Frost')
    expect(swap.textContent).toContain('locked for the match')
})

it('omits all visible keybind reminders for touch input', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const root = spellPicker([...DEFAULT_SPELLS], vi.fn()).el as unknown as FakeElement
    expect(root.find(el => el.className === 'key' || el.className === 'desktop-only')).toBeNull()
})

it('places all seven editable bar icons at the battle coordinates and size', () => {
    const root = spellPicker([...DEFAULT_SPELLS], vi.fn()).el as unknown as FakeElement
    const layout = battleLayout(WIDTH, HEIGHT)
    layout.slots.forEach((slot, index) => {
        const wrap = target(root, `slot:${index}`).parent!
        expect(wrap.style.cssText).toBe(
            `left:${(slot.x / WIDTH) * 100}%;top:${(slot.y / HEIGHT) * 100}%;width:${(slot.width / WIDTH) * 100}%;height:${(slot.width / HEIGHT) * 100}%`,
        )
    })
})
