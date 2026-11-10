import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'

const css = readFileSync('apps/web/src/style.css', 'utf8')

for (const [width, height] of [
    [1200, 800],
    [960, 600],
    [844, 390],
    [667, 375],
    [932, 430],
    [1000, 500],
]) {
    test(`fullscreen toggle reserves space outside the entire HUD at ${width}x${height}`, async ({ page }) => {
        await page.setViewportSize({ width, height })
        await page.setContent(
            '<div id="app" style="padding: 12px 24px 8px; --inset-y: 20px"><button class="btn small fullscreen-toggle lobby-fullscreen-toggle">⛶</button><div class="lobby-screen"><div class="battle-screen"><div class="stage"></div></div></div></div>',
        )
        await page.addStyleTag({ content: css })
        const toggle = await page.locator('button').boundingBox()
        const arena = await page.locator('.lobby-screen').boundingBox()
        expect(toggle!.y).toBeGreaterThanOrEqual(12)
        expect(toggle!.x + toggle!.width).toBeLessThanOrEqual(width - 24)
        expect(toggle!.height).toBeGreaterThanOrEqual(44)
        // All HUD layers, including above-wizard resources and the log, live in the arena.
        expect(toggle!.y + toggle!.height).toBeLessThanOrEqual(arena!.y)
        expect(arena!.y + arena!.height).toBeLessThanOrEqual(height)
    })
}
