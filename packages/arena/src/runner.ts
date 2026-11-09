import {
    Battle,
    cooldownRemaining,
    fromCenti,
    isValidLoadout,
    lockRemaining,
    secondsToTicks,
    toCenti,
    type EffectState,
    type LogEntry,
    type PlayerKey,
    type PlayerState,
    type SpellId,
} from '@magus/engine'
import { deriveSeed, isSeed, Rng } from './prng'
import type {
    Action,
    Controller,
    Decision,
    EnemyLogEntry,
    Entrant,
    MatchEndReason,
    MatchEvent,
    MatchResult,
    Side,
    SideStats,
} from './types'

/** 3 minutes of game time at the engine's tick rate (3600 ticks at 50 ms). */
export const DEFAULT_MAX_TICKS = secondsToTicks(180)

export interface MatchOptions {
    /** An integer in [0, 2^32). Each side's controller gets its own stream derived from it. */
    seed: number
    a: Entrant
    b: Entrant
    /** Time cap in ticks; reaching it with both players alive is a draw. Default `DEFAULT_MAX_TICKS`. */
    maxTicks?: number
    /** Build the match log. Default true; tournaments can turn it off. */
    log?: boolean
}

const SIDE_OF: Record<PlayerKey, Side> = { player1: 'a', player2: 'b' }

/** The mutable objects behind one player's `ArenaView`, refreshed in place every tick. */
interface ViewState {
    /** The only object the controller gets. */
    view: {
        tick: number
        self: {
            hp: number
            casting: OwnCast | null
            gcdUntil: number
            lockedUntil: number
            effects: EffectSlot[]
            spells: SpellSlot[]
        }
        enemy: { hp: number; casting: Cast | null; lockedUntil: number; effects: EffectSlot[]; log: EnemyLogEntry[] }
    }
    /** Reused cast objects, linked from the view only while that player is casting. */
    ownCast: OwnCast
    enemyCast: Cast
    /** Reused effect objects, grown on demand; the view arrays hold the first `effects.length` of them. */
    ownEffects: EffectSlot[]
    enemyEffects: EffectSlot[]
}

interface Cast {
    spellId: SpellId
    startTick: number
    castTime: number
    completesAt: number
}
interface OwnCast extends Cast {
    slot: number
}
interface EffectSlot {
    id: EffectState['id']
    type: EffectState['type']
    startingTick: number
    expiresAt: number
}
interface SpellSlot {
    id: SpellId
    castTime: number
    cooldownRemaining: number
    lockRemaining: number
    ready: boolean
}

const emptyCast = (): OwnCast => ({ spellId: 'SPELL_FIREBALL', startTick: 0, castTime: 0, completesAt: 0, slot: 0 })
const emptyEnemyCast = (): Cast => ({ spellId: 'SPELL_FIREBALL', startTick: 0, castTime: 0, completesAt: 0 })

const createView = (loadout: readonly SpellId[]): ViewState => ({
    view: {
        tick: 0,
        self: {
            hp: 0,
            casting: null,
            gcdUntil: 0,
            lockedUntil: 0,
            effects: [],
            spells: loadout.map(id => ({ id, castTime: 0, cooldownRemaining: 0, lockRemaining: 0, ready: false })),
        },
        enemy: { hp: 0, casting: null, lockedUntil: 0, effects: [], log: [] },
    },
    ownCast: emptyCast(),
    enemyCast: emptyEnemyCast(),
    ownEffects: [],
    enemyEffects: [],
})

/**
 * Copies what the buff bar shows of each effect into `into` (reusing `pool`): id, kind and timer, never the effect's
 * internal fields, which can hold hidden state (Haste's `backup` is every slot's cast time, so the loadout).
 */
const readEffects = (effects: readonly EffectState[], into: EffectSlot[], pool: EffectSlot[]) => {
    into.length = effects.length
    for (let i = 0; i < effects.length; i++) {
        const effect = effects[i]
        const slot = (pool[i] ??= { id: effect.id, type: effect.type, startingTick: 0, expiresAt: 0 })
        slot.id = effect.id
        slot.type = effect.type
        slot.startingTick = effect.startingTick
        slot.expiresAt = effect.startingTick + effect.duration
        into[i] = slot
    }
}

/** Copies the cast in progress into `into`; false if `player` isn't casting. */
const readCast = (player: PlayerState, into: Cast) => {
    if (player.cast === null) return false
    const spell = player.spells[player.cast]
    into.spellId = spell.id
    into.startTick = player.castStartingTick!
    into.castTime = spell.castTime
    into.completesAt = into.startTick + spell.castTime
    return true
}

/**
 * Fills `view` with what `self` may see. Of the enemy it reads only what a client shows (the server's opponent
 * redaction): HP, the spell being cast, the lock and the buff bar (its spell log is `readEnemyLogs`'). Never the
 * loadout, cooldowns or GCD.
 */
const refresh = (state: ViewState, self: PlayerState, enemy: PlayerState, tick: number) => {
    const { view, ownCast, enemyCast } = state
    view.tick = tick
    const own = view.self
    own.hp = self.hp
    own.gcdUntil = self.gcdUntil
    own.lockedUntil = self.lockedUntil
    readEffects(self.effects, own.effects, state.ownEffects)
    // Haste swaps the engine's spell objects, so read them fresh every tick
    for (let i = 0; i < own.spells.length; i++) {
        const spell = self.spells[i]
        const slot = own.spells[i]
        slot.castTime = spell.castTime
        slot.cooldownRemaining = cooldownRemaining(spell, tick)
        slot.lockRemaining = lockRemaining(self, spell, tick)
        slot.ready = slot.cooldownRemaining === 0 && slot.lockRemaining === 0
    }
    if (readCast(self, ownCast)) {
        ownCast.slot = self.cast!
        own.casting = ownCast
    } else own.casting = null

    view.enemy.hp = enemy.hp
    view.enemy.lockedUntil = enemy.lockedUntil
    readEffects(enemy.effects, view.enemy.effects, state.enemyEffects)
    view.enemy.casting = readCast(enemy, enemyCast) ? enemyCast : null
}

/**
 * Reads the engine log the server streams to both clients (#126) into each player's `enemy.log`, from entry `from` on,
 * and returns where it stopped. An entry goes to the view of the player it is not about: the caster's opponent, or for
 * INTERRUPTED the interrupter (the interrupted player's opponent). It keeps only what the client's spell log shows,
 * the type, the tick and the spell id, never the loadout slot. A STOP_CAST names the cast it stopped, the one its
 * caster last started, as the client does. `lastStarted` holds each player's latest START_CAST spell.
 */
const readEnemyLogs = (
    entries: readonly LogEntry[],
    from: number,
    views: Record<PlayerKey, ViewState>,
    lastStarted: Record<PlayerKey, SpellId | undefined>,
) => {
    for (let i = from; i < entries.length; i++) {
        const entry = entries[i]
        const player = entry.type === 'INTERRUPTED' ? entry.player : entry.caster
        let spellId: SpellId | undefined
        if (entry.type === 'STOP_CAST') spellId = lastStarted[player]
        else {
            spellId = entry.spellId
            if (entry.type === 'START_CAST') lastStarted[player] = spellId
        }
        if (spellId === undefined) continue
        views[player === 'player1' ? 'player2' : 'player1'].view.enemy.log.push({
            tick: entry.tick,
            type: entry.type,
            spellId,
        })
    }
    return entries.length
}

const emptyStats = (): SideStats => ({
    casts: 0,
    started: 0,
    cancelled: 0,
    interrupts: 0,
    interrupted: 0,
    rejected: 0,
    damageTaken: 0,
})

/**
 * Applies one action; false if the engine rejected it. A `stop` is accepted when the engine logs it, which it does for
 * the cast in progress whether that releases it or cancels it early.
 */
const apply = (battle: Battle, key: PlayerKey, action: Action) => {
    if (action.type === 'start') return battle.startCast(key, action.slot)
    if (action.type !== 'stop') return false
    const logged = battle.state.log.length
    battle.stopCast(key, action.slot)
    return battle.state.log.length > logged
}

/** Applies a decision in order and returns how many of its actions the engine rejected. */
const act = (battle: Battle, key: PlayerKey, decision: Decision) => {
    if (decision === null) return 0
    if (!Array.isArray(decision)) return apply(battle, key, decision as Action) ? 0 : 1
    let rejected = 0
    for (const action of decision as readonly Action[]) if (!apply(battle, key, action)) rejected += 1
    return rejected
}

const validate = ({ seed, a, b, maxTicks }: MatchOptions & { maxTicks: number }) => {
    if (!isSeed(seed)) throw new Error(`seed must be an integer in [0, 2^32), got ${seed}`)
    if (!(Number.isSafeInteger(maxTicks) && maxTicks > 0))
        throw new Error(`maxTicks must be a positive integer, got ${maxTicks}`)
    for (const [side, entrant] of [
        ['a', a],
        ['b', b],
    ] as const) {
        if (!isValidLoadout([...entrant.loadout])) throw new Error(`entrant ${side} (${entrant.name}): invalid loadout`)
        if (typeof entrant.controller !== 'function')
            throw new Error(`entrant ${side} (${entrant.name}): controller must be a function`)
    }
}

/** Per-side stats and the side-keyed log, from the engine's log and HP events. */
const summarize = (battle: Battle, withLog: boolean) => {
    const stats: Record<Side, SideStats> = { a: emptyStats(), b: emptyStats() }
    const log: MatchEvent[] = []
    const entries = battle.state.log
    // each side's latest START_CAST: the cast a later STOP_CAST ends (only a cast in progress can be stopped)
    const castSlot: Record<Side, number> = { a: -1, b: -1 }
    const castSpell: Record<Side, SpellId | undefined> = { a: undefined, b: undefined }
    for (let i = 0; i < entries.length; i++) {
        const entry: LogEntry = entries[i]
        const side = SIDE_OF[entry.type === 'INTERRUPTED' ? entry.player : entry.caster]
        const own = stats[side]
        switch (entry.type) {
            case 'START_CAST':
                own.started += 1
                castSlot[side] = entry.spellIndex
                castSpell[side] = entry.spellId
                break
            case 'SPELL_RELEASE':
                own.casts += 1
                break
            case 'CANCEL_CAST':
                own.cancelled += 1
                break
            case 'STOP_CAST': {
                // a releasing stop is followed at once by the release of that same slot; any other stop cancelled
                // the cast, even when an instant started right after it releases on the same tick
                const next = entries[i + 1]
                const released =
                    next?.type === 'SPELL_RELEASE' &&
                    next.caster === entry.caster &&
                    next.tick === entry.tick &&
                    next.spellIndex === castSlot[side]
                if (!released) own.cancelled += 1
                break
            }
            case 'INTERRUPTED':
                own.interrupted += 1
                stats[side === 'a' ? 'b' : 'a'].interrupts += 1
                break
        }
        if (!withLog) continue
        if (entry.type === 'STOP_CAST') log.push({ tick: entry.tick, side, type: entry.type, spellId: castSpell[side] })
        else if (entry.type === 'INTERRUPTED')
            log.push({ tick: entry.tick, side, type: entry.type, spellId: entry.spellId, source: entry.source })
        else log.push({ tick: entry.tick, side, type: entry.type, spellId: entry.spellId })
    }
    const taken: Record<Side, number> = { a: 0, b: 0 }
    for (const event of battle.drainEvents()) {
        if (event.amount < 0) taken[SIDE_OF[event.player]] += toCenti(-event.amount)
    }
    stats.a.damageTaken = fromCenti(taken.a)
    stats.b.damageTaken = fromCenti(taken.b)
    return { stats, log }
}

/**
 * Plays one best-of-1 match at 100 HP between two controllers on the real engine. Each loop:
 *   1. both views are refreshed from the same state, so the two decisions are simultaneous;
 *   2. `a`'s actions are applied, then `b`'s (engine order player1 then player2; tournaments swap sides);
 *   3. `Battle.tick()` advances the game.
 * The match ends when the engine's result is final (`Battle.finished`): actions in the tick the winner is decided still
 * resolve, so same-tick lethal damage to both players is a draw. Tick `maxTicks` resolves like any other tick: both
 * players act on it, and a winner decided on it counts. With both players still alive after it, the match is a draw.
 */
export const runMatch = (options: MatchOptions): MatchResult => {
    const { seed, a, b, maxTicks = DEFAULT_MAX_TICKS, log = true } = options
    validate({ ...options, maxTicks })

    const loadoutA = Object.freeze([...a.loadout])
    const loadoutB = Object.freeze([...b.loadout])
    const battle = new Battle({ name: a.name, spells: [...loadoutA] }, { name: b.name, spells: [...loadoutB] })
    const decideA: Controller = a.controller({ loadout: loadoutA, rng: new Rng(deriveSeed(seed, 1)) })
    const decideB: Controller = b.controller({ loadout: loadoutB, rng: new Rng(deriveSeed(seed, 2)) })
    const viewA = createView(loadoutA)
    const viewB = createView(loadoutB)
    let rejectedA = 0
    let rejectedB = 0
    const state = battle.state

    const views: Record<PlayerKey, ViewState> = { player1: viewA, player2: viewB }
    const lastStarted: Record<PlayerKey, SpellId | undefined> = { player1: undefined, player2: undefined }
    let logRead = 0

    let timeout = false
    while (!battle.finished) {
        // what the clients' spell logs have received by now: every entry logged on earlier ticks
        logRead = readEnemyLogs(state.log, logRead, views, lastStarted)
        refresh(viewA, state.player1, state.player2, state.gameTick)
        refresh(viewB, state.player2, state.player1, state.gameTick)
        const decisionA = decideA(viewA.view)
        const decisionB = decideB(viewB.view)
        rejectedA += act(battle, 'player1', decisionA)
        rejectedB += act(battle, 'player2', decisionB)
        // the cap tick resolves like any other; only with no winner after it is the match a timeout
        if (state.winner === null && state.gameTick >= maxTicks) {
            timeout = true
            break
        }
        battle.tick()
    }

    const winner: Side | 'draw' = timeout || state.winner === 'draw' ? 'draw' : SIDE_OF[state.winner!]
    const reason: MatchEndReason = timeout ? 'timeout' : state.winner === 'draw' ? 'mutual' : 'death'
    const summary = summarize(battle, log)
    summary.stats.a.rejected = rejectedA
    summary.stats.b.rejected = rejectedB
    return {
        seed,
        winner,
        reason,
        ticks: state.gameTick,
        hp: { a: state.player1.hp, b: state.player2.hp },
        stats: summary.stats,
        log: summary.log,
    }
}
