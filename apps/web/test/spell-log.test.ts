import { describe, expect, it } from 'vitest'
import { Battle, type LogEntry } from '@magus/engine'
import { emptySpellLog, logRowY, mapSpellLog } from '../src/game/spell-log'

const release = (caster: 'player1' | 'player2', tick = 1): LogEntry => ({
    type: 'SPELL_RELEASE',
    caster,
    spellId: 'SPELL_HASTE',
    spellIndex: 999,
    tick,
})

describe('centre spell log', () => {
    it('keeps engine order, caps at four, and maps both seats and spectator sides without loadouts', () => {
        const entries = [
            release('player1', 0),
            release('player2'),
            release('player1', 2),
            release('player2', 3),
            release('player1', 4),
        ]
        for (const me of ['player1', 'player2', null] as const) {
            const result = mapSpellLog(emptySpellLog(), entries, me)
            expect(result.rows).toHaveLength(4)
            expect(result.added).toHaveLength(5)
            expect(result.rows.map(row => row.side)).toEqual(
                me === 'player2' ? ['left', 'right', 'left', 'right'] : ['right', 'left', 'right', 'left'],
            )
            expect(result.rows.every(row => row.text === 'Haste')).toBe(true)
            expect(result.rows[0].label).toContain(me === null ? 'PLAYER 2' : me === 'player2' ? 'YOU' : 'RIVAL')
        }
    })

    it('uses real engine outcomes for interruptions, replacements and early releases', () => {
        const spells = ['SPELL_FIREBALL', 'SPELL_COUNTERSPELL', 'SPELL_HASTE'] as const
        const battle = new Battle({ name: 'a', spells: [...spells] }, { name: 'b', spells: [...spells] })
        battle.startCast('player1', 0)
        battle.startCast('player2', 1)
        let result = mapSpellLog(emptySpellLog(), battle.state.log, 'player1')
        expect(result.added.map(row => [row.text, row.side])).toEqual([
            ['Counter Spell', 'right'],
            ['INTERRUPTED Fireball', 'right'],
        ])
        for (let i = 0; i < 80; i++) battle.tick()
        let seen = battle.state.log.length
        battle.startCast('player1', 0)
        battle.startCast('player1', 2)
        result = mapSpellLog(result, battle.state.log.slice(seen), 'player1')
        expect(result.added.map(row => row.text)).toEqual(['CANCELLED Fireball', 'Haste'])
        seen = battle.state.log.length
        battle.startCast('player1', 0)
        battle.stopCast('player1', 0)
        expect(mapSpellLog(result, battle.state.log.slice(seen), 'player1').added[0].text).toBe('CANCELLED Fireball')
    })

    it('does not announce a successful stop as cancellation, or repeat DoT ticks', () => {
        const battle = new Battle(
            { name: 'a', spells: ['SPELL_FIREBALL', 'SPELL_IGNITE'] },
            { name: 'b', spells: ['SPELL_HASTE'] },
        )
        battle.startCast('player1', 0)
        let result = mapSpellLog(emptySpellLog(), battle.state.log, 'player1')
        for (let i = 0; i < 100; i++) battle.tick()
        let seen = battle.state.log.length
        battle.stopCast('player1', 0)
        result = mapSpellLog(result, battle.state.log.slice(seen), 'player1')
        expect(result.added.map(row => row.text)).toEqual(['Fireball'])
        seen = battle.state.log.length
        battle.startCast('player1', 1)
        for (let i = 0; i < 100; i++) battle.tick()
        battle.stopCast('player1', 1)
        for (let i = 0; i < 200; i++) battle.tick()
        expect(mapSpellLog(result, battle.state.log.slice(seen), 'player1').added.map(row => row.text)).toEqual([
            'Ignite',
        ])
    })

    it('moves older rows upwards and snaps immediately with reduced motion', () => {
        expect(logRowY(0, -90, 0.075, false)).toBe(-45)
        expect(logRowY(0, -90, 0, true)).toBe(-90)
    })
})
