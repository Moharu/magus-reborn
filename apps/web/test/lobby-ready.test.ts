import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_SPELLS } from '@magus/engine'
import { DEFAULT_SETTINGS, type LobbyInfo, type ServerMessage } from '@magus/engine/protocol'
import { lobbyScreen } from '../src/screens/lobby'
import { FakeElement, FakeNode } from './fake-dom'

vi.mock('../src/game/icons', () => ({ iconUrl: () => 'icon.png' }))
vi.mock('../src/identity', () => ({
    playerId: 'test-player',
    getName: () => 'Wizard',
    getLoadout: () => [...DEFAULT_SPELLS],
    setLoadout: vi.fn(),
    getAdvancedDescriptions: () => false,
    setAdvancedDescriptions: vi.fn(),
}))

class FakeWebSocket {
    static OPEN = 1
    static instances: FakeWebSocket[] = []
    readyState = 0
    onopen = () => {}
    onclose = () => {}
    onmessage = (_event: { data: string }) => {}
    sent: string[] = []
    constructor() {
        FakeWebSocket.instances.push(this)
    }
    send(message: string) {
        this.sent.push(message)
    }
    open() {
        this.readyState = FakeWebSocket.OPEN
        this.onopen()
    }
    close() {
        this.readyState = 3
        this.onclose()
    }
    receive(message: ServerMessage) {
        this.onmessage({ data: JSON.stringify(message) })
    }
}

beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('Node', FakeNode)
    vi.stubGlobal('document', { createElement: (tag: string) => new FakeElement(tag) })
})
afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

it('keeps Ready final while disconnected and retries after fresh unready metadata on reconnect', () => {
    const root = new FakeElement('main')
    const cleanup = lobbyScreen(root as unknown as HTMLElement, ['ABCDEF'])
    try {
        const lobby: LobbyInfo = {
            code: 'ABCDEF',
            phase: 'set_up',
            round: 1,
            countdown: 30,
            paused: false,
            pauseReason: null,
            matchStarted: true,
            matchWinner: null,
            admin: 'player1',
            player1: { name: 'Wizard', ready: false, wins: 0, connected: true },
            player2: { name: 'Rival', ready: false, wins: 0, connected: true },
            spectators: [],
            settings: { ...DEFAULT_SETTINGS },
            rounds: [],
        }
        const first = FakeWebSocket.instances[0]
        first.open()
        first.receive({ t: 'welcome', role: 'player1', spells: [...DEFAULT_SPELLS] })
        first.receive({ t: 'meta', lobby })
        first.close()
        root.button('Ready for round 1')!.click()
        expect(first.sent).toEqual([])
        expect(root.textContent).toContain('Ready!')
        expect(root.button('Ready for round 1')).toBeNull()
        expect(root.textContent).toContain('Spells locked in.')

        vi.advanceTimersByTime(1000)
        const recovered = FakeWebSocket.instances[1]
        recovered.open()
        recovered.receive({ t: 'welcome', role: 'player1', spells: [...DEFAULT_SPELLS] })
        expect(recovered.sent).toEqual([])
        recovered.receive({ t: 'meta', lobby })
        expect(recovered.sent.map(message => JSON.parse(message))).toEqual([{ t: 'ready' }])
        expect(root.textContent).toContain('Ready!')
        expect(root.button('Ready for round 1')).toBeNull()

        recovered.receive({ t: 'meta', lobby: { ...lobby, player1: { ...lobby.player1!, ready: true } } })
        recovered.receive({ t: 'meta', lobby: { ...lobby, round: 2 } })
        expect(recovered.sent).toHaveLength(1)
        expect(root.button('Ready for round 2')).not.toBeNull()
    } finally {
        cleanup()
    }
})
