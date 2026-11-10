import { describe, expect, it } from 'vitest'
import baitFile from '../profiles/bait.json'
import {
    ARCHETYPES,
    behaviourKey,
    clampProfile,
    getAt,
    loadArchetype,
    parseProfile,
    PROFILE_PARAMETERS,
    REACTION_MIN_SECONDS,
} from '../src'

// #160: the bait-only tuning run 42665449015 (arena:tune --profile bait, 8 generations; 42.2% -> 51.8% on the
// selection seeds, 52.1% on fresh ones) is adopted as the bait defaults (owner, 2026-11-09). These are its 15 changed
// parameters, from the run report's "Changed parameters", at the paths the tuner names them by.
const ADOPTED: Readonly<Record<string, { readonly from: number; readonly to: number }>> = {
    'counterspell.reaction.meanSeconds': { from: 0.4, to: 0.3 },
    'counterspell.minValue': { from: 12, to: 9.2 },
    'counterspell.unseenValuePerSecond': { from: 6, to: 6.8 },
    'fakeCast.cancelAfterSeconds': { from: 0.25, to: 0.35 },
    'fakeCast.minGapSeconds': { from: 12, to: 13.71 },
    'fakeCast.realBaitShare': { from: 0.5, to: 0.45 },
    'counterspell.giveUpSeconds': { from: 8, to: 7.44 },
    'rotation[0].when[0].count': { from: 2, to: 1 },
    'rotation[3].when[0].withinSeconds': { from: 10, to: 10.67 },
    'lockoutWindow.rotation[2].when[0].count': { from: 2, to: 1 },
    'lockoutWindow.rotation[3].when[0].withinSeconds': { from: 10, to: 10.23 },
    'generals.SPELL_TEMPORAL_SHIELD.when[0].of[0][0].seconds': { from: 0.25, to: 0.28 },
    'generals.SPELL_TEMPORAL_SHIELD.when[0].of[1][0].seconds': { from: 0.5, to: 0.48 },
    'generals.SPELL_TEMPORAL_SHIELD.when[0].of[2][1].count': { from: 3, to: 4 },
    'generals.SPELL_BLUR.when[0].of[0][0].seconds': { from: 0.3, to: 0.28 },
}

describe('bait defaults: the tuned parameters of run 42665449015 (#160)', () => {
    const { profile } = ARCHETYPES.bait

    it('holds all 15 tuned values, at the same places in the profile', () => {
        expect(Object.keys(ADOPTED)).toHaveLength(15)
        for (const [path, { to }] of Object.entries(ADOPTED)) expect(getAt(profile, path), path).toBe(to)
        // the paths still mean what the run tuned: the conditions they sit in are unchanged
        expect(getAt(profile, 'rotation[0]')).toEqual({
            spell: 'SPELL_IGNITE',
            when: [{ type: 'enemyEffectsBelow', effect: 'DEBUFF_IGNITE', count: 1 }],
        })
        expect(getAt(profile, 'rotation[3].when[0]')).toMatchObject({
            type: 'selfCastsAtLeast',
            spell: 'SPELL_FIREBALL',
        })
        expect(getAt(profile, 'lockoutWindow.rotation[2].spell')).toBe('SPELL_IGNITE')
        expect(getAt(profile, 'generals.SPELL_TEMPORAL_SHIELD.when[0].of[2][1]')).toMatchObject({
            type: 'selfEffectsAtLeast',
            effect: 'DEBUFF_IGNITE',
        })
        expect(getAt(profile, 'generals.SPELL_BLUR.when[0].of[0][0].spells')).toEqual(['SPELL_LIVING_BOMB'])
    })

    it('loads and validates, keeps the name bait, and every tunable value is inside the tuner bounds', () => {
        expect(() => loadArchetype('bait', baitFile)).not.toThrow()
        expect(parseProfile(baitFile.profile)).toEqual(profile)
        expect(profile.name).toBe('bait')
        // clamping to the tuner's bounds changes nothing: the defaults are a profile the tuner could have produced
        expect(behaviourKey(clampProfile(profile))).toBe(behaviourKey(profile))
        // the intent says what the profile does now: one Ignite under its long casts, Temporal Shield on 4+ Ignites
        expect(profile.intent).toContain('1 Ignite and a Living Bomb')
        expect(profile.intent).toContain('4+ Ignites')
    })

    it('keeps the 0.25 s reaction minimum (owner rule): the reaction mean, the fake cast and the pause after it', () => {
        expect(REACTION_MIN_SECONDS).toBe(0.25)
        expect(profile.counterspell.reaction.meanSeconds).toBeGreaterThanOrEqual(REACTION_MIN_SECONDS)
        expect(profile.fakeCast.cancelAfterSeconds).toBeGreaterThanOrEqual(REACTION_MIN_SECONDS)
        expect(profile.fakeCast.pauseAfterSeconds).toBeGreaterThanOrEqual(REACTION_MIN_SECONDS)
        for (const path of [
            'counterspell.reaction.meanSeconds',
            'fakeCast.cancelAfterSeconds',
            'fakeCast.pauseAfterSeconds',
        ])
            expect(PROFILE_PARAMETERS[path], path).toMatchObject({ min: REACTION_MIN_SECONDS })
    })
})
