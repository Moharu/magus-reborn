import { ENGINE_VERSION, loadoutElement, secondsToTicks, SPELLS, type EffectId, type SpellId } from '@magus/engine'
import { describe, expect, it } from 'vitest'
import fireJson from '../baselines/reborn-0.4.1.json'
import frostJson from '../baselines/reborn-0.4.1-frost.json'
import {
    adaptProfile,
    ARCHETYPE_NAMES,
    ARCHETYPES,
    chillingAfter,
    chillingGain,
    chillingSources,
    clampProfile,
    conditionHolds,
    formatReport,
    formatTable,
    hasChillingSource,
    loadProfile,
    pairList,
    parameterSlots,
    parseBaseline,
    parseCondition,
    parseFireSet,
    planStrategy,
    planTournament,
    priority,
    profileController,
    profileEntrant,
    REPORT_SECTIONS,
    Rng,
    runMatch,
    runTournament,
    selectLoadouts,
    wilsonInterval,
    type ArenaView,
    type ControllerFactory,
    type Entrant,
    type HpLogEntry,
    type MatchEvent,
    type MatchFn,
} from '../src'
import { idler, METEOR_LOADOUT, recording } from './helpers'
import { actionsOf, quietProfile, type RawProfile } from './profile-helpers'

// Frost in the arena (#150): Chilling on the view, Frost rotations built from a Frost loadout, the Chilling rules the
// profiles keep, and Frost entrants facing Fire ones.

const FROST_DEFAULT: SpellId[] = [
    'SPELL_FROSTBOLT',
    'SPELL_GLACIER',
    'SPELL_FROST_BOMB',
    'SPELL_ICE_SPEAR',
    'SPELL_COUNTERSPELL',
    'SPELL_HASTE',
    'SPELL_TEMPORAL_SHIELD',
]
/** Frost Fever and Icy Touch with one builder (Frostbolt) and Frost Bomb. */
const FEVER_TOUCH: SpellId[] = [
    'SPELL_FROSTBOLT',
    'SPELL_FROST_BOMB',
    'SPELL_ICY_TOUCH',
    'SPELL_FROST_FEVER',
    'SPELL_COUNTERSPELL',
    'SPELL_HASTE',
    'SPELL_BLUR',
]
/** No spell that grants Chilling: Ice Spear is a plain nuke here. */
const NO_SOURCE: SpellId[] = [
    'SPELL_FROST_BOMB',
    'SPELL_ICE_SPEAR',
    'SPELL_ICY_TOUCH',
    'SPELL_FROST_FEVER',
    'SPELL_COUNTERSPELL',
    'SPELL_MAGIC_EATER',
    'SPELL_TEMPORAL_SHIELD',
]

// the shipped tables of this engine version (checked against ENGINE_VERSION by the parser)
const fireTable = parseBaseline(fireJson, ENGINE_VERSION)
const frostTable = parseBaseline(frostJson, ENGINE_VERSION, 'FROST')
/** One loadout of each of the 15 Frost sets (their best general pair). */
const FROST_SETS = selectLoadouts(frostTable, 99, 1).loadouts.map(l => l.loadout)

const slot = (loadout: readonly SpellId[], id: SpellId) => loadout.indexOf(id)
const of = (log: readonly MatchEvent[], side: 'a' | 'b', type: MatchEvent['type']) =>
    log.filter(e => e.side === side && e.type === type)

/** Plays a match and returns it with the last view `a` saw (its floating combat text, both sides). */
const watched = (a: Entrant, b: Entrant, seed = 1, maxTicks?: number) => {
    const seen: ArenaView[] = []
    const result = runMatch({
        seed,
        a: { ...a, controller: recording(a.controller, seen) },
        b,
        ...(maxTicks === undefined ? {} : { maxTicks }),
    })
    return { result, last: seen[seen.length - 1] }
}

/** The hits of `spell` on the enemy (its `spell` entries on the floating combat text), in HP. */
const hitsOf = (hpLog: readonly HpLogEntry[] | undefined, spell: SpellId) =>
    (hpLog ?? []).filter(e => e.spellId === spell && e.kind === 'spell').map(e => -e.amount)

const effect = (id: EffectId, tick: number) => ({
    id,
    type: 'negative' as const,
    startingTick: tick - 10,
    expiresAt: tick + 200,
})

/** A hand-built Frost view: every spell ready (cast times from the catalog), `chilling` stacks, the enemy's debuffs. */
const frostView = (
    loadout: readonly SpellId[],
    tick: number,
    { chilling = 0, enemy = [] as EffectId[], casting = null as SpellId | null } = {},
): ArenaView => {
    const castTime = (id: SpellId) => (SPELLS[id].castSeconds ? secondsToTicks(SPELLS[id].castSeconds) : 0)
    const cast = casting && {
        spellId: casting,
        slot: slot(loadout, casting),
        startTick: tick - castTime(casting),
        castTime: castTime(casting),
        completesAt: tick,
    }
    return {
        tick,
        self: {
            hp: 100,
            casting: cast,
            gcdUntil: 0,
            lockedUntil: 0,
            chilling,
            effects: [],
            spells: loadout.map(id => ({
                id,
                castTime: castTime(id),
                cooldownRemaining: 0,
                lockRemaining: 0,
                ready: chilling >= (SPELLS[id].chillingCost ?? 0),
            })),
            log: [],
        },
        enemy: {
            hp: 100,
            casting: null,
            lockedUntil: 0,
            effects: enemy.map(id => effect(id, tick)),
            log: [],
        },
    }
}

const frostProfile = (edit: (raw: RawProfile) => void, loadout: readonly SpellId[]) => {
    const raw = quietProfile()
    raw.rotation = ['SPELL_FROSTBOLT']
    edit(raw)
    return loadProfile(raw, loadout)
}
const started = (loadout: readonly SpellId[], decision: ReturnType<ReturnType<ControllerFactory>>) =>
    actionsOf(decision)
        .filter(a => a.type === 'start')
        .map(a => loadout[a.slot])

describe('the view shows Chilling (#150) to its owner only (#171)', () => {
    it('gives the player the stacks the client HUD shows, and Icy Touch is only ready with a stack', () => {
        const seen: ArenaView[] = []
        const bolts = priority({ order: ['SPELL_FROSTBOLT'] })
        const enemySeen: ArenaView[] = []
        runMatch({
            seed: 1,
            a: { name: 'bolts', loadout: FEVER_TOUCH, controller: recording(bolts, seen) },
            b: { name: 'watcher', loadout: METEOR_LOADOUT, controller: recording(() => () => null, enemySeen) },
            maxTicks: 100,
        })
        const touch = slot(FEVER_TOUCH, 'SPELL_ICY_TOUCH')
        // Frostbolts release on 30, 61, 92 (released on the tick they complete), +1 Chilling each, shown the next tick
        expect(seen[30].self.chilling).toBe(0)
        expect(seen[30].self.spells[touch].ready).toBe(false)
        expect(seen[31].self.chilling).toBe(1)
        expect(seen[31].self.spells[touch].ready).toBe(true)
        expect(seen[100].self.chilling).toBe(3)
        // the opponent never sees them (a Fire player's view of a Frost player), as a player's client never gets them
        for (const view of enemySeen) {
            expect(view.enemy).not.toHaveProperty('chilling')
            expect(JSON.stringify(view.enemy)).not.toContain('hilling')
        }
    })

    it("never shows a Frost player the opponent's Chilling, though the engine has it", () => {
        const seen: ArenaView[] = []
        const boltsSeen: ArenaView[] = []
        const bolts = priority({ order: ['SPELL_FROSTBOLT'] })
        runMatch({
            seed: 1,
            a: { name: 'watcher', loadout: FROST_DEFAULT, controller: recording(() => () => null, seen) },
            b: { name: 'bolts', loadout: FEVER_TOUCH, controller: recording(bolts, boltsSeen) },
            maxTicks: 100,
        })
        expect(boltsSeen.at(-1)!.self.chilling).toBe(3)
        expect(seen).toHaveLength(boltsSeen.length)
        for (const view of seen) {
            expect(Object.keys(view.enemy)).not.toContain('chilling')
            expect(JSON.stringify(view.enemy)).not.toContain('hilling')
            expect(view.self.chilling).toBe(0)
        }
    })

    it('refuses the removed enemyChillingAtLeast condition, which would read the hidden stacks', () => {
        expect(() => parseCondition({ type: 'enemyChillingAtLeast', count: 4 }, 'c')).toThrow(/c\.type.*#171/)
        for (const name of ARCHETYPE_NAMES)
            expect(JSON.stringify(ARCHETYPES[name].profile)).not.toContain('enemyChilling')
    })

    it('plays a Frost loadout against a Fire one, and refuses a loadout that mixes the elements', () => {
        const result = runMatch({
            seed: 1,
            a: profileEntrant(ARCHETYPES.aggressive.profile, FROST_DEFAULT),
            b: idler(),
        })
        expect(result.winner).toBe('a')
        const mixed = [...FROST_DEFAULT]
        mixed[0] = 'SPELL_FIREBALL'
        expect(() => runMatch({ seed: 1, a: { ...idler(), loadout: mixed }, b: idler() })).toThrow(/invalid loadout/)
    })
})

describe('Chilling, measured on the engine (#150)', () => {
    it('reads each spell gain, the cap, Ice Spear spending every stack and Icy Touch spending one', () => {
        expect(chillingSources()).toEqual(['SPELL_FROSTBOLT', 'SPELL_GLACIER'])
        expect(chillingGain('SPELL_FROSTBOLT')).toBe(1)
        expect(chillingGain('SPELL_GLACIER')).toBe(3)
        expect(chillingGain('SPELL_FROST_BOMB')).toBe(0)
        expect(chillingGain('SPELL_FIREBALL')).toBe(0)
        expect(chillingAfter('SPELL_FROSTBOLT', 2)).toBe(3)
        // over the cap of 5, the extra stacks are lost
        expect(chillingAfter('SPELL_GLACIER', 4)).toBe(5)
        expect(chillingAfter('SPELL_FROSTBOLT', 5)).toBe(5)
        expect(chillingAfter('SPELL_ICE_SPEAR', 4)).toBe(0)
        expect(chillingAfter('SPELL_ICY_TOUCH', 3)).toBe(2)
        expect(chillingAfter('SPELL_FROST_FEVER', 3)).toBe(3)
        expect(hasChillingSource(FROST_DEFAULT)).toBe(true)
        expect(hasChillingSource(NO_SOURCE)).toBe(false)
        expect(hasChillingSource(METEOR_LOADOUT)).toBe(false)
    })
})

describe('Chilling conditions (#150)', () => {
    it('parse and read the stacks after this tick release and a loadout without a source', () => {
        const at = parseCondition({ type: 'selfChillingAtLeast', count: 4 }, 'c')
        const below = parseCondition({ type: 'selfChillingBelow', count: 3 }, 'c')
        const none = parseCondition({ type: 'noChillingSource' }, 'c')
        expect(() => parseCondition({ type: 'selfChillingAtLeast' }, 'c')).toThrow(/c\.count/)
        expect(() => parseCondition({ type: 'noChillingSource', count: 1 }, 'c')).toThrow(/unknown key/)
        const view = frostView(FROST_DEFAULT, 10, { chilling: 3 })
        const input = { view, casting: false, nextCast: null }
        expect(conditionHolds(at, input)).toBe(false)
        // a Frostbolt released this tick: 4 stacks, though the view still shows 3
        expect(conditionHolds(at, { ...input, chilling: 4 })).toBe(true)
        expect(conditionHolds(below, input)).toBe(false)
        expect(conditionHolds(below, { ...input, chilling: 2 })).toBe(true)
        expect(conditionHolds(none, { ...input, chillingSource: true })).toBe(false)
        expect(conditionHolds(none, { ...input, chillingSource: false })).toBe(true)
    })

    it('the tuner keeps a Chilling count between 0 and the cap of 5', () => {
        const loaded = frostProfile(raw => {
            raw.rotation = [{ spell: 'SPELL_ICE_SPEAR', when: [{ type: 'selfChillingAtLeast', count: 9 }] }]
        }, FROST_DEFAULT)
        const spear = parameterSlots(loaded).find(s => s.path === 'rotation[0].when[0].count')!
        expect(spear.parameter).toMatchObject({ min: 0, max: 5 })
        expect(clampProfile(loaded).rotation[0].when[0]).toEqual({ type: 'selfChillingAtLeast', count: 5 })
    })
})

describe('Frost rotations built from the loadout (#150)', () => {
    it('every archetype keeps only Frost spells on a Frost loadout and only Fire spells on a Fire one', () => {
        for (const name of ARCHETYPE_NAMES) {
            const { profile } = ARCHETYPES[name]
            for (const loadout of FROST_SETS) {
                const built = adaptProfile(profile, loadout)
                const spells = [...built.rotation, ...built.lockoutWindow.rotation].map(e => e.spell)
                expect(
                    spells.every(id => SPELLS[id].school === 'FROST'),
                    name,
                ).toBe(true)
                // every Frost spell of the loadout has a rotation entry, but Icy Touch with no Chilling source (it
                // could never be cast) or with no Frost Fever (the archetypes only use it with Frost Fever up)
                for (const id of loadout.slice(0, 4)) {
                    const usable =
                        id !== 'SPELL_ICY_TOUCH' ||
                        (hasChillingSource(loadout) && loadout.includes('SPELL_FROST_FEVER'))
                    expect(built.rotation.map(e => e.spell).includes(id), `${name} ${id}`).toBe(usable)
                }
            }
            const fire = adaptProfile(profile, ARCHETYPES[name].loadout)
            expect(
                fire.rotation.every(e => SPELLS[e.spell].school === 'FIRE'),
                name,
            ).toBe(true)
        }
    })

    it('drops an entry that waits on stacks with no Chilling source, but keeps Ice Spear as a plain nuke there', () => {
        const loaded = frostProfile(raw => {
            raw.rotation = [
                { spell: 'SPELL_ICY_TOUCH', when: [{ type: 'selfChillingAtLeast', count: 1 }] },
                {
                    spell: 'SPELL_ICE_SPEAR',
                    when: [
                        {
                            type: 'anyOf',
                            of: [[{ type: 'selfChillingAtLeast', count: 4 }], [{ type: 'noChillingSource' }]],
                        },
                    ],
                },
                'SPELL_FROST_BOMB',
            ]
        }, NO_SOURCE)
        expect(adaptProfile(loaded, NO_SOURCE).rotation.map(e => e.spell)).toEqual([
            'SPELL_ICE_SPEAR',
            'SPELL_FROST_BOMB',
        ])
        // and Ice Spear is cast at 0 stacks for its base hit
        const { last } = watched(profileEntrant(loaded, NO_SOURCE), idler(), 1, 400)
        expect(hitsOf(last.enemy.hpLog, 'SPELL_ICE_SPEAR').length).toBeGreaterThan(0)
    })

    it('with no entry left, the rotation is the loadout own Frost spells in slot order', () => {
        const loaded = loadProfile({ ...quietProfile(), rotation: ['SPELL_METEOR'] }, METEOR_LOADOUT)
        expect(adaptProfile(loaded, FROST_DEFAULT).rotation.map(e => e.spell)).toEqual(FROST_DEFAULT.slice(0, 4))
    })
})

describe('Chilling is built and spent sensibly (#150)', () => {
    // each archetype's Ice Spear threshold outside the free-cast window, from its intent
    const spearAt = { aggressive: 4, 'patient-counter': 5, bait: 5, defensive: 5 } as const

    it('Ice Spear goes off at the archetype high-stack threshold, never early (no Counterspell, so no window)', () => {
        for (const name of ARCHETYPE_NAMES) {
            // the default Frost loadout without Icy Touch or Frost Fever: Frostbolt and Glacier build, Ice Spear spends
            const { result, last } = watched(profileEntrant(ARCHETYPES[name].profile, FROST_DEFAULT), idler(), 1)
            expect(result.winner, name).toBe('a')
            const spears = hitsOf(last.enemy.hpLog, 'SPELL_ICE_SPEAR')
            expect(spears.length, name).toBeGreaterThan(0)
            // 5 HP plus 6.5 per stack spent: never fewer stacks than the threshold
            for (const hit of spears) expect(hit, name).toBeGreaterThanOrEqual(5 + 6.5 * spearAt[name])
        }
    })

    it('Icy Touch only with Frost Fever on the enemy, so every Icy Touch gets the Frost Fever bonus', () => {
        for (const name of ARCHETYPE_NAMES) {
            for (const seed of [1, 2]) {
                const { result, last } = watched(profileEntrant(ARCHETYPES[name].profile, FEVER_TOUCH), idler(), seed)
                const touches = hitsOf(last.enemy.hpLog, 'SPELL_ICY_TOUCH')
                expect(touches.length, name).toBeGreaterThan(0)
                // 3 HP, plus 6 against Frost Fever (the approved numbers)
                expect(new Set(touches), name).toEqual(new Set([9]))
                // the GCD and the stack cost are respected: the engine refuses nothing
                expect(result.stats.a.rejected, name).toBe(0)
            }
        }
    })

    it('reads the stacks this tick release leaves: no Icy Touch after Ice Spear spends them, one after a Frostbolt adds one', () => {
        const loadout: SpellId[] = [
            'SPELL_FROST_FEVER',
            'SPELL_ICE_SPEAR',
            'SPELL_ICY_TOUCH',
            'SPELL_FROSTBOLT',
            'SPELL_COUNTERSPELL',
            'SPELL_MAGIC_EATER',
            'SPELL_TEMPORAL_SHIELD',
        ]
        const loaded = frostProfile(raw => {
            raw.rotation = [
                {
                    spell: 'SPELL_ICY_TOUCH',
                    when: [{ type: 'enemyEffectsAtLeast', effect: 'DEBUFF_FROST_FEVER', count: 1 }],
                },
                'SPELL_FROSTBOLT',
                'SPELL_ICE_SPEAR',
            ]
        }, loadout)
        // the rotation is built as written (an entry the loadout can't play would be dropped, passing trivially)
        expect(adaptProfile(loaded, loadout).rotation.map(e => e.spell)).toEqual([
            'SPELL_ICY_TOUCH',
            'SPELL_FROSTBOLT',
            'SPELL_ICE_SPEAR',
        ])
        const fever = ['DEBUFF_FROST_FEVER' as const]
        // releasing Ice Spear with 2 stacks: they are spent, so Icy Touch would be refused; a Frostbolt starts
        const spent = profileController(loaded)({ loadout, rng: new Rng(1) })(
            frostView(loadout, 50, { chilling: 2, enemy: fever, casting: 'SPELL_ICE_SPEAR' }),
        )
        expect(started(loadout, spent)).toEqual(['SPELL_FROSTBOLT'])
        // releasing a Frostbolt with 0 stacks: it adds one, so Icy Touch goes at once
        const gained = profileController(loaded)({ loadout, rng: new Rng(1) })(
            frostView(loadout, 50, { chilling: 0, enemy: fever, casting: 'SPELL_FROSTBOLT' }),
        )
        expect(started(loadout, gained)).toEqual(['SPELL_ICY_TOUCH'])
    })

    it('never starts a Frost Bomb while its own is still on the enemy, the give-up timer included', () => {
        // the bomb when none is up, else nothing holds: after 0.25 s idle the give-up casts "the first ready entry",
        // which must not be the bomb (a recast replaces it and loses its pulses)
        const loaded = frostProfile(raw => {
            raw.rotation = [
                {
                    spell: 'SPELL_FROST_BOMB',
                    when: [{ type: 'enemyEffectsBelow', effect: 'DEBUFF_FROST_BOMB', count: 1 }],
                },
                { spell: 'SPELL_FROSTBOLT', when: [{ type: 'selfHpBelow', hp: 0 }] },
            ]
            ;(raw as Record<string, unknown>).patience = { thresholdGiveUpSeconds: 0.25, commitGiveUpSeconds: null }
        }, FROST_DEFAULT)
        const { result, last } = watched(profileEntrant(loaded, FROST_DEFAULT), idler(), 1, 600)
        const bombs = of(result.log, 'a', 'SPELL_RELEASE').filter(e => e.spellId === 'SPELL_FROST_BOMB')
        // each bomb lasts 3 pulses of 4 s (240 ticks): a new one only once the last has expired
        for (let i = 1; i < bombs.length; i++) expect(bombs[i].tick - bombs[i - 1].tick).toBeGreaterThanOrEqual(240)
        expect(bombs.length).toBeGreaterThanOrEqual(2)
        // every bomb pulses all 3 times (the last one may still be running when the match ends)
        const pulses = (last.enemy.hpLog ?? []).filter(e => e.spellId === 'SPELL_FROST_BOMB').length
        expect(pulses).toBeGreaterThanOrEqual(3 * (bombs.length - 1))
        // and the give-up did cast the other entry meanwhile
        expect(of(result.log, 'a', 'SPELL_RELEASE').some(e => e.spellId === 'SPELL_FROSTBOLT')).toBe(true)
    })

    it('every archetype on every Frost set gives up its waits: no draw by time against any archetype', () => {
        for (const name of ARCHETYPE_NAMES) {
            for (const loadout of FROST_SETS) {
                const vsIdle = runMatch({ seed: 1, a: profileEntrant(ARCHETYPES[name].profile, loadout), b: idler() })
                expect(vsIdle.reason, `${name} ${loadout.join()}`).toBe('death')
                for (const enemy of ARCHETYPE_NAMES) {
                    const fire = runMatch({
                        seed: 2,
                        a: profileEntrant(ARCHETYPES[name].profile, loadout),
                        b: profileEntrant(ARCHETYPES[enemy].profile, ARCHETYPES[enemy].loadout),
                        log: false,
                    })
                    expect(fire.reason, `${name} vs ${enemy}`).not.toBe('timeout')
                    // the Frost player (player1, acting first) never sends an action the engine refuses; player2 may
                    // lose a same-tick Counterspell race to it, as in any match
                    expect(fire.stats.a.rejected, `${name} vs ${enemy}`).toBe(0)
                }
            }
        }
    })

    it('a real bait is never an instant: with Icy Touch last in the rotation, the bait is the last cast-time entry', () => {
        const loadout = FEVER_TOUCH
        const loaded = frostProfile(raw => {
            raw.rotation = ['SPELL_FROST_BOMB', 'SPELL_FROSTBOLT', 'SPELL_ICY_TOUCH']
            Object.assign(raw.fakeCast, {
                enabled: true,
                spell: 'SPELL_FROST_BOMB',
                realBaitShare: 1,
                minGapSeconds: 0,
            })
        }, loadout)
        const decision = profileController(loaded)({ loadout, rng: new Rng(1) })(
            frostView(loadout, 50, { chilling: 2, enemy: ['DEBUFF_FROST_FEVER'] }),
        )
        expect(started(loadout, decision)).toEqual(['SPELL_FROSTBOLT'])
    })
})

describe('Counterspell on Frost casts follows the visible-cast values (#146, #150)', () => {
    it('a Fire aggressive counters an enemy Glacier (3.5 s unseen: 24.5 HP) but lets Frostbolts (10.5 HP) through', () => {
        const caster = (spell: SpellId): Entrant => ({
            name: spell,
            loadout: FROST_DEFAULT,
            controller: priority({ order: [spell] }),
        })
        const aggressive = profileEntrant(ARCHETYPES.aggressive.profile, ARCHETYPES.aggressive.loadout)
        const glacier = runMatch({ seed: 1, a: caster('SPELL_GLACIER'), b: aggressive, maxTicks: 100 })
        expect(of(glacier.log, 'a', 'INTERRUPTED').map(e => e.spellId)).toEqual(['SPELL_GLACIER'])
        // Frostbolts are below minValue 12; the 8 s give-up (160 ticks) makes the next one a target only after that
        const bolts = runMatch({ seed: 1, a: caster('SPELL_FROSTBOLT'), b: aggressive, maxTicks: 150 })
        expect(of(bolts.log, 'a', 'INTERRUPTED')).toEqual([])
    })
})

describe('Frost sets in strategy mode (#150)', () => {
    it('--fire-set accepts four Frost spells and rejects a mixed set', () => {
        expect(parseFireSet('frostbolt,glacier,frost-bomb,ice-spear')).toEqual(FROST_DEFAULT.slice(0, 4))
        expect(() => parseFireSet('frostbolt,glacier,frost-bomb,fireball')).toThrow(/not four distinct Fire spells/)
    })

    it('labels a Frost set I<n>, marks its element and takes its dummy baseline from the Frost table', () => {
        const { config } = planStrategy({
            baseline: fireTable,
            frostBaseline: frostTable,
            fireSets: [fireTable.loadouts[0].loadout.slice(0, 4), FROST_DEFAULT.slice(0, 4)],
            profiles: [ARCHETYPES.aggressive.profile, ARCHETYPES.bait.profile],
            seeds: 1,
            games: 2,
        })
        expect(config.fireSets[0]).not.toHaveProperty('element')
        expect(config.fireSets[1]).toMatchObject({ element: 'FROST', baseline: { rank: 1 } })
        expect(config.setups.map(s => s.id.split('/')[0])).toEqual([...Array(6).fill('F1'), ...Array(6).fill('I2')])
        expect(config.setups[6].loadout).toEqual([
            ...FROST_DEFAULT.slice(0, 4),
            'SPELL_COUNTERSPELL',
            'SPELL_HASTE',
            'SPELL_BLUR',
        ])
    })
})

describe('the shipped Frost baseline (#159, #150)', () => {
    it('is the Frost table of this engine version: 90 loadouts of the 15 Frost sets, best under pressure first', () => {
        expect(frostTable.element).toBe('FROST')
        expect(frostTable.version).toBe(ENGINE_VERSION)
        expect(frostTable.loadouts).toHaveLength(90)
        expect(FROST_SETS).toHaveLength(15)
        const rates = frostTable.loadouts.map(l => l.dpsUnderPressure)
        expect(rates).toEqual([...rates].sort((a, b) => b - a))
        // the Fire table has no element key and is Fire
        expect(fireTable.element).toBe('FIRE')
    })

    it('the parser is element-aware: a Frost loadout is not a Fire one, and the expected element is checked', () => {
        const raw = JSON.parse(JSON.stringify(frostJson)) as Record<string, unknown>
        const { element: _element, ...asFire } = raw
        expect(() => parseBaseline(asFire)).toThrow(/loadouts\[0\]\.loadout: is not a valid FIRE loadout/)
        expect(() => parseBaseline(raw, ENGINE_VERSION, 'FIRE')).toThrow(/element: is FROST, expected FIRE/)
        expect(() => parseBaseline({ ...raw, element: 'WATER' })).toThrow(/element: must be one of/)
    })
})

describe('Fire faces Frost in the tournament (#150)', () => {
    const profiles = [ARCHETYPES.aggressive.profile, ARCHETYPES.bait.profile]
    const options = { baseline: fireTable, frostBaseline: frostTable, top: 2, generalPairs: 1, profiles, games: 2 }

    it('takes the top N Frost sets alongside the Fire sets, labelled I<rank>, and pairs every Fire entrant with every Frost one', () => {
        const { config } = planTournament(options)
        expect(config.entrants.map(e => e.id)).toEqual([
            'L01/aggressive',
            'L01/bait',
            'L04/aggressive',
            'L04/bait',
            'I01/aggressive',
            'I01/bait',
            'I04/aggressive',
            'I04/bait',
        ])
        expect(config.entrants.filter(e => e.element === 'FROST').map(e => e.loadout.slice(0, 4))).toEqual([
            frostTable.loadouts[0].loadout.slice(0, 4),
            frostTable.loadouts[0].loadout.slice(0, 4),
            frostTable.loadouts[3].loadout.slice(0, 4),
            frostTable.loadouts[3].loadout.slice(0, 4),
        ])
        expect(config.frost).toEqual({ top: { requested: 2, used: 2 } })
        expect(config.loadouts.map(l => `${l.element ?? 'FIRE'} ${l.rank}`)).toEqual([
            'FIRE 1',
            'FIRE 4',
            'FROST 1',
            'FROST 4',
        ])
        const cross = pairList(config.entrants.length).filter(
            ([a, b]) => config.entrants[a].element !== config.entrants[b].element,
        )
        expect(cross).toHaveLength(4 * 4)
        // frostTop sets the Frost count on its own; 0 (or no Frost table) is the Fire-only tournament as before #150
        expect(planTournament({ ...options, frostTop: 1 }).config.frost).toEqual({ top: { requested: 1, used: 1 } })
        const fireOnly = planTournament({ ...options, frostBaseline: undefined }).config
        expect(planTournament({ ...options, frostTop: 0 }).config).toEqual(fireOnly)
        expect(fireOnly).not.toHaveProperty('frost')
        expect(fireOnly.entrants.every(e => !('element' in e))).toBe(true)
    })

    it('refuses tables of the wrong element or of another version', () => {
        expect(() => planTournament({ ...options, baseline: frostTable })).toThrow(/baseline must be the Fire table/)
        expect(() => planTournament({ ...options, frostBaseline: fireTable })).toThrow(
            /frostBaseline must be the Frost/,
        )
        expect(() => planTournament({ ...options, frostBaseline: { ...frostTable, version: 'other' } })).toThrow(
            /one version/,
        )
    })

    it('plays real matches between the elements: a Frost entrant meets a Fire one on the real engine', () => {
        const plan = planTournament({ ...options, top: 1, profiles: [ARCHETYPES.aggressive.profile] })
        const result = runTournament(plan)
        expect(result.games).toBe(2)
        expect(result.ranking.map(r => r.id).sort()).toEqual(['I01/aggressive', 'L01/aggressive'])
        expect(result.ranking.reduce((sum, r) => sum + r.wins + r.draws / 2, 0)).toBe(2)
    })

    /** Frost wins every game against Fire; within an element, player1 wins. */
    const frostWins: MatchFn = ({ a, b, seed }) => {
        const winner =
            loadoutElement([...a.loadout]) === loadoutElement([...b.loadout])
                ? 'a'
                : loadoutElement([...a.loadout]) === 'FROST'
                  ? 'a'
                  : 'b'
        return {
            seed,
            winner,
            reason: 'death',
            ticks: 1,
            hp: { a: 0, b: 0 },
            stats: { a: emptySide(), b: emptySide() },
            log: [],
        }
    }
    const emptySide = () => ({
        casts: 0,
        started: 0,
        cancelled: 0,
        interrupts: 0,
        interrupted: 0,
        rejected: 0,
        damageTaken: 0,
    })

    it('reports Fire vs Frost win rates with 95% Wilson intervals in an Elements section', () => {
        const result = runTournament(planTournament(options), frostWins)
        const text = formatReport(result, { date: '2026-11-09' })
        expect([...text.matchAll(/^## (.+)$/gm)].map(m => m[1])).toEqual([...REPORT_SECTIONS])
        expect(REPORT_SECTIONS).toContain('Elements')
        const section = text.slice(text.indexOf('## Elements'), text.indexOf('## General pairs'))
        // 16 cross pairs x 2 games: Frost wins all 32
        const ci = wilsonInterval(0, 32)
        const frostCi = wilsonInterval(32, 32)
        const pct = (x: number) => `${(x * 100).toFixed(1)}%`
        expect(section).toContain(`| Fire | Frost | 4 | 0 | 0 | 32 | 0.0% | ${pct(ci.low)}-${pct(ci.high)} |`)
        expect(section).toContain(
            `| Frost | Fire | 4 | 32 | 0 | 32 | 100.0% | ${pct(frostCi.low)}-${pct(frostCi.high)} |`,
        )
        // per profile: its 2 Fire entrants against the 4 Frost entrants, and its 2 Frost entrants against the 4 Fire ones
        expect(section).toMatch(/\| aggressive \| 0\.0% \(0\.0%-\d+\.\d%\) \| 100\.0% \(\d+\.\d%-100\.0%\) \|/)
        // the loadouts show their element's label and table
        expect(text).toContain('| I01 | Frostbolt, Glacier, Frost Bomb, Ice Spear |')
        expect(text).toContain(`baselines/${ENGINE_VERSION}-frost.json`)
        expect(text).toContain('top 2 Fire sets and top 2 Frost sets')
        expect(formatTable(result)).toContain('I01  Frostbolt, Glacier, Frost Bomb, Ice Spear | Counterspell |')
    })

    it('rates each element on its cross-element games only; same-element games are listed apart (#163)', () => {
        const result = runTournament(planTournament(options), frostWins)
        const text = formatReport(result, { date: '2026-11-09' })
        const section = text.slice(text.indexOf('### All games'), text.indexOf('## General pairs'))
        const pct = (x: number) => `${(x * 100).toFixed(1)}%`
        // 4 Fire and 4 Frost entrants x 2 games a pair: 32 cross games, and 6 same-element pairs (12 games) in each element.
        // The same-element games are fixed 0.5 trials: they are left out of the rate and the interval
        const fire = wilsonInterval(0, 32)
        const frost = wilsonInterval(32, 32)
        expect(section).toContain(
            '| Element | Entrants | Wins | Draws | Games | Win rate | 95% CI | Same-element games |',
        )
        expect(section).toContain(`| Fire | 4 | 0 | 0 | 32 | 0.0% | ${pct(fire.low)}-${pct(fire.high)} | 12 |`)
        expect(section).toContain(`| Frost | 4 | 32 | 0 | 32 | 100.0% | ${pct(frost.low)}-${pct(frost.high)} | 12 |`)
    })

    it('does not let drawn same-element games into the draws or the interval (#163)', () => {
        const drawsInside: MatchFn = input => {
            const sameElement = loadoutElement([...input.a.loadout]) === loadoutElement([...input.b.loadout])
            const result = frostWins(input)
            return sameElement ? { ...result, winner: 'draw', reason: 'timeout' } : result
        }
        const result = runTournament(planTournament(options), drawsInside)
        const text = formatReport(result, { date: '2026-11-09' })
        const section = text.slice(text.indexOf('### All games'), text.indexOf('## General pairs'))
        const pct = (x: number) => `${(x * 100).toFixed(1)}%`
        const fire = wilsonInterval(0, 32)
        expect(section).toContain(`| Fire | 4 | 0 | 0 | 32 | 0.0% | ${pct(fire.low)}-${pct(fire.high)} | 12 |`)
    })

    it('says so when the run is Fire only', () => {
        const result = runTournament(planTournament({ ...options, frostTop: 0 }), frostWins)
        const text = formatReport(result, { date: '2026-11-09' })
        expect(text).toContain('## Elements\n\nFire entrants only: no cross-element games.')
    })
})
