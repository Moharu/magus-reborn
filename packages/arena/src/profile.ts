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
    /** One line on what the profile is trying to do, and its plan for the general spells (#136). */
    readonly intent?: string
    /** Which cast to start when nothing else applies: the first entry whose spell is ready and whose `when` holds. */
    readonly rotation: readonly RotationEntry[]
    readonly lockoutWindow: LockoutWindow
    readonly counterspell: CounterspellPolicy
    readonly fakeCast: FakeCast
    /** The give-up timers of the profile's own waits (#136). `parseProfile` always sets it. */
    readonly patience: Patience
    /** One usage rule per general spell. Rules for general spells that aren't on the loadout are ignored. */
    readonly generals: Readonly<Record<GeneralSpell, GeneralRule>>
}

/** A rotation entry. A bare spell id in the JSON is `{ spell }`; `parseProfile` always returns this form. */
export interface RotationEntry {
    readonly spell: SpellId
    /** All must hold. Default `[]`: always. */
    readonly when: readonly Condition[]
}

/**
 * The free-cast window (#123): while the enemy can't Counterspell (its Counterspell lock, or its Counterspell on
 * cooldown, both from the view), the profile casts from this list instead of `rotation`, and only a cast that is
 * released before the enemy can next Counterspell. No fake cast or bait is started in the window.
 */
export interface LockoutWindow {
    /**
     * Highest value first: the first entry whose spell is ready, whose `when` holds and whose cast fits the window. With
     * none fitting, no cast starts until the window ends. Default: a copy of `rotation`.
     */
    readonly rotation: readonly RotationEntry[]
    /**
     * Edge greed (#126, pending an owner decision): when no entry fits, how far past the window's end, in seconds, a
     * cast may still release, in [0, `EDGE_GREED_MAX_SECONDS`]. The entries are tried again in order against that
     * later bound; the enemy may Counterspell such a cast. Default 0: none, the #123 rule as it was.
     * `parseProfile` always sets it.
     */
    readonly edgeGreedSeconds?: number
}

/** The largest `lockoutWindow.edgeGreedSeconds` (#126). */
export const EDGE_GREED_MAX_SECONDS = 1.5

export interface CounterspellPolicy {
    readonly enabled: boolean
    /** The enemy casts it interrupts; casts of other spells are let through. */
    readonly targets: readonly SpellId[]
    /**
     * Time from deciding to interrupt to the Counterspell landing, sampled once per enemy cast from the seeded stream:
     * uniform in [meanSeconds - spreadSeconds, meanSeconds + spreadSeconds], then rounded to ticks. `spreadSeconds` may
     * not exceed `meanSeconds`, so no draw is negative and the mean is exact (no floor skews it).
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
    /**
     * Give-up timer for holding Counterspell for `targets` (#136): once Counterspell has been off cooldown this long
     * without being used, the next enemy cast seen is interrupted whatever its spell (then the timer starts again when
     * Counterspell is next off cooldown). Null: it holds for its targets for good. `parseProfile` always sets it.
     */
    readonly giveUpSeconds?: number | null
}

/**
 * The give-up timers of a profile's own waits (#136), so that no wait lasts forever. Null turns a timer off: a profile
 * written for one test may wait for good, every shipped archetype sets both.
 */
export interface Patience {
    /**
     * Waiting on a rotation `when` (a stack or HP threshold): after this long with no cast of its own in progress or
     * started, the profile starts the first rotation entry that is ready, whatever its `when`.
     */
    readonly thresholdGiveUpSeconds: number | null
    /**
     * Waiting for the opponent to commit: when set, the profile starts no cast (nor a bait) while the enemy may still
     * Counterspell, until the free-cast window opens (the enemy used its Counterspell, or ours landed), for at most this
     * long from the start of the match or from the end of the last window. Then it plays its rotation until the next
     * window. Null: it never waits for the opponent.
     */
    readonly commitGiveUpSeconds: number | null
}

/** The largest give-up timer the loader accepts, in seconds. */
export const GIVE_UP_MAX_SECONDS = 60

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
    /**
     * Sacrificial bait (#123): the share of baits, in [0, 1], that are a real cast of the lowest-priority rotation entry
     * (the last one that is ready and whose `when` holds) instead of a fake. A real bait is not cancelled: it may be
     * countered, which shows the enemy's Counterspell on cooldown and opens the free-cast window. Drawn from the seeded
     * stream per bait (no draw at 0 or 1). Default 0: every bait is a fake. The fake-cast gates above (`enabled`,
     * `minGapSeconds`, `maxPerMatch`, `when`) apply to both kinds.
     */
    readonly realBaitShare: number
}

export const GENERAL_SPELLS = ['SPELL_HASTE', 'SPELL_TEMPORAL_SHIELD', 'SPELL_MAGIC_EATER', 'SPELL_BLUR'] as const
export type GeneralSpell = (typeof GENERAL_SPELLS)[number]

/** `never`, or use the spell whenever it is ready and every condition in `when` holds. */
export type GeneralRule = 'never' | { readonly when: readonly Condition[] }

const MAX_SECONDS = 10
const MAX_TEXT = 600
const PROFILE_KEYS = ['name', 'intent', 'rotation', 'lockoutWindow', 'counterspell', 'fakeCast', 'patience', 'generals']
const PATIENCE_KEYS = ['thresholdGiveUpSeconds', 'commitGiveUpSeconds']
const LOCKOUT_WINDOW_KEYS = ['rotation', 'edgeGreedSeconds']
const COUNTERSPELL_KEYS = ['enabled', 'targets', 'reaction', 'timing', 'lateWindowSeconds', 'giveUpSeconds']
/** Counterspell keys that may be left out (default null). */
const OPTIONAL_COUNTERSPELL_KEYS = ['giveUpSeconds']

/** A give-up timer: null (off) or seconds in [0, `GIVE_UP_MAX_SECONDS`]. Absent is null. */
const giveUp = (raw: unknown, path: string) =>
    raw === undefined || raw === null ? null : number(raw, path, 0, GIVE_UP_MAX_SECONDS)
const FAKE_CAST_KEYS = [
    'enabled',
    'spell',
    'cancelAfterSeconds',
    'pauseAfterSeconds',
    'minGapSeconds',
    'maxPerMatch',
    'when',
    'realBaitShare',
]
/** Keys that may be left out, with their default. */
const OPTIONAL_FAKE_CAST_KEYS = ['realBaitShare']

const castTimeSpell = (raw: unknown, path: string) => {
    if (!isSpellId(raw)) fail(path, `unknown spell id ${JSON.stringify(raw)}`)
    const id = raw as SpellId
    if (!SPELLS[id].castSeconds) fail(path, `${id} is an instant: it has no cast to show`)
    return id
}

const parseRotation = (raw: unknown, base = 'rotation'): RotationEntry[] => {
    if (!Array.isArray(raw) || raw.length === 0) fail(base, 'must be a non-empty array')
    const seen = new Set<SpellId>()
    return (raw as unknown[]).map((entry, i) => {
        const path = `${base}[${i}]`
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
    for (const key of COUNTERSPELL_KEYS)
        if (!(key in value) && !OPTIONAL_COUNTERSPELL_KEYS.includes(key)) fail(`counterspell.${key}`, 'is required')
    const targets =
        Array.isArray(value.targets) && value.targets.length === 0
            ? []
            : spellList(value.targets, 'counterspell.targets')
    targets.forEach((id, i) => castTimeSpell(id, `counterspell.targets[${i}]`))
    const reaction = record(value.reaction, 'counterspell.reaction', ['meanSeconds', 'spreadSeconds'])
    if (value.timing !== 'early' && value.timing !== 'late') fail('counterspell.timing', 'must be "early" or "late"')
    const meanSeconds = number(reaction.meanSeconds, 'counterspell.reaction.meanSeconds', 0, MAX_SECONDS)
    const spreadSeconds = number(reaction.spreadSeconds, 'counterspell.reaction.spreadSeconds', 0, MAX_SECONDS)
    if (spreadSeconds > meanSeconds)
        fail(
            'counterspell.reaction.spreadSeconds',
            `must not exceed meanSeconds (${meanSeconds}), got ${spreadSeconds}`,
        )
    return {
        enabled: boolean(value.enabled, 'counterspell.enabled'),
        targets,
        reaction: { meanSeconds, spreadSeconds },
        timing: value.timing as 'early' | 'late',
        lateWindowSeconds: number(value.lateWindowSeconds, 'counterspell.lateWindowSeconds', 0, MAX_SECONDS),
        giveUpSeconds: giveUp(value.giveUpSeconds, 'counterspell.giveUpSeconds'),
    }
}

/** Absent: no give-up timers (both null). */
const parsePatience = (raw: unknown): Patience => {
    const value = raw === undefined ? {} : record(raw, 'patience', PATIENCE_KEYS)
    return {
        thresholdGiveUpSeconds: giveUp(value.thresholdGiveUpSeconds, 'patience.thresholdGiveUpSeconds'),
        commitGiveUpSeconds: giveUp(value.commitGiveUpSeconds, 'patience.commitGiveUpSeconds'),
    }
}

const parseFakeCast = (raw: unknown): FakeCast => {
    const value = record(raw, 'fakeCast', FAKE_CAST_KEYS)
    for (const key of FAKE_CAST_KEYS)
        if (!(key in value) && !OPTIONAL_FAKE_CAST_KEYS.includes(key)) fail(`fakeCast.${key}`, 'is required')
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
        realBaitShare:
            value.realBaitShare === undefined ? 0 : number(value.realBaitShare, 'fakeCast.realBaitShare', 0, 1),
    }
}

/** Absent: the window plays a copy of the rotation, with no edge greed. */
const parseLockoutWindow = (raw: unknown, rotation: readonly RotationEntry[]): LockoutWindow => {
    if (raw === undefined)
        return { rotation: rotation.map(entry => ({ spell: entry.spell, when: [...entry.when] })), edgeGreedSeconds: 0 }
    const value = record(raw, 'lockoutWindow', LOCKOUT_WINDOW_KEYS)
    if (!('rotation' in value)) fail('lockoutWindow.rotation', 'is required')
    return {
        rotation: parseRotation(value.rotation, 'lockoutWindow.rotation'),
        edgeGreedSeconds:
            value.edgeGreedSeconds === undefined
                ? 0
                : number(value.edgeGreedSeconds, 'lockoutWindow.edgeGreedSeconds', 0, EDGE_GREED_MAX_SECONDS),
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
    const rotation = parseRotation(value.rotation)
    const profile: Profile = {
        name: string(value.name, 'name', MAX_TEXT),
        ...(value.intent === undefined ? {} : { intent: string(value.intent, 'intent', MAX_TEXT) }),
        rotation,
        lockoutWindow: parseLockoutWindow(value.lockoutWindow, rotation),
        counterspell: parseCounterspell(value.counterspell),
        fakeCast: parseFakeCast(value.fakeCast),
        patience: parsePatience(value.patience),
        generals: parseGenerals(value.generals),
    }
    return profile
}

/**
 * Rejects a profile that names a spell the loadout doesn't have: every rotation and window spell, and the fake-cast spell when
 * fake-casting is enabled. Rejected here, at load time, never skipped during a match.
 */
export const checkLoadout = (profile: Profile, loadout: readonly SpellId[]) => {
    profile.rotation.forEach(({ spell }, i) => {
        if (!loadout.includes(spell)) fail(`rotation[${i}]`, `${spell} is not on the loadout`)
    })
    profile.lockoutWindow.rotation.forEach(({ spell }, i) => {
        if (!loadout.includes(spell)) fail(`lockoutWindow.rotation[${i}]`, `${spell} is not on the loadout`)
    })
    if (profile.fakeCast.enabled && !loadout.includes(profile.fakeCast.spell))
        fail('fakeCast.spell', `${profile.fakeCast.spell} is not on the loadout`)
    if (profile.counterspell.enabled && !loadout.includes(FIXED_SPELL))
        fail('counterspell.enabled', `${FIXED_SPELL} is not on the loadout`)
    return profile
}

/** `parseProfile`, then `checkLoadout` against the loadout it will play. */
export const loadProfile = (raw: unknown, loadout: readonly SpellId[]) => checkLoadout(parseProfile(raw), loadout)
