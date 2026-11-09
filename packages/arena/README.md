# @magus/arena

Headless AI-vs-AI matches on the real battle engine (`@magus/engine`). One match is best-of-1, 100 HP, to the death,
with a time cap that counts as a draw. Behaviour profiles (#102), tournaments (#103), self-tuning (#104) and the
workflow (#105) build on this package.

```sh
npm run arena:match -- --seed 1          # summary of one match between the two built-in example entrants
npm run arena:match -- --seed 1 --log    # the full match log, then the summary
npm run arena:match -- --seed 1 --max-ticks 600
npm run arena:match -- --seed 1 --a bait --b patient-counter   # two archetypes from profiles/
npm run arena:tournament -- --top 8 --games 2 --seed 1          # round-robin, ranked by win rate (#103)
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

`a` plays as the engine's `player1` and `b` as `player2`. Loadouts must pass the engine's `isValidLoadout`.

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
  `lockedUntil`, `effects`, and `spells`, the player's own loadout with `castTime`, `cooldownRemaining`,
  `lockRemaining` and `ready` per slot.
- `enemy`: `hp`, `casting` (`spellId`, `startTick`, `castTime`, `completesAt`) or `null`, `lockedUntil`, `effects` and
  `log`. Never the opponent's loadout, cooldowns or GCD.
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
shape and ranges and returns it in normal form; `loadProfile(raw, loadout)` also checks it against the loadout it will
play. Both throw a `ProfileError` whose message starts with the offending key's path (`counterspell.reaction.meanSeconds:
must be in [0, 10], got 11`): unknown keys, missing keys and out-of-range values are rejected. `profileController(profile)`
is its `ControllerFactory`, `profileEntrant(profile, loadout)` an entrant. Every key except `intent`, a rotation
entry's `when`, `lockoutWindow` (default: a copy of `rotation`), `lockoutWindow.edgeGreedSeconds` (default 0) and
`fakeCast.realBaitShare` (default 0) is required.

```jsonc
{
    "name": "bait",
    "intent": "one line",
    // ordered spell ids, or { "spell", "when": [conditions] }; every spell must be on the loadout (rejected at load
    // time); Counterspell and the general spells are decided by their own blocks, not here
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
        "targets": ["SPELL_METEOR"], // enemy casts it interrupts
        "reaction": { "meanSeconds": 0.4, "spreadSeconds": 0.1 }, // uniform in mean ± spread (spread ≤ mean), per cast
        "timing": "early", // or "late"
        "lateWindowSeconds": 0, // late: decide once the cast is within this long of its release
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
    // one rule per general spell: "never" or { "when": [conditions] }; rules for spells not on the loadout are unused
    "generals": {
        "SPELL_HASTE": { "when": [{ "type": "nextCastIs", "spells": ["SPELL_METEOR"] }] },
        "SPELL_TEMPORAL_SHIELD": "never",
        "SPELL_MAGIC_EATER": "never",
        "SPELL_BLUR": "never",
    },
}
```

**Conditions** are data; a `when` list holds when all its conditions do. They read only the `ArenaView` and the
profile's own choice this tick (`src/conditions.ts`): `selfHpBelow`/`selfHpAtLeast`/`enemyHpBelow`/`enemyHpAtLeast`
(`hp`), `selfEffectsAtLeast`/`selfEffectsBelow`/`enemyEffectsAtLeast`/`enemyEffectsBelow` (`effect`, `count`),
`selfCasting`, `selfNotCasting`, `enemyCasting` (optional `spells`), `enemyNotCasting`, `enemyCastEndsWithin`
(`seconds`, optional `spells`), `enemyLocked` and `nextCastIs` (`spells`: the real cast the profile starts this tick; never a fake).

**Each tick** the controller: (1) cancels its fake cast once `cancelAfterSeconds` has passed, or releases a completed
cast; (2) lands a committed Counterspell; (3) picks its next cast if it has none in progress, isn't pausing after a
fake and didn't just press Counterspell (it waits one tick to see on the view whether the lock landed): in the
free-cast window, the first `lockoutWindow.rotation` entry that is ready, whose `when` holds and that fits (or, with edge greed, fits the greedy bound), or none;
else a bait if `fakeCast` allows one (a fake, or a real cast, see below); else the first rotation entry that is ready
and whose `when` holds; (4)
uses each general spell that is ready and whose rule holds (an instant used mid-cast cancels the cast, so rules that
must not do that say `selfNotCasting`); (5) starts the cast from (3), after the general spells so Haste applies to it.
It never assumes a side.

**Counterspell model.** For each targeted enemy cast it sees, the player samples a reaction time and waits for its
decision tick: `early`, the first tick the cast is visible; `late`, the first tick the cast is within
`lateWindowSeconds` of its release (moved with the release if the visible cast time changes, as when Haste expires
mid-cast). From then on, while the cast is still on the bar, it commits as soon as
Counterspell will be ready one reaction later, and the Counterspell lands one reaction after the commit whatever the
enemy does meanwhile: the enemy can't tell a fake cast from a real one, nor react to the cancel faster than to the
cast. A `late` window shorter than the reaction lands after the release.

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
intent in its file.

### Tournaments (#103)

```sh
npm run arena:tournament -- [--top N] [--general-pairs K] [--profiles a,b] [--games G] [--seed S] [--max-ticks T] [--baseline VERSION]
                            [--jobs J] [--shard i/n] [--out FILE]
npm run arena:tournament -- merge SHARD.json... [--out FILE]
npm run arena:baseline -- [--top K] --out baselines/<ENGINE_VERSION>.json
```

An **entrant** is a (loadout, profile) pair. The loadouts (`selectLoadouts`) come from the version's dummy-DPS baseline
(`baselines/<ENGINE_VERSION>.json`, generated from `sim:search`, best first; a missing file fails with a clear error):

1. Take the top `N` **distinct Fire sets** (`--top`, default 8): the 4 element spells as a set, whatever their slot order.
   A set ranks where its best loadout does, so near-duplicates of one set never crowd out the others.
2. For each set, take its top `K` **general pairs** (`--general-pairs`, default 2) as separate loadouts, best first.
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
  repeated or foreign shards (different config).
- **Jobs.** `--jobs J` (default the cores, at most 4) runs J worker processes over the pairs. The output does not depend on
  it, nor on the shard split.

From code: `planTournament({ baseline, profiles, top, generalPairs, games, seed })`, then `runTournament(plan)`, or `runShard(plan, i, n)`
and `mergeShards(shards)`. `profiles` are plain `Profile` objects, so a tuner (#104) can pass its own.

### Self-tuning (#104)

```sh
npm run arena:tune -- [--generations G] [--population P] [--elite K] [--seed S] [--max-matches M] [--out FILE]
                      [--top N] [--general-pairs K] [--games G] [--max-ticks T] [--from a,b] [--field a,b] [--baseline VERSION]
```

An evolutionary search over profile parameters across generations, keeping the strongest. It is for the arena only:
gameplay (`apps/`) never reads a tuned profile, and `packages/engine` is untouched.

- **Population.** Generation 0 is the `--from` profiles (default every archetype), then mutants of them in turn, up to
  `--population P` (default 8). `--generations G` (default 5) counts generation 0.
- **Score.** Each profile is scored against a fixed **field** (`--field`, default every archetype) on the tournament's
  loadouts (`--top`, `--general-pairs`, `--games`, `--max-ticks` as in `arena:tournament`). The score is the profile's row
  of the #103 round-robin: the tournament of `[profile, ...field]`, restricted to the pairs where one of the profile's
  entrants meets a field entrant, played with the tournament's own pairing, side swap and `deriveSeed(seed, pair, game)`.
  That is `L * (L * F) * games` matches per profile for `L` loadouts and `F` field profiles (16 x 64 x 2 = 2048 with the
  defaults, so start small). Win rate only, as in #103. The pairs and seeds are the same for every profile in every
  generation, so a profile's score depends on nothing but the profile, and identical profiles are only played once.
- **Next generation.** The best `--elite K` (default 2, `0 <= K < P`) pass unchanged, so with `K >= 1` the best score
  never drops. Each other member `i` of generation `g` is bred from the ranking (ties keep population order) with its
  own stream `Rng(breedSeed(S, g, i))`: a parent by tournament selection (the better of two uniform picks), with
  probability 1/2 a uniform crossover with a second one, then a mutation of each parameter with probability 0.2 (at
  least one value always changes). Every random choice comes from that stream, so the same `S` gives the same run.
- **What may change.** Only the tunable parameters declared in `src/profile-params.ts`, each with bounds that lie inside
  what the profile loader accepts; out-of-bounds values are clamped (and `spreadSeconds` kept at most `meanSeconds`). The
  profile's structure (rotation and window orders, their conditions, Counterspell targets, which general spells it
  uses) never changes, and neither does `counterspell.enabled`: everyone has Counterspell. A fake cast and the pause
  after it last at least one standard reaction time (0.25 s, the reaction mean's minimum too).
  Crossover takes condition values from the second parent only if both have the same structure.

    | Parameter                                                                            | Bounds                   |
    | ------------------------------------------------------------------------------------ | ------------------------ |
    | `fakeCast.enabled`                                                                   | `true` / `false`         |
    | `counterspell.timing`                                                                | `early` / `late`         |
    | `counterspell.reaction.meanSeconds`                                                  | 0.25 to 1.5 s            |
    | `counterspell.reaction.spreadSeconds`                                                | 0 to 0.5 s, <= mean      |
    | `counterspell.lateWindowSeconds`                                                     | 0 to 3 s                 |
    | `fakeCast.cancelAfterSeconds` / `pauseAfterSeconds` / `minGapSeconds`                | 0.25-2 / 0.25-2 / 0-60 s |
    | `fakeCast.maxPerMatch`                                                               | 0 to 50                  |
    | `fakeCast.realBaitShare`                                                             | 0 to 1                   |
    | `lockoutWindow.edgeGreedSeconds` (#126)                                              | 0 to 1.5 s               |
    | every condition's `hp` / `count` / `seconds` (rotation, window, fake cast, generals) | 0-100 / 0-20 / 0-3 s     |

- **Overfitting guard.** The final best profile is re-scored on a fresh seed set (a tournament seed derived from `S`
  whose match seeds share none with the selection set). Both win rates are printed; a large gap means the search fitted
  the selection seeds rather than the matchups.
- **Budget.** `--max-matches M` caps the matches played, the holdout re-score included. When the next profile would not
  fit, the run stops, prints and writes the best profile found so far, and says the result is partial (`PARTIAL:` in the
  output, `(partial run)` in the written profile's intent).
- **Output.** One row per generation: the population's best, median and worst win rate, the best profile (and the
  starting profile it descends from) and its win rate on each loadout (`L<rank>`, legend at the end). Then the best
  profile's selection and holdout win rates, and the parameters it changed from its starting profile. `--out FILE` writes
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
`partial`); `formatTuning(result)` is the text above and `tunedProfile(result)` the profile `--out` writes.

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
