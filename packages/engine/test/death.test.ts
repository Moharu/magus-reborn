import { describe, expect, it } from 'vitest'
import { Battle, simpleDamage, simpleDebuff, type BattleSnapshot, type IgniteDebuff, type SpellId } from '../src'
import { castFull, FIRE, GENERAL, setup, slot } from './helpers'

describe('HP clamp and immediate death resolution', () => {
    it('simpleDamage never takes HP below 0', () => {
        const b = setup()
        simpleDamage(b.state, 'player2', 1000)
        expect(b.state.player2.hp).toBe(0)
    })

    it('an instant lethal cast sets HP to 0 and winner immediately, and the next startCast returns false', () => {
        const b = setup(FIRE, GENERAL, { p2hp: 10 })
        const meteor = slot(b, 'player1', 'SPELL_METEOR')
        b.state.player1.spells[meteor].castTime = 0
        expect(b.startCast('player1', meteor)).toBe(true)
        expect(b.state.player2.hp).toBe(0)
        expect(b.state.winner).toBe('player1')
        expect(b.snapshot().player2.hp).toBe(0)
        expect(b.startCast('player2', slot(b, 'player2', 'SPELL_BLUR'))).toBe(false)
        expect(b.startCast('player1', slot(b, 'player1', 'SPELL_FIREBALL'))).toBe(false)
    })

    it('a lethal Combustion released between ticks resolves the winner before the next tick', () => {
        const b = setup(FIRE, GENERAL, { p2hp: 3 })
        castFull(b, 'player1', 'SPELL_COMBUSTION')
        expect(b.state.player2.hp).toBe(0)
        expect(b.state.winner).toBe('player1')
        expect(b.startCast('player2', slot(b, 'player2', 'SPELL_BLUR'))).toBe(false)
    })

    it('simultaneous deaths in the same tick are a draw', () => {
        const b = new Battle({ name: 'A', spells: FIRE, hp: 1 }, { name: 'B', spells: FIRE, hp: 1 })
        for (const key of ['player1', 'player2'] as const) {
            simpleDebuff<IgniteDebuff>(b.state, key, {
                id: 'DEBUFF_IGNITE',
                label: 'Ignite',
                source: 'SPELL_IGNITE',
                damage: 1000,
                duration: 10,
            })
        }
        b.tick()
        expect(b.state.winner).toBe('draw')
        expect(b.state.player1.hp).toBe(0)
        expect(b.state.player2.hp).toBe(0)
    })

    it('no snapshot ever contains hp < 0', () => {
        const b = setup(FIRE, FIRE, { p2hp: 20 })
        const snaps: BattleSnapshot[] = [b.snapshot()]
        const order: SpellId[] = ['SPELL_IGNITE', 'SPELL_LIVING_BOMB', 'SPELL_METEOR', 'SPELL_COMBUSTION']
        for (let round = 0; round < 3 && !b.state.winner; round++) {
            for (const id of order) {
                const i = slot(b, 'player1', id)
                if (!b.startCast('player1', i)) continue
                snaps.push(b.snapshot())
                for (let t = 0; t < b.state.player1.spells[i].castTime; t++) {
                    b.tick()
                    snaps.push(b.snapshot())
                }
                b.stopCast('player1', i)
                snaps.push(b.snapshot())
                for (let t = 0; t < 5; t++) {
                    b.tick()
                    snaps.push(b.snapshot())
                }
            }
        }
        expect(b.state.winner).toBe('player1')
        for (const s of snaps) {
            expect(s.player1.hp).toBeGreaterThanOrEqual(0)
            expect(s.player2.hp).toBeGreaterThanOrEqual(0)
        }
    })
})
