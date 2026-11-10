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
    [640, 360],
    [568, 320],
    [844, 390],
    [1200, 800],
]) {
    test(`header slots preserve picker geometry and tap targets at ${width}x${height}`, async ({ page }) => {
        await page.setViewportSize({ width, height })
        await page.route('**/*', route =>
            new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
        )
        await page.addInitScript(() => localStorage.setItem('magus.name', 'Tester'))
        let sendMeta: (phase: string, round: number) => void = () => {}
        await page.routeWebSocket('**/*', ws => {
            const player = { name: 'Tester', wins: 0, ready: false, connected: true }
            sendMeta = (phase, round) =>
                ws.send(
                    JSON.stringify({
                        t: 'meta',
                        lobby: {
                            code: 'TEST12',
                            phase,
                            round,
                            admin: 'player1',
                            player1: player,
                            player2: player,
                            spectators: [],
                            rounds: [],
                            matchStarted: round > 1,
                            countdown: 60,
                            settings: { bestOf: 3, setupTime: 60, allowSpellChange: true, maxSpectators: 0 },
                        },
                    }),
                )
            ws.send(JSON.stringify({ t: 'welcome', role: 'player1' }))
            sendMeta('lobby', 1)
        })
        const clearTargets = async () => {
            const toggle = page.getByRole('button', { name: 'Toggle fullscreen' })
            await expect(toggle).toBeVisible()
            const a = (await toggle.boundingBox())!
            expect(a.x).toBeGreaterThanOrEqual(0)
            expect(a.x + a.width).toBeLessThanOrEqual(width)
            for (const el of await page
                .locator(
                    'button, a, input, select, [role="button"], .picker-top, .spell, .slot, .stage, .spell-log-history',
                )
                .all()) {
                if (await el.evaluate(el => el.classList.contains('fullscreen-toggle'))) continue
                if (!(await el.isVisible())) continue
                const b = (await el.boundingBox())!
                expect(
                    a.x >= b.x + b.width || b.x >= a.x + a.width || a.y >= b.y + b.height || b.y >= a.y + a.height,
                    JSON.stringify({ element: await el.evaluate(el => el.className), toggle: a, box: b }),
                ).toBe(true)
            }
        }
        await page.goto('/lobby/TEST12')
        await clearTargets()
        for (const round of [1, 2]) {
            sendMeta('set_up', round)
            await expect(page.locator('.panel.setup')).toBeVisible()
            await clearTargets()
            const geometry = () =>
                page.locator('.picker-stage, .picker-top, .spell, .slot').evaluateAll(els =>
                    els.map(el => {
                        const { x, y, width, height } = el.getBoundingClientRect()
                        return { x, y, width, height }
                    }),
                )
            const header = (await page.locator('.picker-top').boundingBox())!
            const firstSpell = (await page.locator('.picker-stage .spell').first().boundingBox())!
            expect(header.y + header.height).toBeLessThanOrEqual(firstSpell.y)
            if (height <= 500) {
                const details = page.locator('.header-details')
                await expect(details).toBeVisible()
                const box = (await details.boundingBox())!
                expect(box.height).toBeGreaterThanOrEqual(height <= 340 ? 36 : 44)
                expect(box.width).toBeGreaterThan(100)
                expect(box.y + box.height).toBeLessThanOrEqual(firstSpell.y)
                await expect(details.locator('strong')).not.toBeEmpty()
            }
            const withToggle = await geometry()
            if (height <= 500) expect((await page.locator('.picker-stage').boundingBox())!.height).toBe(height - 24)
            // The toggle must not change the corrected picker layout.
            await page.locator('.fullscreen-toggle').evaluate(el => el.remove())
            expect(await geometry()).toEqual(withToggle)
            if (round === 1) {
                await page.reload()
                await expect(page.locator('.panel.lobby')).toBeVisible()
            }
        }
        sendMeta('battle', 2)
        await expect(page.locator('.stage canvas')).toBeVisible()
        await clearTargets()
        await page.goto('/training')
        await expect(page.locator('.stage canvas')).toBeVisible()
        await clearTargets()
        const before = await page.locator('.stage').boundingBox()
        await page.locator('.fullscreen-toggle').evaluate(el => el.remove())
        expect(await page.locator('.stage').boundingBox()).toEqual(before)
    })
}
