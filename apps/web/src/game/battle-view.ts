import { Application, Container, Graphics, Sprite, Text } from 'pixi.js'
import {
    GAME_TICK_INTERVAL,
    SPELLS,
    type SnapshotView,
    type HpEvent,
    type LogEntry,
    type PlayerKey,
    type PlayerState,
    type SpellId,
} from '@magus/engine'
import { ActionBar, INFINITE_HP, PlayerHud, setText } from './hud'
import { hotkeyFor, KEY_CODES } from './hotkeys'
import { battleLayout, GROUND_Y, HEIGHT, SIDE_X, sidesFor, TEXT_FONT, WIDTH, type Side } from './layout'
import { interruptTells, type InterruptTell } from './interrupt-tell'
import { backdropTexture, particleTexture } from './textures'
import { Vfx } from './vfx'
import { Wizard } from './wizard'

export interface BattleViewOptions {
    /** The local player's seat, or null for spectators (no input, no action bar). */
    me: PlayerKey | null
    onPress?: (spellIndex: number) => void | boolean
    onRelease?: (spellIndex: number) => void
}

const SIDES: Side[] = ['left', 'right']
const opposite = (side: Side): Side => (side === 'left' ? 'right' : 'left')

const SPELL_COLOR: Record<SpellId, number> = {
    SPELL_FIREBALL: 0xff8a1f,
    SPELL_IGNITE: 0xff5a1f,
    SPELL_COMBUSTION: 0xffb347,
    SPELL_AFTERBURN: 0xff9a3c,
    SPELL_LIVING_BOMB: 0xb15cff,
    SPELL_METEOR: 0xff7b29,
    SPELL_HASTE: 0xffe066,
    SPELL_COUNTERSPELL: 0x7ff3ff,
    SPELL_TEMPORAL_SHIELD: 0x8fd3ff,
    SPELL_MAGIC_EATER: 0x7dffb0,
    SPELL_BLUR: 0xc9b8ff,
}

/** How long the Counterspell projectile flies, so the interrupt lands with it. */
const COUNTERSPELL_FLIGHT = 0.18

const formatTime = (ticks: number) => {
    const seconds = Math.floor((ticks * GAME_TICK_INTERVAL) / 1000)
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

const formatAmount = (amount: number) => {
    const abs = Math.abs(amount)
    return `${amount < 0 ? '-' : '+'}${abs < 10 ? abs.toFixed(1) : abs.toFixed(0)}`
}

export class BattleView {
    private app!: Application
    private readonly world = new Container()
    private readonly vfx = new Vfx()
    private readonly wizards: Record<Side, Wizard> = { left: new Wizard('left'), right: new Wizard('right') }
    private readonly huds: Record<Side, PlayerHud>
    private readonly auras: Record<Side, Graphics> = { left: new Graphics(), right: new Graphics() }
    private readonly bombs: Record<Side, Sprite> = {
        left: new Sprite(particleTexture()),
        right: new Sprite(particleTexture()),
    }
    private readonly lastCast: Record<Side, Text> = { left: new Text(), right: new Text() }
    private readonly dots: Record<Side, number> = { left: 0, right: 0 }
    private readonly timer = new Text()
    private readonly score = new Text()
    private readonly overlay = new Container()
    private readonly overlayTitle = new Text()
    private readonly overlaySub = new Text()
    private actionBar: ActionBar | null = null
    private readonly sides: Record<Side, PlayerKey>
    private snap: SnapshotView | null = null
    private snapAt = 0
    private frozen = false
    private dotTimer = 0
    private time = 0
    private delayed: { at: number; run: () => void }[] = []
    private readonly keysDown = new Set<number>()
    private readonly handledKeyUps = new Set<string>()
    private resizeObserver: ResizeObserver | null = null
    private destroyed = false

    private constructor(
        private readonly container: HTMLElement,
        private readonly options: BattleViewOptions,
    ) {
        this.sides = sidesFor(options.me)
        this.huds = {
            left: new PlayerHud('left', this.sides.left, options.me),
            right: new PlayerHud('right', this.sides.right, options.me),
        }
    }

    static async create(container: HTMLElement, options: BattleViewOptions) {
        const view = new BattleView(container, options)
        await view.init()
        return view
    }

    private async init() {
        this.app = new Application()
        await this.app.init({
            width: WIDTH,
            height: HEIGHT,
            antialias: true,
            background: 0x0b0d1a,
            resolution: Math.min(2, window.devicePixelRatio || 1),
            autoDensity: true,
        })
        this.app.canvas.classList.add('battle-canvas')
        this.container.append(this.app.canvas)
        const stage = this.app.stage

        stage.addChild(new Sprite(backdropTexture()))
        stage.addChild(this.world)
        for (const side of SIDES) {
            const wizard = this.wizards[side]
            wizard.position.set(SIDE_X[side], GROUND_Y)
            const bomb = this.bombs[side]
            bomb.anchor.set(0.5)
            bomb.blendMode = 'add'
            bomb.tint = SPELL_COLOR.SPELL_LIVING_BOMB
            bomb.visible = false
            const text = this.lastCast[side]
            text.style = {
                fontFamily: TEXT_FONT,
                fontSize: 20,
                fontWeight: '800',
                fill: 0xffd43b,
                stroke: { color: 0x000000, width: 4 },
            }
            text.anchor.set(0.5)
            text.position.set(SIDE_X[side], GROUND_Y - 190)
            text.alpha = 0
            this.world.addChild(this.auras[side], wizard, bomb, text)
        }
        this.world.addChild(this.vfx)

        const top = new Graphics().rect(0, 0, WIDTH, 136).fill(0x130f20)
        stage.addChild(top, this.huds.left, this.huds.right)
        for (const [text, size, y] of [
            [this.timer, 15, 8],
            [this.score, 24, 26],
        ] as const) {
            text.style = {
                fontFamily: TEXT_FONT,
                fontSize: size,
                fontWeight: '800',
                fill: 0xffffff,
                stroke: { color: 0x000000, width: 3 },
            }
            text.anchor.set(0.5, 0)
            text.position.set(WIDTH / 2, y)
            stage.addChild(text)
        }
        // score sits between the hp bars
        this.score.position.y = battleLayout(WIDTH, HEIGHT).score.y
        this.timer.position.y = battleLayout(WIDTH, HEIGHT).timer.y

        if (this.options.me) {
            this.actionBar = new ActionBar(
                i => {
                    if (!this.combatActive()) return false
                    return this.options.onPress?.(i)
                },
                i => this.options.onRelease?.(i),
            )
            stage.addChild(this.actionBar)
            window.addEventListener('keydown', this.onKeyDown)
            window.addEventListener('keyup', this.onKeyUp)
            window.addEventListener('blur', this.releaseAll)
        }

        const dim = new Graphics()
            .rect(0, 136, WIDTH, (this.options.me ? battleLayout(WIDTH, HEIGHT).bar.y : HEIGHT) - 136)
            .fill({ color: 0x000000, alpha: 0.45 })
        this.overlayTitle.style = {
            fontFamily: TEXT_FONT,
            fontSize: 44,
            fontWeight: '900',
            fill: 0xffffff,
            stroke: { color: 0x000000, width: 6 },
        }
        this.overlaySub.style = {
            fontFamily: TEXT_FONT,
            fontSize: 20,
            fontWeight: '700',
            fill: 0xe9e3ff,
            stroke: { color: 0x000000, width: 4 },
        }
        this.overlayTitle.anchor.set(0.5)
        this.overlaySub.anchor.set(0.5)
        this.overlayTitle.position.set(WIDTH / 2, 280)
        this.overlaySub.position.set(WIDTH / 2, 330)
        this.overlay.addChild(dim, this.overlayTitle, this.overlaySub)
        this.overlay.visible = false
        stage.addChild(this.overlay)

        this.app.ticker.add(ticker => this.frame(ticker.deltaMS / 1000))
        this.resizeObserver = new ResizeObserver(() => this.fit())
        this.resizeObserver.observe(this.container)
        this.fit()
    }

    /** Feed a new authoritative state. `fresh` is false for catch-up state, which skips effects. */
    update(snap: SnapshotView, newLog: LogEntry[], events: HpEvent[], fresh = true) {
        if (!fresh) this.actionBar?.clearAccessibleCast()
        this.snap = snap
        this.snapAt = performance.now()
        const mine = this.options.me ? snap[this.options.me] : null
        if (mine?.spells)
            this.actionBar?.update(
                mine as PlayerState,
                snap.gameTick,
                this.keysDown,
                snap.gameTick,
                this.combatActive() && fresh,
            )
        if (!fresh) return
        for (const entry of newLog) if (entry.type === 'SPELL_RELEASE') this.onSpellRelease(entry.caster, entry.spellId)
        for (const tell of interruptTells(newLog, this.sides)) this.onInterrupt(tell)
        for (const event of events) this.onHpEvent(event)
    }

    /** Stops cast bars and cooldowns from advancing between snapshots (countdowns, pauses). */
    setFrozen(frozen: boolean) {
        if (frozen) {
            this.actionBar?.clearAccessibleCast()
            this.releaseAll()
        }
        this.frozen = frozen
    }

    setOverlay(title: string | null, sub = '') {
        if (title !== null) {
            this.actionBar?.clearAccessibleCast()
            this.releaseAll()
        }
        this.overlay.visible = title !== null
        setText(this.overlayTitle, title ?? '')
        setText(this.overlaySub, sub)
    }

    setScore(score: Record<PlayerKey, number> | null) {
        setText(this.score, score ? `${score[this.sides.left]}  –  ${score[this.sides.right]}` : '')
    }

    destroy() {
        if (this.destroyed) return
        this.destroyed = true
        this.actionBar?.clearAccessibleCast()
        this.releaseAll()
        window.removeEventListener('keydown', this.onKeyDown)
        window.removeEventListener('keyup', this.onKeyUp)
        window.removeEventListener('blur', this.releaseAll)
        this.resizeObserver?.disconnect()
        this.app?.destroy(true, { children: true })
    }

    // rendering

    private fit() {
        if (this.destroyed) return
        const { clientWidth, clientHeight } = this.container
        if (!clientWidth || !clientHeight) return
        const scale = Math.min(clientWidth / WIDTH, clientHeight / HEIGHT)
        this.app.renderer.resize(Math.floor(WIDTH * scale), Math.floor(HEIGHT * scale))
        this.app.stage.scale.set(scale)
    }

    private displayTick(snap: SnapshotView) {
        if (this.frozen || snap.winner) return snap.gameTick
        const ahead = (performance.now() - this.snapAt) / GAME_TICK_INTERVAL
        return snap.gameTick + Math.min(1, Math.max(0, ahead))
    }

    private frame(dt: number) {
        dt = Math.min(dt, 0.1)
        this.time += dt
        const due = this.delayed.filter(d => d.at <= this.time)
        this.delayed = this.delayed.filter(d => d.at > this.time)
        for (const d of due) d.run()

        const snap = this.snap
        if (snap) {
            const tick = this.displayTick(snap)
            for (const side of SIDES) {
                const key = this.sides[side]
                const player = snap[key]
                this.huds[side].update(player, tick, dt)
                const wizard = this.wizards[side]
                wizard.pose =
                    snap.winner && snap.winner !== 'draw'
                        ? snap.winner === key
                            ? 'win'
                            : 'lose'
                        : snap.winner === 'draw'
                          ? 'lose'
                          : player.cast !== null
                            ? 'casting'
                            : 'idle'
                const casting = player.cast === null ? null : (player.casting ?? player.spells?.[player.cast])
                if (casting) wizard.orbColor = SPELL_COLOR[casting.id]
                this.persistentEffects(side, player, tick, dt)
            }
            setText(this.timer, formatTime(snap.gameTick))
            const mine = this.options.me && snap[this.options.me]
            // a player always has their own loadout
            if (this.actionBar && mine?.spells)
                this.actionBar.update(mine as PlayerState, tick, this.keysDown, snap.gameTick, this.combatActive())
        }

        for (const side of SIDES) {
            this.wizards[side].update(dt)
            const text = this.lastCast[side]
            text.alpha = Math.max(0, text.alpha - dt * 0.6)
        }

        this.dotTimer += dt
        if (this.dotTimer >= 1) {
            this.dotTimer = 0
            for (const side of SIDES) {
                if (Math.abs(this.dots[side]) >= 0.05) {
                    this.vfx.floatText(
                        this.wizards[side].headPoint,
                        formatAmount(this.dots[side]),
                        this.dots[side] < 0 ? 0xff8f6b : 0x8ce99a,
                        16,
                    )
                }
                this.dots[side] = 0
            }
        }

        this.vfx.update(dt)
        // Split Console keeps the arena stationary, including on heavy hits.
        this.world.position.set(0, 0)
    }

    private persistentEffects(side: Side, player: SnapshotView['player1'], tick: number, dt: number) {
        const wizard = this.wizards[side]
        const aura = this.auras[side].clear()
        const has = (id: string) => player.effects.filter(e => e.id === id)
        const chest = wizard.chestPoint
        wizard.blurred = has('BUFF_BLUR').length > 0

        const ignites = has('DEBUFF_IGNITE').length
        if (ignites && Math.random() < dt * 18 * ignites) {
            this.vfx.spray(
                { x: chest.x + (Math.random() - 0.5) * 40, y: GROUND_Y - 10 - Math.random() * 60 },
                0xff6a1f,
                {
                    count: 1,
                    speed: 40,
                    size: 0.7,
                    life: 0.7,
                    gravity: -160,
                    angle: -Math.PI / 2,
                    spread: 0.6,
                },
            )
        }

        const bomb = has('DEBUFF_LIVING_BOMB')[0]
        const bombSprite = this.bombs[side]
        bombSprite.visible = !!bomb
        if (bomb) {
            const left = Math.max(0, bomb.startingTick + bomb.duration - tick) / bomb.duration
            const rate = 3 + (1 - left) * 14
            bombSprite.position.set(wizard.headPoint.x, wizard.headPoint.y + 6)
            bombSprite.scale.set(1 + Math.sin(this.time * rate) * 0.25 + (1 - left) * 0.4)
        }

        if (has('BUFF_HASTE').length && Math.random() < dt * 14) {
            this.vfx.spray({ x: chest.x + (Math.random() - 0.5) * 60, y: chest.y + 40 }, 0xffe066, {
                count: 1,
                speed: 120,
                size: 0.35,
                life: 0.5,
                angle: -Math.PI / 2,
                spread: 0.2,
            })
        }

        if (has('BUFF_TEMPORAL_SHIELD').length) {
            for (let i = 0; i < 3; i++) {
                const r = 58 + i * 8
                const start = this.time * (2 + i) + i
                aura.arc(chest.x, chest.y, r, start, start + Math.PI * 1.2).stroke({
                    width: 3,
                    color: 0x8fd3ff,
                    alpha: 0.7 - i * 0.18,
                })
            }
        }

        if (has('BUFF_MAGIC_EATER').length) {
            for (let i = 0; i < 6; i++) {
                const a = this.time * 3 + (i / 6) * Math.PI * 2
                aura.circle(chest.x + Math.cos(a) * 46, chest.y + Math.sin(a) * 22, 4).fill({
                    color: 0x7dffb0,
                    alpha: 0.8,
                })
            }
        }

        if (has('DEBUFF_COUNTERSPELL').length) {
            const { x, y } = wizard.headPoint
            aura.circle(x, y - 4, 15).stroke({ width: 4, color: 0x7ff3ff })
            aura.moveTo(x - 10, y + 6)
                .lineTo(x + 10, y - 14)
                .stroke({ width: 4, color: 0x7ff3ff })
        }
    }

    private onSpellRelease(caster: PlayerKey, spellId: SpellId) {
        const casterSide: Side = this.sides.left === caster ? 'left' : 'right'
        const targetSide = opposite(casterSide)
        const from = this.wizards[casterSide].castPoint
        const to = this.wizards[targetSide].chestPoint
        const self = this.wizards[casterSide].chestPoint
        const color = SPELL_COLOR[spellId]

        const text = this.lastCast[casterSide]
        setText(text, `${SPELLS[spellId].label}!`)
        text.alpha = 1.4

        switch (spellId) {
            case 'SPELL_FIREBALL':
                this.vfx.projectile(from, to, color, { size: 1.5 })
                break
            case 'SPELL_IGNITE':
                this.vfx.projectile(from, to, color, {
                    size: 0.9,
                    onHit: () => this.vfx.spray(to, color, { count: 18, speed: 90, gravity: -200, life: 0.7 }),
                })
                break
            case 'SPELL_COMBUSTION':
                this.vfx.burst(to, color, 1.7)
                this.vfx.shake = 7
                break
            case 'SPELL_AFTERBURN':
                for (let i = 0; i < 3; i++) {
                    this.delayed.push({
                        at: this.time + i * 0.08,
                        run: () => this.vfx.projectile(from, to, color, { size: 0.8, arc: 20 + i * 15 }),
                    })
                }
                break
            case 'SPELL_LIVING_BOMB':
                this.vfx.projectile(from, to, color, { size: 1.1, arc: 60 })
                break
            case 'SPELL_METEOR': {
                const sky = { x: to.x + (targetSide === 'right' ? -220 : 220), y: -60 }
                const ground = { x: to.x, y: GROUND_Y - 10 }
                this.vfx.projectile(sky, ground, color, {
                    duration: 0.45,
                    arc: 0,
                    size: 2.6,
                    trail: 0xff5a1f,
                    onHit: () => {
                        this.vfx.burst(ground, color, 2.4)
                        this.vfx.spray(ground, 0x6b4a3a, {
                            count: 20,
                            speed: 260,
                            gravity: 600,
                            life: 0.8,
                            angle: -Math.PI / 2,
                            spread: 2,
                        })
                        this.vfx.shake = 14
                    },
                })
                break
            }
            case 'SPELL_HASTE':
                this.vfx.ring(self, color, 70, 0.45)
                this.vfx.spray(self, color, { count: 24, speed: 160, size: 0.5, life: 0.5 })
                break
            case 'SPELL_COUNTERSPELL':
                this.vfx.projectile(from, to, color, {
                    duration: COUNTERSPELL_FLIGHT,
                    arc: 8,
                    size: 0.9,
                    onHit: () => this.vfx.ring(to, color, 60, 0.4, 6),
                })
                break
            case 'SPELL_TEMPORAL_SHIELD':
            case 'SPELL_MAGIC_EATER':
            case 'SPELL_BLUR':
                this.vfx.ring(self, color, 80, 0.5)
                this.vfx.spray(self, color, { count: 16, speed: 70, size: 0.5, life: 0.6 })
                break
        }
    }

    private onInterrupt({ interruptedSide, casterSide, spell, source }: InterruptTell) {
        const color = SPELL_COLOR[source]
        const interrupted = this.wizards[interruptedSide]
        const caster = this.wizards[casterSide]

        // the cast bar is already gone from the snapshot, so its flash can't wait for the projectile
        this.huds[interruptedSide].showInterrupted(spell, color)
        this.delayed.push({
            at: this.time + COUNTERSPELL_FLIGHT,
            run: () => {
                // the charge on the staff breaks apart in the interrupted spell's own color
                this.vfx.spray(interrupted.castPoint, SPELL_COLOR[spell], {
                    count: 24,
                    speed: 200,
                    size: 0.7,
                    life: 0.5,
                })
                this.vfx.burst(interrupted.chestPoint, color, 1.3)
                this.vfx.shake = 6
            },
        })

        const head = caster.headPoint
        // starts lower than other float text, to stay clear of the "Counter Spell!" label above the head
        this.vfx.floatText({ x: head.x, y: head.y + 14 }, 'Interrupted!', color, 26)
        this.vfx.ring(caster.chestPoint, color, 90, 0.5, 5)
        this.vfx.spray(caster.chestPoint, color, { count: 16, speed: 130, size: 0.5, life: 0.5 })
    }

    private onHpEvent(event: HpEvent) {
        const side: Side = this.sides.left === event.player ? 'left' : 'right'
        const wizard = this.wizards[side]
        const big = event.kind === 'spell' || Math.abs(event.amount) >= 3
        if (!big) {
            this.dots[side] += event.amount
            return
        }
        const damage = event.amount < 0
        this.vfx.floatText(wizard.headPoint, formatAmount(event.amount), damage ? 0xff6b6b : 0x8ce99a, damage ? 26 : 22)
        if (event.source === 'SPELL_LIVING_BOMB' && event.kind === 'effect') {
            this.vfx.burst(wizard.chestPoint, SPELL_COLOR.SPELL_LIVING_BOMB, 2)
            this.vfx.shake = 10
        }
        if (event.source === 'SPELL_TEMPORAL_SHIELD')
            this.vfx.ring(wizard.chestPoint, SPELL_COLOR.SPELL_TEMPORAL_SHIELD, 90, 0.6, 6)
    }

    // input

    private combatActive() {
        return !!this.options.me && !!this.snap && !this.frozen && !this.overlay.visible
    }

    private onKeyDown = (event: KeyboardEvent) => {
        if (!this.combatActive()) return
        const index = hotkeyFor({
            code: event.code,
            target: event.target,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            altKey: event.altKey,
            repeat: false,
        })
        if (index === undefined) return
        event.preventDefault()
        if (event.repeat || this.keysDown.has(index)) return
        this.handledKeyUps.add(event.code)
        this.keysDown.add(index)
        this.actionBar?.manualPress(index)
        this.options.onPress?.(index)
    }

    private onKeyUp = (event: KeyboardEvent) => {
        const index = KEY_CODES[event.code]
        if (this.handledKeyUps.delete(event.code)) event.preventDefault()
        if (index === undefined || !this.keysDown.delete(index)) return
        // Firefox clicks the focused button when Space is released; a cast hotkey must not do that
        event.preventDefault()
        this.options.onRelease?.(index)
    }

    private releaseAll = () => {
        for (const index of this.keysDown) this.options.onRelease?.(index)
        this.keysDown.clear()
        if (this.actionBar) {
            for (const index of this.actionBar.pressed) this.options.onRelease?.(index)
            this.actionBar.pressed.clear()
        }
    }
}

export { INFINITE_HP }
