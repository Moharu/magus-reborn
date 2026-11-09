import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_SPELLS, SPELLBOOKS, loadoutElement } from '@magus/engine'
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

it('accepts a raw-client Frost loadout and permits only Frost swaps when spell changes are enabled', () => {
    const root = new FakeElement('main')
    const cleanup = lobbyScreen(root as unknown as HTMLElement, ['ABCDEF'])
    const frost = [...SPELLBOOKS.FROST.elementSpells.slice(0, 4), ...DEFAULT_SPELLS.slice(4)]
    const lobby: LobbyInfo = {
        code: 'ABCDEF',
        phase: 'set_up',
        round: 2,
        countdown: 30,
        paused: false,
        pauseReason: null,
        matchStarted: true,
        matchWinner: null,
        admin: 'player1',
        player1: { name: 'Wizard', ready: false, wins: 0, connected: true },
        player2: { name: 'Rival', ready: false, wins: 1, connected: true },
        spectators: [],
        settings: { ...DEFAULT_SETTINGS, allowSpellChange: true },
        rounds: [],
    }
    try {
        const socket = FakeWebSocket.instances[0]
        socket.open()
        socket.receive({ t: 'welcome', role: 'player1', spells: [...DEFAULT_SPELLS] })
        socket.receive({ t: 'loadout', spells: frost })
        socket.receive({ t: 'meta', lobby })
        expect(root.button('Ready for round 2')!.attrs.get('disabled')).toBeUndefined()
        expect((root.button('Ready for round 2') as unknown as HTMLButtonElement).disabled).not.toBe(true)
        expect(root.textContent).toContain('Frost spellbook')
        expect(root.button('Fire')).toBeNull()
        const target = (value: string) => root.find(el => el.attrs.get('data-target') === value)!
        target('spell:SPELL_ICY_TOUCH').click()
        target('slot:0').click()
        const sent = socket.sent.map(message => JSON.parse(message))
        expect(sent).toHaveLength(1)
        expect(sent[0].t).toBe('set_spells')
        expect(loadoutElement(sent[0].spells)).toBe('FROST')
        expect(sent[0].spells[0]).toBe('SPELL_ICY_TOUCH')
        socket.receive({ t: 'meta', lobby: { ...lobby, settings: { ...lobby.settings, allowSpellChange: false } } })
        target('spell:SPELL_FROST_FEVER').click()
        target('slot:0').click()
        expect(socket.sent).toHaveLength(1)
        expect(root.textContent).toContain('Spell changes are off')
        expect(root.textContent).not.toContain('Rival: Frost')
    } finally {
        cleanup()
    }
})
