import type { SpellId } from '../../types'

/*
 * Every Frost number lives in this one table and nowhere else. They were balanced with the simulator (#148) and
 * approved by the owner (2026-11-09). Seconds are converted to ticks with `secondsToTicks`; damage is in HP and
 * applied in exact centi-HP.
 */
export const FROST_NUMBERS = {
    /** Chilling stacks a caster can hold. Stacks gained above it are lost. Owner design: 5. */
    chillingMaxStacks: 5,
    frostbolt: { castSeconds: 1.5, damage: 7.5, chillingGain: 1 },
    glacier: { castSeconds: 3.5, damage: 16, chillingGain: 3 },
    /** Pulses 3 times, every `pulseSeconds`: the bomb lasts 3 pulses and the last one lands on its expiry tick. */
    frostBomb: { castSeconds: 1.5, pulseSeconds: 4, pulseDamage: 11, chillingGain: 0 },
    /** Castable at 0 stacks for `baseDamage`; spends every stack for `damagePerStack` each. */
    iceSpear: { castSeconds: 2, baseDamage: 5, damagePerStack: 6.5, chillingGain: 0 },
    /** An on-GCD instant that needs and spends `chillingCost` stacks. Its Frost Fever bonus is in `frostFeverBonus`. */
    icyTouch: { damage: 3, chillingCost: 1 },
    /** Total `damage` over `durationSeconds`. A recast refreshes it; it never stacks. */
    frostFever: { castSeconds: 1, damage: 12, durationSeconds: 12, chillingGain: 0 },
    /**
     * Flat bonus damage a spell's hit deals to a target that has Frost Fever. Frost Fever amplifies nothing else (owner,
     * 2026-11-09): only Icy Touch is listed. Every Frost hit reads this table, so giving another spell a bonus is an
     * entry here, not an engine change.
     */
    frostFeverBonus: { SPELL_ICY_TOUCH: 8.5 } as Partial<Record<SpellId, number>>,
}
