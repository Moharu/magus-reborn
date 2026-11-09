import type { SpellId } from '@magus/engine'
import { priority } from './controllers'
import type { Entrant } from './types'

const AGGRESSOR_LOADOUT: SpellId[] = [
    'SPELL_METEOR',
    'SPELL_FIREBALL',
    'SPELL_IGNITE',
    'SPELL_COMBUSTION',
    'SPELL_COUNTERSPELL',
    'SPELL_HASTE',
    'SPELL_BLUR',
]

const COUNTER_LOADOUT: SpellId[] = [
    'SPELL_FIREBALL',
    'SPELL_IGNITE',
    'SPELL_COMBUSTION',
    'SPELL_AFTERBURN',
    'SPELL_COUNTERSPELL',
    'SPELL_HASTE',
    'SPELL_TEMPORAL_SHIELD',
]

/**
 * The two built-in example entrants `arena:match` plays: placeholders to exercise the runner until the behaviour
 * profiles of #102. Their jitter makes the seed matter.
 */
export const EXAMPLE_ENTRANTS: Readonly<Record<'aggressor' | 'counter', Entrant>> = {
    aggressor: {
        name: 'Aggressor',
        loadout: AGGRESSOR_LOADOUT,
        controller: priority({ releaseJitterTicks: 2 }),
    },
    counter: {
        name: 'Counter',
        loadout: COUNTER_LOADOUT,
        controller: priority({ releaseJitterTicks: 2, counter: { reactionTicks: 8, jitterTicks: 6 } }),
    },
}
