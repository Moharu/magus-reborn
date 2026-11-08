import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Battle, GLOBAL_COOLDOWN, secondsToTicks, SPELLS, type SpellId } from '@magus/engine'
import { buttonState } from '../src/game/button-state'

const LOADOUT: SpellId[] = [
    'SPELL_HASTE',
    'SPELL_TEMPORAL_SHIELD',
    'SPELL_MAGIC_EATER',
    'SPELL_COUNTERSPELL',
    'SPELL_BLUR',
    'SPELL_FIREBALL',
]
const GENERAL_SPELLS: SpellId[] = [
    'SPELL_HASTE',
    'SPELL_TEMPORAL_SHIELD',
    'SPELL_MAGIC_EATER',
    'SPELL_COUNTERSPELL',
    'SPELL_BLUR',
]
const IDLE = { fader: 0, locked: false, timer: 0 }
const LOCK_TICKS = secondsToTicks(3)

const setup = () => {
    const battle = new Battle({ name: 'Alice', spells: LOADOUT }, { name: 'Bob', spells: LOADOUT })
    advance(battle, 10)
    return battle
}

const advance = (battle: Battle, ticks: number) => {
    for (let i = 0; i < ticks; i++) battle.tick()
}

const cast = (battle: Battle, caster: 'player1' | 'player2', id: SpellId) => {
    expect(battle.startCast(caster, LOADOUT.indexOf(id))).toBe(true)
}

const stateOf = (battle: Battle, id: SpellId, tick = battle.state.gameTick) => {
    const player = battle.state.player1
    return buttonState(player, player.spells[LOADOUT.indexOf(id)], tick)
}

const spellOf = (battle: Battle, id: SpellId) => battle.state.player1.spells[LOADOUT.indexOf(id)]

/** Player 1 starts a Fireball and player 2 counters it, locking player 1. */
const lockPlayer1 = (battle: Battle) => {
    cast(battle, 'player1', 'SPELL_FIREBALL')
    cast(battle, 'player2', 'SPELL_COUNTERSPELL')
    expect(battle.state.player1.lockedUntil).toBe(battle.state.gameTick + LOCK_TICKS)
}

describe('buttonState (#38)', () => {
    it('shows nothing when no timer is running', () => {
        const battle = setup()
        for (const id of LOADOUT) expect(stateOf(battle, id)).toEqual(IDLE)
    })

    describe('GCD', () => {
        /** No shipped spell starts a GCD since #84; set it as an on-GCD instant would. */
        const startGcd = (battle: Battle) => {
            battle.state.player1.gcdUntil = battle.state.gameTick + GLOBAL_COOLDOWN
        }

        it('a running GCD shows a full fader with no text or tint on a cast-time spell', () => {
            const battle = setup()
            startGcd(battle)
            expect(stateOf(battle, 'SPELL_FIREBALL')).toEqual({ fader: 1, locked: false, timer: 0 })
        })

        it('drains the fader with the GCD remaining over its duration', () => {
            const battle = setup()
            startGcd(battle)
            advance(battle, GLOBAL_COOLDOWN / 4)
            expect(stateOf(battle, 'SPELL_FIREBALL').fader).toBe(0.75)
        })

        it('follows the fractional tick the battle view interpolates', () => {
            const battle = setup()
            startGcd(battle)
            const tick = battle.state.gameTick + 0.5
            expect(stateOf(battle, 'SPELL_FIREBALL', tick).fader).toBeCloseTo((GLOBAL_COOLDOWN - 0.5) / GLOBAL_COOLDOWN)
        })

        it('is gone on the tick the GCD ends, when the engine accepts the spell again', () => {
            const battle = setup()
            startGcd(battle)
            advance(battle, GLOBAL_COOLDOWN - 1)
            expect(stateOf(battle, 'SPELL_FIREBALL').fader).toBe(1 / GLOBAL_COOLDOWN)
            advance(battle, 1)
            expect(stateOf(battle, 'SPELL_FIREBALL')).toEqual(IDLE)
            cast(battle, 'player1', 'SPELL_FIREBALL')
        })

        for (const id of GENERAL_SPELLS) {
            it(`${id} is off-GCD and shows no GCD sweep (#84)`, () => {
                const battle = setup()
                startGcd(battle)
                expect(stateOf(battle, id)).toEqual(IDLE)
                cast(battle, 'player1', id)
            })

            it(`${id} starts no GCD: only its own button shows its cooldown (#84)`, () => {
                const battle = setup()
                cast(battle, 'player1', id)
                const { cooldown } = spellOf(battle, id)
                expect(battle.state.player1.gcdUntil).toBe(0)
                expect(stateOf(battle, id)).toEqual({ fader: 1, locked: false, timer: cooldown })
                for (const other of LOADOUT.filter(other => other !== id)) expect(stateOf(battle, other)).toEqual(IDLE)
            })

            it(`${id} keeps showing its own cooldown during the GCD, even a shorter one`, () => {
                const battle = setup()
                cast(battle, 'player1', id)
                const { cooldown } = spellOf(battle, id)
                advance(battle, cooldown - 5)
                startGcd(battle)
                expect(stateOf(battle, id)).toEqual({ fader: 5 / cooldown, locked: false, timer: 5 })
            })
        }
    })

    describe('own cooldown against the GCD', () => {
        // no shipped on-GCD spell has a cooldown since #84, so Temporal Shield is put back on the GCD here
        beforeEach(() => {
            delete SPELLS.SPELL_TEMPORAL_SHIELD.offGlobalCooldown
        })
        afterEach(() => {
            SPELLS.SPELL_TEMPORAL_SHIELD.offGlobalCooldown = true
        })

        /** Temporal Shield on cooldown with `left` ticks to go, and a GCD just started. */
        const shieldCooldownDuringGcd = (left: number) => {
            const battle = setup()
            cast(battle, 'player1', 'SPELL_TEMPORAL_SHIELD')
            const { cooldown } = spellOf(battle, 'SPELL_TEMPORAL_SHIELD')
            advance(battle, cooldown - left)
            battle.state.player1.gcdUntil = battle.state.gameTick + GLOBAL_COOLDOWN
            return { battle, cooldown }
        }

        it('shows the normal display on the button that started the GCD', () => {
            const battle = setup()
            cast(battle, 'player1', 'SPELL_TEMPORAL_SHIELD')
            expect(battle.state.player1.gcdUntil).toBe(battle.state.gameTick + GLOBAL_COOLDOWN)
            const { cooldown } = spellOf(battle, 'SPELL_TEMPORAL_SHIELD')
            expect(stateOf(battle, 'SPELL_TEMPORAL_SHIELD')).toEqual({ fader: 1, locked: false, timer: cooldown })
        })

        it('shows the normal display when the cooldown is longer than the GCD', () => {
            const left = GLOBAL_COOLDOWN + 1
            const { battle, cooldown } = shieldCooldownDuringGcd(left)
            expect(stateOf(battle, 'SPELL_TEMPORAL_SHIELD')).toEqual({
                fader: left / cooldown,
                locked: false,
                timer: left,
            })
        })

        it('shows the normal display when the cooldown and the GCD are equal', () => {
            const left = GLOBAL_COOLDOWN
            const { battle, cooldown } = shieldCooldownDuringGcd(left)
            expect(stateOf(battle, 'SPELL_TEMPORAL_SHIELD')).toEqual({
                fader: left / cooldown,
                locked: false,
                timer: left,
            })
        })

        it('shows the GCD fader without text when the GCD is longer than the cooldown', () => {
            const { battle } = shieldCooldownDuringGcd(GLOBAL_COOLDOWN - 1)
            expect(stateOf(battle, 'SPELL_TEMPORAL_SHIELD')).toEqual({ fader: 1, locked: false, timer: 0 })
        })
    })

    describe('Counterspell lock', () => {
        it('shows the tint, a full fill and the timer on every button, off-GCD ones included', () => {
            const battle = setup()
            lockPlayer1(battle)
            for (const id of LOADOUT) {
                expect(stateOf(battle, id)).toEqual({ fader: 1, locked: true, timer: LOCK_TICKS })
            }
        })

        it('keeps the cooldown fader and the longer timer on a spell that is on cooldown', () => {
            const battle = setup()
            cast(battle, 'player1', 'SPELL_BLUR')
            const { cooldown } = spellOf(battle, 'SPELL_BLUR')
            lockPlayer1(battle)
            expect(stateOf(battle, 'SPELL_BLUR')).toEqual({ fader: 1, locked: true, timer: cooldown })
        })

        it('keeps the timer of the lock when it outlasts the cooldown', () => {
            const battle = setup()
            cast(battle, 'player1', 'SPELL_BLUR')
            const { cooldown } = spellOf(battle, 'SPELL_BLUR')
            advance(battle, cooldown - 10)
            lockPlayer1(battle)
            expect(stateOf(battle, 'SPELL_BLUR')).toEqual({ fader: 10 / cooldown, locked: true, timer: LOCK_TICKS })
        })

        it('takes priority over the GCD', () => {
            const battle = setup()
            lockPlayer1(battle)
            battle.state.player1.gcdUntil = battle.state.gameTick + GLOBAL_COOLDOWN
            expect(stateOf(battle, 'SPELL_FIREBALL')).toEqual({ fader: 1, locked: true, timer: LOCK_TICKS })
        })

        it('counts down the lock alone, even if the GCD runs longer', () => {
            const battle = setup()
            lockPlayer1(battle)
            battle.state.player1.gcdUntil = battle.state.player1.lockedUntil + 10
            expect(stateOf(battle, 'SPELL_FIREBALL')).toEqual({ fader: 1, locked: true, timer: LOCK_TICKS })
        })

        it('is gone on the tick the lock ends', () => {
            const battle = setup()
            lockPlayer1(battle)
            advance(battle, LOCK_TICKS - 1)
            expect(stateOf(battle, 'SPELL_FIREBALL')).toEqual({ fader: 1, locked: true, timer: 1 })
            advance(battle, 1)
            expect(stateOf(battle, 'SPELL_FIREBALL')).toEqual(IDLE)
        })
    })
})
