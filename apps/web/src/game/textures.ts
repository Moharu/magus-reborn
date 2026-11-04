import { Texture } from 'pixi.js'
import type { SpellId } from '@magus/engine'
import { iconCanvas } from './icons'
import { GROUND_Y, HEIGHT, WIDTH } from './layout'

const iconTextures = new Map<SpellId, Texture>()
export const iconTexture = (id: SpellId) => {
    let texture = iconTextures.get(id)
    if (!texture) {
        texture = Texture.from(iconCanvas(id))
        iconTextures.set(id, texture)
    }
    return texture
}

let particle: Texture | null = null
/** Soft white dot, tinted per particle. */
export const particleTexture = () => {
    if (particle) return particle
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 32
    const ctx = canvas.getContext('2d')!
    const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.35, 'rgba(255,255,255,0.75)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 32, 32)
    particle = Texture.from(canvas)
    return particle
}

/** Deterministic pseudo-random so the backdrop is the same every load. */
const seeded = (seed: number) => () => {
    seed = (seed * 16807) % 2147483647
    return (seed - 1) / 2147483646
}

let backdrop: Texture | null = null
export const backdropTexture = () => {
    if (backdrop) return backdrop
    const canvas = document.createElement('canvas')
    canvas.width = WIDTH
    canvas.height = HEIGHT
    const ctx = canvas.getContext('2d')!
    const rand = seeded(7)

    const sky = ctx.createLinearGradient(0, 0, 0, GROUND_Y)
    sky.addColorStop(0, '#0b0d26')
    sky.addColorStop(0.45, '#2a1f5c')
    sky.addColorStop(0.8, '#7a3b6e')
    sky.addColorStop(1, '#e0855a')
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, WIDTH, HEIGHT)

    for (let i = 0; i < 90; i++) {
        ctx.fillStyle = `rgba(255,255,255,${0.2 + rand() * 0.6})`
        const r = rand() * 1.4 + 0.3
        ctx.beginPath()
        ctx.arc(rand() * WIDTH, rand() * GROUND_Y * 0.55, r, 0, Math.PI * 2)
        ctx.fill()
    }

    // moon
    const moon = ctx.createRadialGradient(700, 215, 4, 700, 215, 70)
    moon.addColorStop(0, 'rgba(255,240,220,0.95)')
    moon.addColorStop(0.35, 'rgba(255,220,200,0.5)')
    moon.addColorStop(1, 'rgba(255,200,180,0)')
    ctx.fillStyle = moon
    ctx.fillRect(600, 115, 200, 200)

    const ridge = (base: number, amp: number, color: string, step: number) => {
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.moveTo(0, GROUND_Y)
        let y = base
        for (let x = 0; x <= WIDTH + step; x += step) {
            y = Math.min(GROUND_Y - 10, Math.max(base - amp, y + (rand() - 0.5) * amp * 0.9))
            ctx.lineTo(x, y)
        }
        ctx.lineTo(WIDTH, GROUND_Y)
        ctx.fill()
    }
    ridge(300, 90, '#3b2350', 48)
    ridge(350, 60, '#2a183c', 32)
    ridge(395, 30, '#1c1029', 24)

    const ground = ctx.createLinearGradient(0, GROUND_Y - 20, 0, HEIGHT)
    ground.addColorStop(0, '#2b2236')
    ground.addColorStop(1, '#0d0a14')
    ctx.fillStyle = ground
    ctx.fillRect(0, GROUND_Y - 18, WIDTH, HEIGHT)

    // dueling circle
    ctx.strokeStyle = 'rgba(160,140,255,0.25)'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.ellipse(WIDTH / 2, GROUND_Y + 4, 380, 34, 0, 0, Math.PI * 2)
    ctx.stroke()
    ctx.strokeStyle = 'rgba(160,140,255,0.12)'
    ctx.beginPath()
    ctx.ellipse(WIDTH / 2, GROUND_Y + 4, 330, 26, 0, 0, Math.PI * 2)
    ctx.stroke()

    backdrop = Texture.from(canvas)
    return backdrop
}
