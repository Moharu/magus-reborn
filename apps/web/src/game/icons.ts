import { SPELLS, type School, type SpellId } from '@magus/engine'

const SIZE = 128
type Ctx = CanvasRenderingContext2D

const SCHOOL_COLORS: Record<School, [string, string, string]> = {
    FIRE: ['#ff9a3c', '#8a1c0c', '#2a0805'],
    GENERAL: ['#7c8cff', '#2b2a7a', '#0c0b26'],
}

const background = (ctx: Ctx, school: School) => {
    const [light, mid, dark] = SCHOOL_COLORS[school]
    const g = ctx.createRadialGradient(SIZE * 0.5, SIZE * 0.42, 6, SIZE * 0.5, SIZE * 0.5, SIZE * 0.75)
    g.addColorStop(0, light)
    g.addColorStop(0.35, mid)
    g.addColorStop(1, dark)
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.roundRect(0, 0, SIZE, SIZE, 22)
    ctx.fill()
}

const glow = (ctx: Ctx, color: string, blur = 18) => {
    ctx.shadowColor = color
    ctx.shadowBlur = blur
}

const flame = (ctx: Ctx, x: number, y: number, w: number, hgt: number, outer: string, inner: string) => {
    const drawShape = (s: number, color: string) => {
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.moveTo(x, y - hgt * s)
        ctx.bezierCurveTo(x + w * 0.9 * s, y - hgt * 0.45 * s, x + w * 0.7 * s, y + hgt * 0.1, x, y + hgt * 0.12)
        ctx.bezierCurveTo(x - w * 0.7 * s, y + hgt * 0.1, x - w * 0.9 * s, y - hgt * 0.45 * s, x, y - hgt * s)
        ctx.fill()
    }
    drawShape(1, outer)
    drawShape(0.6, inner)
}

const orb = (ctx: Ctx, x: number, y: number, r: number, stops: [number, string][]) => {
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r)
    for (const [offset, color] of stops) g.addColorStop(offset, color)
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
}

const DRAW: Record<SpellId, (ctx: Ctx) => void> = {
    SPELL_FIREBALL: ctx => {
        glow(ctx, '#ffb347')
        ctx.fillStyle = '#ff5a1f'
        ctx.beginPath()
        ctx.moveTo(18, 30)
        ctx.quadraticCurveTo(60, 50, 92, 60)
        ctx.quadraticCurveTo(60, 74, 22, 100)
        ctx.quadraticCurveTo(50, 70, 18, 30)
        ctx.fill()
        orb(ctx, 82, 64, 26, [
            [0, '#fff6d5'],
            [0.5, '#ffb347'],
            [1, '#ff5a1f'],
        ])
    },
    SPELL_IGNITE: ctx => {
        glow(ctx, '#ff7b29')
        flame(ctx, 64, 92, 40, 70, '#ff5a1f', '#ffd27a')
        flame(ctx, 36, 100, 18, 34, '#ff7b29', '#ffe5a0')
        flame(ctx, 92, 102, 16, 28, '#ff7b29', '#ffe5a0')
    },
    SPELL_COMBUSTION: ctx => {
        glow(ctx, '#ffcf6b', 24)
        ctx.fillStyle = '#ff8a1f'
        ctx.beginPath()
        for (let i = 0; i < 24; i++) {
            const r = i % 2 === 0 ? 50 : 22
            const a = (i / 24) * Math.PI * 2
            ctx.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r)
        }
        ctx.fill()
        orb(ctx, 64, 64, 20, [
            [0, '#ffffff'],
            [0.6, '#ffe08a'],
            [1, '#ff8a1f'],
        ])
    },
    SPELL_AFTERBURN: ctx => {
        glow(ctx, '#ff9a3c')
        for (const [x, y, r] of [
            [34, 94, 12],
            [58, 70, 15],
            [88, 42, 19],
        ]) {
            ctx.strokeStyle = 'rgba(255,140,40,0.55)'
            ctx.lineWidth = r * 0.9
            ctx.lineCap = 'round'
            ctx.beginPath()
            ctx.moveTo(x - r * 1.6, y + r * 1.6)
            ctx.lineTo(x, y)
            ctx.stroke()
            orb(ctx, x, y, r, [
                [0, '#fff3c4'],
                [0.5, '#ffb347'],
                [1, '#e2461a'],
            ])
        }
    },
    SPELL_LIVING_BOMB: ctx => {
        orb(ctx, 60, 72, 34, [
            [0, '#7a5a8a'],
            [0.5, '#3a1f4a'],
            [1, '#150818'],
        ])
        ctx.strokeStyle = '#c9a26b'
        ctx.lineWidth = 5
        ctx.beginPath()
        ctx.moveTo(78, 44)
        ctx.quadraticCurveTo(92, 26, 100, 30)
        ctx.stroke()
        glow(ctx, '#ffd27a', 20)
        orb(ctx, 101, 28, 10, [
            [0, '#ffffff'],
            [0.5, '#ffd27a'],
            [1, '#ff5a1f'],
        ])
    },
    SPELL_METEOR: ctx => {
        ctx.lineCap = 'round'
        for (const [w, alpha] of [
            [26, 0.35],
            [14, 0.7],
        ]) {
            ctx.strokeStyle = `rgba(255,150,50,${alpha})`
            ctx.lineWidth = w
            ctx.beginPath()
            ctx.moveTo(108, 16)
            ctx.lineTo(62, 62)
            ctx.stroke()
        }
        glow(ctx, '#ff7b29', 22)
        ctx.fillStyle = '#5b3a2e'
        ctx.beginPath()
        const rock = [
            [30, 66],
            [44, 50],
            [66, 52],
            [78, 70],
            [70, 94],
            [46, 100],
            [28, 86],
        ]
        rock.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
        ctx.fill()
        ctx.shadowBlur = 0
        ctx.fillStyle = '#ff9a3c'
        ctx.beginPath()
        ctx.arc(56, 72, 8, 0, Math.PI * 2)
        ctx.arc(44, 86, 5, 0, Math.PI * 2)
        ctx.fill()
    },
    SPELL_HASTE: ctx => {
        glow(ctx, '#ffe066', 20)
        ctx.fillStyle = '#ffe066'
        ctx.beginPath()
        const bolt = [
            [74, 12],
            [36, 70],
            [60, 70],
            [48, 116],
            [94, 52],
            [68, 52],
            [82, 12],
        ]
        bolt.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
        ctx.fill()
        ctx.strokeStyle = 'rgba(255,240,170,0.6)'
        ctx.lineWidth = 4
        for (const y of [40, 64, 88]) {
            ctx.beginPath()
            ctx.moveTo(14, y)
            ctx.lineTo(32, y)
            ctx.stroke()
        }
    },
    SPELL_COUNTERSPELL: ctx => {
        glow(ctx, '#7ff3ff', 20)
        ctx.strokeStyle = '#7ff3ff'
        ctx.lineWidth = 12
        ctx.beginPath()
        ctx.arc(64, 64, 38, 0, Math.PI * 2)
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(37, 91)
        ctx.lineTo(91, 37)
        ctx.stroke()
        ctx.shadowBlur = 0
        ctx.fillStyle = '#d8fbff'
        ctx.beginPath()
        ctx.arc(64, 64, 9, 0, Math.PI * 2)
        ctx.fill()
    },
    SPELL_TEMPORAL_SHIELD: ctx => {
        glow(ctx, '#8fd3ff', 18)
        ctx.fillStyle = 'rgba(120,190,255,0.35)'
        ctx.strokeStyle = '#a8dcff'
        ctx.lineWidth = 5
        ctx.beginPath()
        ctx.moveTo(64, 14)
        ctx.lineTo(106, 30)
        ctx.quadraticCurveTo(104, 88, 64, 116)
        ctx.quadraticCurveTo(24, 88, 22, 30)
        ctx.closePath()
        ctx.fill()
        ctx.stroke()
        ctx.shadowBlur = 0
        ctx.fillStyle = '#e8f6ff'
        ctx.beginPath()
        ctx.moveTo(48, 40)
        ctx.lineTo(80, 40)
        ctx.lineTo(64, 64)
        ctx.lineTo(80, 88)
        ctx.lineTo(48, 88)
        ctx.lineTo(64, 64)
        ctx.closePath()
        ctx.fill()
    },
    SPELL_MAGIC_EATER: ctx => {
        glow(ctx, '#7dffb0', 18)
        ctx.strokeStyle = '#7dffb0'
        ctx.lineWidth = 7
        ctx.lineCap = 'round'
        ctx.beginPath()
        for (let i = 0; i <= 60; i++) {
            const t = i / 60
            const a = t * Math.PI * 4.2
            const r = 6 + t * 40
            const x = 64 + Math.cos(a) * r
            const y = 64 + Math.sin(a) * r
            i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
        }
        ctx.stroke()
        orb(ctx, 64, 64, 10, [
            [0, '#ffffff'],
            [1, '#c58bff'],
        ])
    },
    SPELL_BLUR: ctx => {
        for (const [x, alpha] of [
            [40, 0.25],
            [54, 0.5],
            [70, 1],
        ]) {
            ctx.globalAlpha = alpha
            glow(ctx, '#c9b8ff', 14)
            ctx.fillStyle = '#d9ceff'
            ctx.beginPath()
            ctx.arc(x, 50, 16, Math.PI, 0)
            ctx.lineTo(x + 16, 96)
            ctx.lineTo(x + 8, 88)
            ctx.lineTo(x, 96)
            ctx.lineTo(x - 8, 88)
            ctx.lineTo(x - 16, 96)
            ctx.closePath()
            ctx.fill()
        }
        ctx.globalAlpha = 1
    },
}

const canvases = new Map<SpellId, HTMLCanvasElement>()
const urls = new Map<SpellId, string>()

/** Canvas with the spell's icon, drawn once and cached. */
export const iconCanvas = (id: SpellId): HTMLCanvasElement => {
    let canvas = canvases.get(id)
    if (canvas) return canvas
    canvas = document.createElement('canvas')
    canvas.width = SIZE
    canvas.height = SIZE
    const ctx = canvas.getContext('2d')!
    background(ctx, SPELLS[id].school)
    ctx.save()
    DRAW[id](ctx)
    ctx.restore()
    // bevel
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.roundRect(1.5, 1.5, SIZE - 3, SIZE - 3, 21)
    ctx.stroke()
    canvases.set(id, canvas)
    return canvas
}

export const iconUrl = (id: SpellId): string => {
    let url = urls.get(id)
    if (!url) {
        url = iconCanvas(id).toDataURL()
        urls.set(id, url)
    }
    return url
}
