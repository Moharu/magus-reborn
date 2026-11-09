import { ELEMENT_SPELL_COUNT, SPELLS, type EffectId, type SpellId } from '@magus/engine'
import type { Condition } from './conditions'
import { checkLoadout, type Profile, type RotationEntry } from './profile'

/**
 * The spell that puts each counted effect on the enemy: a rotation entry waiting for that effect relies on the spell.
 * Public spell data (the effect each spell's description names); no spell math.
 */
const EFFECT_SOURCES: Partial<Record<EffectId, SpellId>> = {
    DEBUFF_IGNITE: 'SPELL_IGNITE',
    DEBUFF_LIVING_BOMB: 'SPELL_LIVING_BOMB',
}

/** Whether `condition` can never hold on `loadout`, because it waits on a spell the loadout lacks. */
const needsMissingSpell = (condition: Condition, loadout: readonly SpellId[]) => {
    if (condition.type === 'enemyEffectsAtLeast' && condition.count > 0) {
        const source = EFFECT_SOURCES[condition.effect]
        return source !== undefined && !loadout.includes(source)
    }
    if (condition.type === 'selfCastsAtLeast') return condition.count > 0 && !loadout.includes(condition.spell)
    return false
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
 * after Fireballs with no Fireball), so a rotation never relies on a missing spell. With no entry left, the rotation is
 * the loadout's own Fire spells in slot order, with no conditions; with no window entry left, the window plays the
 * built rotation. When the fake-cast spell is missing, the fake is retargeted to the loadout's longest cast-time spell
 * (the first in slot order on a tie), and fake-casting is turned off only if the loadout has no cast-time spell.
 * Everything else is kept. Building a built profile again for the same loadout changes nothing.
 */
export const adaptProfile = (profile: Profile, loadout: readonly SpellId[]): Profile => {
    let rotation = buildRotation(profile.rotation, loadout)
    if (rotation.length === 0) rotation = loadout.slice(0, ELEMENT_SPELL_COUNT).map(spell => ({ spell, when: [] }))
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
        rotation.length === profile.rotation.length &&
            lockoutWindow === profile.lockoutWindow &&
            fakeCast === profile.fakeCast
            ? profile
            : { ...profile, rotation, lockoutWindow, fakeCast },
        loadout,
    )
}
