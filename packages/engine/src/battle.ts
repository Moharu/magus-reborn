import { EFFECT_REDUCERS, SPELLS } from './catalog'
import { DEFAULT_GLOBAL_COOLDOWN, ENGINE_VERSION, MAX_HP, secondsToTicks } from './constants'
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
import { enemyOf, isCasting } from './utils'

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
        globalCooldown: def.globalCooldownTicks ?? DEFAULT_GLOBAL_COOLDOWN,
        lastCast: null,
    }
}

const createPlayer = ({ name, spells, hp = MAX_HP }: PlayerInit): PlayerState => ({
    name,
    hp,
    effects: [],
    cast: null,
    castStartingTick: null,
    globalCooldown: 0,
    spells: spells.map(createSpellState),
})

/** Ticks remaining until the spell is off cooldown, 0 if ready. */
export const cooldownRemaining = (spell: SpellState, gameTick: number) =>
    spell.lastCast && spell.cooldown ? Math.max(0, spell.lastCast + spell.cooldown - gameTick) : 0

export class Battle {
    state: BattleState
    private events: HpEvent[] = []

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
            for (const effect of state[target].effects) {
                if (!effect.tickInterval || (state.gameTick - effect.startingTick) % effect.tickInterval === 0) {
                    const reducer = EFFECT_REDUCERS[effect.id] as EffectReducer<EffectState>
                    this.measure(effect.source, 'effect', () => reducer(state, { target, enemy }, effect))
                }
            }
        }

        for (const [key] of PAIRS) {
            state[key].effects = state[key].effects.filter(
                effect => state.gameTick < effect.startingTick + effect.duration,
            )
        }

        if (state.player1.hp <= 0) {
            state.player1.hp = 0
            state.winner = 'player2'
        } else if (state.player2.hp <= 0) {
            state.player2.hp = 0
            state.winner = 'player1'
        }
    }

    startCast(caster: PlayerKey, spellIndex: number): boolean {
        const state = this.state
        const player = state[caster]
        if (state.gameTick < player.globalCooldown) return false

        const spell = player.spells[spellIndex]
        if (!spell) return false
        if (spell.lastCast && spell.cooldown && state.gameTick <= spell.lastCast + spell.cooldown) return false

        if (!spell.castTime) {
            this.castSpell(caster, spellIndex)
            return true
        }
        this.log({ type: 'START_CAST', caster, spellIndex, tick: state.gameTick })
        player.cast = spellIndex
        player.castStartingTick = state.gameTick
        return true
    }

    stopCast(caster: PlayerKey, _spellIndex?: number): boolean {
        const state = this.state
        const player = state[caster]
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
        state[caster].globalCooldown = state.gameTick + spell.globalCooldown
        const def = SPELLS[spell.id]
        this.measure(spell.id, 'spell', () => def.reducer(state, { caster, target: enemyOf(caster) }))
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
        const d1 = state.player1.hp - before1
        const d2 = state.player2.hp - before2
        if (d1 !== 0) this.events.push({ tick, player: 'player1', amount: d1, source, kind })
        if (d2 !== 0) this.events.push({ tick, player: 'player2', amount: d2, source, kind })
    }
}
