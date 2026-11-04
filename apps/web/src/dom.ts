type Child = Node | string | number | null | undefined | false
type Props = Record<string, unknown>

/** Minimal element builder: h('button', { class: 'btn', onclick: fn }, 'Label') */
export function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Props | null = null,
    ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag)
    for (const [key, value] of Object.entries(props ?? {})) {
        if (value === undefined || value === null || value === false) continue
        if (key.startsWith('on') && typeof value === 'function') {
            el.addEventListener(key.slice(2), value as EventListener)
        } else if (key === 'class') {
            el.className = String(value)
        } else if (key === 'style') {
            el.style.cssText = String(value)
        } else if (key === 'value' || key === 'checked' || key === 'disabled') {
            ;(el as unknown as Record<string, unknown>)[key] = value
        } else {
            el.setAttribute(key, value === true ? '' : String(value))
        }
    }
    for (const child of children.flat()) {
        if (child === null || child === undefined || child === false) continue
        el.append(child instanceof Node ? child : String(child))
    }
    return el
}

export const clear = (el: Element) => el.replaceChildren()
