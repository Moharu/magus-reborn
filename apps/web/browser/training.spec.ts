import { expect, test } from '@playwright/test'
import { mobileBattleLayout } from '../src/game/layout'

// Keep the real screen, stylesheet, renderer and input dispatch; only use localhost.
test.beforeEach(async ({ page }) => {
    await page.route('**/*', route =>
        new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    )
})

for (const [width, height] of [
    [640, 360],
    [740, 360],
    [844, 390],
    [932, 430],
]) {
    test(`training meter leaves arena width and all seven targets available at ${width}x${height}`, async ({
        page,
    }) => {
        await page.setViewportSize({ width, height })
        await page.goto('/training')
        const canvas = page.locator('.stage canvas')
        await expect(canvas).toBeVisible()
        const before = (await canvas.boundingBox())!
        await page.getByRole('button', { name: 'Damage meter', exact: true }).click()
        await expect(page.locator('.meter')).toBeVisible()
        await expect.poll(async () => (await canvas.boundingBox())!.width).toBe(width)
        const arena = (await canvas.boundingBox())!
        expect(arena).toEqual(before)
        expect(arena.y + arena.height).toBeLessThanOrEqual(height)
        const meter = (await page.locator('.meter').boundingBox())!
        const { slots, bar } = mobileBattleLayout(arena.width, arena.height)
        expect(meter.y + meter.height).toBeLessThanOrEqual(arena.y + bar.y)
        for (const slot of slots) {
            // Check corners as well as the center: no portion of a target may be intercepted.
            for (const [dx, dy] of [
                [1, 1],
                [slot.width - 1, slot.height - 1],
                [slot.width / 2, slot.height / 2],
            ]) {
                const point = { x: arena.x + slot.x + dx, y: arena.y + slot.y + dy }
                expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, point)).toBe(
                    'CANVAS',
                )
            }
            await page.touchscreen.tap(arena.x + slot.x + slot.width / 2, arena.y + slot.y + slot.height / 2)
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
        expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(height)
    })
}

test('an open picker keeps descriptions and selection available across rotation', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/training')
    await expect(page.locator('.stage canvas')).toBeVisible()
    await page.getByRole('button', { name: 'Change spells', exact: true }).last().click()
    const picker = page.locator('.training-picker')
    await picker.locator('[data-target="spell:SPELL_AFTERBURN"]').click()
    await expect(picker.locator('.details')).toBeVisible()
    await page.setViewportSize({ width: 844, height: 390 })
    await picker.getByRole('button', { name: 'Spell details' }).click()
    await expect(picker.locator('.details:popover-open')).toContainText('Afterburn')
    await page.keyboard.press('Escape')
    await expect(picker.locator('[data-target="spell:SPELL_AFTERBURN"]')).toHaveAttribute('aria-pressed', 'true')
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(picker.locator('.details')).toBeVisible()
    await expect(picker.locator('.details')).toContainText('Afterburn')
})
