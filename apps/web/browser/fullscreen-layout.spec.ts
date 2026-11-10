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

for (const [width, height] of [
    [667, 375],
    [844, 390],
    [1000, 500],
]) {
    for (const toolbar of [false, true]) {
        test(`setup and swap picker fit with toolbar=${toolbar} at ${width}x${height}`, async ({ page }) => {
            await page.route('**/*', route =>
                new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
            )
            await page.setViewportSize({ width, height })
            // Reuse the real picker DOM without connecting to a lobby server.
            await page.goto('/training')
            await expect(page.locator('.stage canvas')).toBeVisible()
            await page.getByRole('button', { name: 'Change spells', exact: true }).last().click()
            const training = page.locator('.training-picker')
            const trainingBox = (await training.boundingBox())!
            expect(trainingBox.y).toBeGreaterThanOrEqual(0)
            expect(trainingBox.y + trainingBox.height).toBeLessThanOrEqual(height)
            expect(await training.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1)
            await page.evaluate(toolbar => {
                const picker = document.querySelector('.training-picker .picker')!
                const app = document.querySelector('#app')!
                app.replaceChildren()
                app.setAttribute('style', 'padding: 12px 24px 8px; --inset-y: 20px')
                if (toolbar) {
                    const button = document.createElement('button')
                    button.className = 'btn small fullscreen-toggle lobby-fullscreen-toggle'
                    button.textContent = 'Fullscreen'
                    app.append(button)
                }
                const lobby = document.createElement('div')
                lobby.className = 'lobby-screen'
                lobby.innerHTML = '<section class="panel setup"><div class="setup-viewport"></div></section>'
                lobby.querySelector('.setup-viewport')!.append(picker)
                app.append(lobby)
            }, toolbar)
            // Pregame and between-round swap use this same panel and picker structure.
            const panel = (await page.locator('.panel.setup').boundingBox())!
            const stage = (await page.locator('.picker-stage').boundingBox())!
            expect(stage.y).toBeGreaterThanOrEqual(panel.y + 12)
            expect(stage.y + stage.height).toBeLessThanOrEqual(panel.y + panel.height - 12 + 1)
            expect(panel.y + panel.height).toBeLessThanOrEqual(height - 8 + 1)
            for (const control of await page
                .locator('.picker-stage .slot-wrap, .picker-stage .spell, .picker-stage .bar-panel')
                .all()) {
                const box = (await control.boundingBox())!
                expect(box.x).toBeGreaterThanOrEqual(stage.x)
                expect(box.x + box.width).toBeLessThanOrEqual(stage.x + stage.width + 1)
                expect(box.y).toBeGreaterThanOrEqual(stage.y)
                expect(box.y + box.height).toBeLessThanOrEqual(stage.y + stage.height + 1)
            }
            expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(height)
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
        })
    }
}
