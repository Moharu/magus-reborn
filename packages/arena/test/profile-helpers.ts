import type { SpellId } from '@magus/engine'
import type { Action, ArenaView, Decision } from '../src'

/** A JSON profile that never casts and never counters: tests switch on only what they need. */
export const quietProfile = () => ({
    name: 'quiet',
    intent: 'Does nothing unless a test turns something on.',
    // never true: HP is never below 0
    rotation: [{ spell: 'SPELL_FIREBALL', when: [{ type: 'selfHpBelow', hp: 0 }] }] as unknown[],
    /** Absent by default: the loader then uses a copy of `rotation`. */
    lockoutWindow: undefined as unknown,
    counterspell: {
        enabled: false,
        // #143: only casts worth 15+ HP: an unseen Meteor (3.6 s x 6 HP/s), not a Fireball, an Ignite or a Combustion
        minValue: 15,
        bestShare: 0,
        unseenValuePerSecond: 6,
        reaction: { meanSeconds: 0.4, spreadSeconds: 0 },
        timing: 'early' as 'early' | 'late',
        lateWindowSeconds: 0,
    },
    fakeCast: {
        enabled: false,
        spell: 'SPELL_METEOR' as SpellId,
        cancelAfterSeconds: 0.25,
        pauseAfterSeconds: 0,
        minGapSeconds: 12,
        maxPerMatch: 1,
        when: [] as unknown[],
    },
    generals: {
        SPELL_HASTE: 'never',
        SPELL_TEMPORAL_SHIELD: 'never',
        SPELL_MAGIC_EATER: 'never',
        SPELL_BLUR: 'never',
    } as Record<string, unknown>,
})

export type RawProfile = ReturnType<typeof quietProfile>

/** The actions of a decision as a fresh array. */
export const actionsOf = (decision: Decision): Action[] =>
    decision === null ? [] : Array.isArray(decision) ? [...(decision as Action[])] : [decision as Action]

/** Whether `action` is one the view says the engine accepts: a ready spell, or stopping the own cast in progress. */
export const legalFor = (view: ArenaView, action: Action) =>
    action.type === 'start' ? view.self.spells[action.slot]?.ready === true : view.self.casting?.slot === action.slot
