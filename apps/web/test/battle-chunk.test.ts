import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GAME_TICK_INTERVAL } from '@magus/engine'
import { NEW_VERSION_MESSAGE, type ServerMessage } from '@magus/engine/protocol'
import {
    BATTLE_COUNTDOWN,
    Lobby,
    READY_SETUP_COUNTDOWN,
    RECONNECT_GRACE,
    START_COUNTDOWN,
} from '../../server/src/lobby'
import { BATTLE_CREATE_ERROR, BATTLE_SETUP_ERROR, loadBattleChunk } from '../src/screens/battle-chunk'
import { FakeElement, FakeNode } from './fake-dom'

// The screens run for real against a real server Lobby, and only the browser is faked: enough DOM for `h`, and a
// WebSocket whose ends are the Lobby's connect/message/disconnect, the calls lobby-room.ts makes for a real socket.

// the real icons draw on a canvas, which node doesn't have
vi.mock('../src/game/icons', () => ({ iconUrl: () => 'icon.png' }))

type Listener = (error: unknown) => void
const nodeProcess = (
    globalThis as unknown as {
        process: {
            listeners(event: string): Listener[]
            removeAllListeners(event: string): void
            on(event: string, listener: Listener): void
        }
    }
).process

let unhandled: unknown[] = []
let vitestListeners: Listener[] = []
let reload: ReturnType<typeof vi.fn>
let lobby: Lobby
let sockets: Map<string, FakeWebSocket>
let nextConn = 0

class FakeWebSocket {
    static OPEN = 1
    readyState = FakeWebSocket.OPEN
    onopen: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onclose: (() => void) | null = null
    readonly connId = `client-${++nextConn}`

    constructor(url: string) {
        const params = new URL(url).searchParams
        sockets.set(this.connId, this)
        queueMicrotask(() => {
            this.onopen?.()
            lobby.connect(this.connId, params.get('playerId'), params.get('name'))
        })
    }
    send(data: string) {
        lobby.message(this.connId, JSON.parse(data))
    }
    close() {
        if (!sockets.delete(this.connId)) return
        this.readyState = 3
        lobby.disconnect(this.connId)
        this.onclose?.()
    }
}

const newLobby = () =>
    new Lobby('ABC234', {
        send: (connId, message) => deliver(connId, message),
        broadcast: message => [...sockets.keys()].forEach(connId => deliver(connId, message)),
        close: connId => sockets.get(connId)?.close(),
        listingChanged() {},
        closed() {},
    })

const deliver = (connId: string, message: ServerMessage) =>
    sockets.get(connId)?.onmessage?.({ data: JSON.stringify(message) })

const realSetTimeout = setTimeout
/** Lets promises and Node's unhandled rejection check run. */
const settle = () => new Promise(resolve => realSetTimeout(resolve, 0))
const seconds = (s: number) => vi.advanceTimersByTimeAsync(s * 1000)

const fakeView = () => ({
    update: vi.fn(),
    destroy: vi.fn(),
    setScore: vi.fn(),
    setFrozen: vi.fn(),
    setOverlay: vi.fn(),
})

type Chunk = () => Promise<unknown>
const FAILED_CHUNK: Chunk = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module'))
const WORKING_CHUNK: Chunk = async () => ({ BattleView: { create: async () => fakeView() } })
const BROKEN_RENDERER: Chunk = async () => ({
    BattleView: { create: () => Promise.reject(new Error('WebGL is not available')) },
})
const pendingChunk = (error = new TypeError('Failed to fetch')) => {
    let reject!: (error: Error) => void
    const promise = new Promise<never>((_, rej) => (reject = rej))
    return { chunk: () => promise, fail: () => reject(error) }
}

/** A fresh copy of the client, as a page load gets. `localStorage` survives, so a refresh keeps the player id. */
const loadPage = async (chunk: Chunk) => {
    vi.resetModules()
    vi.doMock('../src/game/battle-view', chunk)
    const root = new FakeElement('main')
    const { lobbyScreen } = await import('../src/screens/lobby')
    const { trainingScreen } = await import('../src/screens/training')
    return {
        root,
        openLobby: () => lobbyScreen(root as unknown as HTMLElement, ['ABC234']),
        openTraining: () => trainingScreen(root as unknown as HTMLElement),
    }
}

const openLobby = async (chunk: Chunk) => {
    const page = await loadPage(chunk)
    const leave = page.openLobby()
    await settle()
    return { root: page.root, leave }
}

/** The client under test's socket. It is the only one, the players around it being direct Lobby connections. */
const socketOfClient = () => [...sockets.values()].at(0)

/** Takes a lobby with both seats filled to the start of the first battle, when the client asks for the chunk. */
const startBattle = async (ready: string[]) => {
    for (const connId of ready) lobby.message(connId, { t: 'ready' })
    await seconds(START_COUNTDOWN)
    for (const connId of ready) lobby.message(connId, { t: 'ready' })
    await seconds(READY_SETUP_COUNTDOWN)
    expect(lobby.phase).toBe('battle_countdown')
    await settle()
}

/** The client sits in seat one and Bob, a direct connection, in seat two. */
const seatedClient = async (chunk: Chunk) => {
    const client = await openLobby(chunk)
    lobby.connect('bob', 'bob-id', 'Bob')
    await startBattle([socketOfClient()!.connId, 'bob'])
    return client
}

/** Alice and Bob are seated, and the client watches them. */
const spectatingClient = async (chunk: Chunk) => {
    lobby.connect('alice', 'alice-id', 'Alice')
    lobby.connect('bob', 'bob-id', 'Bob')
    lobby.settings.maxSpectators = 1
    const client = await openLobby(chunk)
    await startBattle(['alice', 'bob'])
    return client
}

const expectNoNewVersionMessage = (root: FakeElement) => {
    expect(root.textContent).not.toContain(NEW_VERSION_MESSAGE)
}

const expectNewVersionMessage = (root: FakeElement) => {
    // spelled out rather than the constant: this is the wording #41 asks for
    const alert = root.find(el => el.attrs.get('role') === 'alert')
    expect(alert?.textContent).toContain('A new version is available, please refresh')
    alert!.button('Refresh')!.click()
    expect(reload).toHaveBeenCalledTimes(1)
}

/** Online there is no other way off the panel, since a refresh lands back in the battle. */
const expectBackHomeLink = (root: FakeElement) => {
    const alert = root.find(el => el.attrs.get('role') === 'alert')
    const link = alert?.find(el => el.tag === 'a' && el.textContent === 'Back home')
    expect(link?.attrs.get('href')).toBe('/')
    expect(link?.attrs.has('data-link')).toBe(true)
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const storage = new Map([['magus.name', 'Carol']])
    reload = vi.fn()
    sockets = new Map()
    lobby = newLobby()
    vi.stubGlobal('Node', FakeNode)
    vi.stubGlobal('document', { createElement: (tag: string) => new FakeElement(tag) })
    vi.stubGlobal('location', { origin: 'https://game.example', reload })
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    // vitest fails the run on an unhandled rejection. Taking its place lets each test assert on them, in both directions.
    unhandled = []
    vitestListeners = nodeProcess.listeners('unhandledRejection')
    nodeProcess.removeAllListeners('unhandledRejection')
    nodeProcess.on('unhandledRejection', error => unhandled.push(error))
})

afterEach(() => {
    nodeProcess.removeAllListeners('unhandledRejection')
    for (const listener of vitestListeners) nodeProcess.on('unhandledRejection', listener)
    lobby.dispose()
    vi.doUnmock('../src/game/battle-view')
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
})

describe('loadBattleChunk', () => {
    const handlers = (current = true) => ({
        onLoaded: vi.fn((module: string) => `${module} loaded`),
        onFailed: vi.fn(),
        onCreateFailed: vi.fn(),
        isCurrent: () => current,
    })

    it('hands a loaded module on, and reports no failure', async () => {
        const h = handlers()
        await expect(loadBattleChunk(async () => 'chunk', h)).resolves.toBe('chunk loaded')
        expect(h.onFailed).not.toHaveBeenCalled()
    })

    it('reports a rejected load once, and resolves', async () => {
        const h = handlers()
        await expect(loadBattleChunk(() => Promise.reject(new Error('gone')), h)).resolves.toBeUndefined()
        expect(h.onFailed).toHaveBeenCalledTimes(1)
        expect(h.onLoaded).not.toHaveBeenCalled()
    })

    it('stays quiet about a rejected load nobody is waiting for', async () => {
        const h = handlers(false)
        await expect(loadBattleChunk(() => Promise.reject(new Error('gone')), h)).resolves.toBeUndefined()
        expect(h.onFailed).not.toHaveBeenCalled()
    })

    it('reports a create failure separately and resolves', async () => {
        const h = handlers()
        await expect(
            loadBattleChunk(async () => 'chunk', {
                ...h,
                onLoaded: () => Promise.reject(new Error('renderer')),
            }),
        ).resolves.toBeUndefined()
        expect(h.onFailed).not.toHaveBeenCalled()
        expect(h.onCreateFailed).toHaveBeenCalledWith(BATTLE_CREATE_ERROR)
    })
})

describe('training room', () => {
    const openTraining = async (chunk: Chunk) => {
        const page = await loadPage(chunk)
        const leave = page.openTraining()
        return { root: page.root, leave }
    }

    it('shows the message and a reload control when the import fails', async () => {
        const { root } = await openTraining(FAILED_CHUNK)
        await settle()
        expectNewVersionMessage(root)
        expect(unhandled).toEqual([])
    })

    it('shows nothing and throws nothing when the import fails after the screen was left', async () => {
        const { chunk, fail } = pendingChunk()
        const { root, leave } = await openTraining(chunk)
        leave()
        fail()
        await settle()
        expectNoNewVersionMessage(root)
        expect(unhandled).toEqual([])
    })

    it('does not report a failed BattleView.create as a new version', async () => {
        const { root } = await openTraining(BROKEN_RENDERER)
        await settle()
        expectNoNewVersionMessage(root)
        expect(root.textContent).toContain(BATTLE_CREATE_ERROR)
        expect(unhandled).toEqual([])
    })

    it('shows no message when the import works', async () => {
        const { root } = await openTraining(WORKING_CHUNK)
        await settle()
        expectNoNewVersionMessage(root)
        expect(unhandled).toEqual([])
    })
})

describe('online, for a player', () => {
    it('shows the message and a reload control when the import fails', async () => {
        const { root } = await seatedClient(FAILED_CHUNK)
        expectNewVersionMessage(root)
        expectBackHomeLink(root)
        expect(unhandled).toEqual([])
    })

    it('closes the socket, so the server pauses the match for the opponent', async () => {
        await seatedClient(FAILED_CHUNK)
        expect(sockets.size).toBe(0)
        expect(lobby.info()).toMatchObject({
            phase: 'battle_countdown',
            paused: true,
            pauseReason: 'Carol disconnected',
            player1: { name: 'Carol', connected: false },
        })
    })

    it('does not reconnect by itself, or the match would resume for a player who still has no battle', async () => {
        await seatedClient(FAILED_CHUNK)
        await seconds(RECONNECT_GRACE - 1)
        expect(sockets.size).toBe(0)
        expect(lobby.paused).toBe(true)
    })

    it('stops showing a connection status for the socket it closed', async () => {
        const { root } = await seatedClient(FAILED_CHUNK)
        expect(root.textContent).not.toMatch(/ms|Connecting|Reconnecting/)
    })

    it('holds a paused battle still, then rejoins the same seat and resumes after a refresh', async () => {
        await seatedClient(FAILED_CHUNK)
        await seconds(RECONNECT_GRACE - 1)
        expect(lobby.phase).toBe('battle_countdown')

        const { root } = await openLobby(WORKING_CHUNK)

        expect(lobby.info()).toMatchObject({ paused: false, player1: { name: 'Carol', connected: true } })
        expect(lobby.seats.player1!.connId).toBe(socketOfClient()!.connId)
        expectNoNewVersionMessage(root)

        await seconds(BATTLE_COUNTDOWN)
        expect(lobby.phase).toBe('battle')
        const tick = lobby.battle!.state.gameTick
        await vi.advanceTimersByTimeAsync(GAME_TICK_INTERVAL * 5)
        expect(lobby.battle!.state.gameTick).toBe(tick + 5)
    })

    it('stays paused until both players are back when a deploy caught both of them', async () => {
        await seatedClient(FAILED_CHUNK)
        lobby.disconnect('bob')
        expect(lobby.paused).toBe(true)

        await openLobby(WORKING_CHUNK)
        expect(lobby.paused).toBe(true)

        lobby.connect('bob-again', 'bob-id', 'Bob')
        expect(lobby.paused).toBe(false)
    })

    it('forfeits if the refresh comes after the reconnect grace period', async () => {
        await seatedClient(FAILED_CHUNK)
        await seconds(RECONNECT_GRACE)
        expect(lobby.info()).toMatchObject({ phase: 'match_over', matchWinner: 'player2' })
    })

    it('shows nothing and leaves the match alone when the import fails after the screen was left', async () => {
        const { chunk, fail } = pendingChunk()
        const { root, leave } = await seatedClient(chunk)
        leave()
        const before = lobby.info()
        fail()
        await settle()
        expectNoNewVersionMessage(root)
        expect(lobby.info()).toEqual(before)
        expect(unhandled).toEqual([])
    })

    it('shows nothing and keeps the socket when the import fails after the battle ended', async () => {
        const { chunk, fail } = pendingChunk()
        const { root } = await seatedClient(chunk)
        lobby.disconnect('bob')
        await seconds(RECONNECT_GRACE)
        expect(lobby.phase).toBe('match_over')
        fail()
        await settle()
        expectNoNewVersionMessage(root)
        expect(root.textContent).toContain('Victory!')
        expect(sockets.size).toBe(1)
        expect(unhandled).toEqual([])
    })

    it('shows a generic create error and disconnects', async () => {
        const { root } = await seatedClient(BROKEN_RENDERER)
        expectNoNewVersionMessage(root)
        expect(sockets.size).toBe(0)
        expect(lobby.paused).toBe(true)
        expect(root.textContent).toContain(BATTLE_CREATE_ERROR)
        expectBackHomeLink(root)
        root.button('Refresh')!.click()
        expect(reload).toHaveBeenCalledTimes(1)
        expect(unhandled).toEqual([])
    })

    it('stays connected with no message when the import works', async () => {
        const { root } = await seatedClient(WORKING_CHUNK)
        expectNoNewVersionMessage(root)
        expect(sockets.size).toBe(1)
        expect(lobby.paused).toBe(false)
        expect(unhandled).toEqual([])
    })
})

describe('online, for a spectator', () => {
    it('shows the message and a reload control when the import fails', async () => {
        const { root } = await spectatingClient(FAILED_CHUNK)
        expectNewVersionMessage(root)
        expectBackHomeLink(root)
        expect(unhandled).toEqual([])
    })

    it('carries the match on for the players', async () => {
        await spectatingClient(FAILED_CHUNK)
        expect(lobby.info()).toMatchObject({
            paused: false,
            spectators: [],
            player1: { connected: true },
            player2: { connected: true },
        })

        await seconds(BATTLE_COUNTDOWN)
        expect(lobby.phase).toBe('battle')
        const tick = lobby.battle!.state.gameTick
        await vi.advanceTimersByTimeAsync(GAME_TICK_INTERVAL * 5)
        expect(lobby.battle!.state.gameTick).toBe(tick + 5)
    })

    it('comes back as a spectator after a refresh', async () => {
        await spectatingClient(FAILED_CHUNK)
        const { root } = await openLobby(WORKING_CHUNK)
        expect(lobby.info().spectators).toEqual(['Carol'])
        expect(lobby.seats.player1!.playerId).toBe('alice-id')
        expectNoNewVersionMessage(root)
    })
})

// Exercise renderer imports independently of the outer battle-view import.
describe.each([
    ['chunk', new TypeError('Failed to fetch dynamically imported module: /assets/WebGL.js'), NEW_VERSION_MESSAGE],
    ['Safari chunk', new TypeError('Importing a module script failed.'), NEW_VERSION_MESSAGE],
    ['Firefox chunk', new TypeError('error loading dynamically imported module'), NEW_VERSION_MESSAGE],
    ['renderer', new Error('WebGL is not available'), BATTLE_CREATE_ERROR],
])('BattleView.create: %s', (_kind, error, message) => {
    const failingCreate: Chunk = async () => ({ BattleView: { create: () => Promise.reject(error) } })
    const pendingCreate = () => {
        const pending = pendingChunk(error)
        return { chunk: async () => ({ BattleView: { create: pending.chunk } }), fail: pending.fail }
    }

    it('shows the appropriate training message without an unhandled rejection', async () => {
        const page = await loadPage(failingCreate)
        page.openTraining()
        await settle()
        expect(page.root.textContent).toContain(message)
        if (message === NEW_VERSION_MESSAGE) {
            expectNewVersionMessage(page.root)
            expect(page.root.textContent).not.toContain(BATTLE_CREATE_ERROR)
        } else expectNoNewVersionMessage(page.root)
        expect(unhandled).toEqual([])
    })

    it('pauses online and rejoins the seat after refresh', async () => {
        const { root } = await seatedClient(failingCreate)
        expect(root.textContent).toContain(message)
        if (message === NEW_VERSION_MESSAGE) {
            expectNewVersionMessage(root)
            expect(root.textContent).not.toContain(BATTLE_CREATE_ERROR)
        } else expectNoNewVersionMessage(root)
        expect(sockets.size).toBe(0)
        expect(lobby.paused).toBe(true)
        await openLobby(WORKING_CHUNK)
        expect(lobby.info()).toMatchObject({ paused: false, player1: { name: 'Carol', connected: true } })
        expect(unhandled).toEqual([])
    })

    it('disconnects a spectator without pausing the players', async () => {
        const { root } = await spectatingClient(failingCreate)
        expect(root.textContent).toContain(message)
        expect(sockets.size).toBe(0)
        expect(lobby.paused).toBe(false)
        expect(unhandled).toEqual([])
    })

    it('ignores a late training failure after leaving', async () => {
        const { chunk, fail } = pendingCreate()
        const page = await loadPage(chunk)
        const leave = page.openTraining()
        await settle()
        leave()
        fail()
        await settle()
        expect(page.root.textContent).not.toContain(message)
        expect(unhandled).toEqual([])
    })

    it('ignores a late online failure after leaving', async () => {
        const { chunk, fail } = pendingCreate()
        const { root, leave } = await seatedClient(chunk)
        leave()
        const before = lobby.info()
        fail()
        await settle()
        expect(root.textContent).not.toContain(message)
        expect(lobby.info()).toEqual(before)
        expect(unhandled).toEqual([])
    })

    it('ignores a late online failure after the battle ends', async () => {
        const { chunk, fail } = pendingCreate()
        const { root } = await seatedClient(chunk)
        lobby.disconnect('bob')
        await seconds(RECONNECT_GRACE)
        fail()
        await settle()
        expect(root.textContent).toContain('Victory!')
        expect(root.textContent).not.toContain(message)
        expect(sockets.size).toBe(1)
        expect(unhandled).toEqual([])
    })
})

describe('errors after BattleView.create succeeds', () => {
    it.each(['training update', 'lobby update', 'lobby decoration'])(
        'logs and destroys the view after a failed %s',
        async scenario => {
            const view = fakeView()
            const error = new Error('screen setup failed')
            const method = scenario === 'lobby decoration' ? view.setScore : view.update
            method.mockImplementation(() => {
                throw error
            })
            const chunk: Chunk = async () => ({ BattleView: { create: async () => view } })
            let root: FakeElement
            let leave: () => void
            if (scenario.startsWith('training')) {
                const page = await loadPage(chunk)
                root = page.root
                leave = page.openTraining()
                await settle()
            } else {
                ;({ root, leave } = await seatedClient(chunk))
                expect(sockets.size).toBe(0)
                expect(lobby.paused).toBe(true)
            }
            expect(console.error).toHaveBeenCalledWith('Could not initialize the battle screen', error)
            expect(root.textContent).toContain(BATTLE_SETUP_ERROR)
            expect(root.textContent).not.toContain(BATTLE_CREATE_ERROR)
            expectNoNewVersionMessage(root)
            expect(view.destroy).toHaveBeenCalledTimes(1)
            leave()
            expect(view.destroy).toHaveBeenCalledTimes(1)
            expect(unhandled).toEqual([])
        },
    )
})
