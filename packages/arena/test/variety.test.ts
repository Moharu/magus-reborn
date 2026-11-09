import { secondsToTicks, SPELLS, type SpellId } from '@magus/engine'
import { describe, expect, it } from 'vitest'
import baselineJson from '../baselines/reborn-0.3.0.json'
import {
    adaptProfile,
    ARCHETYPE_NAMES,
    ARCHETYPES,
    archetypeEntrant,
    DEFAULT_GENERAL_PAIRS,
    DEFAULT_TOP,
    GENERAL_SPELLS,
    parseBaseline,
    parseProfile,
    profileEntrant,
    runMatch,
    selectLoadouts,
    type MatchEvent,
    type Profile,
} from '../src'
import { idler, METEOR_LOADOUT, OTHER_LOADOUT, entrant, scripted, slotOf } from './helpers'
import { start, stop } from '../src'
import { quietProfile } from './profile-helpers'

// #136: rotations built from the loadout, give-up timers on every wait, and every general spell used

// the shipped v0.3.0 table (the #136 field), read as data whatever the engine version
const baseline = parseBaseline(baselineJson)
/** The loadouts of the default field: the top 8 Fire sets, each with all 6 general pairs. */
const field = selectLoadouts(baseline, DEFAULT_TOP, DEFAULT_GENERAL_PAIRS).loadouts.map(l => l.loadout)

const isFire = (id: SpellId | undefined) => id !== undefined && SPELLS[id].school === 'FIRE'
const of = (log: readonly MatchEvent[], side: 'a' | 'b', type: MatchEvent['type']) =>
    log.filter(e => e.side === side && e.type === type)

describe('every entrant of the field plays (#136)', () => {
    it('the default field is 48 loadouts: 8 Fire sets x 6 general pairs', () => {
        expect(field).toHaveLength(48)
    })

    it('every profile, on every loadout in the field, casts a Fire spell against an opponent that never acts', () => {
        for (const name of ARCHETYPE_NAMES)
            for (const loadout of field) {
                const result = runMatch({
                    seed: 1,
                    a: profileEntrant(ARCHETYPES[name].profile, loadout),
                    b: idler(),
                    maxTicks: secondsToTicks(10),
                })
                const fire = of(result.log, 'a', 'SPELL_RELEASE').filter(e => isFire(e.spellId))
                expect(fire.length, `${name} on ${loadout.join()}`).toBeGreaterThan(0)
                expect(result.stats.a.rejected, `${name} on ${loadout.join()}`).toBe(0)
            }
    })

    it('every profile, on every loadout in the field, uses each general spell it holds against the archetypes', () => {
        // whether a reactive rule fires depends on the opponent (Blur needs an enemy Ignite or Living Bomb landing):
        // each general must be used in at least one match against the four archetypes
        for (const name of ARCHETYPE_NAMES)
            for (const loadout of field) {
                const used = new Set<SpellId | undefined>()
                for (const enemy of ARCHETYPE_NAMES) {
                    const result = runMatch({
                        seed: 2,
                        a: profileEntrant(ARCHETYPES[name].profile, loadout),
                        b: archetypeEntrant(enemy),
                        maxTicks: secondsToTicks(90),
                    })
                    for (const e of of(result.log, 'a', 'SPELL_RELEASE')) used.add(e.spellId)
                }
                for (const general of loadout.slice(5))
                    expect(used.has(general), `${name} on ${loadout.join()}: ${general}`).toBe(true)
            }
    })

    it('no archetype sets a general spell to "never"', () => {
        for (const name of ARCHETYPE_NAMES)
            for (const id of GENERAL_SPELLS)
                expect(ARCHETYPES[name].profile.generals[id], `${name} ${id}`).not.toBe('never')
    })
})

/** The quiet test profile with `edit` applied, parsed. */
const custom = (edit: (raw: ReturnType<typeof quietProfile> & Record<string, unknown>) => void): Profile => {
    const raw = quietProfile() as ReturnType<typeof quietProfile> & Record<string, unknown>
    edit(raw)
    return parseProfile(raw)
}
const firstStart = (log: readonly MatchEvent[], side: 'a' | 'b') => of(log, side, 'START_CAST')[0]?.tick

describe('give-up timers (#136)', () => {
    it('two profiles waiting for the opponent to commit break the stalemate when the timer ends', () => {
        const { profile, loadout } = ARCHETYPES['patient-counter']
        expect(profile.patience.commitGiveUpSeconds).toBe(3)
        const mirror = (commitGiveUpSeconds: number) => {
            const waiter = { ...profile, patience: { ...profile.patience, commitGiveUpSeconds } }
            return runMatch({
                seed: 1,
                a: profileEntrant(waiter, loadout),
                b: profileEntrant(waiter, loadout),
                maxTicks: 1200,
            })
        }
        // both wait 3 s (60 ticks) for the other to commit, then start their rotations
        const shipped = mirror(3)
        expect(firstStart(shipped.log, 'a')).toBe(60)
        expect(firstStart(shipped.log, 'b')).toBe(60)
        // the timer sets when: with 20 s, nobody casts before tick 400
        const patient = mirror(20)
        expect(firstStart(patient.log, 'a')).toBe(400)
        expect(firstStart(patient.log, 'b')).toBe(400)
    })

    it('two profiles waiting for each other to cast first break the stalemate after thresholdGiveUpSeconds', () => {
        // a rotation that only answers an enemy cast: facing itself, nobody ever casts without a give-up timer
        const answerer = (thresholdGiveUpSeconds: number | null) =>
            custom(raw => {
                raw.rotation = [{ spell: 'SPELL_FIREBALL', when: [{ type: 'enemyCasting' }] }]
                raw.patience = { thresholdGiveUpSeconds, commitGiveUpSeconds: null }
            })
        const run = (seconds: number | null) =>
            runMatch({
                seed: 1,
                a: profileEntrant(answerer(seconds), METEOR_LOADOUT),
                b: profileEntrant(answerer(seconds), METEOR_LOADOUT),
                maxTicks: 600,
            })
        expect(of(run(null).log, 'a', 'START_CAST')).toEqual([])
        const given = run(2)
        expect(firstStart(given.log, 'a')).toBe(40)
        expect(firstStart(given.log, 'b')).toBe(40)
    })

    it('a stack threshold that never comes gives up: Combustion waiting on Ignites it never casts', () => {
        const waiter = (thresholdGiveUpSeconds: number | null) =>
            custom(raw => {
                raw.rotation = [
                    {
                        spell: 'SPELL_COMBUSTION',
                        when: [{ type: 'enemyEffectsAtLeast', effect: 'DEBUFF_IGNITE', count: 3 }],
                    },
                ]
                raw.patience = { thresholdGiveUpSeconds, commitGiveUpSeconds: null }
            })
        const run = (seconds: number | null) =>
            runMatch({ seed: 1, a: profileEntrant(waiter(seconds), METEOR_LOADOUT), b: idler(), maxTicks: 400 })
        expect(of(run(null).log, 'a', 'START_CAST')).toEqual([])
        const given = run(1.5)
        expect(of(given.log, 'a', 'START_CAST')[0]).toMatchObject({ tick: 30, spellId: 'SPELL_COMBUSTION' })
        // after each release it is idle again, so the next Combustion waits another 1.5 s
        expect(of(given.log, 'a', 'START_CAST')[1]).toMatchObject({ tick: 30 + 48 + 30 })
    })

    it('holding Counterspell for a target that never comes gives up and interrupts the next cast', () => {
        const holder = (giveUpSeconds: number | null) =>
            custom(raw => {
                Object.assign(raw.counterspell, { enabled: true, giveUpSeconds })
            })
        const fireballs = profileEntrant(
            custom(raw => (raw.rotation = ['SPELL_FIREBALL'])),
            METEOR_LOADOUT,
            'fireballs',
        )
        const run = (seconds: number | null) =>
            runMatch({ seed: 1, a: profileEntrant(holder(seconds), METEOR_LOADOUT), b: fireballs, maxTicks: 600 })
        expect(run(null).stats.a.interrupts).toBe(0)
        const given = run(5)
        const [interrupt] = of(given.log, 'b', 'INTERRUPTED')
        expect(interrupt.spellId).toBe('SPELL_FIREBALL')
        // held from tick 0; the first Fireball seen from tick 100 on is planned, and lands one reaction (8 ticks) later
        expect(interrupt.tick).toBeGreaterThanOrEqual(100 + 8)
        expect(interrupt.tick).toBeLessThanOrEqual(100 + 26 + 8)
    })

    it('every shipped archetype has every give-up timer it needs', () => {
        for (const name of ARCHETYPE_NAMES) {
            const { profile } = ARCHETYPES[name]
            expect(profile.patience.thresholdGiveUpSeconds, name).toBeGreaterThan(0)
            expect(profile.counterspell.giveUpSeconds, name).toBeGreaterThan(0)
        }
    })
})

describe('rotations built from the loadout (#136)', () => {
    it('a loadout without the spells a profile prefers still gets a working rotation', () => {
        // aggressive prefers Ignite, Combustion and Meteor: without Ignite, Combustion's entry is dropped too
        const loadout: SpellId[] = [
            'SPELL_COMBUSTION',
            'SPELL_AFTERBURN',
            'SPELL_LIVING_BOMB',
            'SPELL_FIREBALL',
            'SPELL_COUNTERSPELL',
            'SPELL_HASTE',
            'SPELL_BLUR',
        ]
        const built = adaptProfile(ARCHETYPES.aggressive.profile, loadout)
        expect(built.rotation.map(e => e.spell)).toEqual(['SPELL_LIVING_BOMB', 'SPELL_AFTERBURN', 'SPELL_FIREBALL'])
        const result = runMatch({
            seed: 1,
            a: profileEntrant(ARCHETYPES.aggressive.profile, loadout),
            b: idler(),
            maxTicks: secondsToTicks(20),
        })
        const cast = new Set(of(result.log, 'a', 'SPELL_RELEASE').map(e => e.spellId))
        for (const id of ['SPELL_LIVING_BOMB', 'SPELL_AFTERBURN', 'SPELL_FIREBALL'] as const)
            expect(cast.has(id), id).toBe(true)
        expect(result.stats.a.rejected).toBe(0)
    })

    it('a profile with none of the loadout spells plays the loadout Fire spells', () => {
        const meteorOnly = custom(raw => (raw.rotation = ['SPELL_METEOR']))
        const loadout = METEOR_LOADOUT.map(id => (id === 'SPELL_METEOR' ? 'SPELL_LIVING_BOMB' : id))
        const result = runMatch({ seed: 1, a: profileEntrant(meteorOnly, loadout), b: idler(), maxTicks: 200 })
        expect(of(result.log, 'a', 'SPELL_RELEASE').filter(e => isFire(e.spellId)).length).toBeGreaterThan(0)
    })
})

/** Counterspells with METEOR_LOADOUT on each of `ticks`, nothing else. */
const counterAt = (...ticks: number[]) => {
    const slot = slotOf(METEOR_LOADOUT, 'SPELL_COUNTERSPELL')
    return entrant('counter', scripted(Object.fromEntries(ticks.map(t => [t, start(slot)]))))
}

describe('review fixes (#136)', () => {
    it('counts only releases the engine made: a Fireball interrupted on the tick it completes is no Fireball', () => {
        // Afterburn only after a Fireball: an interrupted one must not count
        const afterFireball = custom(raw => {
            raw.rotation = [
                {
                    spell: 'SPELL_AFTERBURN',
                    when: [{ type: 'selfCastsAtLeast', spell: 'SPELL_FIREBALL', count: 1, withinSeconds: 10 }],
                },
                'SPELL_FIREBALL',
            ]
        })
        // the enemy is player1 and acts first: its Counterspell on tick 26 interrupts the Fireball due to release on 26
        const result = runMatch({
            seed: 1,
            a: counterAt(26),
            b: profileEntrant(afterFireball, OTHER_LOADOUT),
            maxTicks: 120,
        })
        expect(of(result.log, 'b', 'INTERRUPTED')).toMatchObject([{ tick: 26, spellId: 'SPELL_FIREBALL' }])
        expect(of(result.log, 'b', 'SPELL_RELEASE').filter(e => e.tick <= 86)).toEqual([])
        // after the lock (until tick 86) it casts a Fireball, not an Afterburn on a Fireball that never went off
        expect(
            of(result.log, 'b', 'START_CAST')
                .slice(0, 2)
                .map(e => [e.tick, e.spellId]),
        ).toEqual([
            [0, 'SPELL_FIREBALL'],
            [86, 'SPELL_FIREBALL'],
        ])
    })

    it('keeps a release when the cast started after it on the same tick is the one interrupted', () => {
        // as player1 it releases a Fireball on tick 26 and starts an Afterburn at once; the enemy, acting second, counters
        // the Afterburn on that tick. The Fireball went off, so after the lock it is an Afterburn again
        const afterFireball = custom(raw => {
            raw.rotation = [
                {
                    spell: 'SPELL_AFTERBURN',
                    when: [{ type: 'selfCastsAtLeast', spell: 'SPELL_FIREBALL', count: 1, withinSeconds: 10 }],
                },
                'SPELL_FIREBALL',
            ]
        })
        const result = runMatch({
            seed: 1,
            a: profileEntrant(afterFireball, OTHER_LOADOUT),
            b: counterAt(26),
            maxTicks: 120,
        })
        expect(of(result.log, 'a', 'SPELL_RELEASE')[0]).toMatchObject({ tick: 26, spellId: 'SPELL_FIREBALL' })
        expect(of(result.log, 'a', 'INTERRUPTED')).toMatchObject([{ tick: 26, spellId: 'SPELL_AFTERBURN' }])
        expect(
            of(result.log, 'a', 'START_CAST')
                .slice(0, 3)
                .map(e => [e.tick, e.spellId]),
        ).toEqual([
            [0, 'SPELL_FIREBALL'],
            [26, 'SPELL_AFTERBURN'],
            [86, 'SPELL_AFTERBURN'],
        ])
    })

    it('does not count time under a Counterspell lock toward a give-up timer', () => {
        // holds Counterspell for Meteor, giving up after 5 s (100 ticks) held; casts Fireballs meanwhile
        const holder = custom(raw => {
            raw.rotation = ['SPELL_FIREBALL']
            Object.assign(raw.counterspell, { enabled: true, giveUpSeconds: 5 })
        })
        // the enemy counters its first Fireball on tick 10 (locked until 70), then casts Fireballs on 105 and 165
        const FIREBALL = slotOf(METEOR_LOADOUT, 'SPELL_FIREBALL')
        const COUNTER = slotOf(METEOR_LOADOUT, 'SPELL_COUNTERSPELL')
        const enemy = entrant(
            'enemy',
            scripted({
                10: start(COUNTER),
                105: start(FIREBALL),
                131: stop(FIREBALL),
                165: start(FIREBALL),
                191: stop(FIREBALL),
            }),
        )
        const result = runMatch({ seed: 1, a: profileEntrant(holder, METEOR_LOADOUT), b: enemy, maxTicks: 240 })
        expect(of(result.log, 'a', 'INTERRUPTED').map(e => e.tick)).toEqual([10])
        // held from tick 0, but the 59 locked ticks don't count: it gives up on tick 159, so the Fireball started on
        // 105 is let through and the one started on 165 (seen on 166) is interrupted one reaction (8 ticks) later
        expect(of(result.log, 'b', 'INTERRUPTED').map(e => [e.tick, e.spellId])).toEqual([[174, 'SPELL_FIREBALL']])
    })

    it('builds a new rotation when every entry is dropped, even if the fallback has as many entries', () => {
        const ignite = { type: 'enemyEffectsAtLeast', effect: 'DEBUFF_IGNITE', count: 1 }
        const needsIgnites = custom(raw => {
            raw.rotation = ['SPELL_FIREBALL', 'SPELL_COMBUSTION', 'SPELL_LIVING_BOMB', 'SPELL_AFTERBURN'].map(
                spell => ({
                    spell,
                    when: [ignite],
                }),
            )
            raw.lockoutWindow = { rotation: ['SPELL_FIREBALL'] }
        })
        const loadout: SpellId[] = [
            'SPELL_FIREBALL',
            'SPELL_COMBUSTION',
            'SPELL_LIVING_BOMB',
            'SPELL_AFTERBURN',
            'SPELL_COUNTERSPELL',
            'SPELL_HASTE',
            'SPELL_BLUR',
        ]
        const built = adaptProfile(needsIgnites, loadout)
        expect(built.rotation).toEqual(loadout.slice(0, 4).map(spell => ({ spell, when: [] })))
        expect(built.lockoutWindow.rotation.map(e => e.spell)).toEqual(['SPELL_FIREBALL'])
    })

    it('drops an entry whose anyOf can only hold with a missing spell, and keeps one with a branch that can', () => {
        const combustion = (of: unknown[][]) =>
            custom(raw => {
                raw.rotation = [{ spell: 'SPELL_COMBUSTION', when: [{ type: 'anyOf', of }] }, 'SPELL_FIREBALL']
            })
        const loadout = METEOR_LOADOUT.map(id => (id === 'SPELL_IGNITE' ? 'SPELL_LIVING_BOMB' : id))
        const ignites = [{ type: 'enemyEffectsAtLeast', effect: 'DEBUFF_IGNITE', count: 1 }]
        expect(adaptProfile(combustion([ignites]), loadout).rotation.map(e => e.spell)).toEqual(['SPELL_FIREBALL'])
        // one branch can hold (a Living Bomb on the enemy): the entry stays
        const bomb = [{ type: 'enemyEffectsAtLeast', effect: 'DEBUFF_LIVING_BOMB', count: 1 }]
        expect(adaptProfile(combustion([ignites, bomb]), loadout).rotation.map(e => e.spell)).toEqual([
            'SPELL_COMBUSTION',
            'SPELL_FIREBALL',
        ])
    })

    it('keeps profile names short (200 characters) while an intent may hold a plan of 1200 (Fire and Frost, #150)', () => {
        expect(() => custom(raw => (raw.name = 'n'.repeat(200)))).not.toThrow()
        expect(() => custom(raw => (raw.name = 'n'.repeat(201)))).toThrow(/^name: must be one line of at most 200/)
        expect(() => custom(raw => (raw.intent = 'i'.repeat(1200)))).not.toThrow()
        expect(() => custom(raw => (raw.intent = 'i'.repeat(1201)))).toThrow(
            /^intent: must be one line of at most 1200/,
        )
    })

    describe('drops an entry waiting on a spell the loadout lacks, for every condition that names an effect or spell', () => {
        // no Living Bomb, Haste, Temporal Shield or Afterburn: Fireball, Ignite, Combustion, Meteor, Blur, Magic Eater
        const loadout: SpellId[] = [
            'SPELL_FIREBALL',
            'SPELL_IGNITE',
            'SPELL_COMBUSTION',
            'SPELL_METEOR',
            'SPELL_COUNTERSPELL',
            'SPELL_BLUR',
            'SPELL_MAGIC_EATER',
        ]
        const built = (when: unknown[]) =>
            adaptProfile(
                custom(raw => {
                    raw.rotation = [{ spell: 'SPELL_COMBUSTION', when }, 'SPELL_FIREBALL']
                }),
                loadout,
            ).rotation.map(e => e.spell)
        const DROPPED = ['SPELL_FIREBALL']
        const KEPT = ['SPELL_COMBUSTION', 'SPELL_FIREBALL']
        const cases: [string, unknown, string[]][] = [
            // a debuff only our spell puts on the enemy
            [
                'enemyEffectsAtLeast, a missing debuff',
                { type: 'enemyEffectsAtLeast', effect: 'DEBUFF_LIVING_BOMB', count: 1 },
                DROPPED,
            ],
            [
                'enemyEffectsAtLeast, a held debuff',
                { type: 'enemyEffectsAtLeast', effect: 'DEBUFF_IGNITE', count: 1 },
                KEPT,
            ],
            [
                'enemyEffectsAtLeast, count 0',
                { type: 'enemyEffectsAtLeast', effect: 'DEBUFF_LIVING_BOMB', count: 0 },
                KEPT,
            ],
            // a buff on the enemy is the enemy's own
            [
                'enemyEffectsAtLeast, an enemy buff',
                { type: 'enemyEffectsAtLeast', effect: 'BUFF_HASTE', count: 1 },
                KEPT,
            ],
            [
                'enemyEffectEndsWithin, a missing debuff',
                { type: 'enemyEffectEndsWithin', effect: 'DEBUFF_LIVING_BOMB', seconds: 1 },
                DROPPED,
            ],
            [
                'enemyEffectEndsWithin, a held debuff',
                { type: 'enemyEffectEndsWithin', effect: 'DEBUFF_IGNITE', seconds: 1 },
                KEPT,
            ],
            // a buff only our spell puts on ourselves
            [
                'selfEffectsAtLeast, a missing buff',
                { type: 'selfEffectsAtLeast', effect: 'BUFF_HASTE', count: 1 },
                DROPPED,
            ],
            ['selfEffectsAtLeast, a held buff', { type: 'selfEffectsAtLeast', effect: 'BUFF_BLUR', count: 1 }, KEPT],
            // a debuff on ourselves comes from the enemy
            [
                'selfEffectsAtLeast, an enemy debuff',
                { type: 'selfEffectsAtLeast', effect: 'DEBUFF_LIVING_BOMB', count: 1 },
                KEPT,
            ],
            [
                'selfEffectEndsWithin, a missing buff',
                { type: 'selfEffectEndsWithin', effect: 'BUFF_TEMPORAL_SHIELD', seconds: 1 },
                DROPPED,
            ],
            [
                'selfEffectEndsWithin, a held buff',
                { type: 'selfEffectEndsWithin', effect: 'BUFF_MAGIC_EATER', seconds: 1 },
                KEPT,
            ],
            [
                'selfCastsAtLeast, a missing spell',
                { type: 'selfCastsAtLeast', spell: 'SPELL_AFTERBURN', count: 1, withinSeconds: 5 },
                DROPPED,
            ],
            [
                'selfCastsAtLeast, a held spell',
                { type: 'selfCastsAtLeast', spell: 'SPELL_IGNITE', count: 1, withinSeconds: 5 },
                KEPT,
            ],
            [
                'nextCastIs, no held spell',
                { type: 'nextCastIs', spells: ['SPELL_LIVING_BOMB', 'SPELL_AFTERBURN'] },
                DROPPED,
            ],
            ['nextCastIs, a held spell', { type: 'nextCastIs', spells: ['SPELL_LIVING_BOMB', 'SPELL_METEOR'] }, KEPT],
            ['enemyLocked, Counterspell held', { type: 'enemyLocked' }, KEPT],
            // nested: an anyOf whose every list waits on a missing spell, and one with a list that can hold
            [
                'anyOf, every list impossible',
                {
                    type: 'anyOf',
                    of: [
                        [{ type: 'enemyEffectEndsWithin', effect: 'DEBUFF_LIVING_BOMB', seconds: 1 }],
                        [{ type: 'selfEffectsAtLeast', effect: 'BUFF_HASTE', count: 1 }, { type: 'selfNotCasting' }],
                    ],
                },
                DROPPED,
            ],
            [
                'anyOf, one list possible',
                {
                    type: 'anyOf',
                    of: [
                        [{ type: 'enemyEffectEndsWithin', effect: 'DEBUFF_LIVING_BOMB', seconds: 1 }],
                        [{ type: 'enemyEffectsAtLeast', effect: 'DEBUFF_IGNITE', count: 2 }],
                    ],
                },
                KEPT,
            ],
        ]
        for (const [name, condition, expected] of cases) it(name, () => expect(built([condition])).toEqual(expected))

        it('enemyLocked without Counterspell on the loadout: only our Counterspell locks the enemy', () => {
            const noCounter = loadout.map(id => (id === 'SPELL_COUNTERSPELL' ? 'SPELL_HASTE' : id))
            const profile = custom(raw => {
                raw.rotation = [{ spell: 'SPELL_COMBUSTION', when: [{ type: 'enemyLocked' }] }, 'SPELL_FIREBALL']
            })
            expect(adaptProfile(profile, noCounter).rotation.map(e => e.spell)).toEqual(DROPPED)
        })

        it("Codex's case: a lone Fireball waiting on a Living Bomb ending gets the fallback rotation and casts", () => {
            const waiting = custom(raw => {
                raw.rotation = [
                    {
                        spell: 'SPELL_FIREBALL',
                        when: [{ type: 'enemyEffectEndsWithin', effect: 'DEBUFF_LIVING_BOMB', seconds: 1 }],
                    },
                ]
            })
            expect(waiting.patience.thresholdGiveUpSeconds).toBeNull()
            expect(adaptProfile(waiting, loadout).rotation).toEqual(
                loadout.slice(0, 4).map(spell => ({ spell, when: [] })),
            )
            const result = runMatch({ seed: 1, a: profileEntrant(waiting, loadout), b: idler(), maxTicks: 3600 })
            expect(of(result.log, 'a', 'START_CAST').length).toBeGreaterThan(0)
        })
    })
})
