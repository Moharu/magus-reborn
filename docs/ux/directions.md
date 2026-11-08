# Magus Reborn: three whole-client directions

Decision proposal for [issue #90](https://github.com/Moharu/magus-reborn/issues/90). The owner chooses **one** direction; implementation belongs in separate issues. No game behaviour changes here.

Open any `battle.html` or `loadout.html` below directly from disk. Each file embeds its CSS, uses local font fallbacks, and makes no network requests. Links switch between the two mockups. These are static compositions: cards, readiness, timers and combat states do not respond to input. Wizard chess glyphs are placeholders for the existing PixiJS characters, not proposed final character art.

The issue originally suggests `docs/design/`; this delivery uses the requested `docs/ux/` location for both the proposal and all six mockups.

## Shared product contract

- **0.2 loadout:** four Fire spells on **Q W E R**, fixed **Counterspell on S**, two selected general spells on **D F**. Always show seven slots in that order, in loadout and battle. S has a double border, the word “Fixed”, and no replacement affordance. Fixed means its assignment cannot change, not that it is unavailable in combat.
- Every general spell, including Counterspell, carries a literal **OFF GCD** badge in the catalog, selected slots and battle HUD. Explain once: “Does not trigger or wait for global cooldown; cooldowns and locks still apply.” An instant cancels a current cast unless specifically usable while casting. Do not promise uninterrupted casting from this badge.
- Loadout selection is slot-first, then catalog, with visible equipped key labels; no drag-only interactions. Show spell descriptions from the catalog rather than inventing balance values. Keep the round setup timer and both players’ readiness visible. A standalone loadout save flow is a future product decision; these mockups show round preparation.
- Future element choice replaces the four element slots as a group; S/D/F stay put. Fire uses ◆, Frost ❄ and Lightning ϟ plus names, not colour alone. These symbols are visual placeholders for a consistent icon family. In 0.2 only Fire is available; future elements appear only in these proposal mockups, not as misleading live controls.
- Future random matchmaking gets a separate home action and waiting panel with queue status and cancel. It reuses the same loadout, duel, reconnect and results surfaces. No invented rating, queue ETA, or spectator permissions.
- Private lobbies prioritise a shareable code, two player seats, settings and readiness. Spectators have a separate roster/count and a clear “Watching” heading; never show their loadout as a playable third seat. Preserve existing role and capacity rules.
- Distinguish connecting, reconnecting, paused, empty lobby lists, full spectator capacity, setup, countdown, round results and match results. Errors use text plus an icon, with a recovery action where available. Never replace a connection failure with an empty-state message.

### Battle information hierarchy and accessibility baseline

HP and casts sit in stable, opaque HUD panels above the arena. Keep full player names and explicit You/Opponent labels. HP uses an exact numeric readout and bar length; colour does not change at arbitrary thresholds. Text sits beside bars rather than on a moving fill. Casts show spell name, elapsed/required time, and a fixed completion end cap. At completion add **READY · release**, a check symbol and a solid outline; do not auto-release or alter timing. Idle casts explicitly say “Not casting” in implementation.

Only a confirmed interrupt event creates the broken-bar/× tell and “SPELL INTERRUPTED”; a miss or ordinary cast cancellation must not. Show the resulting all-spell lock separately with its remaining duration, never as a normal cooldown. The mockup combines an active local cast, a confirmed opponent interrupt, and an unrelated local cooldown so those states can be compared. Illustrative timers are not balance specifications.

Cooldowns keep key and spell name legible, with a hatched fill/sweep and numeric seconds; ready slots say Ready. Locks use a lock symbol and countdown. Distinguish selected, pressed, casting, cooldown and locked states with outlines and words, not just opacity. Buff/debuff chips use name, remaining seconds and +/− labels; do not convey polarity with red/green only. Reserve one compact row beneath each player’s bars for them; the static mockups omit chips to keep the main hierarchy clear.

Implementation targets: WCAG AA text contrast (4.5:1 ordinary text), 3:1 meaningful graphical boundaries, visible keyboard focus, 44 × 44 CSS-pixel minimum targets and at least 16px primary body text. Mockup metadata is smaller; provide UI scaling and a larger-text option. Support 200% zoom and keyboard navigation in DOM screens. Battle should have a DOM status/action equivalent alongside PixiJS; announce discrete events, not every animation tick. Accessible real-time play needs its own implementation/testing work and is not established by these static files.

Use reduced motion to replace flashes, shake, pulses and sweeps with static outlines and text. No rapid flashing or sound-only cues. Permit independent VFX reduction without removing essential tells. Test protanopia, deuteranopia, tritanopia and grayscale, keyboard-only navigation and actual assistive technology before shipping.

The HTML sheets reflow below 800px for review. Production battle should preserve key/HP legibility rather than shrink a canvas to fit: prefer landscape, move secondary details below the arena, retain seven explicit touch targets, and test small screens separately. Do not imply phone control parity is solved by these sheets.

## 1. Precision

**Rationale.** Treat the client as a competitive instrument: spacious dark panels, strong alignment and restrained colour give cast timing and interrupt windows the highest priority. Home and setup teach the same visual grammar as the HUD, so players recognise their seven slots immediately on entering a duel. This is the smallest conceptual step from the existing DOM/PixiJS split and the clearest foundation for balancing and repeated practice.

**Mood / references in words:** tournament broadcast scoreboards, precision instruments, quiet strategy-game control panels; flat geometry and almost no ornament. No borrowed artwork or external reference dependencies.

**Palette:** midnight `#101827` background; slate `#192638` panels; ice `#F3F6FC` primary text; blue-gray `#B8C7DB` secondary text and boundaries; mint `#7EE0CA` HP/selected state; amber `#F6C76A` casting/attention. Element accents are confined to icons so Fire never becomes confused with danger or HP.

**Contrast:** primary and secondary text against the panel are approximately 14.1:1 and 8.9:1. HP and cast fills against the background are approximately 11.3:1 and 11.2:1. Keep labels outside fills; if an overlay is unavoidable, use midnight text, not white. Interrupts use amber plus × and a dashed broken frame. No red/green distinction is needed.

**Typography:** Inter (SIL Open Font License) for UI; IBM Plex Mono (SIL Open Font License) for keys/timers. Self-host in a future implementation; mockups use system sans and monospace with tabular numerical styling as a follow-up requirement. Avoid decorative headings and make numerals consistent between DOM and PixiJS.

| Screen   | Treatment                                                                                                                                                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home     | Compact name entry and primary Create private lobby, secondary Join by code and Training; public lobby list below with explicit Join/Watch actions. Later, Find match becomes a peer primary action rather than replacing private play. |
| Lobby    | Two aligned seat cards with ready states, central code/share area, host settings below, separate spectator rail. Watching mode substitutes a summary for playable controls.                                                             |
| Training | Same battle HUD against a quieter arena; damage/DPS/time and spell breakdown in a collapsible right rail. Reset and loadout remain near each other outside combat controls.                                                             |
| Loadout  | Left discipline/round-context rail; right slot grid and catalog. OFF GCD stays literal on S/D/F. Future element selector occupies the left rail without moving the seven slots.                                                         |
| Battle   | Symmetric top status panels, a compact central score, calm open arena, rectangular bottom action strip. Effects never cover numbers. Results reuse the score and a straightforward round table.                                         |

**Readability specifics:** HP bars are mint regardless of player side; player identity is carried by names and placement. Amber cast progress has an endpoint marker and READY label. Confirmed interrupt uses a dashed amber outline and ×; cooldown uses diagonal hatch and seconds. The double-bordered S slot anchors the general group. Enemy spell availability must only be shown when existing game state permits it.

**Accessibility:** highest priority on contrast, stable spatial grouping and reduced motion. Mint/amber remain supplementary to text and pattern. Strong focus outlines must remain distinct from equipped outlines. Reflow settings/catalog into one column; never let the training rail squeeze the combat HUD.

**Rough effort:** small–medium, approximately **6–9 developer days** after approval for shared tokens/DOM screens, seven-slot presentation, PixiJS HUD styling and responsive/accessibility verification; excludes underlying 0.2 loadout mechanics, new elements and matchmaking behaviour.

Mockups: [battle](mockups/precision/battle.html) · [loadout](mockups/precision/loadout.html).

## 2. Living Grimoire

**Rationale.** Present dueling as a craft learned from a living spellbook. A warm paper interface makes spell reading and preparation welcoming, while sharply inked rules and diagrams keep the actual duel exact. The direction makes training and loadout feel like connected chapters, giving Magus a distinct identity without requiring a large amount of illustration.

**Mood / references in words:** annotated field manuals, woodcut diagrams, library catalog cards and printed tabletop rules. Paper is a flat colour, never a noisy texture underneath text.

**Palette:** parchment `#F3EAD7` background; ivory `#FFF9ED` panels; ink `#29251E` primary text; umber `#60533F` secondary text/boundaries; forest `#285C49` HP/selection; ochre `#79530C` casts/attention. Future elements get named chapter tabs and unique symbols rather than different paper colours.

**Contrast:** primary/secondary text on ivory are approximately 14.5:1 and 7.1:1. Forest HP and ochre cast against parchment are approximately 6.5:1 and 5.7:1. Place ink labels outside fills; use ivory text if labels must appear on forest/ochre. Use a solid dark bar endpoint and an ivory gap at interruptions, not a subtle change in paper tint.

**Typography:** Literata (SIL Open Font License) for headings; Source Sans 3 (SIL Open Font License) for body/UI; IBM Plex Mono for keys and values. Mockups use Georgia/system sans/monospace. No script lettering in spell names or numerical displays. Production body stays sans even though the mockup’s surrounding editorial copy uses Georgia.

| Screen   | Treatment                                                                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home     | A book-cover title above a practical directory: private duel, code entry and practice chapter; open lobbies become legible catalog rows. Future queue is another destination tab, never hidden in lore. |
| Lobby    | Facing player “pages” divided by a shared lobby code; spectators become a labelled reader list below. Host settings read like a short form with explicit labels.                                        |
| Training | Ruled practice sheet around the same duel HUD; damage meter becomes a results ledger, with clear Reset and Change loadout actions. No new training mechanics implied.                                   |
| Loadout  | Discipline chapter tabs on the left, seven spell cards on the right, catalog below. S looks like a permanently bound card with Fixed text and double rule. Future Frost/Lightning add tabs.             |
| Battle   | Inky top bars, a ruled dueling ground and squared card slots. Thin dividers replace glow; score reads like a match notation. Results become a concise duel record.                                      |

**Readability specifics:** forest HP and ochre cast bars use white space and dark outlines to stand apart. Cast READY adds a checked end tab. Interrupt tell breaks the rule with a large × and spell label. Cooldown cards use hatch marks and printed seconds. OFF GCD is a small high-contrast typeset label, never a decorative rune.

**Accessibility:** best bright-room option. Avoid grain, tiny marginalia and low-contrast sepia body text. Offer the shared reduced-motion mode and test dark-room glare with users; an alternate dark theme would be additional work, not assumed in this estimate. Grayscale hierarchy relies on typography, solid/dashed rules and exact labels.

**Rough effort:** medium, approximately **9–13 developer days**, including consistent card/rule assets across DOM and PixiJS plus accessibility verification. Budget extra art review if custom chapter emblems are requested. Same functional exclusions as Precision.

Mockups: [battle](mockups/grimoire/battle.html) · [loadout](mockups/grimoire/loadout.html).

## 3. Astral Observatory

**Rationale.** Make the client feel like a duel staged inside an arcane observatory. Rounded instrument panels, orbital framing and a deep violet arena create a stronger fantasy spectacle, while opaque status panels protect the competitive information. This is the most expressive brand direction, suited to making elemental identities feel different through their arena art rather than rearranging the controls.

**Mood / references in words:** star charts, planetarium instruments, ceremonial arenas and luminous glass. Orbit decoration belongs in empty space; no animated particles behind the HUD.

**Palette:** void `#100F25` background; violet `#211D3C` panels; starlight `#F5F1FF` primary text; lavender `#C3B9DF` secondary text/boundaries; cyan `#91DBFF` HP/selection; gold `#F6C76A` casting/attention. Fire, Frost and Lightning may change arena ornament later; semantic HUD colours stay fixed.

**Contrast:** primary/secondary text on panels are approximately 14.5:1 and 8.7:1. Cyan HP and gold cast against void are approximately 12.3:1 and 11.9:1. Decoration may be translucent, but bar tracks, text panels and focus indicators must remain opaque. Void text is appropriate on a bright fill; starlight text is not.

**Typography:** Space Grotesk (SIL Open Font License) for headings, Atkinson Hyperlegible (SIL Open Font License) for UI, IBM Plex Mono for timing. Mockups use system fonts. Avoid condensed or widely spaced numerals in combat; the observatory theme belongs in headings and framing.

| Screen   | Treatment                                                                                                                                                                                                                        |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home     | Dramatic title framed by a static orbital arc, followed by familiar rectangular private-lobby and training actions. Future matchmaking gets a queue panel with status and cancel beneath the selected discipline.                |
| Lobby    | Two rounded player stations around the share code; spectator count/list sits below, explicitly separate from the two combatants. Settings stay in a conventional form.                                                           |
| Training | Quiet observatory platform with meter panel below, retaining the same HUD positions. Ornament fades when reading spell details; no moving star field.                                                                            |
| Loadout  | Tall discipline medallion on the left and rounded spell tiles on the right. Future elements change medallion/name and catalog, preserving key positions. S gets a double-ring frame and Fixed label.                             |
| Battle   | An elliptical arena, rounded opaque status plates and rounded rectangular action tiles. No circular progress bars: straight bars still communicate cast timing. Results use a ceremonial heading above the standard round table. |

**Readability specifics:** cyan HP and gold cast sit above the orbital art. READY uses a square endpoint/check despite rounded framing. A confirmed interrupt produces a stationary broken halo plus × text near the affected cast, never a screen-wide burst. Cooldowns keep high-contrast seconds over a dark hatch/sweep. OFF GCD remains ordinary text on S/D/F rather than a glowing dot.

**Accessibility:** eliminate ambient drift and pulsing in reduced-motion mode; all important states must work with decoration entirely hidden. Avoid bloom on glyphs and thin neon outlines. Cyan/gold plus labels and hatch support colour-blind reading; keyboard focus uses a distinct solid outer ring. Preserve a predictable reading order even when visual decoration is radial.

**Rough effort:** medium–large, approximately **12–18 developer days** including original frame/arena assets, DOM/PixiJS consistency and VFX/accessibility review. Same functional exclusions as Precision; elaborate animation or bespoke wizard art would require a separate estimate.

Mockups: [battle](mockups/observatory/battle.html) · [loadout](mockups/observatory/loadout.html).

## Comparison

Effort assumes one developer familiar with the client, reuse of existing spell icons/characters, and one review iteration. These are planning ranges, not commitments. Contrast ratios above are rounded sRGB calculations for solid colours, not a complete accessibility audit; compare actual rendered text and antialiasing during implementation. Every direction must implement the shared accessibility baseline.

| Direction          | Strongest quality                                   | Main tradeoff                                            | Future elements / queue                | Estimated effort |
| ------------------ | --------------------------------------------------- | -------------------------------------------------------- | -------------------------------------- | ---------------- |
| Precision          | Immediate competitive scanning; lowest asset burden | Less distinctive fantasy identity                        | Discipline rail / separate queue panel | 6–9 days         |
| Living Grimoire    | Spell discovery and approachable craft identity     | Light UI may glare at night; print style needs restraint | Chapter tabs / destination tab         | 9–13 days        |
| Astral Observatory | Most theatrical and ownable world                   | Ornament and VFX need stricter readability review        | Medallion + arena art / queue station  | 12–18 days       |

## Recommendation — Precision

**I recommend Precision** for the first unified client: the game’s central skill is reading charge and interrupt timing, and its restrained hierarchy puts that skill ahead of decoration. It also lets the team align DOM setup screens and the PixiJS battle HUD with the fewest bespoke assets while 0.2’s loadout evolves. Keep its semantics and geometry consistent rather than combining all three styles.

**The owner chooses the direction.** Please select Precision, Living Grimoire or Astral Observatory. Also indicate whether desktop competitive play or small-screen play is the first implementation priority; that affects layout validation and effort. Approval here selects a visual direction only. Follow-up issues should cover shared tokens/fonts, DOM surfaces, seven-slot HUD and accessible battle feedback, then element/queue presentation when those features are scheduled.
