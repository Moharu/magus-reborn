import { ENGINE_VERSION } from './constants'
import type { BattleSnapshot, HpEvent, LogEntry, PlayerKey, SpellId, Winner } from './types'

export type BestOf = 1 | 3 | 5
export const BEST_OF_OPTIONS: BestOf[] = [1, 3, 5]

export interface LobbySettings {
    bestOf: BestOf
    /** Seconds to pick spells before each round. */
    setupTime: number
    /** When false, loadouts are locked after the first round's set up. */
    allowSpellChange: boolean
    maxSpectators: number
}

export const DEFAULT_SETTINGS: LobbySettings = {
    bestOf: 3,
    setupTime: 30,
    allowSpellChange: true,
    maxSpectators: 5,
}

export const SETUP_TIME_MIN = 10
export const SETUP_TIME_MAX = 120
export const MAX_SPECTATORS = 8
export const NAME_MAX_LENGTH = 15
export const LOBBY_CODE_LENGTH = 6
export const LOBBY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const LOBBY_CODE_PATTERN = new RegExp(`^[${LOBBY_CODE_ALPHABET}]{${LOBBY_CODE_LENGTH}}$`)

/** The query parameter that carries the client's `ENGINE_VERSION` when it creates or joins a lobby. */
export const VERSION_PARAM = 'v'
/** `VERSION_PARAM` set to this build's version, ready to go in a URL. */
export const VERSION_QUERY = `${VERSION_PARAM}=${encodeURIComponent(ENGINE_VERSION)}`
/** The stable code the server answers a missing or different version with. */
export const VERSION_MISMATCH = 'version_mismatch'
export const NEW_VERSION_MESSAGE = 'A new version is available, please refresh'

export const gamesToWin = (bestOf: BestOf) => Math.ceil(bestOf / 2)

export type Phase = 'lobby' | 'set_up' | 'battle_countdown' | 'battle' | 'round_over' | 'match_over'
export type Role = PlayerKey | 'spectator'

export interface LobbyPlayerInfo {
    name: string
    ready: boolean
    wins: number
    connected: boolean
}

export interface RoundResult {
    round: number
    winner: Winner
    ticks: number
    player1: { hp: number; spells: SpellId[] }
    player2: { hp: number; spells: SpellId[] }
}

export interface LobbyInfo {
    code: string
    phase: Phase
    round: number
    /** Seconds until the current phase advances, if it is timed. */
    countdown: number | null
    paused: boolean
    pauseReason: string | null
    matchStarted: boolean
    /** Set when the match is over. Null with phase match_over means it was abandoned. */
    matchWinner: PlayerKey | null
    admin: PlayerKey | null
    player1: LobbyPlayerInfo | null
    player2: LobbyPlayerInfo | null
    spectators: string[]
    settings: LobbySettings
    rounds: RoundResult[]
}

/** Public summary shown in the lobby list. */
export interface LobbyListing {
    code: string
    player1: string | null
    player2: string | null
    phase: Phase
    round: number
    bestOf: BestOf
    spectators: number
    maxSpectators: number
}

export type ClientMessage =
    | { t: 'ready' }
    | { t: 'unready' }
    | { t: 'set_spells'; spells: SpellId[] }
    | { t: 'start_cast'; i: number }
    | { t: 'stop_cast'; i: number }
    | { t: 'settings'; settings: Partial<LobbySettings> }
    | { t: 'ping'; at: number }

export type ServerMessage =
    | { t: 'welcome'; role: Role; spells: SpellId[] | null }
    | { t: 'meta'; lobby: LobbyInfo }
    | { t: 'loadout'; spells: SpellId[] }
    | {
          t: 'battle'
          snap: BattleSnapshot
          /** Log entries starting at index `logFrom`. */
          log: LogEntry[]
          logFrom: number
          events: HpEvent[]
      }
    | { t: 'error'; message: string; fatal?: boolean; code?: typeof VERSION_MISMATCH }
    | { t: 'pong'; at: number }

export type RegistryMessage = { t: 'lobbies'; lobbies: LobbyListing[] }

export const sanitizeName = (name: unknown, fallback: string) => {
    if (typeof name !== 'string') return fallback
    // drop control characters, collapse whitespace
    const clean = name
        // eslint-disable-next-line no-control-regex -- matching control characters is this regex's purpose
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, NAME_MAX_LENGTH)
    return clean || fallback
}
