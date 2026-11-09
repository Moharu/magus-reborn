import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_LOADOUTS, DEFAULT_SPELLS, SPELLBOOKS, SPELLS, loadoutElement } from '@magus/engine'
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

it('selects Frost with four of six spells, while Lightning stays locked', () => {
    const save = vi.fn()
    const root = spellPicker([...DEFAULT_SPELLS], save, { overlayDetails: true }).el as unknown as FakeElement
    root.button('Frost')!.click()
    expect(loadoutElement(save.mock.calls[0][0])).toBe('FROST')
    expect(save.mock.calls[0][0]).toEqual(DEFAULT_LOADOUTS.FROST)
    for (const id of SPELLBOOKS.FROST.elementSpells) {
        const card = target(root, `spell:${id}`)
        expect(card).not.toBeNull()
        expect(card.attrs.get('title')).toBe(SPELLS[id].description)
        card.click()
        expect(root.querySelector('.header-details')!.textContent).toContain(SPELLS[id].label)
        card.click()
    }
    target(root, 'spell:SPELL_ICY_TOUCH').click()
    target(root, 'slot:0').click()
    expect(save.mock.lastCall![0].slice(0, 4)).toContain('SPELL_ICY_TOUCH')
    expect(loadoutElement(save.mock.lastCall![0])).toBe('FROST')
    const teaser = root.find(el => el.tag === 'button' && el.textContent.includes('Lightning'))!
    expect((teaser as unknown as HTMLButtonElement).disabled).toBe(true)
    expect(teaser.textContent).toContain('Locked · coming later')
})

it('locks the Frost element between rounds but allows same-element swaps until Ready', () => {
    const frost = [...SPELLBOOKS.FROST.elementSpells.slice(0, 4), ...DEFAULT_SPELLS.slice(4)]
    const save = vi.fn()
    const picker = spellPicker(frost, save, { elementLocked: true })
    const root = picker.el as unknown as FakeElement
    expect(root.button('Fire')).toBeNull()
    expect(root.textContent).toContain('Frost · locked for the match')
    target(root, 'spell:SPELL_FROST_FEVER').click()
    target(root, 'slot:0').click()
    expect(loadoutElement(save.mock.lastCall![0])).toBe('FROST')
    picker.setLocked(true)
    target(root, 'spell:SPELL_ICY_TOUCH').click()
    target(root, 'slot:0').click()
    expect(save).toHaveBeenCalledTimes(1)
})

it('places all seven editable bar icons at the battle coordinates and size', () => {
    const root = spellPicker([...DEFAULT_SPELLS], vi.fn()).el as unknown as FakeElement
    const layout = battleLayout(WIDTH, HEIGHT)
    layout.slots.forEach((slot, index) => {
        const wrap = target(root, `slot:${index}`).parent!
        expect(wrap.style.cssText).toBe(
            `left:${(slot.x / WIDTH) * 100}%;top:${(slot.y / HEIGHT) * 100}%;width:${(slot.width / WIDTH) * 100}%;height:${(slot.width / HEIGHT) * 100}%;--slot:${index}`,
        )
    })
})

it('keeps header details on the last tapped spell after deselection with accessible full text', () => {
    const root = spellPicker([...DEFAULT_SPELLS], vi.fn(), { overlayDetails: true }).el as unknown as FakeElement
    const details = () => root.querySelector('.header-details')!
    expect(details().textContent).toContain('Fireball')
    target(root, 'spell:SPELL_AFTERBURN').click()
    target(root, 'spell:SPELL_AFTERBURN').click()
    expect(target(root, 'spell:SPELL_AFTERBURN').attrs.get('aria-pressed')).toBe('false')
    expect(details().textContent).toContain('Afterburn')
    const description = details().find(el => el.tag === 'p')!
    expect(description.attrs.get('title')).toBe(description.textContent)
    expect(description.attrs.get('aria-label')).toBe(description.textContent)
    expect(details().find(el => el.tag === 'img')).not.toBeNull()
    expect(details().textContent).toContain('Cast')
})
