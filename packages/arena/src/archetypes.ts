import { isValidLoadout, type SpellId } from '@magus/engine'
import aggressive from '../profiles/aggressive.json'
import bait from '../profiles/bait.json'
import defensive from '../profiles/defensive.json'
import patientCounter from '../profiles/patient-counter.json'
import { adaptProfile } from './adapt'
import { parseProfile, type Profile } from './profile'
import { profileEntrant } from './profile-controller'
import type { Entrant } from './types'

/**
 * A hand-made profile with the loadout it shows off. Its file is `profiles/<name>.json`. The profile's rotation and
 * window are priority lists over the Fire spells, built for each loadout it plays (`adaptProfile`, #136), so they may
 * name spells this loadout lacks.
 */
export interface Archetype {
    readonly loadout: readonly SpellId[]
    readonly profile: Profile
}

export type ArchetypeName = 'aggressive' | 'patient-counter' | 'bait' | 'defensive'

/** Checks one archetype file: a valid loadout, and a profile that parses and builds for it. */
export const loadArchetype = (file: string, raw: { loadout: unknown; profile: unknown }): Archetype => {
    if (!isValidLoadout(raw.loadout)) throw new Error(`profiles/${file}.json: invalid loadout`)
    try {
        const profile = parseProfile(raw.profile)
        adaptProfile(profile, raw.loadout)
        return { loadout: Object.freeze([...raw.loadout]), profile }
    } catch (error) {
        throw new Error(`profiles/${file}.json: ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
        })
    }
}

/** The checked-in archetypes, loaded and validated on import. */
export const ARCHETYPES: Readonly<Record<ArchetypeName, Archetype>> = {
    aggressive: loadArchetype('aggressive', aggressive),
    'patient-counter': loadArchetype('patient-counter', patientCounter),
    bait: loadArchetype('bait', bait),
    defensive: loadArchetype('defensive', defensive),
}

export const ARCHETYPE_NAMES = Object.keys(ARCHETYPES) as ArchetypeName[]

/** An entrant playing archetype `name` with its own loadout. */
export const archetypeEntrant = (name: ArchetypeName): Entrant =>
    profileEntrant(ARCHETYPES[name].profile, ARCHETYPES[name].loadout)
