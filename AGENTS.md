# AGENTS.md

## Overview

magus-reborn is a 1v1 wizard-battle web game inspired by WoW caster PvP. It is a TypeScript monorepo using npm workspaces:

- `packages/engine`: the deterministic battle engine. It runs on fixed 50 ms ticks (`GAME_TICK_INTERVAL` in `packages/engine/src/constants.ts`). It also contains the spells (`src/spells/`), the catalog and the DPS simulator (`src/sim/`).
- `apps/web`: the browser client, built with PixiJS.
- `apps/server`: a Cloudflare Worker with Durable Objects (lobbies and authoritative battles).

Git flow: work branches come from `dev` and PRs target `dev`. `main` only receives tagged releases from `dev`.

## Running the checks

```sh
npm ci
npm test               # vitest
npm run typecheck
npm run format:check   # prettier
npm run build          # web client
```

CI (`ci`) and the secret scan (`gitleaks`) must both pass on PRs into `dev`.

## Code Review Rules

You are the final, adversarial reviewer. The Claude code reviewer has already approved the PR. Assume it still contains a bug and try to find it:

- Try to break the change. Hunt for edge cases, off-by-one tick errors and ordering bugs: effect order within a tick, player1 vs player2 order, a cast vs a tick, expiry on the last tick.
- Check that the new or changed tests would fail without the change. Flag tests that pass trivially or only assert the implementation.
- Check every acceptance criterion against the linked issue (`Closes #N`). Report any criterion that is missing or only partly met.
- Flag security issues: untrusted client messages reaching the server, missing input validation, and any exposure of secrets, tokens or `.env`/`.dev.vars` contents.

### Product invariants (must not break)

These are intended behaviour. A change that breaks one is a bug.

1. The GCD is 1 s, derived from the tick constant (`GLOBAL_COOLDOWN = secondsToTicks(GLOBAL_COOLDOWN_SECONDS)`). Haste, Temporal Shield and Magic Eater trigger it. Counterspell and Blur are off-GCD (`offGlobalCooldown`). Cast-time spells are blocked by the GCD but don't trigger it.
2. Using an instant mid-cast cancels the cast, unless the spell is `usableWhileCasting`. An instant rejected by the GCD, a lock or a cooldown does not cancel the cast. Starting a new cast replaces the current one.
3. The Counterspell lockout lasts 3 s, can't be cleansed (Blur skips it) and blocks every spell, including off-GCD ones (`lockedUntil`, separate from the GCD).
4. Death is final the moment HP reaches 0: nothing heals or rewinds a player at 0 HP. If both players take lethal damage in the same tick, the result is a draw.
5. Temporal Shield rewinds HP to exactly the HP at cast time when it expires.
6. Magic Eater heals its owner for 40% of the damage that owner dealt. The heal is applied at the end of the tick, after both players' effects, the same way for both players.
7. Combustion deals the remaining Ignite damage and does NOT consume Ignites. Ignite stacks have no cap.
8. All HP math is in exact hundredths (centi-HP integers via `toCenti`/`fromCenti`). No float drift.
9. The engine is deterministic: no `Math.random`, `Date.now` or other non-deterministic sources in `packages/engine`.
10. The simulator must drive the real engine (`Battle.startCast`/`stopCast`/`tick`). It must not reimplement spell math.

Do not report intended product behaviour as a bug. For example, Combustion keeping Ignites, uncapped Ignite stacks and Counterspell being off-GCD are all intended. Balance numbers (damage, cast times, cooldowns) are product decisions. Don't flag them unless the PR changes them without the linked issue asking for it.
