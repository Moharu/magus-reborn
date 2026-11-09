import { FIXED_SPELL, secondsToTicks, SPELLS, toCenti, type SpellId } from '@magus/engine'
import { adaptProfile } from './adapt'
import { chillingAfter, hasChillingSource } from './chilling'
import { allHold, type Condition, type ConditionInput, type OwnRelease } from './conditions'
import { countAfterRelease, EFFECT_SOURCES } from './effects'
import { ownHits } from './own-hits'
import { spellValues } from './threat'
import { start, stop } from './controllers'
import {
    EDGE_GREED_MAX_SECONDS,
    GENERAL_SPELLS,
    GIVE_UP_MAX_SECONDS,
    LETHAL_MARGIN_MAX_HP,
    RELEASE_HOLD_MAX_SECONDS,
    type GeneralSpell,
    type Profile,
} from './profile'
import type { Action, ArenaView, ControllerFactory, Decision, Entrant, OwnCastView, SpellView } from './types'

const NONE = -1

/** The debuffs a recast replaces (`unique` in `EFFECT_SOURCES`): Living Bomb, Frost Bomb, Frost Fever. */
const UNIQUE_DEBUFFS = (Object.keys(EFFECT_SOURCES) as (keyof typeof EFFECT_SOURCES)[]).filter(
    id => EFFECT_SOURCES[id].unique && EFFECT_SOURCES[id].on === 'target',
)

/**
 * Counterspell's cooldown in ticks, from the public spell data a client shows (not from the opponent's state, which the
 * view never has). With the tick an enemy Counterspell was seen used, it gives when that Counterspell is ready again.
 */
const COUNTER_COOLDOWN = secondsToTicks(SPELLS[FIXED_SPELL].cooldownSeconds ?? 0)

/** A give-up timer in ticks, clamped to the loader's range; NONE when it is off (null or absent). */
const giveUpTicks = (seconds: number | null | undefined) =>
    typeof seconds === 'number' && Number.isFinite(seconds)
        ? secondsToTicks(Math.min(GIVE_UP_MAX_SECONDS, Math.max(0, seconds)))
        : NONE

/**
 * The controller a profile plays, on the profile built for its loadout (`adaptProfile`, #136). Each tick, from that
 * player's `ArenaView` only (and its own memory and seeded stream), it decides in this order:
 *   1. its own cast: cancel a fake cast once `fakeCast.cancelAfterSeconds` has passed, or release a completed cast
 *      (unless `releaseHold` keeps it on the bar, #143);
 *   2. Counterspell: land a committed interrupt (see below);
 *   3. the next cast, if it has none in progress, isn't pausing after a fake and didn't press Counterspell this tick
 *      (it waits one tick to see on the view whether the lock landed): in the free-cast window (below), the first
 *      `lockoutWindow.rotation` entry that is ready, whose `when` holds and that fits the window (or its edge-greed
 *      bound), or none; else nothing while it waits for the opponent to commit (`patience.commitGiveUpSeconds`, only
 *      while its own Counterspell is off cooldown, see `waitingForCommit`);
 *      else a bait when `fakeCast` allows one (a fake, or a real low-priority cast, see `realBaitShare`), else the
 *      first rotation entry whose spell is ready and whose `when` holds. With none (outside the window), once it has
 *      had no cast in progress or started for `patience.thresholdGiveUpSeconds`, it gives up waiting: the first
 *      rotation entry that is ready, whatever its `when`;
 *   4. general spells, in loadout order: each one that is ready and whose rule holds (`nextCastIs` sees step 3);
 *   5. starts the cast chosen in step 3, after the general spells, so Haste applies to it.
 * A general spell used while a cast is in progress cancels that cast, like any instant: rules that must not do that
 * say `selfNotCasting`.
 *
 * Counterspell targets (#143): an enemy cast is a target when its spell's value, learned from the view by
 * `spellValues` (the damage its casts have dealt this player so far, or for a spell not yet seen to deal any, its
 * public base cast time times `counterspell.unseenValuePerSecond`), is at least `counterspell.minValue` and at least
 * `counterspell.bestShare` times the best value among the spells the opponent has been seen casting.
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
 * Counterspell give-up (#136): once its Counterspell has been off cooldown for `counterspell.giveUpSeconds` unused,
 * the next enemy cast it sees is planned for as if it were a target. Ticks under an enemy Counterspell lock, when the
 * player can't act, count toward none of the give-up timers.
 *
 * A cast released in step 1 counts in this tick's effect conditions (#143): its effect is not on the view until the
 * next tick, so the effect counts add it (`countAfterRelease`), and a Living Bomb just released is not cast again.
 *
 * Own releases (`selfCastsAtLeast`) are the SPELL_RELEASEs on the player's own spell log (`self.log`), what the
 * engine did. A release sent this tick counts for this tick's decisions, then gives way to the log on the next view:
 * dropped if the engine rejected it (an enemy Counterspell acting first on that tick interrupted the cast).
 *
 * Frost (#150): Chilling is read from the view (`self.chilling`), plus what this tick's release adds or spends
 * (`chillingAfter`), for the Chilling conditions and for whether Icy Touch, which costs a stack, is ready. Icy Touch is
 * an instant on the GCD: started in step 5 like a cast, it releases at once and the GCD it starts shows on the view
 * as the other spells' `lockRemaining`, so the next cast waits for it. A real bait is never an instant (nothing to
 * counter). The threshold give-up never recasts a spell whose own unique debuff is still on the enemy (Frost Bomb,
 * Frost Fever, Living Bomb): a recast would replace it and lose what it has left.
 *
 * Nothing here depends on the side: player1 acting first within a tick is the runner's, and tournaments swap sides.
 */
export const profileController =
    (template: Profile): ControllerFactory =>
    ({ loadout, rng }) => {
        const profile = adaptProfile(template, loadout)
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

        // the loadout's longest casts by public base cast time (`nextCastIsLongest`)
        const castSeconds = (id: SpellId) => SPELLS[id].castSeconds ?? 0
        const longestSeconds = Math.max(0, ...loadout.map(castSeconds))
        const longest = longestSeconds > 0 ? loadout.filter(id => castSeconds(id) === longestSeconds) : []
        // own releases, oldest first (`selfCastsAtLeast`): those on the own spell log, then the one sent this tick
        const releases: OwnRelease[] = []
        // whether the last entry of `releases` is the one sent last tick, not yet read from the log; how much of the
        // own log has been read
        let provisional = false
        let ownLogRead = 0

        // give-up timers (#136), NONE when off
        const thresholdGiveUp = giveUpTicks(profile.patience?.thresholdGiveUpSeconds)
        const commitGiveUp = giveUpTicks(profile.patience?.commitGiveUpSeconds)
        const counterGiveUp = giveUpTicks(profile.counterspell.giveUpSeconds)

        const cs = profile.counterspell
        const csSlot = cs.enabled ? slotOf(FIXED_SPELL) : NONE
        // what each opponent spell is worth to counter, learned from the view (#143)
        const values = spellValues(cs.unseenValuePerSecond)
        /**
         * Whether an enemy cast of `spell` is worth a Counterspell (#143): see `CounterspellPolicy.minValue`. Compared
         * in centi-HP (AGENTS.md invariant 8), so a tie with the best value is a tie.
         */
        const isTarget = (spell: SpellId) => {
            const value = toCenti(values.valueOf(spell))
            return value >= toCenti(cs.minValue) && value >= Math.round(cs.bestShare * toCenti(values.best(spell)))
        }
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
        // the last tick the player had a cast in progress or started one, or the first tick it saw (threshold give-up)
        let lastBusy = NONE
        // the tick the current wait for the opponent to commit started: the match start, or the end of the last window
        let commitWaitFrom = 0
        // since when our Counterspell has been off cooldown and unused (NONE: on cooldown), for its give-up
        let counterHeldSince = NONE
        // the tick our Counterspell was last seen come off cooldown (the match start until then), and whether it was
        // on cooldown on the last view: the commit wait runs from then too (#143)
        let counterBackAt = 0
        let counterCooling = false

        /**
         * Whether the wait for the opponent to commit still runs (#143). It runs only while the player's own
         * Counterspell is off cooldown, ready to answer the commit (a wait with it on cooldown only hands the enemy
         * free time), and lasts `commitGiveUp` from the later of the end of the last window (or the match start) and
         * the tick its Counterspell was seen come off cooldown. A profile that never counters waits from the window's
         * end.
         */
        const waitingForCommit = (self: ArenaView['self'], tick: number) => {
            if (csSlot === NONE) return tick - commitWaitFrom < commitGiveUp
            if (self.spells[csSlot].cooldownRemaining > 0) return false
            return tick - Math.max(commitWaitFrom, counterBackAt) < commitGiveUp
        }

        // holding a completed cast (#143): while `releaseHold.when` holds, for at most this many ticks past completion
        const hold = profile.releaseHold
        const holdTicks =
            hold && Number.isFinite(hold.giveUpSeconds)
                ? secondsToTicks(Math.min(RELEASE_HOLD_MAX_SECONDS, Math.max(0, hold.giveUpSeconds)))
                : 0
        // the lethal check's margin in centi-HP (NONE: off), and the expected hits of the own casts
        const lethalMargin =
            hold?.lethalMarginHp !== undefined && Number.isFinite(hold.lethalMarginHp)
                ? toCenti(Math.min(LETHAL_MARGIN_MAX_HP, Math.max(0, hold.lethalMarginHp)))
                : NONE
        const hits = ownHits(loadout)

        // Chilling (#150): what each slot's spell costs, and whether the loadout can build stacks at all
        const costs = loadout.map(id => SPELLS[id].chillingCost ?? 0)
        const chillingSource = hasChillingSource(loadout)
        // the stacks after this tick's release, set each tick
        let chillingNow = 0
        /**
         * Whether the engine accepts `slot` this tick: the view's `ready`, except for a spell that costs Chilling, whose
         * stacks are those this tick's release leaves (the view shows them from before it).
         */
        const isReady = (spells: readonly SpellView[], slot: number) => {
            const spell = spells[slot]
            if (costs[slot] === 0) return spell.ready
            return spell.cooldownRemaining === 0 && spell.lockRemaining === 0 && chillingNow >= costs[slot]
        }
        /** The unique debuff `slot`'s spell puts on the enemy is on it (this tick's release included): a recast replaces it. */
        const ownUniqueUp = (enemy: ArenaView['enemy'], slot: number) => {
            for (const effect of UNIQUE_DEBUFFS) {
                if (EFFECT_SOURCES[effect].spell !== loadout[slot]) continue
                let shown = 0
                for (const e of enemy.effects) if (e.id === effect) shown += 1
                if (countAfterRelease(shown, effect, 'enemy', input.released) > 0) return true
            }
            return false
        }

        const actions: Action[] = []
        const input: {
            view: ArenaView
            casting: boolean
            nextCast: SpellId | null
            longest: readonly SpellId[]
            releases: readonly OwnRelease[]
            window: boolean
            released: SpellId | null
            chilling: number
            chillingSource: boolean
        } = {
            view: null as unknown as ArenaView,
            casting: false,
            nextCast: null,
            longest,
            releases,
            window: false,
            released: null,
            chilling: 0,
            chillingSource,
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
        /**
         * Whether to keep the own cast that completed on `completesAt` on the bar this tick rather than release it
         * (#143): within `holdTicks` of the completion, while `releaseHold.when` holds (read as still casting), unless
         * the cast would kill (`releaseHold.lethalMarginHp`).
         */
        const holding = (own: OwnCastView, enemyHp: number, tick: number) => {
            if (!hold || tick - own.completesAt >= holdTicks) return false
            // a lethal hit needs no hold (#146 review): death is final, a rewind can't undo it
            if (lethalMargin !== NONE && toCenti(enemyHp) <= hits.predict(own.slot) + lethalMargin) return false
            input.casting = true
            return holds(hold.when)
        }
        /** The first window entry that is ready, whose `when` holds and that releases before `bound`, or NONE. */
        const windowCast = (self: ArenaView['self'], tick: number, bound: number) => {
            for (const entry of windowRotation) {
                if (
                    isReady(self.spells, entry.slot) &&
                    holds(entry.when) &&
                    releaseTick(self, entry.slot, tick) < bound
                )
                    return entry.slot
            }
            return NONE
        }

        return (view): Decision => {
            const { tick, self, enemy } = view
            actions.length = 0
            values.observe(view)
            hits.observe(view)
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
            // a release sent is only queued (an enemy Counterspell acting first in that tick interrupts the cast and the
            // engine rejects the stopCast): the own spell log says what happened
            if (provisional) {
                releases.pop()
                provisional = false
            }
            const ownLog = self.log ?? []
            for (; ownLogRead < ownLog.length; ownLogRead++) {
                const entry = ownLog[ownLogRead]
                if (entry.type === 'SPELL_RELEASE') releases.push({ spellId: entry.spellId, tick: entry.tick })
            }
            // what the enemy's spell log shows (#126): every Counterspell it used, a whiff included
            for (; logRead < enemy.log.length; logRead++) {
                const entry = enemy.log[logRead]
                if (entry.type === 'SPELL_RELEASE' && entry.spellId === FIXED_SPELL && entry.tick > enemyCounterAt)
                    enemyCounterAt = entry.tick
            }
            // the enemy can't Counterspell before this tick: its lock, or its Counterspell's cooldown
            const safeUntil = Math.max(enemy.lockedUntil, enemyCounterAt + COUNTER_COOLDOWN)
            input.window = tick < safeUntil
            // the window is open: a new wait for the opponent to commit starts when it ends
            if (tick < safeUntil) commitWaitFrom = safeUntil
            if (self.casting || lastBusy === NONE) lastBusy = tick
            if (csSlot !== NONE) {
                const cooling = self.spells[csSlot].cooldownRemaining > 0
                if (counterCooling && !cooling) counterBackAt = tick
                counterCooling = cooling
            }
            // under a Counterspell lock the player can't act: those ticks don't count toward its give-up timers
            if (self.lockedUntil > tick) {
                lastBusy += 1
                // inside a safe window the wait is already set to start when the window ends: only locked ticks from
                // then on postpone it (counting the window's own locked ticks too would start it one tick late)
                if (tick >= safeUntil) {
                    commitWaitFrom += 1
                    counterBackAt += 1
                }
                if (counterHeldSince !== NONE) counterHeldSince += 1
            }
            released = false
            input.released = null
            // before step 1's release: the stacks the view shows
            chillingNow = self.chilling ?? 0
            input.chilling = chillingNow
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
                } else if (tick >= own.completesAt && !holding(own, enemy.hp, tick)) {
                    actions.push(stop(own.slot))
                    casting = false
                    released = true
                    input.released = own.spellId
                    releases.push({ spellId: own.spellId, tick })
                    provisional = true
                }
            }

            // Chilling once this tick's release has gone off (#150)
            chillingNow = released ? chillingAfter(input.released!, self.chilling ?? 0) : (self.chilling ?? 0)
            input.chilling = chillingNow

            // 2. Counterspell
            if (csSlot !== NONE) {
                const seen = enemy.casting
                if (self.spells[csSlot].cooldownRemaining > 0) counterHeldSince = NONE
                else if (counterHeldSince === NONE) counterHeldSince = tick
                // held unused for its give-up time: the next cast is a target whatever its spell
                const anyCast =
                    counterGiveUp !== NONE && counterHeldSince !== NONE && tick - counterHeldSince >= counterGiveUp
                if (seen && seen.startTick !== planFor) {
                    planFor = seen.startTick
                    planReaction = NONE
                    if (anyCast || isTarget(seen.spellId)) {
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
                        counterHeldSince = NONE
                    }
                }
            }

            // 3. the next cast
            input.casting = casting
            let next = NONE
            let isFake = false
            let isBait = false
            let waiting = false
            if (!casting && tick >= pauseUntil && !countered) {
                if (tick < safeUntil) {
                    // the free-cast window: nothing to bait, and only casts released before the enemy can counter
                    next = windowCast(self, tick, safeUntil)
                    // edge greed (#126): with nothing safe, a cast that releases up to `edgeGreed` ticks later
                    if (next === NONE && edgeGreed > 0) next = windowCast(self, tick, safeUntil + edgeGreed)
                } else if (commitGiveUp !== NONE && waitingForCommit(self, tick)) {
                    // waiting for the opponent to commit: no cast, no bait, until the window opens or the timer ends
                    waiting = true
                } else if (
                    fakeSlot !== NONE &&
                    fakes < fake.maxPerMatch &&
                    tick - lastFake >= fakeGap &&
                    isReady(self.spells, fakeSlot) &&
                    holds(fake.when)
                ) {
                    isBait = true
                    // a real bait: the lowest-priority rotation entry that is ready and whose `when` holds, a cast
                    // (an instant such as Icy Touch shows no cast to counter, #150)
                    if (realShare >= 1 || (realShare > 0 && rng.next() < realShare)) {
                        for (let i = rotation.length - 1; i >= 0; i--) {
                            const entry = rotation[i]
                            if (castSeconds(entry.spell) === 0) continue
                            if (isReady(self.spells, entry.slot) && holds(entry.when)) {
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
                        if (isReady(self.spells, entry.slot) && holds(entry.when)) {
                            next = entry.slot
                            break
                        }
                    }
                }
            }
            // the threshold give-up: idle for its time with nothing whose `when` holds, cast anything ready (not in the
            // free-cast window, whose wait ends with it)
            if (
                next === NONE &&
                !waiting &&
                tick >= safeUntil &&
                !casting &&
                tick >= pauseUntil &&
                !countered &&
                thresholdGiveUp !== NONE &&
                tick - lastBusy >= thresholdGiveUp
            ) {
                // never a recast that would replace the own unique debuff still on the enemy (#150: Frost Bomb)
                for (const entry of rotation) {
                    if (isReady(self.spells, entry.slot) && !ownUniqueUp(enemy, entry.slot)) {
                        next = entry.slot
                        break
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
                lastBusy = tick
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

/** An entrant that plays `profile`, built for `loadout` (`adaptProfile`, which throws at once if it can't be). */
export const profileEntrant = (profile: Profile, loadout: readonly SpellId[], name = profile.name): Entrant => {
    adaptProfile(profile, loadout)
    return { name, loadout, controller: profileController(profile) }
}
