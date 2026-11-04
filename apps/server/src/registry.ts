import { DurableObject } from 'cloudflare:workers'
import {
    LOBBY_CODE_ALPHABET,
    LOBBY_CODE_LENGTH,
    type LobbyListing,
    type RegistryMessage,
} from '@magus/engine/protocol'
import type { Env } from './env'

const MAX_LOBBIES = 500
/** Codes handed out but never connected to are released after this. */
const RESERVATION_TTL = 2 * 60 * 1000
/** Safety net for lobbies that vanished without delisting (e.g. a redeploy). */
const LISTING_TTL = 6 * 60 * 60 * 1000

interface Entry {
    listing: LobbyListing | null
    updatedAt: number
}

const randomCode = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(LOBBY_CODE_LENGTH))
    return [...bytes].map(b => LOBBY_CODE_ALPHABET[b % LOBBY_CODE_ALPHABET.length]).join('')
}

/**
 * Single instance holding the public lobby list. Uses WebSocket hibernation so idle
 * lobby-list viewers cost nothing; entries live in storage so they survive hibernation.
 */
export class LobbyRegistry extends DurableObject<Env> {
    async reserveCode(): Promise<string | null> {
        const entries = await this.entries()
        if (entries.size >= MAX_LOBBIES) return null
        let code = randomCode()
        while (entries.has(code)) code = randomCode()
        await this.ctx.storage.put<Entry>(`lobby:${code}`, { listing: null, updatedAt: Date.now() })
        return code
    }

    async update(listing: LobbyListing) {
        await this.ctx.storage.put<Entry>(`lobby:${listing.code}`, { listing, updatedAt: Date.now() })
        await this.broadcast()
    }

    async remove(code: string) {
        await this.ctx.storage.delete(`lobby:${code}`)
        await this.broadcast()
    }

    override async fetch(): Promise<Response> {
        const { 0: client, 1: server } = new WebSocketPair()
        this.ctx.acceptWebSocket(server)
        server.send(JSON.stringify(await this.message()))
        return new Response(null, { status: 101, webSocket: client })
    }

    override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
        if (message === 'refresh') ws.send(JSON.stringify(await this.message()))
    }

    override async webSocketClose(ws: WebSocket, code: number) {
        ws.close(code, 'closing')
    }

    private async entries() {
        const entries = await this.ctx.storage.list<Entry>({ prefix: 'lobby:' })
        const now = Date.now()
        const expired: string[] = []
        const live = new Map<string, Entry>()
        for (const [key, entry] of entries) {
            const ttl = entry.listing ? LISTING_TTL : RESERVATION_TTL
            if (now - entry.updatedAt > ttl) expired.push(key)
            else live.set(key.slice('lobby:'.length), entry)
        }
        if (expired.length) await this.ctx.storage.delete(expired)
        return live
    }

    private async message(): Promise<RegistryMessage> {
        const lobbies = [...(await this.entries()).values()]
            .map(entry => entry.listing)
            .filter((listing): listing is LobbyListing => listing !== null)
        return { t: 'lobbies', lobbies }
    }

    private async broadcast() {
        const sockets = this.ctx.getWebSockets()
        if (!sockets.length) return
        const payload = JSON.stringify(await this.message())
        for (const ws of sockets) {
            try {
                ws.send(payload)
            } catch {
                // socket already closing
            }
        }
    }
}
