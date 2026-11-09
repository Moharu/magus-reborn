import { FIXED_SPELL, type EffectId, type SpellId } from '@magus/engine'

/**
 * The spell that applies each effect, and to whom: `caster` for a buff on its caster, `target` for a debuff on the
 * caster's opponent. `unique`: a new one replaces the one already on (Living Bomb), so there is never more than one.
 * Public spell data (the effect each spell's description names); no spell math. A `Record` over every effect id, so a
 * new effect without an entry fails typecheck.
 */
export const EFFECT_SOURCES: Readonly<
    Record<EffectId, { readonly spell: SpellId; readonly on: 'caster' | 'target'; readonly unique?: true }>
> = {
    DEBUFF_IGNITE: { spell: 'SPELL_IGNITE', on: 'target' },
    DEBUFF_LIVING_BOMB: { spell: 'SPELL_LIVING_BOMB', on: 'target', unique: true },
    DEBUFF_COUNTERSPELL: { spell: FIXED_SPELL, on: 'target' },
    BUFF_HASTE: { spell: 'SPELL_HASTE', on: 'caster' },
    BUFF_BLUR: { spell: 'SPELL_BLUR', on: 'caster' },
    BUFF_MAGIC_EATER: { spell: 'SPELL_MAGIC_EATER', on: 'caster' },
    BUFF_TEMPORAL_SHIELD: { spell: 'SPELL_TEMPORAL_SHIELD', on: 'caster' },
}

/**
 * How many effects with id `effect` are on `whom` once the cast `released` this tick has gone off: `shown`, what the
 * view shows, plus the one that release puts on `whom` (#143). The view on a tick is built before that tick's actions,
 * so a cast released this tick does not show its effect until the next tick; without this, a profile releasing a
 * Living Bomb would read "no Living Bomb on the enemy" and start another one at once, replacing its own.
 */
export const countAfterRelease = (
    shown: number,
    effect: EffectId,
    whom: 'self' | 'enemy',
    released: SpellId | null | undefined,
) => {
    const source = EFFECT_SOURCES[effect]
    if (!released || source.spell !== released || source.on !== (whom === 'enemy' ? 'target' : 'caster')) return shown
    return source.unique ? Math.max(shown, 1) : shown + 1
}
