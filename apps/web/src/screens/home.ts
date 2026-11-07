import {
    LOBBY_CODE_PATTERN,
    NAME_MAX_LENGTH,
    NEW_VERSION_MESSAGE,
    VERSION_MISMATCH,
    VERSION_QUERY,
    type LobbyListing,
    type RegistryMessage,
} from '@magus/engine/protocol'
import { SERVER_URL, WS_URL } from '../config'
import { h } from '../dom'
import { getName, setName } from '../identity'
import { connect } from '../net'
import { navigate } from '../router'
import { newVersionPanel } from './battle-chunk'

export const phaseLabel = (lobby: Pick<LobbyListing, 'phase' | 'round'>) => {
    switch (lobby.phase) {
        case 'lobby':
            return 'Waiting'
        case 'set_up':
            return `Round ${lobby.round} · choosing spells`
        case 'battle_countdown':
        case 'battle':
            return `Round ${lobby.round} · dueling`
        case 'round_over':
            return `Round ${lobby.round} over`
        case 'match_over':
            return 'Finished'
    }
}

export const createLobby = async () => {
    const res = await fetch(`${SERVER_URL}/api/lobbies?${VERSION_QUERY}`, { method: 'POST' })
    const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string; errorCode?: string }
    if (body.errorCode === VERSION_MISMATCH) throw new Error(NEW_VERSION_MESSAGE)
    if (!res.ok || !body.code) throw new Error(body.error ?? 'Could not create a lobby')
    return body.code
}

export const nameField = () => {
    const input = h('input', {
        id: 'player-name',
        maxlength: NAME_MAX_LENGTH,
        placeholder: 'Wizard name',
        autocomplete: 'nickname',
        value: getName(),
        oninput: (e: Event) => setName((e.target as HTMLInputElement).value),
    })
    return h('label', { class: 'field' }, h('span', null, 'Your name'), input)
}

export const homeScreen = (root: HTMLElement) => {
    const status = h('p', { class: 'status muted' }, 'Connecting to server…')
    const list = h('ul', { class: 'lobby-list' })
    const error = h('p', { class: 'error', role: 'alert' })

    const createButton = h(
        'button',
        {
            class: 'btn primary',
            onclick: async () => {
                createButton.disabled = true
                error.textContent = ''
                let code: string
                try {
                    code = await createLobby()
                } catch (e) {
                    if (e instanceof Error && e.message === NEW_VERSION_MESSAGE) {
                        socket.close()
                        root.replaceChildren(newVersionPanel())
                        return
                    }
                    error.textContent = e instanceof Error ? e.message : 'Could not reach the server'
                    createButton.disabled = false
                    return
                }
                navigate(`/lobby/${code}`)
            },
        },
        'Create lobby',
    )

    const codeInput = h('input', {
        maxlength: 6,
        placeholder: 'CODE',
        class: 'code-input',
        'aria-label': 'Lobby code',
        autocapitalize: 'characters',
        spellcheck: 'false',
    })
    const joinForm = h(
        'form',
        {
            class: 'join',
            onsubmit: (e: Event) => {
                e.preventDefault()
                const code = codeInput.value.trim().toUpperCase()
                if (!LOBBY_CODE_PATTERN.test(code)) {
                    error.textContent = 'Lobby codes are 6 letters and numbers.'
                    return
                }
                navigate(`/lobby/${code}`)
            },
        },
        codeInput,
        h('button', { class: 'btn', type: 'submit' }, 'Join'),
    )

    const renderList = (lobbies: LobbyListing[]) => {
        status.textContent = lobbies.length ? '' : 'No open lobbies right now. Create one and share the code!'
        list.replaceChildren(
            ...lobbies.map(lobby => {
                const seatOpen = lobby.phase === 'lobby' && (!lobby.player1 || !lobby.player2)
                const canWatch = lobby.spectators < lobby.maxSpectators
                return h(
                    'li',
                    null,
                    h(
                        'div',
                        { class: 'who' },
                        h('strong', null, lobby.player1 ?? 'Open seat'),
                        h('span', { class: 'vs' }, 'vs'),
                        h('strong', null, lobby.player2 ?? 'Open seat'),
                    ),
                    h('span', { class: 'meta' }, `Best of ${lobby.bestOf} · ${phaseLabel(lobby)}`),
                    seatOpen || canWatch
                        ? h(
                              'a',
                              {
                                  class: `btn small${seatOpen ? ' primary' : ''}`,
                                  href: `/lobby/${lobby.code}`,
                                  'data-link': true,
                              },
                              seatOpen ? 'Join' : 'Watch',
                          )
                        : h('span', { class: 'meta' }, 'Full'),
                )
            }),
        )
    }

    const socket = connect<RegistryMessage>({
        url: () => `${WS_URL}/api/lobbies`,
        onMessage: message => {
            if (message.t === 'lobbies') renderList(message.lobbies)
        },
        onStatus: s => {
            if (s !== 'open')
                status.textContent = s === 'connecting' ? 'Connecting to server…' : 'Server unreachable, retrying…'
        },
    })

    root.append(
        h(
            'div',
            { class: 'home' },
            h(
                'header',
                { class: 'hero' },
                h('h1', null, 'Magus ', h('span', null, 'Reborn')),
                h('p', null, 'Hold to charge. Release to cast. Outwit the other wizard.'),
            ),
            h(
                'section',
                { class: 'panel' },
                nameField(),
                h(
                    'div',
                    { class: 'actions' },
                    h('a', { class: 'btn', href: '/training', 'data-link': true }, 'Training room'),
                    createButton,
                ),
                joinForm,
                error,
            ),
            h('section', { class: 'panel' }, h('h2', null, 'Open lobbies'), status, list),
            h(
                'footer',
                { class: 'muted' },
                'Keys: Q W E / A S D. Hold a key to charge, release when the bar turns green.',
            ),
        ),
    )

    return () => socket.close()
}
