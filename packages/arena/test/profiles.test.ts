import { secondsToTicks, type SpellId } from '@magus/engine'
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
import { entrant, idler, METEOR_LOADOUT, OTHER_LOADOUT, recording, scripted, slotOf } from './helpers'
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
    })

    it('rejects out-of-range and malformed values, naming the key', () => {
        rejects(raw => (raw.counterspell.reaction.meanSeconds = 11), 'counterspell.reaction.meanSeconds')
        rejects(raw => (raw.counterspell.reaction.spreadSeconds = -0.1), 'counterspell.reaction.spreadSeconds')
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
    })

    it('rejects, at load time, a rotation spell that is not on the loadout instead of skipping it', () => {
        expect(OTHER_LOADOUT).not.toContain('SPELL_METEOR')
        const raw = quietProfile()
        raw.rotation = ['SPELL_FIREBALL', 'SPELL_METEOR']
        expect(() => loadProfile(raw, METEOR_LOADOUT)).not.toThrow()
        expect(() => loadProfile(raw, OTHER_LOADOUT)).toThrow(/^rotation\[1\]: SPELL_METEOR is not on the loadout/)
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

    it('lets casts of spells it does not target through', () => {
        const fireballs = entrant('fireballs', profileController(profile(raw => (raw.rotation = ['SPELL_FIREBALL']))))
        const result = runMatch({ seed: 1, a: fireballs, b: counterer('early', 0.2), maxTicks: 200 })
        expect(of(result.log, 'b', 'SPELL_RELEASE')).toEqual([])
        expect(result.stats.a.casts).toBeGreaterThan(5)
    })

    it('commits later in the cast once Counterspell will be ready in time', () => {
        // b counters the tick-0 Meteor on tick 11, then is on cooldown (11.7 s = 234 ticks) until tick 245
        const meteors = entrant('meteors', profileController(profile(raw => (raw.rotation = ['SPELL_METEOR']))))
        const result = runMatch({ seed: 1, a: meteors, b: counterer('early', 0.5), maxTicks: 400 })
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

    it('makes no fake cast when disabled', () => {
        const meteors = player('meteors', raw => (raw.rotation = ['SPELL_METEOR']))
        const result = runMatch({ seed: 1, a: meteors, b: idler(), maxTicks: 100 })
        expect(result.stats.a).toMatchObject({ cancelled: 0, casts: 1 })
    })

    it('the bait archetype fake-casts against a reactive Counterspell in a seeded match', () => {
        for (const seed of [1, 2, 3]) {
            const result = runMatch({ seed, a: archetypeEntrant('bait'), b: archetypeEntrant('aggressive') })
            const fakes = fakeCasts(result.log, 'a', 'SPELL_METEOR')
            expect(fakes.length).toBeGreaterThanOrEqual(1)
            // at least one of the enemy's Counterspells hit nothing
            const wasted = of(result.log, 'b', 'SPELL_RELEASE').filter(
                e =>
                    e.spellId === 'SPELL_COUNTERSPELL' &&
                    !result.log.some(i => i.tick === e.tick && i.side === 'a' && i.type === 'INTERRUPTED'),
            )
            expect(wasted.length).toBeGreaterThanOrEqual(1)
        }
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
            expect(result.stats.a.casts, name).toBeGreaterThan(5)
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
