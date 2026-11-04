import { Battle, DEFAULT_SPELLS, GAME_TICK_INTERVAL, isValidLoadout, type PlayerKey, type SpellId } from '@magus/engine'
import {
    BEST_OF_OPTIONS,
    DEFAULT_SETTINGS,
    gamesToWin,
    MAX_SPECTATORS,
    sanitizeName,
    SETUP_TIME_MAX,
    SETUP_TIME_MIN,
    type ClientMessage,
    type LobbyInfo,
    type LobbyListing,
    type LobbyPlayerInfo,
    type LobbySettings,
    type Phase,
    type Role,
    type RoundResult,
    type ServerMessage,
} from '@magus/engine/protocol'

export const START_COUNTDOWN = 3
export const READY_SETUP_COUNTDOWN = 3
export const BATTLE_COUNTDOWN = 3
export const ROUND_OVER_COUNTDOWN = 10
export const RECONNECT_GRACE = 30
/** Messages per second a connection may send before the rest are dropped. */
export const RATE_LIMIT = 40

export interface LobbyTransport {
    send(connId: string, message: ServerMessage): void
    broadcast(message: ServerMessage): void
    close(connId: string, reason: string): void
    /** Called when the public listing changes. Null means the lobby should be delisted. */
    listingChanged(listing: LobbyListing | null): void
    /** Called once nobody is left and the lobby can be discarded. */
    closed(): void
}

interface Seat {
    playerId: string
    name: string
    ready: boolean
    wins: number
    spells: SpellId[]
    connId: string | null
}

interface Connection {
    playerId: string
    role: Role
    name: string
    budget: number
    budgetSecond: number
}

const SEATS: PlayerKey[] = ['player1', 'player2']
const other = (key: PlayerKey): PlayerKey => (key === 'player1' ? 'player2' : 'player1')

export const sanitizeSettings = (current: LobbySettings, patch: unknown): LobbySettings => {
    const next = { ...current }
    if (typeof patch !== 'object' || patch === null) return next
    const p = patch as Record<string, unknown>
    if (BEST_OF_OPTIONS.includes(p.bestOf as never)) next.bestOf = p.bestOf as LobbySettings['bestOf']
    if (typeof p.setupTime === 'number' && Number.isFinite(p.setupTime)) {
        next.setupTime = Math.min(SETUP_TIME_MAX, Math.max(SETUP_TIME_MIN, Math.round(p.setupTime)))
    }
    if (typeof p.allowSpellChange === 'boolean') next.allowSpellChange = p.allowSpellChange
    if (typeof p.maxSpectators === 'number' && Number.isFinite(p.maxSpectators)) {
        next.maxSpectators = Math.min(MAX_SPECTATORS, Math.max(0, Math.round(p.maxSpectators)))
    }
    return next
}

export class Lobby {
    settings: LobbySettings = { ...DEFAULT_SETTINGS }
    phase: Phase = 'lobby'
    matchStarted = false
    round = 0
    admin: PlayerKey | null = null
    seats: Record<PlayerKey, Seat | null> = { player1: null, player2: null }
    rounds: RoundResult[] = []
    matchWinner: PlayerKey | null = null
    paused = false
    pauseReason: string | null = null
    battle: Battle | null = null
    isClosed = false

    private connections = new Map<string, Connection>()
    private countdownValue: number | null = null
    private countdownDone: (() => void) | null = null
    private countdownHandle: ReturnType<typeof setInterval> | null = null
    private ticker: ReturnType<typeof setInterval> | null = null
    private forfeitHandle: ReturnType<typeof setTimeout> | null = null
    private logSent = 0
    private lastListing = ''

    constructor(
        readonly code: string,
        private readonly transport: LobbyTransport,
    ) {}

    // connections

    connect(connId: string, playerId: unknown, rawName: unknown) {
        if (this.isClosed) {
            this.reject(connId, 'Lobby not found')
            return
        }
        if (typeof playerId !== 'string' || playerId.length === 0 || playerId.length > 64) {
            this.reject(connId, 'Missing player id')
            return
        }

        let role: Role | null = this.seatOf(playerId)
        if (role) {
            const seat = this.seats[role]!
            if (seat.connId && seat.connId !== connId) {
                this.connections.delete(seat.connId)
                this.transport.close(seat.connId, 'Connected from another tab')
            }
            seat.connId = connId
        } else if (!this.matchStarted && this.freeSeat()) {
            role = this.freeSeat()!
            this.seats[role] = {
                playerId,
                name: sanitizeName(rawName, role === 'player1' ? 'Player 1' : 'Player 2'),
                ready: false,
                wins: 0,
                spells: [...DEFAULT_SPELLS],
                connId,
            }
            if (!this.admin) this.admin = role
        } else if (this.spectatorCount() < this.settings.maxSpectators) {
            role = 'spectator'
        } else {
            this.reject(connId, 'No spectator slots available')
            return
        }

        const name = role === 'spectator' ? sanitizeName(rawName, 'Spectator') : this.seats[role]!.name
        this.connections.set(connId, { playerId, role, name, budget: RATE_LIMIT, budgetSecond: 0 })
        this.transport.send(connId, {
            t: 'welcome',
            role,
            spells: role === 'spectator' ? null : this.seats[role]!.spells,
        })
        if (this.battle) this.transport.send(connId, this.battleMessage(0))

        if (role !== 'spectator' && this.paused && this.bothConnected()) this.resume()
        this.changed()
    }

    disconnect(connId: string) {
        const conn = this.connections.get(connId)
        if (!conn) return
        this.connections.delete(connId)

        if (conn.role !== 'spectator') {
            const key = conn.role
            const seat = this.seats[key]
            if (seat && seat.connId === connId) {
                if (!this.matchStarted) {
                    this.seats[key] = null
                    if (this.admin === key) this.admin = this.seats[other(key)] ? other(key) : null
                    // the other player may have readied against someone else
                    const remaining = this.seats[other(key)]
                    if (remaining) remaining.ready = false
                } else if (this.phase !== 'match_over') {
                    seat.connId = null
                    this.pause(`${seat.name} disconnected`)
                    this.startForfeitTimer()
                } else {
                    seat.connId = null
                }
            }
        }

        if (this.connections.size === 0 && (!this.matchStarted || this.phase === 'match_over')) {
            this.close()
            return
        }
        this.changed()
    }

    message(connId: string, raw: unknown) {
        const conn = this.connections.get(connId)
        if (!conn || !this.withinRateLimit(conn)) return
        if (typeof raw !== 'object' || raw === null) return
        const msg = raw as ClientMessage
        if (msg.t === 'ping') {
            if (typeof msg.at === 'number') this.transport.send(connId, { t: 'pong', at: msg.at })
            return
        }
        if (conn.role === 'spectator') return
        const key = conn.role
        const seat = this.seats[key]
        if (!seat) return

        switch (msg.t) {
            case 'ready':
                return this.onReady(seat)
            case 'unready':
                if (this.phase === 'lobby' && !this.matchStarted && seat.ready) {
                    seat.ready = false
                    this.changed()
                }
                return
            case 'set_spells':
                if (!isValidLoadout(msg.spells)) {
                    this.transport.send(connId, { t: 'error', message: 'Invalid spell selection' })
                    return
                }
                if (!this.canChangeSpells(seat)) return
                seat.spells = [...msg.spells]
                this.transport.send(connId, { t: 'loadout', spells: seat.spells })
                return
            case 'start_cast':
                if (this.canCast() && Number.isInteger(msg.i)) this.battle!.startCast(key, msg.i)
                return
            case 'stop_cast':
                if (this.canCast() && Number.isInteger(msg.i)) this.battle!.stopCast(key, msg.i)
                return
            case 'settings':
                if (this.admin !== key || this.matchStarted) return
                this.settings = sanitizeSettings(this.settings, msg.settings)
                // nobody should be locked in to settings they didn't see
                for (const s of SEATS) if (this.seats[s]) this.seats[s]!.ready = false
                this.changed()
                return
        }
    }

    // views

    info(): LobbyInfo {
        const player = (key: PlayerKey): LobbyPlayerInfo | null => {
            const seat = this.seats[key]
            return seat && { name: seat.name, ready: seat.ready, wins: seat.wins, connected: seat.connId !== null }
        }
        return {
            code: this.code,
            phase: this.phase,
            round: this.round,
            countdown: this.countdownValue,
            paused: this.paused,
            pauseReason: this.pauseReason,
            matchStarted: this.matchStarted,
            matchWinner: this.matchWinner,
            admin: this.admin,
            player1: player('player1'),
            player2: player('player2'),
            spectators: [...this.connections.values()].filter(c => c.role === 'spectator').map(c => c.name),
            settings: this.settings,
            rounds: this.rounds,
        }
    }

    listing(): LobbyListing {
        return {
            code: this.code,
            player1: this.seats.player1?.name ?? null,
            player2: this.seats.player2?.name ?? null,
            phase: this.phase,
            round: this.round,
            bestOf: this.settings.bestOf,
            spectators: this.spectatorCount(),
            maxSpectators: this.settings.maxSpectators,
        }
    }

    /** Stops all timers. */
    dispose() {
        this.clearCountdown()
        this.stopTicker()
        if (this.forfeitHandle) clearTimeout(this.forfeitHandle)
        this.forfeitHandle = null
    }

    // phases

    private onReady(seat: Seat) {
        if (seat.ready) return
        if (this.phase === 'lobby' && !this.matchStarted) {
            seat.ready = true
            if (this.seats.player1?.ready && this.seats.player2?.ready) {
                this.matchStarted = true
                this.countdown(START_COUNTDOWN, () => {
                    this.round = 1
                    this.enterSetup()
                })
            }
            this.changed()
        } else if (this.phase === 'set_up') {
            seat.ready = true
            if (
                this.seats.player1!.ready &&
                this.seats.player2!.ready &&
                this.countdownValue! > READY_SETUP_COUNTDOWN
            ) {
                this.countdownValue = READY_SETUP_COUNTDOWN
            }
            this.changed()
        }
    }

    private enterSetup() {
        for (const key of SEATS) this.seats[key]!.ready = false
        if (this.round === 1 || this.settings.allowSpellChange) {
            this.phase = 'set_up'
            this.countdown(this.settings.setupTime, () => this.enterBattleCountdown())
            this.changed()
        } else {
            this.enterBattleCountdown()
        }
    }

    private enterBattleCountdown() {
        const p1 = this.seats.player1!
        const p2 = this.seats.player2!
        for (const seat of [p1, p2]) seat.ready = false
        this.phase = 'battle_countdown'
        this.battle = new Battle({ name: p1.name, spells: p1.spells }, { name: p2.name, spells: p2.spells })
        this.logSent = 0
        this.transport.broadcast(this.battleMessage(0))
        this.countdown(BATTLE_COUNTDOWN, () => this.enterBattle())
        this.changed()
    }

    private enterBattle() {
        this.phase = 'battle'
        this.startTicker()
        this.changed()
    }

    private onTick() {
        const battle = this.battle!
        battle.tick()
        this.transport.broadcast(this.battleMessage(this.logSent))
        if (battle.state.winner) this.endRound()
    }

    private endRound() {
        this.stopTicker()
        const state = this.battle!.state
        const winner = state.winner
        this.rounds.push({
            round: this.round,
            winner,
            ticks: state.gameTick,
            player1: { hp: state.player1.hp, spells: state.player1.spells.map(s => s.id) },
            player2: { hp: state.player2.hp, spells: state.player2.spells.map(s => s.id) },
        })
        if (winner === 'player1' || winner === 'player2') {
            const seat = this.seats[winner]!
            seat.wins += 1
            if (seat.wins >= gamesToWin(this.settings.bestOf)) {
                this.endMatch(winner)
                return
            }
        }
        this.phase = 'round_over'
        this.countdown(ROUND_OVER_COUNTDOWN, () => {
            this.round += 1
            this.enterSetup()
        })
        this.changed()
    }

    private endMatch(winner: PlayerKey | null) {
        this.dispose()
        this.paused = false
        this.pauseReason = null
        this.phase = 'match_over'
        this.matchWinner = winner
        this.changed()
        if (![...this.connections.values()].length) this.close()
    }

    private pause(reason: string) {
        this.paused = true
        this.pauseReason = reason
        this.stopTicker()
        if (this.countdownHandle) clearInterval(this.countdownHandle)
        this.countdownHandle = null
    }

    private resume() {
        this.paused = false
        this.pauseReason = null
        if (this.forfeitHandle) clearTimeout(this.forfeitHandle)
        this.forfeitHandle = null
        if (this.phase === 'battle') this.startTicker()
        if (this.countdownDone) this.armCountdown()
    }

    private startForfeitTimer() {
        if (this.forfeitHandle) return
        this.forfeitHandle = setTimeout(() => {
            this.forfeitHandle = null
            const connected = SEATS.filter(key => this.seats[key]?.connId)
            this.endMatch(connected.length === 1 ? connected[0] : null)
        }, RECONNECT_GRACE * 1000)
    }

    // timers

    private countdown(seconds: number, done: () => void) {
        this.clearCountdown()
        this.countdownValue = seconds
        this.countdownDone = done
        if (!this.paused) this.armCountdown()
    }

    private armCountdown() {
        this.countdownHandle = setInterval(() => {
            this.countdownValue! -= 1
            if (this.countdownValue! <= 0) {
                const done = this.countdownDone!
                this.clearCountdown()
                done()
            } else {
                this.changed()
            }
        }, 1000)
    }

    private clearCountdown() {
        if (this.countdownHandle) clearInterval(this.countdownHandle)
        this.countdownHandle = null
        this.countdownValue = null
        this.countdownDone = null
    }

    private startTicker() {
        this.stopTicker()
        this.ticker = setInterval(() => this.onTick(), GAME_TICK_INTERVAL)
    }

    private stopTicker() {
        if (this.ticker) clearInterval(this.ticker)
        this.ticker = null
    }

    // helpers

    private battleMessage(logFrom: number): ServerMessage {
        const battle = this.battle!
        const log = battle.state.log.slice(logFrom)
        this.logSent = battle.state.log.length
        return { t: 'battle', snap: battle.snapshot(), log, logFrom, events: battle.drainEvents() }
    }

    private canCast() {
        return this.phase === 'battle' && !this.paused && this.battle !== null
    }

    private canChangeSpells(seat: Seat) {
        if (this.phase === 'lobby') return true
        return this.phase === 'set_up' && !seat.ready && (this.round === 1 || this.settings.allowSpellChange)
    }

    private seatOf(playerId: string): PlayerKey | null {
        return SEATS.find(key => this.seats[key]?.playerId === playerId) ?? null
    }

    private freeSeat(): PlayerKey | null {
        return SEATS.find(key => !this.seats[key]) ?? null
    }

    private bothConnected() {
        return SEATS.every(key => this.seats[key]?.connId)
    }

    private spectatorCount() {
        let count = 0
        for (const conn of this.connections.values()) if (conn.role === 'spectator') count++
        return count
    }

    private withinRateLimit(conn: Connection) {
        const second = Math.floor(Date.now() / 1000)
        if (second !== conn.budgetSecond) {
            conn.budgetSecond = second
            conn.budget = RATE_LIMIT
        }
        return conn.budget-- > 0
    }

    private reject(connId: string, message: string) {
        this.transport.send(connId, { t: 'error', message, fatal: true })
        this.transport.close(connId, message)
    }

    private changed() {
        this.transport.broadcast({ t: 'meta', lobby: this.info() })
        const listing = this.phase === 'match_over' ? null : this.listing()
        const serialized = JSON.stringify(listing)
        if (serialized !== this.lastListing) {
            this.lastListing = serialized
            this.transport.listingChanged(listing)
        }
    }

    private close() {
        if (this.isClosed) return
        this.isClosed = true
        this.dispose()
        if (this.lastListing !== 'null') this.transport.listingChanged(null)
        this.transport.closed()
    }
}
