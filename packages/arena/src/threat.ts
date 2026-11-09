import { SPELLS, type EffectId, type SpellId } from '@magus/engine'
import type { ArenaView } from './types'

/**
 * What each opponent spell is worth to counter (#143), learned only from what a client shows: the player's own HP,
 * its own buff bar and the opponent's spell log (`enemy.log`). Never the opponent's loadout, cooldowns or any effect's
 * internals, and no spell module: it works for any spell set, future elements included.
 *
 * The value of a spell is the damage it has done to the player per cast, as seen:
 *   - a hit: the HP lost on the tick after the opponent released it (the view on tick `t + 1` shows a release on `t`),
 *     beyond the damage over time already running (the last tick's loss with nothing new happening);
 *   - a burst when one of its effects runs out (a Living Bomb's explosion): the HP lost beyond that running damage on
 *     the tick the effect leaves the buff bar at its `expiresAt` (cleansed early, it gives nothing);
 *   - damage over time: each tick's running loss, shared evenly by the opponent's debuffs on the player.
 * An effect's spell is the opponent release on the effect's `startingTick` (a cast-time one first). Heals and rewinds
 * are not damage: a tick whose HP went up credits nothing.
 *
 * A spell the opponent has not yet released (or whose casts have dealt nothing yet) is valued from its public base
 * cast time, the one number a client shows for every spell: `unseenValuePerSecond` HP per second of cast.
 */
export interface SpellValues {
    /** Reads one view. Call it once per tick, on every view, before asking for values. */
    observe(view: ArenaView): void
    /** The value of one cast of `spell`, in HP. */
    valueOf(spell: SpellId): number
    /** The highest value among the cast-time spells the opponent has been seen casting (and `also`), 0 for none. */
    best(also?: SpellId): number
}

/** The spells whose effect a debuff on the player comes from, the opponent's Counterspell lock aside. */
const TRACKED = (id: EffectId) => id !== 'DEBUFF_COUNTERSPELL'

interface Tracked {
    readonly id: EffectId
    readonly startingTick: number
    readonly expiresAt: number
    readonly source: SpellId | null
}

export const spellValues = (unseenValuePerSecond: number): SpellValues => {
    const damage = new Map<SpellId, number>()
    const casts = new Map<SpellId, number>()
    // cast-time spells the opponent has been seen starting
    const seenCasting = new Set<SpellId>()
    // opponent releases by tick, for the effects' sources
    const releasedOn = new Map<number, SpellId[]>()
    let logRead = 0
    let lastHp = NaN
    let lastTick = NaN
    // the HP lost per tick to damage over time, from the last tick with nothing new
    let running = 0
    let debuffs: Tracked[] = []

    const credit = (spell: SpellId | null, hp: number) => {
        if (spell && hp > 0) damage.set(spell, (damage.get(spell) ?? 0) + hp)
    }
    const sourceOf = (startingTick: number): SpellId | null => {
        const spells = releasedOn.get(startingTick) ?? []
        return spells.find(id => (SPELLS[id].castSeconds ?? 0) > 0) ?? spells[0] ?? null
    }
    const prior = (spell: SpellId) => Math.max(0, unseenValuePerSecond) * (SPELLS[spell].castSeconds ?? 0)

    return {
        observe(view) {
            const { tick, self, enemy } = view
            for (; logRead < enemy.log.length; logRead++) {
                const entry = enemy.log[logRead]
                if (entry.type === 'START_CAST') seenCasting.add(entry.spellId)
                if (entry.type !== 'SPELL_RELEASE') continue
                const list = releasedOn.get(entry.tick)
                if (list) list.push(entry.spellId)
                else releasedOn.set(entry.tick, [entry.spellId])
                casts.set(entry.spellId, (casts.get(entry.spellId) ?? 0) + 1)
            }
            if (enemy.casting) seenCasting.add(enemy.casting.spellId)
            // the releases of the last tick show in this tick's HP
            const hits = releasedOn.get(tick - 1) ?? []

            // the opponent's debuffs on the buff bar now, and the ones that ran out on this tick
            const now: Tracked[] = []
            for (const effect of self.effects)
                if (effect.type === 'negative' && TRACKED(effect.id))
                    now.push({
                        id: effect.id,
                        startingTick: effect.startingTick,
                        expiresAt: effect.expiresAt,
                        source: sourceOf(effect.startingTick),
                    })
            const bursts = debuffs.filter(
                old => old.expiresAt === tick && !now.some(e => e.id === old.id && e.startingTick === old.startingTick),
            )

            if (lastTick === tick - 1) {
                const lost = lastHp - self.hp
                if (lost > 0) {
                    const events = hits.length + bursts.length
                    if (events === 0) running = lost
                    const dot = Math.min(lost, running)
                    // damage over time, shared by the debuffs that were running
                    const ticking = debuffs.filter(d => d.expiresAt >= tick)
                    for (const d of ticking) credit(d.source, dot / ticking.length)
                    // the rest: the hits and bursts of this tick, shared evenly
                    const extra = lost - (ticking.length > 0 ? dot : 0)
                    if (events > 0) {
                        for (const spell of hits) credit(spell, extra / events)
                        for (const d of bursts) credit(d.source, extra / events)
                    }
                } else if (hits.length + bursts.length === 0) running = 0
            }
            debuffs = now
            lastHp = self.hp
            lastTick = tick
        },
        valueOf(spell) {
            const total = damage.get(spell) ?? 0
            const count = casts.get(spell) ?? 0
            return count > 0 && total > 0 ? total / count : prior(spell)
        },
        best(also) {
            let top = also ? this.valueOf(also) : 0
            for (const spell of seenCasting) top = Math.max(top, this.valueOf(spell))
            return top
        },
    }
}
