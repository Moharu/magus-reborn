import { Container, Graphics, Sprite } from 'pixi.js'
import { particleTexture } from './textures'
import { PALETTE, type Side } from './layout'

export type Pose = 'idle' | 'casting' | 'win' | 'lose'

const drawBody = (side: Side) => {
    const { robe, trim, hat } = PALETTE[side]
    const g = new Graphics()
    // staff
    g.moveTo(34, -4).lineTo(34, -112).stroke({ width: 5, color: 0x6b4a2b, cap: 'round' })
    // robe
    g.poly([-28, 0, 28, 0, 15, -72, -15, -72]).fill(robe).stroke({ width: 2, color: trim })
    g.rect(-16, -46, 32, 5).fill(0xe8c46a)
    // arm reaching for the staff
    g.poly([6, -66, 16, -70, 36, -56, 30, -48]).fill(robe).stroke({ width: 2, color: trim })
    g.circle(33, -52, 4.5).fill(0xf1c9a0)
    // head and beard
    g.circle(0, -84, 13).fill(0xf1c9a0)
    g.poly([-11, -80, 11, -80, 2, -52]).fill(0xeeeeee)
    g.circle(5, -86, 1.8).fill(0x222222)
    // hat
    g.ellipse(0, -94, 28, 6).fill(hat)
    g.poly([-18, -95, 18, -95, 10, -122, -6, -146, 2, -122]).fill(hat).stroke({ width: 2, color: trim })
    g.star(2, -110, 5, 4, 2).fill(0xffe9a8)
    return g
}

export class Wizard extends Container {
    readonly body = new Container()
    private readonly ghosts: Graphics[] = []
    private readonly orb: Sprite
    private readonly shadow = new Graphics()
    private time = Math.random() * 10
    pose: Pose = 'idle'
    blurred = false
    orbColor = 0xffd27a

    constructor(readonly side: Side) {
        super()
        this.shadow.ellipse(0, 2, 34, 7).fill({ color: 0x000000, alpha: 0.4 })
        this.addChild(this.shadow)
        for (const _ of [0, 1]) {
            const ghost = drawBody(side)
            ghost.alpha = 0
            this.ghosts.push(ghost)
            this.addChild(ghost)
        }
        this.body.addChild(drawBody(side))
        this.orb = new Sprite(particleTexture())
        this.orb.anchor.set(0.5)
        this.orb.position.set(34, -118)
        this.orb.blendMode = 'add'
        this.body.addChild(this.orb)
        this.addChild(this.body)
        if (side === 'right') this.scale.x = -1
    }

    /** World position of the staff orb, where spells come from. */
    get castPoint() {
        return { x: this.x + 34 * this.scale.x, y: this.y - 118 + this.body.y }
    }

    get chestPoint() {
        return { x: this.x, y: this.y - 62 }
    }

    get headPoint() {
        return { x: this.x, y: this.y - 150 }
    }

    update(dt: number) {
        this.time += dt
        const t = this.time
        this.body.rotation = 0
        this.body.pivot.set(0, 0)
        this.body.alpha = 1
        let bob = Math.sin(t * 2.4) * 2

        if (this.pose === 'win') bob = -Math.abs(Math.sin(t * 5)) * 16
        if (this.pose === 'lose') {
            this.body.rotation = -1.35
            this.body.alpha = 0.85
            bob = 0
        }
        this.body.y = bob

        const casting = this.pose === 'casting'
        const pulse = casting ? 1.1 + Math.sin(t * 14) * 0.25 : 0.55 + Math.sin(t * 3) * 0.08
        this.orb.scale.set(pulse)
        this.orb.tint = casting ? this.orbColor : 0xffe9a8
        this.orb.alpha = casting ? 1 : 0.7

        if (this.blurred) {
            this.body.alpha = 0.55
            this.ghosts.forEach((ghost, i) => {
                ghost.alpha = 0.22
                ghost.x = Math.sin(t * 9 + i * Math.PI) * 10
                ghost.y = bob
            })
        } else {
            for (const ghost of this.ghosts) ghost.alpha = 0
        }
    }
}
