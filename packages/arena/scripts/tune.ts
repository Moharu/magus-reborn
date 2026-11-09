// Usage:
//   npm run arena:tune -- [--generations G] [--population P] [--elite K] [--seed S] [--top N] [--general-pairs K]
//                         [--games G] [--max-ticks T] [--max-matches M] [--from a,b | --profile NAME] [--field a,b]
//                         [--baseline VERSION]
//                         [--out FILE]
// Evolutionary self-tuning (#104): scores a population of profiles against a fixed field on the tournament's top loadouts,
// keeps the best --elite unchanged and breeds the rest, for --generations generations. Prints one row per generation, then
// the best profile's win rate on the selection seeds and on a fresh holdout seed set. --out writes the best profile as
// profile JSON (`parseProfile`). --profile NAME tunes that one archetype only (#156): it seeds and mutates nothing else, the
// field stays the same, and the output reports the improvement over the untuned archetype on both seed sets. --max-matches stops early and says the result is partial. Progress goes to stderr.
// Tuned profiles are for the arena only; gameplay never reads them.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fromInvocation } from './paths'
import { ENGINE_VERSION } from '@magus/engine'
import {
    ARCHETYPE_NAMES,
    ARCHETYPES,
    DEFAULT_ELITE,
    DEFAULT_GAMES,
    DEFAULT_GENERAL_PAIRS,
    DEFAULT_GENERATIONS,
    DEFAULT_POPULATION,
    DEFAULT_SEED,
    DEFAULT_TOP,
    formatTuning,
    parseBaseline,
    percent,
    tune,
    tunedProfile,
    type ArchetypeName,
} from '../src'

const args = process.argv.slice(2)
const flag = (name: string) => {
    const i = args.indexOf(`--${name}`)
    if (i === -1) return undefined
    const value = args[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`)
    return value
}
const intFlag = (name: string, fallback: number) => {
    const raw = flag(name)
    if (raw === undefined) return fallback
    if (!/^\d+$/.test(raw)) throw new Error(`--${name} must be a non-negative integer, got ${raw}`)
    return Number(raw)
}
const archetypes = (name: string) => {
    const names = (flag(name) ?? ARCHETYPE_NAMES.join(',')).split(',').filter(Boolean)
    for (const n of names)
        if (!(ARCHETYPE_NAMES as string[]).includes(n))
            throw new Error(`--${name}: unknown profile ${n} (one of ${ARCHETYPE_NAMES.join(', ')})`)
    return names.map(n => ARCHETYPES[n as ArchetypeName].profile)
}

/** `--profile NAME`: the one archetype to tune (instead of `--from`), or undefined. */
const tunedArchetype = () => {
    const name = flag('profile')
    if (name === undefined) return undefined
    if (!(ARCHETYPE_NAMES as string[]).includes(name))
        throw new Error(`--profile: unknown profile ${name} (one of ${ARCHETYPE_NAMES.join(', ')})`)
    if (flag('from') !== undefined) throw new Error('--profile and --from cannot be used together')
    return ARCHETYPES[name as ArchetypeName].profile
}

const loadBaseline = () => {
    const version = flag('baseline') ?? ENGINE_VERSION
    if (!/^[\w.-]+$/.test(version))
        throw new Error(`--baseline must be a version like ${ENGINE_VERSION}, got ${version}`)
    const file = fileURLToPath(new URL(`../baselines/${version}.json`, import.meta.url))
    let raw: unknown
    try {
        raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            throw new Error(
                `no dummy-DPS baseline for version ${version}: expected packages/arena/baselines/${version}.json (npm run arena:baseline)`,
                { cause: error },
            )
        throw error
    }
    return parseBaseline(raw, version)
}

const main = () => {
    const population = intFlag('population', DEFAULT_POPULATION)
    const maxMatches = flag('max-matches') === undefined ? undefined : intFlag('max-matches', 0)
    const only = tunedArchetype()
    const result = tune({
        baseline: loadBaseline(),
        seeds: only ? [only] : archetypes('from'),
        ...(only ? { compareToStart: true } : {}),
        field: archetypes('field'),
        top: intFlag('top', DEFAULT_TOP),
        generalPairs: intFlag('general-pairs', DEFAULT_GENERAL_PAIRS),
        games: intFlag('games', DEFAULT_GAMES),
        seed: intFlag('seed', DEFAULT_SEED),
        generations: intFlag('generations', DEFAULT_GENERATIONS),
        population,
        elite: intFlag('elite', Math.min(DEFAULT_ELITE, Math.max(0, population - 1))),
        ...(flag('max-ticks') === undefined ? {} : { maxTicks: intFlag('max-ticks', 0) }),
        ...(maxMatches === undefined ? {} : { maxMatches }),
        onGeneration: g =>
            console.error(
                `generation ${g.generation}: best ${percent(g.best)}, median ${percent(g.median)}, worst ${percent(g.worst)} (${g.matches} matches so far)`,
            ),
    })
    const out = flag('out')
    if (out !== undefined) writeFileSync(fromInvocation(out), JSON.stringify(tunedProfile(result), null, 4) + '\n')
    console.log(formatTuning(result))
    if (out !== undefined) console.log(`Best profile written to ${out}${result.partial ? ' (partial run)' : ''}.`)
}

try {
    main()
} catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
}
