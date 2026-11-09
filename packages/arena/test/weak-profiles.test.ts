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
    start,
    type ArenaView,
    type MatchEvent,
} from '../src'
import { entrant, idler, scripted, slotOf } from './helpers'
import { quietProfile } from './profile-helpers'

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
    const bomb = slotOf(HASTE_BLUR, 'SPELL_LIVING_BOMB')
    /** Casts one Living Bomb, a patient-counter target, on tick 0, then never acts. */
    const bomber = () => entrant('bomber', scripted({ 0: start(bomb) }), HASTE_BLUR)
    const play = (maxTicks: number) =>
        runMatch({ seed: 1, a: profileEntrant(profile, HASTE_BLUR), b: bomber(), maxTicks })

    it('after the window its Counterspell opened, it casts at once and deals damage', () => {
        expect(profile.patience.commitGiveUpSeconds).toBe(3)
        const result = play(secondsToTicks(12))
        const [interrupt] = events(result.log, 'b', 'INTERRUPTED')
        expect(interrupt?.spellId).toBe('SPELL_LIVING_BOMB')
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
