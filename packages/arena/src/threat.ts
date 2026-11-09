import { fromCenti, SPELLS, toCenti, type SpellId } from '@magus/engine'
import type { ArenaView } from './types'

/**
 * What each opponent spell is worth to counter (#143), from what a client shows: the player's floating combat text
 * (`self.hpLog`, #146: every HP change on the player with the spell it came from, as the server streams it to both
 * clients) and the opponent's spell log (`enemy.log`). Never the opponent's loadout, cooldowns or any effect's
 * internals, and no spell module: it works for any spell set, future elements included.
 *
 * The value of a spell is the damage it has dealt to the player per cast released: every damage entry of the combat
 * text whose source is that spell (its hits, its effects' ticks and bursts, a Living Bomb's explosion or any later
 * one) over the opponent's releases of it. The combat text names the spell exactly, so nothing is inferred from HP
 * drops (#146 review: same-tick releases and expiries made such inference split damage wrongly). In a 1v1 the damage
 * on a player comes from the opponent's spells; a damage entry from one of the player's own spells (a Temporal Shield
 * rewind after a heal) is credited to that spell id, which is a general instant and never a Counterspell target.
 *
 * Damage is summed in exact centi-HP (AGENTS.md invariant 8), and a value is a whole number of centi-HP, so equal
 * damage compares equal however many events it came in (a Living Bomb's ticks and explosion against one Meteor hit).
 *
 * A spell the opponent has not yet been seen to deal damage with is valued from its public base cast time, the one
 * number a client shows for every spell: `unseenValuePerSecond` HP per second of cast.
 */
export interface SpellValues {
    /** Reads one view. Call it once per tick, on every view, before asking for values. */
    observe(view: ArenaView): void
    /** The value of one cast of `spell`, in HP, a whole number of hundredths. */
    valueOf(spell: SpellId): number
    /** The highest value among the cast-time spells the opponent has been seen casting (and `also`), 0 for none. */
    best(also?: SpellId): number
}

export const spellValues = (unseenValuePerSecond: number): SpellValues => {
    // damage per spell, in centi-HP
    const damage = new Map<SpellId, number>()
    const casts = new Map<SpellId, number>()
    // cast-time spells the opponent has been seen starting
    const seenCasting = new Set<SpellId>()
    let logRead = 0
    let hpRead = 0
    const prior = (spell: SpellId) => toCenti(Math.max(0, unseenValuePerSecond) * (SPELLS[spell].castSeconds ?? 0))

    return {
        observe(view) {
            const { self, enemy } = view
            for (; logRead < enemy.log.length; logRead++) {
                const entry = enemy.log[logRead]
                if (entry.type === 'START_CAST') seenCasting.add(entry.spellId)
                else if (entry.type === 'SPELL_RELEASE') casts.set(entry.spellId, (casts.get(entry.spellId) ?? 0) + 1)
            }
            if (enemy.casting) seenCasting.add(enemy.casting.spellId)
            const hpLog = self.hpLog ?? []
            for (; hpRead < hpLog.length; hpRead++) {
                const { amount, spellId } = hpLog[hpRead]
                if (amount < 0) damage.set(spellId, (damage.get(spellId) ?? 0) + toCenti(-amount))
            }
        },
        valueOf(spell) {
            const total = damage.get(spell) ?? 0
            const count = casts.get(spell) ?? 0
            return fromCenti(count > 0 && total > 0 ? Math.round(total / count) : prior(spell))
        },
        best(also) {
            let top = also ? this.valueOf(also) : 0
            for (const spell of seenCasting) top = Math.max(top, this.valueOf(spell))
            return top
        },
    }
}
