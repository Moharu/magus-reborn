import type { SpellId } from '@magus/engine'
import type { Action, ArenaView, ControllerFactory, Entrant } from '../src'
import { idle, priority } from '../src'

export const METEOR_LOADOUT: SpellId[] = [
    'SPELL_METEOR',
    'SPELL_FIREBALL',
    'SPELL_IGNITE',
    'SPELL_COMBUSTION',
    'SPELL_COUNTERSPELL',
    'SPELL_HASTE',
    'SPELL_BLUR',
]
/** Shares no element or general spell with METEOR_LOADOUT except Fireball, Ignite and Counterspell. */
export const OTHER_LOADOUT: SpellId[] = [
    'SPELL_FIREBALL',
    'SPELL_IGNITE',
    'SPELL_LIVING_BOMB',
    'SPELL_AFTERBURN',
    'SPELL_COUNTERSPELL',
    'SPELL_TEMPORAL_SHIELD',
    'SPELL_MAGIC_EATER',
]

export const slotOf = (loadout: readonly SpellId[], id: SpellId) => loadout.indexOf(id)

export const entrant = (name: string, controller: ControllerFactory, loadout = METEOR_LOADOUT): Entrant => ({
    name,
    loadout,
    controller,
})

export const idler = (loadout = METEOR_LOADOUT) => entrant('Idle', idle(), loadout)
export const only = (id: SpellId, loadout = METEOR_LOADOUT) => entrant(id, priority({ order: [id] }), loadout)

/** Plays `script[tick]` on that tick and nothing else. */
export const scripted =
    (script: Record<number, Action | Action[]>): ControllerFactory =>
    () =>
    ({ tick }) =>
        script[tick] ?? null

/** Wraps a factory so the controller sees every view; `seen` collects a deep copy per tick. */
export const recording =
    (inner: ControllerFactory, seen: ArenaView[]): ControllerFactory =>
    init => {
        const decide = inner(init)
        return view => {
            seen.push(JSON.parse(JSON.stringify(view)) as ArenaView)
            return decide(view)
        }
    }
