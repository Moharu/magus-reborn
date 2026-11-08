# @magus/arena

Headless AI-vs-AI matches on the real battle engine (`@magus/engine`). One match is best-of-1, 100 HP, to the death,
with a time cap that counts as a draw. Behaviour profiles (#102), tournaments (#103), self-tuning (#104) and the
workflow (#105) build on this package.

```sh
npm run arena:match -- --seed 1          # summary of one match between the two built-in example entrants
npm run arena:match -- --seed 1 --log    # the full match log, then the summary
npm run arena:match -- --seed 1 --max-ticks 600
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

`ArenaView` is only what that player can see:

- `tick`
- `self`: `hp`, `casting` (`slot`, `spellId`, `startTick`, `castTime`, `completesAt`) or `null`, `gcdUntil`,
  `lockedUntil`, and `spells`, the player's own loadout with `castTime`, `cooldownRemaining`, `lockRemaining` and
  `ready` per slot.
- `enemy`: `hp`, `casting` (`spellId`, `startTick`, `castTime`, `completesAt`) or `null`, and `lockedUntil`. Never the
  opponent's loadout.

The runner reuses the view objects every tick. A controller that keeps a value across ticks must copy it.

Built-in controllers, only to exercise the runner: `idle()` never casts; `priority(options)` Counterspells a visible
enemy cast after a seeded reaction time (`counter`, off by default), else releases its own cast once complete (plus a
seeded `releaseJitterTicks`), else starts the first ready spell in `order`. `EXAMPLE_ENTRANTS` holds the two entrants
`arena:match` plays.

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

`TYPE` is the engine's log type: `START_CAST`, `STOP_CAST` (no spell), `SPELL_RELEASE`, `CANCEL_CAST` or
`INTERRUPTED`. For `INTERRUPTED`, `side` is the interrupted player, `spellId` the countered spell and `source` the
interrupter's spell. A `STOP_CAST` followed by a `SPELL_RELEASE` on the same tick is a release; any other `STOP_CAST`
cancelled the cast. Example:

```
0 a START_CAST SPELL_METEOR
0 b START_CAST SPELL_FIREBALL
8 b CANCEL_CAST SPELL_FIREBALL
8 b SPELL_RELEASE SPELL_COUNTERSPELL
8 a INTERRUPTED SPELL_METEOR SPELL_COUNTERSPELL
9 b START_CAST SPELL_FIREBALL
37 b STOP_CAST
...
END winner=a reason=death ticks=450 seconds=22.5 hp=16/0 casts=4/17 interrupts=0/2 seed=1
```
