import { describe, expect, it } from 'vitest'
import { Battle, enemyOf, simpleDebuff, type IgniteDebuff, type PlayerKey, type SpellId } from '../src'
import { advance, effectIds, FIRE, GENERAL, slot } from './helpers'

const FIREBALL = 0 // slot in FIRE; its 5.6 damage is lethal at HP
const HP = 5
const FIREBALL_TICKS = 26
const KEYS: PlayerKey[] = ['player1', 'player2']

/** `killer` plays FIRE and `other` plays GENERAL, which also has a Fireball. */
const killerVsGeneral = (killer: PlayerKey, hp = HP) => {
    const [p1, p2] = killer === 'player1' ? [FIRE, GENERAL] : [GENERAL, FIRE]
    return new Battle({ name: 'A', spells: p1, hp }, { name: 'B', spells: p2, hp })
}

const mirror = (hp = HP, spells: SpellId[] = FIRE) => new Battle({ name: 'A', spells, hp }, { name: 'B', spells, hp })

/** No catalog spell is both instant and damaging, so Fireball gets no cast time for both players. */
const withLethalInstants = () => {
    const b = mirror()
    for (const key of KEYS) b.state[key].spells[FIREBALL].castTime = 0
    advance(b, 10)
    return b
}

/** Both players holding a Fireball that can be released on the current tick. */
const withReadyReleases = () => {
    const b = mirror()
    for (const key of KEYS) b.startCast(key, FIREBALL)
    advance(b, FIREBALL_TICKS)
    return b
}

/** `other` holds a ready Fireball when `killer`'s instant Fireball kills them. */
const killedMidCast = (killer: PlayerKey) => {
    const other = enemyOf(killer)
    const b = killerVsGeneral(killer)
    b.state[killer].spells[FIREBALL].castTime = 0
    const fireball = slot(b, other, 'SPELL_FIREBALL')
    b.startCast(other, fireball)
    advance(b, FIREBALL_TICKS)
    b.startCast(killer, FIREBALL)
    expect(b.state.winner).toBe(killer)
    return { b, fireball }
}

/** Decides the winner inside `tick()`, with a DoT that kills `victim`. */
const killByDot = (b: Battle, victim: PlayerKey) => {
    simpleDebuff<IgniteDebuff>(b.state, victim, {
        id: 'DEBUFF_IGNITE',
        label: 'Ignite',
        source: 'SPELL_IGNITE',
        damage: 1000,
        duration: 10,
    })
    b.tick()
    expect(b.state.winner).toBe(enemyOf(victim))
    expect(b.finished).toBe(false)
}

describe.each(KEYS)('actions in the tick a winner is decided, %s landing first', first => {
    const second = enemyOf(first)

    it('a lethal instant from the other player makes it a draw', () => {
        const b = withLethalInstants()
        expect(b.startCast(first, FIREBALL)).toBe(true)
        expect(b.state.winner).toBe(first)
        expect(b.state[second].hp).toBe(0)

        expect(b.startCast(second, FIREBALL)).toBe(true)
        expect(b.state.winner).toBe('draw')
        expect(b.state[first].hp).toBe(0)
    })

    it('a lethal release from the other player makes it a draw', () => {
        const b = withReadyReleases()
        expect(b.stopCast(first, FIREBALL)).toBe(true)
        expect(b.state.winner).toBe(first)

        expect(b.stopCast(second, FIREBALL)).toBe(true)
        expect(b.state.winner).toBe('draw')
        expect(b.state[first].hp).toBe(0)
        expect(b.state[second].hp).toBe(0)
    })

    it('a lethal instant after a lethal release makes it a draw', () => {
        const b = mirror()
        b.state[second].spells[FIREBALL].castTime = 0
        b.startCast(first, FIREBALL)
        advance(b, FIREBALL_TICKS)
        expect(b.stopCast(first, FIREBALL)).toBe(true)
        expect(b.state.winner).toBe(first)

        expect(b.startCast(second, FIREBALL)).toBe(true)
        expect(b.state.winner).toBe('draw')
    })

    it('a lethal instant after a winner decided inside tick() makes it a draw', () => {
        const b = withLethalInstants()
        killByDot(b, second)
        expect(b.startCast(second, FIREBALL)).toBe(true)
        expect(b.state.winner).toBe('draw')
    })

    it('a lethal release after a winner decided inside tick() makes it a draw', () => {
        const b = mirror()
        b.startCast(second, FIREBALL)
        advance(b, FIREBALL_TICKS - 1)
        killByDot(b, second)
        expect(b.stopCast(second, FIREBALL)).toBe(true)
        expect(b.state.winner).toBe('draw')
    })

    it('a non-lethal action counts but leaves the result alone', () => {
        const b = mirror(50)
        b.state[second].hp = HP
        b.startCast(first, FIREBALL)
        b.startCast(second, FIREBALL)
        advance(b, FIREBALL_TICKS)
        expect(b.stopCast(first, FIREBALL)).toBe(true)
        expect(b.stopCast(second, FIREBALL)).toBe(true)
        expect(b.state[first].hp).toBe(44.4)
        expect(b.state.winner).toBe(first)
    })

    it('the winner can still interrupt the dead player, which keeps the win', () => {
        const b = new Battle(
            { name: 'A', spells: first === 'player1' ? GENERAL : FIRE, hp: HP },
            { name: 'B', spells: first === 'player1' ? FIRE : GENERAL, hp: HP },
        )
        const fireball = slot(b, first, 'SPELL_FIREBALL')
        b.state[first].spells[fireball].castTime = 0
        b.startCast(second, FIREBALL)
        advance(b, FIREBALL_TICKS)
        b.startCast(first, fireball)
        expect(b.state.winner).toBe(first)

        expect(b.startCast(first, slot(b, first, 'SPELL_COUNTERSPELL'))).toBe(true)
        expect(b.stopCast(second, FIREBALL)).toBe(false)
        expect(b.state.winner).toBe(first)
        expect(b.state[first].hp).toBe(HP)
    })

    it('a dead player cannot come back: Temporal Shield and Magic Eater heal nothing', () => {
        const b = killerVsGeneral(first)
        advance(b, 10)
        killByDot(b, second)
        expect(b.startCast(second, slot(b, second, 'SPELL_TEMPORAL_SHIELD'))).toBe(true)
        b.state[second].gcdUntil = 0
        expect(b.startCast(second, slot(b, second, 'SPELL_MAGIC_EATER'))).toBe(true)
        expect(effectIds(b, second)).toEqual(expect.arrayContaining(['BUFF_TEMPORAL_SHIELD', 'BUFF_MAGIC_EATER']))
        expect(b.state[second].hp).toBe(0)
        expect(b.state.winner).toBe(first)

        advance(b, 100)
        expect(b.state[second].hp).toBe(0)
        expect(b.state.winner).toBe(first)
    })

    const rejections: [string, (b: Battle, spell: number) => void][] = [
        ['the GCD', b => void (b.state[second].gcdUntil = b.state.gameTick + 20)],
        ['a lock', b => void (b.state[second].lockedUntil = b.state.gameTick + 20)],
        ['its cooldown', (b, spell) => void (b.state[second].spells[spell].lastCast = b.state.gameTick)],
    ]

    it.each(rejections)('an instant rejected by %s does not cancel the cast', (name, reject) => {
        const { b, fireball } = killedMidCast(first)
        const haste = slot(b, second, 'SPELL_HASTE')
        reject(b, haste)
        const logged = b.state.log.length

        expect(b.startCast(second, haste)).toBe(false)
        expect(b.state[second].cast).toBe(fireball)
        expect(b.state.log.length).toBe(logged)

        // a lock blocks new spells, not a release already in progress
        expect(b.stopCast(second, fireball)).toBe(true)
        expect(b.state.winner).toBe('draw')
    })

    it('an accepted instant still cancels the cast, so that release is gone', () => {
        const { b, fireball } = killedMidCast(first)
        expect(b.startCast(second, slot(b, second, 'SPELL_HASTE'))).toBe(true)
        expect(b.state[second].cast).toBeNull()
        expect(b.stopCast(second, fireball)).toBe(false)
        expect(b.state.winner).toBe(first)
    })
})

describe.each(KEYS)('after the tick a winner is decided, %s winning', first => {
    const second = enemyOf(first)

    /** The whole state, so a rejected action can't hide a side effect. */
    const frozen = (b: Battle) => JSON.stringify(b.state)

    it.each([1, 2, 6])('rejects an instant from either player, %i tick() calls later', calls => {
        const b = withLethalInstants()
        b.startCast(first, FIREBALL)
        advance(b, calls)
        expect(b.finished).toBe(true)

        const before = frozen(b)
        expect(b.startCast(second, FIREBALL)).toBe(false)
        expect(b.startCast(first, FIREBALL)).toBe(false)
        expect(frozen(b)).toBe(before)
        expect(b.state.winner).toBe(first)
        expect(b.state[first].hp).toBe(HP)
    })

    it.each([1, 2, 6])('rejects a ready release from either player, %i tick() calls later', calls => {
        const b = withReadyReleases()
        b.stopCast(first, FIREBALL)
        advance(b, calls)
        expect(b.finished).toBe(true)

        const before = frozen(b)
        expect(b.stopCast(second, FIREBALL)).toBe(false)
        expect(b.stopCast(first, FIREBALL)).toBe(false)
        expect(frozen(b)).toBe(before)
        expect(b.state[second].cast).toBe(FIREBALL)
        expect(b.state.winner).toBe(first)
        expect(b.state[first].hp).toBe(HP)
    })

    it('rejects a release after a winner decided inside tick()', () => {
        const b = mirror()
        b.startCast(second, FIREBALL)
        advance(b, FIREBALL_TICKS - 1)
        killByDot(b, second)
        b.tick()

        const before = frozen(b)
        expect(b.stopCast(second, FIREBALL)).toBe(false)
        expect(frozen(b)).toBe(before)
        expect(b.state.winner).toBe(first)
    })

    it('rejects every action after a draw too, and the draw stands', () => {
        const b = withLethalInstants()
        b.startCast(first, FIREBALL)
        b.startCast(second, FIREBALL)
        expect(b.state.winner).toBe('draw')
        b.tick()

        const before = frozen(b)
        expect(b.startCast(first, FIREBALL)).toBe(false)
        expect(b.startCast(second, FIREBALL)).toBe(false)
        expect(b.stopCast(second, FIREBALL)).toBe(false)
        expect(frozen(b)).toBe(before)
        expect(b.state.winner).toBe('draw')
    })

    it('finished only turns true on the next tick() call, which does not advance the clock', () => {
        const b = withLethalInstants()
        expect(b.finished).toBe(false)
        b.startCast(first, FIREBALL)
        expect(b.finished).toBe(false)
        const tick = b.state.gameTick
        b.tick()
        expect(b.finished).toBe(true)
        expect(b.state.gameTick).toBe(tick)
    })
})
