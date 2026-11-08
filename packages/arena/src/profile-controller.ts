import { FIXED_SPELL, secondsToTicks, type SpellId } from '@magus/engine'
import { allHold, type Condition, type ConditionInput } from './conditions'
import { start, stop } from './controllers'
import { checkLoadout, GENERAL_SPELLS, type GeneralSpell, type Profile } from './profile'
import type { Action, ArenaView, ControllerFactory, Decision, Entrant } from './types'

const NONE = -1

/**
 * The controller a profile plays. Each tick, from that player's `ArenaView` only (and its own memory and seeded
 * stream), it decides in this order:
 *   1. its own cast: cancel a fake cast once `fakeCast.cancelAfterSeconds` has passed, or release a completed cast;
 *   2. Counterspell: land a committed interrupt (see below);
 *   3. the next cast, if it has none in progress and isn't pausing after a fake: a fake cast when `fakeCast` allows
 *      one, else the first rotation entry whose spell is ready and whose `when` holds;
 *   4. general spells, in loadout order: each one that is ready and whose rule holds (`nextCastIs` sees step 3);
 *   5. starts the cast chosen in step 3, after the general spells, so Haste applies to it.
 * A general spell used while a cast is in progress cancels that cast, like any instant: rules that must not do that
 * say `selfNotCasting`.
 *
 * Counterspell model: for each targeted enemy cast it sees, the player samples a reaction time and picks a decision
 * tick (`early`: the first tick the cast is visible; `late`: the first tick the cast is within `lateWindowSeconds` of
 * its release, moved with the release if the visible cast time changes, as when Haste expires mid-cast). From that tick on, while the cast is still on the bar, it commits as soon as Counterspell will be
 * ready one reaction later; the Counterspell then lands one reaction after the commit whatever the enemy does
 * meanwhile, because it can't tell a fake cast from a real one, nor react to the cancel faster than to the cast. A fake cancelled after the commit and before the landing
 * wastes the Counterspell; one cancelled before the commit is seen in time and not interrupted.
 *
 * Nothing here depends on the side: player1 acting first within a tick is the runner's, and tournaments swap sides.
 */
export const profileController =
    (profile: Profile): ControllerFactory =>
    ({ loadout, rng }) => {
        checkLoadout(profile, loadout)
        const slotOf = (id: SpellId) => loadout.indexOf(id)
        const rotation = profile.rotation.map(entry => ({ ...entry, slot: slotOf(entry.spell) }))
        const generals: { slot: number; when: readonly Condition[] }[] = []
        loadout.forEach((id, slot) => {
            const rule = (GENERAL_SPELLS as readonly SpellId[]).includes(id) && profile.generals[id as GeneralSpell]
            if (rule && rule !== 'never') generals.push({ slot, when: rule.when })
        })

        const cs = profile.counterspell
        const csSlot = cs.enabled && cs.targets.length > 0 ? slotOf(FIXED_SPELL) : NONE
        const lateWindow = secondsToTicks(cs.lateWindowSeconds)
        const { meanSeconds, spreadSeconds } = cs.reaction
        const sampleReaction = () => {
            const seconds = spreadSeconds > 0 ? meanSeconds + spreadSeconds * (2 * rng.next() - 1) : meanSeconds
            return secondsToTicks(Math.max(0, seconds))
        }

        const fake = profile.fakeCast
        const fakeSlot = fake.enabled && fake.maxPerMatch > 0 ? slotOf(fake.spell) : NONE
        const cancelAfter = secondsToTicks(fake.cancelAfterSeconds)
        const fakeGap = secondsToTicks(fake.minGapSeconds)
        const fakePause = secondsToTicks(fake.pauseAfterSeconds)

        // the enemy cast last planned for (its start tick); the plan's sampled reaction (NONE: no plan) and decision tick
        let planFor = NONE
        let planReaction = NONE
        let decideAt = NONE
        // the enemy cast's release tick when the plan was made or last moved
        let planCompletesAt = NONE
        // a committed Counterspell: it lands on this tick whatever the enemy does meanwhile
        let pressAt = NONE
        // fake casts: the start tick of the one in progress, the last one's start, how many so far
        let fakeStart = NONE
        let lastFake = -Infinity
        let fakes = 0
        // no cast starts before this tick: the pause after a fake cast's cancel
        let pauseUntil = NONE

        const actions: Action[] = []
        const input: { view: ArenaView; casting: boolean; nextCast: SpellId | null } = {
            view: null as unknown as ArenaView,
            casting: false,
            nextCast: null,
        }
        const holds = (when: readonly Condition[]) => allHold(when, input as ConditionInput)

        return (view): Decision => {
            const { tick, self, enemy } = view
            actions.length = 0
            input.view = view
            input.nextCast = null
            let casting = self.casting !== null

            // 1. own cast
            const own = self.casting
            if (own) {
                if (own.startTick === fakeStart) {
                    if (tick >= Math.min(own.startTick + cancelAfter, own.completesAt - 1)) {
                        actions.push(stop(own.slot))
                        casting = false
                        pauseUntil = tick + fakePause
                    }
                } else if (tick >= own.completesAt) {
                    actions.push(stop(own.slot))
                    casting = false
                }
            }

            // 2. Counterspell
            if (csSlot !== NONE) {
                const seen = enemy.casting
                if (seen && seen.startTick !== planFor) {
                    planFor = seen.startTick
                    planReaction = NONE
                    if (cs.targets.includes(seen.spellId)) {
                        planReaction = sampleReaction()
                        planCompletesAt = seen.completesAt
                        decideAt = cs.timing === 'early' ? tick : Math.max(tick, seen.completesAt - lateWindow)
                    }
                } else if (
                    cs.timing === 'late' &&
                    planReaction !== NONE &&
                    seen?.startTick === planFor &&
                    seen.completesAt !== planCompletesAt
                ) {
                    // the same cast now completes at another tick (Haste expired mid-cast): move the window with it,
                    // keeping the reaction already drawn for this cast
                    planCompletesAt = seen.completesAt
                    decideAt = Math.max(tick, seen.completesAt - lateWindow)
                }
                if (planReaction !== NONE && tick >= decideAt) {
                    // a cast that left the bar before the decision was seen in time: nothing to interrupt
                    if (seen?.startTick !== planFor) planReaction = NONE
                    else if (pressAt === NONE) {
                        const counter = self.spells[csSlot]
                        // commit only if Counterspell will be ready when it lands; else try again next tick
                        if (Math.max(counter.cooldownRemaining, counter.lockRemaining) <= planReaction) {
                            pressAt = tick + planReaction
                            planReaction = NONE
                        }
                    }
                }
                if (pressAt !== NONE && tick >= pressAt) {
                    pressAt = NONE
                    if (self.spells[csSlot].ready) {
                        actions.push(start(csSlot))
                        casting = false
                    }
                }
            }

            // 3. the next cast
            input.casting = casting
            let next = NONE
            let isFake = false
            if (!casting && tick >= pauseUntil) {
                if (
                    fakeSlot !== NONE &&
                    fakes < fake.maxPerMatch &&
                    tick - lastFake >= fakeGap &&
                    self.spells[fakeSlot].ready &&
                    holds(fake.when)
                ) {
                    next = fakeSlot
                    isFake = true
                } else {
                    for (const entry of rotation) {
                        if (self.spells[entry.slot].ready && holds(entry.when)) {
                            next = entry.slot
                            break
                        }
                    }
                }
            }
            // a fake cast is not a cast `nextCastIs` rules prepare for (no Haste or Magic Eater wasted on a bait)
            input.nextCast = next === NONE || isFake ? null : loadout[next]

            // 4. general spells
            for (const general of generals) {
                if (!self.spells[general.slot].ready || !holds(general.when)) continue
                actions.push(start(general.slot))
                // an instant cancels a cast in progress
                input.casting = false
            }

            // 5. start the next cast
            if (next !== NONE) {
                actions.push(start(next))
                if (isFake) {
                    fakeStart = lastFake = tick
                    fakes += 1
                } else fakeStart = NONE
            }

            if (actions.length === 0) return null
            return actions.length === 1 ? actions[0] : actions
        }
    }

/** An entrant that plays `profile` with `loadout`; throws at once if the profile doesn't fit the loadout. */
export const profileEntrant = (profile: Profile, loadout: readonly SpellId[], name = profile.name): Entrant => {
    checkLoadout(profile, loadout)
    return { name, loadout, controller: profileController(profile) }
}
