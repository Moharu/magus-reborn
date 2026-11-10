import html from '../index.html?raw'
import manifestText from '../public/manifest.webmanifest?raw'
import icon from '../public/favicon.svg?raw'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fullscreenButton, installFullscreen, onFullscreenChange, requestMobileFullscreen } from '../src/fullscreen'
import { FakeElement, FakeNode } from './fake-dom'

const gesture = { isTrusted: true } as Event
let target: EventTarget
let request: ReturnType<typeof vi.fn>
let lock: ReturnType<typeof vi.fn>
let unlock: ReturnType<typeof vi.fn>
let documentMock: Record<string, unknown>
let resize: ReturnType<typeof vi.fn>
beforeEach(() => {
    target = new EventTarget()
    request = vi.fn().mockResolvedValue(undefined)
    lock = vi.fn().mockRejectedValue(new Error('unsupported'))
    unlock = vi.fn()
    resize = vi.fn()
    documentMock = {
        fullscreenEnabled: true,
        documentElement: { requestFullscreen: request },
        createElement: (tag: string) => new FakeElement(tag),
        addEventListener: target.addEventListener.bind(target),
        removeEventListener: target.removeEventListener.bind(target),
    }
    vi.stubGlobal('document', documentMock)
    vi.stubGlobal('Node', FakeNode)
    vi.stubGlobal('navigator', { userActivation: { isActive: true } })
    vi.stubGlobal('screen', { orientation: { lock, unlock } })
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }), dispatchEvent: resize })
})
afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

it('requests synchronously only from an active mobile user gesture', () => {
    requestMobileFullscreen()
    requestMobileFullscreen(new Event('click'))
    expect(request).not.toHaveBeenCalled()
    requestMobileFullscreen(gesture)
    expect(request).toHaveBeenCalledWith({ navigationUI: 'hide' })
    request.mockClear()
    vi.stubGlobal('navigator', { userActivation: { isActive: false } })
    requestMobileFullscreen(gesture)
    expect(request).not.toHaveBeenCalled()
})

it('keeps desktop automatic entry unchanged', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
    requestMobileFullscreen(gesture)
    expect(request).not.toHaveBeenCalled()
})

it('hides the toggle when element fullscreen is unsupported or disabled', () => {
    expect(fullscreenButton()).not.toBeNull()
    documentMock.fullscreenEnabled = false
    expect(fullscreenButton()).toBeNull()
    documentMock.fullscreenEnabled = true
    documentMock.documentElement = {}
    expect(fullscreenButton()).toBeNull()
})

it('lets the desktop toggle enter and leave fullscreen', () => {
    let click: (event: Event) => void = () => {}
    vi.spyOn(FakeElement.prototype, 'addEventListener').mockImplementation((_type, handler) => {
        click = handler
    })
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
    const exit = vi.fn().mockResolvedValue(undefined)
    documentMock.exitFullscreen = exit
    fullscreenButton()
    click(gesture)
    expect(request).toHaveBeenCalledOnce()
    documentMock.fullscreenElement = {}
    click(gesture)
    expect(exit).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledOnce()
})

it('uses prefixed exit and tolerates missing orientation locking', () => {
    let click: (event: Event) => void = () => {}
    vi.spyOn(FakeElement.prototype, 'addEventListener').mockImplementation((_type, handler) => {
        click = handler
    })
    const exit = vi.fn()
    documentMock.webkitFullscreenElement = {}
    documentMock.webkitExitFullscreen = exit
    fullscreenButton()
    click(gesture)
    expect(exit).toHaveBeenCalledOnce()
    vi.stubGlobal('screen', {})
    const cleanup = installFullscreen()
    expect(() => target.dispatchEvent(new Event('webkitfullscreenchange'))).not.toThrow()
    expect(resize).toHaveBeenCalledOnce()
    cleanup()
})

it('supports prefixed element fullscreen', () => {
    documentMock.fullscreenEnabled = false
    documentMock.webkitFullscreenEnabled = true
    documentMock.documentElement = { webkitRequestFullscreen: request }
    expect(fullscreenButton()).not.toBeNull()
    requestMobileFullscreen(gesture)
    expect(request).toHaveBeenCalledOnce()
})

it('silently handles orientation rejection and refits on entry and exit', async () => {
    const cleanup = installFullscreen()
    const fit = vi.fn()
    const stopFit = onFullscreenChange(fit)
    documentMock.fullscreenElement = {}
    target.dispatchEvent(new Event('fullscreenchange'))
    await Promise.resolve()
    expect(lock).toHaveBeenCalledWith('landscape')
    expect(fit).toHaveBeenCalledTimes(1)
    documentMock.fullscreenElement = null
    target.dispatchEvent(new Event('fullscreenchange'))
    expect(fit).toHaveBeenCalledTimes(2)
    expect(resize).toHaveBeenCalledTimes(2)
    expect(unlock).toHaveBeenCalledOnce()
    expect(lock).toHaveBeenCalledTimes(1)
    cleanup()
    stopFit()
    target.dispatchEvent(new Event('fullscreenchange'))
    expect(fit).toHaveBeenCalledTimes(2)
})

it('ignores synchronous API failures and request rejection', async () => {
    request.mockImplementationOnce(() => {
        throw new Error('denied')
    })
    expect(() => requestMobileFullscreen(gesture)).not.toThrow()
    request.mockRejectedValueOnce(new Error('denied'))
    requestMobileFullscreen(gesture)
    const cleanup = installFullscreen()
    documentMock.fullscreenElement = {}
    lock.mockImplementationOnce(() => {
        throw new Error('denied')
    })
    expect(() => target.dispatchEvent(new Event('fullscreenchange'))).not.toThrow()
    await Promise.resolve()
    cleanup()
})

it('links a Vite public manifest with fullscreen, landscape and an existing icon', () => {
    expect(html).toMatch(/rel="manifest" href="\/manifest.webmanifest"/)
    const manifest = JSON.parse(manifestText)
    expect(manifest).toMatchObject({ display: 'fullscreen', orientation: 'landscape' })
    expect(manifest.icons[0].src).toBe('/favicon.svg')
    expect(icon).toContain('<svg')
})

it('silently tolerates missing or throwing orientation unlock on exit', () => {
    const cleanup = installFullscreen()
    unlock.mockImplementation(() => {
        throw new Error('unsupported')
    })
    expect(() => target.dispatchEvent(new Event('fullscreenchange'))).not.toThrow()
    expect(unlock).toHaveBeenCalledOnce()
    vi.stubGlobal('screen', {})
    expect(() => target.dispatchEvent(new Event('webkitfullscreenchange'))).not.toThrow()
    cleanup()
})
