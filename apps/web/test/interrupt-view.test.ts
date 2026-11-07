import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { Graphics } from 'pixi.js'
import { Battle, SPELLS, type LogEntry, type PlayerKey, type SpellId } from '@magus/engine'
import { BattleView } from '../src/game/battle-view'
import type { PlayerHud } from '../src/game/hud'
import { GROUND_Y, SIDE_X, type Side } from '../src/game/layout'
import { iconTexture } from '../src/game/textures'
import type { Vfx } from '../src/game/vfx'
import type { Wizard } from '../src/game/wizard'

// pixi reads navigator on import, and node only has it from version 21; CI runs node 20
vi.hoisted(() => {
    if (!('navigator' in globalThis)) vi.stubGlobal('navigator', { userAgent: 'node' })
})

// the real textures draw on a canvas, which node doesn't have; nothing here is rendered
vi.mock('../src/game/textures', async () => {
    const { Texture } = await import('pixi.js')
    return {
        iconTexture: vi.fn(() => Texture.EMPTY),
        particleTexture: () => Texture.EMPTY,
        backdropTexture: () => Texture.EMPTY,
    }
})

// a different order per seat, so reading the spell index from the wrong player names the wrong spell
const LOADOUTS: Record<PlayerKey, SpellId[]> = {
    player1: ['SPELL_FIREBALL', 'SPELL_METEOR', 'SPELL_COUNTERSPELL', 'SPELL_BLUR', 'SPELL_HASTE', 'SPELL_LIVING_BOMB'],
    player2: ['SPELL_COUNTERSPELL', 'SPELL_BLUR', 'SPELL_METEOR', 'SPELL_FIREBALL', 'SPELL_LIVING_BOMB', 'SPELL_HASTE'],
}
const CYAN = 0x7ff3ff
const FIREBALL_ORANGE = 0xff8a1f
const LIVING_BOMB_PURPLE = 0xb15cff
const FRAME = 1 / 60
/** Long enough for the Counterspell projectile to land. */
const AFTER_LANDING = 0.25

/** The private parts of the view and HUD that show the tell. */
interface ViewInternals {
    update: BattleView['update']
    frame(dt: number): void
    vfx: Vfx
    wizards: Record<Side, Wizard>
    huds: Record<
        Side,
        {
            showInterrupted: PlayerHud['showInterrupted']
            castText: { text: string; visible: boolean; alpha: number }
            castIcon: { visible: boolean }
            bars: Graphics
            x0: number
            w: number
        }
    >
}

const newBattle = () =>
    new Battle({ name: 'Alice', spells: LOADOUTS.player1 }, { name: 'Bob', spells: LOADOUTS.player2 })

const createView = (me: PlayerKey | null) => {
    const Ctor = BattleView as unknown as new (container: unknown, options: { me: PlayerKey | null }) => ViewInternals
    const view = new Ctor({}, { me })
    // init() places the wizards but needs a real canvas; without this both sit at x = 0 and sides can't be told apart
    view.wizards.left.position.set(SIDE_X.left, GROUND_Y)
    view.wizards.right.position.set(SIDE_X.right, GROUND_Y)
    return view
}

const press = (battle: Battle, player: PlayerKey, id: SpellId) =>
    expect(battle.startCast(player, LOADOUTS[player].indexOf(id))).toBe(true)

const runFrames = (view: ViewInternals, seconds: number) => {
    for (let t = 0; t < seconds; t += FRAME) view.frame(FRAME)
}

/** The highest screen shake seen over the given time. */
const peakShake = (view: ViewInternals, seconds: number) => {
    let peak = 0
    for (let t = 0; t < seconds; t += FRAME) {
        view.frame(FRAME)
        peak = Math.max(peak, view.vfx.shake)
    }
    return peak
}

type Style = { color?: number; alpha?: number }

/** The cyan styles recorded by a spy on a Graphics `fill` or `stroke`. */
const cyanStyles = (spy: MockInstance) =>
    spy.mock.calls.map(([style]) => style as Style).filter(style => style.color === CYAN)

describe('BattleView interrupt tell (#39)', () => {
    let battle: Battle
    let seen: number

    /** What the client gets after each tick: the snapshot and only the new log entries. */
    const feed = (view: ViewInternals, fresh = true) => {
        const newLog: LogEntry[] = battle.state.log.slice(seen)
        seen = battle.state.log.length
        view.update(battle.snapshot(), newLog, [], fresh)
    }

    beforeEach(() => {
        battle = newBattle()
        for (let i = 0; i < 10; i++) battle.tick()
        seen = battle.state.log.length
    })

    describe.each<[PlayerKey, Side, Side]>([
        ['player1', 'left', 'right'],
        ['player2', 'right', 'left'],
    ])('seen by %s', (me, interruptedSide, casterSide) => {
        it('flashes the cast bar of the interrupted player only, with the spell name', () => {
            const view = createView(me)
            press(battle, 'player1', 'SPELL_FIREBALL')
            feed(view)
            view.frame(FRAME)
            press(battle, 'player2', 'SPELL_COUNTERSPELL')
            feed(view)
            view.frame(FRAME)

            const bar = view.huds[interruptedSide].castText
            expect(bar.visible).toBe(true)
            expect(bar.text).toBe(`${SPELLS.SPELL_FIREBALL.label} interrupted!`)
            expect(view.huds[casterSide].castText.visible).toBe(false)
        })

        it('shows the icon of the interrupted spell on the cast bar', () => {
            const view = createView(me)
            press(battle, 'player1', 'SPELL_FIREBALL')
            press(battle, 'player2', 'SPELL_COUNTERSPELL')
            feed(view)
            vi.mocked(iconTexture).mockClear()
            view.frame(FRAME)

            expect(view.huds[interruptedSide].castIcon.visible).toBe(true)
            expect(view.huds[casterSide].castIcon.visible).toBe(false)
            expect(iconTexture).toHaveBeenCalledWith('SPELL_FIREBALL')
        })

        it('draws the flash across the whole cast bar, fading until it ends', () => {
            const view = createView(me)
            const hud = view.huds[interruptedSide]
            const roundRect = vi.spyOn(hud.bars, 'roundRect')
            const fill = vi.spyOn(hud.bars, 'fill')
            const stroke = vi.spyOn(hud.bars, 'stroke')
            const casterFill = vi.spyOn(view.huds[casterSide].bars, 'fill')
            const casterStroke = vi.spyOn(view.huds[casterSide].bars, 'stroke')
            press(battle, 'player1', 'SPELL_FIREBALL')
            press(battle, 'player2', 'SPELL_COUNTERSPELL')
            feed(view)
            view.frame(FRAME)

            expect(roundRect).toHaveBeenCalledWith(hud.x0 + 2, 78, hud.w - 4, 22, 4)
            const [first] = cyanStyles(fill)
            expect(first.alpha).toBeGreaterThan(0.5)
            const [outline] = cyanStyles(stroke)
            expect(outline.alpha).toBeGreaterThan(0.5)

            fill.mockClear()
            runFrames(view, 0.5)
            expect(cyanStyles(fill).at(-1)!.alpha).toBeLessThan(first.alpha!)

            runFrames(view, 0.5)
            fill.mockClear()
            stroke.mockClear()
            view.frame(FRAME)
            expect(cyanStyles(fill)).toEqual([])
            expect(cyanStyles(stroke)).toEqual([])

            expect(cyanStyles(casterFill)).toEqual([])
            expect(cyanStyles(casterStroke)).toEqual([])
        })

        it('floats "Interrupted!" over the Counterspell caster', () => {
            const view = createView(me)
            const floatText = vi.spyOn(view.vfx, 'floatText')
            press(battle, 'player1', 'SPELL_FIREBALL')
            press(battle, 'player2', 'SPELL_COUNTERSPELL')
            feed(view)

            expect(floatText).toHaveBeenCalledTimes(1)
            const [at, text, color] = floatText.mock.calls[0]
            expect(text).toBe('Interrupted!')
            expect(color).toBe(CYAN)
            expect(at.x).toBe(view.wizards[casterSide].headPoint.x)
        })

        it('bursts on the interrupted wizard when the projectile lands', () => {
            const view = createView(me)
            const burst = vi.spyOn(view.vfx, 'burst')
            press(battle, 'player1', 'SPELL_FIREBALL')
            press(battle, 'player2', 'SPELL_COUNTERSPELL')
            feed(view)

            view.frame(FRAME)
            expect(burst).not.toHaveBeenCalled()
            runFrames(view, AFTER_LANDING)
            expect(burst).toHaveBeenCalledTimes(1)
            expect(burst.mock.calls[0][0]).toEqual(view.wizards[interruptedSide].chestPoint)
            expect(burst.mock.calls[0][1]).toBe(CYAN)
        })

        it('puts a ring and a spray on the Counterspell caster right away', () => {
            const view = createView(me)
            const ring = vi.spyOn(view.vfx, 'ring')
            const spray = vi.spyOn(view.vfx, 'spray')
            press(battle, 'player1', 'SPELL_FIREBALL')
            press(battle, 'player2', 'SPELL_COUNTERSPELL')
            feed(view)

            // no frame has run yet, so the projectile hasn't added its own ring or trail
            const chest = view.wizards[casterSide].chestPoint
            expect(ring).toHaveBeenCalledTimes(1)
            expect(ring.mock.calls[0].slice(0, 2)).toEqual([chest, CYAN])
            expect(spray).toHaveBeenCalledTimes(1)
            expect(spray.mock.calls[0].slice(0, 2)).toEqual([chest, CYAN])
        })

        it.each<[SpellId, number]>([
            ['SPELL_FIREBALL', FIREBALL_ORANGE],
            ['SPELL_LIVING_BOMB', LIVING_BOMB_PURPLE],
        ])("sprays %s's color from the interrupted staff when the projectile lands", (id, color) => {
            const view = createView(me)
            const spray = vi.spyOn(view.vfx, 'spray')
            const sparks = () => spray.mock.calls.filter(call => call[1] === color)
            press(battle, 'player1', id)
            press(battle, 'player2', 'SPELL_COUNTERSPELL')
            feed(view)

            view.frame(FRAME)
            expect(sparks()).toEqual([])
            runFrames(view, AFTER_LANDING)
            expect(sparks()).toHaveLength(1)
            expect(sparks()[0][0].x).toBe(view.wizards[interruptedSide].castPoint.x)
        })

        it('shakes the screen when the projectile lands', () => {
            const view = createView(me)
            press(battle, 'player1', 'SPELL_FIREBALL')
            press(battle, 'player2', 'SPELL_COUNTERSPELL')
            feed(view)

            expect(peakShake(view, FRAME)).toBe(0)
            expect(peakShake(view, AFTER_LANDING)).toBeGreaterThan(0)
        })
    })

    it("names the spell from the interrupted player's own loadout", () => {
        const view = createView('player1')
        press(battle, 'player2', 'SPELL_METEOR')
        press(battle, 'player1', 'SPELL_COUNTERSPELL')
        feed(view)
        view.frame(FRAME)

        expect(view.huds.right.castText.text).toBe(`${SPELLS.SPELL_METEOR.label} interrupted!`)
    })

    it('shows the same tell to a spectator', () => {
        const view = createView(null)
        const floatText = vi.spyOn(view.vfx, 'floatText')
        press(battle, 'player2', 'SPELL_FIREBALL')
        press(battle, 'player1', 'SPELL_COUNTERSPELL')
        feed(view)
        view.frame(FRAME)

        expect(view.huds.right.castText.text).toBe(`${SPELLS.SPELL_FIREBALL.label} interrupted!`)
        expect(floatText.mock.calls[0][0].x).toBe(view.wizards.left.headPoint.x)
    })

    it('plays only once, however many snapshots follow', () => {
        const view = createView('player1')
        const floatText = vi.spyOn(view.vfx, 'floatText')
        const burst = vi.spyOn(view.vfx, 'burst')
        press(battle, 'player1', 'SPELL_FIREBALL')
        press(battle, 'player2', 'SPELL_COUNTERSPELL')
        for (let i = 0; i < 40; i++) {
            feed(view)
            view.frame(FRAME)
            battle.tick()
        }
        expect(floatText).toHaveBeenCalledTimes(1)
        expect(burst).toHaveBeenCalledTimes(1)
    })

    it('plays nothing new for a Counterspell that lands on nothing, but keeps its projectile', () => {
        const view = createView('player1')
        const floatText = vi.spyOn(view.vfx, 'floatText')
        const burst = vi.spyOn(view.vfx, 'burst')
        const projectile = vi.spyOn(view.vfx, 'projectile')
        const ring = vi.spyOn(view.vfx, 'ring')
        const spray = vi.spyOn(view.vfx, 'spray')
        // player 2 counters, so player 1's HUD on the left is the one an interrupt would flash
        const flash = vi.spyOn(view.huds.left, 'showInterrupted')
        const barFill = vi.spyOn(view.huds.left.bars, 'fill')
        press(battle, 'player2', 'SPELL_COUNTERSPELL')
        feed(view)

        // no frame has run yet: an interrupt would already have put its ring and spray on the caster
        expect(ring).not.toHaveBeenCalled()
        expect(spray).not.toHaveBeenCalled()

        expect(peakShake(view, AFTER_LANDING)).toBe(0)

        expect(projectile).toHaveBeenCalledTimes(1)
        expect(flash).not.toHaveBeenCalled()
        expect(cyanStyles(barFill)).toEqual([])
        expect(floatText).not.toHaveBeenCalled()
        expect(burst).not.toHaveBeenCalled()
        // the existing ring, where the projectile lands
        expect(ring).toHaveBeenCalledTimes(1)
        expect(ring.mock.calls[0][0]).toEqual(view.wizards.left.chestPoint)
        expect(view.huds.left.castText.visible).toBe(false)
        expect(view.huds.right.castText.visible).toBe(false)
    })

    it('shows no tell when the cast bar ends another way', () => {
        const view = createView('player1')
        const floatText = vi.spyOn(view.vfx, 'floatText')
        press(battle, 'player1', 'SPELL_FIREBALL')
        feed(view)
        view.frame(FRAME)
        press(battle, 'player1', 'SPELL_BLUR')
        feed(view)
        view.frame(FRAME)

        expect(battle.state.player1.cast).toBeNull()
        expect(floatText).not.toHaveBeenCalled()
        expect(view.huds.left.castText.visible).toBe(false)
    })

    it('replays nothing from catch-up state, which carries the full log', () => {
        const view = createView('player1')
        const floatText = vi.spyOn(view.vfx, 'floatText')
        press(battle, 'player1', 'SPELL_FIREBALL')
        press(battle, 'player2', 'SPELL_COUNTERSPELL')
        feed(view, false)
        runFrames(view, AFTER_LANDING)

        expect(floatText).not.toHaveBeenCalled()
        expect(view.huds.left.castText.visible).toBe(false)
    })

    it('ends the cast bar flash on its own, and a later cast shows normally', () => {
        const view = createView('player1')
        press(battle, 'player1', 'SPELL_FIREBALL')
        press(battle, 'player2', 'SPELL_COUNTERSPELL')
        feed(view)
        runFrames(view, 0.8)
        const bar = view.huds.left.castText
        expect(bar.visible).toBe(true)
        expect(bar.alpha).toBeLessThan(1)

        runFrames(view, 0.2)
        expect(bar.visible).toBe(false)

        while (battle.state.gameTick < battle.state.player1.lockedUntil) battle.tick()
        press(battle, 'player1', 'SPELL_FIREBALL')
        feed(view)
        view.frame(FRAME)
        expect(bar.visible).toBe(true)
        expect(bar.alpha).toBe(1)
        expect(bar.text).toContain(SPELLS.SPELL_FIREBALL.label)
        expect(bar.text).not.toContain('interrupted')
    })

    it('gives way to a new cast if one starts during the flash', () => {
        const view = createView('player1')
        press(battle, 'player1', 'SPELL_FIREBALL')
        press(battle, 'player2', 'SPELL_COUNTERSPELL')
        feed(view)
        runFrames(view, 0.1)

        // the lock and the round countdown keep this out of real play, so it takes another battle's state
        const fresh = newBattle()
        fresh.tick()
        fresh.startCast('player1', LOADOUTS.player1.indexOf('SPELL_METEOR'))
        view.update(fresh.snapshot(), [], [])
        view.frame(FRAME)

        const bar = view.huds.left.castText
        expect(bar.alpha).toBe(1)
        expect(bar.text).toContain(SPELLS.SPELL_METEOR.label)
        expect(bar.text).not.toContain('interrupted')

        // the flash had time left, but it must not come back when that cast ends
        fresh.stopCast('player1', LOADOUTS.player1.indexOf('SPELL_METEOR'))
        view.update(fresh.snapshot(), [], [])
        view.frame(FRAME)
        expect(bar.visible).toBe(false)
    })
})
