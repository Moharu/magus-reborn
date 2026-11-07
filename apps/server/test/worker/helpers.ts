import { exports } from 'cloudflare:workers'
import type { ClientMessage, LobbyInfo, RegistryMessage, ServerMessage } from '@magus/engine/protocol'

/** In ALLOWED_ORIGINS for these tests; see vitest.config.ts. */
export const ALLOWED_ORIGIN = 'https://allowed.example'
export const ALSO_ALLOWED_ORIGIN = 'https://also-allowed.example'
export const DISALLOWED_ORIGIN = 'https://evil.example'

/** Shorter than Vitest's 5 s test timeout, so a missing message fails with the list of what did arrive. */
const WAIT_TIMEOUT_MS = 3000
/** Slower than the rate limit refills, so these retries can't keep a connection over it. */
const RETRY_PING_INTERVAL_MS = 100

/** Sends a request through the Worker's real `fetch` handler. `origin: null` sends no Origin header. */
export const workerFetch = (path: string, init: RequestInit = {}, origin: string | null = ALLOWED_ORIGIN) => {
    const headers = new Headers(init.headers)
    if (origin !== null) headers.set('Origin', origin)
    return exports.default.fetch(new Request(`https://worker.test${path}`, { ...init, headers }))
}

/** Sends a WebSocket upgrade request and returns the raw response, so a refused upgrade can be asserted on. */
export const upgrade = (path: string, origin: string | null = ALLOWED_ORIGIN) =>
    workerFetch(path, { headers: { Upgrade: 'websocket' } }, origin)

export const createLobby = async () => {
    const res = await workerFetch('/api/lobbies', { method: 'POST' })
    if (res.status !== 201) throw new Error(`creating a lobby returned ${res.status}`)
    const { code } = await res.json<{ code: string }>()
    return code
}

export interface CloseInfo {
    code: number
    reason: string
}

/** Accepts a WebSocket and records what it receives, in order, so a test can wait on it. */
export class RecordingSocket<M> {
    /** Resolves when the socket closes. */
    readonly closed: Promise<CloseInfo>
    protected readonly received: M[] = []
    protected cursor = 0
    private wake: (() => void) | null = null
    protected isClosed = false
    private closeSent = false

    constructor(private readonly ws: WebSocket) {
        ws.accept()
        ws.addEventListener('message', event => {
            this.received.push(JSON.parse(event.data as string) as M)
            this.wake?.()
        })
        this.closed = new Promise(resolve => {
            ws.addEventListener('close', event => {
                this.isClosed = true
                resolve({ code: event.code, reason: event.reason })
                this.wake?.()
            })
        })
    }

    /** Sends a frame as is, including payloads the protocol types wouldn't allow. */
    sendRaw(data: string | ArrayBuffer) {
        this.ws.send(data)
    }

    /**
     * Returns the first unread message that matches, marking it and everything before it as read. Rejects after
     * WAIT_TIMEOUT_MS or once the socket closes, listing what did arrive.
     */
    waitFor<S extends M>(match: (message: M) => message is S): Promise<S>
    waitFor(match: (message: M) => boolean): Promise<M>
    async waitFor(match: (message: M) => boolean): Promise<M> {
        const deadline = Date.now() + WAIT_TIMEOUT_MS
        for (;;) {
            while (this.cursor < this.received.length) {
                const message = this.received[this.cursor++]
                if (match(message)) return message
            }
            const remaining = deadline - Date.now()
            if (remaining <= 0 || this.isClosed) {
                throw new Error(`Expected message never arrived. Received: ${JSON.stringify(this.received)}`)
            }
            await new Promise<void>(resolve => {
                const timer = setTimeout(resolve, remaining)
                this.wake = () => {
                    clearTimeout(timer)
                    resolve()
                }
            })
            this.wake = null
        }
    }

    /** Closes the socket from the client side, as a dropped connection or closed tab would. Safe to call twice. */
    close() {
        if (this.isClosed || this.closeSent) return
        this.closeSent = true
        this.ws.close(1000, 'client closed')
    }
}

type MessageOf<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

/** A connection to a lobby's Durable Object, as the web client holds one. */
export class LobbyClient extends RecordingSocket<ServerMessage> {
    private pings = 0

    send(message: ClientMessage) {
        this.sendRaw(JSON.stringify(message))
    }

    /** The next unread message of type `t`, optionally also satisfying `match`. */
    next<T extends ServerMessage['t']>(t: T, match: (message: MessageOf<T>) => boolean = () => true) {
        return this.waitFor((message): message is MessageOf<T> => message.t === t && match(message as MessageOf<T>))
    }

    /** The next lobby state that satisfies `match`. */
    async nextLobby(match: (lobby: LobbyInfo) => boolean): Promise<LobbyInfo> {
        return (await this.next('meta', message => match(message.lobby))).lobby
    }

    /**
     * Pings, waits for the pong and returns the unread messages that arrived before it, marking them as read.
     *
     * The server handles a socket's frames in order and sends its replies in order, so by the time the pong is back,
     * the server has handled everything this socket sent earlier and anything it sent this socket because of that has
     * already arrived. That makes "the server sent nothing" checkable without sleeping. It also holds across sockets:
     * after A's sync returns, B's sync sees any broadcast that A's earlier frames caused.
     *
     * Each call uses one message of the connection's rate limit.
     */
    async sync(): Promise<ServerMessage[]> {
        const from = this.cursor
        const at = ++this.pings
        this.send({ t: 'ping', at })
        await this.next('pong', message => message.at === at)
        return this.received.slice(from, this.cursor - 1)
    }

    /**
     * `sync` for a connection that may be over its rate limit, which would silently drop a single ping. Pings until one
     * is answered. Only the first answer ends the wait, so no retry's pong is in the result.
     */
    async syncOverLimit(): Promise<ServerMessage[]> {
        const from = this.cursor
        const sent = new Set<number>()
        const ping = () => {
            if (this.isClosed) return
            sent.add(++this.pings)
            this.send({ t: 'ping', at: this.pings })
        }
        ping()
        const retries = setInterval(ping, RETRY_PING_INTERVAL_MS)
        try {
            await this.next('pong', message => sent.has(message.at))
        } finally {
            clearInterval(retries)
        }
        return this.received.slice(from, this.cursor - 1)
    }
}

const acceptedSocket = (res: Response) => {
    if (res.status !== 101 || !res.webSocket) throw new Error(`Upgrade returned ${res.status}`)
    return res.webSocket
}

/** Wraps a successful upgrade response in a client that `closeAllSockets` will clean up. */
export const lobbyClientFrom = (res: Response) => track(new LobbyClient(acceptedSocket(res)))

/** Upgrades a connection to the lobby without waiting for any message. */
export const connect = async (code: string, playerId?: string, name?: string) => {
    const params = new URLSearchParams()
    if (playerId !== undefined) params.set('playerId', playerId)
    if (name !== undefined) params.set('name', name)
    return lobbyClientFrom(await upgrade(`/api/lobbies/${code}?${params}`))
}

/** Connects to the lobby and waits for `welcome`. */
export const join = async (code: string, playerId: string, name?: string) => {
    const client = await connect(code, playerId, name)
    const welcome = await client.next('welcome')
    return { client, welcome }
}

/** Creates a lobby with both seats taken. Both clients have read everything up to the second player joining. */
export const lobbyWithTwoPlayers = async () => {
    const code = await createLobby()
    const { client: alice } = await join(code, 'alice-id', 'Alice')
    const { client: bob } = await join(code, 'bob-id', 'Bob')
    await alice.nextLobby(lobby => lobby.player2 !== null)
    await bob.nextLobby(lobby => lobby.player2 !== null)
    return { code, alice, bob }
}

/** Connects to the public lobby list. */
export const connectRegistry = async () =>
    track(new RecordingSocket<RegistryMessage>(acceptedSocket(await upgrade('/api/lobbies'))))

const openSockets = new Set<{ close(): void }>()
const track = <S extends { close(): void }>(socket: S) => {
    openSockets.add(socket)
    return socket
}

/** Closes every socket the test opened. Use with `afterEach`, so lobbies and their timers don't outlive the test. */
export const closeAllSockets = () => {
    for (const socket of openSockets) socket.close()
    openSockets.clear()
}
