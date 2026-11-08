import { describe, expect, it } from 'vitest'
import { BAR } from '../src/game/layout'
import { BOOK } from '../src/ui/spell-picker'

describe('spellbook layout', () => {
    it('fits above the bar panel with at least 10px between them', () => {
        expect(BOOK.top + BOOK.height + 10).toBeLessThanOrEqual(BAR.panelTop)
    })

    it('gives each card room for a readable icon', () => {
        expect(BOOK.cardHeight).toBeGreaterThanOrEqual(150)
    })
})
