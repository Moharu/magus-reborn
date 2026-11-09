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
import { idler, METEOR_LOADOUT } from './helpers'
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
                Object.assign(raw.counterspell, { enabled: true, targets: ['SPELL_METEOR'], giveUpSeconds })
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
