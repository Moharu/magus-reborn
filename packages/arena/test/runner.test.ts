import { SPELLS } from '@magus/engine'
import { afterEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_MAX_TICKS,
    EXAMPLE_ENTRANTS,
    formatLog,
    priority,
    runMatch,
    start,
    stop,
    type ArenaView,
    type ControllerFactory,
    type ControllerInit,
} from '../src'
import { entrant, idler, METEOR_LOADOUT, only, OTHER_LOADOUT, recording, scripted, slotOf } from './helpers'

const METEOR = slotOf(METEOR_LOADOUT, 'SPELL_METEOR')
const FIREBALL = slotOf(METEOR_LOADOUT, 'SPELL_FIREBALL')
const HASTE = slotOf(METEOR_LOADOUT, 'SPELL_HASTE')
const COUNTER = slotOf(METEOR_LOADOUT, 'SPELL_COUNTERSPELL')
/**
 * Meteor: 3.6 s cast = 72 ticks, 28 damage, so the 4th release kills from 100 HP. `priority` releases on the tick a
 * cast completes and starts the next one on the following tick: releases at 72, 145, 218 and 291.
 */
const KILL_TICK = 4 * 72 + 3

describe('runMatch: determinism', () => {
    it('gives an identical result and log for the same seed and inputs', () => {
        const run = () => runMatch({ seed: 7, a: EXAMPLE_ENTRANTS.aggressor, b: EXAMPLE_ENTRANTS.counter })
        const first = run()
        expect(run()).toEqual(first)
        expect(formatLog(run())).toBe(formatLog(first))
        expect(first.log.length).toBeGreaterThan(10)
    })

    it('lets the seed change the match through the controllers seeded streams', () => {
        const logs = new Set(
            [1, 2, 3, 4].map(seed =>
                formatLog(runMatch({ seed, a: EXAMPLE_ENTRANTS.aggressor, b: EXAMPLE_ENTRANTS.counter })),
            ),
        )
        expect(logs.size).toBeGreaterThan(1)
    })

    it('gives each side its own stream, so one side drawing more never shifts the other', () => {
        const draws = (greedy: boolean) => {
            const values: number[] = []
            const sampler: ControllerFactory =
                ({ rng }) =>
                () => {
                    values.push(rng.uint32())
                    return null
                }
            const hungry: ControllerFactory =
                ({ rng }) =>
                () => {
                    if (greedy) for (let i = 0; i < 5; i++) rng.uint32()
                    return null
                }
            runMatch({ seed: 9, a: entrant('hungry', hungry), b: entrant('sampler', sampler), maxTicks: 20 })
            return values
        }
        expect(draws(true)).toEqual(draws(false))
    })
})

describe('runMatch: time cap', () => {
    it('is a draw on exactly maxTicks when neither player ever casts', () => {
        const result = runMatch({ seed: 1, a: idler(), b: idler(), maxTicks: 100 })
        expect(result).toMatchObject({ winner: 'draw', reason: 'timeout', ticks: 100, hp: { a: 100, b: 100 } })
        expect(result.log).toEqual([])
    })

    it('defaults to 3 minutes (3600 ticks)', () => {
        expect(DEFAULT_MAX_TICKS).toBe(3600)
        expect(runMatch({ seed: 1, a: idler(), b: idler() }).ticks).toBe(3600)
    })

    it('resolves the cap tick like any other: a kill landing exactly on tick maxTicks counts', () => {
        const result = runMatch({ seed: 1, a: only('SPELL_METEOR'), b: idler(), maxTicks: KILL_TICK })
        expect(result).toMatchObject({ winner: 'a', reason: 'death', ticks: KILL_TICK, hp: { a: 100, b: 0 } })
        expect(result.log.at(-1)).toEqual({
            tick: KILL_TICK,
            side: 'a',
            type: 'SPELL_RELEASE',
            spellId: 'SPELL_METEOR',
        })
        // one tick short of the kill, the match is a timeout on exactly maxTicks
        expect(runMatch({ seed: 1, a: only('SPELL_METEOR'), b: idler(), maxTicks: KILL_TICK - 1 })).toMatchObject({
            winner: 'draw',
            reason: 'timeout',
            ticks: KILL_TICK - 1,
            hp: { a: 100, b: 16 },
        })
    })

    it('a mutual kill exactly on the cap tick is a draw by death, not a timeout', () => {
        const result = runMatch({ seed: 1, a: only('SPELL_METEOR'), b: only('SPELL_METEOR'), maxTicks: KILL_TICK })
        expect(result).toMatchObject({ winner: 'draw', reason: 'mutual', ticks: KILL_TICK, hp: { a: 0, b: 0 } })
    })

    it('rejects a bad seed, maxTicks or loadout', () => {
        expect(() => runMatch({ seed: -1, a: idler(), b: idler() })).toThrow(/seed/)
        expect(() => runMatch({ seed: 1, a: idler(), b: idler(), maxTicks: 0 })).toThrow(/maxTicks/)
        expect(() => runMatch({ seed: 1, a: idler(['SPELL_FIREBALL']), b: idler() })).toThrow(/entrant a.*loadout/)
    })
})

describe('runMatch: death', () => {
    it('one-sided kill: the winner is decided at 0 HP and the match ends on that tick', () => {
        const result = runMatch({ seed: 1, a: only('SPELL_METEOR'), b: idler() })
        expect(result).toMatchObject({ winner: 'a', reason: 'death', ticks: KILL_TICK, hp: { a: 100, b: 0 } })
        expect(result.stats.a).toMatchObject({ casts: 4, started: 4, cancelled: 0, rejected: 0 })
        expect(result.stats.b.damageTaken).toBe(100)
    })

    it('mutual kill: the second lethal release in the same tick still resolves, so it is a draw', () => {
        const result = runMatch({ seed: 1, a: only('SPELL_METEOR'), b: only('SPELL_METEOR') })
        expect(result).toMatchObject({ winner: 'draw', reason: 'mutual', ticks: KILL_TICK, hp: { a: 0, b: 0 } })
        const last = result.log.filter(e => e.tick === KILL_TICK && e.type === 'SPELL_RELEASE').map(e => e.side)
        expect(last).toEqual(['a', 'b'])
    })

    it('mutual kill inside tick(): mirrored damage over time kills both on the same tick, a draw', () => {
        const result = runMatch({ seed: 1, a: only('SPELL_IGNITE'), b: only('SPELL_IGNITE') })
        expect(result).toMatchObject({ winner: 'draw', reason: 'mutual', hp: { a: 0, b: 0 } })
    })

    it('a lethal release one tick after the kill does not count', () => {
        const lateMeteor: ControllerFactory = init => {
            const decide = priority({ order: ['SPELL_METEOR'] })(init)
            return view => (view.tick === 0 ? null : decide(view))
        }
        const result = runMatch({ seed: 1, a: only('SPELL_METEOR'), b: entrant('late', lateMeteor) })
        expect(result).toMatchObject({ winner: 'a', ticks: KILL_TICK, hp: { a: 16, b: 0 } })
        expect(result.log.filter(e => e.side === 'b' && e.type === 'SPELL_RELEASE')).toHaveLength(3)
    })

    it('a kill inside tick() still lets both players act on that tick, then nothing more', () => {
        // b sees itself at 0 HP on the winner's tick and Counterspells: that action resolves, the match then ends
        const lastWord: ControllerFactory = () => view => (view.self.hp === 0 ? start(COUNTER) : null)
        const result = runMatch({ seed: 1, a: only('SPELL_IGNITE'), b: entrant('last word', lastWord) })
        expect(result).toMatchObject({ winner: 'a', reason: 'death', hp: { b: 0 } })
        // b's Counterspell also interrupts the Ignite a was casting on that tick
        expect(result.log.filter(e => e.tick === result.ticks && e.type !== 'START_CAST')).toEqual([
            { tick: result.ticks, side: 'b', type: 'SPELL_RELEASE', spellId: 'SPELL_COUNTERSPELL' },
            {
                tick: result.ticks,
                side: 'a',
                type: 'INTERRUPTED',
                spellId: 'SPELL_IGNITE',
                source: 'SPELL_COUNTERSPELL',
            },
        ])
        expect(result.stats.b).toMatchObject({ casts: 1, interrupts: 1, rejected: 0 })
    })
})

describe('runMatch: engine rules apply through startCast/stopCast', () => {
    it('a Counterspell lock blocks every start for 3 s (60 ticks)', () => {
        // a presses Meteor every tick it isn't casting, and releases when the cast completes
        const blind: ControllerFactory = () => view => {
            if (view.self.casting) return view.tick >= view.self.casting.completesAt ? stop(METEOR) : null
            return start(METEOR)
        }
        const counterOnly = entrant('counter', priority({ order: [], counter: { reactionTicks: 10 } }))
        const result = runMatch({ seed: 1, a: entrant('blind', blind), b: counterOnly, maxTicks: 200 })
        const starts = result.log.filter(e => e.side === 'a' && e.type === 'START_CAST').map(e => e.tick)
        expect(result.log.find(e => e.type === 'INTERRUPTED')).toMatchObject({ tick: 10, side: 'a' })
        expect(starts.slice(0, 2)).toEqual([0, 70])
        expect(result.stats.a.rejected).toBe(59)
        expect(result.stats.a.interrupted).toBe(1)
        expect(result.stats.b.interrupts).toBe(1)
    })

    it('an instant cancels the cast, but one rejected by its cooldown leaves the cast alone', () => {
        const script = scripted({
            0: start(METEOR),
            5: start(HASTE),
            6: start(METEOR),
            7: start(HASTE),
            [6 + 36]: stop(METEOR),
        })
        const result = runMatch({ seed: 1, a: entrant('script', script), b: idler(), maxTicks: 60 })
        const a = result.log.filter(e => e.side === 'a').map(e => `${e.tick} ${e.type}`)
        // Haste halves the 72-tick Meteor to 36 ticks
        expect(a).toEqual([
            '0 START_CAST',
            '5 CANCEL_CAST',
            '5 SPELL_RELEASE',
            '6 START_CAST',
            '42 STOP_CAST',
            '42 SPELL_RELEASE',
        ])
        expect(result.stats.a).toMatchObject({ rejected: 1, cancelled: 1, casts: 2 })
        expect(result.hp.b).toBe(72)
    })

    it('stopping before the cast completes cancels it without a release', () => {
        const fake = scripted({ 0: start(FIREBALL), 10: stop(FIREBALL), 11: stop(FIREBALL) })
        const result = runMatch({ seed: 1, a: entrant('fake', fake), b: idler(), maxTicks: 40 })
        expect(result.stats.a).toMatchObject({ started: 1, cancelled: 1, casts: 0, rejected: 1 })
        expect(result.hp.b).toBe(100)
    })

    it('counts a stop as a cancel when an instant started in the same decision releases right after it', () => {
        const script = scripted({ 0: start(METEOR), 1: [stop(METEOR), start(HASTE)] })
        const result = runMatch({ seed: 1, a: entrant('script', script), b: idler(), maxTicks: 10 })
        expect(result.log.filter(e => e.side === 'a').map(e => `${e.tick} ${e.type} ${e.spellId}`)).toEqual([
            '0 START_CAST SPELL_METEOR',
            '1 STOP_CAST SPELL_METEOR',
            '1 SPELL_RELEASE SPELL_HASTE',
        ])
        expect(result.stats.a).toMatchObject({ started: 1, cancelled: 1, casts: 1, rejected: 0 })
        expect(result.hp.b).toBe(100)
    })

    it('counts a stop that releases the completed cast as a release, not a cancel', () => {
        const script = scripted({ 0: start(FIREBALL), 26: [stop(FIREBALL), start(HASTE)] })
        const result = runMatch({ seed: 1, a: entrant('script', script), b: idler(), maxTicks: 30 })
        expect(result.stats.a).toMatchObject({ started: 1, cancelled: 0, casts: 2, rejected: 0 })
        expect(result.hp.b).toBe(94.4)
    })

    describe('with Haste put on the GCD', () => {
        afterEach(() => {
            SPELLS.SPELL_HASTE.offGlobalCooldown = true
        })

        it('blocks a cast-time spell until the 1 s GCD ends', () => {
            delete SPELLS.SPELL_HASTE.offGlobalCooldown
            const script = scripted({ 0: start(HASTE), 1: start(FIREBALL), 19: start(FIREBALL), 20: start(FIREBALL) })
            const result = runMatch({ seed: 1, a: entrant('script', script), b: idler(), maxTicks: 30 })
            const starts = result.log.filter(e => e.type === 'START_CAST').map(e => e.tick)
            expect(starts).toEqual([20])
            expect(result.stats.a.rejected).toBe(2)
        })
    })
})

describe('runMatch: what a controller sees', () => {
    it('gets its own loadout and seeded stream at init, nothing about the opponent', () => {
        const inits: ControllerInit[] = []
        const spy: ControllerFactory = init => {
            inits.push(init)
            return () => null
        }
        runMatch({ seed: 1, a: entrant('spy', spy), b: idler(OTHER_LOADOUT), maxTicks: 1 })
        expect(Object.keys(inits[0]).sort()).toEqual(['loadout', 'rng'])
        expect(inits[0].loadout).toEqual(METEOR_LOADOUT)
    })

    it("never holds the opponent's loadout, only the spell the opponent is casting", () => {
        const hidden = OTHER_LOADOUT.filter(id => !METEOR_LOADOUT.includes(id))
        expect(hidden.length).toBeGreaterThan(0)
        const seen: ArenaView[] = []
        const other = entrant('other', priority({ order: ['SPELL_LIVING_BOMB'] }), OTHER_LOADOUT)
        runMatch({
            seed: 1,
            a: entrant(
                'watcher',
                recording(() => () => null, seen),
            ),
            b: other,
            maxTicks: 200,
        })

        // ticks 0 to maxTicks, the cap tick included
        expect(seen).toHaveLength(201)
        for (const view of seen) {
            expect(Object.keys(view.enemy).sort()).toEqual(['casting', 'hp', 'lockedUntil'])
            const json = JSON.stringify(view)
            for (const id of hidden) {
                if (id === view.enemy.casting?.spellId) continue
                expect(json).not.toContain(id)
            }
        }
        const visible = seen.find(view => view.enemy.casting)
        expect(visible?.enemy.casting).toMatchObject({ spellId: 'SPELL_LIVING_BOMB', startTick: 0, completesAt: 30 })
        expect(seen[0].self.spells.map(s => s.id)).toEqual(METEOR_LOADOUT)
    })

    it('shows engine readiness: cooldowns and the lock after an interrupt', () => {
        const seen: ArenaView[] = []
        const a = entrant('a', recording(priority({ order: ['SPELL_METEOR'] }), seen))
        const b = entrant('b', priority({ order: [], counter: { reactionTicks: 10 } }))
        runMatch({ seed: 1, a, b, maxTicks: 80 })
        expect(seen[11].self).toMatchObject({ casting: null, lockedUntil: 70 })
        expect(seen[11].self.spells[METEOR]).toMatchObject({ lockRemaining: 59, ready: false })
        expect(seen[70].self.spells[METEOR]).toMatchObject({ lockRemaining: 0, ready: true })
    })
})
