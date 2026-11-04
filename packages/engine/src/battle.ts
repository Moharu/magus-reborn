import { EFFECT_REDUCERS, SPELLS } from './catalog'
import { ENGINE_VERSION, GLOBAL_COOLDOWN, MAX_HP, secondsToTicks } from './constants'
import type {
    BattleSnapshot,
    BattleState,
    EffectReducer,
    EffectState,
    HpEvent,
    LogEntry,
    PlayerKey,
    PlayerState,
    SpellId,
    SpellState,
} from './types'
import { flushMagicEater } from './spells/general/magic-eater'
import { enemyOf, fromCenti, isCasting, toCenti } from './utils'

export interface PlayerInit {
    name: string
    spells: SpellId[]
    hp?: number
}

const PAIRS: [PlayerKey, PlayerKey][] = [
    ['player1', 'player2'],
    ['player2', 'player1'],
]

export const createSpellState = (id: SpellId): SpellState => {
    const def = SPELLS[id]
    return {
        id,
        castTime: def.castSeconds ? secondsToTicks(def.castSeconds) : 0,
        cooldown: def.cooldownSeconds ? secondsToTicks(def.cooldownSeconds) : 0,
        globalCooldown: def.castSeconds || def.offGlobalCooldown ? 0 : GLOBAL_COOLDOWN,
        lastCast: null,
    }
}

const createPlayer = ({ name, spells, hp = MAX_HP }: PlayerInit): PlayerState => ({
    name,
    hp,
    effects: [],
    cast: null,
    castStartingTick: null,
    gcdUntil: 0,
    lockedUntil: 0,
    spells: spells.map(createSpellState),
})

/** Ticks remaining until the spell is off cooldown, 0 if ready. */
export const cooldownRemaining = (spell: SpellState, gameTick: number) =>
    spell.lastCast !== null && spell.cooldown ? Math.max(0, spell.lastCast + spell.cooldown - gameTick) : 0

/** Ticks remaining on the player's GCD, 0 if free. */
export const gcdRemaining = (player: PlayerState, gameTick: number) => Math.max(0, player.gcdUntil - gameTick)

/**
 * Ticks remaining until the player may start `spell` because of the GCD or a Counterspell lock, 0 if free.
 * A lock blocks every spell; the GCD blocks on-GCD spells and cast-time spells, but not off-GCD spells.
 */
export const lockRemaining = (player: PlayerState, spell: SpellState, gameTick: number) => {
    const locked = Math.max(0, player.lockedUntil - gameTick)
    const gcd = SPELLS[spell.id].offGlobalCooldown ? 0 : gcdRemaining(player, gameTick)
    return Math.max(locked, gcd)
}

export class Battle {
    state: BattleState
    private events: HpEvent[] = []
    private winnerTick: number | null = null

    constructor(player1: PlayerInit, player2: PlayerInit) {
        this.state = {
            version: ENGINE_VERSION,
            gameTick: 0,
            winner: null,
            player1: createPlayer(player1),
            player2: createPlayer(player2),
            log: [],
        }
    }

    tick() {
        const state = this.state
        if (state.winner) return
        state.gameTick += 1

        for (const [target, enemy] of PAIRS) {
            for (const effect of [...state[target].effects]) {
                // an earlier reducer this tick may have removed it (e.g. Blur cleanse)
                if (!state[target].effects.includes(effect)) continue
                if (!effect.tickInterval || (state.gameTick - effect.startingTick) % effect.tickInterval === 0) {
                    const reducer = EFFECT_REDUCERS[effect.id] as EffectReducer<EffectState>
                    this.measure(effect.source, 'effect', () => reducer(state, { target, enemy }, effect))
                }
            }
        }

        // after both players' effects, before expiry: identical timing for both, last-tick damage included
        for (const [key] of PAIRS) {
            for (const effect of state[key].effects) {
                if (effect.id !== 'BUFF_MAGIC_EATER') continue
                this.measure(effect.source, 'effect', () => flushMagicEater(state, key, effect))
            }
        }

        for (const [key] of PAIRS) {
            state[key].effects = state[key].effects.filter(
                effect => state.gameTick < effect.startingTick + effect.duration,
            )
        }

        this.resolveDeaths()
    }

    /** Clamps HP at 0 and sets `winner`; both dead at once is a draw. Runs after every tick and cast. */
    private resolveDeaths() {
        const state = this.state
        // a winner decided earlier in this same tick can still become a draw
        if (state.winner && this.winnerTick !== state.gameTick) return
        const p1Dead = state.player1.hp <= 0
        const p2Dead = state.player2.hp <= 0
        if (p1Dead) state.player1.hp = 0
        if (p2Dead) state.player2.hp = 0
        if (p1Dead && p2Dead) state.winner = 'draw'
        else if (p1Dead) state.winner = 'player2'
        else if (p2Dead) state.winner = 'player1'
        if (state.winner && this.winnerTick === null) this.winnerTick = state.gameTick
    }

    startCast(caster: PlayerKey, spellIndex: number): boolean {
        const state = this.state
        const player = state[caster]
        if (state.winner) return false

        const spell = player.spells[spellIndex]
        if (!spell) return false
        // checked before cancelling: a spell rejected by the GCD leaves the current cast alone
        if (lockRemaining(player, spell, state.gameTick) > 0) return false
        if (cooldownRemaining(spell, state.gameTick) > 0) return false

        if (!spell.castTime) {
            if (player.cast !== null && !SPELLS[spell.id].usableWhileCasting) {
                this.log({ type: 'CANCEL_CAST', caster, spellIndex: player.cast, tick: state.gameTick })
                player.cast = null
                player.castStartingTick = null
            }
            this.castSpell(caster, spellIndex)
            return true
        }
        this.log({ type: 'START_CAST', caster, spellIndex, tick: state.gameTick })
        player.cast = spellIndex
        player.castStartingTick = state.gameTick
        return true
    }

    /** Releases the spell in `spellIndex` if it is the one being cast. */
    stopCast(caster: PlayerKey, spellIndex: number): boolean {
        const state = this.state
        const player = state[caster]
        if (player.cast !== spellIndex) return false
        this.log({ type: 'STOP_CAST', caster, tick: state.gameTick })
        let released = false
        if (isCasting(player)) {
            const spell = player.spells[player.cast!]
            if (state.gameTick >= player.castStartingTick! + spell.castTime) {
                this.castSpell(caster, player.cast!)
                released = true
            }
        }
        player.cast = null
        player.castStartingTick = null
        return released
    }

    /** HP changes since the last call, attributed to the spell that caused them. */
    drainEvents(): HpEvent[] {
        const events = this.events
        this.events = []
        return events
    }

    snapshot(): BattleSnapshot {
        const { log: _log, ...rest } = this.state
        return JSON.parse(JSON.stringify(rest)) as BattleSnapshot
    }

    private castSpell(caster: PlayerKey, spellIndex: number) {
        const state = this.state
        this.log({ type: 'SPELL_RELEASE', caster, spellIndex, tick: state.gameTick })
        const spell = state[caster].spells[spellIndex]
        spell.lastCast = state.gameTick
        // never shortens a longer GCD already running; the Counterspell lock (lockedUntil) is separate
        if (spell.globalCooldown)
            state[caster].gcdUntil = Math.max(state[caster].gcdUntil, state.gameTick + spell.globalCooldown)
        const def = SPELLS[spell.id]
        this.measure(spell.id, 'spell', () => def.reducer(state, { caster, target: enemyOf(caster) }))
        this.resolveDeaths()
    }

    private log(entry: LogEntry) {
        this.state.log.push(entry)
    }

    private measure(source: SpellId, kind: HpEvent['kind'], run: () => void) {
        const state = this.state
        const before1 = state.player1.hp
        const before2 = state.player2.hp
        run()
        const tick = state.gameTick
        // differences on the centi-HP grid, so event amounts are exact (e.g. -13.3, never -13.299999999999997)
        const d1 = fromCenti(toCenti(state.player1.hp) - toCenti(before1))
        const d2 = fromCenti(toCenti(state.player2.hp) - toCenti(before2))
        if (d1 !== 0) this.events.push({ tick, player: 'player1', amount: d1, source, kind })
        if (d2 !== 0) this.events.push({ tick, player: 'player2', amount: d2, source, kind })
    }
}
