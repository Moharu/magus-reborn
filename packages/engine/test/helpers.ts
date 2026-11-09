import { Battle, SPELLS, type PlayerKey, type SpellId } from '../src'

export const FIRE: SpellId[] = [
    'SPELL_FIREBALL',
    'SPELL_IGNITE',
    'SPELL_COMBUSTION',
    'SPELL_AFTERBURN',
    'SPELL_LIVING_BOMB',
    'SPELL_METEOR',
]
export const GENERAL: SpellId[] = [
    'SPELL_HASTE',
    'SPELL_COUNTERSPELL',
    'SPELL_TEMPORAL_SHIELD',
    'SPELL_MAGIC_EATER',
    'SPELL_BLUR',
    'SPELL_FIREBALL',
]

/** Starts a battle and moves past tick 0. */
export const setup = (p1: SpellId[] = FIRE, p2: SpellId[] = GENERAL, opts: { p2hp?: number } = {}) => {
    const battle = new Battle({ name: 'Alice', spells: p1 }, { name: 'Bob', spells: p2, hp: opts.p2hp })
    advance(battle, 10)
    return battle
}

export const advance = (battle: Battle, ticks: number) => {
    for (let i = 0; i < ticks; i++) battle.tick()
}

export const slot = (battle: Battle, caster: PlayerKey, id: SpellId) => {
    const index = battle.state[caster].spells.findIndex(s => s.id === id)
    if (index === -1) throw new Error(`${id} not equipped by ${caster}`)
    return index
}

/** Press, hold for exactly the cast time, release. Returns whether the spell went off. */
export const castFull = (battle: Battle, caster: PlayerKey, id: SpellId) => {
    const index = slot(battle, caster, id)
    if (!battle.startCast(caster, index)) return false
    const spell = battle.state[caster].spells[index]
    if (!spell.castTime) {
        battle.stopCast(caster, index)
        return true
    }
    advance(battle, spell.castTime)
    return battle.stopCast(caster, index)
}

export const releases = (battle: Battle, caster: PlayerKey) =>
    battle.state.log.filter(l => l.type === 'SPELL_RELEASE' && l.caster === caster)

export const effectIds = (battle: Battle, player: PlayerKey) => battle.state[player].effects.map(e => e.id)

const clearedOffGcd = new Set<SpellId>()

/**
 * Since #84 no general spell is on the GCD (Icy Touch is the one shipped on-GCD instant), so tests that need a
 * general on-GCD instant (to start a GCD, or to be blocked by it) clear `offGlobalCooldown` on a spell. Call it before creating the battle when the spell must also start the
 * GCD: `createSpellState` reads the flag then. Undo with `restoreOffGcd` in `afterEach`.
 */
export const putOnGcd = (...ids: SpellId[]) => {
    for (const id of ids) {
        if (!SPELLS[id].offGlobalCooldown) continue
        clearedOffGcd.add(id)
        delete SPELLS[id].offGlobalCooldown
    }
}

export const restoreOffGcd = () => {
    for (const id of clearedOffGcd) SPELLS[id].offGlobalCooldown = true
    clearedOffGcd.clear()
}
