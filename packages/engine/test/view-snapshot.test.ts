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

describe('viewSnapshot and loadout-derived data', () => {
    // two valid loadouts with Fireball, Haste and Counterspell in different slots and different other spells
    const A = DEFAULT_SPELLS
    const B: typeof A = [
        'SPELL_METEOR',
        'SPELL_COMBUSTION',
        'SPELL_FIREBALL',
        'SPELL_IGNITE',
        'SPELL_COUNTERSPELL',
        'SPELL_BLUR',
        'SPELL_HASTE',
    ]

    /** player1 hastes, then casts Fireball; returns player2's view of the snapshot at each step. */
    const opponentViews = (loadout: typeof A) => {
        const b = new Battle({ name: 'A', spells: loadout }, { name: 'B', spells: other })
        const views: string[] = []
        const snap = () => views.push(JSON.stringify(viewSnapshot(b.snapshot(), 'player2').player1))
        b.startCast('player1', loadout.indexOf('SPELL_HASTE'))
        snap()
        b.tick()
        snap()
        b.startCast('player1', loadout.indexOf('SPELL_FIREBALL'))
        snap()
        for (let i = 0; i < 40; i++) {
            b.tick()
            snap()
        }
        return { views, b }
    }

    it('shows the opponent the same thing whatever the loadout, when the same spells were cast', () => {
        const a = opponentViews(A)
        const bb = opponentViews(B)
        expect(a.b.state.player1.effects.some(e => e.id === 'BUFF_HASTE')).toBe(true)
        // slot indices are what the log and `cast` expose for cast spells; everything else must match
        const strip = (v: string) => v.replace(/"cast":\d+/, '"cast":N')
        expect(a.views.map(strip)).toEqual(bb.views.map(strip))
    })

    it('does not give the opponent a Haste buff backup, but keeps it for the owner and spectators', () => {
        const { b } = opponentViews(A)
        const haste = (viewer: 'player1' | 'player2' | 'spectator') =>
            viewSnapshot(b.snapshot(), viewer).player1.effects.find(e => e.id === 'BUFF_HASTE')
        expect(haste('player2')).toBeDefined()
        expect(haste('player2')).not.toHaveProperty('backup')
        expect(haste('player1')).toHaveProperty('backup')
        expect(haste('spectator')).toHaveProperty('backup')
    })
})
