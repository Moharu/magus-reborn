import { expect, it, vi } from 'vitest'
import { Container, Graphics, Text } from 'pixi.js'
import { Battle, DEFAULT_SPELLS, FROST_NUMBERS, ticksToSeconds, SPELLBOOKS, SPELLS, type SpellId } from '@magus/engine'
import {
    BATTLE_BAR,
    battleLayout,
    WIDTH,
    HEIGHT,
    resourceMeterSlot,
    RESOURCE_METER_PLACEMENT,
    mobileWorldTransform,
    mobileBattleLayout,
    SIDE_X,
    resourceCombatTextOffset,
    type Rect,
} from '../src/game/layout'
import { ActionBar, PlayerHud } from '../src/game/hud'
import { BattleView } from '../src/game/battle-view'
import { emptySpellLog, mapSpellLog } from '../src/game/spell-log'

vi.mock('../src/game/textures', async () => {
    const { Texture } = await import('pixi.js')
    return {
        iconTexture: () => Texture.EMPTY,
        particleTexture: () => Texture.EMPTY,
        backdropTexture: () => Texture.EMPTY,
    }
})
vi.mock('../src/game/hotkeys', () => ({ keybindsVisible: () => false, onKeybindVisibilityChange: () => () => {} }))
const spells: SpellId[] = [...SPELLBOOKS.FROST.elementSpells.slice(0, 4), ...DEFAULT_SPELLS.slice(4)]
const texts = (node: Container): string[] => [
    ...(node instanceof Text && node.visible ? [node.text] : []),
    ...node.children.flatMap(child => texts(child)),
]

const pips = (hud: PlayerHud) => (hud as unknown as { chillingPips: Graphics }).chillingPips

it('shows own Frost resource but keeps Fire and unrevealed rivals hidden', () => {
    const battle = new Battle({ name: 'a', spells }, { name: 'b', spells: DEFAULT_SPELLS })
    const own = new PlayerHud('left', 'player1', 'player1')
    const rival = new PlayerHud('right', 'player2', 'player1')
    own.update(battle.state.player1, 0, 1)
    expect(pips(own).visible).toBe(true)
    expect(pips(own).accessibleTitle).toBe(`Chilling 0 / ${FROST_NUMBERS.chillingMaxStacks}`)
    own.update(battle.state.player2, 0, 1)
    expect(pips(own).visible).toBe(false)
    // Even a full local snapshot must not reveal a rival's loadout.
    rival.update(battle.state.player1, 0, 1)
    expect(pips(rival).visible).toBe(false)
    for (const count of [1, FROST_NUMBERS.chillingMaxStacks, 0]) {
        rival.update({ ...battle.state.player2, spells: undefined, chilling: count }, 0, 1)
        expect(pips(rival).visible).toBe(true)
        expect(pips(rival).accessibleTitle).toBe(`Chilling ${count} / ${FROST_NUMBERS.chillingMaxStacks}`)
    }
    own.destroy({ children: true })
    rival.destroy({ children: true })
})

it.each(['SPELL_FROST_FEVER', 'SPELL_ICY_TOUCH'] as const)('reveals zero-stack rivals from public %s casts', id => {
    const battle = new Battle({ name: 'a', spells }, { name: 'b', spells: [id] })
    battle.state.player2.chilling = FROST_NUMBERS.chillingMaxStacks
    const hud = new PlayerHud('right', 'player2', 'player1')
    battle.startCast('player2', 0)
    hud.observeCasts(battle.state.log)
    hud.update({ ...battle.state.player2, spells: undefined, chilling: 0 }, 0, 1)
    expect(pips(hud).visible).toBe(true)
    hud.destroy({ children: true })
})

it.each([
    [1024, 768],
    [844, 390],
    [667, 375],
    [896, 500],
])('lays out five readable segments directly below the cast bar at %ix%i', (width, height) => {
    const battle = new Battle({ name: 'long player name', spells }, { name: 'b', spells })
    const hud = new PlayerHud('left', 'player1', 'player1')
    hud.update(battle.state.player1, 0, 1)
    const scale = height <= 500 ? Math.min(0.8, (width - 120) / 728) : 1
    hud.scale.set(scale)
    const segments = pips(hud)
    const internals = hud as unknown as { nameText: Text }
    hud.fitResource(width, height)
    const cast = battleLayout(WIDTH, HEIGHT).left.cast
    expect(hud.resourceSlot.y).toBe(cast.y + cast.height + 10)
    expect(hud.resourceSlot.x + segments.width / 2).toBe(cast.x + cast.width / 2)
    expect(internals.nameText.y + Number(internals.nameText.style.fontSize) + 3).toBeLessThan(hud.resourceSlot.y)
    expect(hud.resourceSlot.y + segments.height).toBeLessThan(battleLayout(WIDTH, HEIGHT).left.effects.y)
    expect(segments.height * scale).toBeGreaterThanOrEqual(6)
    const rect = vi.spyOn(segments, 'roundRect')
    const fill = vi.spyOn(segments, 'fill')
    battle.state.player1.chilling = 2
    hud.update(battle.state.player1, 0, 1)
    expect(rect.mock.calls).toEqual(
        Array.from({ length: FROST_NUMBERS.chillingMaxStacks }, (_, i) => [i * 26, 0, 22, 8, 2]),
    )
    expect(fill.mock.calls.map(call => call[0])).toEqual([
        0x9ee7ff,
        0x9ee7ff,
        ...Array(FROST_NUMBERS.chillingMaxStacks - 2).fill(0x394b60),
    ])
    hud.destroy({ children: true })
})

it('renders Frost Fever and Frost Bomb as negative effect icons with decreasing durations', () => {
    const debuffs: SpellId[] = ['SPELL_FROST_FEVER', 'SPELL_FROST_BOMB']
    const battle = new Battle({ name: 'a', spells: debuffs }, { name: 'b', spells })
    for (let i = 0; i < debuffs.length; i++) {
        expect(battle.startCast('player1', i)).toBe(true)
        for (let n = 0; n < battle.state.player1.spells[i].castTime; n++) battle.tick()
        battle.stopCast('player1', i)
    }
    const target = battle.state.player2
    expect(target.effects.map(e => e.source)).toEqual(debuffs)
    expect(target.effects.every(e => e.type === 'negative')).toBe(true)
    const hud = new PlayerHud('right')
    hud.update(target, battle.state.gameTick, 1)
    for (const effect of target.effects) {
        expect(texts(hud)).toContain(
            ticksToSeconds(effect.startingTick + effect.duration - battle.state.gameTick).toFixed(1),
        )
    }
    hud.update(target, battle.state.gameTick + 2, 1)
    for (const effect of target.effects) {
        expect(texts(hud)).toContain(
            ticksToSeconds(effect.startingTick + effect.duration - battle.state.gameTick - 2).toFixed(1),
        )
    }
    hud.destroy({ children: true })
})

it('hides touch key labels and explains Icy Touch resource and GCD unavailability', () => {
    const battle = new Battle(
        { name: 'a', spells: [...spells.slice(0, 3), 'SPELL_ICY_TOUCH', ...spells.slice(4)] },
        { name: 'b', spells },
    )
    const bar = new ActionBar(
        () => {},
        () => {},
    )
    bar.update(battle.state.player1, 0, new Set())
    expect(texts(bar)).not.toContain('R')
    const button = bar.children.find(child => child.accessibleTitle?.startsWith('Icy Touch'))!
    expect(button.accessibleHint).toContain('Not enough Chilling')
    const slot = (
        bar as unknown as {
            buttons: { icon: { alpha: number }; overlay: Graphics }[]
        }
    ).buttons[3]
    expect(slot.icon.alpha).toBe(0.4)
    const arc = vi.spyOn(slot.overlay, 'arc')
    battle.state.player1.gcdUntil = 20
    bar.update(battle.state.player1, 10, new Set())
    expect(slot.icon.alpha).toBe(0.4)
    expect(arc).toHaveBeenLastCalledWith(
        BATTLE_BAR.button / 2,
        BATTLE_BAR.button / 2,
        BATTLE_BAR.button,
        -Math.PI / 2,
        Math.PI / 2,
    )
    battle.state.player1.gcdUntil = 0
    battle.state.player1.chilling = 2
    battle.startCast('player1', 3)
    bar.update(battle.state.player1, 0, new Set())
    expect(button.accessibleHint).toContain('Global cooldown')
    bar.destroy({ children: true })
})

it.each(SPELLBOOKS.FROST.elementSpells)('logs and floats real engine damage from %s', id => {
    const battle = new Battle({ name: 'a', spells: [id] }, { name: 'b', spells })
    battle.state.player1.chilling = FROST_NUMBERS.chillingMaxStacks
    const Ctor = BattleView as unknown as new (container: HTMLElement, options: { me: 'player1' }) => BattleView
    const view = new Ctor({} as HTMLElement, { me: 'player1' })
    // Use the real public update path; texture initialization is unnecessary for log/HUD projection.
    const internals = view as unknown as { vfx: { floatText: (...args: unknown[]) => void }; frame(dt: number): void }
    const float = vi.spyOn(internals.vfx, 'floatText')
    view.update(battle.snapshot(), [], [])
    battle.startCast('player1', 0)
    for (let i = 0; i < battle.state.player1.spells[0].castTime; i++) battle.tick()
    battle.stopCast('player1', 0)
    // Include DoT/pulse damage as well as direct releases.
    for (let i = 0; i < 300; i++) battle.tick()
    const log = mapSpellLog(emptySpellLog(), battle.state.log, 'player1')
    expect(log.added).toEqual([{ text: SPELLS[id].label, side: 'left', label: `YOU: ${SPELLS[id].label}` }])
    view.update(battle.snapshot(), battle.state.log, battle.drainEvents())
    for (let i = 0; i < 70; i++) internals.frame(1 / 60)
    const n = FROST_NUMBERS
    const amounts: Record<string, number[]> = {
        SPELL_FROSTBOLT: [n.frostbolt.damage],
        SPELL_GLACIER: [n.glacier.damage],
        SPELL_ICE_SPEAR: [n.iceSpear.baseDamage + n.chillingMaxStacks * n.iceSpear.damagePerStack],
        SPELL_ICY_TOUCH: [n.icyTouch.damage],
        SPELL_FROST_FEVER: [n.frostFever.damage],
        SPELL_FROST_BOMB: Array(3).fill(n.frostBomb.pulseDamage),
    }
    expect(float.mock.calls.map(call => call[1])).toEqual(
        amounts[id].map(amount => `-${amount < 10 ? amount.toFixed(1) : amount.toFixed(0)}`),
    )
})

const overlaps = (a: Rect, b: Rect) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

it.each([
    [960, 600],
    [844, 390],
    [667, 375],
    [568, 320],
    [896, 500],
    [932, 430],
])('keeps both resource positions clear of HUD, log and combat text at %ix%i', (width, height) => {
    const compact = height <= 500
    const factor = compact ? Math.min(0.8, (width - 120) / 728) : 1
    const world = compact ? mobileWorldTransform(width, height) : { x: 0, y: 0, scale: 1 }
    const log = compact ? mobileBattleLayout(width, height).log : { x: 480, y: 434 }
    const bar = compact ? mobileBattleLayout(width, height).bar : battleLayout(WIDTH, HEIGHT).bar
    for (const position of ['below-cast', 'above-wizard'] as const) {
        const previous = RESOURCE_METER_PLACEMENT.position
        RESOURCE_METER_PLACEMENT.position = position
        try {
            for (const side of ['left', 'right'] as const) {
                const hud = new PlayerHud(side)
                const battle = new Battle({ name: 'a', spells }, { name: 'b', spells })
                hud.update({ ...battle.state.player1, chilling: 1 }, 0, 1)
                hud.scale.set(factor)
                hud.x = side === 'right' ? width - WIDTH * factor : 0
                hud.fitResource(width, height)
                const local = resourceMeterSlot(side, width, height)
                expect(pips(hud).width * hud.resourceSlot.scale.x).toBeCloseTo(local.width)
                expect(pips(hud).height * hud.resourceSlot.scale.y).toBeCloseTo(local.height)
                expect(hud.resourceSlot.position.x).toBe(local.x)
                expect(hud.resourceSlot.position.y).toBe(local.y)
                const slot = {
                    x: hud.x + local.x * factor,
                    y: local.y * factor,
                    width: local.width * factor,
                    height: local.height * factor,
                }
                // Measure the real rendered pips after both container transforms.
                expect(pips(hud).height * hud.resourceSlot.scale.y * factor).toBeGreaterThanOrEqual(6)
                expect(22 * hud.resourceSlot.scale.x * factor).toBeGreaterThanOrEqual(10)
                expect(resourceCombatTextOffset()).toBe(position === 'above-wizard' ? 100 : 0)
                const player = battleLayout(WIDTH, HEIGHT)[side]
                const obstacles = [player.heading, player.hp, player.cast, player.effects].map(rect => ({
                    x: hud.x + rect.x * factor,
                    y: rect.y * factor,
                    width: rect.width * factor,
                    height: rect.height * factor,
                }))
                obstacles.push(bar, { x: log.x - 92, y: log.y - 127, width: 184, height: 140 })
                // Floaters start at the head (290), rise at most 60 * 1.1, with jitter and stroke.
                // Also encloses the interrupt tell at y=250 and Interrupted! at y=304.
                const combatX = world.x + SIDE_X[side] * world.scale
                obstacles.push({
                    x: combatX - 130 * world.scale,
                    y: world.y + (204 + resourceCombatTextOffset()) * world.scale,
                    width: 260 * world.scale,
                    height: 120 * world.scale,
                })
                expect(slot.x).toBeGreaterThanOrEqual(0)
                expect(slot.x + slot.width).toBeLessThanOrEqual(width)
                expect(slot.y + slot.height).toBeLessThan(height)
                for (const obstacle of obstacles)
                    expect(overlaps(slot, obstacle), JSON.stringify({ position, side, slot, obstacle })).toBe(false)
                if (position === 'above-wizard') {
                    expect(slot.x + slot.width / 2).toBeCloseTo(world.x + SIDE_X[side] * world.scale)
                    expect(slot.y + slot.height).toBeLessThan(world.y + 282 * world.scale)
                }
                hud.destroy({ children: true })
            }
        } finally {
            RESOURCE_METER_PLACEMENT.position = previous
        }
    }
})
