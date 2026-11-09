import { describe, expect, it } from 'vitest'
import {
    ARCHETYPES,
    breedSeed,
    clampProfile,
    clampValue,
    CONDITION_PARAMETERS,
    EDGE_GREED_MAX_SECONDS,
    crossoverProfiles,
    formatTuning,
    getAt,
    loadProfile,
    MUTATION_RATE,
    mutateProfile,
    parameterSlots,
    parseProfile,
    PROFILE_PARAMETERS,
    REACTION_MIN_SECONDS,
    Rng,
    runMatch,
    scorer,
    shapeKey,
    tune,
    tunedProfile,
    type Baseline,
    type MatchFn,
    type NumberParameter,
    type Profile,
    type TuningOptions,
} from '../src'
import { METEOR_LOADOUT, OTHER_LOADOUT } from './helpers'

const baseline: Baseline = {
    version: 'test',
    loadouts: [
        { rank: 1, loadout: METEOR_LOADOUT, dps: 40, dpsUnderPressure: 30 },
        { rank: 2, loadout: OTHER_LOADOUT, dps: 35, dpsUnderPressure: 31 },
    ],
}
const { aggressive, bait, defensive, 'patient-counter': patient } = ARCHETYPES
const archetypes = [aggressive, bait, defensive, patient].map(a => a.profile)

/**
 * Tiny runs: each profile plays its 2 entrants (one per loadout) against the 2 field entrants, 2 games a pair: 8 matches
 * per profile, each at most 30 s of game time.
 */
const tiny = (extra: Partial<TuningOptions> = {}) =>
    tune({
        baseline,
        seeds: archetypes,
        field: [aggressive.profile],
        top: 2,
        generalPairs: 1,
        games: 2,
        maxTicks: 600,
        seed: 11,
        population: 4,
        generations: 2,
        elite: 1,
        ...extra,
    })

const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

/** Sets the value at a slot path in a plain copy (for building out-of-bounds input). */
const withValue = (profile: Profile, path: string, value: unknown) => {
    const out = copy(profile) as unknown as Record<string, unknown>
    const keys = path.split(/\.|(?=\[)/).map(k => (k.startsWith('[') ? Number(k.slice(1, -1)) : k))
    let node = out as Record<string | number, unknown>
    for (const key of keys.slice(0, -1)) node = node[key] as Record<string | number, unknown>
    node[keys[keys.length - 1]] = value
    return out as unknown as Profile
}

const inBounds = (profile: Profile) => {
    for (const { path, parameter } of parameterSlots(profile)) {
        const value = getAt(profile, path)
        if (parameter.kind === 'choice') expect(parameter.options, path).toContain(value)
        else {
            expect(value, path).toBeGreaterThanOrEqual(parameter.min)
            expect(value, path).toBeLessThanOrEqual(parameter.max)
        }
    }
    expect(profile.counterspell.reaction.spreadSeconds).toBeLessThanOrEqual(profile.counterspell.reaction.meanSeconds)
}

describe('tunable parameter schema', () => {
    it('declares bounds for every parameter, all inside what the profile loader accepts', () => {
        for (const profile of archetypes) {
            const slots = parameterSlots(profile)
            expect(slots.length).toBeGreaterThan(Object.keys(PROFILE_PARAMETERS).length)
            for (const end of ['min', 'max'] as const) {
                let p = profile
                for (const { path, parameter } of slots)
                    if (parameter.kind === 'number') p = withValue(p, path, parameter[end])
                // spread may not exceed mean, so at the max end the clamp lowers it to the mean
                expect(() => parseProfile(clampProfile(p))).not.toThrow()
            }
        }
        for (const parameter of [...Object.values(PROFILE_PARAMETERS), ...Object.values(CONDITION_PARAMETERS)])
            if (parameter.kind === 'number') expect(parameter.min).toBeLessThan(parameter.max)
            else expect(parameter.options.length).toBeGreaterThanOrEqual(2)
    })

    it('lists condition fields by path, wherever the profile has them', () => {
        const paths = parameterSlots(defensive.profile).map(s => s.path)
        expect(paths).toContain('rotation[0].when[0].count')
        expect(paths).toContain('generals.SPELL_TEMPORAL_SHIELD.when[0].seconds')
        expect(paths).toContain('generals.SPELL_MAGIC_EATER.when[1].count')
        expect(paths).not.toContain('generals.SPELL_HASTE.when[0].seconds') // "never": no conditions
    })

    it('leaves the archetypes as they are: they are inside the bounds', () => {
        for (const profile of archetypes) expect(clampProfile(profile)).toEqual(profile)
    })

    it('clamps out-of-bounds values to the bounds and rounds to the precision', () => {
        const mean = PROFILE_PARAMETERS['counterspell.reaction.meanSeconds'] as NumberParameter
        const count = CONDITION_PARAMETERS.count
        expect(clampValue(mean, 9)).toBe(mean.max)
        expect(clampValue(mean, 0)).toBe(mean.min)
        expect(clampValue(mean, 0.4449)).toBe(0.44)
        expect(clampValue(count, 99)).toBe(count.max)
        expect(clampValue(count, 2.6)).toBe(3)
        expect(clampValue(PROFILE_PARAMETERS['counterspell.timing'], 'never')).toBe('early')

        let p = withValue(aggressive.profile, 'counterspell.reaction.meanSeconds', 7)
        p = withValue(p, 'fakeCast.maxPerMatch', -5)
        p = withValue(p, 'fakeCast.minGapSeconds', 500)
        p = withValue(p, 'rotation[0].when[0].count', 1000)
        p = withValue(p, 'counterspell.reaction.spreadSeconds', 0.3)
        p = withValue(p, 'fakeCast.cancelAfterSeconds', 0)
        p = withValue(p, 'fakeCast.pauseAfterSeconds', 0)
        p = withValue(p, 'fakeCast.realBaitShare', 3)
        const clamped = clampProfile(p)
        expect(clamped.counterspell.reaction.meanSeconds).toBe(1.5)
        expect(clamped.fakeCast.maxPerMatch).toBe(0)
        expect(clamped.fakeCast.minGapSeconds).toBe(60)
        expect(getAt(clamped, 'rotation[0].when[0].count')).toBe(20)
        // a fake cast and the pause after it last at least one standard reaction time (0.25 s)
        expect(clamped.fakeCast.cancelAfterSeconds).toBe(0.25)
        expect(clamped.fakeCast.pauseAfterSeconds).toBe(0.25)
        expect(clamped.fakeCast.realBaitShare).toBe(1)
        expect(clamped.counterspell.reaction.spreadSeconds).toBe(0.3) // 0.3 <= 1.5: kept

        const spread = clampProfile(withValue(aggressive.profile, 'counterspell.reaction.spreadSeconds', 0.45))
        expect(spread.counterspell.reaction.spreadSeconds).toBe(0.35) // above the 0.35 mean: lowered to it
    })
})

describe('tuning bounds (#123)', () => {
    it('never tunes counterspell.enabled: everyone has Counterspell', () => {
        expect(Object.keys(PROFILE_PARAMETERS)).not.toContain('counterspell.enabled')
        const off = { ...aggressive.profile, counterspell: { ...aggressive.profile.counterspell, enabled: false } }
        for (const profile of [...archetypes, off]) {
            expect(parameterSlots(profile).map(s => s.path)).not.toContain('counterspell.enabled')
            for (let i = 0; i < 40; i++) {
                const rng = new Rng(i)
                // a high rate: every declared parameter is likely to move
                expect(mutateProfile(profile, rng, 0.9).counterspell.enabled).toBe(profile.counterspell.enabled)
                expect(crossoverProfiles(profile, off, rng).counterspell.enabled).toBe(profile.counterspell.enabled)
            }
        }
    })

    it('keeps fake-cast cancel and pause at least one reaction time (0.25 s), clamped', () => {
        expect(REACTION_MIN_SECONDS).toBe(0.25)
        for (const path of [
            'fakeCast.cancelAfterSeconds',
            'fakeCast.pauseAfterSeconds',
            'counterspell.reaction.meanSeconds',
        ])
            expect((PROFILE_PARAMETERS[path] as NumberParameter).min, path).toBe(REACTION_MIN_SECONDS)
        for (const value of [0, 0.05, 0.1, 0.24])
            for (const path of ['fakeCast.cancelAfterSeconds', 'fakeCast.pauseAfterSeconds'])
                expect(getAt(clampProfile(withValue(bait.profile, path, value)), path), `${path} ${value}`).toBe(0.25)
        expect(
            clampProfile(withValue(bait.profile, 'fakeCast.pauseAfterSeconds', 0.3)).fakeCast.pauseAfterSeconds,
        ).toBe(0.3)
        // mutation never goes below it either
        for (let i = 0; i < 60; i++) {
            const mutant = mutateProfile(bait.profile, new Rng(i), 0.9)
            expect(mutant.fakeCast.cancelAfterSeconds).toBeGreaterThanOrEqual(0.25)
            expect(mutant.fakeCast.pauseAfterSeconds).toBeGreaterThanOrEqual(0.25)
        }
    })

    it('tunes the bait style and the window conditions within bounds', () => {
        expect(PROFILE_PARAMETERS['fakeCast.realBaitShare']).toMatchObject({ kind: 'number', min: 0, max: 1 })
        expect(clampValue(PROFILE_PARAMETERS['fakeCast.realBaitShare'], -1)).toBe(0)
        const paths = parameterSlots(aggressive.profile).map(s => s.path)
        expect(paths).toContain('fakeCast.realBaitShare')
        expect(paths).toContain('lockoutWindow.rotation[1].when[0].count')
        const seen = new Set<number>()
        for (let i = 0; i < 60; i++) seen.add(mutateProfile(bait.profile, new Rng(i), 0.9).fakeCast.realBaitShare)
        expect(seen.size).toBeGreaterThan(3)
        for (const share of seen) expect(share >= 0 && share <= 1).toBe(true)
    })
})

describe('edge greed (#126)', () => {
    const GREED = 'lockoutWindow.edgeGreedSeconds'

    it('is tunable in [0, 1.5] s, the range the loader accepts, and clamped to it', () => {
        expect(PROFILE_PARAMETERS[GREED]).toMatchObject({ kind: 'number', min: 0, max: EDGE_GREED_MAX_SECONDS })
        expect(EDGE_GREED_MAX_SECONDS).toBe(1.5)
        for (const profile of archetypes) {
            expect(parameterSlots(profile).map(s => s.path)).toContain(GREED)
            // the shipped archetypes keep the #123 window: no greed
            expect(profile.lockoutWindow.edgeGreedSeconds).toBe(0)
        }
        expect(clampProfile(withValue(aggressive.profile, GREED, 4)).lockoutWindow.edgeGreedSeconds).toBe(1.5)
        expect(clampProfile(withValue(aggressive.profile, GREED, -1)).lockoutWindow.edgeGreedSeconds).toBe(0)
        expect(clampValue(PROFILE_PARAMETERS[GREED], 0.704)).toBe(0.7)
    })

    it('mutation explores it within bounds, and the tuned profile loads', () => {
        const seen = new Set<number>()
        for (let i = 0; i < 60; i++) {
            const mutant = mutateProfile(bait.profile, new Rng(i), 0.9)
            seen.add(mutant.lockoutWindow.edgeGreedSeconds!)
            expect(loadProfile(copy(mutant), bait.loadout)).toEqual(mutant)
        }
        expect(seen.size).toBeGreaterThan(3)
        for (const greed of seen) expect(greed >= 0 && greed <= EDGE_GREED_MAX_SECONDS).toBe(true)
    })
})

describe('mutation and crossover', () => {
    const others = (profile: Profile) => archetypes.filter(p => p !== profile)

    it('change only declared parameters, keep them in bounds, and always give a loadable profile', () => {
        for (const profile of archetypes)
            for (let i = 0; i < 60; i++) {
                const rng = new Rng(i)
                const mutant = mutateProfile(profile, rng, MUTATION_RATE)
                expect(shapeKey(mutant)).toBe(shapeKey(profile))
                expect(mutant.name).toBe(profile.name)
                inBounds(mutant)
                expect(parseProfile(copy(mutant))).toEqual(mutant)
                // a mutant always differs in at least one declared parameter
                expect(parameterSlots(profile).some(({ path }) => getAt(mutant, path) !== getAt(profile, path))).toBe(
                    true,
                )

                for (const partner of [mutateProfile(profile, rng, 0.5), ...others(profile)]) {
                    const child = crossoverProfiles(profile, partner, rng)
                    expect(shapeKey(child)).toBe(shapeKey(profile))
                    inBounds(child)
                    expect(parseProfile(copy(child))).toEqual(child)
                    for (const { path, condition } of parameterSlots(profile)) {
                        const value = getAt(child, path)
                        if (condition && shapeKey(partner) !== shapeKey(profile))
                            expect(value, path).toBe(getAt(profile, path))
                        else expect([getAt(profile, path), getAt(partner, path)], path).toContain(value)
                    }
                }
            }
    })

    it('crossover of two same-shape parents mixes their values', () => {
        const a = aggressive.profile
        const b = clampProfile(withValue(withValue(a, 'rotation[0].when[0].count', 9), 'fakeCast.minGapSeconds', 40))
        const seen = new Set<string>()
        for (let i = 0; i < 40; i++) {
            const child = crossoverProfiles(a, b, new Rng(i))
            seen.add(`${getAt(child, 'rotation[0].when[0].count')}/${child.fakeCast.minGapSeconds}`)
        }
        expect(seen).toEqual(new Set(['4/12', '9/12', '4/40', '9/40']))
    })

    it('are pure functions of the stream', () => {
        expect(mutateProfile(bait.profile, new Rng(5), MUTATION_RATE)).toEqual(
            mutateProfile(bait.profile, new Rng(5), MUTATION_RATE),
        )
        expect(mutateProfile(bait.profile, new Rng(5), MUTATION_RATE)).not.toEqual(
            mutateProfile(bait.profile, new Rng(6), MUTATION_RATE),
        )
    })
})

describe('scoring', () => {
    const options = {
        baseline,
        field: [aggressive.profile, bait.profile],
        top: 2,
        generalPairs: 1,
        games: 2,
        maxTicks: 600,
    }
    const recording = (seeds: number[]): MatchFn => {
        return match => {
            seeds.push(match.seed)
            return runMatch(match)
        }
    }

    it("plays the profile's row of the #103 round-robin against the field, on the same seeds for any profile", () => {
        const seen: number[][] = [[], []]
        const first = scorer({ ...options, run: recording(seen[0]) }, 99)
        const second = scorer({ ...options, run: recording(seen[1]) }, 99)
        const a = first.score(defensive.profile)
        second.score(mutateProfile(patient.profile, new Rng(1), 0.5))
        // 2 loadouts x (2 loadouts x 2 field profiles) pairs x 2 games
        expect(first.matches).toBe(16)
        expect(seen[0]).toEqual(seen[1])
        expect(new Set(seen[0])).toEqual(first.seeds())
        expect(a.games).toBe(16)
        expect(a.perLoadout.map(l => l.rank)).toEqual([1, 2])
        expect(a.perLoadout.reduce((s, l) => s + l.wins, 0)).toBe(a.wins)
        expect(a.winRate).toBe(a.wins / a.games)
        expect(first.score(defensive.profile)).toEqual(a) // pure
    })
})

describe('tune', () => {
    it('population 4, 2 generations: two runs with the same seed give the same final population', () => {
        const one = tiny()
        const two = tiny()
        expect(two).toEqual(one)
        expect(one.population).toHaveLength(4)
        expect(one.generations).toHaveLength(2)
        expect(one.partial).toBe(false)
        const other = tiny({ seed: 12 })
        expect(other.config.selectionSeed).not.toBe(one.config.selectionSeed)
        expect(other.population.map(p => p.profile)).not.toEqual(one.population.map(p => p.profile))
    })

    it('draws each member from a stream seeded by S, the generation and the index', () => {
        const result = tiny({ seeds: [bait.profile], population: 3, generations: 1, elite: 0 })
        const members = result.population.map(p => p.profile)
        for (const i of [1, 2]) {
            const expected = mutateProfile(bait.profile, new Rng(breedSeed(11, 0, i)), MUTATION_RATE)
            expect(members).toContainEqual({ ...expected, name: `g0-${i}` })
        }
        expect(members).toContainEqual(bait.profile)
        expect(new Set([breedSeed(11, 0, 1), breedSeed(11, 1, 0), breedSeed(12, 0, 1)]).size).toBe(3)
    })

    it('elitism: the top K pass unchanged, keep their score, and the best never drops', () => {
        const seeds: number[] = []
        const run: MatchFn = match => {
            seeds.push(match.seed)
            return runMatch(match)
        }
        const result = tiny({ population: 5, generations: 4, elite: 2, run })
        expect(result.generations).toHaveLength(4)
        for (let g = 1; g < result.generations.length; g++) {
            const before = result.generations[g - 1].ranking
            const now = result.generations[g].ranking
            for (const elite of before.slice(0, 2)) expect(now).toContainEqual(elite)
            expect(result.generations[g].best).toBeGreaterThanOrEqual(result.generations[g - 1].best)
            // every other member is a new child of this generation
            expect(now.filter(m => m.profile.name.startsWith(`g${g}-`))).toHaveLength(3)
        }
        // every generation scores on the same match seed set: each scored profile played exactly the selection seeds
        const { config } = result
        const fresh = scorer(
            { baseline, field: [aggressive.profile], top: 2, generalPairs: 1, games: 2, maxTicks: 600, run: runMatch },
            config.selectionSeed,
        )
        const selection = fresh.seeds()
        const scored = (result.matches - config.matchesPerProfile) / config.matchesPerProfile
        const counts = new Map<number, number>()
        for (const s of seeds.slice(0, seeds.length - config.matchesPerProfile)) counts.set(s, (counts.get(s) ?? 0) + 1)
        expect(new Set(counts.keys())).toEqual(selection)
        for (const n of counts.values()) expect(n).toBe(scored)
        // and an elite's carried score is what a fresh scoring gives
        const best = result.generations[3].ranking[0]
        expect(fresh.score(best.profile)).toEqual(best.score)
    })

    it('elite K is configurable: with 0 nothing is carried over', () => {
        const result = tiny({ population: 4, generations: 2, elite: 0 })
        expect(result.generations[1].ranking.every(m => m.profile.name.startsWith('g1-'))).toBe(true)
        expect(result.config.elite).toBe(0)
        expect(() => tiny({ elite: 4 })).toThrow(/elite/)
    })

    it('reports best, median and worst win rate per generation, and the best profile per loadout', () => {
        const result = tiny({ population: 5 })
        for (const g of result.generations) {
            const rates = g.ranking.map(m => m.score.winRate)
            expect(g.best).toBe(Math.max(...rates))
            expect(g.worst).toBe(Math.min(...rates))
            expect(g.median).toBe([...rates].sort((a, b) => a - b)[2])
        }
        const text = formatTuning(result)
        const lines = text.split('\n')
        expect(lines[1].split(/\s{2,}/).map(s => s.trim())).toEqual([
            'gen',
            'best',
            'median',
            'worst',
            'best profile',
            'L01',
            'L02',
        ])
        const top = result.generations[1].ranking[0]
        const row = lines[3]
        expect(row).toContain(top.profile.name)
        for (const l of top.score.perLoadout) expect(row).toContain(`${(l.winRate * 100).toFixed(1)}%`)
        expect(text).toContain('L01  Meteor, Fireball, Ignite, Combustion | Counterspell | Haste, Blur')
    })

    it('median of an even population is the mean of the two middle win rates', () => {
        const g = tiny().generations[0]
        const sorted = g.ranking.map(m => m.score.winRate).sort((a, b) => a - b)
        expect(g.median).toBe((sorted[1] + sorted[2]) / 2)
    })

    it('writes the best profile as profile JSON the #102 loader accepts', () => {
        const result = tiny()
        const out = JSON.parse(JSON.stringify(tunedProfile(result))) as unknown
        const parsed = parseProfile(out)
        expect(parsed.name).toBe(`${result.best.origin}-tuned-s11`)
        expect(parsed.intent).toMatch(/on the selection seeds, .* on fresh seeds\.$/)
        const { name: _n, intent: _i, ...behaviour } = parsed
        const { name: _bn, intent: _bi, ...bestBehaviour } = result.best.profile
        expect(behaviour).toEqual(bestBehaviour)
        const origin = Object.values(ARCHETYPES).find(a => a.profile.name === result.best.origin)!
        expect(() => loadProfile(out, origin.loadout)).not.toThrow()
    })

    it('re-scores the best profile on a fresh seed set not used for selection, and prints both', () => {
        const result = tiny()
        const options = { baseline, field: [aggressive.profile], top: 2, generalPairs: 1, games: 2, maxTicks: 600 }
        const selection = scorer({ ...options, run: runMatch }, result.config.selectionSeed)
        const holdout = scorer({ ...options, run: runMatch }, result.config.holdoutSeed)
        for (const s of holdout.seeds()) expect(selection.seeds().has(s)).toBe(false)
        expect(holdout.score(result.best.profile)).toEqual(result.best.holdout)
        expect(selection.score(result.best.profile)).toEqual(result.best.score)
        const text = formatTuning(result)
        const pct = (x: number) => `${(x * 100).toFixed(1)}%`
        expect(text).toContain(`selection seeds: ${pct(result.best.score.winRate)}`)
        expect(text).toContain(`fresh seeds (holdout, not used for selection): ${pct(result.best.holdout.winRate)}`)
    })

    it('--max-matches: stops when the budget is reached, keeps what it has and says it is partial', () => {
        const full = tiny({ population: 4, generations: 3 })
        // 8 matches a profile: generation 0 (32), its elite (free), one child (8), then the next child would leave no room
        // for the holdout (8): 48 in all
        const result = tiny({ population: 4, generations: 3, maxMatches: 50 })
        expect(result.partial).toBe(true)
        expect(result.matches).toBeLessThanOrEqual(50)
        expect(result.stopped).toEqual({ generation: 1, scored: 2 })
        expect(result.generations).toHaveLength(1)
        expect(result.generations[0]).toEqual(full.generations[0])
        expect(result.population).toEqual(full.generations[0].ranking)
        expect(result.matches).toBe(48)
        expect(result.best.holdout.games).toBe(8)
        expect(formatTuning(result)).toContain('PARTIAL: the --max-matches budget of 50')
        expect(tunedProfile(result).intent).toContain('(partial run)')
        expect(formatTuning(full)).not.toContain('PARTIAL')
        expect(full.partial).toBe(false)

        // a budget inside generation 0 still gives a result from the profiles it scored
        const early = tiny({ maxMatches: 30 })
        expect(early.stopped).toEqual({ generation: 0, scored: 2 })
        expect(early.population).toHaveLength(2)
        expect(early.generations).toHaveLength(0)
        expect(tiny({ maxMatches: 31 }).stopped).toEqual({ generation: 0, scored: 2 })
        expect(() => tiny({ maxMatches: 15 })).toThrow(/below 16/)
    })
})
