import { afterEach, expect, it, vi } from 'vitest'
import { BattleView } from '../src/game/battle-view'
import { FakeElement } from './fake-dom'

vi.mock('../src/game/textures', async () => {
    const { Texture } = await import('pixi.js')
    return {
        iconTexture: () => Texture.EMPTY,
        particleTexture: () => Texture.EMPTY,
        backdropTexture: () => Texture.EMPTY,
    }
})
vi.mock('pixi.js', async importOriginal => {
    const actual = await importOriginal<typeof import('pixi.js')>()
    return {
        ...actual,
        Application: class {
            stage = new actual.Container()
            canvas = { classList: { add() {} } }
            ticker = { add() {} }
            renderer = { resize() {} }
            async init() {}
            destroy() {}
        },
    }
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

it('refits the live battle on fullscreen entry and exit and removes both listeners on destruction', async () => {
    const events = new EventTarget()
    const remove = vi.spyOn(events, 'removeEventListener')
    vi.stubGlobal('document', {
        createElement: (tag: string) => new FakeElement(tag),
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
    })
    vi.stubGlobal('window', { removeEventListener() {} })
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            disconnect() {}
        },
    )
    vi.spyOn(FakeElement.prototype, 'querySelector').mockReturnValue(null)
    const host = new FakeElement('div')
    Object.assign(host, { clientWidth: 960, clientHeight: 600 })
    // Keep Pixi geometry real while observing the view's actual lifecycle wiring.
    const prototype = BattleView.prototype as unknown as { fit(): void }
    const fit = vi.spyOn(prototype, 'fit')
    const view = await BattleView.create(host as unknown as HTMLElement, { me: null })
    expect(view).toBeInstanceOf(BattleView)
    fit.mockClear()
    Object.defineProperty(document, 'fullscreenElement', { value: host, writable: true })
    events.dispatchEvent(new Event('fullscreenchange'))
    expect(fit).toHaveBeenCalledTimes(1)
    Object.assign(host, { clientWidth: 667, clientHeight: 375 })
    Object.defineProperty(document, 'fullscreenElement', { value: null })
    events.dispatchEvent(new Event('webkitfullscreenchange'))
    expect(fit).toHaveBeenCalledTimes(2)
    view.destroy()
    expect(remove.mock.calls.map(([name]) => name)).toEqual(['fullscreenchange', 'webkitfullscreenchange'])
    events.dispatchEvent(new Event('fullscreenchange'))
    Object.defineProperty(document, 'fullscreenElement', { value: null })
    events.dispatchEvent(new Event('webkitfullscreenchange'))
    expect(fit).toHaveBeenCalledTimes(2)
})
