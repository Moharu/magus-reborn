import { afterEach, describe, expect, it } from 'vitest'
import {
    Battle,
    createSpellState,
    ELEMENTS,
    FROST_NUMBERS,
    GLOBAL_COOLDOWN,
    secondsToTicks,
    SPELLBOOKS,
    SPELLS,
    toCenti,
    type PlayerKey,
    type SpellId,
} from '../src'
import { advance, castFull, effectIds, GENERAL, putOnGcd, releases, restoreOffGcd, setup, slot } from './helpers'

const N = FROST_NUMBERS
const FROST: SpellId[] = [
    'SPELL_FROSTBOLT',
    'SPELL_GLACIER',
    'SPELL_FROST_BOMB',
    'SPELL_ICE_SPEAR',
    'SPELL_ICY_TOUCH',
    'SPELL_FROST_FEVER',
]
/** Every Frost spell plus every general spell; a test kit, the battle doesn't validate loadouts. */
const FROST_KIT: SpellId[] = [
    ...FROST,
    'SPELL_COUNTERSPELL',
    'SPELL_HASTE',
    'SPELL_TEMPORAL_SHIELD',
    'SPELL_MAGIC_EATER',
    'SPELL_BLUR',
]

/** Frost Bomb's pulse interval in ticks. */
const PULSE = secondsToTicks(N.frostBomb.pulseSeconds)

const frostVsGeneral = (opts: { p2hp?: number } = {}) => setup(FROST_KIT, GENERAL, opts)
const chilling = (b: Battle, key: PlayerKey = 'player1') => b.state[key].chilling
const cancels = (b: Battle) => b.state.log.filter(l => l.type === 'CANCEL_CAST')
/** Damage `source` dealt to `victim` in the events drained now, in centi-HP. */
const dealt = (b: Battle, source: SpellId, victim: PlayerKey = 'player2') =>
    b
        .drainEvents()
        .filter(e => e.source === source && e.player === victim)
        .reduce((sum, e) => sum - toCenti(e.amount), 0)
/** Starts `id` and holds it `ticks` ticks, then stops: released only if that covers the cast time. */
const startAndHold = (b: Battle, key: PlayerKey, id: SpellId, ticks: number) => {
    const index = slot(b, key, id)
    expect(b.startCast(key, index)).toBe(true)
    advance(b, ticks)
    return index
}
const counterspellPlayer1 = (b: Battle) => {
    expect(b.startCast('player2', slot(b, 'player2', 'SPELL_COUNTERSPELL'))).toBe(true)
    expect(effectIds(b, 'player1')).toContain('DEBUFF_COUNTERSPELL')
}

afterEach(restoreOffGcd)

describe('the Frost spellbook', () => {
    it('is an element with exactly the six Frost spells', () => {
        expect(ELEMENTS).toEqual(['FIRE', 'FROST'])
        expect([...SPELLBOOKS.FROST.elementSpells].sort()).toEqual([...FROST].sort())
        expect(SPELLBOOKS.FROST.generalSpells).toEqual(SPELLBOOKS.FIRE.generalSpells)
        for (const id of FROST) expect(SPELLS[id].school).toBe('FROST')
    })

    it('Icy Touch is an instant; every other Frost spell has a cast time', () => {
        for (const id of FROST) {
            const instant = id === 'SPELL_ICY_TOUCH'
            expect(createSpellState(id).castTime === 0).toBe(instant)
        }
    })
})

describe('Chilling stacks', () => {
    it('start at 0 in every battle, so they reset each round', () => {
        const round1 = frostVsGeneral()
        castFull(round1, 'player1', 'SPELL_GLACIER')
        expect(chilling(round1)).toBe(3)
        const round2 = frostVsGeneral()
        expect(chilling(round2)).toBe(0)
        expect(chilling(round2, 'player2')).toBe(0)
    })

    it('are gained when Frostbolt completes, not when it starts', () => {
        const b = frostVsGeneral()
        const index = slot(b, 'player1', 'SPELL_FROSTBOLT')
        b.startCast('player1', index)
        expect(chilling(b)).toBe(0)
        advance(b, b.state.player1.spells[index].castTime)
        expect(chilling(b)).toBe(0)
        expect(b.stopCast('player1', index)).toBe(true)
        expect(chilling(b)).toBe(N.frostbolt.chillingGain)
        expect(chilling(b)).toBe(1)
    })

    it('a cast released early grants nothing', () => {
        const b = frostVsGeneral()
        const index = slot(b, 'player1', 'SPELL_FROSTBOLT')
        b.startCast('player1', index)
        advance(b, b.state.player1.spells[index].castTime - 1)
        expect(b.stopCast('player1', index)).toBe(false)
        expect(chilling(b)).toBe(0)
    })

    it('a countered cast grants nothing', () => {
        for (const id of ['SPELL_FROSTBOLT', 'SPELL_GLACIER'] as SpellId[]) {
            const b = frostVsGeneral()
            const index = startAndHold(b, 'player1', id, 5)
            counterspellPlayer1(b)
            advance(b, b.state.player1.spells[index].castTime)
            expect(b.stopCast('player1', index)).toBe(false)
            expect(chilling(b)).toBe(0)
        }
    })

    it('a cast cancelled by a new cast grants nothing', () => {
        const b = frostVsGeneral()
        startAndHold(b, 'player1', 'SPELL_GLACIER', 5)
        b.startCast('player1', slot(b, 'player1', 'SPELL_FROSTBOLT'))
        expect(chilling(b)).toBe(0)
    })

    it('Glacier grants 3', () => {
        const b = frostVsGeneral()
        castFull(b, 'player1', 'SPELL_GLACIER')
        expect(chilling(b)).toBe(N.glacier.chillingGain)
        expect(chilling(b)).toBe(3)
    })

    it('cap at 5: stacks gained above it are lost', () => {
        expect(N.chillingMaxStacks).toBe(5)
        const b = frostVsGeneral()
        castFull(b, 'player1', 'SPELL_GLACIER')
        castFull(b, 'player1', 'SPELL_GLACIER')
        expect(chilling(b)).toBe(5)
        castFull(b, 'player1', 'SPELL_FROSTBOLT')
        expect(chilling(b)).toBe(5)
        // the lost stacks don't come back after spending
        castFull(b, 'player1', 'SPELL_ICY_TOUCH')
        expect(chilling(b)).toBe(4)
    })

    it('are per player', () => {
        const b = setup(FROST_KIT, FROST_KIT)
        castFull(b, 'player1', 'SPELL_GLACIER')
        expect(chilling(b, 'player1')).toBe(3)
        expect(chilling(b, 'player2')).toBe(0)
    })
})

describe('Frostbolt and Glacier', () => {
    it('deal their damage on release', () => {
        const b = frostVsGeneral()
        castFull(b, 'player1', 'SPELL_FROSTBOLT')
        expect(dealt(b, 'SPELL_FROSTBOLT')).toBe(toCenti(N.frostbolt.damage))
        castFull(b, 'player1', 'SPELL_GLACIER')
        expect(dealt(b, 'SPELL_GLACIER')).toBe(toCenti(N.glacier.damage))
        expect(createSpellState('SPELL_GLACIER').castTime).toBe(secondsToTicks(N.glacier.castSeconds))
        expect(N.glacier.castSeconds).toBeGreaterThan(N.frostbolt.castSeconds)
    })
})

describe('Ice Spear', () => {
    it('is castable at 0 stacks for its base damage', () => {
        const b = frostVsGeneral()
        expect(castFull(b, 'player1', 'SPELL_ICE_SPEAR')).toBe(true)
        expect(dealt(b, 'SPELL_ICE_SPEAR')).toBe(toCenti(N.iceSpear.baseDamage))
        expect(chilling(b)).toBe(0)
    })

    it.each([1, 3, 5])('spends all %i stacks for more damage per stack', stacks => {
        const b = frostVsGeneral()
        b.state.player1.chilling = stacks
        b.drainEvents()
        castFull(b, 'player1', 'SPELL_ICE_SPEAR')
        expect(dealt(b, 'SPELL_ICE_SPEAR')).toBe(
            toCenti(N.iceSpear.baseDamage) + stacks * toCenti(N.iceSpear.damagePerStack),
        )
        expect(chilling(b)).toBe(0)
    })

    it('a countered Ice Spear keeps the stacks', () => {
        const b = frostVsGeneral()
        castFull(b, 'player1', 'SPELL_GLACIER')
        startAndHold(b, 'player1', 'SPELL_ICE_SPEAR', 5)
        counterspellPlayer1(b)
        expect(chilling(b)).toBe(3)
    })
})

describe('Icy Touch', () => {
    it('is rejected without a stack: no release, no GCD, no cooldown', () => {
        const b = frostVsGeneral()
        const index = slot(b, 'player1', 'SPELL_ICY_TOUCH')
        expect(b.startCast('player1', index)).toBe(false)
        expect(releases(b, 'player1')).toHaveLength(0)
        expect(b.state.player1.gcdUntil).toBe(0)
        expect(b.state.player1.spells[index].lastCast).toBeNull()
        expect(b.state.player2.hp).toBe(100)
    })

    it('rejected without a stack, it does not cancel the current cast (invariant 2)', () => {
        const b = frostVsGeneral()
        const frostbolt = startAndHold(b, 'player1', 'SPELL_FROSTBOLT', 5)
        expect(b.startCast('player1', slot(b, 'player1', 'SPELL_ICY_TOUCH'))).toBe(false)
        expect(b.state.player1.cast).toBe(frostbolt)
        expect(cancels(b)).toHaveLength(0)
        advance(b, b.state.player1.spells[frostbolt].castTime)
        expect(b.stopCast('player1', frostbolt)).toBe(true)
    })

    it('spends one stack and deals its damage', () => {
        const b = frostVsGeneral()
        castFull(b, 'player1', 'SPELL_GLACIER')
        b.drainEvents()
        expect(castFull(b, 'player1', 'SPELL_ICY_TOUCH')).toBe(true)
        expect(chilling(b)).toBe(3 - N.icyTouch.chillingCost)
        expect(chilling(b)).toBe(2)
        expect(dealt(b, 'SPELL_ICY_TOUCH')).toBe(toCenti(N.icyTouch.damage))
    })

    it('with a stack, it cancels the current cast, which grants nothing (invariant 2)', () => {
        const b = frostVsGeneral()
        castFull(b, 'player1', 'SPELL_FROSTBOLT')
        const glacier = startAndHold(b, 'player1', 'SPELL_GLACIER', 10)
        expect(b.startCast('player1', slot(b, 'player1', 'SPELL_ICY_TOUCH'))).toBe(true)
        expect(b.state.player1.cast).toBeNull()
        expect(cancels(b)).toEqual([
            {
                type: 'CANCEL_CAST',
                caster: 'player1',
                spellIndex: glacier,
                spellId: 'SPELL_GLACIER',
                tick: b.state.gameTick,
            },
        ])
        expect(chilling(b)).toBe(0)
    })
})

describe('Icy Touch is the shipped on-GCD instant', () => {
    it('is on the GCD, not off it, and starts the 1 s GCD', () => {
        expect(SPELLS.SPELL_ICY_TOUCH.offGlobalCooldown).toBeFalsy()
        expect(createSpellState('SPELL_ICY_TOUCH').globalCooldown).toBe(GLOBAL_COOLDOWN)
        const b = frostVsGeneral()
        b.state.player1.chilling = 2
        castFull(b, 'player1', 'SPELL_ICY_TOUCH')
        expect(b.state.player1.gcdUntil).toBe(b.state.gameTick + GLOBAL_COOLDOWN)
    })

    it('a second Icy Touch is rejected for 19 ticks and accepted on tick 20', () => {
        const b = frostVsGeneral()
        b.state.player1.chilling = 2
        const index = slot(b, 'player1', 'SPELL_ICY_TOUCH')
        expect(b.startCast('player1', index)).toBe(true)
        for (let t = 1; t < GLOBAL_COOLDOWN; t++) {
            advance(b, 1)
            expect(b.startCast('player1', index)).toBe(false)
        }
        expect(chilling(b)).toBe(1)
        advance(b, 1)
        expect(b.startCast('player1', index)).toBe(true)
        expect(chilling(b)).toBe(0)
    })

    it('blocks cast-time spells for the GCD', () => {
        const b = frostVsGeneral()
        b.state.player1.chilling = 1
        castFull(b, 'player1', 'SPELL_ICY_TOUCH')
        const frostbolt = slot(b, 'player1', 'SPELL_FROSTBOLT')
        for (let t = 0; t < GLOBAL_COOLDOWN; t++) {
            expect(b.startCast('player1', frostbolt)).toBe(false)
            advance(b, 1)
        }
        expect(b.startCast('player1', frostbolt)).toBe(true)
    })

    it.each<SpellId>(['SPELL_HASTE', 'SPELL_COUNTERSPELL', 'SPELL_TEMPORAL_SHIELD', 'SPELL_MAGIC_EATER', 'SPELL_BLUR'])(
        '%s stays off-GCD: usable during the Icy Touch GCD, which it leaves alone',
        id => {
            expect(SPELLS[id].offGlobalCooldown).toBe(true)
            const b = frostVsGeneral()
            b.state.player1.chilling = 1
            castFull(b, 'player1', 'SPELL_ICY_TOUCH')
            advance(b, 1)
            const gcdEnd = b.state.player1.gcdUntil
            expect(b.startCast('player1', slot(b, 'player1', id))).toBe(true)
            expect(b.state.player1.gcdUntil).toBe(gcdEnd)
        },
    )

    it('an Icy Touch rejected by the GCD does not cancel the cast (invariant 2)', () => {
        // a cast running under a GCD needs a GCD started mid-cast: a usable-while-casting on-GCD fixture
        putOnGcd('SPELL_TEMPORAL_SHIELD')
        SPELLS.SPELL_TEMPORAL_SHIELD.usableWhileCasting = true
        try {
            const b = frostVsGeneral()
            b.state.player1.chilling = 2
            const frostbolt = startAndHold(b, 'player1', 'SPELL_FROSTBOLT', 2)
            expect(b.startCast('player1', slot(b, 'player1', 'SPELL_TEMPORAL_SHIELD'))).toBe(true)
            expect(b.state.player1.cast).toBe(frostbolt)
            advance(b, 1)
            expect(b.startCast('player1', slot(b, 'player1', 'SPELL_ICY_TOUCH'))).toBe(false)
            expect(b.state.player1.cast).toBe(frostbolt)
            expect(cancels(b)).toHaveLength(0)
            expect(chilling(b)).toBe(2)
            advance(b, b.state.player1.spells[frostbolt].castTime)
            expect(b.stopCast('player1', frostbolt)).toBe(true)
        } finally {
            delete SPELLS.SPELL_TEMPORAL_SHIELD.usableWhileCasting
        }
    })

    it('is blocked by the Counterspell lockout for 3 s even with stacks (invariant 3)', () => {
        const b = frostVsGeneral()
        b.state.player1.chilling = 2
        startAndHold(b, 'player1', 'SPELL_FROSTBOLT', 5)
        counterspellPlayer1(b)
        const icyTouch = slot(b, 'player1', 'SPELL_ICY_TOUCH')
        const lock = secondsToTicks(3)
        for (let t = 0; t < lock; t++) {
            expect(b.startCast('player1', icyTouch)).toBe(false)
            advance(b, 1)
        }
        expect(chilling(b)).toBe(2)
        expect(b.startCast('player1', icyTouch)).toBe(true)
    })
})

describe('Frost Fever', () => {
    const feverTicks = secondsToTicks(N.frostFever.durationSeconds)

    it('deals its exact damage over its duration, then expires', () => {
        const b = frostVsGeneral()
        castFull(b, 'player1', 'SPELL_FROST_FEVER')
        b.drainEvents()
        advance(b, feverTicks - 1)
        expect(effectIds(b, 'player2')).toEqual(['DEBUFF_FROST_FEVER'])
        advance(b, 1)
        expect(dealt(b, 'SPELL_FROST_FEVER')).toBe(toCenti(N.frostFever.damage))
        expect(effectIds(b, 'player2')).toEqual([])
        expect(b.state.player2.hp).toBe(100 - N.frostFever.damage)
    })

    it('a Frost Fever tick that kills decides the winner inside tick(); the deciding tick still counts both actions', () => {
        // player2 has 0.1 HP, so the second 0.05 Fever tick kills them; player1 has 3 HP, exactly Icy Touch's base damage
        const b = new Battle({ name: 'A', spells: FROST_KIT, hp: 3 }, { name: 'B', spells: FROST_KIT, hp: 0.1 })
        advance(b, 10)
        castFull(b, 'player1', 'SPELL_FROST_FEVER')
        for (let i = 0; i < 5 && b.state.winner === null; i++) b.tick()
        expect(b.state.player2.hp).toBe(0)
        expect(b.state.winner).toBe('player1')
        expect(b.finished).toBe(false)

        // the dead player's last action in the deciding tick still lands, and trading lethal damage is a draw
        b.state.player2.chilling = 1
        expect(b.startCast('player2', slot(b, 'player2', 'SPELL_ICY_TOUCH'))).toBe(true)
        expect(b.state.player1.hp).toBe(0)
        expect(b.state.winner).toBe('draw')

        // the next tick makes it final, and nothing resolves after the deciding tick: the clock stays, no effect runs
        const decidingTick = b.state.gameTick
        const logged = b.state.log.length
        const effects = JSON.stringify(b.state.player2.effects)
        advance(b, 3)
        expect(b.finished).toBe(true)
        expect(b.state.gameTick).toBe(decidingTick)
        expect(b.state.log).toHaveLength(logged)
        expect(JSON.stringify(b.state.player2.effects)).toBe(effects)
        expect(b.state.player2.hp).toBe(0)
        expect(b.state.winner).toBe('draw')
    })

    it('a recast refreshes the duration and does not stack', () => {
        const b = frostVsGeneral()
        castFull(b, 'player1', 'SPELL_FROST_FEVER')
        advance(b, 50)
        castFull(b, 'player1', 'SPELL_FROST_FEVER')
        const recast = b.state.gameTick
        expect(effectIds(b, 'player2')).toEqual(['DEBUFF_FROST_FEVER'])
        expect(b.state.player2.effects[0].startingTick).toBe(recast)
        // the first one is still up past its original end, as one debuff
        advance(b, feverTicks - 1)
        expect(effectIds(b, 'player2')).toEqual(['DEBUFF_FROST_FEVER'])
        advance(b, 1)
        expect(effectIds(b, 'player2')).toEqual([])
    })

    it('amplifies no damage: every other Frost hit deals the same with Frost Fever on the target', () => {
        const hits: [SpellId, number][] = [
            ['SPELL_FROSTBOLT', N.frostbolt.damage],
            ['SPELL_GLACIER', N.glacier.damage],
            ['SPELL_ICE_SPEAR', N.iceSpear.baseDamage],
        ]
        for (const [id, damage] of hits) {
            const b = frostVsGeneral()
            castFull(b, 'player1', 'SPELL_FROST_FEVER')
            castFull(b, 'player1', id)
            expect(effectIds(b, 'player2')).toContain('DEBUFF_FROST_FEVER')
            expect(dealt(b, id)).toBe(toCenti(damage))
        }
        const b = frostVsGeneral()
        castFull(b, 'player1', 'SPELL_FROST_FEVER')
        castFull(b, 'player1', 'SPELL_FROST_BOMB')
        b.drainEvents()
        advance(b, secondsToTicks(N.frostBomb.pulseSeconds))
        expect(dealt(b, 'SPELL_FROST_BOMB')).toBe(toCenti(N.frostBomb.pulseDamage))
    })

    it('Icy Touch deals its bonus to a target with Frost Fever, and only then', () => {
        expect(N.frostFeverBonus).toEqual({ SPELL_ICY_TOUCH: N.frostFeverBonus.SPELL_ICY_TOUCH })
        const bonus = N.frostFeverBonus.SPELL_ICY_TOUCH!
        expect(bonus).toBeGreaterThan(0)
        const b = frostVsGeneral()
        b.state.player1.chilling = 2
        castFull(b, 'player1', 'SPELL_ICY_TOUCH')
        expect(dealt(b, 'SPELL_ICY_TOUCH')).toBe(toCenti(N.icyTouch.damage))
        advance(b, GLOBAL_COOLDOWN)
        castFull(b, 'player1', 'SPELL_FROST_FEVER')
        castFull(b, 'player1', 'SPELL_ICY_TOUCH')
        expect(dealt(b, 'SPELL_ICY_TOUCH')).toBe(toCenti(N.icyTouch.damage + bonus))
    })

    it('the bonus is data-driven per spell: a table entry gives another spell one, no engine change', () => {
        const table = N.frostFeverBonus
        try {
            table.SPELL_FROSTBOLT = 1.25
            const b = frostVsGeneral()
            castFull(b, 'player1', 'SPELL_FROSTBOLT')
            expect(dealt(b, 'SPELL_FROSTBOLT')).toBe(toCenti(N.frostbolt.damage))
            castFull(b, 'player1', 'SPELL_FROST_FEVER')
            castFull(b, 'player1', 'SPELL_FROSTBOLT')
            expect(dealt(b, 'SPELL_FROSTBOLT')).toBe(toCenti(N.frostbolt.damage) + 125)
        } finally {
            delete table.SPELL_FROSTBOLT
        }
    })

    it('Blur cleanses it', () => {
        const b = setup(FROST_KIT, FROST_KIT)
        castFull(b, 'player2', 'SPELL_BLUR')
        castFull(b, 'player1', 'SPELL_FROST_FEVER')
        expect(effectIds(b, 'player2')).toContain('DEBUFF_FROST_FEVER')
        advance(b, secondsToTicks(3.9))
        expect(effectIds(b, 'player2')).not.toContain('DEBUFF_FROST_FEVER')
    })
})

describe('Frost Bomb', () => {
    const interval = PULSE

    it('pulses exactly 3 times, evenly spaced, the last on its expiry tick', () => {
        const b = frostVsGeneral()
        castFull(b, 'player1', 'SPELL_FROST_BOMB')
        const applied = b.state.gameTick
        b.drainEvents()
        const pulses: number[] = []
        for (let t = 0; t < interval * 3 + 30; t++) {
            b.tick()
            for (const e of b.drainEvents()) {
                expect(e).toMatchObject({
                    source: 'SPELL_FROST_BOMB',
                    player: 'player2',
                    amount: -N.frostBomb.pulseDamage,
                })
                pulses.push(e.tick - applied)
            }
        }
        expect(pulses).toEqual([interval, 2 * interval, 3 * interval])
        expect(effectIds(b, 'player2')).toEqual([])
        expect(b.state.player2.hp).toBe(100 - 3 * N.frostBomb.pulseDamage)
    })

    it('Blur cleanses it, so the later pulses never land', () => {
        const b = setup(FROST_KIT, FROST_KIT)
        castFull(b, 'player2', 'SPELL_BLUR')
        castFull(b, 'player1', 'SPELL_FROST_BOMB')
        b.drainEvents()
        advance(b, 3 * interval)
        expect(effectIds(b, 'player2')).not.toContain('DEBUFF_FROST_BOMB')
        // Blur lasts 3.9 s and the bomb was applied 1.5 s into it: it expires before the first 3 s pulse
        expect(dealt(b, 'SPELL_FROST_BOMB')).toBe(0)
    })

    it('a recast replaces it', () => {
        const b = frostVsGeneral()
        castFull(b, 'player1', 'SPELL_FROST_BOMB')
        castFull(b, 'player1', 'SPELL_FROST_BOMB')
        expect(effectIds(b, 'player2')).toEqual(['DEBUFF_FROST_BOMB'])
    })
})

describe('existing rules hold with Frost', () => {
    it('Temporal Shield rewinds to exactly the HP at cast time through Frost damage (invariant 5)', () => {
        const b = setup(FROST_KIT, GENERAL)
        castFull(b, 'player1', 'SPELL_FROSTBOLT')
        castFull(b, 'player1', 'SPELL_FROST_FEVER')
        castFull(b, 'player1', 'SPELL_FROST_BOMB')
        advance(b, PULSE - 10)
        expect(castFull(b, 'player2', 'SPELL_TEMPORAL_SHIELD')).toBe(true)
        const backup = b.state.player2.hp
        expect(castFull(b, 'player1', 'SPELL_ICY_TOUCH')).toBe(true)
        advance(b, secondsToTicks(1.2) - 1)
        // the bomb pulse and the fever ticks landed under the shield
        expect(b.state.player2.hp).toBeLessThan(backup - N.frostBomb.pulseDamage)
        advance(b, 1)
        expect(b.state.player2.hp).toBe(backup)
    })

    it('Magic Eater heals 40% of the Frost damage its owner dealt, at the end of the tick (invariant 6)', () => {
        const b = new Battle({ name: 'A', spells: FROST_KIT, hp: 50 }, { name: 'B', spells: GENERAL })
        advance(b, 10)
        castFull(b, 'player1', 'SPELL_MAGIC_EATER')
        castFull(b, 'player1', 'SPELL_FROSTBOLT')
        // Frostbolt's stack, spent at once: Icy Touch between the same ticks
        expect(castFull(b, 'player1', 'SPELL_ICY_TOUCH')).toBe(true)
        expect(b.state.player1.hp).toBe(50)
        b.tick()
        const hit = toCenti(N.frostbolt.damage) + toCenti(N.icyTouch.damage)
        expect(toCenti(b.state.player1.hp)).toBe(toCenti(50) + (hit * 40) / 100)
    })

    it('a Frost Bomb pulse and a same-tick lethal Icy Touch from the other player are a draw (invariant 4)', () => {
        const b = new Battle({ name: 'A', spells: FROST_KIT, hp: 1 }, { name: 'B', spells: FROST_KIT, hp: 1 })
        advance(b, 10)
        castFull(b, 'player1', 'SPELL_FROST_BOMB')
        b.state.player2.chilling = 1
        advance(b, PULSE)
        expect(b.state.winner).toBe('player1')
        expect(b.finished).toBe(false)
        expect(b.startCast('player2', slot(b, 'player2', 'SPELL_ICY_TOUCH'))).toBe(true)
        expect(b.state.winner).toBe('draw')
        b.tick()
        expect(b.finished).toBe(true)
        b.state.player1.chilling = 1
        expect(b.startCast('player1', slot(b, 'player1', 'SPELL_ICY_TOUCH'))).toBe(false)
        expect(b.state.winner).toBe('draw')
    })

    it('a Frost DoT never ticks a dead player back or past 0 (invariant 4)', () => {
        const b = frostVsGeneral({ p2hp: 10 })
        castFull(b, 'player1', 'SPELL_FROST_FEVER')
        castFull(b, 'player1', 'SPELL_GLACIER')
        expect(b.state.player2.hp).toBe(0)
        expect(b.state.winner).toBe('player1')
        advance(b, 5)
        expect(b.state.player2.hp).toBe(0)
        expect(b.finished).toBe(true)
    })
})
