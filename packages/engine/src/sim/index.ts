import { Battle } from '../battle'
import { isSpellId } from '../catalog'
import { secondsToTicks, ticksToSeconds } from '../constants'
import type { PlayerKey, SpellId } from '../types'

/**
 * Far more than any loadout deals in a fight (hundreds per minute), so the dummy never reaches 0
 * and `winner` stays null. Kept moderate because damage is read from hp deltas and a huge hp
 * value would cost floating-point precision. `simulate` throws if the fight ever ends.
 */
export const DUMMY_HP = 1e6

export interface SimInput {
    /** Spells equipped by the caster, in slot order. */
    loadout: SpellId[]
    /** Ordered priority list. Each tick the first spell the engine accepts is started. */
    policy: SpellId[]
    durationSeconds?: number
    /** Optional cap on releases per spell; a capped spell is no longer castable for the policy. */
    maxCasts?: Partial<Record<SpellId, number>>
}

export interface SimSpellResult {
    damage: number
    casts: number
    share: number
}

export interface SimResult {
    totalDamage: number
    dps: number
    durationSeconds: number
    perSpell: Partial<Record<SpellId, SimSpellResult>>
}

const CASTER: PlayerKey = 'player1'
const DUMMY: PlayerKey = 'player2'

/**
 * Drives the real engine (`Battle.startCast` / `stopCast` / `tick`) against a passive dummy.
 * Each tick, before the engine advances: a cast in progress is released exactly when its cast
 * time completes; then, if not casting, the first spell in `policy` that `startCast` accepts
 * is started. Damage comes from the engine's attributed HpEvents, so effect ticks (Ignite,
 * Living Bomb) count toward the spell that applied them.
 */
export const simulate = ({ loadout, policy, durationSeconds = 60, maxCasts = {} }: SimInput): SimResult => {
    for (const id of [...loadout, ...policy]) if (!isSpellId(id)) throw new Error(`unknown spell id: ${id}`)
    const order = policy.map(id => {
        const index = loadout.indexOf(id)
        if (index === -1) throw new Error(`policy spell ${id} is not in the loadout`)
        return index
    })
    if (!(Number.isFinite(durationSeconds) && durationSeconds > 0))
        throw new Error('durationSeconds must be a finite positive number')
    for (const [id, cap] of Object.entries(maxCasts)) {
        if (!loadout.includes(id as SpellId)) throw new Error(`maxCasts spell ${id} is not in the loadout`)
        if (!(Number.isInteger(cap) && cap! >= 0)) throw new Error(`maxCasts for ${id} must be a non-negative integer`)
    }

    const battle = new Battle({ name: 'Caster', spells: loadout }, { name: 'Dummy', spells: [], hp: DUMMY_HP })
    const totalTicks = secondsToTicks(durationSeconds)
    const damage = new Map<SpellId, number>()
    const casts = new Map<SpellId, number>()
    let logSeen = 0

    const act = () => {
        const { gameTick } = battle.state
        const player = battle.state[CASTER]
        if (player.cast !== null) {
            const spell = player.spells[player.cast]
            if (gameTick < player.castStartingTick! + spell.castTime) return
            battle.stopCast(CASTER, player.cast)
            collect() // count the release before deciding what to start next (maxCasts)
        }
        for (const index of order) {
            const cap = maxCasts[loadout[index]]
            if (cap !== undefined && (casts.get(loadout[index]) ?? 0) >= cap) continue
            if (battle.startCast(CASTER, index)) break
        }
    }

    const collect = () => {
        for (const event of battle.drainEvents()) {
            if (event.player !== DUMMY || event.amount >= 0) continue
            damage.set(event.source, (damage.get(event.source) ?? 0) - event.amount)
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

    let totalDamage = 0
    for (const value of damage.values()) totalDamage += value
    const perSpell: SimResult['perSpell'] = {}
    for (const id of loadout) {
        const dmg = damage.get(id) ?? 0
        const n = casts.get(id) ?? 0
        if (dmg === 0 && n === 0) continue
        perSpell[id] = { damage: round(dmg), casts: n, share: totalDamage > 0 ? round(dmg / totalDamage) : 0 }
    }
    const seconds = ticksToSeconds(totalTicks)
    return { totalDamage: round(totalDamage), dps: round(totalDamage / seconds), durationSeconds: seconds, perSpell }
}

/** Strips float noise (e.g. 0.1 + 0.2) so output is stable and readable. */
const round = (n: number) => Math.round(n * 1e6) / 1e6

const isIdList = (v: unknown): v is SpellId[] => Array.isArray(v) && v.every(isSpellId)

/** Validates untrusted input (e.g. a CLI JSON file), throwing a readable error. */
export const parseSimInput = (raw: unknown): SimInput => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('input must be a JSON object')
    const { loadout, policy, durationSeconds, maxCasts } = raw as Record<string, unknown>
    if (!isIdList(loadout) || loadout.length === 0) throw new Error('"loadout" must be a non-empty array of spell ids')
    if (!isIdList(policy) || policy.length === 0) throw new Error('"policy" must be a non-empty array of spell ids')
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
    return {
        loadout,
        policy,
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        ...(maxCasts !== undefined ? { maxCasts: maxCasts as SimInput['maxCasts'] } : {}),
    }
}
