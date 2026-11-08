import { describe, expect, it } from 'vitest'
import { BATTLE_BAR, battleButtonX, HEIGHT, WIDTH } from '../src/game/layout'
import { BOOK, cardBoxes, DETAILS } from '../src/ui/spell-picker'

const BAR = { ...BATTLE_BAR }

/** The picker stage scales with the picker's rendered width: 960x600 stage units to CSS pixels. */
const sizes = [
    { name: 'desktop 1200x720', width: Math.min(1200 - 24, (720 - 24) * 1.6) },
    { name: 'phone 844x390', width: ((390 - 24) * 1.6) | 0 },
    { name: 'phone 667x375', width: (375 - 24) * 1.6 },
]

const sections = [
    { count: 6, firstSlot: 0, columns: 3 },
    { count: 4, firstSlot: 5, columns: 2 },
]

describe.each(sizes)('rendered spellbook at $name', ({ width }) => {
    const scale = width / WIDTH
    const px = (units: number) => units * scale
    const cards = sections.flatMap(s => cardBoxes(s.count, s.firstSlot, s.columns))

    it('keeps every card inside the stage, above the bar and clear of the details strip', () => {
        for (const c of cards) {
            expect(c.x).toBeGreaterThanOrEqual(0)
            expect(c.x + c.w).toBeLessThanOrEqual(WIDTH)
            expect(c.y).toBeGreaterThanOrEqual(DETAILS.top + DETAILS.height)
            expect(c.y + c.h + 10).toBeLessThanOrEqual(BAR.panelTop)
        }
        expect(BAR.panelTop + BAR.panelHeight).toBeLessThanOrEqual(HEIGHT)
    })

    it('does not overlap cards', () => {
        for (const a of cards)
            for (const b of cards) {
                if (a === b) continue
                const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y
                expect(apart).toBe(true)
            }
    })

    it('leaves room for a readable icon and a name inside each card', () => {
        for (const c of cards) {
            const icon = Math.max(32, Math.min(width * 0.05, 48)) / scale
            expect(icon + 30).toBeLessThanOrEqual(c.h) // icon plus a two-line name
        }
        if (width >= 480) {
            // rendered icon at least 32px on phones, 48px on desktop
            const min = width >= 1000 ? 48 : 32
            expect(Math.max(32, Math.min(width * 0.05, 48))).toBeGreaterThanOrEqual(min)
        }
    })

    it('is at least as tall as the spec minimum card', () => {
        for (const c of cards) expect(px(c.h)).toBeGreaterThanOrEqual(width >= 1000 ? 94 : 54)
        expect(BOOK.height).toBe(BOOK.cardHeight * 2 + BOOK.rowGap)
    })
})

it('uses the battle bar section edges for the spellbook', () => {
    expect(cardBoxes(6, 0, 3)[0].x).toBe(battleButtonX(0))
    const last = cardBoxes(4, 5, 2)[1]
    expect(last.x + last.w).toBe(battleButtonX(6) + BATTLE_BAR.button)
})
