import { env, runInDurableObject } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { RegistryMessage } from '@magus/engine/protocol'
import { registryOf } from '../../src/env'
import { LobbyRegistry } from '../../src/registry'
import { closeAllSockets, connectRegistry, createLobby, join, RecordingSocket, upgrade } from './helpers'

/** What the runtime reports for a socket that ended without a close frame, and for a close frame with no code. */
const CLOSE_ABNORMAL = 1006
const CLOSE_NO_STATUS = 1005

let webSocketClose: MockInstance<LobbyRegistry['webSocketClose']>

// The Durable Objects run in the same isolate as the tests, so this sees every call the runtime makes.
beforeEach(() => {
    webSocketClose = vi.spyOn(LobbyRegistry.prototype, 'webSocketClose')
})

afterEach(() => {
    closeAllSockets()
    vi.restoreAllMocks()
})

/** Waits for the registry to handle a close reported with `code`, and returns how that call settled. */
const closeHandled = async (code: number) => {
    // the runtime passes (ws, code, reason, wasClean), though the registry only declares ws
    const reported = (call: unknown[]) => call[1] === code
    await vi.waitFor(() => expect(webSocketClose.mock.calls.some(reported)).toBe(true))
    const index = webSocketClose.mock.calls.findIndex(reported)
    return webSocketClose.mock.settledResults[index]
}

/**
 * Opens a lobby list connection whose client end lives in another Durable Object, then aborts that object. Its socket
 * goes away without a close frame, which the registry sees as 1006, the same as a killed tab or a lost network.
 * workerd logs the abort itself as an uncaught `broken.outputGateBroken` error, which is expected.
 */
const dropRegistrySocket = async () => {
    const holder = env.LOBBY.get(env.LOBBY.idFromName('registry-drop-test'))
    await runInDurableObject(holder, async () => {
        const res = await registryOf(env).fetch('https://worker.test/api/lobbies', {
            headers: { Upgrade: 'websocket' },
        })
        res.webSocket?.accept()
    })
    await expect(runInDurableObject(holder, (_, state) => state.abort('dropping the connection'))).rejects.toThrow()
}

/** Creates a lobby, seats a player so it's listed, and waits for `viewer` to see it. */
const expectNewLobbyListedFor = async (viewer: RecordingSocket<RegistryMessage>) => {
    const code = await createLobby()
    await join(code, 'alice-id', 'Alice')
    const update = await viewer.waitFor(message => message.lobbies.some(listing => listing.code === code))
    expect(update.lobbies.find(listing => listing.code === code)).toMatchObject({ code, player1: 'Alice' })
    return code
}

describe('lobby list connections closing', () => {
    it('completes a clean close from the client', async () => {
        const viewer = await connectRegistry()
        await viewer.waitFor(message => message.t === 'lobbies')

        viewer.close()

        expect(await viewer.closed).toEqual({ code: 1000, reason: 'closing' })
        expect(await closeHandled(1000)).toEqual({ type: 'fulfilled', value: undefined })
    })

    it('handles a connection that drops without a close frame and keeps serving the others', async () => {
        const viewer = await connectRegistry()
        await viewer.waitFor(message => message.t === 'lobbies')

        await dropRegistrySocket()

        expect(await closeHandled(CLOSE_ABNORMAL)).toEqual({ type: 'fulfilled', value: undefined })
        const code = await expectNewLobbyListedFor(viewer)
        const latecomer = await connectRegistry()
        const first = await latecomer.waitFor(message => message.t === 'lobbies')
        expect(first.lobbies.map(listing => listing.code)).toContain(code)
    })

    it('answers a close with no code and keeps serving the others', async () => {
        const viewer = await connectRegistry()
        await viewer.waitFor(message => message.t === 'lobbies')
        const res = await upgrade('/api/lobbies')
        if (!res.webSocket) throw new Error(`Upgrade returned ${res.status}`)
        const leaving = new RecordingSocket<RegistryMessage>(res.webSocket)
        await leaving.waitFor(message => message.t === 'lobbies')

        // a close frame with no code, which the registry is told about as 1005
        res.webSocket.close()

        expect(await leaving.closed).toEqual({ code: 1000, reason: 'closing' })
        expect(await closeHandled(CLOSE_NO_STATUS)).toEqual({ type: 'fulfilled', value: undefined })
        await expectNewLobbyListedFor(viewer)
    })
})
