# @magus/arena

Headless AI-vs-AI matches on the real battle engine (`@magus/engine`). One match is best-of-1, 100 HP, to the death,
with a time cap that counts as a draw. Behaviour profiles (#102), tournaments (#103), self-tuning (#104) and the
workflow (#105) build on this package.

```sh
npm run arena:match -- --seed 1          # summary of one match between the two built-in example entrants
npm run arena:match -- --seed 1 --log    # the full match log, then the summary
npm run arena:match -- --seed 1 --max-ticks 600
npm run arena:match -- --seed 1 --a bait --b patient-counter   # two archetypes from profiles/
```

## Rules the arena keeps

- It drives the engine only through `Battle.startCast`, `Battle.stopCast` and `Battle.tick()`. Nothing under `src/`
  imports a spell module or computes damage, cooldowns or cast times: readiness comes from the engine's
  `cooldownRemaining` and `lockRemaining`, and GCD, Counterspell lock, cast cancelling and death are the engine's.
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
- `enemy`: `hp`, `casting` (`spellId`, `startTick`, `castTime`, `completesAt`) or `null`, `lockedUntil` and `effects`.
  Never the opponent's loadout, cooldowns or GCD.
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
is its `ControllerFactory`, `profileEntrant(profile, loadout)` an entrant. Every key except `intent` and a rotation
entry's `when` is required.

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
    "counterspell": {
        "enabled": true,
        "targets": ["SPELL_METEOR"], // enemy casts it interrupts
        "reaction": { "meanSeconds": 0.4, "spreadSeconds": 0.1 }, // uniform in mean ± spread, floored at 0, per cast
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
(`seconds`, optional `spells`), `enemyLocked` and `nextCastIs` (`spells`: the cast the profile starts this tick).

**Each tick** the controller: (1) cancels its fake cast once `cancelAfterSeconds` has passed, or releases a completed
cast; (2) lands a committed Counterspell; (3) picks its next cast if it has none in progress and isn't pausing after a
fake: a fake cast if `fakeCast` allows one, else the first rotation entry that is ready and whose `when` holds; (4)
uses each general spell that is ready and whose rule holds (an instant used mid-cast cancels the cast, so rules that
must not do that say `selfNotCasting`); (5) starts the cast from (3), after the general spells so Haste applies to it.
It never assumes a side.

**Counterspell model.** For each targeted enemy cast it sees, the player samples a reaction time and waits for its
decision tick: `early`, the first tick the cast is visible; `late`, the first tick the cast is within
`lateWindowSeconds` of its release. From then on, while the cast is still on the bar, it commits as soon as
Counterspell will be ready one reaction later, and the Counterspell lands one reaction after the commit whatever the
enemy does meanwhile: the enemy can't tell a fake cast from a real one, nor react to the cancel faster than to the
cast. A `late` window shorter than the reaction lands after the release.

**Fake casts (#43).** Start `fakeCast.spell`, then cancel it with `Battle.stopCast` after `cancelAfterSeconds`; the
cancel costs only the elapsed time (no lock, no damage). It baits a Counterspell when the enemy has committed before
the cancel and lands after it: against an `early` counterer with reaction `R`, the cancel must come before `R` from
the first visible tick, and `pauseAfterSeconds` must outlast it, or the Counterspell lands on the next cast. `late`
counterers decide near the release and are not fooled by short fakes.

**Archetypes** live in `profiles/<name>.json` as `{ "loadout": [...], "profile": {...} }` and load on import
(`ARCHETYPES`, `archetypeEntrant(name)`): `aggressive`, `patient-counter`, `bait` and `defensive`, each with its
intent in its file.

### Tick order and the end of a match

Each loop: both views are refreshed from the same state (the decisions are simultaneous), then `a`'s actions are
applied, then `b`'s, then `Battle.tick()`. Within a tick `a` acts first, so tournaments swap sides between games.

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
