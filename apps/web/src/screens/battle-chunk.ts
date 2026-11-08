import { NEW_VERSION_MESSAGE } from '@magus/engine/protocol'
import { h } from '../dom'

interface BattleChunkHandlers<M, R> {
    /** Only create the view here; screen setup belongs in onCreated. */
    onLoaded: (module: M) => R | PromiseLike<R>
    onCreated?: (view: R) => void
    onSetupFailed?: () => void
    onCreateFailed: (message: string) => void
    /** The chunk could not be loaded, and `isCurrent` says someone still wants it. */
    onFailed: () => void
    /** False once the screen was left or the battle ended, so a late failure has nobody to tell. */
    isCurrent: () => boolean
}

export const BATTLE_SETUP_ERROR = 'Could not display the battle. Please try refreshing.'

export const BATTLE_CREATE_ERROR =
    'Could not start the battle renderer. Check that your browser supports WebGL or WebGPU and try refreshing.'

/** Browser and bundler messages for failed dynamic imports, including Pixi's renderer imports. */
const isChunkLoadError = (error: unknown): boolean =>
    error instanceof Error &&
    (error.name === 'ChunkLoadError' ||
        /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk .+ failed|Failed to load module script/i.test(
            error.message,
        ))

/** Import failures need a refresh; renderer startup failures may need a different explanation. */
export const loadBattleChunk = <M, R>(
    load: () => Promise<M>,
    { onLoaded, onCreated, onSetupFailed, onFailed, onCreateFailed, isCurrent }: BattleChunkHandlers<M, R>,
): Promise<R | void> =>
    load().then(
        async module => {
            let view: R
            try {
                view = await onLoaded(module)
            } catch (error) {
                if (!isCurrent()) return
                console.error('Could not create the battle view', error)
                if (isChunkLoadError(error)) onFailed()
                else onCreateFailed(BATTLE_CREATE_ERROR)
                return
            }
            try {
                onCreated?.(view)
            } catch (error) {
                console.error('Could not initialize the battle screen', error)
                onSetupFailed?.()
            }
            return view
        },
        error => {
            if (!isCurrent()) return
            console.error('Could not load the battle chunk', error)
            onFailed()
        },
    )

/** The message and the control that reloads the page, after any other actions the screen offers. */
export const newVersionPanel = (...actions: Node[]) => battleErrorPanel(NEW_VERSION_MESSAGE, ...actions)

export const battleErrorPanel = (message: string, ...actions: Node[]) =>
    h(
        'div',
        { class: 'center' },
        h(
            'section',
            { class: 'panel narrow', role: 'alert' },
            h('h2', null, message),
            h(
                'div',
                { class: 'actions' },
                actions,
                h('button', { class: 'btn primary', onclick: () => location.reload() }, 'Refresh'),
            ),
        ),
    )
