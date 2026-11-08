import 'pixi.js/accessibility'
import { Container, Graphics, Sprite, Text } from 'pixi.js'
import {
    cooldownRemaining,
    HOTKEYS,
    SPELLS,
    ticksToSeconds,
    secondsToTicks,
    type PlayerKey,
    type PlayerState,
    type PlayerView,
    type SpellId,
} from '@magus/engine'
import { buttonState, type ButtonState } from './button-state'
import { battleLayout, BATTLE_BAR, battleButtonX, HEIGHT, TEXT_FONT, WIDTH, type Side } from './layout'
import { keybindsVisible } from './hotkeys'
import { iconTexture } from './textures'

export const INFINITE_HP = 1e8

const label = (size: number, weight = '700', fill = 0xffffff) =>
    new Text({
        text: '',
        style: {
            fontFamily: TEXT_FONT,
            fontSize: size,
            fontWeight: weight as '700',
            fill,
            stroke: { color: 0x000000, width: 3 },
        },
    })

export const setText = (text: Text, value: string) => {
    if (text.text !== value) text.text = value
}

/** How long the cast bar flashes after an interrupt, in seconds. */
const INTERRUPT_FLASH = 0.9

const hpColor = (hp: number) => (hp > 65 ? 0x2fb344 : hp > 30 ? 0xf08c00 : 0xe03131)

/** HP bar, cast bar and effect icons for one side. */
export class PlayerHud extends Container {
    private readonly bars = new Graphics()
    private readonly nameText = label(18, '800')
    private readonly hpText = label(12)
    private readonly castText = label(13)
    private readonly lockText = label(13)
    private readonly castIcon = new Sprite()
    private readonly effectIcons = new Container()
    private effectKey = ''
    private shownHp = 100
    private interrupt: { spell: SpellId; color: number; left: number } | null = null
    private readonly x0: number
    private readonly w = battleLayout(WIDTH, HEIGHT).left.hp.width

    private readonly motionQuery = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')
    private reducedMotion = this.motionQuery?.matches ?? false
    private readonly onMotionChange = (event: MediaQueryListEvent) => {
        this.reducedMotion = event.matches
    }

    constructor(
        private readonly side: Side,
        private readonly seat: PlayerKey = side === 'left' ? 'player1' : 'player2',
        private readonly me: PlayerKey | null = null,
    ) {
        super()
        this.motionQuery?.addEventListener('change', this.onMotionChange)
        this.on('destroyed', () => this.motionQuery?.removeEventListener('change', this.onMotionChange))
        this.x0 = battleLayout(WIDTH, HEIGHT)[side].hp.x
        this.nameText.position.set(this.x0, 12)
        this.nameText.style.fontSize = 12
        this.nameText.style.wordWrap = false
        this.nameText.style.fill = 0xe9e3ff
        this.nameText.anchor.set(0, 0)
        this.hpText.anchor.set(1, 0)
        this.hpText.position.set(this.x0 + this.w, 12)
        this.castText.anchor.set(0.5)
        this.castText.position.set(this.x0 + this.w / 2 + 14, 89)
        this.castIcon.width = this.castIcon.height = 22
        this.castIcon.position.set(side === 'left' ? this.x0 + 1 : this.x0 + this.w - 23, 78)
        this.lockText.anchor.set(0.5)
        this.lockText.position.set(this.x0 + this.w / 2, 162)
        this.effectIcons.position.set(this.x0, 110)
        this.addChild(
            this.bars,
            this.nameText,
            this.hpText,
            this.castIcon,
            this.castText,
            this.effectIcons,
            this.lockText,
        )
    }

    /** Flashes the cast bar with the spell that was interrupted. */
    showInterrupted(spell: SpellId, color: number) {
        this.interrupt = { spell, color, left: INTERRUPT_FLASH }
    }

    update(player: PlayerView, tick: number, dt: number) {
        const name = player.name.slice(0, 12) || (this.seat === 'player1' ? 'Player 1' : 'Player 2')
        setText(this.nameText, this.me ? `${this.seat === this.me ? 'YOU' : 'OPPONENT'} · ${name}` : name)
        const infinite = player.hp >= INFINITE_HP
        const hp = infinite ? 100 : player.hp
        this.shownHp += (hp - this.shownHp) * (this.reducedMotion ? 1 : Math.min(1, dt / 0.12))
        const { x0, w } = this
        const fill = Math.max(0, Math.min(1, this.shownHp / 100)) * (w - 4)
        const g = this.bars.clear()
        g.roundRect(x0, 40, w, 24, 6).fill({ color: 0x000000, alpha: 0.65 })
        g.roundRect(this.side === 'left' ? x0 + 2 : x0 + w - 2 - fill, 42, fill, 20, 5).fill(hpColor(this.shownHp))
        g.roundRect(this.side === 'left' ? x0 + 2 : x0 + w - 2 - fill, 42, fill, 9, 4).fill({
            color: 0xffffff,
            alpha: 0.15,
        })
        setText(this.hpText, infinite ? '∞' : `${formatHp(player.hp)} / 100 HP`)

        g.roundRect(x0, 76, w, 26, 5).fill({ color: 0x000000, alpha: 0.55 })
        // the opponent's loadout isn't sent, so their spell comes as `casting`
        const spell = player.cast === null ? null : (player.casting ?? player.spells?.[player.cast])
        if (spell && player.castStartingTick !== null) {
            this.interrupt = null
            const elapsed = Math.max(0, tick - player.castStartingTick)
            const done = elapsed >= spell.castTime
            const progress = spell.castTime ? Math.min(1, elapsed / spell.castTime) : 1
            const barW = (w - 28) * progress
            const barX = this.side === 'left' ? x0 + 26 : x0 + w - 26 - barW
            g.roundRect(barX, 78, barW, 22, 4).fill(done ? 0x2fb344 : 0x4c6ef5)
            this.showCastLabel(spell.id, 1)
            setText(this.castText, `${SPELLS[spell.id].label} · ${Math.round(progress * 100)}%`)
        } else if (this.interrupt && this.interrupt.left > dt) {
            this.drawInterrupt(this.interrupt, dt)
        } else {
            this.interrupt = null
            this.castIcon.visible = false
            this.castText.visible = false
        }

        const lock = Math.max(0, player.lockedUntil - tick)
        setText(this.lockText, lock > 0 ? `LOCKED ${ticksToSeconds(lock).toFixed(1)}s` : '')
        this.updateEffects(player, tick)
    }

    private showCastLabel(spell: SpellId, alpha: number) {
        this.castIcon.texture = iconTexture(spell)
        this.castIcon.width = this.castIcon.height = 22
        this.castIcon.visible = true
        this.castIcon.alpha = alpha
        this.castText.visible = true
        this.castText.alpha = alpha
    }

    /** A full-width flash with an outline that grows as it fades. There is no cast progress to show. */
    private drawInterrupt(interrupt: NonNullable<PlayerHud['interrupt']>, dt: number) {
        interrupt.left -= dt
        const k = interrupt.left / INTERRUPT_FLASH
        const grow = (1 - k) * 6
        const { x0, w } = this
        this.bars
            .roundRect(x0 + 2, 78, w - 4, 22, 4)
            .fill({ color: interrupt.color, alpha: k * 0.8 })
            .roundRect(x0 - grow, 76 - grow, w + grow * 2, 26 + grow * 2, 5 + grow)
            .stroke({ width: 2, color: interrupt.color, alpha: k })
        // A visible break distinguishes a confirmed interrupt from an ordinary cast fill.
        this.bars.rect(x0 + w / 2 - 8, 78, 16, 22).fill(0x130f20)
        this.bars
            .moveTo(x0 + w / 2 - 5, 84)
            .lineTo(x0 + w / 2 + 5, 94)
            .moveTo(x0 + w / 2 + 5, 84)
            .lineTo(x0 + w / 2 - 5, 94)
            .stroke({ width: 2, color: 0xffffff })
        this.showCastLabel(interrupt.spell, Math.min(1, k * 2))
        setText(this.castText, `${SPELLS[interrupt.spell].label} interrupted!`)
    }

    private updateEffects(player: PlayerView, tick: number) {
        const key = player.effects.map(e => e.id + e.startingTick).join()
        if (key !== this.effectKey) {
            this.effectKey = key
            this.effectIcons.removeChildren().forEach(child => child.destroy())
            const shown = [...player.effects].reverse()
            shown.forEach((effect, i) => {
                const slot = new Container()
                const x = this.side === 'left' ? i * 38 : this.w - 32 - i * 38
                slot.position.set(x, 0)
                const border = new Graphics()
                    .roundRect(-1, -1, 34, 34, 6)
                    .fill(effect.type === 'negative' ? 0xe03131 : 0x51cf66)
                const icon = new Sprite(iconTexture(effect.source))
                icon.width = icon.height = 32
                const time = label(12)
                time.anchor.set(0.5, 0)
                time.position.set(16, 34)
                time.label = 'time'
                slot.addChild(border, icon, time)
                this.effectIcons.addChild(slot)
            })
        }
        const shown = [...player.effects].reverse()
        this.effectIcons.children.forEach((slot, i) => {
            const effect = shown[i]
            const time = slot.getChildByLabel('time') as Text
            setText(time, ticksToSeconds(Math.max(0, effect.startingTick + effect.duration - tick)).toFixed(1))
        })
    }
}

const BUTTON = BATTLE_BAR.button

/** The seven spell buttons. Pointer input is reported through the callbacks. */
export class ActionBar extends Container {
    private readonly buttons: {
        root: Container
        icon: Sprite
        overlay: Graphics
        frame: Graphics
        center: Text
        key: Text
        name: Text
        spellId: string
    }[] = []
    pressed = new Set<number>()
    private accessibleCast: { index: number; startingTick: number } | null = null
    // Ten 50 ms ticks allow a 0.5 s lobby round trip without claiming later casts.
    private readonly accessibleRequests = new Map<number, number>()
    private requestTick = 0

    manualPress(index: number) {
        this.accessibleRequests.delete(index)
    }

    clearAccessibleCast() {
        this.accessibleCast = null
        this.accessibleRequests.clear()
    }

    /** A recreated view has no live input owner for the server's surviving cast. */
    recoverCast(player: PlayerState) {
        this.clearAccessibleCast()
        if (player.cast !== null && player.castStartingTick !== null)
            this.accessibleCast = { index: player.cast, startingTick: player.castStartingTick }
    }

    constructor(
        onPress: (i: number) => void | boolean,
        private readonly onRelease: (i: number) => void,
    ) {
        super()
        const r = battleLayout(WIDTH, HEIGHT).bar
        const panel = new Graphics()
            .roundRect(r.x, r.y, r.width, r.height, 16)
            .fill(0x130f20)
            .stroke({ width: 1, color: 0x756585 })
        this.addChild(panel)
        for (let i = 0; i < HOTKEYS.length; i++) {
            const root = new Container()
            root.pivot.set(BUTTON / 2, BUTTON / 2)
            root.position.set(battleButtonX(i) + BUTTON / 2, BATTLE_BAR.top + BUTTON / 2)
            root.eventMode = 'static'
            root.cursor = 'pointer'
            root.accessible = true
            root.accessibleType = 'button'
            root.tabIndex = 0
            const icon = new Sprite()
            const overlay = new Graphics()
            const frame = new Graphics()
            const center = label(20, '800', 0xfff3a0)
            center.anchor.set(0.5)
            center.position.set(BUTTON / 2, BUTTON / 2)
            const key = label(12, '800', 0xffffff)
            key.anchor.set(1, 1)
            key.position.set(BUTTON - 6, BUTTON - 3)
            key.text = HOTKEYS[i]
            key.visible = keybindsVisible()
            const name = label(10, '600', 0xdddddd)
            name.style.wordWrap = false
            name.style.wordWrapWidth = BUTTON + BATTLE_BAR.gap - 2
            name.style.align = 'center'
            name.style.lineHeight = 12
            name.anchor.set(0.5, 0)
            name.position.set(BUTTON / 2, BUTTON + 2)
            // the cooldown sweep is drawn oversized and clipped with the icon
            const mask = new Graphics().roundRect(0, 0, BUTTON, BUTTON, 14).fill(0xffffff)
            const clip = new Container()
            clip.addChild(icon, overlay)
            clip.mask = mask
            root.addChild(mask, clip, frame, center, key, name)
            // Manual input does not own automatic release. Only accepted cast state
            // can invalidate the existing accessible binding.
            root.on('pointerdown', () => {
                if (this.pressed.has(i)) return
                this.pressed.add(i)
                this.manualPress(i)
                onPress(i)
            })
            const release = () => {
                if (!this.pressed.delete(i)) return
                onRelease(i)
            }
            root.on('pointerup', release)
            root.on('pointerupoutside', release)
            root.on('click', event => {
                // Pixi's pointer click already went through down/up. Accessibility clicks
                // have no pointer type and need their own activation.
                if (event?.pointerType) return
                this.accessibleRequests.set(i, this.requestTick)
                if (onPress(i) === false) this.accessibleRequests.delete(i)
            })
            this.addChild(root)
            this.buttons.push({ root, icon, overlay, frame, center, key, name, spellId: '' })
        }
    }

    update(player: PlayerState, tick: number, keysDown: Set<number>, confirmedTick = Math.floor(tick), active = true) {
        // Requests, expiry and release use engine time; interpolation is visual only.
        this.requestTick = confirmedTick
        // Bind requests to the cast the engine actually accepted, never the last clicked slot.
        if (
            active &&
            player.cast !== null &&
            player.castStartingTick !== null &&
            this.accessibleRequests.has(player.cast) &&
            player.castStartingTick >= this.accessibleRequests.get(player.cast)! &&
            player.castStartingTick <= this.accessibleRequests.get(player.cast)! + secondsToTicks(0.5)
        ) {
            this.accessibleCast = { index: player.cast, startingTick: player.castStartingTick }
            // Other requests may still be in flight to the authoritative server.
            this.accessibleRequests.delete(player.cast)
        }
        for (const [index, requestedTick] of this.accessibleRequests) {
            if (confirmedTick > requestedTick + secondsToTicks(0.5)) this.accessibleRequests.delete(index)
        }
        const pending = this.accessibleCast
        if (pending) {
            if (player.cast !== pending.index || player.castStartingTick !== pending.startingTick) {
                this.accessibleCast = null
            } else if (active && confirmedTick >= pending.startingTick + player.spells[pending.index].castTime) {
                this.accessibleCast = null
                this.onRelease(pending.index)
            }
        }
        player.spells.forEach((spell, i) => {
            const b = this.buttons[i]
            if (b.spellId !== spell.id) {
                b.spellId = spell.id
                b.icon.texture = iconTexture(spell.id)
                b.icon.width = b.icon.height = BUTTON
                setText(b.name, SPELLS[spell.id].label)
            }
            const state = buttonState(player, spell, tick)
            const cooldown = cooldownRemaining(spell, tick)
            b.root.accessibleTitle = `${SPELLS[spell.id].label}, ${HOTKEYS[i]}`
            const reason = state.locked
                ? `Locked, ${ticksToSeconds(state.timer).toFixed(1)} seconds. Personal cooldown ${ticksToSeconds(cooldown).toFixed(1)} seconds.`
                : cooldown > 0
                  ? `Cooldown, ${ticksToSeconds(cooldown).toFixed(1)} seconds.`
                  : state.fader > 0
                    ? 'Global cooldown.'
                    : 'Ready.'
            b.root.accessibleHint = `${b.root.accessibleTitle}. ${reason}`
            this.drawButton(b, state, player.cast === i, keysDown.has(i) || this.pressed.has(i))
        })
    }

    private drawButton(
        b: ActionBar['buttons'][number],
        { fader, locked, timer }: ButtonState,
        casting: boolean,
        down: boolean,
    ) {
        const o = b.overlay.clear()
        if (fader > 0) {
            const c = BUTTON / 2
            o.moveTo(c, c)
                .arc(c, c, BUTTON, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * fader)
                .lineTo(c, c)
                .fill({ color: 0x000000, alpha: 0.62 })
        }
        if (timer > 0 && !locked) {
            o.roundRect(0, 0, BUTTON, BUTTON, 14).fill({ color: 0x130f20, alpha: 0.5 })
            for (let x = -BUTTON; x < BUTTON * 2; x += 10)
                o.moveTo(x, 0)
                    .lineTo(x + BUTTON, BUTTON)
                    .stroke({ width: 2, color: 0xffffff, alpha: 0.22 })
        }
        if (locked) o.roundRect(0, 0, BUTTON, BUTTON, 14).fill({ color: 0x0c8599, alpha: 0.35 })
        setText(b.center, timer > 0 ? `${locked ? '🔒 ' : ''}${ticksToSeconds(timer).toFixed(1)}s` : '')
        b.frame
            .clear()
            .roundRect(0, 0, BUTTON, BUTTON, 14)
            .stroke({
                width: casting ? 4 : 2,
                color: casting ? 0xffd43b : 0xffffff,
                alpha: casting || b.spellId === 'SPELL_COUNTERSPELL' ? 1 : 0.55,
            })
        b.root.scale.set(down ? 0.94 : 1)
    }
}

/**
 * One decimal, rounded up so a living player never reads 0.0. Goes through integer hundredths
 * (engine HP is on a 0.01 grid) so float noise like 86.7 * 10 = 867.0000000000001 cannot bump it.
 */
export const formatHp = (hp: number) => (Math.ceil(Math.round(Math.max(0, hp) * 100) / 10) / 10).toFixed(1)
