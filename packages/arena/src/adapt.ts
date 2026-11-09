import { ELEMENT_SPELL_COUNT, FIXED_SPELL, SPELLS, type EffectId, type SpellId } from '@magus/engine'
import type { Condition } from './conditions'
import { EFFECT_SOURCES } from './effects'
import { checkLoadout, type Profile, type RotationEntry } from './profile'

/**
 * Whether an effect on `whom` can only come from this player's own spell, and the loadout lacks it: a debuff on the
 * enemy, or a buff on the player itself. (A buff on the enemy or a debuff on the player comes from the enemy's
 * loadout, which the profile can't know, so it may come.)
 */
const effectNeverComes = (effect: EffectId, whom: 'self' | 'enemy', loadout: readonly SpellId[]) => {
    const { spell, on } = EFFECT_SOURCES[effect]
    const ours = whom === 'enemy' ? on === 'target' : on === 'caster'
    return ours && !loadout.includes(spell)
}

/**
 * Whether `condition` can never hold on `loadout`, because it waits on a spell the loadout lacks: an effect only that
 * spell applies, a release of that spell, the lock only our Counterspell puts on the enemy, or a next cast of spells
 * none of which is held. An `anyOf` can never hold when none of its lists can: each holds such a condition. An
 * exhaustive switch, so a new condition type without a rule here fails typecheck.
 */
const needsMissingSpell = (condition: Condition, loadout: readonly SpellId[]): boolean => {
    switch (condition.type) {
        case 'selfEffectsAtLeast':
            return condition.count > 0 && effectNeverComes(condition.effect, 'self', loadout)
        case 'enemyEffectsAtLeast':
            return condition.count > 0 && effectNeverComes(condition.effect, 'enemy', loadout)
        case 'selfEffectEndsWithin':
            return effectNeverComes(condition.effect, 'self', loadout)
        case 'enemyEffectEndsWithin':
            return effectNeverComes(condition.effect, 'enemy', loadout)
        case 'selfCastsAtLeast':
            return condition.count > 0 && !loadout.includes(condition.spell)
        case 'enemyLocked':
            return !loadout.includes(FIXED_SPELL)
        case 'nextCastIs':
            return !condition.spells.some(spell => loadout.includes(spell))
        case 'anyOf':
            return condition.of.every(when => when.some(inner => needsMissingSpell(inner, loadout)))
        // no own spell needed: HP, fewer effects than a count, casting states, the enemy's casts, the longest cast
        // (every loadout has cast-time spells) and the free-cast window (the enemy's own Counterspell opens it too)
        case 'selfHpBelow':
        case 'selfHpAtLeast':
        case 'enemyHpBelow':
        case 'enemyHpAtLeast':
        case 'selfEffectsBelow':
        case 'enemyEffectsBelow':
        case 'selfCasting':
        case 'selfNotCasting':
        case 'enemyCasting':
        case 'enemyNotCasting':
        case 'enemyCastEndsWithin':
        case 'nextCastIsLongest':
        case 'inLockoutWindow':
            return false
        default: {
            const unhandled: never = condition
            return unhandled
        }
    }
}

/** The entries whose spell is on the loadout and whose `when` relies on no spell it lacks, in order. */
const buildRotation = (entries: readonly RotationEntry[], loadout: readonly SpellId[]) =>
    entries.filter(
        ({ spell, when }) => loadout.includes(spell) && !when.some(condition => needsMissingSpell(condition, loadout)),
    )

/**
 * Builds the profile a loadout plays (#136): a profile's rotation and free-cast window are priority lists over the Fire
 * spells, and the loadout keeps the entries it can play, in order. An entry is dropped when its spell is not on the
 * loadout, or when its `when` waits on a spell the loadout lacks (Combustion at 3+ Ignites with no Ignite, Afterburn
 * after Fireballs with no Fireball; see `needsMissingSpell`), so a rotation never relies on a missing spell. With no
 * entry left, the rotation is the loadout's own Fire spells in slot order, with no conditions; with no window entry
 * left, the window plays the built rotation. When the fake-cast spell is missing, the fake is retargeted to the loadout's longest cast-time spell
 * (the first in slot order on a tie), and fake-casting is turned off only if the loadout has no cast-time spell.
 * Everything else is kept. Building a built profile again for the same loadout changes nothing.
 */
export const adaptProfile = (profile: Profile, loadout: readonly SpellId[]): Profile => {
    const kept = buildRotation(profile.rotation, loadout)
    // unchanged only when every entry was kept: a fallback of the same length is still a new rotation
    const rotationKept = kept.length === profile.rotation.length
    const rotation = kept.length > 0 ? kept : loadout.slice(0, ELEMENT_SPELL_COUNT).map(spell => ({ spell, when: [] }))
    const windowRotation = buildRotation(profile.lockoutWindow.rotation, loadout)
    const lockoutWindow =
        windowRotation.length === profile.lockoutWindow.rotation.length
            ? profile.lockoutWindow
            : { ...profile.lockoutWindow, rotation: windowRotation.length > 0 ? windowRotation : rotation }
    let fakeCast = profile.fakeCast
    if (fakeCast.enabled && !loadout.includes(fakeCast.spell)) {
        let longest: SpellId | undefined
        for (const id of loadout)
            if (SPELLS[id].castSeconds && (!longest || SPELLS[id].castSeconds > (SPELLS[longest].castSeconds ?? 0)))
                longest = id
        fakeCast = longest ? { ...fakeCast, spell: longest } : { ...fakeCast, enabled: false }
    }
    return checkLoadout(
        rotationKept && lockoutWindow === profile.lockoutWindow && fakeCast === profile.fakeCast
            ? profile
            : { ...profile, rotation, lockoutWindow, fakeCast },
        loadout,
    )
}
