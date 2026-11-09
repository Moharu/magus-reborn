import { Battle, FROST_NUMBERS, SPELL_IDS, SPELLS, type SpellId } from '@magus/engine'

/** The most Chilling stacks a player holds (public: the client's HUD draws this many pips). */
export const CHILLING_MAX = FROST_NUMBERS.chillingMaxStacks

/** Ticks a probe waits for the engine to accept a cast (a GCD after an instant, for example). */
const PROBE_WAIT = 200

/**
 * Releases `casts` (slots into `spells`) in turn on a fresh battle against an idle opponent, through the engine's API
 * only (`startCast`, `tick`, `stopCast`), and returns the caster's Chilling after the last one, or null when the engine
 * refused a cast. The same idea as `baseHit`: the arena measures what the engine does, it never reimplements it.
 */
const play = (spells: readonly SpellId[], casts: readonly number[]): number | null => {
    const battle = new Battle({ name: 'probe', spells: [...spells] }, { name: 'target', spells: [...spells] })
    for (const slot of casts) {
        let started = battle.startCast('player1', slot)
        for (let i = 0; !started && i < PROBE_WAIT; i++) {
            battle.tick()
            started = battle.startCast('player1', slot)
        }
        if (!started) return null
        const castTime = battle.state.player1.spells[slot].castTime
        if (castTime === 0) continue
        for (let i = 0; i < castTime; i++) battle.tick()
        battle.stopCast('player1', slot)
    }
    return battle.state.player1.chilling
}

const GAIN = new Map<SpellId, number>()
/** The Chilling one release of `spell` leaves a player who had none (Frostbolt 1, Glacier 3, the others 0). */
export const chillingGain = (spell: SpellId): number => {
    let gain = GAIN.get(spell)
    if (gain === undefined) {
        gain = SPELLS[spell].chillingCost ? 0 : (play([spell], [0]) ?? 0)
        GAIN.set(spell, gain)
    }
    return gain
}

/** The spells whose release grants Chilling, smallest gain first (ties in catalog order). */
let sources: SpellId[] | undefined
export const chillingSources = (): readonly SpellId[] =>
    (sources ??= SPELL_IDS.filter(id => chillingGain(id) > 0).sort((x, y) => chillingGain(x) - chillingGain(y)))

/** Whether any spell of `loadout` grants Chilling: without one, its stacks stay at 0 all match. */
export const hasChillingSource = (loadout: readonly SpellId[]) => loadout.some(id => chillingSources().includes(id))

const AFTER = new Map<string, number>()
/**
 * A player's Chilling once its release of `spell` has gone off with `before` stacks held: the release adds its gain
 * up to the cap (Frostbolt, Glacier), spends every stack (Ice Spear) or its cost (Icy Touch). The view on a tick is
 * built before that tick's actions, so a profile deciding its next cast on the tick it releases one reads the stacks
 * from here (#150), as it reads the effect counts from `countAfterRelease`. Measured on the real engine: `before`
 * stacks are built by releasing the smallest Chilling source, then `spell` is released. A count the smallest source
 * can't build exactly (none with the shipped numbers) falls back to `before` plus the spell's gain, capped.
 */
export const chillingAfter = (spell: SpellId, before: number): number => {
    const key = `${spell}#${before}`
    const known = AFTER.get(key)
    if (known !== undefined) return known
    let after: number | null = null
    if (before === 0) after = SPELLS[spell].chillingCost ? 0 : chillingGain(spell)
    else {
        const builder = chillingSources()[0]
        const step = builder === undefined ? 0 : chillingGain(builder)
        if (builder !== undefined && before % step === 0 && before <= CHILLING_MAX) {
            const builds = Array<number>(before / step).fill(0)
            after = builder === spell ? play([spell], [...builds, 0]) : play([builder, spell], [...builds, 1])
        }
    }
    after ??= Math.min(CHILLING_MAX, before + chillingGain(spell))
    AFTER.set(key, after)
    return after
}
