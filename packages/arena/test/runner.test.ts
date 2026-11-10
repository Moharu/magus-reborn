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

describe('runMatch: spell logs', () => {
    it('gives each player its own copy of a log entry: editing one in a view leaves the opponent view alone', () => {
        const seenB: ArenaView[] = []
        // a vandal that rewrites every entry of its own log and of the enemy's log it is shown
        const vandal: ControllerFactory = () => {
            const decide = scripted({ 5: start(FIREBALL) })({ loadout: METEOR_LOADOUT, rng: null as never })
            return view => {
                for (const entry of [...view.self.log, ...view.enemy.log]) (entry as { spellId: string }).spellId = 'X'
                return decide(view)
            }
        }
        runMatch({
            seed: 1,
            a: entrant('a', vandal),
            b: entrant('b', recording(scripted({ 8: start(METEOR) }), seenB)),
            maxTicks: 40,
        })
        const last = seenB[seenB.length - 1]
        // b sees a's START_CAST on its enemy log untouched, though a overwrote its own copy
        expect(last.enemy.log.map(e => e.spellId)).toEqual(['SPELL_FIREBALL'])
        expect(last.self.log.map(e => e.spellId)).toEqual(['SPELL_METEOR'])
    })
})

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

    it("never holds the opponent's loadout, only the spells the opponent is casting or has cast", () => {
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
            // hpLog (#146): the floating combat text over the opponent, which every client shows
            // never the opponent's class resources such as Chilling (#171): the server leaves them out
            expect(Object.keys(view.enemy).sort()).toEqual(['casting', 'effects', 'hp', 'hpLog', 'lockedUntil', 'log'])
            for (const entry of [...(view.enemy.hpLog ?? []), ...(view.self.hpLog ?? [])])
                expect(Object.keys(entry).sort()).toEqual(['amount', 'kind', 'spellId', 'tick'])
            // a spell the opponent has cast is on the client's spell log; the rest of its loadout never shows
            const revealed = new Set([view.enemy.casting?.spellId, ...view.enemy.log.map(e => e.spellId)])
            const json = JSON.stringify(view)
            for (const id of hidden) {
                if (revealed.has(id)) continue
                expect(json).not.toContain(id)
            }
        }
        expect(new Set(seen[200].enemy.log.map(e => e.spellId))).toEqual(new Set(['SPELL_LIVING_BOMB']))
        const visible = seen.find(view => view.enemy.casting)
        expect(visible?.enemy.casting).toMatchObject({ spellId: 'SPELL_LIVING_BOMB', startTick: 0, completesAt: 30 })
        expect(seen[0].self.spells.map(s => s.id)).toEqual(METEOR_LOADOUT)
    })

    it("shows both players' buffs and debuffs, as id, kind and timer only", () => {
        const IGNITE = slotOf(METEOR_LOADOUT, 'SPELL_IGNITE')
        const BLUR = slotOf(METEOR_LOADOUT, 'SPELL_BLUR')
        const SHIELD = slotOf(OTHER_LOADOUT, 'SPELL_TEMPORAL_SHIELD')
        const EATER = slotOf(OTHER_LOADOUT, 'SPELL_MAGIC_EATER')
        const COUNTER_B = slotOf(OTHER_LOADOUT, 'SPELL_COUNTERSPELL')
        // a: Haste and Blur, two Ignites, then a Meteor that b counters 5 ticks in
        const a: ControllerFactory = () => {
            let ignites = 0
            return ({ tick, self }) => {
                if (tick === 0) return [start(HASTE), start(BLUR)]
                if (self.casting) {
                    if (tick < self.casting.completesAt) return null
                    if (self.casting.spellId === 'SPELL_IGNITE') ignites += 1
                    return stop(self.casting.slot)
                }
                if (ignites < 2) return start(IGNITE)
                return self.spells[METEOR].ready ? start(METEOR) : null
            }
        }
        const b: ControllerFactory =
            () =>
            ({ tick, enemy }) => {
                if (tick === 5) return start(SHIELD)
                if (tick === 6) return start(EATER)
                return enemy.casting?.spellId === 'SPELL_METEOR' && tick === enemy.casting.startTick + 5
                    ? start(COUNTER_B)
                    : null
            }
        const seenA: ArenaView[] = []
        const seenB: ArenaView[] = []
        const result = runMatch({
            seed: 1,
            a: entrant('a', recording(a, seenA)),
            b: entrant('b', recording(b, seenB), OTHER_LOADOUT),
            maxTicks: 120,
        })
        const ids = (effects: ArenaView['self']['effects']) => effects.map(e => e.id)

        expect(seenA[1].self.effects).toEqual([
            { id: 'BUFF_HASTE', type: 'positive', startingTick: 0, expiresAt: 1200 },
            { id: 'BUFF_BLUR', type: 'positive', startingTick: 0, expiresAt: 78 },
        ])
        expect(seenB[1].enemy.effects).toEqual(seenA[1].self.effects)
        // Temporal Shield (1.2 s) from tick 5 and Magic Eater (7.8 s) from tick 6, on b, as a sees them
        expect(seenA[7].enemy.effects).toEqual([
            { id: 'BUFF_TEMPORAL_SHIELD', type: 'positive', startingTick: 5, expiresAt: 29 },
            { id: 'BUFF_MAGIC_EATER', type: 'positive', startingTick: 6, expiresAt: 162 },
        ])
        expect(ids(seenA[28].enemy.effects)).toContain('BUFF_TEMPORAL_SHIELD')
        expect(ids(seenA[29].enemy.effects)).not.toContain('BUFF_TEMPORAL_SHIELD')
        // the Ignite stacks on b
        const stacks = seenA.map(view => view.enemy.effects.filter(e => e.id === 'DEBUFF_IGNITE').length)
        expect(Math.max(...stacks)).toBe(2)
        expect(seenB.map(view => view.self.effects.filter(e => e.id === 'DEBUFF_IGNITE').length)).toEqual(stacks)
        // the Counterspell lock on a, on both sides of the view
        const interrupt = result.log.find(e => e.type === 'INTERRUPTED')!
        expect(interrupt).toMatchObject({ side: 'a', spellId: 'SPELL_METEOR' })
        const after = interrupt.tick + 1
        expect(seenA[after].self).toMatchObject({ lockedUntil: interrupt.tick + 60 })
        expect(seenB[after].enemy).toMatchObject({ lockedUntil: interrupt.tick + 60 })
        expect(seenB[after].enemy.effects).toContainEqual({
            id: 'DEBUFF_COUNTERSPELL',
            type: 'negative',
            startingTick: interrupt.tick,
            expiresAt: interrupt.tick + 60,
        })

        // never an effect's internals: Haste's saved cast times, the shield's saved HP, Magic Eater's pending heal
        for (const view of [...seenA, ...seenB]) {
            for (const effect of [...view.self.effects, ...view.enemy.effects]) {
                expect(Object.keys(effect).sort()).toEqual(['expiresAt', 'id', 'startingTick', 'type'])
            }
            const json = JSON.stringify(view)
            for (const hidden of ['backup', 'pendingDamage', 'healCarry', 'logIndex', 'damage', 'source'])
                expect(json).not.toContain(`"${hidden}"`)
            // nor the opponent's cooldowns, GCD or loadout
            const enemy = JSON.stringify(view.enemy)
            for (const hidden of ['cooldown', 'gcd', 'spells', 'ready']) expect(enemy).not.toContain(hidden)
        }
    })

    it("shows the opponent's spell log as the client receives it: the engine log entries before this tick", () => {
        // b: a Fireball, a Meteor cancelled by starting an Ignite, Ignite released, a fake Meteor stopped early, then a
        // Counterspell on a's empty cast bar and one that interrupts a's Fireball
        const b = scripted({
            0: start(FIREBALL),
            26: stop(FIREBALL),
            27: start(METEOR),
            30: start(slotOf(METEOR_LOADOUT, 'SPELL_IGNITE')),
            62: stop(slotOf(METEOR_LOADOUT, 'SPELL_IGNITE')),
            63: start(METEOR),
            66: stop(METEOR),
            70: start(COUNTER),
            // ready again on 70 + 234 = 304
            310: start(COUNTER),
        })
        const a = scripted({ 300: start(FIREBALL) })
        const seenA: ArenaView[] = []
        const seenB: ArenaView[] = []
        const result = runMatch({
            seed: 1,
            a: entrant('a', recording(a, seenA)),
            b: entrant('b', recording(b, seenB)),
            maxTicks: 330,
        })
        const entriesOf = (side: 'a' | 'b', before: number) =>
            result.log
                .filter(e => e.side === side && e.tick < before)
                .map(e => ({ tick: e.tick, type: e.type, spellId: e.spellId }))
        // on every tick, each side's enemy log is exactly the other side's engine log entries from earlier ticks
        for (const view of seenA) expect(view.enemy.log).toEqual(entriesOf('b', view.tick))
        for (const view of seenB) expect(view.enemy.log).toEqual(entriesOf('a', view.tick))
        // and its own log (#136) is exactly its own entries from earlier ticks, the interrupted cast included
        for (const view of seenA) expect(view.self.log).toEqual(entriesOf('a', view.tick))
        for (const view of seenB) expect(view.self.log).toEqual(entriesOf('b', view.tick))
        expect(seenA[300].enemy.log.map(e => `${e.tick} ${e.type} ${e.spellId}`)).toEqual([
            '0 START_CAST SPELL_FIREBALL',
            '26 STOP_CAST SPELL_FIREBALL',
            '26 SPELL_RELEASE SPELL_FIREBALL',
            '27 START_CAST SPELL_METEOR',
            '30 CANCEL_CAST SPELL_METEOR',
            '30 START_CAST SPELL_IGNITE',
            '62 STOP_CAST SPELL_IGNITE',
            '62 SPELL_RELEASE SPELL_IGNITE',
            '63 START_CAST SPELL_METEOR',
            '66 STOP_CAST SPELL_METEOR',
            // the whiff: no INTERRUPTED and no lock, but the client's log shows it
            '70 SPELL_RELEASE SPELL_COUNTERSPELL',
        ])
        expect(seenA[71].self.lockedUntil).toBe(0)
        expect(seenA[71].self.effects.map(e => e.id)).not.toContain('DEBUFF_COUNTERSPELL')
        // a's interrupted Fireball is on b's enemy log, b's Counterspell that landed on a's
        expect(seenB[330].enemy.log.map(e => `${e.tick} ${e.type} ${e.spellId}`)).toEqual([
            '300 START_CAST SPELL_FIREBALL',
            '310 INTERRUPTED SPELL_FIREBALL',
        ])
        expect(seenA[311].enemy.log.at(-1)).toEqual({ tick: 310, type: 'SPELL_RELEASE', spellId: 'SPELL_COUNTERSPELL' })
        // seen from the tick after, the same as the client: on its own tick it isn't on the log yet
        expect(seenA[70].enemy.log.some(e => e.spellId === 'SPELL_COUNTERSPELL')).toBe(false)
        expect(seenA[71].enemy.log.at(-1)).toEqual({ tick: 70, type: 'SPELL_RELEASE', spellId: 'SPELL_COUNTERSPELL' })
        // only the client's fields: never a loadout slot or anything else of the engine entry
        for (const view of [...seenA, ...seenB])
            for (const entry of view.enemy.log) expect(Object.keys(entry).sort()).toEqual(['spellId', 'tick', 'type'])
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
