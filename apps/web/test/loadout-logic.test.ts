import { describe, expect, it } from 'vitest'
import { DEFAULT_SPELLS, FIXED_SLOT, type SpellId } from '@magus/engine'
import { canTarget, click, drop, kindOfSpell, loadoutValid, placeSpell, swapSlots } from '../src/ui/loadout-logic'

const E = 'FIRE' as const
// Q W E R | Space | D F
const BASE: SpellId[] = [...DEFAULT_SPELLS]

describe('loadout validity in the UI', () => {
    it('accepts the default and rejects wrong counts, order and the old 6-slot shape', () => {
        expect(loadoutValid(BASE, E)).toBe(true)
        expect(loadoutValid(BASE.slice(0, 6), E)).toBe(false)
        const swapped = [...BASE]
        ;[swapped[0], swapped[5]] = [swapped[5], swapped[0]]
        expect(loadoutValid(swapped, E)).toBe(false)
        expect(loadoutValid([...BASE.slice(0, 6), 'SPELL_HASTE'], E)).toBe(false)
    })

    it('classifies spellbook spells', () => {
        expect(kindOfSpell('SPELL_METEOR', E)).toBe('element')
        expect(kindOfSpell('SPELL_BLUR', E)).toBe('general')
        expect(kindOfSpell('SPELL_COUNTERSPELL', E)).toBeNull()
    })
})

describe('placeSpell', () => {
    it('replaces a slot with an unequipped spell of its section', () => {
        const next = placeSpell(BASE, 3, 'SPELL_METEOR', E)
        expect(next[3]).toBe('SPELL_METEOR')
        expect(loadoutValid(next, E)).toBe(true)
    })

    it('swaps when the spell is already equipped in the same section', () => {
        const next = placeSpell(BASE, 0, 'SPELL_AFTERBURN', E)
        expect(next.slice(0, 4)).toEqual(['SPELL_AFTERBURN', 'SPELL_IGNITE', 'SPELL_COMBUSTION', 'SPELL_FIREBALL'])
    })

    it('refuses the wrong section and the fixed slot, returning the same array', () => {
        expect(placeSpell(BASE, 0, 'SPELL_BLUR', E)).toBe(BASE)
        expect(placeSpell(BASE, 5, 'SPELL_METEOR', E)).toBe(BASE)
        expect(placeSpell(BASE, FIXED_SLOT, 'SPELL_METEOR', E)).toBe(BASE)
        expect(placeSpell(BASE, 0, 'SPELL_COUNTERSPELL', E)).toBe(BASE)
    })
})

describe('swapSlots', () => {
    it('swaps within a section', () => {
        expect(swapSlots(BASE, 0, 1, E).slice(0, 2)).toEqual(['SPELL_IGNITE', 'SPELL_FIREBALL'])
        expect(swapSlots(BASE, 5, 6, E).slice(5)).toEqual(['SPELL_TEMPORAL_SHIELD', 'SPELL_HASTE'])
    })

    it('never moves Counterspell or crosses sections', () => {
        expect(swapSlots(BASE, FIXED_SLOT, 0, E)).toBe(BASE)
        expect(swapSlots(BASE, 0, FIXED_SLOT, E)).toBe(BASE)
        expect(swapSlots(BASE, 0, 5, E)).toBe(BASE)
    })
})

describe('drag and drop', () => {
    it('drops a spellbook spell onto a slot', () => {
        const next = drop(BASE, { kind: 'spell', id: 'SPELL_METEOR' }, { kind: 'slot', index: 1 }, E)
        expect(next[1]).toBe('SPELL_METEOR')
    })

    it('drops a slot onto another slot to rearrange', () => {
        const next = drop(BASE, { kind: 'slot', index: 0 }, { kind: 'slot', index: 3 }, E)
        expect(next[0]).toBe('SPELL_AFTERBURN')
        expect(next[3]).toBe('SPELL_FIREBALL')
    })

    it('ignores drops that land on the spellbook or between spellbook spells', () => {
        expect(drop(BASE, { kind: 'spell', id: 'SPELL_METEOR' }, { kind: 'spell', id: 'SPELL_BLUR' }, E)).toBe(BASE)
    })
})

describe('click then click', () => {
    const state = { loadout: BASE, selection: null }

    it('spell then slot places the spell', () => {
        const picked = click(state, { kind: 'spell', id: 'SPELL_METEOR' }, E)
        expect(picked.selection).toEqual({ kind: 'spell', id: 'SPELL_METEOR' })
        const placed = click(picked, { kind: 'slot', index: 2 }, E)
        expect(placed.loadout[2]).toBe('SPELL_METEOR')
        expect(placed.selection).toBeNull()
    })

    it('slot then slot swaps them', () => {
        const picked = click(state, { kind: 'slot', index: 1 }, E)
        expect(picked.selection).toEqual({ kind: 'slot', index: 1 })
        const swapped = click(picked, { kind: 'slot', index: 2 }, E)
        expect(swapped.loadout.slice(1, 3)).toEqual(['SPELL_COMBUSTION', 'SPELL_IGNITE'])
        expect(swapped.selection).toBeNull()
    })

    it('slot then spell puts the spell in the slot', () => {
        const next = click(click(state, { kind: 'slot', index: 6 }, E), { kind: 'spell', id: 'SPELL_BLUR' }, E)
        expect(next.loadout[6]).toBe('SPELL_BLUR')
    })

    it('clicking the selection again clears it', () => {
        const picked = click(state, { kind: 'slot', index: 1 }, E)
        expect(click(picked, { kind: 'slot', index: 1 }, E).selection).toBeNull()
    })

    it('an invalid second click moves the selection and leaves the loadout alone', () => {
        const picked = click(state, { kind: 'spell', id: 'SPELL_BLUR' }, E)
        const next = click(picked, { kind: 'slot', index: 0 }, E)
        expect(next.loadout).toBe(BASE)
        expect(next.selection).toEqual({ kind: 'slot', index: 0 })
    })

    it('the fixed slot cannot be selected', () => {
        expect(click(state, { kind: 'slot', index: FIXED_SLOT }, E).selection).toBeNull()
    })

    it('lights up only valid targets', () => {
        const selection = { kind: 'spell', id: 'SPELL_BLUR' } as const
        expect(canTarget(BASE, selection, { kind: 'slot', index: 5 }, E)).toBe(true)
        expect(canTarget(BASE, selection, { kind: 'slot', index: 0 }, E)).toBe(false)
        expect(canTarget(BASE, null, { kind: 'slot', index: 5 }, E)).toBe(false)
    })
})
