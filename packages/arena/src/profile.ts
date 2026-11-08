import { FIXED_SPELL, isSpellId, secondsToTicks, SPELLS, type SpellId } from '@magus/engine'
import { parseWhen, spellList, type Condition } from './conditions'
import { boolean, fail, isRecord, number, record, string } from './validate'

/**
 * A behaviour profile: every decision an arena player makes, as a plain JSON object of named parameters, so a tuner
 * (#104) can mutate it and `parseProfile` can check it. Seconds are converted to ticks with the engine's
 * `secondsToTicks`; randomness comes from the player's seeded stream.
 */
export interface Profile {
    readonly name: string
    /** One line on what the profile is trying to do. */
    readonly intent?: string
    /** Which cast to start when nothing else applies: the first entry whose spell is ready and whose `when` holds. */
    readonly rotation: readonly RotationEntry[]
    readonly counterspell: CounterspellPolicy
    readonly fakeCast: FakeCast
    /** One usage rule per general spell. Rules for general spells that aren't on the loadout are ignored. */
    readonly generals: Readonly<Record<GeneralSpell, GeneralRule>>
}

/** A rotation entry. A bare spell id in the JSON is `{ spell }`; `parseProfile` always returns this form. */
export interface RotationEntry {
    readonly spell: SpellId
    /** All must hold. Default `[]`: always. */
    readonly when: readonly Condition[]
}

export interface CounterspellPolicy {
    readonly enabled: boolean
    /** The enemy casts it interrupts; casts of other spells are let through. */
    readonly targets: readonly SpellId[]
    /**
     * Time from deciding to interrupt to the Counterspell landing, sampled once per enemy cast from the seeded stream:
     * uniform in [meanSeconds - spreadSeconds, meanSeconds + spreadSeconds], floored at 0, then rounded to ticks.
     */
    readonly reaction: { readonly meanSeconds: number; readonly spreadSeconds: number }
    /**
     * `early`: decide on the first tick the cast is visible, so the Counterspell lands one reaction later.
     * `late`: wait until the cast is within `lateWindowSeconds` of its release, then decide, so the Counterspell lands
     * one reaction after that: a window shorter than the reaction can come too late.
     */
    readonly timing: 'early' | 'late'
    /** `late` only: how long before the cast's release the Counterspell should land. */
    readonly lateWindowSeconds: number
}

/**
 * Fake-casting (#43): start `spell`, then cancel it with `Battle.stopCast` `cancelAfterSeconds` in, before it can be
 * released, to bait a Counterspell. The cancel costs only the elapsed time. The bait works when the enemy has already
 * decided to interrupt and its Counterspell lands after the cancel: #43's `R + ε`, where `R` is when the enemy commits.
 */
export interface FakeCast {
    readonly enabled: boolean
    readonly spell: SpellId
    /** How long the fake stays on the cast bar. Capped at one tick before the cast would complete. */
    readonly cancelAfterSeconds: number
    /**
     * After the cancel, start no cast for this long, so a Counterspell already on its way lands on an empty cast bar
     * rather than on the next cast. General spells are still used.
     */
    readonly pauseAfterSeconds: number
    /** At least this long between two fake casts' starts. */
    readonly minGapSeconds: number
    /** At most this many fake casts per match. */
    readonly maxPerMatch: number
    /** All must hold to start a fake (as well as the spell being ready and no own cast in progress). */
    readonly when: readonly Condition[]
}

export const GENERAL_SPELLS = ['SPELL_HASTE', 'SPELL_TEMPORAL_SHIELD', 'SPELL_MAGIC_EATER', 'SPELL_BLUR'] as const
export type GeneralSpell = (typeof GENERAL_SPELLS)[number]

/** `never`, or use the spell whenever it is ready and every condition in `when` holds. */
export type GeneralRule = 'never' | { readonly when: readonly Condition[] }

const MAX_SECONDS = 10
const MAX_TEXT = 200
const PROFILE_KEYS = ['name', 'intent', 'rotation', 'counterspell', 'fakeCast', 'generals']
const COUNTERSPELL_KEYS = ['enabled', 'targets', 'reaction', 'timing', 'lateWindowSeconds']
const FAKE_CAST_KEYS = [
    'enabled',
    'spell',
    'cancelAfterSeconds',
    'pauseAfterSeconds',
    'minGapSeconds',
    'maxPerMatch',
    'when',
]

const castTimeSpell = (raw: unknown, path: string) => {
    if (!isSpellId(raw)) fail(path, `unknown spell id ${JSON.stringify(raw)}`)
    const id = raw as SpellId
    if (!SPELLS[id].castSeconds) fail(path, `${id} is an instant: it has no cast to show`)
    return id
}

const parseRotation = (raw: unknown): RotationEntry[] => {
    if (!Array.isArray(raw) || raw.length === 0) fail('rotation', 'must be a non-empty array')
    const seen = new Set<SpellId>()
    return (raw as unknown[]).map((entry, i) => {
        const path = `rotation[${i}]`
        const value = typeof entry === 'string' ? { spell: entry } : record(entry, path, ['spell', 'when'])
        if (!isSpellId(value.spell)) fail(typeof entry === 'string' ? path : `${path}.spell`, 'unknown spell id')
        const spell = value.spell as SpellId
        if (spell === FIXED_SPELL || (GENERAL_SPELLS as readonly string[]).includes(spell))
            fail(path, `${spell} is decided by ${spell === FIXED_SPELL ? 'counterspell' : `generals.${spell}`}`)
        if (seen.has(spell)) fail(path, `${spell} is listed twice`)
        seen.add(spell)
        return { spell, when: value.when === undefined ? [] : parseWhen(value.when, `${path}.when`) }
    })
}

const parseCounterspell = (raw: unknown): CounterspellPolicy => {
    const value = record(raw, 'counterspell', COUNTERSPELL_KEYS)
    for (const key of COUNTERSPELL_KEYS) if (!(key in value)) fail(`counterspell.${key}`, 'is required')
    const targets =
        Array.isArray(value.targets) && value.targets.length === 0
            ? []
            : spellList(value.targets, 'counterspell.targets')
    targets.forEach((id, i) => castTimeSpell(id, `counterspell.targets[${i}]`))
    const reaction = record(value.reaction, 'counterspell.reaction', ['meanSeconds', 'spreadSeconds'])
    if (value.timing !== 'early' && value.timing !== 'late') fail('counterspell.timing', 'must be "early" or "late"')
    return {
        enabled: boolean(value.enabled, 'counterspell.enabled'),
        targets,
        reaction: {
            meanSeconds: number(reaction.meanSeconds, 'counterspell.reaction.meanSeconds', 0, MAX_SECONDS),
            spreadSeconds: number(reaction.spreadSeconds, 'counterspell.reaction.spreadSeconds', 0, MAX_SECONDS),
        },
        timing: value.timing as 'early' | 'late',
        lateWindowSeconds: number(value.lateWindowSeconds, 'counterspell.lateWindowSeconds', 0, MAX_SECONDS),
    }
}

const parseFakeCast = (raw: unknown): FakeCast => {
    const value = record(raw, 'fakeCast', FAKE_CAST_KEYS)
    for (const key of FAKE_CAST_KEYS) if (!(key in value)) fail(`fakeCast.${key}`, 'is required')
    const cancelAfterSeconds = number(value.cancelAfterSeconds, 'fakeCast.cancelAfterSeconds', 0, MAX_SECONDS)
    if (secondsToTicks(cancelAfterSeconds) < 1) fail('fakeCast.cancelAfterSeconds', 'must be at least one tick')
    return {
        enabled: boolean(value.enabled, 'fakeCast.enabled'),
        spell: castTimeSpell(value.spell, 'fakeCast.spell'),
        cancelAfterSeconds,
        pauseAfterSeconds: number(value.pauseAfterSeconds, 'fakeCast.pauseAfterSeconds', 0, MAX_SECONDS),
        minGapSeconds: number(value.minGapSeconds, 'fakeCast.minGapSeconds', 0, 180),
        maxPerMatch: number(value.maxPerMatch, 'fakeCast.maxPerMatch', 0, 1000, true),
        when: parseWhen(value.when, 'fakeCast.when'),
    }
}

const parseGenerals = (raw: unknown): Record<GeneralSpell, GeneralRule> => {
    const value = record(raw, 'generals', GENERAL_SPELLS)
    const rules = {} as Record<GeneralSpell, GeneralRule>
    for (const id of GENERAL_SPELLS) {
        const rule = value[id]
        const path = `generals.${id}`
        if (rule === undefined) fail(path, 'is required: "never" or { "when": [...] }')
        if (rule === 'never') rules[id] = 'never'
        else if (isRecord(rule)) rules[id] = { when: parseWhen(record(rule, path, ['when']).when, `${path}.when`) }
        else fail(path, 'must be "never" or { "when": [...] }')
    }
    return rules
}

/**
 * Checks a profile's shape and ranges and returns it in normal form (bare rotation ids become `{ spell, when: [] }`).
 * Throws a `ProfileError` naming the first bad key: unknown keys, missing keys and out-of-range values are all
 * rejected. It does not check the profile against a loadout; `loadProfile` does.
 */
export const parseProfile = (raw: unknown): Profile => {
    if (!isRecord(raw)) fail('profile', 'must be an object')
    const value = record(raw, '', PROFILE_KEYS)
    const profile: Profile = {
        name: string(value.name, 'name', MAX_TEXT),
        ...(value.intent === undefined ? {} : { intent: string(value.intent, 'intent', MAX_TEXT) }),
        rotation: parseRotation(value.rotation),
        counterspell: parseCounterspell(value.counterspell),
        fakeCast: parseFakeCast(value.fakeCast),
        generals: parseGenerals(value.generals),
    }
    return profile
}

/**
 * Rejects a profile that names a spell the loadout doesn't have: every rotation spell, and the fake-cast spell when
 * fake-casting is enabled. Rejected here, at load time, never skipped during a match.
 */
export const checkLoadout = (profile: Profile, loadout: readonly SpellId[]) => {
    profile.rotation.forEach(({ spell }, i) => {
        if (!loadout.includes(spell)) fail(`rotation[${i}]`, `${spell} is not on the loadout`)
    })
    if (profile.fakeCast.enabled && !loadout.includes(profile.fakeCast.spell))
        fail('fakeCast.spell', `${profile.fakeCast.spell} is not on the loadout`)
    if (profile.counterspell.enabled && !loadout.includes(FIXED_SPELL))
        fail('counterspell.enabled', `${FIXED_SPELL} is not on the loadout`)
    return profile
}

/** `parseProfile`, then `checkLoadout` against the loadout it will play. */
export const loadProfile = (raw: unknown, loadout: readonly SpellId[]) => checkLoadout(parseProfile(raw), loadout)
