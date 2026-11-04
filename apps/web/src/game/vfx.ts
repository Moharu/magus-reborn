import { Container, Graphics, Sprite, Text } from 'pixi.js'
import { TEXT_FONT } from './layout'
import { particleTexture } from './textures'

interface Point {
    x: number
    y: number
}

interface Particle {
    sprite: Sprite
    vx: number
    vy: number
    gravity: number
    life: number
    maxLife: number
    startScale: number
    endScale: number
}

interface Projectile {
    sprite: Sprite
    from: Point
    to: Point
    arc: number
    duration: number
    elapsed: number
    trail: number
    size: number
    onHit: () => void
}

interface Ring {
    g: Graphics
    x: number
    y: number
    color: number
    radius: number
    life: number
    maxLife: number
    width: number
}

interface Floater {
    text: Text
    vy: number
    life: number
    maxLife: number
}

const MAX_PARTICLES = 700

export class Vfx extends Container {
    private particles: Particle[] = []
    private pool: Sprite[] = []
    private projectiles: Projectile[] = []
    private rings: Ring[] = []
    private floaters: Floater[] = []
    private readonly particleLayer = new Container()
    private readonly textLayer = new Container()
    shake = 0

    constructor() {
        super()
        this.addChild(this.particleLayer, this.textLayer)
    }

    spray(
        at: Point,
        color: number,
        opts: Partial<{
            count: number
            speed: number
            size: number
            life: number
            gravity: number
            spread: number
            angle: number
            endScale: number
        }> = {},
    ) {
        const {
            count = 12,
            speed = 120,
            size = 0.6,
            life = 0.6,
            gravity = 0,
            spread = Math.PI * 2,
            angle = 0,
            endScale = 0.1,
        } = opts
        for (let i = 0; i < count; i++) {
            if (this.particles.length >= MAX_PARTICLES) return
            const sprite = this.pool.pop() ?? this.newSprite()
            const a = angle + (Math.random() - 0.5) * spread
            const v = speed * (0.4 + Math.random() * 0.6)
            sprite.position.set(at.x, at.y)
            sprite.tint = color
            sprite.alpha = 1
            sprite.visible = true
            const s = size * (0.6 + Math.random() * 0.6)
            sprite.scale.set(s)
            const l = life * (0.6 + Math.random() * 0.6)
            this.particles.push({
                sprite,
                vx: Math.cos(a) * v,
                vy: Math.sin(a) * v,
                gravity,
                life: l,
                maxLife: l,
                startScale: s,
                endScale: s * endScale,
            })
        }
    }

    burst(at: Point, color: number, power = 1) {
        this.spray(at, color, { count: Math.round(26 * power), speed: 220 * power, size: 0.9 * power, life: 0.55 })
        this.spray(at, 0xffffff, { count: Math.round(8 * power), speed: 90 * power, size: 0.7, life: 0.3 })
        this.ring(at, color, 50 * power, 0.4)
    }

    ring(at: Point, color: number, radius: number, life: number, width = 4) {
        const g = new Graphics()
        g.blendMode = 'add'
        this.particleLayer.addChild(g)
        this.rings.push({ g, x: at.x, y: at.y, color, radius, life, maxLife: life, width })
    }

    projectile(
        from: Point,
        to: Point,
        color: number,
        opts: Partial<{ duration: number; arc: number; size: number; trail: number; onHit: () => void }> = {},
    ) {
        const { duration = 0.35, arc = 40, size = 1.2, trail = color, onHit = () => this.burst(to, color) } = opts
        const sprite = new Sprite(particleTexture())
        sprite.anchor.set(0.5)
        sprite.tint = color
        sprite.blendMode = 'add'
        sprite.scale.set(size)
        sprite.position.set(from.x, from.y)
        this.particleLayer.addChild(sprite)
        this.projectiles.push({ sprite, from, to, arc, duration, elapsed: 0, trail, size, onHit })
    }

    floatText(at: Point, value: string, color: number, size = 22) {
        const text = new Text({
            text: value,
            style: {
                fontFamily: TEXT_FONT,
                fontSize: size,
                fontWeight: '800',
                fill: color,
                stroke: { color: 0x000000, width: 4 },
            },
        })
        text.anchor.set(0.5)
        text.position.set(at.x + (Math.random() - 0.5) * 30, at.y)
        this.textLayer.addChild(text)
        this.floaters.push({ text, vy: -60, life: 1.1, maxLife: 1.1 })
    }

    update(dt: number) {
        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const p = this.projectiles[i]
            p.elapsed += dt
            const t = Math.min(1, p.elapsed / p.duration)
            const x = p.from.x + (p.to.x - p.from.x) * t
            const y = p.from.y + (p.to.y - p.from.y) * t - Math.sin(t * Math.PI) * p.arc
            p.sprite.position.set(x, y)
            this.spray({ x, y }, p.trail, { count: 2, speed: 30, size: p.size * 0.6, life: 0.35 })
            if (t >= 1) {
                p.sprite.destroy()
                this.projectiles.splice(i, 1)
                p.onHit()
            }
        }

        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i]
            p.life -= dt
            if (p.life <= 0) {
                p.sprite.visible = false
                this.pool.push(p.sprite)
                this.particles.splice(i, 1)
                continue
            }
            p.vy += p.gravity * dt
            p.sprite.x += p.vx * dt
            p.sprite.y += p.vy * dt
            const k = p.life / p.maxLife
            p.sprite.alpha = k
            p.sprite.scale.set(p.endScale + (p.startScale - p.endScale) * k)
        }

        for (let i = this.rings.length - 1; i >= 0; i--) {
            const r = this.rings[i]
            r.life -= dt
            if (r.life <= 0) {
                r.g.destroy()
                this.rings.splice(i, 1)
                continue
            }
            const k = 1 - r.life / r.maxLife
            r.g
                .clear()
                .circle(r.x, r.y, r.radius * (0.3 + k))
                .stroke({ width: r.width * (1 - k) + 1, color: r.color, alpha: 1 - k })
        }

        for (let i = this.floaters.length - 1; i >= 0; i--) {
            const f = this.floaters[i]
            f.life -= dt
            if (f.life <= 0) {
                f.text.destroy()
                this.floaters.splice(i, 1)
                continue
            }
            f.text.y += f.vy * dt
            f.vy *= 0.96
            f.text.alpha = Math.min(1, (f.life / f.maxLife) * 2)
        }

        this.shake = Math.max(0, this.shake - dt * 30)
    }

    private newSprite() {
        const sprite = new Sprite(particleTexture())
        sprite.anchor.set(0.5)
        sprite.blendMode = 'add'
        this.particleLayer.addChild(sprite)
        return sprite
    }
}
