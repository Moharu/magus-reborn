import { describe, expect, it } from 'vitest'
import type { Battle, HpEvent, MagicEaterBuff, SpellId } from '../src'
import { fromCenti, simpleBuff, tickShare, toCenti } from '../src/utils'
import { DAMAGE as COMBUSTION_DAMAGE } from '../src/spells/fire/combustion'
import { DEBUFF_TOTAL_DAMAGE as IGNITE_TOTAL } from '../src/spells/fire/ignite'
import { DEBUFF_FINAL_DAMAGE as BOMB_FINAL, DEBUFF_TOTAL_DAMAGE as BOMB_TOTAL } from '../src/spells/fire/living-bomb'
import { advance, castFull, effectIds, setup } from './helpers'

/** Damage dealt to player2 by `source`, summed in centi-HP so the sum itself cannot drift. */
const dealtBy = (events: HpEvent[], source: SpellId, kind?: HpEvent['kind']) =>
    fromCenti(
        events
            .filter(e => e.player === 'player2' && e.source === source && (!kind || e.kind === kind))
            .reduce((sum, e) => sum - toCenti(e.amount), 0),
    )

const onGrid = (hp: number) => fromCenti(toCenti(hp)) === hp

const record = (b: Battle) => {
    const events: HpEvent[] = []
    return {
        events,
        run: (fn: () => void) => {
            fn()
            events.push(...b.drainEvents())
        },
    }
}

describe('exact damage-over-time totals', () => {
    it('tickShare spreads any total over any tick count to exactly that total', () => {
        for (const [total, n] of [
            [13.3, 200],
            [7, 220],
            [0.01, 7],
            [99.99, 3],
        ]) {
            let centi = 0
            for (let k = 1; k <= n; k++) centi += toCenti(tickShare(total, n, k))
            expect(fromCenti(centi)).toBe(total)
        }
    })

    it('a full Ignite deals exactly 13.3', () => {
        const b = setup()
        const r = record(b)
        r.run(() => castFull(b, 'player1', 'SPELL_IGNITE'))
        for (let i = 0; i < 200; i++) {
            r.run(() => advance(b, 1))
            expect(onGrid(b.state.player2.hp)).toBe(true)
        }
        expect(effectIds(b, 'player2')).toEqual([])
        expect(b.state.player2.hp).toBe(86.7)
        expect(dealtBy(r.events, 'SPELL_IGNITE')).toBe(IGNITE_TOTAL)
    })

    it('a full Living Bomb deals exactly 7 over time plus 21 on expiry', () => {
        const b = setup()
        const r = record(b)
        r.run(() => castFull(b, 'player1', 'SPELL_LIVING_BOMB'))
        r.run(() => advance(b, 219))
        expect(dealtBy(r.events, 'SPELL_LIVING_BOMB')).toBe(6.97)
        r.run(() => advance(b, 1))
        expect(effectIds(b, 'player2')).toEqual([])
        expect(dealtBy(r.events, 'SPELL_LIVING_BOMB')).toBe(BOMB_TOTAL + BOMB_FINAL)
        expect(b.state.player2.hp).toBe(72)
    })

    it('Combustion on a partial Ignite plus the ticks already dealt equals the full Ignite plus DAMAGE', () => {
        for (const wait of [0, 1, 7, 33, 151]) {
            const b = setup()
            const r = record(b)
            r.run(() => castFull(b, 'player1', 'SPELL_IGNITE'))
            r.run(() => advance(b, wait))
            r.run(() => castFull(b, 'player1', 'SPELL_COMBUSTION'))
            const ticks = dealtBy(r.events, 'SPELL_IGNITE')
            const combustion = dealtBy(r.events, 'SPELL_COMBUSTION')
            expect(ticks).toBeGreaterThan(0)
            expect(fromCenti(toCenti(ticks) + toCenti(combustion))).toBe(IGNITE_TOTAL + COMBUSTION_DAMAGE)
            expect(b.state.player2.hp).toBe(fromCenti(10000 - toCenti(IGNITE_TOTAL + COMBUSTION_DAMAGE)))
        }
    })

    it('Combustion counts each of several staggered Ignites exactly', () => {
        const b = setup()
        castFull(b, 'player1', 'SPELL_IGNITE')
        advance(b, 13)
        castFull(b, 'player1', 'SPELL_IGNITE')
        castFull(b, 'player1', 'SPELL_COMBUSTION')
        expect(effectIds(b, 'player2')).toEqual(['DEBUFF_IGNITE', 'DEBUFF_IGNITE'])
        expect(b.state.player2.hp).toBe(fromCenti(10000 - toCenti(2 * IGNITE_TOTAL + COMBUSTION_DAMAGE)))
    })

    it('Magic Eater heals exactly 40% of a full Ignite despite sub-centi per-tick heals', () => {
        const b = setup()
        b.state.player1.hp = 50
        simpleBuff<MagicEaterBuff>(b.state, 'player1', {
            id: 'BUFF_MAGIC_EATER',
            label: 'Magic Eater',
            source: 'SPELL_MAGIC_EATER',
            healingPercentage: 40,
            duration: 1000,
            pendingDamage: 0,
            healCarry: 0,
        })
        castFull(b, 'player1', 'SPELL_IGNITE')
        advance(b, 200)
        expect(b.state.player2.hp).toBe(86.7)
        // 40% of 13.3 = 5.32, every tick's 0.0665 dealt yielding a 0.0266 heal
        expect(b.state.player1.hp).toBe(55.32)
    })

    it('Temporal Shield still rewinds exactly to the cast-time HP after Ignite ticks', () => {
        const b = setup(['SPELL_IGNITE'], ['SPELL_TEMPORAL_SHIELD'])
        castFull(b, 'player1', 'SPELL_IGNITE')
        advance(b, 3)
        const backup = b.state.player2.hp
        castFull(b, 'player2', 'SPELL_TEMPORAL_SHIELD')
        advance(b, 24)
        expect(b.state.player2.hp).toBe(backup)
    })
})
