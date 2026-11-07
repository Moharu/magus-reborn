import { SPELLS, ticksToSeconds, type BattleSnapshot, type PlayerKey, type SpellId } from '@magus/engine'
import {
    BEST_OF_OPTIONS,
    MAX_SPECTATORS,
    NEW_VERSION_MESSAGE,
    SETUP_TIME_MAX,
    SETUP_TIME_MIN,
    VERSION_MISMATCH,
    VERSION_QUERY,
    type LobbyInfo,
    type LobbyPlayerInfo,
    type LobbySettings,
    type Role,
    type ServerMessage,
} from '@magus/engine/protocol'
import { WS_URL } from '../config'
import { h } from '../dom'
import type { BattleView } from '../game/battle-view'
import { getLoadout, getName, playerId, setLoadout } from '../identity'
import { connect, type Socket } from '../net'
import { navigate } from '../router'
import { spellPicker, type SpellPicker } from '../ui/spell-picker'
import { loadBattleChunk, newVersionPanel } from './battle-chunk'
import { nameField } from './home'

type Mode = 'connecting' | 'lobby' | 'setup' | 'watch-setup' | 'battle' | 'over' | 'error'

const SETUP_TIMES = [10, 15, 20, 30, 45, 60, 90, 120].filter(t => t >= SETUP_TIME_MIN && t <= SETUP_TIME_MAX)
const PING_INTERVAL = 5000

const modeFor = (lobby: LobbyInfo, role: Role | null): Mode => {
    switch (lobby.phase) {
        case 'lobby':
            return 'lobby'
        case 'set_up':
            return role === 'spectator' ? 'watch-setup' : 'setup'
        case 'match_over':
            return 'over'
        default:
            return 'battle'
    }
}

export const lobbyScreen = (root: HTMLElement, [rawCode]: string[]) => {
    const code = rawCode.toUpperCase()
    if (code !== rawCode) history.replaceState(null, '', `/lobby/${code}`)

    if (!getName()) {
        const form = h(
            'form',
            {
                class: 'panel narrow',
                onsubmit: (e: Event) => {
                    e.preventDefault()
                    root.replaceChildren()
                    cleanup = startLobby(root, code)
                },
            },
            h('h2', null, `Joining lobby ${code}`),
            nameField(),
            h(
                'div',
                { class: 'actions' },
                h('a', { class: 'btn', href: '/', 'data-link': true }, 'Cancel'),
                h('button', { class: 'btn primary', type: 'submit' }, 'Join'),
            ),
        )
        root.append(h('div', { class: 'center' }, form))
        queueMicrotask(() => form.querySelector('input')?.focus())
        let cleanup: (() => void) | null = null
        return () => cleanup?.()
    }
    return startLobby(root, code)
}

const startLobby = (root: HTMLElement, code: string) => {
    let role: Role | null = null
    let lobby: LobbyInfo | null = null
    let loadout: SpellId[] = getLoadout()
    let mode: Mode = 'connecting'
    let fatal: string | null = null
    let connection: 'connecting' | 'open' | 'reconnecting' = 'connecting'
    let ping: number | null = null
    let battleSnap: BattleSnapshot | null = null
    let caughtUp = false

    let view: BattleView | null = null
    let viewPending = false
    let picker: SpellPicker | null = null
    const content = h('div', { class: 'lobby-screen' })
    const netStatus = h('div', { class: 'net-status' })
    root.append(content, netStatus)

    let socket: Socket | null = null
    const send: Socket['send'] = message => socket?.send(message)
    const me = (): PlayerKey | null => (role === 'player1' || role === 'player2' ? role : null)
    const seatInfo = (key: PlayerKey) => lobby?.[key] ?? null

    const flash = (text: string) => {
        const el = h('div', { class: 'toast', role: 'status' }, text)
        root.append(el)
        setTimeout(() => el.remove(), 3000)
    }

    const renderNetStatus = () => {
        netStatus.textContent =
            connection === 'open'
                ? ping !== null
                    ? `${ping} ms`
                    : ''
                : connection === 'connecting'
                  ? 'Connecting…'
                  : 'Reconnecting…'
        netStatus.classList.toggle('warn', connection !== 'open')
    }

    const destroyView = () => {
        view?.destroy()
        view = null
        viewPending = false
    }

    // rendering

    const render = () => {
        const next: Mode = fatal ? 'error' : lobby ? modeFor(lobby, role) : 'connecting'
        const changed = next !== mode
        mode = next
        if (changed) {
            if (mode !== 'battle') destroyView()
            if (mode !== 'setup') picker = null
        }
        switch (mode) {
            case 'connecting':
                return content.replaceChildren(
                    h('div', { class: 'center' }, h('p', { class: 'muted' }, 'Connecting to lobby…')),
                )
            case 'error':
                if (fatal === NEW_VERSION_MESSAGE) {
                    return content.replaceChildren(
                        newVersionPanel(h('a', { class: 'btn', href: '/', 'data-link': true }, 'Back home')),
                    )
                }
                return content.replaceChildren(
                    h(
                        'div',
                        { class: 'center' },
                        h(
                            'section',
                            { class: 'panel narrow' },
                            h('h2', null, fatal),
                            h('a', { class: 'btn primary', href: '/', 'data-link': true }, 'Back home'),
                        ),
                    ),
                )
            case 'lobby':
                return content.replaceChildren(renderLobby(lobby!))
            case 'setup':
                return renderSetup(lobby!, changed)
            case 'watch-setup':
                return content.replaceChildren(
                    h(
                        'div',
                        { class: 'center' },
                        h(
                            'section',
                            { class: 'panel narrow' },
                            h('h2', null, `Round ${lobby!.round}`),
                            h('p', null, `Players are choosing spells… ${lobby!.countdown ?? ''}`),
                            scoreLine(lobby!),
                        ),
                    ),
                )
            case 'battle':
                return renderBattle(lobby!, changed)
            case 'over':
                return content.replaceChildren(renderResults(lobby!))
        }
    }

    const scoreLine = (info: LobbyInfo) =>
        h(
            'p',
            { class: 'score' },
            `${info.player1?.name ?? '?'} ${info.player1?.wins ?? 0} – ${info.player2?.wins ?? 0} ${info.player2?.name ?? '?'}`,
        )

    const playerCard = (key: PlayerKey, info: LobbyPlayerInfo | null, admin: boolean) =>
        h(
            'div',
            { class: `player-card${info?.ready ? ' ready' : ''}${role === key ? ' me' : ''}` },
            info
                ? [
                      h(
                          'strong',
                          null,
                          info.name,
                          admin ? h('span', { class: 'badge', title: 'Lobby host' }, 'host') : null,
                          role === key ? h('span', { class: 'badge' }, 'you') : null,
                      ),
                      h(
                          'span',
                          { class: 'state' },
                          !info.connected ? 'Disconnected' : info.ready ? 'Ready' : 'Not ready',
                      ),
                  ]
                : [
                      h('strong', { class: 'muted' }, 'Waiting for opponent…'),
                      h('span', { class: 'state' }, 'Share the invite link'),
                  ],
        )

    const renderLobby = (info: LobbyInfo) => {
        const mine = me()
        const isAdmin = mine !== null && info.admin === mine
        const editable = isAdmin && !info.matchStarted
        const change = (patch: Partial<LobbySettings>) => send({ t: 'settings', settings: patch })
        const inviteUrl = `${location.origin}/lobby/${info.code}`

        const settingsView = editable
            ? h(
                  'div',
                  { class: 'settings' },
                  h(
                      'div',
                      { class: 'field' },
                      h('span', null, 'Match'),
                      h(
                          'div',
                          { class: 'segmented', role: 'radiogroup', 'aria-label': 'Match length' },
                          BEST_OF_OPTIONS.map(n =>
                              h(
                                  'button',
                                  {
                                      role: 'radio',
                                      'aria-checked': String(info.settings.bestOf === n),
                                      class: info.settings.bestOf === n ? 'active' : '',
                                      onclick: () => change({ bestOf: n }),
                                  },
                                  `Best of ${n}`,
                              ),
                          ),
                      ),
                  ),
                  h(
                      'label',
                      { class: 'field' },
                      h('span', null, 'Set up time'),
                      h(
                          'select',
                          {
                              onchange: (e: Event) =>
                                  change({ setupTime: Number((e.target as HTMLSelectElement).value) }),
                          },
                          SETUP_TIMES.map(t =>
                              h('option', { value: t, selected: info.settings.setupTime === t }, `${t} seconds`),
                          ),
                      ),
                  ),
                  h(
                      'label',
                      { class: 'field toggle' },
                      h('input', {
                          type: 'checkbox',
                          checked: info.settings.allowSpellChange,
                          onchange: (e: Event) => change({ allowSpellChange: (e.target as HTMLInputElement).checked }),
                      }),
                      h('span', null, 'Allow changing spells between rounds'),
                  ),
                  h(
                      'label',
                      { class: 'field' },
                      h('span', null, 'Spectators'),
                      h(
                          'select',
                          {
                              onchange: (e: Event) =>
                                  change({ maxSpectators: Number((e.target as HTMLSelectElement).value) }),
                          },
                          Array.from({ length: MAX_SPECTATORS + 1 }, (_, n) =>
                              h(
                                  'option',
                                  { value: n, selected: info.settings.maxSpectators === n },
                                  n === 0 ? 'None' : `Up to ${n}`,
                              ),
                          ),
                      ),
                  ),
              )
            : h(
                  'dl',
                  { class: 'settings readonly' },
                  h('dt', null, 'Match'),
                  h('dd', null, `Best of ${info.settings.bestOf}`),
                  h('dt', null, 'Set up time'),
                  h('dd', null, `${info.settings.setupTime} seconds`),
                  h('dt', null, 'Spell changes'),
                  h('dd', null, info.settings.allowSpellChange ? 'Allowed between rounds' : 'Locked after round 1'),
                  h('dt', null, 'Spectators'),
                  h('dd', null, info.settings.maxSpectators ? `Up to ${info.settings.maxSpectators}` : 'None'),
              )

        const ready = mine ? info[mine]?.ready : false
        return h(
            'section',
            { class: 'panel lobby' },
            h(
                'header',
                { class: 'lobby-head' },
                h('h2', null, 'Lobby ', h('code', null, info.code)),
                h(
                    'button',
                    {
                        class: 'btn small',
                        onclick: async () => {
                            try {
                                await navigator.clipboard.writeText(inviteUrl)
                                flash('Invite link copied')
                            } catch {
                                flash(inviteUrl)
                            }
                        },
                    },
                    'Copy invite link',
                ),
            ),
            h(
                'div',
                { class: 'versus' },
                playerCard('player1', info.player1, info.admin === 'player1'),
                h('span', { class: 'vs' }, 'VS'),
                playerCard('player2', info.player2, info.admin === 'player2'),
            ),
            h(
                'h3',
                null,
                'Settings',
                !editable && !info.matchStarted ? h('span', { class: 'muted' }, ' · chosen by the host') : null,
            ),
            settingsView,
            info.matchStarted
                ? h('p', { class: 'countdown' }, `Match starting in ${info.countdown ?? 0}…`)
                : h(
                      'div',
                      { class: 'actions' },
                      h('a', { class: 'btn', href: '/', 'data-link': true }, 'Leave'),
                      mine
                          ? h(
                                'button',
                                {
                                    class: `btn ${ready ? '' : 'primary'}`,
                                    disabled: !info.player1 || !info.player2,
                                    onclick: () => send({ t: ready ? 'unready' : 'ready' }),
                                },
                                ready ? 'Not ready' : 'Ready',
                            )
                          : h('span', { class: 'muted' }, 'You are spectating'),
                  ),
            info.spectators.length ? h('p', { class: 'muted' }, `Watching: ${info.spectators.join(', ')}`) : null,
        )
    }

    const setupHead = h('header', { class: 'setup-head' })
    const renderSetup = (info: LobbyInfo, entering: boolean) => {
        const mine = me()!
        const ready = !!info[mine]?.ready
        if (entering || !picker) {
            picker = spellPicker(loadout, next => {
                loadout = next
                setLoadout(next)
                send({ t: 'set_spells', spells: next })
            })
            content.replaceChildren(h('section', { class: 'panel setup' }, setupHead, picker.el))
        }
        picker.setLocked(ready)
        const opponent = seatInfo(mine === 'player1' ? 'player2' : 'player1')
        setupHead.replaceChildren(
            h('div', null, h('h2', null, `Round ${info.round}`), h('span', { class: 'muted' }, 'Choose your spells')),
            h('div', { class: 'timer', 'aria-live': 'polite' }, `${info.countdown ?? 0}s`),
            h(
                'div',
                { class: 'actions' },
                h('span', { class: 'muted' }, opponent?.ready ? `${opponent.name} is ready` : ''),
                ready
                    ? h('strong', { class: 'ready-label' }, 'Ready!')
                    : h('button', { class: 'btn primary', onclick: () => send({ t: 'ready' }) }, 'Ready'),
            ),
        )
    }

    const stage = h('div', { class: 'stage' })
    const renderBattle = (info: LobbyInfo, entering: boolean) => {
        if (entering) {
            content.replaceChildren(h('div', { class: 'battle-screen' }, stage))
            if (!view && !viewPending) {
                viewPending = true
                const mine = me()
                loadBattleChunk(() => import('../game/battle-view'), {
                    onLoaded: ({ BattleView }) =>
                        BattleView.create(stage, {
                            me: mine,
                            onPress: i => send({ t: 'start_cast', i }),
                            onRelease: i => send({ t: 'stop_cast', i }),
                        }).then(created => {
                            if (!viewPending || mode !== 'battle') return created.destroy()
                            viewPending = false
                            view = created
                            if (battleSnap) view.update(battleSnap, [], [], false)
                            decorate(info)
                        }),
                    isCurrent: () => viewPending,
                    onFailed: () => {
                        // A connected player who can't see the battle would leave the opponent fighting someone idle.
                        // Leaving pauses the match, and the server holds the seat for its reconnect grace period.
                        socket?.close()
                        netStatus.remove()
                        fatal = NEW_VERSION_MESSAGE
                        render()
                    },
                })
            }
        }
        if (view) decorate(info)
    }

    const decorate = (info: LobbyInfo) => {
        if (!view || !lobby) return
        info = lobby
        view.setScore({ player1: info.player1?.wins ?? 0, player2: info.player2?.wins ?? 0 })
        view.setFrozen(info.phase !== 'battle' || info.paused)
        if (info.paused) {
            view.setOverlay('Paused', `${info.pauseReason ?? ''} · waiting for them to come back`)
        } else if (info.phase === 'battle_countdown') {
            view.setOverlay(`Round ${info.round}`, `Starts in ${info.countdown ?? 0}`)
        } else if (info.phase === 'round_over') {
            const last = info.rounds.at(-1)
            const title =
                !last || last.winner === 'draw'
                    ? 'Draw!'
                    : `${info[last.winner as PlayerKey]?.name} wins round ${last.round}`
            view.setOverlay(title, `Next round in ${info.countdown ?? 0}`)
        } else {
            view.setOverlay(null)
        }
    }

    const renderResults = (info: LobbyInfo) => {
        const winner = info.matchWinner
        const mine = me()
        const title = !winner
            ? 'Match abandoned'
            : mine
              ? winner === mine
                  ? 'Victory!'
                  : 'Defeat'
              : `${info[winner]?.name} wins!`
        const name = (key: string | null) =>
            key === 'player1' || key === 'player2' ? (info[key]?.name ?? key) : 'Draw'
        return h(
            'div',
            { class: 'center' },
            h(
                'section',
                { class: 'panel results' },
                h('h2', null, title),
                scoreLine(info),
                info.rounds.length
                    ? h(
                          'table',
                          null,
                          h(
                              'thead',
                              null,
                              h(
                                  'tr',
                                  null,
                                  h('th', null, 'Round'),
                                  h('th', null, 'Winner'),
                                  h('th', null, 'Time'),
                                  h('th', null, `${name('player1')} HP`),
                                  h('th', null, `${name('player2')} HP`),
                              ),
                          ),
                          h(
                              'tbody',
                              null,
                              info.rounds.map(round =>
                                  h(
                                      'tr',
                                      null,
                                      h('td', null, round.round),
                                      h('td', null, name(round.winner)),
                                      h('td', null, `${ticksToSeconds(round.ticks).toFixed(1)}s`),
                                      h('td', null, round.player1.hp.toFixed(1)),
                                      h('td', null, round.player2.hp.toFixed(1)),
                                  ),
                              ),
                          ),
                      )
                    : null,
                info.rounds.length
                    ? h(
                          'details',
                          null,
                          h('summary', null, 'Spells used'),
                          ['player1', 'player2'].map(key =>
                              h(
                                  'p',
                                  null,
                                  h('strong', null, `${name(key)}: `),
                                  info.rounds
                                      .at(-1)!
                                      [key as PlayerKey].spells.map(id => SPELLS[id].label)
                                      .join(', '),
                              ),
                          ),
                      )
                    : null,
                h(
                    'div',
                    { class: 'actions' },
                    h('button', { class: 'btn primary', onclick: () => navigate('/') }, 'Back home'),
                ),
            ),
        )
    }

    socket = connect<ServerMessage>({
        url: () =>
            `${WS_URL}/api/lobbies/${code}?playerId=${encodeURIComponent(playerId)}&name=${encodeURIComponent(getName())}&${VERSION_QUERY}`,
        isFatal: m => m.t === 'error' && !!m.fatal,
        onStatus: status => {
            connection = status
            if (status !== 'open') caughtUp = false
            renderNetStatus()
        },
        onMessage: message => {
            switch (message.t) {
                case 'welcome':
                    role = message.role
                    caughtUp = false
                    if (message.spells && message.spells.join() !== loadout.join())
                        send({ t: 'set_spells', spells: loadout })
                    break
                case 'loadout':
                    loadout = message.spells
                    setLoadout(loadout)
                    picker?.setLoadout(loadout)
                    break
                case 'meta':
                    lobby = message.lobby
                    break
                case 'battle': {
                    const fresh = caughtUp
                    caughtUp = true
                    battleSnap = message.snap
                    view?.update(message.snap, message.log, message.events, fresh)
                    return
                }
                case 'error':
                    if (message.code === VERSION_MISMATCH) {
                        netStatus.remove()
                        fatal = NEW_VERSION_MESSAGE
                    } else if (message.fatal) fatal = message.message
                    else flash(message.message)
                    break
                case 'pong':
                    ping = Math.round(performance.now() - message.at)
                    renderNetStatus()
                    return
            }
            render()
        },
    })
    const pinger = setInterval(() => send({ t: 'ping', at: performance.now() }), PING_INTERVAL)

    render()
    return () => {
        clearInterval(pinger)
        socket?.close()
        destroyView()
        netStatus.remove()
    }
}
