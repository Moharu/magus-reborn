import { EventBoundary, FederatedPointerEvent } from 'pixi.js'
import { describe, expect, it, vi } from 'vitest'
import { Battle, DEFAULT_SPELLS, secondsToTicks, ticksToSeconds } from '@magus/engine'
import { battleLayout, HEIGHT, sidesFor, WIDTH, type Rect } from '../src/game/layout'
import { ActionBar, PlayerHud } from '../src/game/hud'
import { BattleView } from '../src/game/battle-view'

vi.mock('../src/game/textures', async () => {
    const { Texture } = await import('pixi.js')
    return { iconTexture: () => Texture.EMPTY, particleTexture: () => Texture.EMPTY }
})

const overlaps = (a: Rect, b: Rect) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

const battle = () => new Battle({ name: 'Alice', spells: DEFAULT_SPELLS }, { name: 'Bob', spells: DEFAULT_SPELLS })

describe('Split Console desktop geometry', () => {
    it.each([
        [960, 600],
        [1200, 720],
    ])('fits at %ix%i without overlapping controls', (width, height) => {
        const layout = battleLayout(width, height)
        const rectangles = [
            ...Object.values(layout.left),
            ...Object.values(layout.right),
            layout.score,
            layout.timer,
            ...Object.values(layout.fighters),
            layout.centre,
            ...layout.slots,
        ]
        for (const r of [...rectangles, layout.bar]) {
            expect(r.x).toBeGreaterThanOrEqual(0)
            expect(r.y).toBeGreaterThanOrEqual(0)
            expect(r.x + r.width).toBeLessThanOrEqual(width)
            expect(r.y + r.height).toBeLessThanOrEqual(height)
        }
        for (let i = 0; i < rectangles.length; i++)
            for (let j = i + 1; j < rectangles.length; j++) expect(overlaps(rectangles[i], rectangles[j])).toBe(false)
        expect(layout.slots).toHaveLength(7)
        expect(new Set(layout.slots.map(r => r.width)).size).toBe(1)
        for (const r of layout.slots) {
            expect(r.x).toBeGreaterThan(layout.bar.x)
            expect(r.x + r.width).toBeLessThan(layout.bar.x + layout.bar.width)
            expect(r.y + r.height).toBeLessThanOrEqual(layout.bar.y + layout.bar.height)
        }
    })

    it('keeps the local seat on the left', () => {
        expect(sidesFor('player1')).toEqual({ left: 'player1', right: 'player2' })
        expect(sidesFor('player2')).toEqual({ left: 'player2', right: 'player1' })
    })
})

// Inspect the actual Pixi tree without a browser or a GPU.
interface Slot {
    root: { x: number; y: number; accessibleHint: string }
    name: { text: string }
    key: { text: string; visible: boolean }
    center: { text: string }
}

describe('Split Console elements', () => {
    it('draws only seven own buttons in loadout order, with desktop keys and no status captions', () => {
        const bar = new ActionBar(
            () => {},
            () => {},
        )
        const player = battle().state.player1
        bar.update(player, 0, new Set())
        const slots = (bar as unknown as { buttons: Slot[] }).buttons
        expect(slots).toHaveLength(7)
        expect(slots.map(b => b.key.text)).toEqual(['Q', 'W', 'E', 'R', 'Space', 'D', 'F'])
        expect(slots.every(b => b.key.visible)).toBe(true)
        expect(slots.map(b => b.name.text)).toEqual([
            'Fireball',
            'Ignite',
            'Combustion',
            'Afterburn',
            'Counter Spell',
            'Haste',
            'Temporal Shield',
        ])
        expect(slots.every(b => b.center.text === '')).toBe(true)
        const layout = battleLayout(WIDTH, HEIGHT)
        slots.forEach((b, i) => expect(b.root.x).toBe(layout.slots[i].x + layout.slots[i].width / 2))
    })

    it('shows a lock glyph and lock seconds on all seven icons even with a longer cooldown', () => {
        const bar = new ActionBar(
            () => {},
            () => {},
        )
        const player = battle().state.player1
        player.lockedUntil = secondsToTicks(3)
        player.spells[4].lastCast = 0
        bar.update(player, 1, new Set())
        const slots = (bar as unknown as { buttons: Slot[] }).buttons
        expect(slots.every(b => b.center.text === '🔒 3.0s')).toBe(true)
        expect(slots[4].root.accessibleHint).toContain(
            `Personal cooldown ${ticksToSeconds(player.spells[4].cooldown - 1).toFixed(1)} seconds`,
        )
        bar.update(player, player.lockedUntil, new Set())
        expect(slots.every(b => !b.center.text.includes('🔒'))).toBe(true)
        expect(slots[4].center.text).toBe(
            `${ticksToSeconds(player.spells[4].cooldown - player.lockedUntil).toFixed(1)}s`,
        )
    })

    it('places numeric HP above each green bar', () => {
        const hud = new PlayerHud('right')
        hud.update(battle().snapshot().player2, 0, 1 / 60)
        const text = (hud as unknown as { hpText: { text: string; y: number } }).hpText
        expect(text.text).toBe('100.0 / 100 HP')
        expect(text.y).toBeLessThan(battleLayout(WIDTH, HEIGHT).right.hp.y)
    })

    it('handles Space only in active combat, preventing scrolling when handled', () => {
        const Ctor = BattleView as unknown as new (
            container: unknown,
            options: unknown,
        ) => {
            update: BattleView['update']
            setFrozen: BattleView['setFrozen']
            onKeyDown(event: unknown): void
            overlay: { visible: boolean }
        }
        const press = vi.fn()
        const view = new Ctor({}, { me: 'player1', onPress: press })
        const event = { code: 'Space', preventDefault: vi.fn() }
        view.onKeyDown(event)
        expect(event.preventDefault).not.toHaveBeenCalled()
        view.update(battle().snapshot(), [], [])
        view.overlay.visible = false
        view.setFrozen(true)
        view.onKeyDown(event)
        expect(press).not.toHaveBeenCalled()
        view.setFrozen(false)
        view.onKeyDown(event)
        expect(press).toHaveBeenCalledWith(4)
        expect(event.preventDefault).toHaveBeenCalledOnce()
        view.onKeyDown({ ...event, repeat: true })
        expect(event.preventDefault).toHaveBeenCalledTimes(2)
        expect(press).toHaveBeenCalledTimes(1)
    })
})

// Regression coverage for pointer and accessibility activation on the real Pixi containers.
describe('battle input review regressions', () => {
    it('handles one pointer down/up/click as exactly one press and release', () => {
        const press = vi.fn()
        const release = vi.fn()
        const bar = new ActionBar(press, release)
        const root = bar.children[1]
        const event = new FederatedPointerEvent(new EventBoundary(bar))
        event.pointerType = 'mouse'
        root.emit('pointerdown', event)
        root.emit('pointerup', event)
        root.emit('click', event)
        expect(press.mock.calls).toEqual([[0]])
        expect(release.mock.calls).toEqual([[0]])
        expect(root.tabIndex).toBe(0)
    })

    it('lets accessible activation charge and release a real Fireball at completion', () => {
        const game = battle()
        const release = vi.fn((i: number) => game.stopCast('player1', i))
        const bar = new ActionBar(i => game.startCast('player1', i), release)
        bar.children[1].emit('click', new FederatedPointerEvent(new EventBoundary(bar)))
        expect(game.state.player1.cast).toBe(0)
        expect(release).not.toHaveBeenCalled()
        const duration = game.state.player1.spells[0].castTime
        for (let i = 0; i < duration; i++) {
            bar.update(game.state.player1, game.state.gameTick, new Set())
            expect(release).not.toHaveBeenCalled()
            game.tick()
        }
        // Render interpolation must not release before an authoritative tick confirms completion.
        bar.update(game.state.player1, game.state.gameTick, new Set(), game.state.gameTick - 1)
        expect(release).not.toHaveBeenCalled()
        bar.update(game.state.player1, game.state.gameTick, new Set())
        expect(release).toHaveBeenCalledExactlyOnceWith(0)
        expect(game.state.player2.hp).toBeLessThan(100)
        bar.update(game.state.player1, game.state.gameTick, new Set())
        expect(release).toHaveBeenCalledTimes(1)
    })

    it.each([null, 'player1', 'player2'] as const)('labels seats correctly for viewer %s', me => {
        const Ctor = BattleView as unknown as new (
            container: unknown,
            options: unknown,
        ) => {
            huds: Record<'left' | 'right', { update: PlayerHud['update']; nameText: { text: string } }>
        }
        const view = new Ctor({}, { me })
        const snapshot = battle().snapshot()
        const sides = sidesFor(me)
        for (const side of ['left', 'right'] as const) {
            const hud = view.huds[side]
            hud.update(snapshot[sides[side]], 0, 1 / 60)
            const name = snapshot[sides[side]].name
            expect(hud.nameText.text).toBe(me ? `${sides[side] === me ? 'YOU' : 'OPPONENT'} · ${name}` : name)
        }
    })

    it('leaves Space in input/dialog/picker targets alone and prevents handled keyup even after freezing', () => {
        const Ctor = BattleView as unknown as new (
            container: unknown,
            options: unknown,
        ) => {
            update: BattleView['update']
            setFrozen: BattleView['setFrozen']
            onKeyDown(event: unknown): void
            onKeyUp(event: unknown): void
            overlay: { visible: boolean }
        }
        const press = vi.fn()
        const release = vi.fn()
        const view = new Ctor({}, { me: 'player1', onPress: press, onRelease: release })
        view.update(battle().snapshot(), [], [])
        view.overlay.visible = false
        for (const target of [
            { tagName: 'INPUT' },
            { tagName: 'BUTTON', closest: (s: string) => s.includes('dialog') },
            { tagName: 'BUTTON', closest: (s: string) => s.includes('.picker') },
        ]) {
            const event = { code: 'Space', target, preventDefault: vi.fn() }
            view.onKeyDown(event)
            view.onKeyUp(event)
            expect(event.preventDefault).not.toHaveBeenCalled()
        }
        expect(press).not.toHaveBeenCalled()
        view.onKeyDown({ code: 'Space', preventDefault: vi.fn() })
        const up = { code: 'Space', preventDefault: vi.fn() }
        view.onKeyUp(up)
        expect(up.preventDefault).toHaveBeenCalled()
        expect(release).toHaveBeenCalledExactlyOnceWith(4)
        view.onKeyDown({ code: 'Space', preventDefault: vi.fn() })
        view.setFrozen(true)
        expect(release).toHaveBeenCalledTimes(1)
        const frozenUp = { code: 'Space', preventDefault: vi.fn() }
        view.onKeyUp(frozenUp)
        expect(frozenUp.preventDefault).toHaveBeenCalled()
        expect(release).toHaveBeenCalledTimes(1)
    })
})

describe('accessible cast ownership', () => {
    const setup = () => {
        const game = battle()
        const release = vi.fn((i: number) => game.stopCast('player1', i))
        const bar = new ActionBar(i => game.startCast('player1', i), release)
        const click = (i: number) =>
            bar.children[i + 1].emit('click', new FederatedPointerEvent(new EventBoundary(bar)))
        const update = () => bar.update(game.state.player1, game.state.gameTick, new Set())
        const charge = () => {
            for (let i = 0; i < game.state.player1.spells[0].castTime; i++) game.tick()
            update()
        }
        return { game, release, bar, click, update, charge }
    }

    describe.each(['training', 'lobby'] as const)('%s state-driven ownership', mode => {
        const harness = () => {
            const game = battle()
            const commands: (() => void)[] = []
            const Ctor = BattleView as unknown as new (
                container: unknown,
                options: unknown,
            ) => {
                actionBar: ActionBar
                overlay: { visible: boolean }
                update: BattleView['update']
                setOverlay: BattleView['setOverlay']
                onKeyDown(event: unknown): void
            }
            const feed = () => view.update(game.snapshot(), [], [])
            const press = (i: number) => {
                if (mode === 'lobby') {
                    commands.push(() => game.startCast('player1', i))
                    return
                }
                const accepted = game.startCast('player1', i)
                feed()
                return accepted
            }
            const release = vi.fn((i: number) => game.stopCast('player1', i))
            const view = new Ctor({}, { me: 'player1', onPress: press, onRelease: release })
            const bar = new ActionBar(press, release)
            view.actionBar = bar
            view.overlay.visible = false
            const sync = () => {
                for (const command of commands.splice(0)) command()
                feed()
            }
            const input = (kind: 'click' | 'pointer' | 'keyboard', i: number) => {
                if (kind === 'keyboard')
                    view.onKeyDown({
                        code: ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'Space', 'KeyD', 'KeyF'][i],
                        preventDefault: vi.fn(),
                    })
                else
                    bar.children[i + 1].emit(
                        kind === 'click' ? 'click' : 'pointerdown',
                        new FederatedPointerEvent(new EventBoundary(bar)),
                    )
                sync()
            }
            const charge = () => {
                for (let i = 0; i < 200; i++) {
                    game.tick()
                    sync()
                }
            }
            sync()
            return { game, view, bar, release, input, charge, sync }
        }

        it.each([0, 0.4, 0.6, 0.99])('auto-releases activation at display tick 10 + %s', fraction => {
            const { game, bar, release, input, sync } = harness()
            for (let i = 0; i < 10; i++) game.tick()
            sync()
            bar.update(game.state.player1, game.state.gameTick + fraction, new Set(), game.state.gameTick)
            input('click', 0)
            const completion = game.state.gameTick + game.state.player1.spells[0].castTime
            while (game.state.gameTick < completion) {
                expect(release).not.toHaveBeenCalled()
                game.tick()
                sync()
            }
            expect(release).toHaveBeenCalledExactlyOnceWith(0)
            expect(game.state.player1.cast).toBeNull()
            expect(game.state.player2.hp).toBeLessThan(100)
            sync()
            expect(release).toHaveBeenCalledTimes(1)
        })

        it('does not claim a manual Fireball after an accessible request rejected under Counterspell', () => {
            const { game, release, input, charge, sync } = harness()
            game.startCast('player1', 0)
            game.startCast('player2', 4)
            sync()
            input('click', 0)
            while (game.state.gameTick < game.state.player1.lockedUntil) {
                game.tick()
                sync()
            }
            input('keyboard', 0)
            charge()
            expect(release).not.toHaveBeenCalled()
            expect(game.state.player1.cast).toBe(0)
        })

        it.each(['keyboard', 'pointer'] as const)('releases accessible Fireball after rejected %s Haste', kind => {
            const { game, release, input, charge } = harness()
            game.startCast('player1', 5)
            input('click', 0)
            input(kind, 5)
            expect(game.state.player1.cast).toBe(0)
            charge()
            expect(release).toHaveBeenCalledExactlyOnceWith(0)
            expect(game.state.player2.hp).toBeLessThan(100)
        })

        it.each(['keyboard', 'pointer', 'click'] as const)(
            'gives an accepted replacement its own %s release behavior',
            kind => {
                const { game, release, input, charge } = harness()
                input('click', 0)
                game.tick()
                input(kind, 1)
                charge()
                if (kind === 'click') {
                    expect(release).toHaveBeenCalledExactlyOnceWith(1)
                    expect(game.state.player1.cast).toBeNull()
                } else {
                    expect(release).not.toHaveBeenCalled()
                    expect(game.state.player1.cast).toBe(1)
                    game.stopCast('player1', 1)
                    charge()
                    expect(game.state.player2.hp).toBeLessThan(100)
                }
            },
        )

        it('drops an interrupted binding before a later manual cast', () => {
            const { game, release, input, charge, sync } = harness()
            input('click', 0)
            expect(game.startCast('player2', 4)).toBe(true)
            sync()
            expect(game.state.player1.cast).toBeNull()
            while (game.state.gameTick < game.state.player1.lockedUntil) game.tick()
            input('keyboard', 0)
            charge()
            expect(release).not.toHaveBeenCalled()
        })

        it('drops ownership at round end even if the last snapshot still has a cast', () => {
            const { game, view, release, input, charge } = harness()
            input('click', 0)
            view.setOverlay('Round over')
            charge()
            expect(release).not.toHaveBeenCalled()
            expect(game.state.player2.hp).toBe(100)
        })
    })

    it('does not retain an activation rejected by the combat gate', () => {
        const game = battle()
        const release = vi.fn()
        const bar = new ActionBar(() => false, release)
        bar.children[1].emit('click', new FederatedPointerEvent(new EventBoundary(bar)))
        game.startCast('player1', 0)
        for (let i = 0; i < game.state.player1.spells[0].castTime; i++) game.tick()
        bar.update(game.state.player1, game.state.gameTick, new Set())
        expect(release).not.toHaveBeenCalled()
    })

    it('keeps Fireball automatic release after rejected accessible Haste, before and after confirmation', () => {
        for (const confirmed of [false, true]) {
            const { game, release, click, update, charge } = setup()
            game.startCast('player1', 5)
            click(0)
            if (confirmed) update()
            click(5)
            expect(game.state.player1.cast).toBe(0)
            charge()
            expect(release).toHaveBeenCalledExactlyOnceWith(0)
            expect(game.state.player2.hp).toBeLessThan(100)
        }
    })

    it.each(['cancel', 'replace', 'pointer'] as const)('does not release a later manual Fireball after %s', reason => {
        const { game, release, bar, click, update, charge } = setup()
        click(0)
        update()
        game.tick()
        if (reason === 'cancel') game.stopCast('player1', 0)
        if (reason === 'replace') game.startCast('player1', 1)
        if (reason === 'cancel' || reason === 'replace') update()
        if (reason === 'pointer') bar.children[1].emit('pointerdown', new FederatedPointerEvent(new EventBoundary(bar)))
        game.startCast('player1', 0)
        charge()
        expect(release).not.toHaveBeenCalled()
        expect(game.state.player1.cast).toBe(0)
    })

    it.each([8, 11])('bounds delayed lobby acceptance at %i ticks', delay => {
        const game = battle()
        const release = vi.fn((i: number) => game.stopCast('player1', i))
        const bar = new ActionBar(() => {}, release)
        bar.update(game.state.player1, 0, new Set())
        bar.children[1].emit('click', new FederatedPointerEvent(new EventBoundary(bar)))
        for (let i = 0; i < delay; i++) {
            game.tick()
            bar.update(game.state.player1, game.state.gameTick, new Set())
        }
        game.startCast('player1', 0)
        bar.update(game.state.player1, game.state.gameTick, new Set())
        for (let i = 0; i < game.state.player1.spells[0].castTime; i++) game.tick()
        bar.update(game.state.player1, game.state.gameTick, new Set())
        if (delay <= 10) expect(release).toHaveBeenCalledExactlyOnceWith(0)
        else {
            expect(release).not.toHaveBeenCalled()
            expect(game.state.player1.cast).toBe(0)
        }
    })

    it('does not claim manual input within a pending lobby request window', () => {
        const game = battle()
        const release = vi.fn()
        const bar = new ActionBar(() => {}, release)
        bar.children[1].emit('click', new FederatedPointerEvent(new EventBoundary(bar)))
        bar.children[1].emit('pointerdown', new FederatedPointerEvent(new EventBoundary(bar)))
        game.startCast('player1', 0)
        for (let i = 0; i < game.state.player1.spells[0].castTime; i++) game.tick()
        bar.update(game.state.player1, game.state.gameTick, new Set())
        expect(release).not.toHaveBeenCalled()
    })

    it('keeps a second accessible request while an older network cast is confirmed', () => {
        const game = battle()
        const requests: number[] = []
        const release = vi.fn((i: number) => game.stopCast('player1', i))
        const bar = new ActionBar(i => {
            requests.push(i)
        }, release)
        for (const i of [0, 1]) bar.children[i + 1].emit('click', new FederatedPointerEvent(new EventBoundary(bar)))
        game.startCast('player1', requests[0])
        bar.update(game.state.player1, game.state.gameTick, new Set())
        game.tick()
        game.startCast('player1', requests[1])
        bar.update(game.state.player1, game.state.gameTick, new Set())
        for (let i = 0; i < game.state.player1.spells[1].castTime; i++) game.tick()
        bar.update(game.state.player1, game.state.gameTick, new Set())
        expect(release).toHaveBeenCalledExactlyOnceWith(1)
    })

    it('invalidates a cast identity even when cancellation and replacement fall between renders', () => {
        const { game, release, click, update, charge } = setup()
        click(0)
        update()
        game.tick()
        game.stopCast('player1', 0)
        game.startCast('player1', 0)
        charge()
        expect(release).not.toHaveBeenCalled()
    })

    it.each(['freeze', 'overlay', 'reconnect'] as const)('clears automatic release on %s', transition => {
        const { game, release, bar, click, update, charge } = setup()
        const Ctor = BattleView as unknown as new (
            container: unknown,
            options: unknown,
        ) => {
            actionBar: ActionBar
            overlay: { visible: boolean }
            update: BattleView['update']
            setFrozen: BattleView['setFrozen']
            setOverlay: BattleView['setOverlay']
            onKeyDown(event: unknown): void
        }
        const view = new Ctor(
            {},
            { me: 'player1', onRelease: release, onPress: (i: number) => game.startCast('player1', i) },
        )
        view.actionBar = bar
        view.overlay.visible = false
        click(0)
        update()
        if (transition === 'freeze') view.setFrozen(true)
        if (transition === 'overlay') view.setOverlay('Round over')
        if (transition === 'reconnect') view.update(game.snapshot(), [], [], false)
        game.tick()
        game.startCast('player1', 0)
        charge()
        expect(release).not.toHaveBeenCalled()
    })

    it('clears pending ownership through the real hotkey handler', () => {
        const { game, release, bar, click, update, charge } = setup()
        const Ctor = BattleView as unknown as new (
            container: unknown,
            options: unknown,
        ) => {
            actionBar: ActionBar
            overlay: { visible: boolean }
            update: BattleView['update']
            onKeyDown(event: unknown): void
        }
        const view = new Ctor({}, { me: 'player1', onPress: (i: number) => game.startCast('player1', i) })
        view.actionBar = bar
        view.overlay.visible = false
        view.update(game.snapshot(), [], [])
        click(0)
        update()
        game.tick()
        view.onKeyDown({ code: 'KeyQ', preventDefault: vi.fn() })
        charge()
        expect(release).not.toHaveBeenCalled()
    })

    it.each([
        ['player1', false],
        ['player1', true],
        [null, false],
    ] as const)('keeps deciding-tick input open only for a participant (%s, missing finished: %s)', (me, missing) => {
        const game = battle()
        const Ctor = BattleView as unknown as new (
            container: unknown,
            options: unknown,
        ) => {
            overlay: { visible: boolean }
            update: BattleView['update']
            setFrozen: BattleView['setFrozen']
            onKeyDown(event: unknown): void
        }
        game.state.player2.hp = 1
        game.startCast('player1', 0)
        game.startCast('player2', 0)
        for (let i = 0; i < game.state.player1.spells[0].castTime; i++) game.tick()
        game.stopCast('player1', 0)
        expect(game.state.winner).toBe('player1')
        expect(game.finished).toBe(false)
        const press = vi.fn((i: number) => game.startCast('player1', i))
        const view = new Ctor({}, { me, onPress: press })
        view.overlay.visible = false
        const snap = game.snapshot()
        if (missing) delete snap.finished
        view.update(snap, [], [], false)
        view.onKeyDown({ code: 'Space', preventDefault: vi.fn() })
        expect(press).toHaveBeenCalledTimes(me ? 1 : 0)
        if (me) expect(game.state.player2.cast).toBeNull()
        game.tick()
        expect(game.finished).toBe(true)
        view.update(game.snapshot(), [], [])
        view.onKeyDown({ code: 'KeyQ', preventDefault: vi.fn() })
        expect(press).toHaveBeenCalledTimes(me ? 1 : 0)
    })
})
