import { Battle, toCenti, type SpellId } from '@magus/engine'
import type { ArenaView } from './types'

/** Base hits by loadout and slot, in centi-HP: a pure function of the engine, so shared by every controller. */
const BASE_HITS = new Map<string, number>()

/**
 * The hit, in centi-HP, of the cast in `loadout[slot]` released on a fresh battle against an idle opponent at full HP:
 * the spell's catalog damage with no modifier (no Fireballs before an Afterburn, no Ignites before a Combustion). It
 * plays the real engine (`startCast`, `tick`, `stopCast`) on a battle of its own and reads the engine's attributed HP
 * event, so no spell math is reimplemented and no spell module is read; it works for any spell set. Instants: 0.
 */
export const baseHit = (loadout: readonly SpellId[], slot: number): number => {
    const key = `${loadout.join()}#${slot}`
    const known = BASE_HITS.get(key)
    if (known !== undefined) return known
    const battle = new Battle({ name: 'probe', spells: [...loadout] }, { name: 'target', spells: [...loadout] })
    const castTime = battle.state.player1.spells[slot]?.castTime ?? 0
    let hit = 0
    if (castTime > 0 && battle.startCast('player1', slot)) {
        for (let i = 0; i < castTime; i++) battle.tick()
        // the opponent's ticks run up to the release, so only the release's own hit counts
        battle.drainEvents()
        battle.stopCast('player1', slot)
        for (const event of battle.drainEvents())
            if (event.player === 'player2' && event.kind === 'spell' && event.amount < 0) hit += toCenti(-event.amount)
    }
    BASE_HITS.set(key, hit)
    return hit
}

/** What the player expects its own casts to hit for, in centi-HP (#146 review: releasing a lethal held cast). */
export interface OwnHits {
    /** Reads one view. Call it once per tick, on every view. */
    observe(view: ArenaView): void
    /** The expected hit of the player's own cast in `slot`, in centi-HP. */
    predict(slot: number): number
}

/**
 * The expected hit of each own cast: the hit its last release dealt, read from the floating combat text over the
 * opponent (`enemy.hpLog`: the `spell` entries with its id, on one tick), which carries the modifiers it had then (the
 * Fireballs before an Afterburn, the Ignites before a Combustion); before its first release, its `baseHit`. In a 1v1
 * every damaging `spell` entry on the opponent is one of the player's own releases.
 */
export const ownHits = (loadout: readonly SpellId[]): OwnHits => {
    const last = new Map<SpellId, { tick: number; centi: number }>()
    let read = 0
    return {
        observe(view) {
            const log = view.enemy.hpLog ?? []
            for (; read < log.length; read++) {
                const { tick, amount, spellId, kind } = log[read]
                if (kind !== 'spell' || amount >= 0) continue
                const seen = last.get(spellId)
                if (seen && seen.tick === tick) seen.centi += toCenti(-amount)
                else last.set(spellId, { tick, centi: toCenti(-amount) })
            }
        },
        predict(slot) {
            return last.get(loadout[slot])?.centi ?? baseHit(loadout, slot)
        },
    }
}
