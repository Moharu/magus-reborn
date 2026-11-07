# Magus Reborn

A fast 1v1 wizard duel for the browser. Hold a key to charge a spell, release it once the cast bar turns green. Pick six spells from the grimoire, out-damage and out-think the other wizard.

- **Training room**: practice against an idle dummy with infinite HP and a live damage meter. Runs entirely in the browser.
- **Online 1v1**: public lobby list, invite links/codes, spectators, best of 1/3/5, configurable set-up time, and optional spell changes between rounds.

## Layout

```
packages/engine   Game rules: battle loop, spells, damage meter, network protocol types. No dependencies.
apps/web          Vite + PixiJS client (static site, deployed to Cloudflare Pages).
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
npm test             # engine + lobby unit tests, and Worker/Durable Object tests in workerd
npm run typecheck
npm run format
```

### Damage simulator

`simulate({ loadout, policy, durationSeconds = 60 })` (exported from `@magus/engine`) runs the real engine against a passive training dummy and returns `{ totalDamage, dps, durationSeconds, perSpell: { [id]: { damage, casts, share } } }`. `policy` is an ordered list of rules: each tick the caster starts the first rule whose conditions hold and whose spell the engine accepts, and releases it exactly when its cast time completes. A rule is a bare spell id (unconditional) or `{ "spell": id, "when": [conditions] }` (all must hold, see below). Effect damage (Ignite, Living Bomb ticks) counts toward the spell that applied it. Optional `maxCasts: { [id]: n }` caps releases of a spell. JSON input is validated (`parseSimInput`); a bad shape exits with code 1 and a readable message.

```sh
npm run sim -w @magus/engine -- input.json    # { "loadout": [...], "policy": [...], "durationSeconds": 60 }
npm run sim -w @magus/engine -- --loadout fireball,ignite --policy ignite,fireball --duration 60
```

Spell ids are case-insensitive and the `SPELL_` prefix is optional. `--policy` defaults to the loadout order.

#### Counterspell pressure (risk index)

Every run also reports `dpsUnderPressure` and `risk = dps - dpsUnderPressure`, plus `pressure: { reactionSeconds, totalDamage, interrupts, perSpell }`: the countered casts and the pressured breakdown. The unpressured run (`dps`, `perSpell`) gives the dummy no spells at all, so there is no Counterspell threat. The model:

- The dummy holds the engine's real Counterspell. It is ready at 0 s and again `COOLDOWN` (11.7 s, from `spells/general/counterspell.ts`) after each use.
- A cast can be countered `reactionSeconds` (R, default 0.4 s, at least one 50 ms tick) after it starts, if it is still in progress. Casts shorter than R, and instants, are never countered. Neither is a cast that would deal nothing (for example one that would only land after the fight ends).
- Interrupts run the engine's Counterspell reducer: the cast's progress is lost (no damage) and `lockedUntil` locks the caster for the full 3 s.
- In each ready window the dummy counters the most valuable eligible cast: the one whose release adds the most damage by the end of the fight, measured by forking the engine at the release (DoTs and Combustion included). Ties go to the earliest cast. The window opens at the first counterable cast and lasts one cooldown.
- Lookahead is deterministic: simulate with the interrupts chosen so far, pick the next window's target, add it, re-simulate from 0, repeat until no eligible cast is left.
- Assumptions: the counterspeller's own cost (it can't cast while countering) is ignored, and fake-casting is not modelled. A PvP sim would need both.

```sh
npm run sim -w @magus/engine -- --loadout meteor --reaction 0.4   # JSON input: "pressure": { "reactionSeconds": 0.4 }
```

#### Policy rules (smart rotations)

A plain priority list collapses to its top spell: fire spells have no cooldown, so the first cast-time spell is always accepted and nothing below it ever fires. Conditions (`src/sim/policy.ts`) let a rule step aside. They only read engine state, never compute damage:

| Condition                                                                    | Holds when                                                                                          |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `{ "type": "targetEffectsBelow", "effect": id, "count": n }`                 | the target has fewer than `n` of that effect (`DEBUFF_LIVING_BOMB`, 1 = "only if not active")       |
| `{ "type": "targetEffectsAtLeast", "effect": id, "count": n }`               | the target has at least `n` (e.g. Combustion once 6 Ignites are up)                                 |
| `{ "type": "recentReleasesAtLeast", "spell": id, "count": n, "seconds": s }` | the caster released `spell` at least `n` times in the last `s` seconds (Afterburn's lookback shape) |
| `{ "type": "enemyCounterspellOnCooldown" }`                                  | the enemy has no Counterspell ready: hold long casts for the safe window after it is spent          |

```json
{
    "loadout": ["SPELL_IGNITE", "SPELL_COMBUSTION", "SPELL_METEOR"],
    "policy": [
        {
            "spell": "SPELL_COMBUSTION",
            "when": [{ "type": "targetEffectsAtLeast", "effect": "DEBUFF_IGNITE", "count": 6 }]
        },
        { "spell": "SPELL_METEOR", "when": [{ "type": "enemyCounterspellOnCooldown" }] },
        "SPELL_IGNITE"
    ]
}
```

In the unpressured run the dummy has no Counterspell, so `enemyCounterspellOnCooldown` always holds and a held Meteor is cast like a bare one. Under pressure the dummy spends its Counterspell within one cooldown window on a cheaper Ignite-phase cast, and the Meteors go out while it is down. `risk` can legitimately be negative: the policy reacts to the adversary, so under pressure it can end up with a better spell mix than it uses unpressured (for example holding Meteor forces Ignite and Combustion casts that bare Meteor spam would skip).

#### Rotation search

```sh
npm run sim:search -- --size N [--top K] [--jobs J] [--pool fireball,ignite,...] [--duration 60] [--reaction 0.4] [--cap C] [--no-dedupe]
```

Runs every loadout of 1 to `N` pool spells times every policy through `simulate` and prints the top `K` (default 10) as JSON: `{ options, evaluated, results: [{ loadout, policy, description, dps, dpsUnderPressure, risk, totalDamage, pressuredDamage, cast, castUnderPressure, interrupts, equivalents }] }`. The library API is `search`, `enumerateLoadouts(pool, size)` and `enumeratePolicies(loadout, { cap, variants, prune })` from `@magus/engine`.

- **Ranking**: `dpsUnderPressure` descending, then `dps` descending, then fewer spells, then fewer conditions, then the JSON of `[loadout, policy]` ascending. That is a total order, so the output is stable and does not depend on `--jobs`.
- **Pool**: by default the 7 spells that can change dummy damage (Fireball, Ignite, Combustion, Afterburn, Living Bomb, Meteor, Haste). Counterspell, Temporal Shield, Magic Eater and Blur deal no damage and the dummy casts nothing at you, so a real 6-slot loadout fills its spare slots with them. A result's `loadout` lists only the spells its policy uses.
- **Policies** for a loadout use each of its spells exactly once: every priority order times every combination of rule variants (`DEFAULT_RULE_VARIANTS`: Ignite bare / `< 3` / `< 6` stacks, Combustion bare / `>= 3` / `>= 6`, Afterburn bare / after 4 or 6 Fireballs in its lookback (`LOOKBACK_TIME`, 10 s), Living Bomb bare / not active, Meteor bare / held for the enemy Counterspell; others bare). So "top" means best within these fixed menus with each spell listed once: rules like `ignite [< 3] > combustion > ignite`, or other thresholds, are not searched.
- **Pruning**: a terminal rule (unconditional, cast-time, no cooldown) is only allowed last, since nothing after it can fire. A policy that would put one earlier is the same behaviour as a smaller loadout's. Not applied when the loadout has an off-GCD spell.
- **Dedupe** (default on): results that cast the same spells in both runs (`cast`, `castUnderPressure`), deal the same damage in both and get countered at the same moments (`interrupts`) are the same behaviour; they are folded into the first-ranked one and `equivalents` counts the others.
- **Bounds**: candidates per `--size` with the default pool and menus: 1: 15, 2: 127, 3: 785, 4: 3,653, 5: 12,053, 6: 25,493. `--cap C` limits the policies per loadout (first `C` in enumeration order).
- **Runtime** (60 s fight, R = 0.4 s, about 6 ms per candidate on one core): `--size 4` takes about 23 s with `--jobs 1` and 9 s with 16 jobs; the full `--size 6` search takes about 3 minutes with `--jobs 1` and about 70 s with 16 jobs. `--jobs` defaults to the available cores (at most 16); each job is a child process running one shard. CI only runs small searches (3-spell pool, size 2).

### CI

`.github/workflows/ci.yml` runs `npm ci`, `npm test`, `npm run typecheck`, `npm run format:check` and `npm run build` on every pull request into `dev` and every push to `dev`. In the branch protection rule for `dev`, mark the `ci` status check as required.

## Controls

| Key         | Slot       |
| ----------- | ---------- |
| `Q` `W` `E` | top row    |
| `A` `S` `D` | bottom row |

Keys are matched by physical position, so they work on AZERTY and other layouts. On touch screens, press and hold the spell buttons.

## Deploying

Both apps run on the Cloudflare free tier, with no custom domain:

| App                 | Hosting            | URL                                                 |
| ------------------- | ------------------ | --------------------------------------------------- |
| Client (`apps/web`) | Cloudflare Pages   | `https://magus-reborn.pages.dev`                    |
| Server              | Cloudflare Workers | `https://magus-reborn.<your-subdomain>.workers.dev` |

If another account already holds the `magus-reborn` subdomain on `pages.dev`, Cloudflare adds a suffix to it. The real URL is shown on the Pages project in the Cloudflare dashboard.

The free Workers plan is enough. Durable Objects on the free plan allow 100k requests and 13,000 GB-s of duration per day, which is roughly 29 hours of active lobby time per day. Incoming WebSocket messages are billed at 20:1 and outgoing messages are free, and an idle lobby list costs nothing thanks to WebSocket hibernation. If the daily limit is reached, new connections fail until 00:00 UTC; nothing is billed.

### Automatic deploys

`.github/workflows/deploy.yml` runs on every push to `main` and on nothing else, so merging into `dev` never deploys. It stops before deploying anything unless the code matches a `vX.Y.Z` tag exactly.

To keep a release matching its tag, `dev` is frozen from the moment of the tag until the release PR is merged, and no PRs merge into `dev` in that window. Before opening the `dev` -> `main` PR, check that `dev` still matches the tag. Merge the PR with **Create a merge commit**, never squash, because a squash makes later releases differ from their tags.

If `dev` no longer matches the tag, don't open the PR. If the deploy has already refused a merge, nothing was deployed and production stays on the previous release, but `main` now holds untagged code. Both cases need a new release: a version bump PR, a new tag and its own balance run. Don't move the existing tag, and don't tag the current code just to make the deploy pass, because that code had no balance run.

The workflow runs the tests, creates the Pages project if it is missing, deploys the server, builds the client against `VITE_SERVER_URL`, deploys the client, then checks both deployments.

It needs the following in the GitHub repo settings:

| Name                    | Type     | Value                                                                                |
| ----------------------- | -------- | ------------------------------------------------------------------------------------ |
| `CLOUDFLARE_API_TOKEN`  | Secret   | API token with Workers Scripts Edit, Cloudflare Pages Edit and Account Settings Read |
| `CLOUDFLARE_ACCOUNT_ID` | Secret   | Cloudflare account ID                                                                |
| `VITE_SERVER_URL`       | Variable | `https://magus-reborn.<your-subdomain>.workers.dev`                                  |

The account also needs a `workers.dev` subdomain. Registering one is a one-time step in the Workers section of the Cloudflare dashboard, and CI can't answer the prompt to do it.

### Client hosting

`apps/web/public/_headers` marks `/assets/*` as immutable, and Vite copies it into the build. The SPA fallback is Pages' default behaviour for a site with no top-level `404.html`, so don't add one. Don't add a `/* /index.html 200` rule to a `_redirects` file either: wrangler treats it as an infinite loop and ignores it.

`vercel.json` is no longer used for new deploys. It stays in the repository until the first Cloudflare deploy has been verified.

### Manual deploys

For recovery only, from a checkout of a tagged release, using Node 22 or newer. Let the workflow create the Pages project first.

```sh
npx wrangler login
npm run deploy:server

# From the repository root:
VITE_SERVER_URL=https://magus-reborn.<your-subdomain>.workers.dev npm run build
npx wrangler pages deploy apps/web/dist --project-name=magus-reborn --branch=main
```

While the Pages project doesn't exist, don't run `wrangler pages project create`, or `wrangler pages deploy` without `--branch`, from an AI coding agent session. In that situation wrangler 4.157 switches to a Workers deploy named after the project, and `magus-reborn` is also the server's Worker name. A non-interactive session with no wrangler config stops rather than overwriting the server, but an interactive session or a run from `apps/server` can overwrite it. The command above passes `--branch`, so it doesn't switch.

### Allowed origins

To restrict which sites can connect, set `ALLOWED_ORIGINS` in `apps/server/wrangler.toml` to a comma separated list (e.g. `https://magus-reborn.pages.dev`) and redeploy. Set it there rather than in the dashboard, because each deploy overwrites dashboard values with the ones in `wrangler.toml`.

## How a match flows

1. Both players ready up in the lobby. The host's settings lock when the match starts.
2. **Set up**: pick spells until the timer runs out. When both players are ready the timer drops to 3 seconds.
3. **Battle**: 3 second countdown, then the duel. Simultaneous deaths are a draw and count for nobody.
4. **Round over**: 10 second break, then back to set up (or straight to the next battle if spell changes are disabled).
5. First to win a majority of rounds takes the match.

If a player disconnects mid-match the game pauses. They can rejoin by reopening the lobby link from the same browser within 30 seconds, otherwise the opponent wins by forfeit.

## Credits

A spiritual successor to Sorcery Battles. Spell rules and numbers are carried over from the original; art is drawn procedurally.
