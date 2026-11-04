import { DurableObject } from 'cloudflare:workers'
import type { ServerMessage } from '@magus/engine/protocol'
import { registryOf, type Env } from './env'
import { Lobby } from './lobby'

/**
 * One instance per lobby code. Holds the lobby in memory; the battle ticks every 50ms
 * so hibernation wouldn't help while a match runs.
 */
export class LobbyRoom extends DurableObject<Env> {
    private lobby: Lobby | null = null
    private sockets = new Map<string, WebSocket>()

    /** Called by the worker right after the registry hands out the code. */
    async init(code: string) {
        this.lobby?.dispose()
        this.lobby = null
        await this.ctx.storage.put('code', code)
    }

    override async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url)
        const lobby = await this.getLobby()
        const { 0: client, 1: server } = new WebSocketPair()
        server.accept()

        if (!lobby) {
            server.send(JSON.stringify({ t: 'error', message: 'Lobby not found', fatal: true } satisfies ServerMessage))
            server.close(4404, 'Lobby not found')
            return new Response(null, { status: 101, webSocket: client })
        }

        const connId = crypto.randomUUID()
        this.sockets.set(connId, server)
        server.addEventListener('message', event => {
            if (typeof event.data !== 'string' || event.data.length > 2048) return
            let parsed: unknown
            try {
                parsed = JSON.parse(event.data)
            } catch {
                return
            }
            this.lobby?.message(connId, parsed)
        })
        const onGone = () => {
            if (!this.sockets.delete(connId)) return
            this.lobby?.disconnect(connId)
        }
        server.addEventListener('close', onGone)
        server.addEventListener('error', onGone)

        lobby.connect(connId, url.searchParams.get('playerId'), url.searchParams.get('name'))
        return new Response(null, { status: 101, webSocket: client })
    }

    private async getLobby(): Promise<Lobby | null> {
        if (this.lobby && !this.lobby.isClosed) return this.lobby
        const code = await this.ctx.storage.get<string>('code')
        if (!code) return null
        this.lobby = new Lobby(code, {
            send: (connId, message) => this.send(connId, message),
            broadcast: message => {
                const payload = JSON.stringify(message)
                for (const connId of this.sockets.keys()) this.send(connId, payload)
            },
            close: (connId, reason) => {
                const ws = this.sockets.get(connId)
                this.sockets.delete(connId)
                ws?.close(4000, reason.slice(0, 120))
            },
            listingChanged: listing => {
                const registry = registryOf(this.env)
                const update = listing ? registry.update(listing) : registry.remove(code)
                this.ctx.waitUntil(update.catch(err => console.error('registry update failed', err)))
            },
            closed: () => {
                this.lobby = null
                this.ctx.waitUntil(this.ctx.storage.deleteAll())
            },
        })
        return this.lobby
    }

    private send(connId: string, message: ServerMessage | string) {
        const ws = this.sockets.get(connId)
        if (!ws) return
        try {
            ws.send(typeof message === 'string' ? message : JSON.stringify(message))
        } catch {
            // closed mid-send; the close handler cleans up
        }
    }
}
