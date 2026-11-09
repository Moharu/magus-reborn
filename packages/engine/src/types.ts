export type PlayerKey = 'player1' | 'player2'
export type School = 'FIRE' | 'FROST' | 'GENERAL'
export type EffectType = 'positive' | 'negative'

export type SpellId =
    | 'SPELL_FIREBALL'
    | 'SPELL_IGNITE'
    | 'SPELL_COMBUSTION'
    | 'SPELL_AFTERBURN'
    | 'SPELL_LIVING_BOMB'
    | 'SPELL_METEOR'
    | 'SPELL_FROSTBOLT'
    | 'SPELL_GLACIER'
    | 'SPELL_FROST_BOMB'
    | 'SPELL_ICE_SPEAR'
    | 'SPELL_ICY_TOUCH'
    | 'SPELL_FROST_FEVER'
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
export interface FrostFeverDebuff extends EffectBase {
    id: 'DEBUFF_FROST_FEVER'
    /** Total damage over the whole duration, dealt a share per tick. */
    damage: number
}
export interface FrostBombDebuff extends EffectBase {
    id: 'DEBUFF_FROST_BOMB'
    /** Damage of each pulse. The bomb pulses every `tickInterval` ticks, the last pulse on its expiry tick. */
    pulseDamage: number
}
export interface CounterspellDebuff extends EffectBase {
    id: 'DEBUFF_COUNTERSPELL'
}
export interface HasteBuff extends EffectBase {
    id: 'BUFF_HASTE'
    backup: number[]
    /** Log entries before this index were already checked for a consuming cast. */
    logIndex: number
}
export interface BlurBuff extends EffectBase {
    id: 'BUFF_BLUR'
}
export interface MagicEaterBuff extends EffectBase {
    id: 'BUFF_MAGIC_EATER'
    healingPercentage: number
    /** Damage the buff owner dealt since the last heal, healed on the next buff tick. */
    pendingDamage: number
    /**
     * Heal owed but not yet given, in ten-thousandths of HP an integer.
     * Its magnitude is at most half a centi-HP (50), and it can be negative when a tick's heal was rounded up.
     * Carried between ticks so small per-tick heals still sum to exactly the percentage of damage dealt.
     */
    healCarry: number
}
export interface TemporalShieldBuff extends EffectBase {
    id: 'BUFF_TEMPORAL_SHIELD'
    healingPercentage: number
    backup: number
}

export type EffectState =
    | IgniteDebuff
    | LivingBombDebuff
    | FrostFeverDebuff
    | FrostBombDebuff
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
    /** The unmodified cast time in seconds, 0 for instants. Haste changes `castTime`, never this. */
    castSeconds: number
    /** In ticks. 0 means no cooldown. */
    cooldown: number
    /** In ticks: the GCD this spell starts on release. 0 for cast-time and off-GCD spells. */
    globalCooldown: number
    lastCast: number | null
}

export interface PlayerState {
    name: string
    hp: number
    effects: EffectState[]
    cast: number | null
    castStartingTick: number | null
    /** Tick until which the GCD blocks on-GCD and cast-time spells. Written only by casting. */
    gcdUntil: number
    /** Tick until which a Counterspell lock blocks every spell. Independent of effects: cleansing does not clear it. */
    lockedUntil: number
    /**
     * Frost's Chilling stacks, a resource on the caster: 0 to `CHILLING_MAX_STACKS`, no duration. Gained when a Frost
     * cast completes, spent by Ice Spear and Icy Touch. Starts at 0 in every battle, so it resets each round.
     */
    chilling: number
    spells: SpellState[]
}

export type LogEntry =
    /** Cast entries carry the id of the spell, so a viewer who can't see the caster's loadout can still name it. */
    | { type: 'SPELL_RELEASE'; caster: PlayerKey; spellIndex: number; spellId: SpellId; tick: number }
    | { type: 'START_CAST'; caster: PlayerKey; spellIndex: number; spellId: SpellId; tick: number }
    | { type: 'STOP_CAST'; caster: PlayerKey; tick: number }
    /** The caster's own cast was cancelled by using an instant mid-cast or replaced by starting a new cast. */
    | { type: 'CANCEL_CAST'; caster: PlayerKey; spellIndex: number; spellId: SpellId; tick: number }
    /**
     * `player`'s cast of the spell (`spellId`, in `spellIndex`) was interrupted by the enemy's `source` spell. Written right
     * after that spell's SPELL_RELEASE, whose `caster` is the interrupter; only when a cast was really interrupted.
     */
    | { type: 'INTERRUPTED'; player: PlayerKey; spellIndex: number; spellId: SpellId; tick: number; source: SpellId }

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
export type BattleSnapshot = Omit<BattleState, 'log'> & {
    /** True after the deciding tick ends. Absent in older snapshots. */
    finished?: boolean
}

/**
 * A player as one viewer may see them. `spells` (the loadout) is absent when the viewer isn't allowed to see it, and
 * `casting` then still holds the one spell being cast, which the cast bar shows anyway.
 */
export type PlayerView = Omit<PlayerState, 'spells' | 'effects'> & {
    spells?: SpellState[]
    casting?: SpellState | null
    effects: ViewEffect[]
}

/** An effect as a viewer sees it. A Haste buff's `backup` holds every slot's cast time, so only the owner gets it. */
export type ViewEffect = Exclude<EffectState, HasteBuff> | (Omit<HasteBuff, 'backup'> & { backup?: number[] })

/** A `BattleSnapshot` as one viewer may see it; every `BattleSnapshot` is one. */
export type SnapshotView = Omit<BattleSnapshot, PlayerKey> & Record<PlayerKey, PlayerView>

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
    /** Instants only: if true, it neither starts nor is blocked by the GCD. Cast-time spells never start one. */
    offGlobalCooldown?: boolean
    /** Instants only: if true, using it mid-cast keeps the current cast going. Default false (cancels it). */
    usableWhileCasting?: boolean
    /**
     * Instants only: Chilling stacks the spell needs and spends on release. `startCast` rejects it with fewer stacks,
     * before it would cancel the current cast, like a GCD or cooldown rejection.
     */
    chillingCost?: number
    reducer: (state: BattleState, ctx: CastContext) => void
}

export type EffectReducer<E extends EffectState = EffectState> = (
    state: BattleState,
    ctx: EffectContext,
    effect: E,
) => void

export type EffectReducers = { [K in EffectId]: EffectReducer<Extract<EffectState, { id: K }>> }
