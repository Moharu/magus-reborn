export type Cleanup = () => void
type Screen = (root: HTMLElement, params: string[]) => Cleanup | void

const routes: [RegExp, Screen][] = []
let root: HTMLElement
let cleanup: Cleanup | void

export const route = (pattern: RegExp, screen: Screen) => routes.push([pattern, screen])

export const navigate = (path: string, { replace = false } = {}) => {
    if (replace) history.replaceState(null, '', path)
    else history.pushState(null, '', path)
    render()
}

const render = () => {
    cleanup?.()
    cleanup = undefined
    root.replaceChildren()
    window.scrollTo(0, 0)
    const path = location.pathname
    for (const [pattern, screen] of routes) {
        const match = path.match(pattern)
        if (match) {
            cleanup = screen(root, match.slice(1))
            return
        }
    }
    navigate('/', { replace: true })
}

export const startRouter = (el: HTMLElement) => {
    root = el
    window.addEventListener('popstate', render)
    // intercept same-origin links
    document.addEventListener('click', event => {
        const link = (event.target as Element).closest?.('a[data-link]') as HTMLAnchorElement | null
        if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
        event.preventDefault()
        navigate(link.getAttribute('href')!)
    })
    render()
}
