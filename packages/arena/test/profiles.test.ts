import { secondsToTicks, SPELLS, type SpellId } from '@magus/engine'
import { describe, expect, it } from 'vitest'
import {
    ARCHETYPE_NAMES,
    ARCHETYPES,
    archetypeEntrant,
    deriveSeed,
    formatLog,
    loadProfile,
    parseProfile,
    profileController,
    profileEntrant,
    ProfileError,
    Rng,
    runMatch,
    start,
    stop,
    type ArenaView,
    type ControllerFactory,
    type Decision,
    type Entrant,
    type MatchEvent,
} from '../src'
import { entrant, idler, METEOR_LOADOUT, only, OTHER_LOADOUT, recording, scripted, slotOf } from './helpers'
import { actionsOf, legalFor, quietProfile, type RawProfile } from './profile-helpers'

const METEOR = slotOf(METEOR_LOADOUT, 'SPELL_METEOR')
const meteorCaster = scripted({ 0: start(METEOR), 72: stop(METEOR) })

const profile = (edit: (raw: RawProfile) => void, loadout = METEOR_LOADOUT) => {
    const raw = quietProfile()
    edit(raw)
    return loadProfile(raw, loadout)
}
const player = (name: string, edit: (raw: RawProfile) => void, loadout = METEOR_LOADOUT) =>
    profileEntrant(profile(edit, loadout), loadout, name)

/** An early or late counterer with a fixed reaction (no spread), targeting Meteor. */
const counterer = (timing: 'early' | 'late', reactionSeconds: number, lateWindowSeconds = 0) =>
    player('counter', raw => {
        raw.counterspell = {
            ...raw.counterspell,
            enabled: true,
            timing,
            lateWindowSeconds,
            reaction: { meanSeconds: reactionSeconds, spreadSeconds: 0 },
        }
    })

/** Fake-casts Meteor once (cancel after 0.25 s = 5 ticks, then pause 0.4 s = 8 ticks), then casts real Meteors. */
const baiter = (pauseAfterSeconds = 0.4) =>
    player('baiter', raw => {
        raw.rotation = ['SPELL_METEOR']
        raw.fakeCast = { ...raw.fakeCast, enabled: true, pauseAfterSeconds }
    })

/**
 * A view built by hand, with no battle behind it: full HP for self, every spell ready, and an enemy Meteor in progress
 * (or none) with `ignites` Ignites on the enemy.
 */
const handView = (
    loadout: readonly SpellId[],
    tick: number,
    meteor: { startTick: number; completesAt: number } | null,
    ignites = 0,
): ArenaView => ({
    tick,
    self: {
        hp: 50,
        casting: null,
        gcdUntil: 0,
        lockedUntil: 0,
        effects: [],
        spells: loadout.map(id => ({ id, castTime: 0, cooldownRemaining: 0, lockRemaining: 0, ready: true })),
    },
    enemy: {
        hp: 80,
        lockedUntil: 0,
        casting: meteor && { spellId: 'SPELL_METEOR', castTime: 72, ...meteor },
        effects: Array.from({ length: ignites }, () => ({
            id: 'DEBUFF_IGNITE' as const,
            type: 'negative' as const,
            startingTick: tick - 10,
            expiresAt: tick + 190,
        })),
        log: [],
    },
})

/** The stream the runner gives `side` (1 for a, 2 for b) of a match with `seed`. */
const rngFor = (seed: number, side: 1 | 2) => new Rng(deriveSeed(seed, side))

const of = (log: readonly MatchEvent[], side: 'a' | 'b', type: MatchEvent['type']) =>
    log.filter(e => e.side === side && e.type === type)

/** Wraps a factory and checks every action against the view it was decided on. */
const checked =
    (inner: ControllerFactory, illegal: string[]): ControllerFactory =>
    init => {
        const decide = inner(init)
        return view => {
            const decision = decide(view)
            for (const action of actionsOf(decision)) {
                if (!legalFor(view, action)) illegal.push(`${view.tick} ${action.type} ${action.slot}`)
            }
            return decision
        }
    }

describe('profile loader', () => {
    it('loads every checked-in archetype against its loadout, each with a one-line intent', () => {
        expect(ARCHETYPE_NAMES).toEqual(['aggressive', 'patient-counter', 'bait', 'defensive'])
        for (const name of ARCHETYPE_NAMES) {
            const { profile: loaded, loadout } = ARCHETYPES[name]
            expect(loaded.name).toBe(name)
            expect(loaded.intent).toMatch(/^[^\n]{10,200}$/)
            expect(() => loadProfile(JSON.parse(JSON.stringify(loaded)), loadout)).not.toThrow()
        }
    })

    it('returns a plain JSON object that round-trips, with bare rotation ids in { spell, when } form', () => {
        const raw = quietProfile()
        raw.rotation = ['SPELL_METEOR', { spell: 'SPELL_FIREBALL' }]
        const loaded = loadProfile(raw, METEOR_LOADOUT)
        expect(loaded.rotation).toEqual([
            { spell: 'SPELL_METEOR', when: [] },
            { spell: 'SPELL_FIREBALL', when: [] },
        ])
        expect(JSON.parse(JSON.stringify(loaded))).toEqual(loaded)
        expect(parseProfile(JSON.parse(JSON.stringify(loaded)))).toEqual(loaded)
    })

    const rejects = (
        edit: (raw: Record<string, unknown> & RawProfile) => void,
        key: string,
        loadout = METEOR_LOADOUT,
    ) => {
        const raw = quietProfile() as Record<string, unknown> & RawProfile
        edit(raw)
        let error: unknown
        try {
            loadProfile(raw, loadout)
        } catch (e) {
            error = e
        }
        expect(error, `expected ${key} to be rejected`).toBeInstanceOf(ProfileError)
        expect((error as ProfileError).key).toBe(key)
        expect((error as Error).message.startsWith(`${key}: `)).toBe(true)
    }

    it('defaults the free-cast window to a copy of the rotation and real baits to none', () => {
        const raw = quietProfile()
        raw.rotation = ['SPELL_METEOR', { spell: 'SPELL_FIREBALL', when: [{ type: 'enemyHpBelow', hp: 50 }] }]
        const loaded = loadProfile(raw, METEOR_LOADOUT)
        expect(loaded.lockoutWindow).toEqual({ rotation: loaded.rotation, edgeGreedSeconds: 0 })
        expect(loaded.lockoutWindow.rotation).not.toBe(loaded.rotation)
        expect(loaded.fakeCast.realBaitShare).toBe(0)
        const withWindow = { ...raw, lockoutWindow: { rotation: ['SPELL_FIREBALL'] } }
        withWindow.fakeCast = { ...raw.fakeCast, realBaitShare: 0.3 } as typeof raw.fakeCast
        const explicit = loadProfile(withWindow, METEOR_LOADOUT)
        expect(explicit.lockoutWindow).toEqual({
            rotation: [{ spell: 'SPELL_FIREBALL', when: [] }],
            edgeGreedSeconds: 0,
        })
        expect(explicit.fakeCast.realBaitShare).toBe(0.3)
        expect(parseProfile(JSON.parse(JSON.stringify(explicit)))).toEqual(explicit)
    })

    it('reads lockoutWindow.edgeGreedSeconds (#126): default 0, bounded to [0, 1.5] s', () => {
        const window = (extra: Record<string, unknown>) => ({
            ...quietProfile(),
            lockoutWindow: { rotation: ['SPELL_FIREBALL'], ...extra },
        })
        expect(loadProfile(window({}), METEOR_LOADOUT).lockoutWindow.edgeGreedSeconds).toBe(0)
        expect(loadProfile(window({ edgeGreedSeconds: 1.5 }), METEOR_LOADOUT).lockoutWindow.edgeGreedSeconds).toBe(1.5)
        const greedy = loadProfile(window({ edgeGreedSeconds: 0.4 }), METEOR_LOADOUT)
        expect(parseProfile(JSON.parse(JSON.stringify(greedy)))).toEqual(greedy)
        for (const edgeGreedSeconds of [-0.05, 1.51, '1', null])
            rejects(
                raw => (raw.lockoutWindow = { rotation: ['SPELL_FIREBALL'], edgeGreedSeconds }),
                'lockoutWindow.edgeGreedSeconds',
            )
    })

    it('rejects unknown keys, naming the key', () => {
        rejects(raw => (raw.speed = 1), 'speed')
        rejects(raw => Object.assign(raw.counterspell, { kick: true }), 'counterspell.kick')
        rejects(
            raw => Object.assign(raw.counterspell.reaction, { medianSeconds: 1 }),
            'counterspell.reaction.medianSeconds',
        )
        rejects(raw => Object.assign(raw.fakeCast, { epsilon: 0.1 }), 'fakeCast.epsilon')
        rejects(raw => (raw.generals.SPELL_FROSTBOLT = 'never'), 'generals.SPELL_FROSTBOLT')
        rejects(raw => (raw.generals.SPELL_BLUR = { when: [], often: true }), 'generals.SPELL_BLUR.often')
        rejects(raw => (raw.rotation = [{ spell: 'SPELL_METEOR', if: [] }]), 'rotation[0].if')
        rejects(raw => (raw.fakeCast.when = [{ type: 'selfHpBelow', hp: 50, below: 1 }]), 'fakeCast.when[0].below')
        rejects(raw => (raw.fakeCast.when = [{ type: 'enemyCooldownReady' }]), 'fakeCast.when[0].type')
        rejects(raw => (raw.lockoutWindow = { rotation: ['SPELL_FIREBALL'], greedy: true }), 'lockoutWindow.greedy')
    })

    it('rejects out-of-range and malformed values, naming the key', () => {
        rejects(raw => (raw.counterspell.reaction.meanSeconds = 11), 'counterspell.reaction.meanSeconds')
        rejects(raw => (raw.counterspell.reaction.spreadSeconds = -0.1), 'counterspell.reaction.spreadSeconds')
        // a spread wider than the mean would need a floor at 0, which skews the mean
        rejects(raw => (raw.counterspell.reaction.spreadSeconds = 0.5), 'counterspell.reaction.spreadSeconds')
        rejects(raw => (raw.counterspell.lateWindowSeconds = Number.NaN), 'counterspell.lateWindowSeconds')
        rejects(raw => ((raw.counterspell as { timing: string }).timing = 'whenever'), 'counterspell.timing')
        rejects(raw => (raw.counterspell.targets = ['SPELL_HASTE']), 'counterspell.targets[0]')
        rejects(raw => (raw.fakeCast.cancelAfterSeconds = 0.01), 'fakeCast.cancelAfterSeconds')
        rejects(raw => (raw.fakeCast.maxPerMatch = 1.5), 'fakeCast.maxPerMatch')
        rejects(raw => ((raw.fakeCast as { enabled: unknown }).enabled = 'yes'), 'fakeCast.enabled')
        rejects(raw => (raw.fakeCast.spell = 'SPELL_COUNTERSPELL'), 'fakeCast.spell')
        rejects(raw => (raw.generals.SPELL_HASTE = 'always'), 'generals.SPELL_HASTE')
        rejects(raw => delete raw.generals.SPELL_MAGIC_EATER, 'generals.SPELL_MAGIC_EATER')
        rejects(raw => delete (raw.fakeCast as Partial<RawProfile['fakeCast']>).minGapSeconds, 'fakeCast.minGapSeconds')
        rejects(
            raw => (raw.rotation = [{ spell: 'SPELL_METEOR', when: [{ type: 'selfHpBelow', hp: 101 }] }]),
            'rotation[0].when[0].hp',
        )
        rejects(
            raw =>
                (raw.rotation = [
                    {
                        spell: 'SPELL_METEOR',
                        when: [{ type: 'enemyEffectsAtLeast', effect: 'DEBUFF_IGNITE', count: -1 }],
                    },
                ]),
            'rotation[0].when[0].count',
        )
        rejects(raw => (raw.rotation = []), 'rotation')
        rejects(raw => (raw.rotation = ['SPELL_METEOR', 'SPELL_METEOR']), 'rotation[1]')
        rejects(raw => (raw.rotation = ['SPELL_COUNTERSPELL']), 'rotation[0]')
        rejects(raw => (raw.rotation = ['SPELL_HASTE']), 'rotation[0]')
        rejects(raw => (raw.name = ''), 'name')
        rejects(raw => (raw.lockoutWindow = { rotation: [] }), 'lockoutWindow.rotation')
        rejects(raw => (raw.lockoutWindow = {}), 'lockoutWindow.rotation')
        rejects(raw => (raw.lockoutWindow = { rotation: ['SPELL_COUNTERSPELL'] }), 'lockoutWindow.rotation[0]')
        rejects(
            raw => (raw.lockoutWindow = { rotation: ['SPELL_FIREBALL', 'SPELL_FIREBALL'] }),
            'lockoutWindow.rotation[1]',
        )
        rejects(raw => Object.assign(raw.fakeCast, { realBaitShare: 1.5 }), 'fakeCast.realBaitShare')
        rejects(raw => Object.assign(raw.fakeCast, { realBaitShare: -0.1 }), 'fakeCast.realBaitShare')
    })

    it('rejects, at load time, a rotation spell that is not on the loadout instead of skipping it', () => {
        expect(OTHER_LOADOUT).not.toContain('SPELL_METEOR')
        const raw = quietProfile()
        raw.rotation = ['SPELL_FIREBALL', 'SPELL_METEOR']
        expect(() => loadProfile(raw, METEOR_LOADOUT)).not.toThrow()
        expect(() => loadProfile(raw, OTHER_LOADOUT)).toThrow(/^rotation\[1\]: SPELL_METEOR is not on the loadout/)
        const windowRaw = { ...quietProfile(), lockoutWindow: { rotation: ['SPELL_FIREBALL', 'SPELL_METEOR'] } }
        expect(() => loadProfile(windowRaw, OTHER_LOADOUT)).toThrow(
            /^lockoutWindow\.rotation\[1\]: SPELL_METEOR is not on the loadout/,
        )
        // shape-only parsing passes, but every way of playing it checks the loadout before the first tick
        const parsed = parseProfile(raw)
        expect(() => profileEntrant(parsed, OTHER_LOADOUT)).toThrow(/rotation\[1\]/)
        const factory = profileController(parsed)
        expect(() => factory({ loadout: OTHER_LOADOUT, rng: new Rng(1) })).toThrow(/rotation\[1\]/)
        expect(() =>
            runMatch({ seed: 1, a: entrant('x', profileController(parsed), OTHER_LOADOUT), b: idler(), maxTicks: 1 }),
        ).toThrow(/rotation\[1\]/)
    })

    it('rejects an enabled fake cast of a spell not on the loadout, and ignores general rules for spells it lacks', () => {
        rejects(raw => (raw.fakeCast.enabled = true), 'fakeCast.spell', OTHER_LOADOUT)
        // METEOR_LOADOUT has no Temporal Shield or Magic Eater: their rules are simply unused
        expect(() =>
            profile(raw => {
                raw.generals.SPELL_TEMPORAL_SHIELD = { when: [] }
                raw.generals.SPELL_MAGIC_EATER = { when: [] }
            }),
        ).not.toThrow()
    })
})

describe('profile controller: Counterspell policy', () => {
    for (const side of ['a', 'b'] as const) {
        const enemy = side === 'a' ? 'b' : 'a'
        const play = (counter: Entrant, maxTicks = 100) =>
            runMatch({
                seed: 1,
                [side]: counter,
                [enemy]: entrant('meteor', meteorCaster),
                maxTicks,
            } as unknown as Parameters<typeof runMatch>[0])

        it(`early (as ${side}): decides on the first tick the cast is visible and lands one reaction later`, () => {
            // the Meteor starts on tick 0 and is first visible on tick 1; 0.5 s = 10 ticks later is tick 11
            const result = play(counterer('early', 0.5))
            expect(of(result.log, enemy, 'INTERRUPTED')).toEqual([
                { tick: 11, side: enemy, type: 'INTERRUPTED', spellId: 'SPELL_METEOR', source: 'SPELL_COUNTERSPELL' },
            ])
        })

        it(`late (as ${side}): waits until the cast is within lateWindowSeconds of release, then one reaction`, () => {
            // Meteor completes on tick 72; the 1 s (20-tick) window opens on tick 52; +0.5 s is tick 62
            const result = play(counterer('late', 0.5, 1))
            expect(of(result.log, enemy, 'INTERRUPTED').map(e => e.tick)).toEqual([62])
        })

        it(`late (as ${side}): a window shorter than the reaction lands after the release`, () => {
            // window opens on tick 68, the Counterspell lands on tick 78, after the Meteor released on 72
            const result = play(counterer('late', 0.5, 0.2))
            expect(of(result.log, enemy, 'INTERRUPTED')).toEqual([])
            expect(of(result.log, enemy, 'SPELL_RELEASE').map(e => e.tick)).toEqual([72])
            expect(of(result.log, side, 'SPELL_RELEASE').map(e => `${e.tick} ${e.spellId}`)).toEqual([
                '78 SPELL_COUNTERSPELL',
            ])
        })
    }

    for (const side of ['a', 'b'] as const) {
        it(`late (as ${side}): moves the window when Haste expires mid-cast and the release comes later`, () => {
            const HASTE = slotOf(METEOR_LOADOUT, 'SPELL_HASTE')
            const enemy = side === 'a' ? 'b' : 'a'
            // Haste on tick 0 lasts 60 s (to tick 1200); the Meteor started on 1190 shows 36 ticks (release 1226)
            // until Haste expires on 1200, then its base 72 (release 1262)
            const hasted: ControllerFactory = () => view => {
                if (view.tick === 0) return start(HASTE)
                if (view.tick === 1190) return start(METEOR)
                return view.self.casting && view.tick >= view.self.casting.completesAt ? stop(METEOR) : null
            }
            const seen: ArenaView[] = []
            const counter = counterer('late', 0, 1)
            const result = runMatch({
                seed: 1,
                [side]: { ...counter, controller: recording(counter.controller, seen) },
                [enemy]: entrant('hasted', hasted),
                maxTicks: 1300,
            } as unknown as Parameters<typeof runMatch>[0])
            expect(seen[1199].enemy.casting?.completesAt).toBe(1226)
            expect(seen[1200].enemy.casting?.completesAt).toBe(1262)
            // the 1 s (20-tick) window opens on 1262 - 20 = 1242, not on the stale 1206
            expect(of(result.log, enemy, 'INTERRUPTED').map(e => e.tick)).toEqual([1242])
        })
    }

    it('lets casts of spells it does not target through', () => {
        const fireballs = entrant('fireballs', profileController(profile(raw => (raw.rotation = ['SPELL_FIREBALL']))))
        const result = runMatch({ seed: 1, a: fireballs, b: counterer('early', 0.2), maxTicks: 200 })
        expect(of(result.log, 'b', 'SPELL_RELEASE')).toEqual([])
        expect(result.stats.a.casts).toBeGreaterThan(5)
    })

    it('commits later in the cast once Counterspell will be ready in time', () => {
        // b counters the tick-0 Meteor on tick 11, then is on cooldown (11.7 s = 234 ticks) until tick 245; a casts
        // Meteors back to back without minding that (a profile would hold its Meteor for the cooldown, see #123)
        const result = runMatch({ seed: 1, a: only('SPELL_METEOR'), b: counterer('early', 0.5), maxTicks: 400 })
        const interrupts = of(result.log, 'a', 'INTERRUPTED').map(e => e.tick)
        expect(interrupts[0]).toBe(11)
        // the Meteor in progress when the cooldown ends is interrupted as soon as Counterspell is ready
        expect(interrupts[1]).toBe(245)
    })

    it('samples the reaction once per cast from the seeded stream, within mean ± spread', () => {
        // drives the controller directly, so Counterspell's cooldown never hides a draw: a new enemy Meteor every
        // 40 ticks, Counterspell always ready, and the offset is the first tick it presses after the cast is visible
        const COUNTER = slotOf(METEOR_LOADOUT, 'SPELL_COUNTERSPELL')
        const loaded = profile(raw => {
            raw.counterspell = {
                ...raw.counterspell,
                enabled: true,
                reaction: { meanSeconds: 0.5, spreadSeconds: 0.25 },
            }
        })
        const offsets = (seed: number) => {
            const decide = profileController(loaded)({ loadout: METEOR_LOADOUT, rng: new Rng(seed) })
            const found: number[] = []
            for (let cast = 0; cast < 30; cast++) {
                const startTick = cast * 40
                for (let tick = startTick + 1; tick < startTick + 40; tick++) {
                    const view = handView(METEOR_LOADOUT, tick, { startTick, completesAt: startTick + 72 })
                    if (actionsOf(decide(view)).some(a => a.type === 'start' && a.slot === COUNTER)) {
                        found.push(tick - (startTick + 1))
                        break
                    }
                }
            }
            return found
        }
        const first = offsets(1)
        expect(first).toHaveLength(30)
        for (const ticks of first) {
            expect(ticks).toBeGreaterThanOrEqual(secondsToTicks(0.25))
            expect(ticks).toBeLessThanOrEqual(secondsToTicks(0.75))
        }
        expect(new Set(first).size).toBeGreaterThan(5)
        expect(offsets(1)).toEqual(first)
        expect(offsets(2)).not.toEqual(first)
    })
})

describe('profile controller: fake casts', () => {
    it('cancels through stopCast after cancelAfterSeconds: no release, no lockout, no damage', () => {
        const seen: ArenaView[] = []
        const fake = baiter()
        const result = runMatch({
            seed: 1,
            a: { ...fake, controller: recording(fake.controller, seen) },
            b: idler(),
            maxTicks: 14,
        })
        // started on tick 0, cancelled 0.25 s = 5 ticks in, then a 0.4 s = 8 tick pause before the real Meteor
        expect(result.log.filter(e => e.side === 'a').map(e => `${e.tick} ${e.type} ${e.spellId}`)).toEqual([
            '0 START_CAST SPELL_METEOR',
            '5 STOP_CAST SPELL_METEOR',
            '13 START_CAST SPELL_METEOR',
        ])
        expect(result.stats.a).toMatchObject({ started: 2, cancelled: 1, casts: 0, interrupted: 0, rejected: 0 })
        expect(result.hp).toEqual({ a: 100, b: 100 })
        expect(seen.every(view => view.self.lockedUntil === 0 && view.self.effects.length === 0)).toBe(true)
        expect(seen[6].self.casting).toBeNull()
    })

    for (const side of ['a', 'b'] as const) {
        const enemy = side === 'a' ? 'b' : 'a'
        it(`baits a Counterspell-ready early counterer into wasting it (baiter as ${side})`, () => {
            const result = runMatch({
                seed: 1,
                [side]: baiter(),
                [enemy]: counterer('early', 0.4),
                maxTicks: 120,
            } as unknown as Parameters<typeof runMatch>[0])
            // the counterer committed on tick 1 and its Counterspell lands on tick 9, after the cancel on tick 5
            expect(of(result.log, enemy, 'SPELL_RELEASE').map(e => `${e.tick} ${e.spellId}`)).toEqual([
                '9 SPELL_COUNTERSPELL',
            ])
            expect(result.stats[side]).toMatchObject({ cancelled: 1, interrupted: 0 })
            // the real Meteor, started on tick 13, lands on tick 85 while Counterspell is on cooldown
            expect(of(result.log, side, 'SPELL_RELEASE').map(e => `${e.tick} ${e.spellId}`)).toEqual([
                '85 SPELL_METEOR',
            ])
            expect(result.hp[enemy]).toBe(72)
        })
    }

    it('without the pause, the baited Counterspell lands on the next cast instead', () => {
        const result = runMatch({ seed: 1, a: baiter(0), b: counterer('early', 0.4), maxTicks: 120 })
        expect(of(result.log, 'a', 'INTERRUPTED').map(e => e.tick)).toEqual([9])
    })

    it('does not fool a late counterer: the fake is gone before it decides', () => {
        const result = runMatch({ seed: 1, a: baiter(), b: counterer('late', 0.4, 1), maxTicks: 120 })
        // no Counterspell on the fake; the real Meteor (13 to 85) is countered 0.4 s after its window opens on 65
        expect(of(result.log, 'b', 'SPELL_RELEASE').map(e => e.tick)).toEqual([73])
        expect(of(result.log, 'a', 'INTERRUPTED').map(e => e.tick)).toEqual([73])
    })

    it('does not let nextCastIs rules (Haste before Meteor) fire for a fake cast', () => {
        const { profile: bait, loadout } = ARCHETYPES.bait
        const fakesOnly = { ...bait, fakeCast: { ...bait.fakeCast, realBaitShare: 0 } }
        const result = runMatch({ seed: 1, a: profileEntrant(fakesOnly, loadout), b: idler(), maxTicks: 20 })
        // the fake Meteor starts on tick 0 and is cancelled on 5; Haste goes with the real Meteor on 13
        expect(result.log.map(e => `${e.tick} ${e.type} ${e.spellId}`)).toEqual([
            '0 START_CAST SPELL_METEOR',
            '5 STOP_CAST SPELL_METEOR',
            '13 SPELL_RELEASE SPELL_HASTE',
            '13 START_CAST SPELL_METEOR',
        ])
    })

    it('makes no fake cast when disabled', () => {
        const meteors = player('meteors', raw => (raw.rotation = ['SPELL_METEOR']))
        const result = runMatch({ seed: 1, a: meteors, b: idler(), maxTicks: 100 })
        expect(result.stats.a).toMatchObject({ cancelled: 0, casts: 1 })
    })

    it('the bait archetype fake-casts against a reactive Counterspell in a seeded match', () => {
        let fakes = 0
        let wasted = 0
        for (const seed of [1, 2, 3, 4]) {
            const result = runMatch({ seed, a: archetypeEntrant('bait'), b: archetypeEntrant('aggressive') })
            fakes += fakeCasts(result.log, 'a', 'SPELL_METEOR').length
            // the enemy's Counterspells that hit nothing
            wasted += of(result.log, 'b', 'SPELL_RELEASE').filter(
                e =>
                    e.spellId === 'SPELL_COUNTERSPELL' &&
                    !result.log.some(i => i.tick === e.tick && i.side === 'a' && i.type === 'INTERRUPTED'),
            ).length
        }
        // half its baits are real casts (realBaitShare 0.5), so not every match has a fake
        expect(fakes).toBeGreaterThanOrEqual(1)
        expect(wasted).toBeGreaterThanOrEqual(1)
    })
})

/** Ticks of `side`'s casts of `spell` that were stopped before completing (a STOP_CAST with no release). */
const fakeCasts = (log: readonly MatchEvent[], side: 'a' | 'b', spell: SpellId) =>
    log
        .map((e, i) => ({ e, next: log[i + 1] }))
        .filter(
            ({ e, next }) =>
                e.side === side &&
                e.type === 'STOP_CAST' &&
                e.spellId === spell &&
                !(next?.type === 'SPELL_RELEASE' && next.side === side && next.spellId === spell),
        )
        .map(({ e }) => e.tick)

describe('profile controller: general spells', () => {
    const SHIELD = slotOf(OTHER_LOADOUT, 'SPELL_TEMPORAL_SHIELD')

    it('uses a general spell when its data rule holds, and never when the rule is "never"', () => {
        const shield = (rule: unknown) =>
            player(
                'shield',
                raw => {
                    raw.generals.SPELL_TEMPORAL_SHIELD = rule
                },
                OTHER_LOADOUT,
            )
        const fireballs = entrant('fireballs', profileController(profile(raw => (raw.rotation = ['SPELL_FIREBALL']))))
        const withRule = runMatch({
            seed: 1,
            a: fireballs,
            b: shield({ when: [{ type: 'selfHpBelow', hp: 90 }] }),
            maxTicks: 300,
        })
        const used = of(withRule.log, 'b', 'SPELL_RELEASE').filter(e => e.spellId === 'SPELL_TEMPORAL_SHIELD')
        expect(used.length).toBeGreaterThanOrEqual(1)
        // Fireballs release on ticks 26 and 52 (5.6 each): b is at 88.8 from tick 52, which its view shows on tick 53
        expect(used[0].tick).toBe(53)
        const never = runMatch({ seed: 1, a: fireballs, b: shield('never'), maxTicks: 300 })
        expect(of(never.log, 'b', 'SPELL_RELEASE')).toEqual([])
    })

    it('decides from the view object alone: a hand-built ArenaView, no battle, triggers the Temporal Shield rule', () => {
        const loaded = profile(raw => {
            raw.generals.SPELL_TEMPORAL_SHIELD = {
                when: [{ type: 'enemyCastEndsWithin', seconds: 0.3, spells: ['SPELL_METEOR'] }],
            }
            raw.generals.SPELL_MAGIC_EATER = {
                when: [{ type: 'enemyEffectsAtLeast', effect: 'DEBUFF_IGNITE', count: 2 }],
            }
        }, OTHER_LOADOUT)
        const decide = profileController(loaded)({ loadout: OTHER_LOADOUT, rng: new Rng(1) })
        const view = (completesAt: number, ignites: number) =>
            handView(OTHER_LOADOUT, 100, { startTick: completesAt - 72, completesAt }, ignites)
        const ME = slotOf(OTHER_LOADOUT, 'SPELL_MAGIC_EATER')
        expect(actionsOf(decide(view(140, 0)))).toEqual([])
        expect(actionsOf(decide(view(106, 0)))).toEqual([start(SHIELD)])
        expect(actionsOf(decide(view(140, 2)))).toEqual([start(ME)])
    })

    it('makes the same decisions when replayed on copies of the views it saw: it reads nothing else', () => {
        for (const name of ARCHETYPE_NAMES) {
            const { profile: loaded, loadout } = ARCHETYPES[name]
            const views: ArenaView[] = []
            const decisions: Decision[] = []
            const watched: ControllerFactory = init => {
                const decide = profileController(loaded)(init)
                return view => {
                    views.push(JSON.parse(JSON.stringify(view)) as ArenaView)
                    const decision = decide(view)
                    decisions.push(actionsOf(decision))
                    return decision
                }
            }
            runMatch({ seed: 5, a: entrant(name, watched, [...loadout]), b: archetypeEntrant('aggressive') })
            // the runner gives side a the stream derived from (seed, 1); replay with that same stream
            const replay = profileController(loaded)({ loadout, rng: rngFor(5, 1) })
            const replayed = views.map(view => actionsOf(replay(view)))
            expect(replayed).toEqual(decisions)
            expect(decisions.some(d => (d as unknown[]).length > 0)).toBe(true)
        }
    })
})

/** A spell's base cast time in ticks, from the public spell data (the view shows the same). */
const castTicks = (id: SpellId) => secondsToTicks(SPELLS[id].castSeconds ?? 0)

/**
 * A hand-built view on `tick`: every spell ready with its base cast time, the enemy idle with `ignites` Ignites and
 * locked until `enemyLockedUntil`.
 */
const freeView = (
    loadout: readonly SpellId[],
    tick: number,
    { enemyLockedUntil = 0, ignites = 0 }: { enemyLockedUntil?: number; ignites?: number } = {},
): ArenaView => ({
    tick,
    self: {
        hp: 100,
        casting: null,
        gcdUntil: 0,
        lockedUntil: 0,
        effects: [],
        spells: loadout.map(id => ({
            id,
            castTime: castTicks(id),
            cooldownRemaining: 0,
            lockRemaining: 0,
            ready: true,
        })),
    },
    enemy: {
        hp: 100,
        casting: null,
        lockedUntil: enemyLockedUntil,
        effects: Array.from({ length: ignites }, () => ({
            id: 'DEBUFF_IGNITE' as const,
            type: 'negative' as const,
            startingTick: tick - 10,
            expiresAt: tick + 190,
        })),
        log: [],
    },
})

/** The view one tick after an enemy Counterspell landed on `landedAt`: locked for 3 s, its debuff on the buff bar. */
const counteredView = (loadout: readonly SpellId[], landedAt: number): ArenaView => {
    const view = freeView(loadout, landedAt + 1)
    return {
        ...view,
        self: {
            ...view.self,
            lockedUntil: landedAt + 60,
            effects: [
                { id: 'DEBUFF_COUNTERSPELL', type: 'negative', startingTick: landedAt, expiresAt: landedAt + 60 },
            ],
            spells: view.self.spells.map(s => ({ ...s, lockRemaining: 59, ready: false })),
        },
    }
}

/** The cast-time spell a decision starts, or null. */
const castOf = (loadout: readonly SpellId[], decision: Decision) =>
    actionsOf(decision)
        .filter(a => a.type === 'start' && castTicks(loadout[a.slot]) > 0)
        .map(a => loadout[a.slot])[0] ?? null

/** A fresh controller for `loaded` on `loadout`. */
const controllerFor = (loaded: ReturnType<typeof parseProfile>, loadout: readonly SpellId[], seed = 1) =>
    profileController(loaded)({ loadout, rng: new Rng(seed) })

/** The ticks `side` started a cast of `spell`. */
const startsOf = (log: readonly MatchEvent[], side: 'a' | 'b', spell?: SpellId) =>
    of(log, side, 'START_CAST')
        .filter(e => !spell || e.spellId === spell)
        .map(e => e.tick)

describe('profile controller: free-cast window after a Counterspell (#123)', () => {
    // Combustion (2.4 s = 48 ticks) is a target of every archetype's Counterspell: risky unless the enemy can't counter
    const cases = [
        { name: 'aggressive', ignites: 2, window: 'SPELL_COMBUSTION', normal: 'SPELL_IGNITE' },
        { name: 'defensive', ignites: 1, window: 'SPELL_COMBUSTION', normal: 'SPELL_LIVING_BOMB' },
        { name: 'patient-counter', ignites: 1, window: 'SPELL_COMBUSTION', normal: 'SPELL_IGNITE' },
        // a 3 s lockout has no room for Meteor (3.6 s), so bait casts a Fireball instead of a bait or a Meteor
        { name: 'bait', ignites: 0, window: 'SPELL_FIREBALL', normal: undefined },
    ] as const

    it('every archetype casts from its window list while the enemy is locked out', () => {
        for (const { name, ignites, window, normal } of cases) {
            const { profile: loaded, loadout } = ARCHETYPES[name]
            // the view one tick after the Counterspell landed on tick 99: the enemy is locked until 159
            const locked = castOf(
                loadout,
                controllerFor(loaded, loadout)(freeView(loadout, 100, { enemyLockedUntil: 159, ignites })),
            )
            const free = castOf(loadout, controllerFor(loaded, loadout)(freeView(loadout, 100, { ignites })))
            expect(locked, name).toBe(window)
            if (normal) expect(free, name).toBe(normal)
            expect(free, name).not.toBe(locked)
        }
    })

    it('a window cast must release before the lockout ends: on that tick the enemy may act first', () => {
        const { profile: loaded, loadout } = ARCHETYPES.aggressive
        const decide = (enemyLockedUntil: number) =>
            castOf(loadout, controllerFor(loaded, loadout)(freeView(loadout, 100, { enemyLockedUntil, ignites: 2 })))
        // Combustion started on 100 releases on 148
        expect(decide(149)).toBe('SPELL_COMBUSTION')
        expect(decide(148)).toBe('SPELL_IGNITE')
        // Ignite (32 ticks) releases on 132: with the lockout ending on it, nothing fits and nothing starts
        expect(decide(133)).toBe('SPELL_IGNITE')
        expect(decide(132)).toBe('SPELL_FIREBALL')
        expect(decide(126)).toBeNull()
    })

    for (const side of ['a', 'b'] as const) {
        const enemy = side === 'a' ? 'b' : 'a'
        it(`in a match (as ${side}): the cast after its Counterspell is a Combustion that lands before the lockout ends`, () => {
            // the enemy Meteor's start tick is picked so the archetype has the Ignites its window rule asks for
            for (const [name, meteorAt] of [
                ['aggressive', 70],
                ['defensive', 100],
                ['patient-counter', 60],
            ] as const) {
                const meteor = entrant('meteor', scripted({ [meteorAt]: start(METEOR), [meteorAt + 72]: stop(METEOR) }))
                const result = runMatch({
                    seed: 1,
                    [side]: archetypeEntrant(name),
                    [enemy]: meteor,
                    maxTicks: meteorAt + 200,
                } as unknown as Parameters<typeof runMatch>[0])
                const [landed] = of(result.log, enemy, 'INTERRUPTED').map(e => e.tick)
                expect(landed, name).toBeGreaterThan(meteorAt)
                // one tick to see the lock on the view, then Combustion, released before the lock ends on landed + 60
                const next = of(result.log, side, 'START_CAST').find(e => e.tick > landed)
                expect(next, name).toMatchObject({ tick: landed + 1, spellId: 'SPELL_COMBUSTION' })
                const release = of(result.log, side, 'SPELL_RELEASE').find(
                    e => e.tick > landed && e.spellId === 'SPELL_COMBUSTION',
                )
                expect(release?.tick, name).toBe(landed + 1 + 48)
                expect(release!.tick, name).toBeLessThan(landed + 60)
                expect(result.stats[side].interrupted, name).toBe(0)
            }
        })
    }

    it('counts a hasted cast at its base time when the Haste will not last to its release', () => {
        const loaded = profile(raw => (raw.rotation = ['SPELL_COMBUSTION', 'SPELL_FIREBALL']))
        const HASTED: Partial<Record<SpellId, number>> = { SPELL_COMBUSTION: 24, SPELL_FIREBALL: 13, SPELL_METEOR: 36 }
        // on tick 100, Haste on and the enemy locked until 140: hasted, Combustion releases on 124; un-hasted, on 148
        const decide = (hasteEnds: number, releasing: boolean) => {
            const decideNow = controllerFor(loaded, METEOR_LOADOUT)
            decideNow(freeView(METEOR_LOADOUT, 10)) // no Haste yet: the base cast times
            const view = freeView(METEOR_LOADOUT, 100, { enemyLockedUntil: 140 })
            const hasted: ArenaView = {
                ...view,
                self: {
                    ...view.self,
                    effects: [{ id: 'BUFF_HASTE', type: 'positive', startingTick: 60, expiresAt: hasteEnds }],
                    spells: view.self.spells.map(s => ({ ...s, castTime: HASTED[s.id] ?? s.castTime })),
                    // a hasted Meteor completing now: releasing it uses up the Haste
                    casting: releasing
                        ? { slot: METEOR, spellId: 'SPELL_METEOR', startTick: 64, castTime: 36, completesAt: 100 }
                        : null,
                },
            }
            return castOf(METEOR_LOADOUT, decideNow(hasted))
        }
        expect(decide(1260, false)).toBe('SPELL_COMBUSTION')
        // this tick's release uses up the Haste: Combustion would take its base 48 ticks, a Fireball 26 fits
        expect(decide(1260, true)).toBe('SPELL_FIREBALL')
        // Haste ends on 120, before the hasted release on 124
        expect(decide(120, false)).toBe('SPELL_FIREBALL')
        // Haste ends on 124, the hasted release tick: the view of 124 no longer shows it and the engine has restored the
        // 48-tick cast time, so the cast doesn't release then (hasteEnds <= release, not <)
        expect(decide(124, false)).toBe('SPELL_FIREBALL')
        expect(decide(125, false)).toBe('SPELL_COMBUSTION')
    })

    it('a cast that ends after the lockout is chosen only if the enemy Counterspell is seen on cooldown', () => {
        const loadout = METEOR_LOADOUT
        const meteors = profile(raw => (raw.rotation = ['SPELL_METEOR', 'SPELL_FIREBALL']))
        // on tick 300 the enemy is locked until 359; a Meteor started then releases on 372, after the lockout
        const decide = (seenLanding?: number) => {
            const decideNow = controllerFor(meteors, loadout)
            if (seenLanding !== undefined) expect(actionsOf(decideNow(counteredView(loadout, seenLanding)))).toEqual([])
            return castOf(loadout, decideNow(freeView(loadout, 300, { enemyLockedUntil: 359 })))
        }
        // no enemy Counterspell seen: it may be ready when the lockout ends, so only a Fireball (326) fits
        expect(decide()).toBe('SPELL_FIREBALL')
        // its Counterspell landed on 139: on cooldown (11.7 s = 234 ticks) until 373, so the Meteor releases first
        expect(decide(139)).toBe('SPELL_METEOR')
        // landed on 138: ready on 372, the Meteor's release tick
        expect(decide(138)).toBe('SPELL_FIREBALL')
    })

    it('holds a long cast while the enemy Counterspell is on cooldown but would be ready before its release', () => {
        // b counters the tick-0 Meteor on tick 11 and is on cooldown until 245: Meteors started on 71 and 143 release
        // first, the one after waits for 245 instead of starting on 215, where it would still be on the bar at 245
        const meteors = player('meteors', raw => (raw.rotation = ['SPELL_METEOR']))
        const result = runMatch({ seed: 1, a: meteors, b: counterer('early', 0.5), maxTicks: 400 })
        const before = (e: MatchEvent) => e.tick < 300
        expect(
            of(result.log, 'a', 'START_CAST')
                .filter(before)
                .map(e => e.tick),
        ).toEqual([0, 71, 143, 245])
        expect(
            of(result.log, 'a', 'SPELL_RELEASE')
                .filter(before)
                .map(e => e.tick),
        ).toEqual([143, 215])
        // the Meteor started on 245 is countered as soon as b sees it and reacts, like the first one
        expect(
            of(result.log, 'a', 'INTERRUPTED')
                .filter(before)
                .map(e => e.tick),
        ).toEqual([11, 256])
    })

    it('starts no fake cast and no real bait in the window', () => {
        for (const realBaitShare of [0, 1]) {
            const baiter = player('baiter', raw => {
                raw.rotation = ['SPELL_FIREBALL', 'SPELL_IGNITE']
                ;(raw as Record<string, unknown>).lockoutWindow = { rotation: ['SPELL_FIREBALL'] }
                raw.counterspell = {
                    ...raw.counterspell,
                    enabled: true,
                    reaction: { meanSeconds: 0.25, spreadSeconds: 0 },
                }
                Object.assign(raw.fakeCast, { enabled: true, minGapSeconds: 0, maxPerMatch: 50, realBaitShare })
            })
            const meteor = entrant('meteor', scripted({ 20: start(METEOR), 92: stop(METEOR) }))
            const result = runMatch({ seed: 1, a: baiter, b: meteor, maxTicks: 160 })
            const [landed] = of(result.log, 'b', 'INTERRUPTED').map(e => e.tick)
            const lockEnds = landed + 60
            const inWindow = (tick: number) => tick > landed && tick < lockEnds
            // baits before and after the window (a fake Meteor, or a real Ignite, the lowest-priority entry) ...
            const baits = realBaitShare
                ? startsOf(result.log, 'a', 'SPELL_IGNITE')
                : fakeCasts(result.log, 'a', 'SPELL_METEOR')
            expect(
                baits.some(t => t < landed),
                `share ${realBaitShare}`,
            ).toBe(true)
            expect(
                baits.some(t => t >= lockEnds),
                `share ${realBaitShare}`,
            ).toBe(true)
            // ... and none in it: only Fireballs, each released before the lockout ends
            expect(baits.filter(inWindow), `share ${realBaitShare}`).toEqual([])
            const windowCasts = of(result.log, 'a', 'START_CAST').filter(e => inWindow(e.tick))
            expect(windowCasts.map(e => e.spellId)).toEqual(['SPELL_FIREBALL', 'SPELL_FIREBALL'])
            expect(windowCasts.every(e => e.tick + 26 < lockEnds)).toBe(true)
        }
    })

    it('never starts a spell while locked out, whatever its rules want', () => {
        for (const name of ARCHETYPE_NAMES) {
            const { profile: loaded, loadout } = ARCHETYPES[name]
            const decide = controllerFor(loaded, loadout)
            const view = counteredView(loadout, 100)
            // an enemy Meteor about to land and Ignites on both: every rule has a reason to act
            const meteorView: ArenaView = {
                ...view,
                self: { ...view.self, hp: 20 },
                enemy: {
                    ...view.enemy,
                    hp: 10,
                    casting: { spellId: 'SPELL_METEOR', startTick: 40, castTime: 72, completesAt: 112 },
                    effects: freeView(loadout, 101, { ignites: 6 }).enemy.effects,
                },
            }
            for (let tick = 101; tick < 160; tick++)
                expect(actionsOf(decide({ ...meteorView, tick })), `${name} on ${tick}`).toEqual([])
        }
    })
})

describe('profile controller: sacrificial bait (#123)', () => {
    const realBait = (share: number) => {
        const { profile: bait, loadout } = ARCHETYPES.bait
        return profileEntrant({ ...bait, fakeCast: { ...bait.fakeCast, realBaitShare: share } }, loadout, 'bait')
    }

    for (const side of ['a', 'b'] as const) {
        const enemy = side === 'a' ? 'b' : 'a'
        it(`sacrifices a real low-priority Combustion, then lands Meteors while the Counterspell is on cooldown (as ${side})`, () => {
            const result = runMatch({
                seed: 1,
                [side]: realBait(1),
                [enemy]: archetypeEntrant('aggressive'),
                maxTicks: 400,
            } as unknown as Parameters<typeof runMatch>[0])
            // the bait: its rotation's last entry, cast for real (no cancel), countered by the enemy
            expect(of(result.log, side, 'START_CAST')[0]).toMatchObject({ tick: 0, spellId: 'SPELL_COMBUSTION' })
            const [landed] = of(result.log, side, 'INTERRUPTED').map(e => e.tick)
            expect(of(result.log, side, 'INTERRUPTED')[0].spellId).toBe('SPELL_COMBUSTION')
            const readyAgain = landed + 234
            // from the end of the lock until the enemy Counterspell is ready again: Meteors (Haste on the first), no
            // bait, and every cast released before the enemy can counter it
            const between = (e: MatchEvent) => e.tick >= landed + 60 && e.tick < readyAgain
            const starts = of(result.log, side, 'START_CAST').filter(between)
            expect(starts[0]).toMatchObject({ tick: landed + 60, spellId: 'SPELL_METEOR' })
            expect(starts.filter(e => e.spellId === 'SPELL_METEOR').length).toBeGreaterThanOrEqual(2)
            expect(starts.some(e => e.spellId === 'SPELL_COMBUSTION')).toBe(false)
            expect(fakeCasts(result.log, side, 'SPELL_METEOR').filter(t => t < readyAgain)).toEqual([])
            const releases = of(result.log, side, 'SPELL_RELEASE').filter(
                e => between(e) && e.spellId === 'SPELL_METEOR',
            )
            expect(releases.length).toBeGreaterThanOrEqual(2)
            expect(of(result.log, side, 'INTERRUPTED').filter(e => e.tick < readyAgain)).toHaveLength(1)
        })
    }

    it('the shipped bait archetype mixes both kinds of bait (realBaitShare 0.5)', () => {
        const first = (seed: number) =>
            of(
                runMatch({ seed, a: archetypeEntrant('bait'), b: archetypeEntrant('aggressive') }).log,
                'a',
                'START_CAST',
            )[0].spellId
        // seed 1 draws a real Combustion for its first bait, seed 3 a fake Meteor
        expect(first(1)).toBe('SPELL_COMBUSTION')
        expect(first(3)).toBe('SPELL_METEOR')
        expect(ARCHETYPES.bait.profile.fakeCast.realBaitShare).toBe(0.5)
    })

    it('picks the bait by rotation priority: the last entry that is ready and whose when holds', () => {
        const loaded = profile(raw => {
            raw.rotation = [
                'SPELL_METEOR',
                'SPELL_FIREBALL',
                {
                    spell: 'SPELL_COMBUSTION',
                    when: [{ type: 'enemyEffectsAtLeast', effect: 'DEBUFF_IGNITE', count: 1 }],
                },
            ]
            Object.assign(raw.fakeCast, { enabled: true, realBaitShare: 1 })
        })
        const first = (ignites: number) =>
            castOf(METEOR_LOADOUT, controllerFor(loaded, METEOR_LOADOUT)(freeView(METEOR_LOADOUT, 50, { ignites })))
        expect(first(1)).toBe('SPELL_COMBUSTION')
        expect(first(0)).toBe('SPELL_FIREBALL')
        // a real bait is released when complete, not cancelled
        const result = runMatch({ seed: 1, a: entrant('bait', profileController(loaded)), b: idler(), maxTicks: 30 })
        expect(result.log.filter(e => e.side === 'a').map(e => `${e.tick} ${e.type} ${e.spellId}`)).toEqual([
            '0 START_CAST SPELL_FIREBALL',
            '26 STOP_CAST SPELL_FIREBALL',
            '26 SPELL_RELEASE SPELL_FIREBALL',
            '26 START_CAST SPELL_METEOR',
        ])
    })

    it('realBaitShare sets how often a bait is real: never at 0, always at 1, drawn per bait in between', () => {
        const kinds = (share: number, seed: number) => {
            const loaded = profile(raw => {
                raw.rotation = ['SPELL_METEOR', 'SPELL_FIREBALL']
                Object.assign(raw.fakeCast, { enabled: true, minGapSeconds: 0, maxPerMatch: 10, realBaitShare: share })
            })
            // 10 baits back to back, then Meteors; at most 10 Fireballs (56 HP), so the idle enemy outlives them
            const result = runMatch({ seed, a: entrant('bait', profileController(loaded)), b: idler(), maxTicks: 600 })
            return {
                fakes: fakeCasts(result.log, 'a', 'SPELL_METEOR').length,
                real: startsOf(result.log, 'a', 'SPELL_FIREBALL').length,
            }
        }
        expect(kinds(0, 1)).toEqual({ fakes: 10, real: 0 })
        expect(kinds(1, 1)).toEqual({ fakes: 0, real: 10 })
        const mixed = kinds(0.5, 1)
        expect(mixed.fakes).toBeGreaterThan(0)
        expect(mixed.real).toBeGreaterThan(0)
        expect(mixed.fakes + mixed.real).toBe(10)
        expect(kinds(0.5, 1)).toEqual(mixed)
    })
})

describe("profile controller: the enemy's spell log (#126)", () => {
    /** The enemy's log entry of a Counterspell used on `tick`, as the view shows it. */
    const counterUsed = (tick: number) => ({
        tick,
        type: 'SPELL_RELEASE' as const,
        spellId: 'SPELL_COUNTERSPELL' as const,
    })
    const withLog = (view: ArenaView, log: ArenaView['enemy']['log']): ArenaView => ({
        ...view,
        enemy: { ...view.enemy, log },
    })
    // Fireballs normally; Meteors only while the enemy's Counterspell can't come
    const meteorsInWindow = profile(raw => {
        raw.rotation = ['SPELL_FIREBALL']
        ;(raw as Record<string, unknown>).lockoutWindow = { rotation: ['SPELL_METEOR', 'SPELL_FIREBALL'] }
    })

    it('infers the enemy Counterspell cooldown from a whiff on its spell log, with no lock or debuff on the view', () => {
        const decide = (log: ArenaView['enemy']['log']) =>
            castOf(
                METEOR_LOADOUT,
                controllerFor(meteorsInWindow, METEOR_LOADOUT)(withLog(freeView(METEOR_LOADOUT, 300), log)),
            )
        // never seen used: taken as ready, so the normal rotation
        expect(decide([])).toBe('SPELL_FIREBALL')
        // used on 139 (nothing interrupted): on cooldown until 139 + 234 = 373, after the Meteor's release on 372
        expect(decide([counterUsed(139)])).toBe('SPELL_METEOR')
        // used on 138: ready on 372, the Meteor's release tick, so the window plays its Fireball (released on 326)
        expect(decide([counterUsed(138)])).toBe('SPELL_FIREBALL')
        // the latest use counts; other entries don't
        expect(decide([counterUsed(20), counterUsed(139)])).toBe('SPELL_METEOR')
        expect(
            decide([
                { tick: 139, type: 'START_CAST', spellId: 'SPELL_METEOR' },
                { tick: 139, type: 'CANCEL_CAST', spellId: 'SPELL_METEOR' },
            ]),
        ).toBe('SPELL_FIREBALL')
        // ready again on 300: no window
        expect(decide([counterUsed(66)])).toBe('SPELL_FIREBALL')
    })

    it('reads the log as it grows on the same array, as the runner gives it', () => {
        const decide = controllerFor(meteorsInWindow, METEOR_LOADOUT)
        const log: { tick: number; type: 'SPELL_RELEASE'; spellId: 'SPELL_COUNTERSPELL' }[] = []
        const view = withLog(freeView(METEOR_LOADOUT, 300), log)
        expect(castOf(METEOR_LOADOUT, decide(view))).toBe('SPELL_FIREBALL')
        log.push(counterUsed(290))
        expect(castOf(METEOR_LOADOUT, decide({ ...view, tick: 301 }))).toBe('SPELL_METEOR')
    })

    for (const side of ['a', 'b'] as const) {
        const enemy = side === 'a' ? 'b' : 'a'
        it(`after a fake cast draws a whiffed Counterspell, casts Meteors during its cooldown (as ${side})`, () => {
            const baiter = profileEntrant(
                profile(raw => {
                    raw.rotation = ['SPELL_FIREBALL']
                    ;(raw as Record<string, unknown>).lockoutWindow = { rotation: ['SPELL_METEOR', 'SPELL_FIREBALL'] }
                    raw.fakeCast = { ...raw.fakeCast, enabled: true, pauseAfterSeconds: 0.4 }
                }),
                METEOR_LOADOUT,
                'baiter',
            )
            const result = runMatch({
                seed: 1,
                [side]: baiter,
                [enemy]: counterer('early', 0.4),
                maxTicks: 242,
            } as unknown as Parameters<typeof runMatch>[0])
            // the fake Meteor (0 to 5) draws the enemy's Counterspell on 9, which hits nothing
            expect(fakeCasts(result.log, side, 'SPELL_METEOR')).toEqual([5])
            expect(of(result.log, enemy, 'SPELL_RELEASE').map(e => `${e.tick} ${e.spellId}`)).toEqual([
                '9 SPELL_COUNTERSPELL',
            ])
            expect(result.stats[side].interrupted).toBe(0)
            // on cooldown until 243: after the pause, Meteors (not the normal Fireballs), each released before 243 and
            // the next started on the same tick; a fourth (229 + 72) wouldn't be, so nothing starts on 229
            expect(startsOf(result.log, side)).toEqual([0, 13, 85, 157])
            expect(of(result.log, side, 'SPELL_RELEASE').map(e => `${e.tick} ${e.spellId}`)).toEqual([
                '85 SPELL_METEOR',
                '157 SPELL_METEOR',
                '229 SPELL_METEOR',
            ])
        })
    }
})

describe('profile controller: edge greed (#126)', () => {
    const { profile: aggressive, loadout } = ARCHETYPES.aggressive
    const greedy = (edgeGreedSeconds: number, base = aggressive) => ({
        ...base,
        lockoutWindow: { ...base.lockoutWindow, edgeGreedSeconds },
    })
    // aggressive on tick 100 with 2 Ignites on the enemy, locked until `enemyLockedUntil` (see the #123 tests above)
    const decide = (edgeGreedSeconds: number, enemyLockedUntil: number) =>
        castOf(
            loadout,
            controllerFor(greedy(edgeGreedSeconds), loadout)(freeView(loadout, 100, { enemyLockedUntil, ignites: 2 })),
        )

    it('at the default 0, waits when no cast fits, as in #123', () => {
        expect(aggressive.lockoutWindow.edgeGreedSeconds).toBe(0)
        // a Fireball started on 100 releases on 126, the tick the lockout ends
        expect(decide(0, 126)).toBeNull()
        expect(decide(0, 133)).toBe('SPELL_IGNITE')
    })

    it('with no safe cast, lets one release up to edgeGreedSeconds past the window, in window order', () => {
        // one tick of greed: the Fireball releasing on 126 now fits (126 < 127)
        expect(decide(0.05, 126)).toBe('SPELL_FIREBALL')
        expect(decide(0.05, 125)).toBeNull()
        // 1.5 s = 30 ticks: up to 155, so Combustion (148) comes first in the window list
        expect(decide(1.5, 126)).toBe('SPELL_COMBUSTION')
        // with a safe cast there is no greed: the Ignite (132 < 133), not the Combustion that would fit the greedy bound
        expect(decide(1.5, 133)).toBe('SPELL_IGNITE')
        // outside the window it changes nothing
        expect(decide(1.5, 0)).toBe(decide(0, 0))
    })

    it('clamps an out-of-range value to [0, 1.5] s', () => {
        const meteorWindow = greedy(
            0,
            profile(raw => ((raw as Record<string, unknown>).lockoutWindow = { rotation: ['SPELL_METEOR'] })),
        )
        const meteor = (edgeGreedSeconds: number) =>
            castOf(
                METEOR_LOADOUT,
                controllerFor(
                    greedy(edgeGreedSeconds, meteorWindow),
                    METEOR_LOADOUT,
                )(freeView(METEOR_LOADOUT, 100, { enemyLockedUntil: 126 })),
            )
        // the Meteor releases on 172: 46 ticks past the window, more than the 30 of 1.5 s
        expect(meteor(5)).toBeNull()
        expect(meteor(1.5)).toBeNull()
        expect(meteor(-5)).toBeNull()
        expect(meteor(Number.NaN)).toBeNull()
    })

    it('in a match: the cast the whiff window has no room for goes out greedily, and lands', () => {
        // the bait match above: on 229 a Meteor (301) and a Fireball (255) both release after the enemy's Counterspell
        // is ready on 243; with 1.5 s of greed the Fireball fits (255 < 273), and b doesn't target it
        const run = (edgeGreedSeconds: number) => {
            const baiter = profileEntrant(
                greedy(
                    edgeGreedSeconds,
                    profile(raw => {
                        raw.rotation = ['SPELL_FIREBALL']
                        ;(raw as Record<string, unknown>).lockoutWindow = {
                            rotation: ['SPELL_METEOR', 'SPELL_FIREBALL'],
                        }
                        raw.fakeCast = { ...raw.fakeCast, enabled: true, pauseAfterSeconds: 0.4 }
                    }),
                ),
                METEOR_LOADOUT,
                'baiter',
            )
            return runMatch({ seed: 1, a: baiter, b: counterer('early', 0.4), maxTicks: 260 })
        }
        expect(startsOf(run(0).log, 'a').filter(t => t > 200 && t < 243)).toEqual([])
        const greedyRun = run(1.5)
        expect(startsOf(greedyRun.log, 'a').filter(t => t > 200 && t < 243)).toEqual([229])
        expect(of(greedyRun.log, 'a', 'SPELL_RELEASE').at(-1)).toMatchObject({ tick: 255, spellId: 'SPELL_FIREBALL' })
        expect(greedyRun.stats.a.interrupted).toBe(0)
    })
})

describe('archetypes in play', () => {
    it('only ever take actions their view says are legal, on either side', () => {
        for (const a of ARCHETYPE_NAMES) {
            for (const b of ARCHETYPE_NAMES) {
                const illegal: string[] = []
                const watch = (name: typeof a) => {
                    const e = archetypeEntrant(name)
                    return { ...e, controller: checked(e.controller, illegal) }
                }
                for (const seed of [1, 2]) runMatch({ seed, a: watch(a), b: watch(b), log: false })
                expect(illegal, `${a} vs ${b}`).toEqual([])
            }
        }
    })

    it('have no action rejected by the engine against an opponent that never acts', () => {
        for (const name of ARCHETYPE_NAMES) {
            const result = runMatch({ seed: 1, a: archetypeEntrant(name), b: idler(), maxTicks: 1200 })
            expect(result.stats.a.rejected, name).toBe(0)
            expect(result.stats.a.casts, name).toBeGreaterThanOrEqual(4)
        }
    })

    it('give an identical log for the same seed and profiles, reaction variation included', () => {
        const run = (seed: number) =>
            formatLog(runMatch({ seed, a: archetypeEntrant('bait'), b: archetypeEntrant('defensive') }))
        expect(run(11)).toBe(run(11))
        const logs = new Set([11, 12, 13, 14].map(run))
        expect(logs.size).toBeGreaterThan(1)
    })

    it('smoke: a round robin of a few hundred matches stays fast and every match ends', () => {
        const began = Date.now()
        let matches = 0
        for (const a of ARCHETYPE_NAMES) {
            for (const b of ARCHETYPE_NAMES) {
                for (let seed = 0; seed < 12; seed++) {
                    const result = runMatch({ seed, a: archetypeEntrant(a), b: archetypeEntrant(b), log: false })
                    expect(['death', 'mutual', 'timeout']).toContain(result.reason)
                    matches += 1
                }
            }
        }
        expect(matches).toBe(192)
        expect(Date.now() - began).toBeLessThan(10_000)
    })
})
