import { SPELLS } from '@magus/engine'
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
    await expect(picker.locator('.header-details')).toContainText('Afterburn')
    await expect(picker.getByRole('button', { name: 'Spell details' })).toHaveCount(0)
    await expect(picker.locator('[data-target="spell:SPELL_AFTERBURN"]')).toHaveAttribute('aria-pressed', 'true')
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(picker.locator('.details')).toBeVisible()
    await expect(picker.locator('.details')).toContainText('Afterburn')
})

for (const [width, height] of [
    [640, 360],
    [740, 360],
    [844, 390],
    [932, 430],
]) {
    test(`picker art and teaser text fit at ${width}x${height}`, async ({ page }) => {
        await page.setViewportSize({ width, height })
        await page.goto('/training')
        await expect(page.locator('.stage canvas')).toBeVisible()
        await page.getByRole('button', { name: 'Change spells', exact: true }).last().click()
        const picker = page.locator('.training-picker')
        const details = picker.locator('.header-details')
        await expect(details).toBeVisible()
        const initial = (await details.boundingBox())!
        const element = (await picker.locator('.element').boundingBox())!
        const toggle = (await picker.locator('.toggle').boundingBox())!
        expect(initial.x).toBeGreaterThanOrEqual(element.x + element.width)
        expect(initial.x + initial.width).toBeLessThanOrEqual(toggle.x)
        for (const spell of ['SPELL_AFTERBURN', 'SPELL_COMBUSTION', 'SPELL_TEMPORAL_SHIELD']) {
            await picker.locator(`[data-target="spell:${spell}"]`).click()
            expect(await details.boundingBox()).toEqual(initial)
        }
        await expect(details.locator('p')).toHaveText(SPELLS.SPELL_TEMPORAL_SHIELD.description)
        await picker.getByLabel('Exact numbers', { exact: true }).check()
        await expect(details.locator('p')).toHaveText(SPELLS.SPELL_TEMPORAL_SHIELD.advancedDescription)
        expect(await details.boundingBox()).toEqual(initial)
        const paragraph = details.locator('p')
        const clamp = await paragraph.evaluate(p => ({
            clamp: getComputedStyle(p).webkitLineClamp,
            height: p.getBoundingClientRect().height,
            title: p.title,
            text: p.textContent,
            aria: p.getAttribute('aria-label'),
        }))
        expect(clamp.clamp).toBe('2')
        expect(clamp.height).toBeLessThanOrEqual(22)
        expect(clamp.title).toBe(clamp.text)
        expect(clamp.aria).toBe(clamp.text)
        for (const control of await picker.locator('.spell, .slot-wrap').all()) {
            expect((await control.boundingBox())!.y).toBeGreaterThanOrEqual(initial.y + initial.height)
        }
        await expect(picker.locator('.details-trigger')).toBeHidden()
        await expect(picker.locator('.picker-stage > .details')).toBeHidden()
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
        expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(height)
        const icons = picker.locator('.slot img')
        await expect(icons).toHaveCount(7)
        for (const icon of await icons.all()) {
            await expect(icon).toBeVisible()
            const art = await icon.evaluate((img: HTMLImageElement) => {
                const style = getComputedStyle(img)
                return { fit: style.objectFit, width: img.clientWidth, height: img.clientHeight }
            })
            // Square sources must retain a uniform scale within each rectangular slot.
            expect(art.width).toBeGreaterThan(art.height)
            expect(art.fit).toBe('contain')
        }
        for (const teaser of await picker.locator('.teaser').all()) {
            await expect(teaser).toHaveAttribute('aria-label', /Locked · coming later/)
            await expect(teaser).toHaveAttribute('title', /Locked · coming later/)
            const lines = await teaser.evaluate(button => {
                const range = document.createRange()
                range.selectNodeContents(button.querySelector('.teaser-compact')!)
                return range.getClientRects().length
            })
            expect(lines).toBeGreaterThan(0)
            expect(lines).toBeLessThanOrEqual(2)
        }
        await expect(picker.locator('.slot .key').first()).toBeHidden()
    })
}

test('picker labels switch live on the first touch even with fine-pointer media reports', async ({ page }) => {
    await page.addInitScript(() => {
        const original = window.matchMedia.bind(window)
        window.matchMedia = query => {
            if (!['(pointer: coarse)', '(any-pointer: coarse)', '(hover: none)'].includes(query)) return original(query)
            return Object.assign(new EventTarget(), { matches: false, media: query }) as MediaQueryList
        }
    })
    await page.goto('/training')
    await expect(page.locator('.stage canvas')).toBeVisible()
    await page.getByRole('button', { name: 'Change spells', exact: true }).last().click()
    const key = page.locator('.training-picker .slot .key').first()
    await expect(key).toBeVisible()
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch' })))
    await expect(key).toBeHidden()
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse' })))
    await expect(key).toBeHidden()
})

test('desktop picker retains its stage description', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/training')
    await expect(page.locator('.stage canvas')).toBeVisible()
    await page.getByRole('button', { name: 'Change spells', exact: true }).last().click()
    const picker = page.locator('.training-picker')
    await expect(picker.locator('.header-details')).toBeHidden()
    await expect(picker.locator('.picker-stage > .details')).toBeVisible()
})
