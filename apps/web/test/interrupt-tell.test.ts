import { describe, expect, it } from 'vitest'
import { Battle, type LogEntry, type PlayerKey, type SpellId } from '@magus/engine'
import { interruptTells, type InterruptTell } from '../src/game/interrupt-tell'
import { sidesFor } from '../src/game/layout'

// a different order per seat, so reading the spell index from the wrong player names the wrong spell
const LOADOUTS: Record<PlayerKey, SpellId[]> = {
    player1: ['SPELL_FIREBALL', 'SPELL_METEOR', 'SPELL_COUNTERSPELL', 'SPELL_BLUR', 'SPELL_HASTE', 'SPELL_LIVING_BOMB'],
    player2: ['SPELL_COUNTERSPELL', 'SPELL_BLUR', 'SPELL_METEOR', 'SPELL_FIREBALL', 'SPELL_LIVING_BOMB', 'SPELL_HASTE'],
}
const SEATS = sidesFor('player1')

const setup = () => {
    const battle = new Battle({ name: 'Alice', spells: LOADOUTS.player1 }, { name: 'Bob', spells: LOADOUTS.player2 })
    advance(battle, 10)
    return battle
}

const advance = (battle: Battle, ticks: number) => {
    for (let i = 0; i < ticks; i++) battle.tick()
}

const press = (battle: Battle, player: PlayerKey, id: SpellId) => battle.startCast(player, LOADOUTS[player].indexOf(id))
const release = (battle: Battle, player: PlayerKey, id: SpellId) =>
    battle.stopCast(player, LOADOUTS[player].indexOf(id))
const castTicks = (battle: Battle, player: PlayerKey, id: SpellId) =>
    battle.state[player].spells[LOADOUTS[player].indexOf(id)].castTime

const start = (battle: Battle, player: PlayerKey, id: SpellId) => expect(press(battle, player, id)).toBe(true)

const tellsOf = (battle: Battle, sides = SEATS) => interruptTells(battle.state.log, sides)

/** Player 1 is interrupted, on the left: what a view seated as player 1 gets for player 2's Counterspell. */
const interrupted = (spell: SpellId): InterruptTell => ({
    interruptedSide: 'left',
    casterSide: 'right',
    spell,
    source: 'SPELL_COUNTERSPELL',
})

describe('interruptTells (#39)', () => {
    describe('a Counterspell that interrupts', () => {
        it('tells who was interrupted, by whom, and which spell', () => {
            const battle = setup()
            start(battle, 'player1', 'SPELL_FIREBALL')
            start(battle, 'player2', 'SPELL_COUNTERSPELL')
            expect(tellsOf(battle)).toEqual([interrupted('SPELL_FIREBALL')])
        })

        it('works the same in the other direction', () => {
            const battle = setup()
            start(battle, 'player2', 'SPELL_METEOR')
            start(battle, 'player1', 'SPELL_COUNTERSPELL')
            expect(tellsOf(battle)).toEqual([
                {
                    interruptedSide: 'right',
                    casterSide: 'left',
                    spell: 'SPELL_METEOR',
                    source: 'SPELL_COUNTERSPELL',
                },
            ])
        })

        it('counts a fully charged cast that was still held', () => {
            const battle = setup()
            start(battle, 'player1', 'SPELL_FIREBALL')
            advance(battle, castTicks(battle, 'player1', 'SPELL_FIREBALL'))
            start(battle, 'player2', 'SPELL_COUNTERSPELL')
            expect(tellsOf(battle)).toEqual([interrupted('SPELL_FIREBALL')])
        })

        it('names the replacing spell after a cast was replaced', () => {
            const battle = setup()
            start(battle, 'player1', 'SPELL_FIREBALL')
            advance(battle, 2)
            start(battle, 'player1', 'SPELL_METEOR')
            start(battle, 'player2', 'SPELL_COUNTERSPELL')
            expect(tellsOf(battle)).toEqual([interrupted('SPELL_METEOR')])
        })

        it("gives one tell when the counterspeller's own cast is cancelled by it", () => {
            const battle = setup()
            start(battle, 'player1', 'SPELL_METEOR')
            start(battle, 'player2', 'SPELL_FIREBALL')
            start(battle, 'player2', 'SPELL_COUNTERSPELL')
            expect(battle.state.log.some(entry => entry.type === 'CANCEL_CAST' && entry.caster === 'player2')).toBe(
                true,
            )
            expect(tellsOf(battle)).toEqual([interrupted('SPELL_METEOR')])
        })
    })

    describe('no tell', () => {
        it('for a Counterspell that lands on nothing', () => {
            const battle = setup()
            start(battle, 'player2', 'SPELL_COUNTERSPELL')
            // the Counterspell really was released, so the existing projectile and ring still play
            expect(battle.state.log.some(entry => entry.type === 'SPELL_RELEASE' && entry.caster === 'player2')).toBe(
                true,
            )
            expect(tellsOf(battle)).toEqual([])
        })

        it('for a Counterspell right after the enemy released their spell', () => {
            const battle = setup()
            start(battle, 'player1', 'SPELL_FIREBALL')
            advance(battle, castTicks(battle, 'player1', 'SPELL_FIREBALL'))
            expect(release(battle, 'player1', 'SPELL_FIREBALL')).toBe(true)
            start(battle, 'player2', 'SPELL_COUNTERSPELL')
            expect(tellsOf(battle)).toEqual([])
        })

        it('for a Counterspell right after the enemy let go of their cast early', () => {
            const battle = setup()
            start(battle, 'player1', 'SPELL_FIREBALL')
            advance(battle, 1)
            expect(release(battle, 'player1', 'SPELL_FIREBALL')).toBe(false)
            expect(battle.state.player1.cast).toBeNull()
            start(battle, 'player2', 'SPELL_COUNTERSPELL')
            expect(tellsOf(battle)).toEqual([])
        })

        it('for a cast the player cancelled with an instant', () => {
            const battle = setup()
            start(battle, 'player1', 'SPELL_FIREBALL')
            start(battle, 'player1', 'SPELL_BLUR')
            expect(battle.state.player1.cast).toBeNull()
            expect(tellsOf(battle)).toEqual([])
        })

        it('for a cast that was replaced', () => {
            const battle = setup()
            start(battle, 'player1', 'SPELL_FIREBALL')
            start(battle, 'player1', 'SPELL_METEOR')
            expect(tellsOf(battle)).toEqual([])
        })

        it('for a Counterspell the engine rejects as on cooldown', () => {
            const battle = setup()
            start(battle, 'player1', 'SPELL_FIREBALL')
            start(battle, 'player2', 'SPELL_COUNTERSPELL')
            advance(battle, battle.state.player1.lockedUntil - battle.state.gameTick)
            const seen = battle.state.log.length

            start(battle, 'player1', 'SPELL_FIREBALL')
            expect(press(battle, 'player2', 'SPELL_COUNTERSPELL')).toBe(false)
            expect(battle.state.player1.cast).toBe(LOADOUTS.player1.indexOf('SPELL_FIREBALL'))
            expect(interruptTells(battle.state.log.slice(seen), SEATS)).toEqual([])
        })
    })

    it('gives each interrupt once when the log is read in slices, as both clients do', () => {
        const battle = setup()
        let seen = 0
        const tells: InterruptTell[] = []
        const flush = () => {
            const newLog = battle.state.log.slice(seen)
            seen = battle.state.log.length
            tells.push(...interruptTells(newLog, SEATS))
        }

        start(battle, 'player1', 'SPELL_FIREBALL')
        flush()
        start(battle, 'player2', 'SPELL_COUNTERSPELL')
        expect(tells).toEqual([])
        flush()
        expect(tells).toEqual([interrupted('SPELL_FIREBALL')])
        for (let i = 0; i < 40; i++) {
            battle.tick()
            flush()
        }
        expect(tells).toEqual([interrupted('SPELL_FIREBALL')])
    })

    it('resolves the spell from the entries a client gets over the wire', () => {
        const battle = setup()
        start(battle, 'player1', 'SPELL_METEOR')
        start(battle, 'player2', 'SPELL_COUNTERSPELL')
        battle.tick()
        const log = JSON.parse(JSON.stringify(battle.state.log)) as LogEntry[]
        expect(interruptTells(log, SEATS)).toEqual([interrupted('SPELL_METEOR')])
    })

    it.each<[PlayerKey | null, InterruptTell['interruptedSide'], InterruptTell['casterSide']]>([
        ['player1', 'left', 'right'],
        ['player2', 'right', 'left'],
        [null, 'left', 'right'],
    ])('puts the interrupted player 1 on the correct side for viewer %s', (me, interruptedSide, casterSide) => {
        const battle = setup()
        start(battle, 'player1', 'SPELL_FIREBALL')
        start(battle, 'player2', 'SPELL_COUNTERSPELL')
        expect(tellsOf(battle, sidesFor(me))).toEqual([
            { interruptedSide, casterSide, spell: 'SPELL_FIREBALL', source: 'SPELL_COUNTERSPELL' },
        ])
    })
})
