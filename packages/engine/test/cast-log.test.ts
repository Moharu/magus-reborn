import { describe, expect, it } from 'vitest'
import { conditionHolds, MAX_HP, secondsToTicks, type HasteBuff, type PlayerKey } from '../src'
import { BASE_DAMAGE, DAMAGE_PER_STACK } from '../src/spells/fire/afterburn'
import { DAMAGE as FIREBALL_DAMAGE } from '../src/spells/fire/fireball'
import { LOCK_DURATION } from '../src/spells/general/counterspell'
import { advance, castFull, effectIds, FIRE, GENERAL, releases, setup, slot } from './helpers'

const ofType = (b: ReturnType<typeof setup>, type: string) => b.state.log.filter(l => l.type === type)
const hasteBuff = (b: ReturnType<typeof setup>, player: PlayerKey) =>
    b.state[player].effects.find((e): e is HasteBuff => e.id === 'BUFF_HASTE')

describe('replacing a cast (#34)', () => {
    it('logs CANCEL_CAST for the old spell, in the instant-cancel shape, just before the new START_CAST', () => {
        const b = setup()
        const fireball = slot(b, 'player1', 'SPELL_FIREBALL')
        const meteor = slot(b, 'player1', 'SPELL_METEOR')
        b.startCast('player1', fireball)
        advance(b, 10)
        expect(b.startCast('player1', meteor)).toBe(true)

        const tick = b.state.gameTick
        expect(b.state.log).toEqual([
            { type: 'START_CAST', caster: 'player1', spellIndex: fireball, tick: tick - 10 },
            { type: 'CANCEL_CAST', caster: 'player1', spellIndex: fireball, tick },
            { type: 'START_CAST', caster: 'player1', spellIndex: meteor, tick },
        ])
    })

    it('the replaced spell deals no damage and gets no SPELL_RELEASE, even if its cast time had completed', () => {
        const b = setup()
        const fireball = slot(b, 'player1', 'SPELL_FIREBALL')
        b.startCast('player1', fireball)
        advance(b, b.state.player1.spells[fireball].castTime + 5)
        b.startCast('player1', slot(b, 'player1', 'SPELL_METEOR'))

        expect(b.stopCast('player1', fireball)).toBe(false)
        advance(b, 5)
        expect(b.state.player2.hp).toBe(MAX_HP)
        expect(releases(b, 'player1')).toEqual([])
        expect(b.state.player1.spells[fireball].lastCast).toBeNull()
    })

    it('the new cast starts normally and lands after its own full cast time', () => {
        const b = setup()
        const ignite = slot(b, 'player1', 'SPELL_IGNITE')
        const fireball = slot(b, 'player1', 'SPELL_FIREBALL')
        b.startCast('player1', ignite)
        advance(b, 10)
        expect(b.startCast('player1', fireball)).toBe(true)
        const started = b.state.gameTick
        expect(b.state.player1.cast).toBe(fireball)
        expect(b.state.player1.castStartingTick).toBe(started)

        advance(b, b.state.player1.spells[fireball].castTime)
        expect(b.stopCast('player1', fireball)).toBe(true)
        expect(releases(b, 'player1')).toEqual([
            { type: 'SPELL_RELEASE', caster: 'player1', spellIndex: fireball, tick: b.state.gameTick },
        ])
        expect(b.state.player2.hp).toBe(MAX_HP - FIREBALL_DAMAGE)
    })

    it('re-pressing the spell being cast logs a cancel and restarts its timer', () => {
        const b = setup()
        const fireball = slot(b, 'player1', 'SPELL_FIREBALL')
        b.startCast('player1', fireball)
        advance(b, 10)
        expect(b.startCast('player1', fireball)).toBe(true)
        expect(b.state.player1.castStartingTick).toBe(b.state.gameTick)
        expect(b.state.log.at(-2)).toEqual({
            type: 'CANCEL_CAST',
            caster: 'player1',
            spellIndex: fireball,
            tick: b.state.gameTick,
        })
        expect(b.state.log.at(-1)).toMatchObject({ type: 'START_CAST', spellIndex: fireball })
    })

    it('logs no cancel when no cast is being replaced', () => {
        const b = setup()
        castFull(b, 'player1', 'SPELL_FIREBALL')
        b.startCast('player1', slot(b, 'player1', 'SPELL_METEOR'))
        expect(ofType(b, 'CANCEL_CAST')).toEqual([])
    })

    it('a new cast the engine rejects keeps the current cast and logs nothing', () => {
        const b = setup()
        const fireball = slot(b, 'player1', 'SPELL_FIREBALL')
        b.startCast('player1', fireball)
        const started = b.state.gameTick
        b.state.player1.gcdUntil = started + 5
        const logged = b.state.log.length

        expect(b.startCast('player1', slot(b, 'player1', 'SPELL_METEOR'))).toBe(false)
        expect(b.state.log).toHaveLength(logged)
        expect(b.state.player1.cast).toBe(fireball)
        expect(b.state.player1.castStartingTick).toBe(started)
    })
})

describe('Counterspell interrupts (#35)', () => {
    it.each<[PlayerKey, PlayerKey]>([
        ['player1', 'player2'],
        ['player2', 'player1'],
    ])('logs the interrupted player (%s, by %s), the spell, the tick and the source', (victim, interrupter) => {
        const b = setup(GENERAL, GENERAL)
        const fireball = slot(b, victim, 'SPELL_FIREBALL')
        b.startCast(victim, fireball)
        advance(b, 5)
        expect(b.startCast(interrupter, slot(b, interrupter, 'SPELL_COUNTERSPELL'))).toBe(true)

        expect(b.state[victim].cast).toBeNull()
        expect(ofType(b, 'INTERRUPTED')).toEqual([
            {
                type: 'INTERRUPTED',
                player: victim,
                spellIndex: fireball,
                tick: b.state.gameTick,
                source: 'SPELL_COUNTERSPELL',
            },
        ])
        // the interrupted spell is resolvable from the entry, and its log order is what a view reads
        expect(b.state[victim].spells[fireball].id).toBe('SPELL_FIREBALL')
        expect(b.state.log.slice(-2).map(l => l.type)).toEqual(['SPELL_RELEASE', 'INTERRUPTED'])
        expect(b.state.log.at(-2)).toMatchObject({ caster: interrupter })
        // an interrupt is not the player's own cancel
        expect(ofType(b, 'CANCEL_CAST')).toEqual([])
    })

    it('a Counterspell used mid-cast logs the own cancel, the release, then the enemy interrupt', () => {
        const b = setup()
        b.startCast('player1', slot(b, 'player1', 'SPELL_FIREBALL'))
        b.startCast('player2', slot(b, 'player2', 'SPELL_FIREBALL'))
        advance(b, 5)
        b.startCast('player2', slot(b, 'player2', 'SPELL_COUNTERSPELL'))
        expect(b.state.log.slice(-3)).toMatchObject([
            { type: 'CANCEL_CAST', caster: 'player2' },
            { type: 'SPELL_RELEASE', caster: 'player2' },
            { type: 'INTERRUPTED', player: 'player1' },
        ])
    })

    it('logs nothing if the enemy was not casting', () => {
        const b = setup()
        const counterspell = slot(b, 'player2', 'SPELL_COUNTERSPELL')
        expect(b.startCast('player2', counterspell)).toBe(true)
        expect(releases(b, 'player2')).toHaveLength(1)
        expect(ofType(b, 'INTERRUPTED')).toEqual([])
    })

    it('logs nothing if the enemy already released or cancelled their cast this tick', () => {
        const released = setup()
        castFull(released, 'player1', 'SPELL_FIREBALL')
        released.startCast('player2', slot(released, 'player2', 'SPELL_COUNTERSPELL'))
        expect(ofType(released, 'INTERRUPTED')).toEqual([])

        const cancelled = setup(GENERAL)
        cancelled.startCast('player1', slot(cancelled, 'player1', 'SPELL_FIREBALL'))
        cancelled.startCast('player1', slot(cancelled, 'player1', 'SPELL_BLUR'))
        cancelled.startCast('player2', slot(cancelled, 'player2', 'SPELL_COUNTERSPELL'))
        expect(ofType(cancelled, 'CANCEL_CAST')).toHaveLength(1)
        expect(ofType(cancelled, 'INTERRUPTED')).toEqual([])
    })

    it('logs nothing if Counterspell is rejected (on cooldown)', () => {
        const b = setup()
        const counterspell = slot(b, 'player2', 'SPELL_COUNTERSPELL')
        b.startCast('player2', counterspell)
        advance(b, 1)
        const fireball = slot(b, 'player1', 'SPELL_FIREBALL')
        b.startCast('player1', fireball)
        expect(b.startCast('player2', counterspell)).toBe(false)
        expect(ofType(b, 'INTERRUPTED')).toEqual([])
        expect(b.state.player1.cast).toBe(fireball)
    })
})

describe('existing log readers ignore the new entries', () => {
    it('Haste: an interrupted hasted cast neither consumes the buff nor loses its place in the log', () => {
        const b = setup(GENERAL, GENERAL)
        const fireball = slot(b, 'player1', 'SPELL_FIREBALL')
        const fullCast = b.state.player1.spells[fireball].castTime
        const hasted = Math.ceil(fullCast / 2)
        castFull(b, 'player1', 'SPELL_HASTE')
        advance(b, secondsToTicks(1)) // the GCD

        b.startCast('player1', fireball)
        b.startCast('player2', slot(b, 'player2', 'SPELL_COUNTERSPELL'))
        expect(ofType(b, 'INTERRUPTED')).toHaveLength(1)
        expect(hasteBuff(b, 'player1')!.logIndex).toBeLessThan(b.state.log.length)

        advance(b, 1)
        expect(hasteBuff(b, 'player1')!.logIndex).toBe(b.state.log.length)
        expect(b.state.player1.spells[fireball].castTime).toBe(hasted)

        // the buff outlasts the lock, and the next real release consumes it on the following tick
        advance(b, secondsToTicks(LOCK_DURATION))
        expect(castFull(b, 'player1', 'SPELL_FIREBALL')).toBe(true)
        expect(effectIds(b, 'player1')).toContain('BUFF_HASTE')
        advance(b, 1)
        expect(effectIds(b, 'player1')).not.toContain('BUFF_HASTE')
        expect(b.state.player1.spells[fireball].castTime).toBe(fullCast)
    })

    it("Haste: the owner's own Counterspell interrupt, a replaced cast and a cancel leave the buff in place", () => {
        const b = setup(GENERAL, GENERAL)
        const fireball = slot(b, 'player1', 'SPELL_FIREBALL')
        const hasted = Math.ceil(b.state.player1.spells[fireball].castTime / 2)
        castFull(b, 'player1', 'SPELL_HASTE')
        advance(b, secondsToTicks(1)) // the GCD

        b.startCast('player2', slot(b, 'player2', 'SPELL_FIREBALL'))
        b.startCast('player1', slot(b, 'player1', 'SPELL_COUNTERSPELL'))
        expect(ofType(b, 'INTERRUPTED')).toMatchObject([{ player: 'player2' }])
        b.startCast('player1', fireball)
        b.startCast('player1', fireball)
        expect(ofType(b, 'CANCEL_CAST')).toMatchObject([{ caster: 'player1', spellIndex: fireball }])
        b.startCast('player1', slot(b, 'player1', 'SPELL_BLUR'))
        expect(ofType(b, 'CANCEL_CAST')).toHaveLength(2)

        advance(b, 1)
        expect(hasteBuff(b, 'player1')!.logIndex).toBe(b.state.log.length)
        expect(b.state.player1.spells[fireball].castTime).toBe(hasted)
    })

    it('Afterburn counts only released Fireballs, not replaced or interrupted ones', () => {
        const b = setup(FIRE, GENERAL)
        const fireball = slot(b, 'player1', 'SPELL_FIREBALL')
        const afterburn = slot(b, 'player1', 'SPELL_AFTERBURN')
        expect(castFull(b, 'player1', 'SPELL_FIREBALL')).toBe(true)

        b.startCast('player1', fireball)
        b.startCast('player2', slot(b, 'player2', 'SPELL_COUNTERSPELL'))
        expect(ofType(b, 'INTERRUPTED')).toMatchObject([{ player: 'player1', spellIndex: fireball }])
        advance(b, secondsToTicks(LOCK_DURATION))

        b.startCast('player1', fireball)
        b.startCast('player1', afterburn)
        expect(ofType(b, 'CANCEL_CAST')).toMatchObject([{ caster: 'player1', spellIndex: fireball }])
        const before = b.state.player2.hp
        advance(b, b.state.player1.spells[afterburn].castTime)
        expect(b.stopCast('player1', afterburn)).toBe(true)
        expect(before - b.state.player2.hp).toBeCloseTo(BASE_DAMAGE + DAMAGE_PER_STACK, 5)
    })

    it("the policy's recentReleasesAtLeast counts only released casts", () => {
        const b = setup(FIRE, GENERAL)
        const fireball = slot(b, 'player1', 'SPELL_FIREBALL')
        const condition = {
            type: 'recentReleasesAtLeast',
            spell: 'SPELL_FIREBALL',
            count: 1,
            seconds: 10,
        } as const
        const holds = () => conditionHolds(b.state, 'player1', 'player2', condition)

        b.startCast('player1', fireball)
        b.startCast('player1', fireball) // replaced
        b.startCast('player2', slot(b, 'player2', 'SPELL_COUNTERSPELL')) // interrupted
        expect(ofType(b, 'CANCEL_CAST')).toHaveLength(1)
        expect(ofType(b, 'INTERRUPTED')).toHaveLength(1)
        expect(holds()).toBe(false)

        advance(b, secondsToTicks(LOCK_DURATION))
        expect(castFull(b, 'player1', 'SPELL_FIREBALL')).toBe(true)
        expect(holds()).toBe(true)
    })
})
