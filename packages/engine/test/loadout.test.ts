import { describe, expect, it } from 'vitest'
import {
    DEFAULT_ELEMENT,
    DEFAULT_SPELLS,
    ELEMENT_SPELL_COUNT,
    FIXED_SLOT,
    FIXED_SPELL,
    GENERAL_SPELL_COUNT,
    HOTKEYS,
    isValidLoadout,
    LOADOUT_SIZE,
    SPELL_IDS,
    SPELLBOOKS,
    SPELLS,
    type SpellElement,
    type SpellId,
} from '../src'

const VALID: SpellId[] = [
    'SPELL_FIREBALL',
    'SPELL_LIVING_BOMB',
    'SPELL_METEOR',
    'SPELL_AFTERBURN',
    'SPELL_COUNTERSPELL',
    'SPELL_BLUR',
    'SPELL_MAGIC_EATER',
]

/** VALID with the spell at `index` replaced. */
const withSlot = (index: number, id: string) => VALID.map((spell, i) => (i === index ? id : spell))

describe('spellbooks', () => {
    it('gives Fire its six Fire spells and the four general spells other than Counterspell', () => {
        expect(SPELLBOOKS.FIRE.element).toBe('FIRE')
        expect([...SPELLBOOKS.FIRE.elementSpells].sort()).toEqual(
            SPELL_IDS.filter(id => SPELLS[id].school === 'FIRE').sort(),
        )
        expect(SPELLBOOKS.FIRE.elementSpells).toHaveLength(6)
        expect([...SPELLBOOKS.FIRE.generalSpells].sort()).toEqual(
            ['SPELL_BLUR', 'SPELL_HASTE', 'SPELL_MAGIC_EATER', 'SPELL_TEMPORAL_SHIELD'].sort(),
        )
    })

    it.each(Object.keys(SPELLBOOKS) as SpellElement[])('%s offers enough spells to fill a loadout', element => {
        const book = SPELLBOOKS[element]
        expect(book.elementSpells.length).toBeGreaterThanOrEqual(ELEMENT_SPELL_COUNT)
        expect(book.generalSpells.length).toBeGreaterThanOrEqual(GENERAL_SPELL_COUNT)
        expect(book.elementSpells).not.toContain(FIXED_SPELL)
        expect(book.generalSpells).not.toContain(FIXED_SPELL)
    })
})

describe('loadout shape', () => {
    it('has 4 element slots, Counterspell in slot 5, then 2 general slots', () => {
        expect(ELEMENT_SPELL_COUNT).toBe(4)
        expect(GENERAL_SPELL_COUNT).toBe(2)
        expect(LOADOUT_SIZE).toBe(7)
        expect(FIXED_SPELL).toBe('SPELL_COUNTERSPELL')
        expect(FIXED_SLOT).toBe(4)
    })

    it('has one hotkey per slot: Q W E R for the element, Space for Counterspell, D F for general', () => {
        expect(HOTKEYS).toEqual(['Q', 'W', 'E', 'R', 'Space', 'D', 'F'])
        expect(HOTKEYS).toHaveLength(LOADOUT_SIZE)
        expect(HOTKEYS[FIXED_SLOT]).toBe('Space')
    })

    it('the default loadout is valid', () => {
        // validity only: the owner has yet to pick the 0.2 default
        expect(isValidLoadout(DEFAULT_SPELLS)).toBe(true)
        expect(isValidLoadout(DEFAULT_SPELLS, DEFAULT_ELEMENT)).toBe(true)
    })
})

describe('isValidLoadout', () => {
    it('accepts a valid loadout', () => {
        expect(isValidLoadout(VALID)).toBe(true)
        expect(isValidLoadout(VALID, 'FIRE')).toBe(true)
    })

    it('accepts the element spells and the general spells in any order within their slots', () => {
        const [a, b, c, d, cs, e, f] = VALID
        expect(isValidLoadout([d, c, b, a, cs, f, e])).toBe(true)
    })

    it.each<[string, unknown[]]>([
        ['3 element spells', withSlot(0, 'SPELL_HASTE')],
        ['5 element spells', withSlot(5, 'SPELL_IGNITE')],
        ['1 general spell', withSlot(6, 'SPELL_COMBUSTION')],
        ['3 general spells', withSlot(3, 'SPELL_TEMPORAL_SHIELD')],
        [
            'a general spell in an element slot and an element spell in a general slot',
            [
                'SPELL_FIREBALL',
                'SPELL_LIVING_BOMB',
                'SPELL_METEOR',
                'SPELL_BLUR',
                'SPELL_COUNTERSPELL',
                'SPELL_AFTERBURN',
                'SPELL_MAGIC_EATER',
            ],
        ],
        ['no Counterspell', withSlot(FIXED_SLOT, 'SPELL_HASTE')],
        ['a repeated element spell', withSlot(1, 'SPELL_FIREBALL')],
        ['a repeated general spell', withSlot(6, 'SPELL_BLUR')],
        ['Counterspell twice', withSlot(0, 'SPELL_COUNTERSPELL')],
        ['an unknown spell', withSlot(0, 'SPELL_NOPE')],
        ['a spell that is not a string', withSlot(0, 1 as never)],
        ['a name every object inherits', withSlot(0, 'toString')],
        [
            'the old 6-slot shape',
            [...DEFAULT_SPELLS.slice(0, 3), 'SPELL_HASTE', 'SPELL_COUNTERSPELL', 'SPELL_TEMPORAL_SHIELD'],
        ],
        [
            'the 0.1 default loadout',
            [
                'SPELL_FIREBALL',
                'SPELL_IGNITE',
                'SPELL_COMBUSTION',
                'SPELL_HASTE',
                'SPELL_COUNTERSPELL',
                'SPELL_TEMPORAL_SHIELD',
            ],
        ],
        ['too many spells', [...VALID, 'SPELL_HASTE']],
        ['no spells', []],
    ])('rejects %s', (_, spells) => {
        expect(isValidLoadout(spells)).toBe(false)
    })

    it.each([0, 1, 2, 3, 5, 6])('rejects Counterspell in slot index %i', index => {
        const spells = [...VALID]
        ;[spells[index], spells[FIXED_SLOT]] = [spells[FIXED_SLOT], spells[index]]
        expect(isValidLoadout(spells)).toBe(false)
    })

    it.each<[string, unknown]>([
        ['undefined', undefined],
        ['null', null],
        ['a string', 'SPELL_FIREBALL'],
        ['something that only looks like a list', { length: LOADOUT_SIZE }],
    ])('rejects %s', (_, spells) => {
        expect(isValidLoadout(spells)).toBe(false)
    })

    it.each(['GENERAL', 'FROST', 'toString', '__proto__'])(
        'rejects every loadout for an element it does not know: %s',
        element => {
            expect(isValidLoadout(VALID, element as SpellElement)).toBe(false)
        },
    )
})
