import { expect, it, vi } from 'vitest'
import { Container, Text } from 'pixi.js'
import { Battle, DEFAULT_SPELLS, FROST_NUMBERS, ticksToSeconds, SPELLBOOKS, SPELLS, type SpellId } from '@magus/engine'
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

it('shows Chilling from both public player states, including zero and the cap', () => {
    const battle = new Battle({ name: 'a', spells }, { name: 'b', spells })
    const left = new PlayerHud('left', 'player1', 'player1')
    const right = new PlayerHud('right', 'player2', 'player1')
    for (const count of [0, 1, FROST_NUMBERS.chillingMaxStacks]) {
        battle.state.player1.chilling = count
        battle.state.player2.chilling = FROST_NUMBERS.chillingMaxStacks - count
        left.update(battle.state.player1, 0, 1)
        // No opponent loadout is needed to display the public resource.
        right.update({ ...battle.state.player2, spells: undefined }, 0, 1)
        expect(texts(left)).toContain(`Chilling ${count} / ${FROST_NUMBERS.chillingMaxStacks}`)
        expect(texts(right)).toContain(
            `Chilling ${FROST_NUMBERS.chillingMaxStacks - count} / ${FROST_NUMBERS.chillingMaxStacks}`,
        )
    }
    left.destroy({ children: true })
    right.destroy({ children: true })
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
    for (let i = 0; i < 200; i++) battle.tick()
    const log = mapSpellLog(emptySpellLog(), battle.state.log, 'player1')
    expect(log.added.map(row => row.text)).toContain(SPELLS[id].label)
    view.update(battle.snapshot(), battle.state.log, battle.drainEvents())
    for (let i = 0; i < 70; i++) internals.frame(1 / 60)
    expect(float).toHaveBeenCalled()
})
