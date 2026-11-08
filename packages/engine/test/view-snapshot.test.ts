import { describe, expect, it } from 'vitest'
import { Battle, DEFAULT_SPELLS, viewSnapshot } from '../src'

const other = [...DEFAULT_SPELLS.slice(0, 4).reverse(), ...DEFAULT_SPELLS.slice(4)]

const battle = () => {
    const b = new Battle({ name: 'A', spells: DEFAULT_SPELLS }, { name: 'B', spells: other })
    b.startCast('player1', 0)
    return b
}

describe('viewSnapshot', () => {
    it('gives a player their own loadout and withholds the opponent', () => {
        const snap = battle().snapshot()
        const one = viewSnapshot(snap, 'player1')
        expect(one.player1.spells).toEqual(snap.player1.spells)
        expect(one.player2).not.toHaveProperty('spells')
        const two = viewSnapshot(snap, 'player2')
        expect(two.player2.spells).toEqual(snap.player2.spells)
        expect(two.player1).not.toHaveProperty('spells')
    })

    it('gives a spectator both loadouts', () => {
        const snap = battle().snapshot()
        const view = viewSnapshot(snap, 'spectator')
        expect(view.player1.spells).toEqual(snap.player1.spells)
        expect(view.player2.spells).toEqual(snap.player2.spells)
    })

    it('keeps the spell being cast visible to the opponent, and nothing else of the loadout', () => {
        const view = viewSnapshot(battle().snapshot(), 'player2')
        expect(view.player1.casting).toMatchObject({ id: 'SPELL_FIREBALL' })
        expect(view.player2.casting).toBeNull()
        expect(JSON.stringify(view.player1)).not.toContain('SPELL_IGNITE')
    })

    it('does not change the snapshot it is given', () => {
        const snap = battle().snapshot()
        const copy = JSON.stringify(snap)
        viewSnapshot(snap, 'player2')
        expect(JSON.stringify(snap)).toBe(copy)
    })
})
