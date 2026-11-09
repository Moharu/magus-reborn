# @magus/arena

Headless AI-vs-AI matches on the real battle engine (`@magus/engine`). One match is best-of-1, 100 HP, to the death,
with a time cap that counts as a draw. Behaviour profiles (#102), tournaments (#103), self-tuning (#104) and the
workflow and report (#105) build on this package.

```sh
npm run arena:match -- --seed 1          # summary of one match between the two built-in example entrants
npm run arena:match -- --seed 1 --log    # the full match log, then the summary
npm run arena:match -- --seed 1 --max-ticks 600
npm run arena:match -- --seed 1 --a bait --b patient-counter   # two archetypes from profiles/
npm run arena -- --mode strategy --seed 1 --report report.md  # strategy tournament on mirror setups (#137)
npm run arena -- --top 8 --games 2 --seed 1 --report report.md  # round-robin, ranked by win rate; the report (#103, #105)
npm run arena:tune -- --top 2 --general-pairs 1 --population 6 --generations 4 --seed 1 --out best.json   # self-tuning (#104)
```

## Rules the arena keeps

- It drives the engine only through `Battle.startCast`, `Battle.stopCast` and `Battle.tick()`. Nothing under `src/`
  imports a spell module or computes damage, cooldowns or cast times: readiness comes from the engine's
  `cooldownRemaining` and `lockRemaining`, and GCD, Counterspell lock, cast cancelling and death are the engine's. The
  one estimate a profile makes is what a player would: when the opponent's Counterspell is ready again, from the tick
  it was seen used (on the opponent's spell log, or landing on us) plus Counterspell's public cooldown (`SPELLS`),
  since the view never shows the opponent's cooldowns (see the free-cast window below).
- Randomness comes only from the seeded PRNG in `src/prng.ts` (mulberry32). `packages/engine` stays deterministic and
  untouched. The same seed and inputs give an identical result and log.

## API

```ts
import { runMatch, priority, idle, formatLog } from '@magus/arena'

const result = runMatch({
    seed: 1, // integer in [0, 2^32)
    a: { name: 'A', loadout, controller: priority() },
    b: { name: 'B', loadout, controller: idle() },
    maxTicks: 3600, // optional, see below
    log: true, // optional, default true; false skips building the log
})
// result: { seed, winner: 'a' | 'b' | 'draw', reason: 'death' | 'mutual' | 'timeout', ticks, hp: { a, b }, stats, log }
```

`a` plays as the engine's `player1` and `b` as `player2`. Each loadout must be a valid loadout of one element, Fire or
Frost (the engine's `loadoutElement`, #150); the two players may play different elements.

### Controllers

```ts
type ControllerFactory = (init: { loadout: readonly SpellId[]; rng: Rng }) => Controller
type Controller = (view: ArenaView) => Action | readonly Action[] | null // Action = { type: 'start' | 'stop', slot }
```

The factory runs once per match, so per-match state lives in its closure. `rng` is the player's own stream, derived
from the match seed and the side, so one player's draws never shift the other's. The controller is called once per
tick. `start` calls `startCast(slot)` and `stop` calls `stopCast(slot)`, which releases a completed cast or cancels
one early (a fake cast). Use the shared `start(slot)`/`stop(slot)` helpers to avoid allocating an action per tick.

`ArenaView` is only what that player can see, the same as a real client (the server's opponent redaction, #86):

- `tick`
- `self`: `hp`, `casting` (`slot`, `spellId`, `startTick`, `castTime`, `completesAt`) or `null`, `gcdUntil`,
  `lockedUntil`, `chilling` (#150, Frost's Chilling stacks, as the HUD shows them), `effects`, `spells`, the player's own
  loadout with `castTime`, `cooldownRemaining`, `lockRemaining` and `ready` per slot (`ready` also needs the Chilling a
  spell costs: Icy Touch's one stack), and `log` (#136), the player's own spell log in the same form as `enemy.log`
  (its own casts released, cancelled or interrupted by the opponent), as the client's spell log shows it too. And
  `hpLog` (#146), its floating combat text: one `{ tick, amount, spellId, kind }` per HP change on the player, oldest
  first, from the engine's attributed HP events, which the server streams to both clients (`events` of each `battle`
  message). `spellId` is the spell the change came from, `kind` is `spell` (a release) or `effect` (a tick, a burst, a
  heal). Same timing as the logs: a change on tick `t` shows from tick `t + 1`. `enemy.hpLog` is the same for the
  opponent, the floating combat text over its wizard.
- `enemy`: `hp`, `casting` (`spellId`, `startTick`, `castTime`, `completesAt`) or `null`, `lockedUntil`, `chilling`
  (#150: every client gets both players' stacks), `effects` and `log`. Never the opponent's loadout, cooldowns or GCD.
- `enemy.log` (#126) is the opponent's spell log, what the game client's spell log shows: one `{ tick, type, spellId }`
  per engine log entry about the opponent, oldest first. `type` is `START_CAST`, `STOP_CAST` (the cast it stopped),
  `SPELL_RELEASE` (instants included), `CANCEL_CAST` or `INTERRUPTED` (its cast, by us). These are the entries the server
  streams to both clients (`battle.state.log`), without the loadout slot (`spellIndex`). The view on tick `t` holds the
  entries logged before tick `t`'s decisions, as the client has them, so an action on tick `t` shows from tick `t + 1`.
  A Counterspell that hit an empty cast bar shows here as its `SPELL_RELEASE`. The array only grows and its entries
  never change, so a controller may keep them. Only the spells the opponent has used show; the rest of its loadout
  never does.
- `effects` (both players) is the buff bar: one `{ id, type, startingTick, expiresAt }` per effect, so Ignite stacks,
  Living Bomb, Haste, Blur, Temporal Shield, Magic Eater and the Counterspell lock (`DEBUFF_COUNTERSPELL`). Never an
  effect's internals (Haste's saved cast times, Temporal Shield's saved HP, Magic Eater's pending heal). `expiresAt` is
  `startingTick + duration`; views from that tick on no longer show the effect.

The runner reuses the view objects every tick. A controller that keeps a value across ticks must copy it.

Built-in controllers, only to exercise the runner: `idle()` never casts; `priority(options)` Counterspells a visible
enemy cast after a seeded reaction time (`counter`, off by default), else releases its own cast once complete (plus a
seeded `releaseJitterTicks`), else starts the first ready spell in `order`. `EXAMPLE_ENTRANTS` holds the two entrants
`arena:match` plays.

### Behaviour profiles (#102)

A profile is a plain JSON object of named parameters, so a tuner (#104) can mutate it. `parseProfile(raw)` checks the
shape and ranges and returns it in normal form; `loadProfile(raw, loadout)` also checks it against one loadout (every
rotation spell on it). Both throw a `ProfileError` whose message starts with the offending key's path (`counterspell.reaction.meanSeconds:
must be in [0, 10], got 11`): unknown keys, missing keys and out-of-range values are rejected. `profileController(profile)`
is its `ControllerFactory`, `profileEntrant(profile, loadout)` an entrant; both play the profile built for the loadout
(`adaptProfile`, below). Every key except `intent`, a rotation entry's `when`, `lockoutWindow` (default: a copy of
`rotation`), `lockoutWindow.edgeGreedSeconds` (default 0), `fakeCast.realBaitShare` (default 0),
`counterspell.giveUpSeconds`, `patience` (default: no give-up timers) and `releaseHold` (default: no hold) is required.

**Built from the loadout (#136).** `rotation` and `lockoutWindow.rotation` are priority lists over the element spells,
Fire and Frost entries side by side (#150), and `adaptProfile(profile, loadout)` keeps the entries a loadout can play,
in order, so a Fire loadout plays the Fire entries and a Frost loadout the Frost ones: an entry is dropped when its
spell is not on the loadout, or when its `when` waits on a spell the loadout lacks (Combustion at 3+ Ignites with no
Ignite, Afterburn after Fireballs with no Fireball, Icy Touch on Frost Fever with no Frost Fever, a Chilling threshold
with no Frostbolt or Glacier), so a rotation never relies on a missing spell. With nothing left, the rotation is the
loadout's element spells in slot order. A profile may leave out spells it judges weak for its style.

```jsonc
{
    "name": "bait",
    "intent": "one line: the plan, general spells included",
    // ordered spell ids, or { "spell", "when": [conditions] }; built for each loadout (above); Counterspell and the
    // general spells are decided by their own blocks, not here
    "rotation": [
        {
            "spell": "SPELL_COMBUSTION",
            "when": [{ "type": "enemyEffectsAtLeast", "effect": "DEBUFF_IGNITE", "count": 6 }],
        },
        "SPELL_FIREBALL",
    ],
    // the free-cast window's list, highest value first, same form as rotation (#123)
    // edgeGreedSeconds (#126, default 0): see the free-cast window below
    "lockoutWindow": { "rotation": ["SPELL_COMBUSTION", "SPELL_FIREBALL"], "edgeGreedSeconds": 0 },
    "counterspell": {
        "enabled": true,
        // #143: which enemy casts it interrupts, by their value as seen (below), not a fixed list
        "minValue": 12, // HP a cast must be worth
        "bestShare": 0.6, // and at least this share of the best value seen from this opponent (1: only the best)
        "unseenValuePerSecond": 6, // a spell not yet seen to deal damage: its public base cast time x this
        "reaction": { "meanSeconds": 0.4, "spreadSeconds": 0.1 }, // uniform in mean ± spread (spread ≤ mean), per cast
        "timing": "early", // or "late"
        "lateWindowSeconds": 0, // late: decide once the cast is within this long of its release
        "giveUpSeconds": 8, // #136: held unused this long, interrupt the next cast whatever it is (null: never)
    },
    "fakeCast": {
        "enabled": true,
        "spell": "SPELL_METEOR",
        "cancelAfterSeconds": 0.25, // #43's R + ε, R being when the enemy commits (see below)
        "pauseAfterSeconds": 0.4, // start no cast for this long after the cancel
        "minGapSeconds": 12, // between two fakes
        "maxPerMatch": 20,
        "when": [], // conditions to start a fake
        "realBaitShare": 0.5, // share of baits that are a real low-priority cast instead of a fake (#123)
    },
    // give-up timers (#136), seconds or null (off)
    "patience": {
        "thresholdGiveUpSeconds": 2, // idle this long on rotation `when`s: cast the first ready entry anyway
        "commitGiveUpSeconds": null, // set: wait this long for the opponent to commit before casting (see below)
    },
    // #143, optional: keep a completed cast on the bar while `when` holds, at most giveUpSeconds (0-3) past completion
    "releaseHold": {
        "when": [{ "type": "enemyEffectsAtLeast", "effect": "BUFF_TEMPORAL_SHIELD", "count": 1 }],
        "giveUpSeconds": 1.2,
        // optional (#146 review): release at once when the enemy has at most the cast's expected hit + this margin
        "lethalMarginHp": 0,
    },
    // one rule per general spell: "never" or { "when": [conditions] }; rules for spells not on the loadout are unused
    "generals": {
        "SPELL_HASTE": { "when": [{ "type": "selfNotCasting" }, { "type": "nextCastIsLongest" }] },
        "SPELL_TEMPORAL_SHIELD": {
            "when": [{ "type": "enemyCastEndsWithin", "seconds": 0.25, "spells": ["SPELL_METEOR"] }],
        },
        "SPELL_MAGIC_EATER": { "when": [{ "type": "selfNotCasting" }, { "type": "inLockoutWindow" }] },
        "SPELL_BLUR": { "when": [{ "type": "enemyCastEndsWithin", "seconds": 0.3, "spells": ["SPELL_LIVING_BOMB"] }] },
    },
}
```

**Conditions** are data; a `when` list holds when all its conditions do. They read only the `ArenaView` and the
profile's own choice this tick (`src/conditions.ts`): `selfHpBelow`/`selfHpAtLeast`/`enemyHpBelow`/`enemyHpAtLeast`
(`hp`), `selfEffectsAtLeast`/`selfEffectsBelow`/`enemyEffectsAtLeast`/`enemyEffectsBelow` (`effect`, `count`),
`selfCasting`, `selfNotCasting`, `enemyCasting` (optional `spells`), `enemyNotCasting`, `enemyCastEndsWithin`
(`seconds`, optional `spells`), `enemyLocked` and `nextCastIs` (`spells`: the real cast the profile starts this tick; never a fake).
From #136: `nextCastIsLongest` (that cast is the loadout's longest by base cast time), `selfEffectEndsWithin` /
`enemyEffectEndsWithin` (`effect`, `seconds`: an effect ends within that long, e.g. a Living Bomb about to explode),
`selfCastsAtLeast` (`spell`, `count`, `withinSeconds`: the player's own releases, e.g. Fireballs before Afterburn),
`inLockoutWindow` (the free-cast window below is open) and `anyOf` (`of`: a list of condition lists, at least one of
which holds; no `anyOf` inside one). From #150 (Frost): `selfChillingAtLeast` / `selfChillingBelow` (`count`: the
player's Chilling stacks), `enemyChillingAtLeast` (`count`: the opponent's, as its HUD shows them) and
`noChillingSource` (no spell of the loadout grants Chilling, so Ice Spear is a plain nuke). The effect counts include the effect of the cast the player releases this tick
(#143): the view is built before the tick's actions, so it shows that effect only from the next tick, and a profile
keeping one Living Bomb up would otherwise start a second one on the release tick, replacing its own. The same goes
for Chilling (#150): the Chilling conditions, and whether Icy Touch is ready, read the stacks the release leaves
(`chillingAfter`: a Frostbolt adds one, an Ice Spear spends them all), measured once per spell and stack count on a
fresh real-engine battle, so no Chilling rule is reimplemented.

**Each tick** the controller: (1) cancels its fake cast once `cancelAfterSeconds` has passed, or releases a completed
cast (unless `releaseHold` keeps it, below); (2) lands a committed Counterspell; (3) picks its next cast if it has none in progress, isn't pausing after a
fake and didn't just press Counterspell (it waits one tick to see on the view whether the lock landed): in the
free-cast window, the first `lockoutWindow.rotation` entry that is ready, whose `when` holds and that fits (or, with edge greed, fits the greedy bound), or none;
else nothing while it waits for the opponent to commit; else a bait if `fakeCast` allows one (a fake, or a real cast,
see below); else the first rotation entry that is ready and whose `when` holds, and with none, once it has been idle
for `patience.thresholdGiveUpSeconds` (outside the window), the first rotation entry that is ready whatever its
`when`; (4)
uses each general spell that is ready and whose rule holds (an instant used mid-cast cancels the cast, so rules that
must not do that say `selfNotCasting`); (5) starts the cast from (3), after the general spells so Haste applies to it.
It never assumes a side.

**Frost (#150).** Icy Touch is an instant on the GCD: picked in (3) like a cast, it releases at once, and the GCD it
starts shows as the other spells' `lockRemaining`, so the next cast waits for it (no action is ever refused). A real
bait (below) is never an instant: it shows no cast to counter. The threshold give-up never recasts a spell whose own
unique debuff is still on the enemy (Frost Bomb, Frost Fever, Living Bomb): the recast would replace it and lose the
pulses it has left. (In a Fire-only field the give-up never meets that case, so Fire play is unchanged.)

**Counterspell targets (#143).** No fixed list: the profile learns what each opponent spell is worth from what a
client shows (`spellValues`, `src/threat.ts`), so it works for any spell set, future elements included. A spell's value
is the damage it has dealt to the player per cast released: every damage entry of the player's floating combat text
(`self.hpLog`) whose `spellId` is that spell (hits, damage over time, a Living Bomb's explosion), over the opponent's
releases of it (`enemy.log`). The combat text names the spell exactly, so nothing is inferred from HP drops (an
inference split a hit with a same-tick release or effect expiry, #146 review).
Until a spell has been seen to deal damage, its value is its public base cast time times
`counterspell.unseenValuePerSecond`. A visible enemy cast is a target when its spell's value is at least
`counterspell.minValue` and at least `counterspell.bestShare` times the highest value among the spells the opponent
has been seen casting. Values are summed and compared in exact centi-HP (invariant 8), so a tie is a tie. It never reads the opponent's loadout, cooldowns or effect internals. The archetypes: aggressive
counters big threats early (12 HP, 60% of the best), patient-counter holds out for the best target late (10 HP, 100%),
bait 12 HP and 75%, defensive anything worth 6 HP early (30%). The give-up timer still makes any cast a target.

**Counterspell model.** For each targeted enemy cast it sees, the player samples a reaction time and waits for its
decision tick: `early`, the first tick the cast is visible; `late`, the first tick the cast is within
`lateWindowSeconds` of its release (moved with the release if the visible cast time changes, as when Haste expires
mid-cast). From then on, while the cast is still on the bar, it commits as soon as
Counterspell will be ready one reaction later, and the Counterspell lands one reaction after the commit whatever the
enemy does meanwhile: the enemy can't tell a fake cast from a real one, nor react to the cancel faster than to the
cast. A `late` window shorter than the reaction lands after the release.

**Give-up timers (#136).** No wait lasts forever. `patience.thresholdGiveUpSeconds`: idle that long (no cast in
progress or started) with no rotation `when` holding, the profile casts its first ready entry anyway.
`patience.commitGiveUpSeconds`: when set, the profile starts no cast (nor a bait) while the opponent may Counterspell,
waiting for it to commit (its Counterspell used, or ours landed: the free-cast window), for at most that long from the
match start, from the end of the last window, or from its own Counterspell coming off cooldown, whichever is latest;
then it plays its rotation until the next window. It waits only while its own Counterspell is off cooldown (#143):
with it on cooldown, ours can't land on the commit, so a wait would only hand the opponent free time. (A profile whose
Counterspell is off waits from the match start or the window's end.) Two such profiles
facing each other both start casting when the timer ends. `counterspell.giveUpSeconds`: once its Counterspell has been
off cooldown that long unused, the next enemy cast is interrupted whatever its spell. Ticks under an enemy Counterspell
lock count toward none of them. Each is a tunable parameter.

**Holding a completed cast (#143).** The engine releases a cast only when its caster stops it, so a completed cast
can stay on the bar. With `releaseHold` set, the profile keeps its completed cast while every condition in
`releaseHold.when` holds, for at most `releaseHold.giveUpSeconds` past the completion, then releases it whatever
holds. The use: an enemy Temporal Shield rewinds every HP change made while it is up, so a Meteor that lands into it
is undone; held until the shield no longer shows (the tick its rewind has run), the hit stays. A held cast is still
on the cast bar, so the opponent may Counterspell it meanwhile, and an instant of the profile's own (its Counterspell,
or a general spell whose rule fires) cancels it like any cast. A hit that would kill needs no hold: a player at 0 HP
stays dead whatever a rewind does, so with `releaseHold.lethalMarginHp` set the profile releases at once when the
enemy's HP is at most the cast's expected hit plus that margin (in centi-HP). The expected hit is the one that spell's
last release dealt, read from the floating combat text over the opponent (`enemy.hpLog`), so it carries the modifiers
it had then (Fireballs before an Afterburn, Ignites before a Combustion); before its first release, its catalog hit,
measured once by releasing it on a fresh real-engine battle (`baseHit`; no spell module is read, no spell math
reimplemented).

**Fake casts (#43).** Start `fakeCast.spell`, then cancel it with `Battle.stopCast` after `cancelAfterSeconds`; the
cancel costs only the elapsed time (no lock, no damage). It baits a Counterspell when the enemy has committed before
the cancel and lands after it: against an `early` counterer with reaction `R`, the cancel must come before `R` from
the first visible tick, and `pauseAfterSeconds` must outlast it, or the Counterspell lands on the next cast. `late`
counterers decide near the release and are not fooled by short fakes.

**Free-cast window (#123).** While the opponent can't Counterspell, the profile casts from `lockoutWindow.rotation`
instead of `rotation`, and starts no fake cast or bait (there is nothing to bait). Everything comes from the view: the
opponent can't Counterspell before `safeUntil`, the later of `enemy.lockedUntil` (our Counterspell landed: 3 s in which
it can cast nothing) and the tick its Counterspell is ready again: the latest tick one was seen used plus
Counterspell's 11.7 s cooldown. It is seen used on `enemy.log` (#126), whether it interrupted us or hit an empty cast
bar, and also by the `DEBUFF_COUNTERSPELL` on our buff bar when it landed (that starts on the same tick). A cast fits when its
release tick is before `safeUntil`: on that tick the opponent may act first and interrupt it. So a cast that finishes
before the lockout ends is always allowed, and one that would finish after it only while the opponent's Counterspell
is seen on cooldown until after its release. The release tick uses the cast time the view shows, or the un-hasted one
when the Haste on won't last to the release (it ends first, on the release tick at the latest, or this tick's release
uses it up). With no entry fitting, no cast starts until the window ends (general spells are still used). An opponent
Counterspell never seen used is taken as ready.

So a fake cast that pays off opens the window: the opponent's Counterspell lands on the empty cast bar after the cancel,
its `SPELL_RELEASE` shows on `enemy.log` the next tick, and the profile plays its window list (high-value casts first)
until that Counterspell is ready again.

**Edge greed (#126, pending an owner decision).** `lockoutWindow.edgeGreedSeconds`, in [0, 1.5] s (the loader rejects
other values; the controller and the tuner clamp to that range), default 0: when no window entry fits, the entries are
tried again, in order, against `safeUntil` plus that much, so a cast may release up to that long after the opponent can
Counterspell again, at the risk of being countered. A safe cast always comes first. At 0 there is no second try: the
window behaves exactly as in #123. It is a tunable parameter, so self-tuning (#104) can find whether the risk pays off.

**Sacrificial bait (#123).** With `realBaitShare` above 0, that share of baits (drawn per bait from the seeded stream;
no draw at 0 or 1) is a real cast of the lowest-priority rotation entry that is ready and whose `when` holds, instead
of a fake. It is not cancelled: if the opponent counters it, its Counterspell shows as on cooldown and the free-cast
window lets the long casts through (bait: a real Combustion, then Meteors). The same gates as fake casts apply
(`enabled`, `minGapSeconds`, `maxPerMatch`, `when`), and `maxPerMatch` counts both kinds.

**Archetypes** live in `profiles/<name>.json` as `{ "loadout": [...], "profile": {...} }` and load on import
(`ARCHETYPES`, `archetypeEntrant(name)`): `aggressive`, `patient-counter`, `bait` and `defensive`, each with its
intent in its file. The file's loadout is the one it shows off; the profile is built for every loadout it plays. Every
archetype has a rule for each general spell (none is `"never"`) and its intent explains the plan: Haste on its longest
cast or in the free-cast window, Magic Eater around its own damage, Temporal Shield to rewind an enemy burst, a Living
Bomb explosion or Ignite build-up, Blur as an enemy Living Bomb or Ignite lands. Each also plays Frost (#150): Frost
Bomb and Frost Fever kept up (never recast while up), Ice Spear at high Chilling (4 for aggressive, 5 for the others;
3 in the free-cast window), Icy Touch only with Frost Fever on the enemy, Glacier while its 3 stacks fit under the
cap, Frostbolt otherwise; and its general spells answer Frost too (Temporal Shield before an enemy Glacier, a 4-stack
Ice Spear or a Frost Bomb's last pulse, Blur as a Frost Bomb lands). The bait defaults are the tuned profile of the
bait-only tuning run 42665449015 (#160: 42.2% to 51.8% on the selection seeds, 52.1% on fresh ones).

### Tournaments (#103)

`npm run arena` is the tournament command; `npm run arena:tournament` is the same script under its older name.

```sh
npm run arena -- [--top N] [--frost-top M] [--general-pairs K] [--profiles a,b] [--games G] [--seed S] [--max-ticks T] [--baseline VERSION]
                 [--jobs J] [--time-budget SECONDS] [--shard i/n] [--out FILE] [--report FILE] [--date D] [--commit SHA]
                 [--bracket-best-of N] [--no-bracket]
npm run arena -- merge SHARD.json... [--allow-missing] [--out FILE] [--report FILE] [--date D] [--commit SHA]
                 [--bracket-best-of N] [--no-bracket]
npm run arena:baseline -- [--top K] --out baselines/<ENGINE_VERSION>.json
npm run arena:baseline -- --element frost [--top K] --out baselines/<ENGINE_VERSION>-frost.json
```

**Frost (#150).** The tournament takes the top `M` distinct Frost sets (`--frost-top`, default `--top` when the version
has a Frost table, `baselines/<ENGINE_VERSION>-frost.json`, else 0; `--frost-top 0` is the Fire-only tournament) from
the Frost table alongside the Fire sets, each with its `K` best general pairs, chosen the same way. They play every
other entrant, so Fire faces Frost. Their ids are `I<Frost rank>/<profile>` (Ice) beside Fire's `L<rank>/<profile>`,
and `config.frost` records `M`. Each element has its own table: a table's `element` key (absent: Fire) says which, and
the parser checks every loadout against it (`parseBaseline(raw, version, element)`). The shipped Frost table is the
whole Frost search (`--element frost --top 90`: 15 sets x 6 pairs) with the approved numbers. Tuning (#104) stays on
the Fire field.

An **entrant** is a (loadout, profile) pair. The loadouts (`selectLoadouts`) come from the version's dummy-DPS baseline
(`baselines/<ENGINE_VERSION>.json`, generated from `sim:search`, best first; a missing file fails with a clear error):

1. Take the top `N` **distinct Fire sets** (`--top`, default 8): the 4 element spells as a set, whatever their slot order.
   A set ranks where its best loadout does, so near-duplicates of one set never crowd out the others.
2. For each set, take its top `K` **general pairs** (`--general-pairs`, default 6: all of them, #136) as separate
   loadouts, best first: the 3 pairs with Haste and the 3 without.
3. A full loadout is never repeated: a table row that only reorders the Fire slots or swaps the two general slots of one
   already taken is skipped. A set with fewer than `K` pairs in the table gives all it has.

That is up to `N * K` loadouts (16 by default), each crossed with the profiles (`--profiles`, default every archetype in
`profiles/`; only their behaviour is used, not the loadout they were written for). Selection is a pure function of the
table and the two numbers, so runs stay deterministic and merged shards stay byte-identical to an unsharded run.
The baseline therefore needs to list every general pair of the sets it offers: the shipped table holds all 90 loadouts of
the search (15 Fire sets, 6 general pairs each; `npm run arena:baseline -- --top 90`), not just the best 16. `--top` is clamped
to the sets in the table, which `config.top` and stderr report; `config.generalPairs` records `K`.

A profile naming spells the loadout lacks is adapted (`adaptProfile`): rotation entries
for missing spells are dropped (with none left, the loadout's own Fire spells in slot order), and so are window entries
(with none left, the window plays the adapted rotation); a fake cast of a spell
the loadout lacks (bait without Meteor) is retargeted to the loadout's longest cast-time spell (first in slot order on a
tie), or turned off if it has none. Everything else is kept.

- **Pairs.** Every unordered pair of distinct entrants plays, so a loadout meets itself under a different profile (mirror
  matches), and an entrant never meets itself. Pairs are indexed (0,1), (0,2), ..., (1,2), ... .
- **Games.** `--games G` (default 2, even) best-of-1 matches per pair, `a` as `player1` on even games and `b` on odd ones, so
  each is first in exactly half. Game `g` of pair `p` is seeded `deriveSeed(seed, p, g)`.
- **Score.** Win rate = wins / games over all of an entrant's games. Only wins count: draws (time cap, mutual lethal) and
  losses are both non-wins; draws are listed for information. The ranking is by win rate, ties by entrant id
  (`L<baseline rank>/<profile>`). The table shows the 95% Wilson interval, wide on a few games. `firstWins` in the JSON
  counts games won by `player1`, the first-mover edge.
- **Output.** `--out FILE` writes `{ format, config, ranking, matrix, firstWins, games }`: `matrix[row][column]` is the
  games `row` won against `column`. The table goes to stdout (stderr with `--out -`, which prints the JSON to stdout, for a run and for `merge`).
- **Shards.** `--shard i/n` plays the pairs with `pair % n === i` and writes `{ format, config, shard, pairs }` (needs
  `--out`); `merge` of all `n` files, in any order, gives byte-identical JSON to the unsharded run. It refuses missing,
  repeated or foreign shards (different config); `--allow-missing` merges the shards given anyway, as a partial result that
  names the missing ones (`partial.missingShards`).
- **Jobs.** `--jobs J` runs J worker processes over the pairs. The default is 4, and a larger value is clamped to 4 with
  a warning on stderr (`warning: --jobs 9 is above the maximum of 4: using 4`); `clampJobs` is the rule. The output does
  not depend on it, nor on the shard split.
- **Time budget (#105).** `--time-budget SECONDS` (a positive number, counted from the start of the process) stops the run
  when it is reached: each worker finishes its current pair, plays no further one, and the result is marked **partial**
  (`partial: { pairsPlayed, pairsTotal, played }` in the JSON, a `PARTIAL:` line under the table, `Status: PARTIAL` and a
  caveat in the report). A shard stopped early writes `partial: true` and `merge` accepts it (a short shard that is not
  marked partial is still refused). A run that finishes within its budget is complete and byte-identical to one without
  a budget. An entrant that played no games in a partial run ranks last and shows `no games`. Where a partial run stops depends on the machine's speed, so unlike a complete run it is not reproducible.

**Top-8 bracket (#136).** A whole run (not a `--shard`) and `merge` then play a double-elimination bracket on the
round-robin's top 8 (entrants with no games left out), seeded by rank: upper round 1 is 1v8, 4v5, 2v7, 3v6; the losers
drop to the lower bracket (lower round 2 crosses them with the upper semifinal losers, so no early rematch); the grand
final has a bracket reset (a second set when the lower-bracket winner takes the first). Every set is a best-of-5
(`--bracket-best-of N`, odd), the better seed `player1` in the set's even games and the other in its odd ones (draws
included). A draw counts for nobody and is replayed, up to 5 draws a set; one more ends the set, to the entrant with more
wins, or the better seed on equal wins. Game `g` of set `s` is seeded `deriveSeed(seed, BRACKET_TAG, s, g)` from the
master seed, so the bracket is deterministic. Placements: 1st, 2nd, 3rd, 4th, 5th-6th, 7th-8th. It is `bracket` in the
result JSON, a section of the report and a few lines under the table; `--no-bracket` skips it, and with fewer than 8
entrants it is skipped with a warning. From code: `runBracket(result, { bestOf, drawCap })` or `withBracket(result)`.
It is 14 or 15 sets, a few dozen games.

From code: `planTournament({ baseline, profiles, top, generalPairs, games, seed })`, then `runTournament(plan)`, or `runShard(plan, i, n)`
and `mergeShards(shards)` (`runTournament` and `runShard` take an optional `stop` callback, the time budget's hook). `profiles` are plain `Profile` objects, so a tuner (#104) can pass its own.

### Strategy tournament (#137)

The round-robin above changes the loadout and the profile together, so a win rate mixes loadout strength and strategy.
`--mode strategy` (or `npm run arena:strategy`, the same command) plays every game as a **mirror**: both players get the
same loadout, so only the profile varies.

```sh
npm run arena -- --mode strategy --seed 1 --out result.json --report report.md
npm run arena -- --mode strategy --fire-set fireball,ignite,combustion,meteor --fire-set fireball,living-bomb,ignite,afterburn
```

- **Frost sets (#150).** `--fire-set` also takes four Frost spells (`frostbolt,glacier,frost-bomb,ice-spear`), and
  `--set` is its element-neutral name. A Frost set's setups are `I<n>/<pair>`, its `element` is `FROST`, and its dummy
  baseline comes from the Frost table. Every game is still a mirror, so a setup plays one element.
- **Setups.** One Fire set with each of the 6 pairs of the four non-Counterspell general spells (Haste+Blur, Haste+Magic
  Eater, Haste+Temporal Shield, Blur+Magic Eater, Blur+Temporal Shield, Magic Eater+Temporal Shield), Counterspell always
  in: `F<n>/<pair>`. The Fire set defaults to the best set of the dummy baseline (that of its rank 1). `--fire-set`
  (four distinct Fire spells, ids or short names) replaces it and may be repeated to run several Fire sets.
- **Matchups.** On every setup each profile plays every profile, itself included. A cell is `--seeds` derived seeds
  (default 30, `deriveSeed(seed, setup, matchup, k)`) x `--games` games each (even, default 36), sides alternating game
  by game: 1080 games a cell, so the widest 95% Wilson interval (at 50%) is about +/-3%. A full default run is 64,800
  games on one Fire set, about 2 minutes on one machine. `--profiles`, `--seed`, `--max-ticks`, `--baseline`, `--jobs`,
  `--time-budget`, `--shard i/n`, `--out`, `--report`, `--date`, `--commit` and `merge` work as in the tournament.
- **Result and report.** The JSON holds the raw counts per cell (`cells`: wins of each side, draws, first-mover wins),
  the profile ranking of each setup and the best profile per general pair. The report has a profile-against-profile
  win-rate matrix per setup, each profile's rank on each setup, and a table of which profile does best with each
  general pair (pooled over the Fire sets, with whether its interval is clear of the runner-up's). All rates are 95%
  Wilson intervals and draws are non-wins. The diagonal of a matrix is the share of games won by whoever moved first.
- **Ranking** is a profile's win rate over its games against the _other_ profiles: mirror games say nothing about which
  profile is better, so they are in the diagonal cells only.
- **Work units** are jobs (one setup, matchup and derived seed, `--games` games), sharded by `job % n`; merging all
  shards equals the unsharded run. From code: `planStrategy`, `runStrategy`, `runStrategyShard`, `mergeStrategyShards`,
  `formatStrategyReport`.

### Workflow, local runs and the report (#105)

**In GitHub Actions** (`.github/workflows/arena.yml`, free on this public repo): _Actions > Arena > Run workflow_, or
`gh workflow run arena.yml -f seed=1 -f top=8 -f games=2 -f generations=0`. It is `workflow_dispatch` only, has
`permissions: contents: read`, uses no secrets and writes nothing back (no commits, no wiki). Inputs: `mode`
(`tournament`, the default, or `strategy`, #137), `seed`, and for the tournament `top` (Fire sets), `frost_top` (Frost
sets beside them, #150, default 8; 0 is Fire only), `games` (per pair,
even) and `generations` (0, the default, means no tuning); for the strategy mode `strategy_seeds` (30), `strategy_games`
(36) and `fire_sets` (`;` between sets, `,` between spells, Fire or Frost sets; empty means the Fire baseline's best). The strategy mode shards
and merges the same way (same shard and report files, no bracket, no tuning):
`gh workflow run arena.yml -f mode=strategy -f seed=1`.

- A `plan` job checks the inputs (non-negative integers; `generations` is read numerically, so `00` means no tuning) and
  decides whether `tune` runs.
- Four `shard` jobs run `--shard i/4 --jobs 4 --time-budget 1200` (a 20 minute budget inside a 30 minute job timeout, so
  a slow run ends partial and is still merged) and upload `arena-shard-<i>` (14 days).
- A `merge` job downloads the shards, runs `merge --allow-missing --bracket-best-of 5` (which also plays the top-8 bracket) into `arena-result.json` and `arena-report.md`, writes the
  report to the run's step summary and uploads both as `arena-report` (30 days). It also runs when a shard job failed: it
  merges the shards that uploaded, and the report is `PARTIAL` and names the missing shards (the workflow still shows red
  for the failed shard). The merged result is byte-identical to a local run of the same seed and inputs (checked by
  `test/arena-cli.test.ts`, which compares a local run with 4 merged shards, the JSON and the report).
- Files: `npm run arena` runs the script from `packages/arena/` (npm workspaces), so the workflow gives the CLI absolute
  paths under `$GITHUB_WORKSPACE/arena-out`, and uploads from the same `arena-out/` directory. Locally the CLI resolves a
  relative `--out`, `--report` or `merge` file against `INIT_CWD` (npm's invocation directory), so those land where you
  typed the command.
- With `generations` above 0 a `tune` job (60 minute timeout, `--max-matches 1500000`) runs `arena:tune` (#104) on the same
  seed, top and games (and `tune_profile`, when set, as `--profile`), writes its output to its step summary and uploads `arena-tuning` (the text and the best profile).
  The tuning is not part of the report.
- Publishing the report to the wiki is manual: the workflow cannot write there.

**Locally**: `npm run arena -- --top 8 --games 2 --seed 1 --report arena-report.md --out arena-result.json`. Keep local runs
small while developing (`--top 2 --general-pairs 1 --games 2`, 28 pairs, a second or two); `--jobs` is 4 at most.

**Expected runtime.** The default run is (8 Fire sets + 8 Frost sets, #150) x 6 general pairs = 96 loadouts x 4
profiles = 384 entrants, 73536 pairs x 2 games = 147072 matches (`games x E(E-1)/2` for `E` entrants), then the
bracket's few dozen: four times the Fire-only run's 36672 matches (`--frost-top 0`, 192 entrants), so the times below,
measured on that Fire-only run, are about four times longer by default. It was not run in
full while writing this: it is extrapolated from a `--top 2` run (48 entrants, 2256 matches) that took 1.3 s with
`--jobs 2` on a WSL2 machine, start-up and bracket included. The v0.3.0 run's shards (64 entrants) took about 20 s each.

| Where                                          | Default run                                            |
| ---------------------------------------------- | ------------------------------------------------------ |
| Locally, 1 job                                 | about 1 to 2 minutes                                   |
| Locally, `--jobs 4` (the default)              | about 20 to 40 s (start-up of the workers included)    |
| Actions, whole workflow (4 shards, then merge) | about 3 to 5 minutes, most of it checkout and `npm ci` |

Matches take about the same time whatever the entrants, so a bigger run scales with its match count: `--top 15 --general-pairs 6`
(the whole baseline, 360 entrants) at 20 games per pair is about 1.3 million matches, roughly 11 minutes on one core,
3 on four, or about a minute per shard on four Actions shards, if the extrapolation holds. The time budget exists for
runs that turn out slower. Re-measure with a tiny config and scale by the match count.

**The report** (`--report FILE`, from a whole run or from `merge`; `formatReport(result, { date, commit })` from code) is Markdown
with these sections, in this order, always present:

1. `# Arena report: <version>` then `## Header`: version (the baseline's engine version), seed, date (UTC), commit (if
   `--commit` is given; the workflow passes the commit it runs on), status (`complete`, or `PARTIAL: x of y pairs played`),
   entrants (loadouts x profiles, with the profile names), how the loadouts were chosen, games per pair and the time cap.
2. `## Dummy baseline`: a table of the loadouts that play (`L<rank>`, Fire set, Counterspell slot, general spells, dummy DPS,
   DPS under pressure), from `baselines/<version>.json`.
3. `## Arena win rates`: `### By profile` (entrants, wins, draws, games and win rate over all of a profile's entrants) and
   `### By entrant` (rank, loadout, profile, wins, draws, games, win rate and 95% interval, best first).
4. `## Elements` (#150): `### Fire vs Frost`, each element's win rate over the games between a Fire entrant and a Frost
   one, with the 95% Wilson interval; `### Per profile`, the same for each profile's entrants; `### All games`, each
   element's win rate over all its games. A Fire-only run says it has no cross-element games.
5. `## General pairs` (#136): win rate by general pair (the six, Haste pairs first) and with Haste against without it,
   pooled over every entrant with it, with the 95% Wilson interval: `### All profiles`, then `### Per profile` (one
   column per profile).
6. `## Matchup matrix`: profile against profile, the share of games the row profile won against the column profile, with
   wins/games (the full entrant matrix is `matrix` in the JSON).
7. `## Bracket` (#136): the seeds, every set with its score, draws and winner, and the final placements; or why it was
   not run.
8. `## Caveats`: partial runs, draws, sample size (games per entrant, the widest interval), the first-mover edge, the
   bracket's small sample and what the numbers mean.

For a given seed and inputs the tables are deterministic: the report is a pure function of the result, the date and the
commit, so everything but the header's date and commit is identical between runs, and a report from merged shards equals
one from an unsharded run. The date is the only clock read, in the script, never in the library or the engine.

### Self-tuning (#104)

```sh
npm run arena:tune -- [--generations G] [--population P] [--elite K] [--seed S] [--max-matches M] [--out FILE]
                      [--top N] [--general-pairs K] [--games G] [--max-ticks T] [--from a,b | --profile NAME] [--field a,b] [--baseline VERSION]
```

An evolutionary search over profile parameters across generations, keeping the strongest. It is for the arena only:
gameplay (`apps/`) never reads a tuned profile, and `packages/engine` is untouched.

- **Population.** Generation 0 is the `--from` profiles (default every archetype), then mutants of them in turn, up to
  `--population P` (default 8). `--generations G` (default 5) counts generation 0.
- **One archetype (#156).** `--profile NAME` (one of the archetypes; not with `--from`) seeds and mutates only that
  archetype, so a weak archetype is tuned on its own terms instead of losing the overall ranking to a stronger one. The
  field, the loadouts, elitism and the holdout re-score are unchanged. The output adds the untuned archetype's win rate
  on the selection seeds and on the holdout seeds and the tuned profile's change in percentage points on each (the
  untuned archetype's holdout re-score counts in the matches and in `--max-matches`). In the workflow it is the
  `tune_profile` input (empty means the whole population).
- **Score.** Each profile is scored against a fixed **field** (`--field`, default every archetype) on the tournament's
  loadouts (`--top`, `--general-pairs`, `--games`, `--max-ticks` as in `arena:tournament`). The score is the profile's row
  of the #103 round-robin: the tournament of `[profile, ...field]`, restricted to the pairs where one of the profile's
  entrants meets a field entrant, played with the tournament's own pairing, side swap and `deriveSeed(seed, pair, game)`.
  That is `L * (L * F) * games` matches per profile for `L` loadouts and `F` field profiles (48 x 192 x 2 = 18432 with the
  defaults since #136, tens of seconds a profile on one core, so start small; the workflow's `--max-matches 1500000` bounds a
  run whatever the field: about 80 profile scores, while the default 5 generations of 8 need at most 41). Win rate only, as in #103. The pairs and seeds are the same for every profile in every
  generation, so a profile's score depends on nothing but the profile, and identical profiles are only played once.
- **Next generation.** The best `--elite K` (default 2, `0 <= K < P`) pass unchanged, so with `K >= 1` the best score
  never drops. Each other member `i` of generation `g` is bred from the ranking (ties keep population order) with its
  own stream `Rng(breedSeed(S, g, i))`: a parent by tournament selection (the better of two uniform picks), with
  probability 1/2 a uniform crossover with a second one, then a mutation of each parameter with probability 0.2 (at
  least one value always changes). Every random choice comes from that stream, so the same `S` gives the same run.
- **What may change.** Only the tunable parameters declared in `src/profile-params.ts`, each with bounds that lie inside
  what the profile loader accepts; out-of-bounds values are clamped (and `spreadSeconds` kept at most `meanSeconds`). The
  profile's structure (rotation and window orders, their conditions, which general spells it
  uses) never changes, and neither does `counterspell.enabled`: everyone has Counterspell. A fake cast and the pause
  after it last at least one standard reaction time (0.25 s, the reaction mean's minimum too).
  Crossover takes condition values from the second parent only if both have the same structure.

    | Parameter                                                                                  | Bounds                    |
    | ------------------------------------------------------------------------------------------ | ------------------------- |
    | `fakeCast.enabled`                                                                         | `true` / `false`          |
    | `counterspell.timing`                                                                      | `early` / `late`          |
    | `counterspell.reaction.meanSeconds`                                                        | 0.25 to 1.5 s             |
    | `counterspell.reaction.spreadSeconds`                                                      | 0 to 0.5 s, <= mean       |
    | `counterspell.lateWindowSeconds`                                                           | 0 to 3 s                  |
    | `counterspell.minValue` / `bestShare` / `unseenValuePerSecond` (#143)                      | 0-40 HP / 0-1 / 0-20 HP/s |
    | `fakeCast.cancelAfterSeconds` / `pauseAfterSeconds` / `minGapSeconds`                      | 0.25-2 / 0.25-2 / 0-60 s  |
    | `fakeCast.maxPerMatch`                                                                     | 0 to 50                   |
    | `fakeCast.realBaitShare`                                                                   | 0 to 1                    |
    | `lockoutWindow.edgeGreedSeconds` (#126)                                                    | 0 to 1.5 s                |
    | `counterspell.giveUpSeconds` (#136, when set)                                              | 1 to 30 s                 |
    | `patience.thresholdGiveUpSeconds` / `commitGiveUpSeconds` (#136, when set)                 | 0.25-10 / 0.25-15 s       |
    | `releaseHold.giveUpSeconds` (#143, when the profile has `releaseHold`)                     | 0 to 3 s                  |
    | every condition's `hp` / `count` / `seconds` (rotation, window, fake cast, hold, generals) | 0-100 / 0-20 / 0-3 s      |
    | a Chilling condition's `count` (#150)                                                      | 0 to 5 (the cap)          |
    | every `selfCastsAtLeast`'s `withinSeconds` (#136), `anyOf` lists included                  | 0 to 15 s                 |

- **Overfitting guard.** The final best profile is re-scored on a fresh seed set (a tournament seed derived from `S`
  whose match seeds share none with the selection set). Both win rates are printed; a large gap means the search fitted
  the selection seeds rather than the matchups.
- **Budget.** `--max-matches M` caps the matches played, the holdout re-score included. When the next profile would not
  fit, the run stops, prints and writes the best profile found so far, and says the result is partial (`PARTIAL:` in the
  output, `(partial run)` in the written profile's intent).
- **Output.** One row per generation: the population's best, median and worst win rate, the best profile (and the
  starting profile it descends from) and its win rate on each loadout (`L<rank>`, legend at the end). Then the best
  profile's selection and holdout win rates, with `--profile` the improvement over the untuned archetype, and the parameters it changed from its starting profile. `--out FILE` writes
  the best profile as profile JSON, which `parseProfile` (and `loadProfile` against its starting archetype's loadout)
  accepts, named `<origin>-tuned-s<S>` with both win rates in its `intent`.

```
gen   best  median  worst  best profile         L01    L04
  0  56.3%   40.6%  25.0%  g0-4 (aggressive)  87.5%  25.0%
  1  56.3%   43.8%  25.0%  g0-4 (aggressive)  87.5%  25.0%

Best profile: g0-4 (from aggressive)
  selection seeds: 56.3% (9/16 wins)
  fresh seeds (holdout, not used for selection): 56.3% (9/16 wins)
Changed parameters:
  counterspell.reaction.meanSeconds: 0.35 -> 0.39
  rotation[0].when[0].count: 4 -> 5
```

From code: `tune({ baseline, seeds, field, generations, population, elite, seed, maxMatches, ... })` returns the
`TuningResult` (`generations`, the final `population`, `best` with its `holdout` score and `changes`, `matches`,
`partial`, and with `compareToStart` the untuned `start` with its two scores); `formatTuning(result)` is the text above and `tunedProfile(result)` the profile `--out` writes.

### Tick order and the end of a match

Each loop: both views are refreshed from the same state (the decisions are simultaneous; each `enemy.log` gets the
entries logged since the last loop), then `a`'s actions are applied, then `b`'s, then `Battle.tick()`. Within a tick `a` acts first, so tournaments swap sides between games.

- **Death**: the match ends when the engine's result is final (`Battle.finished`). Actions in the tick the winner is
  decided still resolve, whether the kill came from an action or from `tick()`, so same-tick lethal damage to both
  players is a draw (`reason: 'mutual'`). `ticks` is the winner's tick.
- **Time cap**: `maxTicks` defaults to `DEFAULT_MAX_TICKS`, 3 minutes of game time (3600 ticks at 50 ms). Tick
  `maxTicks` resolves like any other tick: both players act on it, and a kill on it (from an action or from the `tick()`
  that reached it) counts. If both players are still alive after it, the match is a draw (`reason: 'timeout'`,
  `ticks === maxTicks`).

### Stats

Per side: `casts` (spells released, instants included), `started` (cast-time casts started), `cancelled` (own casts
cancelled by an instant, a new cast or an early `stop`), `interrupts` (enemy casts countered), `interrupted` (own casts
countered), `rejected` (actions the engine refused) and `damageTaken` (HP lost, before heals).

## Log format

`formatLog(result)` prints one line per engine log entry, then one summary line:

```
<tick> <side> <TYPE> [spellId] [source]
END winner=<a|b|draw> reason=<death|mutual|timeout> ticks=<n> seconds=<s> hp=<a>/<b> casts=<a>/<b> interrupts=<a>/<b> seed=<seed>
```

`TYPE` is the engine's log type: `START_CAST`, `STOP_CAST` (the spell whose cast was stopped), `SPELL_RELEASE`, `CANCEL_CAST` or
`INTERRUPTED`. For `INTERRUPTED`, `side` is the interrupted player, `spellId` the countered spell and `source` the
interrupter's spell. A `STOP_CAST` directly followed by a `SPELL_RELEASE` of the same spell is a release; any other `STOP_CAST`
cancelled the cast. Example:

```
0 a START_CAST SPELL_METEOR
0 b START_CAST SPELL_FIREBALL
8 b CANCEL_CAST SPELL_FIREBALL
8 b SPELL_RELEASE SPELL_COUNTERSPELL
8 a INTERRUPTED SPELL_METEOR SPELL_COUNTERSPELL
9 b START_CAST SPELL_FIREBALL
37 b STOP_CAST SPELL_FIREBALL
...
END winner=a reason=death ticks=450 seconds=22.5 hp=16/0 casts=4/17 interrupts=0/2 seed=1
```
