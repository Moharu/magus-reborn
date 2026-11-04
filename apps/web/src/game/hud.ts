import { Container, Graphics, Sprite, Text } from 'pixi.js'
import { cooldownRemaining, HOTKEYS, SPELLS, ticksToSeconds, type PlayerState, type SpellState } from '@magus/engine'
import { TEXT_FONT, WIDTH, type Side } from './layout'
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

const hpColor = (hp: number) => (hp > 65 ? 0x2fb344 : hp > 30 ? 0xf08c00 : 0xe03131)

/** HP bar, cast bar and effect icons for one side. */
export class PlayerHud extends Container {
    private readonly bars = new Graphics()
    private readonly nameText = label(18, '800')
    private readonly hpText = label(15)
    private readonly castText = label(13)
    private readonly castIcon = new Sprite()
    private readonly effectIcons = new Container()
    private effectKey = ''
    private shownHp = 100
    private readonly x0: number
    private readonly w = 430

    constructor(private readonly side: Side) {
        super()
        this.x0 = side === 'left' ? 20 : WIDTH - 20 - this.w
        this.nameText.position.set(side === 'left' ? this.x0 : this.x0 + this.w, 8)
        this.nameText.anchor.set(side === 'left' ? 0 : 1, 0)
        this.hpText.anchor.set(0.5)
        this.hpText.position.set(this.x0 + this.w / 2, 55)
        this.castText.anchor.set(0.5)
        this.castText.position.set(this.x0 + this.w / 2 + 14, 89)
        this.castIcon.width = this.castIcon.height = 22
        this.castIcon.position.set(side === 'left' ? this.x0 + 1 : this.x0 + this.w - 23, 78)
        this.effectIcons.position.set(this.x0, 110)
        this.addChild(this.bars, this.nameText, this.hpText, this.castIcon, this.castText, this.effectIcons)
    }

    update(player: PlayerState, tick: number, dt: number) {
        setText(this.nameText, player.name)
        const infinite = player.hp >= INFINITE_HP
        const hp = infinite ? 100 : player.hp
        this.shownHp += (hp - this.shownHp) * Math.min(1, dt * 14)
        const { x0, w } = this
        const fill = Math.max(0, Math.min(1, this.shownHp / 100)) * (w - 4)
        const g = this.bars.clear()
        g.roundRect(x0, 40, w, 30, 6).fill({ color: 0x000000, alpha: 0.65 })
        g.roundRect(this.side === 'left' ? x0 + 2 : x0 + w - 2 - fill, 42, fill, 26, 5).fill(hpColor(this.shownHp))
        g.roundRect(this.side === 'left' ? x0 + 2 : x0 + w - 2 - fill, 42, fill, 9, 4).fill({
            color: 0xffffff,
            alpha: 0.15,
        })
        setText(this.hpText, infinite ? '∞' : `${Math.max(0, player.hp).toFixed(2)} %`)

        g.roundRect(x0, 76, w, 26, 5).fill({ color: 0x000000, alpha: 0.55 })
        if (player.cast !== null && player.castStartingTick !== null) {
            const spell = player.spells[player.cast]
            const elapsed = Math.max(0, tick - player.castStartingTick)
            const done = elapsed >= spell.castTime
            const progress = spell.castTime ? Math.min(1, elapsed / spell.castTime) : 1
            const barW = (w - 28) * progress
            const barX = this.side === 'left' ? x0 + 26 : x0 + w - 26 - barW
            g.roundRect(barX, 78, barW, 22, 4).fill(done ? 0x2fb344 : 0x4c6ef5)
            this.castIcon.texture = iconTexture(spell.id)
            this.castIcon.width = this.castIcon.height = 22
            this.castIcon.visible = true
            const total = ticksToSeconds(spell.castTime)
            setText(
                this.castText,
                `${SPELLS[spell.id].label}  ${Math.min(ticksToSeconds(elapsed), total).toFixed(1)} / ${total.toFixed(1)}`,
            )
            this.castText.visible = true
        } else {
            this.castIcon.visible = false
            this.castText.visible = false
        }

        this.updateEffects(player, tick)
    }

    private updateEffects(player: PlayerState, tick: number) {
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

const BUTTON = 78
const GAP = 10
const GROUP_GAP = 24

/** The six spell buttons. Pointer input is reported through the callbacks. */
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

    constructor(onPress: (i: number) => void, onRelease: (i: number) => void) {
        super()
        const total = BUTTON * 6 + GAP * 4 + GROUP_GAP
        const startX = (WIDTH - total) / 2
        const panel = new Graphics()
            .roundRect(startX - 16, 470, total + 32, 122, 16)
            .fill({ color: 0x07060f, alpha: 0.72 })
            .stroke({ width: 1, color: 0xffffff, alpha: 0.08 })
        this.addChild(panel)
        for (let i = 0; i < 6; i++) {
            const root = new Container()
            root.pivot.set(BUTTON / 2, BUTTON / 2)
            root.position.set(
                startX + i * (BUTTON + GAP) + (i >= 3 ? GROUP_GAP - GAP : 0) + BUTTON / 2,
                482 + BUTTON / 2,
            )
            root.eventMode = 'static'
            root.cursor = 'pointer'
            const icon = new Sprite()
            const overlay = new Graphics()
            const frame = new Graphics()
            const center = label(26, '800', 0xfff3a0)
            center.anchor.set(0.5)
            center.position.set(BUTTON / 2, BUTTON / 2)
            const key = label(12, '800', 0xffffff)
            key.anchor.set(1, 1)
            key.position.set(BUTTON - 6, BUTTON - 3)
            key.text = HOTKEYS[i]
            const name = label(11, '600', 0xdddddd)
            name.style.wordWrap = true
            name.style.wordWrapWidth = BUTTON + GAP - 2
            name.style.align = 'center'
            name.style.lineHeight = 12
            name.anchor.set(0.5, 0)
            name.position.set(BUTTON / 2, BUTTON + 4)
            // the cooldown sweep is drawn oversized and clipped with the icon
            const mask = new Graphics().roundRect(0, 0, BUTTON, BUTTON, 14).fill(0xffffff)
            const clip = new Container()
            clip.addChild(icon, overlay)
            clip.mask = mask
            root.addChild(mask, clip, frame, center, key, name)
            root.on('pointerdown', () => {
                if (this.pressed.has(i)) return
                this.pressed.add(i)
                onPress(i)
            })
            const release = () => {
                if (!this.pressed.delete(i)) return
                onRelease(i)
            }
            root.on('pointerup', release)
            root.on('pointerupoutside', release)
            this.addChild(root)
            this.buttons.push({ root, icon, overlay, frame, center, key, name, spellId: '' })
        }
    }

    update(player: PlayerState, tick: number, keysDown: Set<number>) {
        const locked = player.globalCooldown > tick
        player.spells.forEach((spell, i) => {
            const b = this.buttons[i]
            if (b.spellId !== spell.id) {
                b.spellId = spell.id
                b.icon.texture = iconTexture(spell.id)
                b.icon.width = b.icon.height = BUTTON
                setText(b.name, SPELLS[spell.id].label)
            }
            this.drawButton(
                b,
                spell,
                tick,
                locked ? player.globalCooldown - tick : 0,
                player.cast === i,
                keysDown.has(i) || this.pressed.has(i),
            )
        })
    }

    private drawButton(
        b: ActionBar['buttons'][number],
        spell: SpellState,
        tick: number,
        lockTicks: number,
        casting: boolean,
        down: boolean,
    ) {
        const remaining = cooldownRemaining(spell, tick)
        const o = b.overlay.clear()
        if (remaining > 0 || lockTicks > 0) {
            const fraction = remaining > 0 ? remaining / spell.cooldown : 1
            const c = BUTTON / 2
            o.moveTo(c, c)
                .arc(c, c, BUTTON, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * fraction)
                .lineTo(c, c)
                .fill({ color: 0x000000, alpha: 0.62 })
            if (lockTicks > 0) o.roundRect(0, 0, BUTTON, BUTTON, 14).fill({ color: 0x0c8599, alpha: 0.35 })
        }
        const shown = Math.max(remaining, lockTicks)
        setText(b.center, shown > 0 ? ticksToSeconds(shown).toFixed(1) : '')
        b.frame
            .clear()
            .roundRect(0, 0, BUTTON, BUTTON, 14)
            .stroke({ width: casting ? 4 : 2, color: casting ? 0xffd43b : 0xffffff, alpha: casting ? 1 : 0.35 })
        b.root.scale.set(down ? 0.94 : 1)
    }
}
