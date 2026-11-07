import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SPELLS, ENGINE_VERSION } from '@magus/engine'
import { VERSION_PARAM, type LobbyInfo, type ServerMessage } from '@magus/engine/protocol'
import { createLobby, homeScreen } from '../src/screens/home'
import { lobbyScreen } from '../src/screens/lobby'
import { FakeElement, FakeNode } from './fake-dom'

// The screens and net.ts run for real. Only the browser and what the server sends are faked, the second using the
// answers apps/server/test/worker/version.test.ts asserts the real Worker gives.

// the real icons draw on a canvas, which node doesn't have
vi.mock('../src/game/icons', () => ({ iconUrl: () => 'icon.png' }))

const MESSAGE = 'A new version is available, please refresh'
const VERSION_ERROR: ServerMessage = { t: 'error', code: 'version_mismatch', message: MESSAGE, fatal: true }
/** Longer than net.ts ever waits between attempts. */
const LONGER_THAN_ANY_BACKOFF = 60_000

const LOBBY: LobbyInfo = {
    code: 'ABC234',
    phase: 'lobby',
    round: 0,
    countdown: null,
    paused: false,
    pauseReason: null,
    matchStarted: false,
    matchWinner: null,
    admin: 'player1',
    player1: { name: 'Carol', ready: false, wins: 0, connected: true },
    player2: null,
    spectators: [],
    settings: { bestOf: 3, setupTime: 30, allowSpellChange: true, maxSpectators: 5 },
    rounds: [],
}

type Answer = 'seat' | 'refuse' | 'drop'

let reload: ReturnType<typeof vi.fn>
/** What the server does with each new lobby connection, in order. The last one repeats. */
let answers: Answer[]
let sockets: FakeWebSocket[]

class FakeWebSocket {
    static OPEN = 1
    readyState = FakeWebSocket.OPEN
    onopen: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onclose: (() => void) | null = null

    constructor(readonly url: string) {
        sockets.push(this)
        // only the lobby's own connections follow the script; the home screen's list just stays open
        const isLobbyList = new URL(url).pathname === '/api/lobbies'
        const answer = isLobbyList ? null : answers.length > 1 ? answers.shift() : answers[0]
        queueMicrotask(() => {
            this.onopen?.()
            if (answer === 'seat') {
                this.deliver({ t: 'welcome', role: 'player1', spells: [...DEFAULT_SPELLS] })
                this.deliver({ t: 'meta', lobby: LOBBY })
            } else if (answer === 'refuse') {
                this.deliver(VERSION_ERROR)
                this.close()
            } else if (answer === 'drop') {
                this.close()
            }
        })
    }
    deliver(message: ServerMessage) {
        this.onmessage?.({ data: JSON.stringify(message) })
    }
    send() {}
    close() {
        if (this.readyState !== FakeWebSocket.OPEN) return
        this.readyState = 3
        this.onclose?.()
    }
}

const realSetTimeout = setTimeout
/** Lets promises run, including a fetch response being read. */
const settle = () => new Promise(resolve => realSetTimeout(resolve, 0))

const openLobby = async () => {
    const root = new FakeElement('main')
    const leave = lobbyScreen(root as unknown as HTMLElement, ['ABC234'])
    await settle()
    return { root, leave }
}

const alert = (root: FakeElement) => root.find(el => el.attrs.get('role') === 'alert')

const expectRefreshPanel = (root: FakeElement) => {
    expect(alert(root)?.textContent).toContain(MESSAGE)
    alert(root)!.button('Refresh')!.click()
    expect(reload).toHaveBeenCalledTimes(1)
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const storage = new Map([['magus.name', 'Carol']])
    reload = vi.fn()
    answers = ['seat']
    sockets = []
    vi.stubGlobal('Node', FakeNode)
    vi.stubGlobal('document', { createElement: (tag: string) => new FakeElement(tag) })
    vi.stubGlobal('location', { origin: 'https://game.example', reload })
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
})

describe('joining a lobby', () => {
    it('sends the version on the WebSocket upgrade, every attempt', async () => {
        answers = ['drop', 'seat']
        const { leave } = await openLobby()
        await vi.advanceTimersByTimeAsync(LONGER_THAN_ANY_BACKOFF)

        expect(sockets).toHaveLength(2)
        for (const socket of sockets) {
            expect(new URL(socket.url).searchParams.get(VERSION_PARAM)).toBe(ENGINE_VERSION)
        }
        leave()
    })

    it('shows the refresh message and stops reconnecting when refused', async () => {
        answers = ['refuse']
        const { root, leave } = await openLobby()

        expectRefreshPanel(root)
        await vi.advanceTimersByTimeAsync(LONGER_THAN_ANY_BACKOFF)
        expect(sockets).toHaveLength(1)
        leave()
    })

    it('keeps reconnecting after an ordinary drop, which is what makes the test above mean something', async () => {
        answers = ['drop']
        const { root, leave } = await openLobby()

        await vi.advanceTimersByTimeAsync(LONGER_THAN_ANY_BACKOFF)

        expect(sockets.length).toBeGreaterThan(1)
        expect(alert(root)).toBeNull()
        leave()
    })

    it('shows the panel to a seated player whose reconnect is refused, and stops there', async () => {
        answers = ['seat', 'refuse']
        const { root, leave } = await openLobby()
        expect(alert(root)).toBeNull()

        sockets[0].close()
        await vi.advanceTimersByTimeAsync(LONGER_THAN_ANY_BACKOFF)

        expect(sockets).toHaveLength(2)
        expectRefreshPanel(root)
        expect(alert(root)?.find(el => el.tag === 'a' && el.textContent === 'Back home')).not.toBeNull()
        leave()
    })

    it('goes by the error code, not the wording', async () => {
        answers = ['seat']
        const { root, leave } = await openLobby()

        sockets[0].deliver({ t: 'error', code: 'version_mismatch', message: 'Reworded by a later server', fatal: true })

        expectRefreshPanel(root)
        leave()
    })

    it('shows other fatal errors as they are', async () => {
        answers = ['seat']
        const { root, leave } = await openLobby()

        sockets[0].deliver({ t: 'error', message: 'Lobby not found', fatal: true })

        expect(root.textContent).toContain('Lobby not found')
        expect(root.button('Refresh')).toBeNull()
        leave()
    })
})

describe('creating a lobby', () => {
    const stubFetch = (status: number, body: unknown) => {
        const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status }))
        vi.stubGlobal('fetch', fetch)
        return fetch
    }

    const clickCreate = async () => {
        const root = new FakeElement('main')
        const leave = homeScreen(root as unknown as HTMLElement)
        root.button('Create lobby')!.click()
        await settle()
        return { root, leave }
    }

    it('sends the version on the create request, without anything that needs a preflight', async () => {
        const fetch = stubFetch(201, { code: 'ABC234' })

        await expect(createLobby()).resolves.toBe('ABC234')

        const [url, init] = fetch.mock.calls[0]
        expect(new URL(url).searchParams.get(VERSION_PARAM)).toBe(ENGINE_VERSION)
        expect(init).toEqual({ method: 'POST' })
    })

    it('replaces the screen with the refresh message when refused', async () => {
        stubFetch(409, { error: 'Reworded by a later server', errorCode: 'version_mismatch' })

        const { root, leave } = await clickCreate()

        expectRefreshPanel(root)
        leave()
    })

    describe('when the player leaves the home screen before the server answers', () => {
        /** A create request the test answers by hand, after the router has moved on to another screen. */
        const leaveMidRequest = async (status: number, body: unknown) => {
            let answer!: () => void
            vi.stubGlobal(
                'fetch',
                vi.fn(
                    () =>
                        new Promise<Response>(resolve => {
                            answer = () => resolve(new Response(JSON.stringify(body), { status }))
                        }),
                ),
            )
            const pushState = vi.fn()
            vi.stubGlobal('history', { pushState, replaceState: vi.fn() })
            const { root, leave } = await clickCreate()

            // what the router does on following the Training room link
            leave()
            const training = new FakeElement('div')
            root.replaceChildren(training)
            answer()
            await settle()

            return { root, training, pushState }
        }

        it('leaves the next screen alone when the version is refused', async () => {
            const { root, training, pushState } = await leaveMidRequest(409, {
                error: MESSAGE,
                errorCode: 'version_mismatch',
            })

            expect(root.children).toEqual([training])
            expect(alert(root)).toBeNull()
            expect(pushState).not.toHaveBeenCalled()
            expect(reload).not.toHaveBeenCalled()
        })

        it('does not navigate to the lobby it created', async () => {
            const { root, training, pushState } = await leaveMidRequest(201, { code: 'ABC234' })

            expect(root.children).toEqual([training])
            expect(pushState).not.toHaveBeenCalled()
        })
    })

    it('still shows other errors in place', async () => {
        stubFetch(503, { error: 'Too many open lobbies, try again later' })

        const { root, leave } = await clickCreate()

        expect(alert(root)?.textContent).toContain('Too many open lobbies, try again later')
        expect(root.button('Refresh')).toBeNull()
        leave()
    })
})
