import { secondsToTicks, SPELLS, type SpellId } from '@magus/engine'
import { describe, expect, it } from 'vitest'
import {
    ARCHETYPES,
    conditionHolds,
    countAfterRelease,
    loadProfile,
    parameterSlots,
    parseProfile,
    profileEntrant,
    ProfileError,
    runMatch,
    spellValues,
    start,
    stop,
    formatLog,
    idle,
    profileController,
    Rng,
    type Action,
    type ArenaView,
    type EffectView,
    type MatchEvent,
} from '../src'
import { entrant, idler, recording, scripted, slotOf } from './helpers'
import { actionsOf, quietProfile } from './profile-helpers'

// #143: the weak patient-counter (no Temporal Shield) and aggressive's Temporal Shield setups, on the mirror loadouts
// of the strategy tournament (#137): the best Fire set of the dummy baseline, Counterspell and a general pair

const FIRE_SET: SpellId[] = ['SPELL_FIREBALL', 'SPELL_AFTERBURN', 'SPELL_LIVING_BOMB', 'SPELL_METEOR']
const mirror = (...pair: SpellId[]): SpellId[] => [...FIRE_SET, 'SPELL_COUNTERSPELL', ...pair]
const HASTE_BLUR = mirror('SPELL_HASTE', 'SPELL_BLUR')
const HASTE_SHIELD = mirror('SPELL_HASTE', 'SPELL_TEMPORAL_SHIELD')

const ticksOf = (id: SpellId) => secondsToTicks(SPELLS[id].castSeconds ?? SPELLS[id].cooldownSeconds ?? 0)
const LIVING_BOMB = ticksOf('SPELL_LIVING_BOMB')
const COUNTER_COOLDOWN = secondsToTicks(SPELLS.SPELL_COUNTERSPELL.cooldownSeconds ?? 0)
/** The Counterspell lock, in ticks: 3 s (AGENTS.md invariant 3). */
const LOCK = secondsToTicks(3)

const events = (log: readonly MatchEvent[], side: 'a' | 'b', type: MatchEvent['type'], spell?: SpellId) =>
    log.filter(e => e.side === side && e.type === type && (!spell || e.spellId === spell))

describe('a cast released this tick counts in its effect conditions (#143)', () => {
    it('a profile that keeps one Living Bomb up does not cast a second one on the tick the first is released', () => {
        // the view is built before the tick's actions, so on the release tick the enemy shows no Living Bomb yet:
        // before #143 the profile started another one at once, replacing its own and pushing its explosion back
        const keeper = loadProfile(
            {
                ...quietProfile(),
                rotation: [
                    {
                        spell: 'SPELL_LIVING_BOMB',
                        when: [{ type: 'enemyEffectsBelow', effect: 'DEBUFF_LIVING_BOMB', count: 1 }],
                    },
                    'SPELL_FIREBALL',
                ],
            },
            HASTE_BLUR,
        )
        const result = runMatch({
            seed: 1,
            a: profileEntrant(keeper, HASTE_BLUR),
            b: idler(HASTE_BLUR),
            maxTicks: secondsToTicks(10),
        })
        // one Living Bomb in 10 s (it lasts 11 s), then Fireballs from its release on
        expect(events(result.log, 'a', 'START_CAST', 'SPELL_LIVING_BOMB').map(e => e.tick)).toEqual([0])
        expect(events(result.log, 'a', 'START_CAST', 'SPELL_FIREBALL')[0]?.tick).toBe(LIVING_BOMB)
    })

    it('the shipped aggressive casts one Living Bomb, then Meteor, not a second Living Bomb', () => {
        const result = runMatch({
            seed: 1,
            a: profileEntrant(ARCHETYPES.aggressive.profile, HASTE_BLUR),
            b: idler(HASTE_BLUR),
            maxTicks: secondsToTicks(10),
        })
        const starts = events(result.log, 'a', 'START_CAST').map(e => [e.tick, e.spellId])
        expect(starts.slice(0, 2)).toEqual([
            [0, 'SPELL_LIVING_BOMB'],
            [LIVING_BOMB, 'SPELL_METEOR'],
        ])
    })

    it('counts the effect of the cast released this tick: one more Ignite, Living Bomb at most one', () => {
        expect(countAfterRelease(2, 'DEBUFF_IGNITE', 'enemy', 'SPELL_IGNITE')).toBe(3)
        expect(countAfterRelease(0, 'DEBUFF_LIVING_BOMB', 'enemy', 'SPELL_LIVING_BOMB')).toBe(1)
        expect(countAfterRelease(1, 'DEBUFF_LIVING_BOMB', 'enemy', 'SPELL_LIVING_BOMB')).toBe(1)
        // our debuffs land on the enemy, not on us; another spell's release adds nothing
        expect(countAfterRelease(2, 'DEBUFF_IGNITE', 'self', 'SPELL_IGNITE')).toBe(2)
        expect(countAfterRelease(2, 'DEBUFF_IGNITE', 'enemy', 'SPELL_FIREBALL')).toBe(2)
        expect(countAfterRelease(2, 'DEBUFF_IGNITE', 'enemy', null)).toBe(2)

        const view = {
            tick: 10,
            self: { hp: 100, casting: null, gcdUntil: 0, lockedUntil: 0, effects: [], spells: [], log: [] },
            enemy: { hp: 100, casting: null, lockedUntil: 0, effects: [], log: [] },
        } as ArenaView
        const at4 = { type: 'enemyEffectsAtLeast', effect: 'DEBUFF_IGNITE', count: 1 } as const
        expect(conditionHolds(at4, { view, casting: false, nextCast: null })).toBe(false)
        expect(conditionHolds(at4, { view, casting: false, nextCast: null, released: 'SPELL_IGNITE' })).toBe(true)
    })
})

describe('patient-counter waits for a commit only while its Counterspell is ready (#143)', () => {
    const { profile } = ARCHETYPES['patient-counter']
    const meteor = slotOf(HASTE_BLUR, 'SPELL_METEOR')
    /** Starts one Meteor, worth a patient-counter Counterspell before it is ever seen land, on tick 0, then idles. */
    const bomber = () => entrant('bomber', scripted({ 0: start(meteor) }), HASTE_BLUR)
    const play = (maxTicks: number) =>
        runMatch({ seed: 1, a: profileEntrant(profile, HASTE_BLUR), b: bomber(), maxTicks })

    it('after the window its Counterspell opened, it casts at once and deals damage', () => {
        expect(profile.patience.commitGiveUpSeconds).toBe(3)
        const result = play(secondsToTicks(12))
        const [interrupt] = events(result.log, 'b', 'INTERRUPTED')
        expect(interrupt?.spellId).toBe('SPELL_METEOR')
        const windowEnd = interrupt.tick + LOCK
        // its Counterspell is on cooldown: there is nothing to wait for. Before #143 it waited 3 s more, idle
        const after = events(result.log, 'a', 'START_CAST').filter(e => e.tick >= windowEnd)
        expect(after[0]?.tick).toBe(windowEnd)
        const released = events(result.log, 'a', 'SPELL_RELEASE').filter(e => e.tick > windowEnd)
        expect(released.length).toBeGreaterThan(0)
        expect(result.hp.b).toBeLessThan(100)
    })

    it('when its Counterspell is ready again, it waits up to commitGiveUpSeconds for a commit, then acts', () => {
        // patient-counter's waits and Counterspell on Fireballs only, so the enemy lives past the Counterspell cooldown
        const fireballs = parseProfile({
            ...profile,
            rotation: ['SPELL_FIREBALL'],
            lockoutWindow: { rotation: ['SPELL_FIREBALL'] },
            generals: { ...profile.generals, SPELL_HASTE: 'never' },
        })
        const result = runMatch({
            seed: 1,
            a: profileEntrant(fireballs, HASTE_BLUR),
            b: bomber(),
            maxTicks: secondsToTicks(30),
        })
        const [counter] = events(result.log, 'a', 'SPELL_RELEASE', 'SPELL_COUNTERSPELL')
        const ready = counter.tick + COUNTER_COOLDOWN
        const wait = secondsToTicks(profile.patience.commitGiveUpSeconds ?? 0)
        const starts = events(result.log, 'a', 'START_CAST').map(e => e.tick)
        // busy before the wait, nothing started during it (the enemy never commits), the rotation again after it
        expect(starts.some(tick => tick < ready && tick > counter.tick + LOCK)).toBe(true)
        expect(starts.filter(tick => tick >= ready && tick < ready + wait)).toEqual([])
        expect(starts).toContain(ready + wait)
    })
})

describe('holding a completed cast while the enemy shows a Temporal Shield (#143)', () => {
    const shield = slotOf(HASTE_SHIELD, 'SPELL_TEMPORAL_SHIELD')
    const METEOR_START = LIVING_BOMB
    // aggressive: Living Bomb on 0, then Haste and Meteor on its release: 3.6 s hasted to 1.8 s
    const METEOR_DONE = METEOR_START + secondsToTicks(SPELLS.SPELL_METEOR.castSeconds! / 2)
    const SHIELD_TICKS = secondsToTicks(1.2)

    it('the shipped aggressive releases its Meteor after the enemy shield ends, so the rewind does not undo it', () => {
        // the shield goes up 4 ticks before the Meteor completes, as the archetypes' Temporal Shield rules do
        const shieldAt = METEOR_DONE - 4
        const shielder = entrant('shielder', scripted({ [shieldAt]: start(shield) }), HASTE_SHIELD)
        const result = runMatch({
            seed: 1,
            a: profileEntrant(ARCHETYPES.aggressive.profile, HASTE_SHIELD),
            b: shielder,
            maxTicks: METEOR_DONE + 60,
        })
        expect(events(result.log, 'a', 'START_CAST', 'SPELL_METEOR')[0]?.tick).toBe(METEOR_START)
        // held from completion until the first tick the shield no longer shows; before #143 released on completion
        expect(events(result.log, 'a', 'SPELL_RELEASE', 'SPELL_METEOR')[0]?.tick).toBe(shieldAt + SHIELD_TICKS)
        // the Meteor's 28 damage stays: the rewind restored the HP of the shield's cast before the Meteor landed
        expect(result.hp.b).toBeLessThan(100 - 28)
    })

    it('without a shield on the enemy, the Meteor is released the tick it completes', () => {
        const result = runMatch({
            seed: 1,
            a: profileEntrant(ARCHETYPES.aggressive.profile, HASTE_SHIELD),
            b: idler(HASTE_SHIELD),
            maxTicks: METEOR_DONE + 5,
        })
        expect(events(result.log, 'a', 'SPELL_RELEASE', 'SPELL_METEOR')[0]?.tick).toBe(METEOR_DONE)
    })

    it('gives up holding after releaseHold.giveUpSeconds, whatever its conditions say', () => {
        const fireball = slotOf(HASTE_SHIELD, 'SPELL_FIREBALL')
        const holder = (giveUpSeconds: number) =>
            loadProfile(
                { ...quietProfile(), rotation: ['SPELL_FIREBALL'], releaseHold: { when: [], giveUpSeconds } },
                HASTE_SHIELD,
            )
        const firstRelease = (giveUpSeconds: number) => {
            const result = runMatch({
                seed: 1,
                a: profileEntrant(holder(giveUpSeconds), HASTE_SHIELD),
                b: idler(HASTE_SHIELD),
                maxTicks: 120,
            })
            expect(events(result.log, 'a', 'START_CAST')[0]).toMatchObject({ tick: 0, spellId: 'SPELL_FIREBALL' })
            return events(result.log, 'a', 'SPELL_RELEASE')[0]?.tick
        }
        const fireballTicks = ticksOf(HASTE_SHIELD[fireball])
        expect(firstRelease(0)).toBe(fireballTicks)
        expect(firstRelease(0.5)).toBe(fireballTicks + 10)
    })

    it('parses releaseHold: optional, checked, and tuned only when a profile has it', () => {
        expect('releaseHold' in parseProfile(quietProfile())).toBe(false)
        expect(() => parseProfile({ ...quietProfile(), releaseHold: { when: [] } })).toThrow(
            /releaseHold.giveUpSeconds: is required/,
        )
        expect(() => parseProfile({ ...quietProfile(), releaseHold: { when: [], giveUpSeconds: 4 } })).toThrow(
            ProfileError,
        )
        expect(() =>
            parseProfile({ ...quietProfile(), releaseHold: { when: [], giveUpSeconds: 1, other: 1 } }),
        ).toThrow(ProfileError)
        const paths = (name: 'aggressive' | 'defensive') => parameterSlots(ARCHETYPES[name].profile).map(s => s.path)
        expect(paths('aggressive')).toContain('releaseHold.giveUpSeconds')
        expect(paths('aggressive')).toContain('releaseHold.when[0].count')
        expect(paths('defensive').some(path => path.startsWith('releaseHold'))).toBe(false)
    })
})

describe('Counterspell targets from what the opponent is seen to cast (#143)', () => {
    const slot = (id: SpellId) => slotOf(HASTE_BLUR, id)
    const [FB, AB] = [ticksOf('SPELL_FIREBALL'), ticksOf('SPELL_AFTERBURN')]
    /** Three Fireballs, then Afterburns back to back, as patient-counter plays (the script only, whatever happens). */
    const afterburner = (loadout: SpellId[] = HASTE_BLUR) => {
        const script: Record<number, Action[]> = {}
        const at = (tick: number, ...actions: Action[]) => (script[tick] = [...(script[tick] ?? []), ...actions])
        let tick = 0
        for (let i = 0; i < 3; i++, tick += FB) {
            at(tick, start(slot('SPELL_FIREBALL')))
            at(tick + FB, stop(slot('SPELL_FIREBALL')))
        }
        for (let i = 0; i < 4; i++, tick += AB) {
            at(tick, start(slot('SPELL_AFTERBURN')))
            at(tick + AB, stop(slot('SPELL_AFTERBURN')))
        }
        return entrant('afterburner', scripted(script), loadout)
    }
    const firstAfterburn = 3 * FB
    const play = (b = afterburner()) =>
        runMatch({
            seed: 1,
            a: profileEntrant(ARCHETYPES.aggressive.profile, HASTE_BLUR),
            b,
            maxTicks: 3 * FB + 4 * AB,
        })

    it('aggressive counters Afterburn, missing from its old target list, once it has seen one hit hard', () => {
        const result = play()
        // no Fireball (5.6 HP) is worth a Counterspell, nor the first, unseen Afterburn (1.1 s cast, valued 7.7 HP)
        const released = events(result.log, 'b', 'SPELL_RELEASE').map(e => [e.tick, e.spellId])
        expect(released.slice(0, 4)).toEqual([
            [FB, 'SPELL_FIREBALL'],
            [2 * FB, 'SPELL_FIREBALL'],
            [3 * FB, 'SPELL_FIREBALL'],
            [firstAfterburn + AB, 'SPELL_AFTERBURN'],
        ])
        // that one dealt 12.6 HP, its best seen: the next Afterburn is interrupted
        const [interrupt] = events(result.log, 'b', 'INTERRUPTED')
        expect(interrupt?.spellId).toBe('SPELL_AFTERBURN')
        expect(interrupt.tick).toBeGreaterThan(firstAfterburn + AB)
        expect(interrupt.tick).toBeLessThan(firstAfterburn + 2 * AB)
    })

    it('learns values from the view only: the opponent loadout it never sees changes nothing', () => {
        // the same visible casts from an opponent whose other slots differ: the views are equal, so are the games
        const other: SpellId[] = [...FIRE_SET, 'SPELL_COUNTERSPELL', 'SPELL_MAGIC_EATER', 'SPELL_TEMPORAL_SHIELD']
        expect(formatLog(play(afterburner(other)))).toBe(formatLog(play()))
        // and the tracker reads nothing but views
        const values = spellValues(6)
        expect(values.valueOf('SPELL_METEOR')).toBeCloseTo(3.6 * 6)
        expect(values.best()).toBe(0)
    })

    it('values a hit from the HP lost after the release, and a Living Bomb from its ticks and its explosion', () => {
        const values = spellValues(6)
        const view = (tick: number, hp: number, log: ArenaView['enemy']['log'], effects: EffectView[] = []) =>
            ({
                tick,
                self: { hp, casting: null, gcdUntil: 0, lockedUntil: 0, effects, spells: [], log: [] },
                enemy: { hp: 100, casting: null, lockedUntil: 0, effects: [], log },
            }) as ArenaView
        const log: ArenaView['enemy']['log'][number][] = []
        values.observe(view(0, 100, log))
        log.push({ tick: 0, type: 'START_CAST', spellId: 'SPELL_LIVING_BOMB' })
        values.observe(view(29, 100, log))
        // a Living Bomb released on 30, ticking 1 HP per tick until 33, exploding for 20 on 33
        values.observe(view(30, 100, log))
        // the log shows a release from the next tick on, like the buff bar
        log.push({ tick: 30, type: 'SPELL_RELEASE', spellId: 'SPELL_LIVING_BOMB' })
        const bomb: EffectView = { id: 'DEBUFF_LIVING_BOMB', type: 'negative', startingTick: 30, expiresAt: 33 }
        values.observe(view(31, 99, log, [bomb]))
        values.observe(view(32, 98, log, [bomb]))
        values.observe(view(33, 77, log))
        expect(values.valueOf('SPELL_LIVING_BOMB')).toBeCloseTo(23)
        // a Meteor released on 40 hits for 28; it is the best seen once it has been seen cast
        log.push({ tick: 38, type: 'START_CAST', spellId: 'SPELL_METEOR' })
        values.observe(view(40, 77, log))
        log.push({ tick: 40, type: 'SPELL_RELEASE', spellId: 'SPELL_METEOR' })
        values.observe(view(41, 49, log))
        expect(values.valueOf('SPELL_METEOR')).toBeCloseTo(28)
        expect(values.best()).toBeCloseTo(28)
        // an unseen spell keeps its cast-time prior
        expect(values.valueOf('SPELL_FIREBALL')).toBeCloseTo(1.3 * 6)
    })

    it('patient-counter holds out for a target worth its Counterspell, then its give-up timer breaks the wait', () => {
        const { profile } = ARCHETYPES['patient-counter']
        const fireballer = profileEntrant(
            parseProfile({ ...quietProfile(), rotation: ['SPELL_FIREBALL'] }),
            HASTE_BLUR,
            'fireballs',
        )
        const run = (giveUpSeconds: number | null) =>
            runMatch({
                seed: 1,
                a: profileEntrant({ ...profile, counterspell: { ...profile.counterspell, giveUpSeconds } }, HASTE_BLUR),
                b: fireballer,
                maxTicks: secondsToTicks(15),
            })
        // Fireballs (5.6 HP) are below its 10 HP floor: never countered without the timer
        expect(run(null).stats.a.interrupts).toBe(0)
        const [interrupt] = events(run(6).log, 'b', 'INTERRUPTED')
        expect(interrupt?.spellId).toBe('SPELL_FIREBALL')
        expect(interrupt.tick).toBeGreaterThanOrEqual(secondsToTicks(6))
    })
})

describe('#146 review fixes', () => {
    it('a general spell released on the same tick as a hit takes no share of it (Codex P2)', () => {
        // three Fireballs, then Afterburn released together with Haste, through the real engine
        const slot = (id: SpellId) => slotOf(HASTE_BLUR, id)
        const [FB, AB] = [ticksOf('SPELL_FIREBALL'), ticksOf('SPELL_AFTERBURN')]
        const script: Record<number, Action[]> = {}
        const at = (tick: number, ...actions: Action[]) => (script[tick] = [...(script[tick] ?? []), ...actions])
        for (let i = 0; i < 3; i++) {
            at(i * FB, start(slot('SPELL_FIREBALL')))
            at((i + 1) * FB, stop(slot('SPELL_FIREBALL')))
        }
        at(3 * FB, start(slot('SPELL_AFTERBURN')))
        at(3 * FB + AB, stop(slot('SPELL_AFTERBURN')), start(slot('SPELL_HASTE')))
        const seen: ArenaView[] = []
        const result = runMatch({
            seed: 1,
            a: entrant('watcher', recording(idle(), seen), HASTE_BLUR),
            b: entrant('caster', scripted(script), HASTE_BLUR),
            maxTicks: 3 * FB + AB + 5,
        })
        const released = events(result.log, 'b', 'SPELL_RELEASE').map(e => [e.tick, e.spellId])
        expect(released.slice(-2)).toEqual([
            [3 * FB + AB, 'SPELL_AFTERBURN'],
            [3 * FB + AB, 'SPELL_HASTE'],
        ])
        const values = spellValues(6)
        for (const view of seen) values.observe(view)
        // 2.1 + 3.5 x 3 Fireballs, all of it Afterburn's; before the fix Haste took half (6.3 each)
        expect(values.valueOf('SPELL_AFTERBURN')).toBeCloseTo(12.6)
        expect(values.valueOf('SPELL_FIREBALL')).toBeCloseTo(5.6)
        // Haste is an instant with no damage seen: its cast-time prior, 0
        expect(values.valueOf('SPELL_HASTE')).toBe(0)
    })

    it('aggressive does not hold a completed cast when the enemy is too low to survive it', () => {
        const loadout = HASTE_SHIELD
        const meteor = slotOf(loadout, 'SPELL_METEOR')
        const decide = (enemyHp: number) => {
            const controller = profileController(ARCHETYPES.aggressive.profile)({ loadout, rng: new Rng(1) })
            const tick = 100
            const view: ArenaView = {
                tick,
                self: {
                    hp: 100,
                    casting: { slot: meteor, spellId: 'SPELL_METEOR', startTick: 28, castTime: 72, completesAt: 100 },
                    gcdUntil: 0,
                    lockedUntil: 0,
                    effects: [],
                    spells: loadout.map(id => ({
                        id,
                        castTime: ticksOf(id),
                        cooldownRemaining: 0,
                        lockRemaining: 0,
                        ready: true,
                    })),
                    log: [],
                },
                enemy: {
                    hp: enemyHp,
                    casting: null,
                    lockedUntil: 0,
                    effects: [{ id: 'BUFF_TEMPORAL_SHIELD', type: 'positive', startingTick: 96, expiresAt: 120 }],
                    log: [],
                },
            }
            return actionsOf(controller(view)).some(a => a.type === 'stop' && a.slot === meteor)
        }
        // 50 HP: held through the shield; 28 HP: the Meteor (28) kills, and death is final, so release at once
        expect(decide(50)).toBe(false)
        expect(decide(28)).toBe(true)
    })

    it('a profile that still lists Counterspell targets gets a clear error', () => {
        const raw = quietProfile() as ReturnType<typeof quietProfile> & { counterspell: Record<string, unknown> }
        raw.counterspell.targets = ['SPELL_METEOR']
        expect(() => parseProfile(raw)).toThrow(ProfileError)
        expect(() => parseProfile(raw)).toThrow(/counterspell\.targets: was removed in #143 \(PR #146\).*value-based/)
    })
})
