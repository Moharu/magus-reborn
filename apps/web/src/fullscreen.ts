import { h } from './dom'

type FullscreenDocument = Document & {
    webkitFullscreenEnabled?: boolean
    webkitFullscreenElement?: Element
    webkitExitFullscreen?: () => Promise<void> | void
}
type FullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void }

const doc = () => document as FullscreenDocument
export const fullscreenActive = () => !!(doc().fullscreenElement || doc().webkitFullscreenElement)
export const fullscreenSupported = () => {
    const root = document.documentElement as FullscreenElement | undefined
    return !!(
        (doc().fullscreenEnabled && root?.requestFullscreen) ||
        (doc().webkitFullscreenEnabled && root?.webkitRequestFullscreen)
    )
}

const quietly = (action: () => Promise<unknown> | void) => {
    try {
        void Promise.resolve(action()).catch(() => {})
    } catch {
        // Fullscreen and orientation permissions vary by browser and embedding context.
    }
}

/** Call synchronously from an entry gesture, before routing or awaiting anything. */
export const requestMobileFullscreen = (event?: Event) => {
    if (!event?.isTrusted || !window.matchMedia('(pointer: coarse)').matches) return
    requestFullscreen(event)
}

const requestFullscreen = (event?: Event) => {
    if (!event?.isTrusted || navigator.userActivation?.isActive === false) return
    if (!fullscreenSupported() || fullscreenActive()) return
    const root = document.documentElement as FullscreenElement
    quietly(() =>
        root.requestFullscreen ? root.requestFullscreen({ navigationUI: 'hide' }) : root.webkitRequestFullscreen?.(),
    )
}

/** Subscribe without replacing the canvas, its input handlers, or battle state. */
export const onFullscreenChange = (refit: () => void) => {
    document.addEventListener('fullscreenchange', refit)
    document.addEventListener('webkitfullscreenchange', refit)
    return () => {
        document.removeEventListener('fullscreenchange', refit)
        document.removeEventListener('webkitfullscreenchange', refit)
    }
}

export const installFullscreen = () =>
    onFullscreenChange(() => {
        if (fullscreenActive()) {
            const orientation = screen.orientation as ScreenOrientation & {
                lock?: (orientation: string) => Promise<void>
            }
            quietly(() => orientation?.lock?.('landscape'))
        }
        window.dispatchEvent(new Event('resize'))
    })

export const fullscreenButton = () => {
    if (!fullscreenSupported()) return null
    return h(
        'button',
        {
            class: 'btn small fullscreen-toggle',
            type: 'button',
            title: 'Toggle fullscreen',
            'aria-label': 'Toggle fullscreen',
            onclick: (event: Event) => {
                if (fullscreenActive()) {
                    quietly(() => (doc().exitFullscreen ? doc().exitFullscreen() : doc().webkitExitFullscreen?.()))
                } else requestFullscreen(event)
            },
        },
        '⛶',
    )
}
