import { FIXED_SPELL, secondsToTicks, SPELLS, type SpellId } from '@magus/engine'
import { allHold, type Condition, type ConditionInput } from './conditions'
import { start, stop } from './controllers'
import { checkLoadout, EDGE_GREED_MAX_SECONDS, GENERAL_SPELLS, type GeneralSpell, type Profile } from './profile'
import type { Action, ArenaView, ControllerFactory, Decision, Entrant } from './types'

const NONE = -1

/**
 * Counterspell's cooldown in ticks, from the public spell data a client shows (not from the opponent's state, which the
 * view never has). With the tick an enemy Counterspell was seen used, it gives when that Counterspell is ready again.
 */
const COUNTER_COOLDOWN = secondsToTicks(SPELLS[FIXED_SPELL].cooldownSeconds ?? 0)

/**
 * The controller a profile plays. Each tick, from that player's `ArenaView` only (and its own memory and seeded
 * stream), it decides in this order:
 *   1. its own cast: cancel a fake cast once `fakeCast.cancelAfterSeconds` has passed, or release a completed cast;
 *   2. Counterspell: land a committed interrupt (see below);
 *   3. the next cast, if it has none in progress, isn't pausing after a fake and didn't press Counterspell this tick
 *      (it waits one tick to see on the view whether the lock landed): in the free-cast window (below), the first
 *      `lockoutWindow.rotation` entry that is ready, whose `when` holds and that fits the window (or its edge-greed
 *      bound), or none; else a bait when `fakeCast` allows one (a fake, or a real low-priority cast, see
 *      `realBaitShare`), else the first rotation entry whose spell is ready and whose `when` holds;
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
 * Free-cast window (#123), from the view only: the enemy can't Counterspell before tick `safeUntil`, the later of
 * `enemy.lockedUntil` (our Counterspell landed) and the tick its own Counterspell is ready again: the latest tick it was
 * seen used plus Counterspell's public cooldown. It is seen used in the enemy's spell log (#126), whether it interrupted
 * us or hit an empty cast bar (a whiff, as after a fake cast), and when it landed, also by the `DEBUFF_COUNTERSPELL` on
 * our buff bar, which starts on that tick. Never seen, it is taken as ready. A cast fits when its release tick is
 * before `safeUntil`: on tick `safeUntil` the enemy may act first (as player1) and interrupt it. The release tick
 * allows for Haste running out first (see `releaseTick`). With no entry fitting and `lockoutWindow.edgeGreedSeconds`
 * above 0 (#126), the entries are tried again against `safeUntil` plus that much.
 *
 * Nothing here depends on the side: player1 acting first within a tick is the runner's, and tournaments swap sides.
 */
export const profileController =
    (profile: Profile): ControllerFactory =>
    ({ loadout, rng }) => {
        checkLoadout(profile, loadout)
        const slotOf = (id: SpellId) => loadout.indexOf(id)
        const rotation = profile.rotation.map(entry => ({ ...entry, slot: slotOf(entry.spell) }))
        const windowRotation = profile.lockoutWindow.rotation.map(entry => ({ ...entry, slot: slotOf(entry.spell) }))
        // edge greed (#126): how far past `safeUntil` a window cast may release when none fits before it; clamped
        const greedSeconds = profile.lockoutWindow.edgeGreedSeconds ?? 0
        const edgeGreed = Number.isFinite(greedSeconds)
            ? secondsToTicks(Math.min(EDGE_GREED_MAX_SECONDS, Math.max(0, greedSeconds)))
            : 0
        // each slot's cast time without Haste, read from the view whenever no Haste is on (always so on tick 0); until
        // then unknown, so a cast whose Haste may run out never fits the window
        const baseCast = loadout.map(() => Infinity)
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
        const realShare = fake.realBaitShare

        // the enemy cast last planned for (its start tick); the plan's sampled reaction (NONE: no plan) and decision tick
        let planFor = NONE
        let planReaction = NONE
        let decideAt = NONE
        // the enemy cast's release tick when the plan was made or last moved
        let planCompletesAt = NONE
        // a committed Counterspell: it lands on this tick whatever the enemy does meanwhile
        let pressAt = NONE
        // baits (fake casts and real ones): the start tick of the fake in progress, the last bait's start, how many so far
        let fakeStart = NONE
        let lastFake = -Infinity
        let fakes = 0
        // the latest tick an enemy Counterspell was seen used (landed on this player or whiffed), and how much of the
        // enemy's spell log has been read
        let enemyCounterAt = -Infinity
        let logRead = 0
        // no cast starts before this tick: the pause after a fake cast's cancel
        let pauseUntil = NONE

        const actions: Action[] = []
        const input: { view: ArenaView; casting: boolean; nextCast: SpellId | null } = {
            view: null as unknown as ArenaView,
            casting: false,
            nextCast: null,
        }
        const holds = (when: readonly Condition[]) => allHold(when, input as ConditionInput)

        // this tick's Haste end on the buff bar (NONE: no Haste), and whether step 1 released a cast
        let hasteEnds = NONE
        let released = false
        /**
         * The release tick of `slot`'s cast started on `tick`: the cast time the view shows, or the un-hasted one when
         * the Haste on won't last to the release, because it ends first or this tick's release of the previous cast
         * uses it up (the engine then restores the longer cast time).
         */
        const releaseTick = (self: ArenaView['self'], slot: number, tick: number) => {
            const castTime = self.spells[slot].castTime
            const unhasted = hasteEnds !== NONE && (released || hasteEnds <= tick + castTime)
            return tick + (unhasted ? baseCast[slot] : castTime)
        }
        /** The first window entry that is ready, whose `when` holds and that releases before `bound`, or NONE. */
        const windowCast = (self: ArenaView['self'], tick: number, bound: number) => {
            for (const entry of windowRotation) {
                if (self.spells[entry.slot].ready && holds(entry.when) && releaseTick(self, entry.slot, tick) < bound)
                    return entry.slot
            }
            return NONE
        }

        return (view): Decision => {
            const { tick, self, enemy } = view
            actions.length = 0
            input.view = view
            input.nextCast = null
            let casting = self.casting !== null

            // what the buff bar shows: an enemy Counterspell that landed (its lock), and Haste's end
            hasteEnds = NONE
            for (const effect of self.effects) {
                if (effect.id === 'DEBUFF_COUNTERSPELL' && effect.startingTick > enemyCounterAt)
                    enemyCounterAt = effect.startingTick
                else if (effect.id === 'BUFF_HASTE') hasteEnds = effect.expiresAt
            }
            if (hasteEnds === NONE) for (let i = 0; i < baseCast.length; i++) baseCast[i] = self.spells[i].castTime
            // what the enemy's spell log shows (#126): every Counterspell it used, a whiff included
            for (; logRead < enemy.log.length; logRead++) {
                const entry = enemy.log[logRead]
                if (entry.type === 'SPELL_RELEASE' && entry.spellId === FIXED_SPELL && entry.tick > enemyCounterAt)
                    enemyCounterAt = entry.tick
            }
            // the enemy can't Counterspell before this tick: its lock, or its Counterspell's cooldown
            const safeUntil = Math.max(enemy.lockedUntil, enemyCounterAt + COUNTER_COOLDOWN)
            released = false
            let countered = false

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
                    released = true
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
                        countered = true
                    }
                }
            }

            // 3. the next cast
            input.casting = casting
            let next = NONE
            let isFake = false
            let isBait = false
            if (!casting && tick >= pauseUntil && !countered) {
                if (tick < safeUntil) {
                    // the free-cast window: nothing to bait, and only casts released before the enemy can counter
                    next = windowCast(self, tick, safeUntil)
                    // edge greed (#126): with nothing safe, a cast that releases up to `edgeGreed` ticks later
                    if (next === NONE && edgeGreed > 0) next = windowCast(self, tick, safeUntil + edgeGreed)
                } else if (
                    fakeSlot !== NONE &&
                    fakes < fake.maxPerMatch &&
                    tick - lastFake >= fakeGap &&
                    self.spells[fakeSlot].ready &&
                    holds(fake.when)
                ) {
                    isBait = true
                    // a real bait: the lowest-priority rotation entry that is ready and whose `when` holds
                    if (realShare >= 1 || (realShare > 0 && rng.next() < realShare)) {
                        for (let i = rotation.length - 1; i >= 0; i--) {
                            const entry = rotation[i]
                            if (self.spells[entry.slot].ready && holds(entry.when)) {
                                next = entry.slot
                                break
                            }
                        }
                    }
                    if (next === NONE) {
                        next = fakeSlot
                        isFake = true
                    }
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
                fakeStart = isFake ? tick : NONE
                if (isBait) {
                    lastFake = tick
                    fakes += 1
                }
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
