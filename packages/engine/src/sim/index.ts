import { Battle } from '../battle'
import { isSpellId } from '../catalog'
import { secondsToTicks, ticksToSeconds } from '../constants'
import { COOLDOWN as COUNTERSPELL_COOLDOWN } from '../spells/general/counterspell'
import type { BattleState, PlayerKey, SpellId } from '../types'
import { fromCenti, toCenti } from '../utils'
import { conditionHolds, parsePolicyEntry, toRule, type PolicyEntry } from './policy'

/**
 * Far more than any loadout deals in a fight (hundreds per minute), so the dummy never reaches 0
 * and `winner` stays null. Kept moderate so hp in centi-HP stays far inside the safe-integer range. `simulate` throws if the fight ever ends.
 */
export const DUMMY_HP = 1e6

export const DEFAULT_REACTION_SECONDS = 0.4

export interface SimPressure {
    /** Seconds into a cast before the enemy can counter it (default 0.4). Shorter casts are immune. */
    reactionSeconds?: number
}

export interface SimInput {
    /** Spells equipped by the caster, in slot order. */
    loadout: SpellId[]
    /**
     * Ordered rules. Each tick the first rule whose conditions hold and whose spell the engine accepts is
     * started. A bare spell id is an unconditional rule. See `PolicyCondition`.
     */
    policy: PolicyEntry[]
    durationSeconds?: number
    /** Optional cap on releases per spell; a capped spell is no longer castable for the policy. */
    maxCasts?: Partial<Record<SpellId, number>>
    /** Counterspell-pressure model, see `simulate`. */
    pressure?: SimPressure
}

export interface SimSpellResult {
    damage: number
    casts: number
    share: number
}

export interface SimInterrupt {
    spell: SpellId
    /** When the countered cast started. */
    startSeconds: number
    /** When the Counterspell landed. */
    atSeconds: number
}

export interface SimResult {
    totalDamage: number
    dps: number
    /** DPS of the same policy while the enemy Counterspells the most valuable cast in each ready window. */
    dpsUnderPressure: number
    /** `dps - dpsUnderPressure`. */
    risk: number
    durationSeconds: number
    /** Unpressured breakdown. */
    perSpell: Partial<Record<SpellId, SimSpellResult>>
    pressure: {
        reactionSeconds: number
        totalDamage: number
        interrupts: SimInterrupt[]
        /** Breakdown of the pressured run (countered casts are not releases, so they don't count). */
        perSpell: Partial<Record<SpellId, SimSpellResult>>
    }
}

const CASTER: PlayerKey = 'player1'
const DUMMY: PlayerKey = 'player2'
/**
 * The dummy's only spell in the pressured run: the engine's real Counterspell. In the unpressured run
 * the dummy has no spells at all, so there is no Counterspell threat (`enemyCounterspellOnCooldown` holds).
 */
const DUMMY_SPELLS: SpellId[] = ['SPELL_COUNTERSPELL']

/** A cast-time spell the caster started. `end` is the tick it was released, cancelled or countered. */
interface CastRecord {
    id: SpellId
    start: number
    end: number | null
    /** Centi-HP that landing this release adds by the end of the fight (see `releaseValue`). */
    value: number
}

interface RunResult {
    damage: Map<SpellId, number>
    casts: Map<SpellId, number>
    records: CastRecord[]
    totalTicks: number
}

const fork = (battle: Battle) => {
    const copy = new Battle({ name: 'Caster', spells: [] }, { name: 'Dummy', spells: [] })
    copy.state = JSON.parse(JSON.stringify(battle.state)) as BattleState
    return copy
}

/**
 * Ticks an idle caster to the end of the fight. Only effects on the dummy (Ignite, Living Bomb) can
 * still damage it, so it stops early once the dummy has none: the final HP can no longer change.
 */
const idleUntil = (battle: Battle, totalTicks: number) => {
    while (battle.state.gameTick < totalTicks && battle.state[DUMMY].effects.length > 0) battle.tick()
    return toCenti(battle.state[DUMMY].hp)
}

/**
 * Value of releasing the caster's current cast right now: dummy HP at the end of the fight if the
 * cast never lands, minus dummy HP if it lands, with the caster idle afterwards in both forks.
 * All engine math, so DoTs (Ignite, Living Bomb) and Combustion's read of existing Ignites count.
 */
const releaseValue = (battle: Battle, totalTicks: number) => {
    const landed = fork(battle)
    landed.stopCast(CASTER, landed.state[CASTER].cast!)
    return idleUntil(fork(battle), totalTicks) - idleUntil(landed, totalTicks)
}

const validate = ({ loadout, policy, durationSeconds = 60, maxCasts = {}, pressure = {} }: SimInput) => {
    for (const id of loadout) if (!isSpellId(id)) throw new Error(`unknown spell id: ${id}`)
    const spells = policy.map(entry => toRule(parsePolicyEntry(entry)).spell)
    for (const id of spells) if (!loadout.includes(id)) throw new Error(`policy spell ${id} is not in the loadout`)
    if (!(Number.isFinite(durationSeconds) && durationSeconds > 0))
        throw new Error('durationSeconds must be a finite positive number')
    for (const [id, cap] of Object.entries(maxCasts)) {
        if (!loadout.includes(id as SpellId)) throw new Error(`maxCasts spell ${id} is not in the loadout`)
        if (!(Number.isInteger(cap) && cap! >= 0)) throw new Error(`maxCasts for ${id} must be a non-negative integer`)
    }
    const { reactionSeconds = DEFAULT_REACTION_SECONDS } = pressure
    // a counter needs a cast already in progress, so R must be at least one tick (50 ms)
    if (!(Number.isFinite(reactionSeconds) && secondsToTicks(reactionSeconds) >= 1))
        throw new Error(`reactionSeconds must be a finite number of at least ${ticksToSeconds(1)}s (one tick)`)
}

/**
 * One run of the real engine. Each tick, before the engine advances: if `interrupts` holds the
 * current tick, the dummy casts its real Counterspell (engine reducer, cooldown and `lockedUntil`);
 * then a cast in progress is released exactly when its cast time completes; then, if not casting,
 * the first spell in `policy` that `startCast` accepts is started.
 */
const run = (
    { loadout, policy, durationSeconds = 60, maxCasts = {} }: SimInput,
    interrupts: ReadonlySet<number>,
    /** Tick the Counterspell is ready for the next window, or null to skip measuring cast values. */
    ready: number | null,
    reaction: number,
    cooldown: number,
): RunResult => {
    const rules = policy.map(toRule).map(rule => ({ ...rule, index: loadout.indexOf(rule.spell) }))
    const battle = new Battle(
        { name: 'Caster', spells: loadout },
        { name: 'Dummy', spells: ready === null ? [] : DUMMY_SPELLS, hp: DUMMY_HP },
    )
    const totalTicks = secondsToTicks(durationSeconds)
    /** In centi-HP, so totals are exact sums of the engine's 0.01-grid events. */
    const damage = new Map<SpellId, number>()
    const casts = new Map<SpellId, number>()
    const records: CastRecord[] = []
    let open: CastRecord | null = null
    let logSeen = 0
    /**
     * First tick the next window can counter a cast worth countering. Only releases are candidates:
     * a cast cancelled or still in progress at the end of the fight deals nothing, so it is not worth
     * a Counterspell. Releases from `opens` up to one cooldown later are valued.
     */
    let opens: number | null = null
    const measure = (record: CastRecord) => {
        const at = record.start + reaction
        if (ready === null || at < ready || at > battle.state.gameTick) return
        if (opens !== null && at >= opens + cooldown) return
        record.value = releaseValue(battle, totalTicks)
        if (record.value > 0 && opens === null) opens = at
    }

    const track = () => {
        const { gameTick } = battle.state
        const player = battle.state[CASTER]
        if (open && (player.cast === null || player.castStartingTick !== open.start)) {
            open.end = gameTick
            open = null
        }
        if (player.cast !== null && open === null) {
            open = { id: loadout[player.cast], start: gameTick, end: null, value: 0 }
            records.push(open)
        }
    }

    const act = () => {
        const { gameTick } = battle.state
        const player = battle.state[CASTER]
        if (interrupts.has(gameTick)) {
            if (player.cast === null || !battle.startCast(DUMMY, 0))
                throw new Error(`pressure model: no counterable cast at tick ${gameTick}`)
            track()
        }
        if (player.cast !== null) {
            const spell = player.spells[player.cast]
            if (gameTick < player.castStartingTick! + spell.castTime) return
            if (open) measure(open)
            battle.stopCast(CASTER, player.cast)
            track()
            collect() // count the release before deciding what to start next (maxCasts)
        }
        for (const { spell, when = [], index } of rules) {
            const cap = maxCasts[spell]
            if (cap !== undefined && (casts.get(spell) ?? 0) >= cap) continue
            if (!when.every(c => conditionHolds(battle.state, CASTER, DUMMY, c))) continue
            if (battle.startCast(CASTER, index)) break
        }
        track()
    }

    const collect = () => {
        for (const event of battle.drainEvents()) {
            if (event.player !== DUMMY || event.amount >= 0) continue
            damage.set(event.source, (damage.get(event.source) ?? 0) - toCenti(event.amount))
        }
        const log = battle.state.log
        for (; logSeen < log.length; logSeen++) {
            const entry = log[logSeen]
            if (entry.type !== 'SPELL_RELEASE' || entry.caster !== CASTER) continue
            const id = battle.state[CASTER].spells[entry.spellIndex].id
            casts.set(id, (casts.get(id) ?? 0) + 1)
        }
    }

    while (true) {
        act()
        collect()
        if (battle.state.gameTick >= totalTicks) break
        battle.tick()
        collect()
        if (battle.state.winner !== null) throw new Error(`dummy fight ended early: ${battle.state.winner}`)
    }
    return { damage, casts, records, totalTicks }
}

const sumCenti = (damage: Map<SpellId, number>) => {
    let total = 0
    for (const value of damage.values()) total += value
    return total
}

/**
 * Drives the real engine (`Battle.startCast` / `stopCast` / `tick`) against a passive dummy:
 * once untouched, with no spells on the dummy (`dps`, `perSpell`), and once under Counterspell pressure
 * (`dpsUnderPressure`, `pressure.perSpell`).
 * Damage comes from the engine's attributed HpEvents, so effect ticks (Ignite, Living Bomb) count
 * toward the spell that applied them.
 *
 * Pressure model. Dummy-based: the counterspeller's own cost (it can't cast while countering) is
 * ignored; a future PvP sim would need it. The dummy's real Counterspell is ready at tick 0 and
 * again `COOLDOWN` seconds after each use (engine cooldown). A cast can be countered
 * `reactionSeconds` (R) after it starts if it is still in progress then, so casts shorter than R
 * never are. Interrupts go through the engine's Counterspell reducer: the cast's progress is lost
 * and `lockedUntil` blocks the caster for the full lockout.
 *
 * Choosing the most valuable cast needs lookahead, done deterministically, one window at a time:
 *   1. run the fight with the interrupts chosen so far (none at first);
 *   2. eligible casts are releases worth > 0 damage, counterable at or after the tick the Counterspell is ready; the
 *      window opens at the first eligible interrupt tick and spans one `COOLDOWN` (the enemy does
 *      not hold Counterspell longer than that);
 *   3. counter the cast in the window whose release adds the most damage (measured by forking the
 *      engine at the release, see `releaseValue`); ties go to the earliest;
 *   4. add that interrupt and re-run from tick 0. Ticks before it are identical (same inputs, no
 *      randomness), so earlier choices stay valid. Stop when no eligible cast is left.
 */
export const simulate = (input: SimInput): SimResult => {
    validate(input)
    const reactionSeconds = input.pressure?.reactionSeconds ?? DEFAULT_REACTION_SECONDS
    const reaction = secondsToTicks(reactionSeconds)
    const cooldown = secondsToTicks(COUNTERSPELL_COOLDOWN)

    const base = run(input, new Set(), null, reaction, cooldown)
    const { totalTicks } = base
    const interrupts = new Set<number>()
    const chosen: SimInterrupt[] = []
    let ready = 0
    let pressured = run(input, interrupts, ready, reaction, cooldown)
    while (true) {
        const eligible = pressured.records.filter(r => {
            const at = r.start + reaction
            return r.value > 0 && at >= ready && at <= totalTicks && r.end !== null && at <= r.end
        })
        if (eligible.length === 0) break
        const opens = Math.min(...eligible.map(r => r.start + reaction))
        let best = eligible[0]
        for (const r of eligible) {
            if (r.start + reaction >= opens + cooldown) continue
            if (r.value > best.value || (r.value === best.value && r.start < best.start)) best = r
        }
        const at = best.start + reaction
        interrupts.add(at)
        chosen.push({ spell: best.id, startSeconds: ticksToSeconds(best.start), atSeconds: ticksToSeconds(at) })
        ready = at + cooldown
        pressured = run(input, interrupts, ready, reaction, cooldown)
    }

    const breakdown = ({ damage, casts }: RunResult) => {
        const total = fromCenti(sumCenti(damage))
        const out: SimResult['perSpell'] = {}
        for (const id of input.loadout) {
            const dmg = fromCenti(damage.get(id) ?? 0)
            const n = casts.get(id) ?? 0
            if (dmg === 0 && n === 0) continue
            out[id] = { damage: round(dmg), casts: n, share: total > 0 ? round(dmg / total) : 0 }
        }
        return out
    }
    const totalDamage = fromCenti(sumCenti(base.damage))
    const perSpell = breakdown(base)
    const seconds = ticksToSeconds(totalTicks)
    const pressuredDamage = fromCenti(sumCenti(pressured.damage))
    const dps = round(totalDamage / seconds)
    const dpsUnderPressure = round(pressuredDamage / seconds)
    return {
        totalDamage: round(totalDamage),
        dps,
        dpsUnderPressure,
        risk: round(dps - dpsUnderPressure),
        durationSeconds: seconds,
        perSpell,
        pressure: {
            reactionSeconds,
            totalDamage: round(pressuredDamage),
            interrupts: chosen,
            perSpell: breakdown(pressured),
        },
    }
}

/** Strips float noise (e.g. 0.1 + 0.2) so output is stable and readable. */
const round = (n: number) => Math.round(n * 1e6) / 1e6

const isIdList = (v: unknown): v is SpellId[] => Array.isArray(v) && v.every(isSpellId)

const parsePolicy = (v: unknown): PolicyEntry[] => {
    if (!Array.isArray(v) || v.length === 0)
        throw new Error('"policy" must be a non-empty array of spell ids or { spell, when } rules')
    return v.map((entry, i) => {
        try {
            return parsePolicyEntry(entry)
        } catch (error) {
            throw new Error(`"policy[${i}]": ${error instanceof Error ? error.message : String(error)}`)
        }
    })
}

/** Validates untrusted input (e.g. a CLI JSON file), throwing a readable error. */
export const parseSimInput = (raw: unknown): SimInput => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('input must be a JSON object')
    const { loadout, policy, durationSeconds, maxCasts, pressure } = raw as Record<string, unknown>
    if (!isIdList(loadout) || loadout.length === 0) throw new Error('"loadout" must be a non-empty array of spell ids')
    const rules = parsePolicy(policy)
    const stray = rules.map(entry => toRule(entry).spell).find(id => !loadout.includes(id))
    if (stray) throw new Error(`"policy" spell ${stray} is not in the loadout`)
    if (
        durationSeconds !== undefined &&
        !(typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds > 0)
    )
        throw new Error('"durationSeconds" must be a finite positive number')
    if (
        maxCasts !== undefined &&
        (typeof maxCasts !== 'object' ||
            maxCasts === null ||
            Object.entries(maxCasts).some(([k, v]) => !isSpellId(k) || !(Number.isInteger(v) && (v as number) >= 0)))
    )
        throw new Error('"maxCasts" must map spell ids to non-negative integers')
    const missing = Object.keys(maxCasts ?? {}).find(id => !loadout.includes(id as SpellId))
    if (missing) throw new Error(`"maxCasts" spell ${missing} is not in the loadout`)
    if (pressure !== undefined) {
        if (typeof pressure !== 'object' || pressure === null || Array.isArray(pressure))
            throw new Error('"pressure" must be an object')
        const { reactionSeconds } = pressure as Record<string, unknown>
        if (
            reactionSeconds !== undefined &&
            !(
                typeof reactionSeconds === 'number' &&
                Number.isFinite(reactionSeconds) &&
                secondsToTicks(reactionSeconds) >= 1
            )
        )
            throw new Error('"pressure.reactionSeconds" must be a finite number of at least one tick (0.05s)')
    }
    return {
        loadout,
        policy: rules,
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        ...(maxCasts !== undefined ? { maxCasts: maxCasts as SimInput['maxCasts'] } : {}),
        ...(pressure !== undefined
            ? {
                  pressure:
                      (pressure as SimPressure).reactionSeconds !== undefined
                          ? { reactionSeconds: (pressure as SimPressure).reactionSeconds }
                          : {},
              }
            : {}),
    }
}
