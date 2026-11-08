import { Container, Graphics, Text } from 'pixi.js'
import type { LogEntry, PlayerKey } from '@magus/engine'
import { battleLayout, HEIGHT, TEXT_FONT, WIDTH } from './layout'
import { emptySpellLog, logRowY, mapSpellLog, type SpellLogRow } from './spell-log'

/** Four preallocated rows; frame work only updates positions/visibility. */
export class SpellLogView extends Container {
    private state = emptySpellLog()
    private readonly pool = Array.from({ length: 4 }, () => {
        const root = new Container()
        const backing = new Graphics()
        const text = new Text({ style: { fontFamily: TEXT_FONT, fontSize: 12, fontWeight: '700' } })
        text.anchor.set(0.5)
        const marker = new Text({ style: { fontFamily: TEXT_FONT, fontSize: 12 } })
        marker.anchor.set(0.5)
        root.addChild(backing, text, marker)
        root.visible = false
        return {
            root,
            backing,
            text,
            marker,
            row: null as SpellLogRow | null,
            expires: 0,
            from: 0,
            target: 0,
            elapsed: 0,
        }
    })
    private time = 0
    private readonly history: HTMLElement
    private readonly motion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')

    constructor(
        private readonly me: PlayerKey | null,
        host: HTMLElement,
    ) {
        super()
        // The arena host outlives a round's Pixi view; retain history until leaving the match.
        this.history = host.querySelector?.<HTMLElement>('.spell-log-history') ?? document.createElement('div')
        const area = battleLayout(WIDTH, HEIGHT).centre
        this.position.set(area.x + area.width / 2, area.y + area.height - 16)
        this.addChild(...this.pool.map(slot => slot.root))
        this.history.className = 'spell-log-history'
        this.history.setAttribute('role', 'log')
        this.history.setAttribute('aria-live', 'polite')
        this.history.setAttribute('aria-relevant', 'additions')
        this.history.setAttribute('aria-label', 'Match spell history')
        host.append(this.history)
    }

    feed(entries: LogEntry[]) {
        const mapped = mapSpellLog(this.state, entries, this.me)
        this.state = mapped
        for (const row of mapped.added) {
            const item = document.createElement('div')
            item.textContent = row.label
            this.history.append(item)
            const slot = this.pool.find(s => !s.root.visible) ?? this.pool[0]
            this.pool.splice(this.pool.indexOf(slot), 1)
            this.pool.push(slot)
            slot.row = row
            slot.expires = this.time + 4
            slot.root.visible = true
            slot.root.y = 0
            slot.target = 0
            slot.from = 0
            slot.elapsed = 0
            const color = row.side === 'left' ? 0xb6e3ff : 0xffe0a8
            const edge = row.side === 'left' ? -92 : 90
            slot.backing.clear().roundRect(-92, -13, 184, 26, 4).fill(0x191426)
            slot.backing.rect(edge, -13, 2, 26).fill(color)
            slot.text.text = row.text
            slot.text.style.fill = color
            // Fit one line; full text remains in the retained DOM history.
            while (slot.text.width > 152 && slot.text.text.length > 1)
                slot.text.text = slot.text.text.replace(/…?$/, '').slice(0, -1) + '…'
            slot.marker.text = row.side === 'left' ? '●' : '◆'
            slot.marker.style.fill = color
            slot.marker.x = row.side === 'left' ? -82 : 82
        }
        this.advance(0)
    }

    advance(dt: number) {
        this.time += dt
        for (const slot of this.pool) if (slot.expires <= this.time) slot.root.visible = false
        const active = this.pool.filter(slot => slot.root.visible)
        active.forEach((slot, i) => {
            const target = (i - active.length + 1) * 30
            if (slot.target !== target) {
                slot.from = slot.root.y
                slot.target = target
                slot.elapsed = 0
            }
            slot.elapsed += dt
            slot.root.y = logRowY(slot.from, target, slot.elapsed, this.motion?.matches ?? false)
        })
    }
}
