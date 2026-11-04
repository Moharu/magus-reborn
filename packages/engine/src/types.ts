export type PlayerKey = 'player1' | 'player2'
export type School = 'FIRE' | 'GENERAL'
export type EffectType = 'positive' | 'negative'

export type SpellId =
    | 'SPELL_FIREBALL'
    | 'SPELL_IGNITE'
    | 'SPELL_COMBUSTION'
    | 'SPELL_AFTERBURN'
    | 'SPELL_LIVING_BOMB'
    | 'SPELL_METEOR'
    | 'SPELL_HASTE'
    | 'SPELL_COUNTERSPELL'
    | 'SPELL_TEMPORAL_SHIELD'
    | 'SPELL_MAGIC_EATER'
    | 'SPELL_BLUR'

interface EffectBase {
    label: string
    type: EffectType
    startingTick: number
    duration: number
    /** Spell that applied this effect, used for damage attribution. */
    source: SpellId
    tickInterval?: number
    dispelProtection?: boolean
}

export interface IgniteDebuff extends EffectBase {
    id: 'DEBUFF_IGNITE'
    damage: number
}
export interface LivingBombDebuff extends EffectBase {
    id: 'DEBUFF_LIVING_BOMB'
    damage: number
    expirationDamage: number
}
export interface CounterspellDebuff extends EffectBase {
    id: 'DEBUFF_COUNTERSPELL'
}
export interface HasteBuff extends EffectBase {
    id: 'BUFF_HASTE'
    backup: number[]
    compareTick: number
}
export interface BlurBuff extends EffectBase {
    id: 'BUFF_BLUR'
}
export interface MagicEaterBuff extends EffectBase {
    id: 'BUFF_MAGIC_EATER'
    healingPercentage: number
    lastTargetHp: number
}
export interface TemporalShieldBuff extends EffectBase {
    id: 'BUFF_TEMPORAL_SHIELD'
    healingPercentage: number
    backup: number
}

export type EffectState =
    | IgniteDebuff
    | LivingBombDebuff
    | CounterspellDebuff
    | HasteBuff
    | BlurBuff
    | MagicEaterBuff
    | TemporalShieldBuff
export type EffectId = EffectState['id']

export interface SpellState {
    id: SpellId
    /** In ticks. 0 means instant. */
    castTime: number
    /** In ticks. 0 means no cooldown. */
    cooldown: number
    globalCooldown: number
    lastCast: number | null
}

export interface PlayerState {
    name: string
    hp: number
    effects: EffectState[]
    cast: number | null
    castStartingTick: number | null
    globalCooldown: number
    spells: SpellState[]
}

export type LogEntry =
    | { type: 'SPELL_RELEASE'; caster: PlayerKey; spellIndex: number; tick: number }
    | { type: 'START_CAST'; caster: PlayerKey; spellIndex: number; tick: number }
    | { type: 'STOP_CAST'; caster: PlayerKey; tick: number }

export type Winner = PlayerKey | 'draw' | null

export interface BattleState {
    version: string
    gameTick: number
    winner: Winner
    player1: PlayerState
    player2: PlayerState
    log: LogEntry[]
}

/** Everything but the log, which is streamed incrementally. */
export type BattleSnapshot = Omit<BattleState, 'log'>

export interface HpEvent {
    tick: number
    /** Whose hp changed. */
    player: PlayerKey
    /** Negative for damage, positive for healing. */
    amount: number
    source: SpellId
    kind: 'spell' | 'effect'
}

export interface CastContext {
    caster: PlayerKey
    target: PlayerKey
}

export interface EffectContext {
    target: PlayerKey
    enemy: PlayerKey
}

export interface SpellDefinition {
    id: SpellId
    school: School
    label: string
    description: string
    advancedDescription: string
    castSeconds?: number
    cooldownSeconds?: number
    globalCooldownTicks?: number
    reducer: (state: BattleState, ctx: CastContext) => void
}

export type EffectReducer<E extends EffectState = EffectState> = (
    state: BattleState,
    ctx: EffectContext,
    effect: E,
) => void

export type EffectReducers = { [K in EffectId]: EffectReducer<Extract<EffectState, { id: K }>> }
