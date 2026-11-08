# Changelog

All notable changes to Magus Reborn are listed here. Versions follow [semantic versioning](https://semver.org/). Each release is tagged `vX.Y.Z` on `dev` and then merged into `main`, which deploys it.

## [0.2.0] - 2026-11-08

The "Loadouts" release. Your loadout is now seven spells: four Fire spells, Counterspell in its own fixed slot, and two general spells. Counterspell moves to the Space bar, general spells no longer use the global cooldown, and you can change your loadout between rounds. This release includes every pull request merged into `dev` since v0.1.0: [#79](https://github.com/Moharu/magus-reborn/pull/79) to [#98](https://github.com/Moharu/magus-reborn/pull/98).

**Engine version:** `ENGINE_VERSION` changes from `reborn-0.1.0` to `reborn-0.2.0`. The loadout shape, the messages between client and server and the battle rules all changed. Players with the game open on the old version are asked to refresh when they try to create or join a lobby. Between the server deploy and the client deploy, online play is briefly unavailable for everyone, because the two are on different versions.

### Gameplay and engine

#### Changed

- **Seven-slot loadouts.** A loadout is 4 Fire spells (slots Q W E R), Counterspell (fixed in slot 5) and 2 general spells (slots D F). Order inside each group is free. Fire is the only element for now. The default loadout is Fireball, Ignite, Combustion, Afterburn, Counterspell, Haste, Temporal Shield. Old six-spell loadouts are no longer valid and stored ones are discarded. ([#91](https://github.com/Moharu/magus-reborn/pull/91), closes [#83](https://github.com/Moharu/magus-reborn/issues/83))
- **General spells are off the global cooldown.** Haste, Temporal Shield and Magic Eater join Counterspell and Blur: they don't start the global cooldown and the global cooldown doesn't block them. They still obey their own cooldown and the Counterspell lockout, and using one still cancels the cast you are charging. No spell numbers change. ([#92](https://github.com/Moharu/magus-reborn/pull/92), closes [#84](https://github.com/Moharu/magus-reborn/issues/84))

### Server and online play

#### Added

- **Loadout changes between rounds.** Players can change their loadout during set-up before each round. This is on by default and the host can turn it off for a lobby. Invalid loadouts are refused with a message and the previous one is kept. Changes are refused once a battle has started or the player is ready. ([#93](https://github.com/Moharu/magus-reborn/pull/93), closes [#85](https://github.com/Moharu/magus-reborn/issues/85))

#### Changed

- **Your loadout is private.** Your opponent never sees your loadout. Spectators do, once the round starts. ([#93](https://github.com/Moharu/magus-reborn/pull/93), closes [#86](https://github.com/Moharu/magus-reborn/issues/86))
- **Rate limit per player.** The message limit now belongs to the player, not the connection, so reconnecting no longer resets it. A player disconnected for flooding has to wait 10 seconds before reconnecting. ([#82](https://github.com/Moharu/magus-reborn/pull/82), closes [#75](https://github.com/Moharu/magus-reborn/issues/75))

#### Fixed

- The server no longer logs an invalid close code (1006) when a lobby-list connection drops; it replies with a normal close (1000). ([#80](https://github.com/Moharu/magus-reborn/pull/80), closes [#74](https://github.com/Moharu/magus-reborn/issues/74))

### Web client

#### Added

- **Seven-button spell bar.** Hotkeys are now Q W E R, Space (Counterspell), D F. Space casts Counterspell and the old S key no longer does anything. ([#96](https://github.com/Moharu/magus-reborn/pull/96), closes [#88](https://github.com/Moharu/magus-reborn/issues/88))
- **Loadout picker.** Pick spells by drag and drop or by tapping a spell and then a slot, before the game and between rounds (element locked, with countdown and Ready button). It is read-only when the host turned changes off. The training room uses the same picker. The spellbook cards are larger and clearer. ([#96](https://github.com/Moharu/magus-reborn/pull/96), closes [#87](https://github.com/Moharu/magus-reborn/issues/87); [#97](https://github.com/Moharu/magus-reborn/pull/97))

#### Fixed

- **Blank screen after an update.** If the battle renderer's files fail to load, for example after an update while the tab was open, you now see the refresh prompt. Other renderer start-up errors show a separate message about browser support, and online matches disconnect cleanly so you can rejoin. ([#94](https://github.com/Moharu/magus-reborn/pull/94), closes [#76](https://github.com/Moharu/magus-reborn/issues/76))

### Simulator and balance tools

#### Changed

- **`npm run sim:search`** searches the new seven-slot shape (90 loadouts) with exact pruning, so it finds the same best rotations in far less time. `--jobs` now defaults to at most 4 workers. ([#98](https://github.com/Moharu/magus-reborn/pull/98), part of [#89](https://github.com/Moharu/magus-reborn/issues/89))

### Design and docs

#### Added

- **Split Console UX spec.** The approved direction for the next battle screen: left/right combatants, a central spell log, seven equal slots and phone rules. This is design only and is not implemented yet, apart from the spellbook layout in the picker. See `docs/ux/split-console.md`. ([#95](https://github.com/Moharu/magus-reborn/pull/95), closes [#90](https://github.com/Moharu/magus-reborn/issues/90))

### Infrastructure and CI

#### Changed

- The Vercel config was removed now that the Cloudflare deploy is verified, and the docs list the real URLs. ([#79](https://github.com/Moharu/magus-reborn/pull/79), closes [#17](https://github.com/Moharu/magus-reborn/issues/17) and [#18](https://github.com/Moharu/magus-reborn/issues/18))
- The devops agent description now matches the live Cloudflare deploy. ([#81](https://github.com/Moharu/magus-reborn/pull/81))

### Known issues

- The HP bar and text in the HUD use unrounded numbers, so the colour or the figure can look slightly off. ([#23](https://github.com/Moharu/magus-reborn/issues/23))
- Only Fire exists as an element, and the Split Console battle screen and spell log are not built yet.

## [0.1.0] - 2026-11-07

The first release of Magus Reborn, a fast 1v1 wizard duel for the browser. Pick six spells from the grimoire, hold a key to charge a spell, and release it once the cast bar turns green. Practise in the training room against a dummy, or play online 1v1 through the public lobby list or an invite link, with spectators and best-of-1/3/5 matches.

This is the first release deployed to Cloudflare: the client on Pages, the server on Workers. It includes every pull request merged into `dev` so far, [#1](https://github.com/Moharu/magus-reborn/pull/1) to [#73](https://github.com/Moharu/magus-reborn/pull/73).

**Engine version:** `ENGINE_VERSION` changes from `reborn-1.0.0` to `reborn-0.1.0`, to match this release. The engine has changed in every way that calls for a new version: the battle state, the messages between client and server, and how battles play out. This is the first deployed version, and nothing was ever deployed before it. It is also the first release in which the server checks the version: it refuses to create or join a lobby for a client on any other version, and that player is asked to refresh.

### Gameplay and engine

#### Changed

- **Global cooldown.** Haste, Temporal Shield and Magic Eater now start a 1-second global cooldown, which also stops you from starting a cast. Counterspell and Blur are off the global cooldown, so you can use them during it. Spells with a cast time never start it. ([#36](https://github.com/Moharu/magus-reborn/pull/36), closes [#7](https://github.com/Moharu/magus-reborn/issues/7))
- **Instants cancel your cast.** Using an instant spell while you are charging a cast cancels that cast. An instant that can't be used yet (cooldown, global cooldown or Counterspell lockout) leaves your cast alone. ([#33](https://github.com/Moharu/magus-reborn/pull/33), closes [#25](https://github.com/Moharu/magus-reborn/issues/25))
- **Counterspell lockout.** The 3-second lockout is now tracked separately from the global cooldown. It still blocks every spell, including Counterspell and Blur, and it still can't be cleansed. ([#44](https://github.com/Moharu/magus-reborn/pull/44), closes [#37](https://github.com/Moharu/magus-reborn/issues/37))
- **Haste.** The hasted cast time is now worked out from the spell's base cast time in seconds. No cast time changes at the current tick rate. ([#61](https://github.com/Moharu/magus-reborn/pull/61), closes [#12](https://github.com/Moharu/magus-reborn/issues/12))

#### Fixed

- **Magic Eater** heals you only for damage you dealt yourself (40% of it). The heal lands at the end of the tick, the same way for both players. ([#32](https://github.com/Moharu/magus-reborn/pull/32), closes [#8](https://github.com/Moharu/magus-reborn/issues/8))
- **Death is final.** HP never goes below 0, a death caused by an instant spell is detected straight away, and nothing heals or brings back a player at 0 HP. ([#31](https://github.com/Moharu/magus-reborn/pull/31), closes [#10](https://github.com/Moharu/magus-reborn/issues/10); [#32](https://github.com/Moharu/magus-reborn/pull/32))
- **The deciding tick.** Every action in the tick that decides a duel still counts, so two lethal hits in the same tick are a draw. After that tick the result is final and no further spells go through. ([#52](https://github.com/Moharu/magus-reborn/pull/52), closes [#22](https://github.com/Moharu/magus-reborn/issues/22))
- **Combustion** now deals its damage like every other spell, so the damage meter, Magic Eater and the death check all see it. As before, it doesn't consume your Ignites. ([#30](https://github.com/Moharu/magus-reborn/pull/30), closes [#9](https://github.com/Moharu/magus-reborn/issues/9))
- **Damage over time adds up exactly.** All HP math now works in exact hundredths, so Ignite and Living Bomb ticks no longer drift from their listed totals. ([#40](https://github.com/Moharu/magus-reborn/pull/40), closes [#11](https://github.com/Moharu/magus-reborn/issues/11))

#### Added

- The battle log now records when a new cast replaces the one in progress, and when Counterspell interrupts a cast. ([#56](https://github.com/Moharu/magus-reborn/pull/56), closes [#34](https://github.com/Moharu/magus-reborn/issues/34) and [#35](https://github.com/Moharu/magus-reborn/issues/35))

### Server and online play

#### Added

- **Version check.** The server refuses to create or join a lobby for a client on a different engine version, and the player is asked to refresh. ([#72](https://github.com/Moharu/magus-reborn/pull/72), closes [#41](https://github.com/Moharu/magus-reborn/issues/41))
- **Message validation.** The server checks every message from a client and silently drops anything malformed, such as unknown message types or spell slots that don't exist. ([#63](https://github.com/Moharu/magus-reborn/pull/63), closes [#14](https://github.com/Moharu/magus-reborn/issues/14))
- **Rate limiting.** Each connection can send up to 40 messages per second. Extra messages are dropped, and a client that keeps flooding the server is disconnected. ([#67](https://github.com/Moharu/magus-reborn/pull/67), closes [#15](https://github.com/Moharu/magus-reborn/issues/15))
- **Allowed sites.** The production server only accepts connections from the official client at `https://magus-reborn.pages.dev`. Local development allows the Vite dev server only. ([#69](https://github.com/Moharu/magus-reborn/pull/69), closes [#13](https://github.com/Moharu/magus-reborn/issues/13))

#### Fixed

- A disconnect in the same tick that decides a round no longer lets the forfeit timer give the match to the wrong player, or to nobody. The round is settled first. ([#54](https://github.com/Moharu/magus-reborn/pull/54), closes [#53](https://github.com/Moharu/magus-reborn/issues/53))
- A spectator or reconnecting player joining mid-battle no longer swallows battle effects that everyone else should have seen. ([#70](https://github.com/Moharu/magus-reborn/pull/70), closes [#57](https://github.com/Moharu/magus-reborn/issues/57))

### Web client

#### Added

- **Counterspell tell.** When Counterspell interrupts a cast, both players see it: the interrupted cast bar flashes with "_Spell_ interrupted!", the interrupted wizard is hit by a cyan burst, and the caster sees "Interrupted!". ([#60](https://github.com/Moharu/magus-reborn/pull/60), closes [#39](https://github.com/Moharu/magus-reborn/issues/39))
- **Global cooldown on the action bar.** Buttons show the global cooldown, separately from the Counterspell lockout and from each spell's own cooldown. ([#55](https://github.com/Moharu/magus-reborn/pull/55), closes [#38](https://github.com/Moharu/magus-reborn/issues/38))
- **Refresh prompt.** If the game is updated while your tab is open and the battle screen can't load, you now see "A new version is available, please refresh" with a Refresh button. The client also shows this message when the server reports a version mismatch. It doesn't cover every failure yet: if one of the renderer's own files fails to load, the screen can still go blank (see Known issues). ([#68](https://github.com/Moharu/magus-reborn/pull/68), closes [#66](https://github.com/Moharu/magus-reborn/issues/66); [#72](https://github.com/Moharu/magus-reborn/pull/72))

### Simulator and balance tools

#### Added

- **Damage simulator.** `npm run sim -w @magus/engine` plays a loadout and a spell priority against a training dummy on the real engine and reports damage and DPS per spell. ([#29](https://github.com/Moharu/magus-reborn/pull/29), closes [#5](https://github.com/Moharu/magus-reborn/issues/5))
- **Counterspell pressure.** Each result also reports the DPS against an enemy who casts Counterspell every 11.7 seconds with a 0.4-second reaction time, interrupting your most valuable cast in each cooldown window, and the difference as a risk index. The enemy doesn't fake-cast to bait Counterspells. ([#49](https://github.com/Moharu/magus-reborn/pull/49), closes [#42](https://github.com/Moharu/magus-reborn/issues/42))
- **Smarter rotations.** Rotations can have conditions, such as "Ignite only below 3 stacks", and `npm run sim:search` searches loadouts and rotations within set limits. ([#51](https://github.com/Moharu/magus-reborn/pull/51), closes [#6](https://github.com/Moharu/magus-reborn/issues/6))

### Infrastructure and CI

#### Added

- **Automatic deploys.** Merging a tagged release into `main` deploys the server to Cloudflare Workers and the client to Cloudflare Pages, then checks both. Code that doesn't match a release tag is refused. ([#58](https://github.com/Moharu/magus-reborn/pull/58), closes [#24](https://github.com/Moharu/magus-reborn/issues/24); part of [#17](https://github.com/Moharu/magus-reborn/issues/17) and [#18](https://github.com/Moharu/magus-reborn/issues/18))
- **Release preflight.** Pull requests into `main` run the same release tag check before they merge. ([#71](https://github.com/Moharu/magus-reborn/pull/71), closes [#64](https://github.com/Moharu/magus-reborn/issues/64))
- **CI** on pull requests into `dev`: tests, typecheck, format check and build ([#26](https://github.com/Moharu/magus-reborn/pull/26), closes [#2](https://github.com/Moharu/magus-reborn/issues/2)), and ESLint ([#73](https://github.com/Moharu/magus-reborn/pull/73), closes [#3](https://github.com/Moharu/magus-reborn/issues/3) and [#4](https://github.com/Moharu/magus-reborn/issues/4)).
- **Secret scan.** gitleaks scans every pull request into `dev`. ([#46](https://github.com/Moharu/magus-reborn/pull/46), closes [#19](https://github.com/Moharu/magus-reborn/issues/19))
- **Server tests.** The Worker and its Durable Objects are tested inside workerd with real WebSockets. ([#59](https://github.com/Moharu/magus-reborn/pull/59), closes [#16](https://github.com/Moharu/magus-reborn/issues/16))
- **Contributor docs.** `AGENTS.md` with the code review rules and product invariants ([#48](https://github.com/Moharu/magus-reborn/pull/48), closes [#47](https://github.com/Moharu/magus-reborn/issues/47)), and the Claude Code agent definitions ([#1](https://github.com/Moharu/magus-reborn/pull/1), [#50](https://github.com/Moharu/magus-reborn/pull/50)).

#### Changed

- CI runs on Node 22 with a 10-minute job timeout. Development needs Node 22.13 or a later 22.x release, Node 24, or Node 26 and up (`^22.13.0 || ^24.0.0 || >=26.0.0`). Node 23 and 25 aren't supported. ([#62](https://github.com/Moharu/magus-reborn/pull/62), closes [#28](https://github.com/Moharu/magus-reborn/issues/28))

### Known issues

- The server logs an invalid WebSocket close code (1006) when a connection drops. ([#74](https://github.com/Moharu/magus-reborn/issues/74))
- The per-connection rate limit starts again from full when a client reconnects. ([#75](https://github.com/Moharu/magus-reborn/issues/75))
- The game screen can go blank if one of the renderer's files fails to load, for example after an update while the tab is open, and no refresh prompt appears. ([#76](https://github.com/Moharu/magus-reborn/issues/76))

[0.2.0]: https://github.com/Moharu/magus-reborn/tree/v0.2.0
[0.1.0]: https://github.com/Moharu/magus-reborn/tree/v0.1.0
