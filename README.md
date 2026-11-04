# Magus Reborn

A fast 1v1 wizard duel for the browser. Hold a key to charge a spell, release it once the cast bar turns green. Pick six spells from the grimoire, out-damage and out-think the other wizard.

- **Training room**: practice against an idle dummy with infinite HP and a live damage meter. Runs entirely in the browser.
- **Online 1v1**: public lobby list, invite links/codes, spectators, best of 1/3/5, configurable set-up time, and optional spell changes between rounds.

## Layout

```
packages/engine   Game rules: battle loop, spells, damage meter, network protocol types. No dependencies.
apps/web          Vite + PixiJS client (static site, deployed to Vercel).
apps/server       Cloudflare Worker + Durable Objects running authoritative lobbies.
```

The same engine runs the training room in the browser and online matches on the server. The server ticks every 50ms, clients only send key presses (`start_cast` / `stop_cast`) and render the state they receive.

## Development

Requires Node 20+.

```sh
npm install
npm run dev:server   # wrangler dev on http://localhost:8787
npm run dev:web      # vite on http://localhost:5173
```

The web app connects to `http://localhost:8787` unless `VITE_SERVER_URL` is set (see `apps/web/.env.example`). The training room works without the server.

```sh
npm test             # engine + lobby unit tests
npm run typecheck
npm run format
```

### Damage simulator

`simulate({ loadout, policy, durationSeconds = 60 })` (exported from `@magus/engine`) runs the real engine against a passive training dummy and returns `{ totalDamage, dps, durationSeconds, perSpell: { [id]: { damage, casts, share } } }`. `policy` is an ordered priority list: each tick the caster starts the first spell the engine accepts and releases it exactly when its cast time completes. Effect damage (Ignite, Living Bomb ticks) counts toward the spell that applied it. Optional `maxCasts: { [id]: n }` caps releases of a spell. JSON input is validated (`parseSimInput`); a bad shape exits with code 1 and a readable message.

```sh
npm run sim -w @magus/engine -- input.json    # { "loadout": [...], "policy": [...], "durationSeconds": 60 }
npm run sim -w @magus/engine -- --loadout fireball,ignite --policy ignite,fireball --duration 60
```

Spell ids are case-insensitive and the `SPELL_` prefix is optional. `--policy` defaults to the loadout order.

#### Counterspell pressure (risk index)

Every run also reports `dpsUnderPressure` and `risk = dps - dpsUnderPressure`, plus `pressure: { reactionSeconds, totalDamage, interrupts }` listing each countered cast. The model:

- The dummy holds the engine's real Counterspell. It is ready at 0 s and again `COOLDOWN` (11.7 s, from `spells/general/counterspell.ts`) after each use.
- A cast can be countered `reactionSeconds` (R, default 0.4 s) after it starts, if it is still in progress. Casts shorter than R, and instants, are never countered.
- Interrupts run the engine's Counterspell reducer: the cast's progress is lost (no damage) and `lockedUntil` locks the caster for the full 3 s.
- In each ready window the dummy counters the most valuable eligible cast: the one whose release adds the most damage by the end of the fight, measured by forking the engine at the release (DoTs and Combustion included). Ties go to the earliest cast. The window opens at the first counterable cast and lasts one cooldown.
- Lookahead is deterministic: simulate with the interrupts chosen so far, pick the next window's target, add it, re-simulate from 0, repeat until no eligible cast is left.
- Assumptions: the counterspeller's own cost (it can't cast while countering) is ignored, and fake-casting is not modelled. A PvP sim would need both.

```sh
npm run sim -w @magus/engine -- --loadout meteor --reaction 0.4   # JSON input: "pressure": { "reactionSeconds": 0.4 }
```

### CI

`.github/workflows/ci.yml` runs `npm ci`, `npm test`, `npm run typecheck`, `npm run format:check` and `npm run build` on every pull request into `dev` and every push to `dev`. In the branch protection rule for `dev`, mark the `ci` status check as required.

## Controls

| Key         | Slot       |
| ----------- | ---------- |
| `Q` `W` `E` | top row    |
| `A` `S` `D` | bottom row |

Keys are matched by physical position, so they work on AZERTY and other layouts. On touch screens, press and hold the spell buttons.

## Deploying

### 1. Server (Cloudflare Workers)

The free Workers plan is enough. Durable Objects on the free plan allow 100k requests and 13,000 GB-s of duration per day, which is roughly 29 hours of active lobby time per day. Incoming WebSocket messages are billed at 20:1 and outgoing messages are free, and an idle lobby list costs nothing thanks to WebSocket hibernation. If the daily limit is reached, new connections fail until 00:00 UTC; nothing is billed.

```sh
cd apps/server
npx wrangler login
npx wrangler deploy
```

Note the deployed URL, e.g. `https://magus-reborn.<your-subdomain>.workers.dev`.

To restrict which sites can connect, set `ALLOWED_ORIGINS` in `apps/server/wrangler.toml` to a comma separated list (e.g. `https://magus-reborn.vercel.app`) and redeploy.

### 2. Web (Vercel)

Import the repository in Vercel with the **root directory left as the repository root**; `vercel.json` handles the install, build, output directory and SPA rewrites. Add one environment variable:

```
VITE_SERVER_URL = https://magus-reborn.<your-subdomain>.workers.dev
```

Or from the CLI:

```sh
npx vercel --prod
```

## How a match flows

1. Both players ready up in the lobby. The host's settings lock when the match starts.
2. **Set up**: pick spells until the timer runs out. When both players are ready the timer drops to 3 seconds.
3. **Battle**: 3 second countdown, then the duel. Simultaneous deaths are a draw and count for nobody.
4. **Round over**: 10 second break, then back to set up (or straight to the next battle if spell changes are disabled).
5. First to win a majority of rounds takes the match.

If a player disconnects mid-match the game pauses. They can rejoin by reopening the lobby link from the same browser within 30 seconds, otherwise the opponent wins by forfeit.

## Credits

A spiritual successor to Sorcery Battles. Spell rules and numbers are carried over from the original; art is drawn procedurally.
