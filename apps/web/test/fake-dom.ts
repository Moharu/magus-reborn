/** Enough DOM for `h` and the screens built with it, so they can run in node. */
export class FakeNode {}

export class FakeElement extends FakeNode {
    className = ''
    style = { cssText: '' }
    classList = { toggle() {} }
    parent: FakeElement | null = null
    children: (FakeElement | string)[] = []
    private clickHandlers: (() => void)[] = []

    constructor(readonly tag: string) {
        super()
    }
    attrs = new Map<string, string>()
    setAttribute(name: string, value: string) {
        this.attrs.set(name, value)
    }
    addEventListener(type: string, handler: () => void) {
        if (type === 'click') this.clickHandlers.push(handler)
    }
    append(...nodes: (FakeElement | string)[]) {
        for (const node of nodes) if (node instanceof FakeElement) node.parent = this
        this.children.push(...nodes)
    }
    replaceChildren(...nodes: (FakeElement | string)[]) {
        this.children = []
        this.append(...nodes)
    }
    remove() {
        if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this)
        this.parent = null
    }
    set textContent(text: string) {
        this.children = [text]
    }
    get textContent(): string {
        return this.children.map(child => (typeof child === 'string' ? child : child.textContent)).join(' ')
    }
    /** Depth first search. */
    find(matches: (el: FakeElement) => boolean): FakeElement | null {
        if (matches(this)) return this
        for (const child of this.children) {
            const found = typeof child === 'string' ? null : child.find(matches)
            if (found) return found
        }
        return null
    }
    querySelector(selector: string): FakeElement | null {
        return this.find(el => el.className.split(' ').includes(selector.slice(1)))
    }
    button(label: string) {
        return this.find(el => el.tag === 'button' && el.textContent === label)
    }
    click() {
        for (const handler of this.clickHandlers) handler()
    }
}
