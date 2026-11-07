import { h } from '../dom'

/** Same wording as the version check in #41: a refresh fixes both. */
export const NEW_VERSION_MESSAGE = 'A new version is available, please refresh'

interface BattleChunkHandlers<M, R> {
    onLoaded: (module: M) => R | PromiseLike<R>
    /** The chunk could not be loaded, and `isCurrent` says someone still wants it. */
    onFailed: () => void
    /** False once the screen was left or the battle ended, so a late failure has nobody to tell. */
    isCurrent: () => boolean
}

/**
 * Runs a lazy import of the battle chunk. A tab left open across a deploy asks for a chunk name that no longer exists,
 * so a rejected `load` means a refresh is needed.
 *
 * Only `load` is guarded. A rejection from `onLoaded` is a different failure, such as the renderer not starting, so it
 * rejects the returned promise instead of being reported as a new version.
 */
export const loadBattleChunk = <M, R>(
    load: () => Promise<M>,
    { onLoaded, onFailed, isCurrent }: BattleChunkHandlers<M, R>,
): Promise<R | void> =>
    load().then(onLoaded, error => {
        if (!isCurrent()) return
        console.error('Could not load the battle chunk', error)
        onFailed()
    })

/** The message and the control that reloads the page, after any other actions the screen offers. */
export const newVersionPanel = (...actions: Node[]) =>
    h(
        'div',
        { class: 'center' },
        h(
            'section',
            { class: 'panel narrow', role: 'alert' },
            h('h2', null, NEW_VERSION_MESSAGE),
            h(
                'div',
                { class: 'actions' },
                actions,
                h('button', { class: 'btn primary', onclick: () => location.reload() }, 'Refresh'),
            ),
        ),
    )
