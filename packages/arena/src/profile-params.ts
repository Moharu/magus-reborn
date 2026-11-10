import {
    EDGE_GREED_MAX_SECONDS,
    GENERAL_SPELLS,
    LETHAL_MARGIN_MAX_HP,
    parseProfile,
    RELEASE_HOLD_MAX_SECONDS,
    type Profile,
} from './profile'
import type { SpellId } from '@magus/engine'
import { buildRotation } from './adapt'
import { CHILLING_MAX } from './chilling'
import type { Rng } from './prng'

/**
 * The tunable parameters of a behaviour profile (#102) and their bounds, for the self-tuner (#104). Only these values
 * are ever changed by mutation or crossover: a profile's structure (its rotation and window orders, the conditions it
 * checks, its Counterspell's `enabled`, which general spells it uses) stays as written. Every bound lies inside the range the profile
 * loader accepts, so a profile clamped to these bounds always loads.
 */

/** A number in [min, max], kept on a multiple of `precision` (1 for counts, 0.01 for seconds). */
export interface NumberParameter {
    readonly kind: 'number'
    readonly min: number
    readonly max: number
    readonly precision: number
    /** A mutation moves the value by a uniform amount in [-step, +step], then rounds and clamps it. */
    readonly step: number
}

/** One of a fixed set of values. A mutation switches to another one. */
export interface ChoiceParameter {
    readonly kind: 'choice'
    readonly options: readonly (string | boolean)[]
}

export type Parameter = NumberParameter | ChoiceParameter

const num = (min: number, max: number, precision: number, step: number): NumberParameter => ({
    kind: 'number',
    min,
    max,
    precision,
    step,
})

/** One standard reaction time: the fastest Counterspell reaction, and the shortest fake cast or pause after one. */
export const REACTION_MIN_SECONDS = 0.25

/**
 * The profile's own parameters, by path. `counterspell.reaction.spreadSeconds` is also kept at most `meanSeconds`.
 * `counterspell.enabled` is not one: everyone has Counterspell, so tuning never turns it off (#123).
 */
export const PROFILE_PARAMETERS: Readonly<Record<string, Parameter>> = {
    'counterspell.reaction.meanSeconds': num(REACTION_MIN_SECONDS, 1.5, 0.01, 0.1),
    'counterspell.reaction.spreadSeconds': num(0, 0.5, 0.01, 0.05),
    'counterspell.timing': { kind: 'choice', options: ['early', 'late'] },
    'counterspell.lateWindowSeconds': num(0, 3, 0.01, 0.2),
    // which casts are worth a Counterspell (#143), by their value as seen
    'counterspell.minValue': num(0, 40, 0.1, 3),
    'counterspell.bestShare': num(0, 1, 0.01, 0.1),
    'counterspell.unseenValuePerSecond': num(0, 20, 0.1, 1),
    'fakeCast.enabled': { kind: 'choice', options: [true, false] },
    'fakeCast.cancelAfterSeconds': num(REACTION_MIN_SECONDS, 2, 0.01, 0.1),
    'fakeCast.pauseAfterSeconds': num(REACTION_MIN_SECONDS, 2, 0.01, 0.1),
    'fakeCast.minGapSeconds': num(0, 60, 0.01, 3),
    'fakeCast.maxPerMatch': num(0, 50, 1, 3),
    'fakeCast.realBaitShare': num(0, 1, 0.01, 0.1),
    // edge greed (#126): the loader's whole range, so the tuner can find whether the risk pays off
    'lockoutWindow.edgeGreedSeconds': num(0, EDGE_GREED_MAX_SECONDS, 0.01, 0.2),
    // give-up timers (#136): only tuned when the profile has the timer (null turns one off, and stays off)
    'counterspell.giveUpSeconds': num(1, 30, 0.01, 2),
    'patience.thresholdGiveUpSeconds': num(REACTION_MIN_SECONDS, 10, 0.01, 0.5),
    'patience.commitGiveUpSeconds': num(REACTION_MIN_SECONDS, 15, 0.01, 1),
    // holding a completed cast (#143): only tuned when the profile holds (`releaseHold` set)
    'releaseHold.giveUpSeconds': num(0, RELEASE_HOLD_MAX_SECONDS, 0.01, 0.2),
    // the lethal-release margin (#146 review), only when the profile has one
    'releaseHold.lethalMarginHp': num(0, LETHAL_MARGIN_MAX_HP, 0.01, 1),
}

/**
 * The numeric fields of a condition, wherever it appears (`rotation[i].when`, `lockoutWindow.rotation[i].when`,
 * `fakeCast.when`, `releaseHold.when`, `generals.<id>.when`, and the lists of an `anyOf` in any of them).
 */
export const CONDITION_PARAMETERS: Readonly<Record<'hp' | 'count' | 'seconds' | 'withinSeconds', NumberParameter>> = {
    hp: num(0, 100, 1, 10),
    count: num(0, 20, 1, 1),
    seconds: num(0, 3, 0.01, 0.1),
    // `selfCastsAtLeast` (#136): how far back own casts count
    withinSeconds: num(0, 15, 0.01, 1),
}

/** The `count` of a Chilling condition (#150): stacks, 0 to the cap. */
export const CHILLING_COUNT_PARAMETER: NumberParameter = num(0, CHILLING_MAX, 1, 1)
const CHILLING_CONDITIONS = new Set(['selfChillingAtLeast', 'selfChillingBelow'])

/** The parameter of a condition's field: Chilling counts have their own bounds, every other field its shared one. */
const conditionParameter = (condition: object, key: keyof typeof CONDITION_PARAMETERS) =>
    key === 'count' && CHILLING_CONDITIONS.has((condition as { type?: string }).type ?? '')
        ? CHILLING_COUNT_PARAMETER
        : CONDITION_PARAMETERS[key]

/** One tunable value of a given profile: its path (`rotation[0].when[0].count`) and its parameter. */
export interface ParameterSlot {
    readonly path: string
    /** The key of the parameter in `PROFILE_PARAMETERS`, or the condition field name (`hp`, `count`, `seconds`). */
    readonly key: string
    readonly parameter: Parameter
    /** True for a condition field: what it means depends on the profile's structure. */
    readonly condition: boolean
}

type Segment = string | number

const segments = (path: string): Segment[] =>
    path
        .split(/\.|(?=\[)/)
        .map(part => (part.startsWith('[') ? Number(part.slice(1, -1)) : part))
        .filter(part => part !== '')

type Json = Record<string | number, unknown>

/** The value at `path` in `root`. */
export const getAt = (root: unknown, path: string): unknown =>
    segments(path).reduce<unknown>((node, key) => (node as Json | undefined)?.[key], root)

/** Sets the value at `path` in `root` (a mutable copy), which must exist. */
const setAt = (root: unknown, path: string, value: unknown) => {
    const keys = segments(path)
    const parent = keys.slice(0, -1).reduce<unknown>((node, key) => (node as Json)[key], root) as Json
    parent[keys[keys.length - 1]] = value
}

/** Every tunable value of `profile`, in a fixed order: the profile's own parameters, then condition fields. */
export const parameterSlots = (profile: Profile): ParameterSlot[] => {
    const slots: ParameterSlot[] = Object.entries(PROFILE_PARAMETERS)
        // a give-up timer that is off (null) or absent is not a value to tune
        .filter(([path]) => getAt(profile, path) !== null && getAt(profile, path) !== undefined)
        .map(([path, parameter]) => ({
            path,
            key: path,
            parameter,
            condition: false,
        }))
    const lists: [string, readonly object[]][] = [
        ...profile.rotation.map((entry, i): [string, readonly object[]] => [`rotation[${i}].when`, entry.when]),
        ...profile.lockoutWindow.rotation.map((entry, i): [string, readonly object[]] => [
            `lockoutWindow.rotation[${i}].when`,
            entry.when,
        ]),
        ['fakeCast.when', profile.fakeCast.when],
        ...(profile.releaseHold ? [['releaseHold.when', profile.releaseHold.when] as [string, readonly object[]]] : []),
        ...GENERAL_SPELLS.flatMap((id): [string, readonly object[]][] => {
            const rule = profile.generals[id]
            return rule === 'never' ? [] : [[`generals.${id}.when`, rule.when]]
        }),
    ]
    const walk = (base: string, when: readonly object[]) =>
        when.forEach((condition, j) => {
            for (const key of Object.keys(CONDITION_PARAMETERS) as (keyof typeof CONDITION_PARAMETERS)[])
                if (key in condition)
                    slots.push({
                        path: `${base}[${j}].${key}`,
                        key,
                        parameter: conditionParameter(condition, key),
                        condition: true,
                    })
            // an anyOf's lists, in order
            const of = (condition as { of?: readonly (readonly object[])[] }).of
            if (Array.isArray(of)) of.forEach((list, k) => walk(`${base}[${j}].of[${k}]`, list))
        })
    for (const [base, when] of lists) walk(base, when)
    return slots
}

/**
 * The rotation lists whose entries can show up in play on at least one of `loadouts` (#163): an entry that
 * `adaptProfile` drops from every loadout (its spell is on none, or its `when` waits on a spell none has) is never
 * played, so its condition values have no fitness signal there.
 */
const deadWhenPaths = (profile: Profile, loadouts: readonly (readonly SpellId[])[]) => {
    const dead = new Set<string>()
    const lists: [string, readonly Profile['rotation'][number][]][] = [
        ['rotation', profile.rotation],
        ['lockoutWindow.rotation', profile.lockoutWindow.rotation],
    ]
    for (const [name, entries] of lists)
        entries.forEach((entry, i) => {
            // a loadout with no entry left plays its own spells with no conditions, so it gives no signal either
            const played = loadouts.some(loadout => {
                const kept = buildRotation(entries, loadout)
                return kept.length > 0 && kept.includes(entry)
            })
            if (!played) dead.add(`${name}[${i}].when`)
        })
    return dead
}

/**
 * The slots of `profile` worth changing when it is scored on `loadouts` (#163): `parameterSlots` without the condition
 * values of rotation entries that are never played on any of them (a Frost entry in a Fire-only run, and the other way
 * round). Mutating those would only add drift that the score can't see. Without `loadouts`, every slot.
 */
export const tunableSlots = (profile: Profile, loadouts?: readonly (readonly SpellId[])[]): ParameterSlot[] => {
    const slots = parameterSlots(profile)
    if (!loadouts) return slots
    const dead = deadWhenPaths(profile, loadouts)
    return slots.filter(({ path, condition }) => !(condition && [...dead].some(base => path.startsWith(`${base}[`))))
}

const decimals = (precision: number) => Math.max(0, -Math.floor(Math.log10(precision)))

/** `value` rounded to the parameter's precision and clamped to its bounds; a choice not among the options becomes the first. */
export const clampValue = (parameter: Parameter, value: unknown): unknown => {
    if (parameter.kind === 'choice') return parameter.options.includes(value as string) ? value : parameter.options[0]
    const raw = typeof value === 'number' && Number.isFinite(value) ? value : parameter.min
    const rounded = Number(
        (Math.round(raw / parameter.precision) * parameter.precision).toFixed(decimals(parameter.precision)),
    )
    return Math.min(parameter.max, Math.max(parameter.min, rounded))
}

const copy = (profile: Profile) => JSON.parse(JSON.stringify(profile)) as Profile

/**
 * `profile` with every tunable value rounded and clamped to its bounds, and the reaction spread at most its mean. The
 * result is checked by `parseProfile`, so it always loads. Values already in bounds are kept as they are.
 */
export const clampProfile = (profile: Profile): Profile => {
    const out = copy(profile)
    for (const { path, parameter } of parameterSlots(out)) {
        const value = getAt(out, path)
        if (
            parameter.kind === 'number' &&
            typeof value === 'number' &&
            value >= parameter.min &&
            value <= parameter.max
        )
            continue
        if (parameter.kind === 'choice' && parameter.options.includes(value as string)) continue
        setAt(out, path, clampValue(parameter, value))
    }
    const reaction = out.counterspell.reaction as { meanSeconds: number; spreadSeconds: number }
    if (reaction.spreadSeconds > reaction.meanSeconds) reaction.spreadSeconds = reaction.meanSeconds
    return parseProfile(out)
}

/** The profile's structure without its tunable values (nor its name and intent): equal for two profiles that differ only in them. */
export const shapeKey = (profile: Profile) => {
    const out = copy(profile) as unknown as Record<string, unknown>
    for (const { path } of parameterSlots(profile)) setAt(out, path, null)
    delete out.name
    delete out.intent
    return JSON.stringify(out)
}

/** The tunable behaviour of a profile, without its name and intent: equal profiles play identically. */
export const behaviourKey = (profile: Profile) => {
    const { name: _name, intent: _intent, ...rest } = profile
    return JSON.stringify(rest)
}

/**
 * Mutates each tunable value with probability `rate`: a number moves by up to its `step` either way (at least one
 * `precision`, so rounding never undoes the move), a choice switches to another option. Then `clampProfile`. If that
 * leaves the profile's behaviour unchanged, one more value is drawn and changed until it differs, so a mutant always
 * differs from its (clamped) parent. Every draw comes from `rng`. With `loadouts`, values with no fitness signal on them
 * (`tunableSlots`) are left alone, but their draws are still made and discarded: the stream is read the same whether a
 * slot is skipped or not, so a run's results stay comparable across loadout coverage.
 */
export const mutateProfile = (
    profile: Profile,
    rng: Rng,
    rate: number,
    loadouts?: readonly (readonly SpellId[])[],
): Profile => {
    const out = copy(profile)
    // a skipped slot is changed on a scratch copy: the same draws are read, and nothing of it reaches the result
    const scratch = copy(profile)
    const slots = parameterSlots(out)
    const live = new Set(tunableSlots(out, loadouts).map(slot => slot.path))
    const change = ({ path, parameter }: ParameterSlot) => {
        const target = live.has(path) ? out : scratch
        const value = getAt(target, path)
        if (parameter.kind === 'choice') {
            const others = parameter.options.filter(option => option !== value)
            setAt(target, path, others[rng.int(others.length)])
            return
        }
        const old = value as number
        const delta = (rng.next() * 2 - 1) * parameter.step
        const sign = delta < 0 ? -1 : 1
        let next = clampValue(parameter, old + delta)
        // a move smaller than the precision, or into a bound the value is already on: one precision the other way
        if (next === old) next = clampValue(parameter, old + sign * parameter.precision)
        if (next === old) next = clampValue(parameter, old - sign * parameter.precision)
        setAt(target, path, next)
    }
    for (const slot of slots) if (rng.next() < rate) change(slot)
    const parent = behaviourKey(clampProfile(profile))
    let result = clampProfile(out)
    for (let tries = 0; behaviourKey(result) === parent && tries < 100; tries++) {
        change(slots[rng.int(slots.length)])
        result = clampProfile(out)
    }
    return result
}

/**
 * Uniform crossover: `a`'s structure, each tunable value taken from `b` with probability 1/2. Condition fields are only
 * taken when both profiles have the same structure (`shapeKey`), since a path like `rotation[0].when[0].count` means
 * something different in another profile. Then `clampProfile`. With `loadouts`, values with no fitness signal on them
 * (`tunableSlots`) keep `a`'s; their coin flips are still drawn, so the stream is read the same either way.
 */
export const crossoverProfiles = (
    a: Profile,
    b: Profile,
    rng: Rng,
    loadouts?: readonly (readonly SpellId[])[],
): Profile => {
    const out = copy(a)
    const sameShape = shapeKey(a) === shapeKey(b)
    const live = new Set(tunableSlots(out, loadouts).map(slot => slot.path))
    for (const { path, condition } of parameterSlots(out)) {
        const take = rng.next() < 0.5
        // a block `b` lacks (`releaseHold`, #143) has no value to give
        if (take && live.has(path) && (sameShape || !condition) && getAt(b, path) !== undefined)
            setAt(out, path, getAt(b, path))
    }
    return clampProfile(out)
}

/** The tunable values where `to` differs from `from`, in slot order. Both must have the same structure for conditions. */
export const parameterChanges = (from: Profile, to: Profile) =>
    parameterSlots(to)
        .map(({ path }) => ({ path, from: getAt(from, path), to: getAt(to, path) }))
        .filter(change => change.from !== change.to)
