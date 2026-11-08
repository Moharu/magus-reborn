# Three spatial directions for Magus Reborn

Revision for [#90](https://github.com/Moharu/magus-reborn/issues/90) and [PR #95](https://github.com/Moharu/magus-reborn/pull/95). The previous submission changed surface styling while preserving the same composition. These proposals change combat geometry, attention priority, input arrangement and preparation workflow. The owner selects one; implementation follows separately.

**Start with [the side-by-side comparison](mockups/index.html)**, then open each full-size battle and loadout. Every sheet is standalone HTML with embedded CSS, system fonts, no scripts and no remote assets. Labels and controls are static examples, not working interactions. The index embeds all six files; narrow previews reflow, so use full-size views to assess the intended desktop layout. Wizard silhouettes are placeholders, not character-art proposals.

## Differences by design axis

| Axis                  | Split Console                                                                                                              | Duel Folio                                                                                                                                      | Anchor Ring                                                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Screen composition    | You on left, opponent on right, HP above each wizard; enemy cast beside a central decision channel; seven-slot bottom bar. | Opponent and cast in upper lane, you and HP below; wizards sit at the right of their lanes; keyboard cluster fills the separate right column.   | Diagonal wizard anchors in a central arena: you lower left, opponent upper right. HP/casts attached to opaque character stations; two-row action arc extends from your station. No global top HUD. |
| Information hierarchy | Enemy cast → central S decision → own cooldowns → HP. Central channel repeats only actionable enemy-cast information.      | Own key readiness → upper incoming cast → lower self status. S sits under W in the keyboard map, with a written decision prompt directly below. | Opponent's local cast → oversized S keystone near your wizard → HP and surrounding abilities. Interrupt opportunity is attached to the source of the threat.                                       |
| Spell bar / input     | Linear MMO bar: Q W E R, then a wider S, D F.                                                                              | Physical keyboard geometry: Q W E R on top; indented S D F beneath.                                                                             | Character-anchored arc: D / large S / F over Q W E R. Keys stay labelled; this is direct key activation, not a radial gesture menu.                                                                |
| Loadout interaction   | Slot-first workbench: choose slot, choose replacement from adjacent catalog; optional drag shortcut.                       | Entry-first spellbook: page through entries, attach a Q/W/E/R bookmark; separate permanent binding and general bookmarks.                       | Summary-first draft: select four element tiles and two general tiles, review assignment order, then confirm. No pick/ban gameplay.                                                                 |
| Feedback / motion     | Hard cuts and short local bar fills; interruption breaks a cast rule, damage arrives as a receipt.                         | Directional incoming marker and stamped words; page turn only outside combat. Interrupted casts receive an ink strike.                          | Local cast tether and expanding single ring on confirmed interrupt; damage rises beside the hit wizard. No full-screen shake.                                                                      |
| Style / palette       | Instrument console: midnight, mint HP, amber attention.                                                                    | Field manual: ivory, ink, teal HP, brown attention.                                                                                             | Ceremonial arena: violet, pale blue HP, gold attention.                                                                                                                                            |

All three change the first five axes, rather than relying on the palette difference. Key bindings and combat rules remain consistent even when their spatial presentation changes.

## Shared constraints and state vocabulary

- Exactly **4 element spells + fixed Counterspell + 2 general**. Keys remain Q/W/E/R, S, D/F. S is always named, enlarged or double-framed, and explicitly fixed during preparation. No replacement affordance on S.
- S/D/F show literal **OFF GCD** in battle and loadout. This means no global-cooldown wait or trigger; personal cooldowns and locks still apply. Instant use cancels an ongoing cast unless usable while casting. Never imply that off-GCD permits uninterrupted casting.
- All battle sheets depict the same mid-fight snapshot: you at 62/100 HP, opponent at 48/100, opponent charging Fireball, Counterspell ready, E Combustion hatched with 6.2 s cooldown. Values are illustrative, not balance specifications.
- The dashed **CAST ACTIVE / interrupt opportunity** region indicates a currently active enemy cast, not a newly invented timed bonus window. The opponent controls release. Do not invent a release deadline from the illustrative progress fill.
- Confirmed interruption: replace the affected cast with **× INTERRUPTED**, a broken track and a separate all-spell lock timer. Miss, cancellation and ordinary cooldown must have different words. Mockups show a historical confirmed interrupt receipt with its lock expired alongside the current opportunity; they do not show an active lock while claiming S is ready.
- Damage: signed number beside the affected player plus HP reduction; healing uses a plus sign. Ready uses text; cooldown uses hatch plus seconds; locked uses a lock label plus remaining duration. Names and numbers sit outside animated fills.
- Fire ◆, Frost ❄ and Lightning ϟ use labels and distinct symbols, never colour alone. Future element choice replaces the four element entries as a group; S/D/F remain stable. Only Fire is assumed available in 0.2. Frost/Lightning labels in the sheets are explicitly future annotations.
- Future matchmaking needs an explicit Find match action, waiting status and Cancel, preserving the chosen build. No invented rating or ETA. Private lobbies retain Join by code, two player seats, readiness and host settings; spectators have a separate labelled roster and Watching state.
- Connection/reconnection, setup, countdown, round result, match result, empty lists and failure need explicit text and relevant recovery actions. Results must distinguish a draw. Static sheets cover battle and preparation, not every state.

### Readability and access

Use opaque panels behind important text. Primary body text is 16px; keys and spell names remain legible through cooldowns. HP uses both numeric value and bar length. Semantic signals use words, shapes and patterns, supporting grayscale and colour-blind reading; no red/green dependency. Production targets are WCAG AA text contrast, meaningful boundaries at 3:1, visible focus, 44px action targets and 200% zoom. These are requirements, not an accessibility certification of static mockups.

At narrow widths the HTML stacks for inspection. Production must retain the same key assignments with seven explicit touch targets and a landscape combat layout; phone parity needs separate validation. Keep a logical DOM reading order and provide status/action equivalents for PixiJS. Announce discrete combat events rather than every charge tick. Test keyboard navigation, screen readers and protanopia/deuteranopia/tritanopia simulations before release.

Motion never carries essential information: reduced-motion uses stationary outlines, words and updated values. No flashing, moving backgrounds under text or audio-only alerts. Decorative art can be disabled without losing a tell. The proposed motion is described below; sheets deliberately freeze its static equivalent.

## 1. Split Console

**Rationale:** make the interrupt decision a single central scan between two evenly weighted combatants. A player can inspect the opponent on the right and press S without searching their own ability row. Best for repeated competitive practice.

**Palette/type:** background `#101923`, panels `#1D2C3B`, text `#F4F7FC`, secondary/boundaries `#C0CEDE` / `#9DB0C3`, HP `#9CE1D5`, attention `#FFD27C`. System sans and monospace in sheets. Optional production fonts: Inter and IBM Plex Mono, free under SIL OFL, self-hosted; never needed to open these files.

**Feedback:** short, linear charge fills; central cue appears when a cast can be interrupted, without pulsing. Confirmed interruption splits the enemy bar with × and writes the lock underneath. Damage uses a brief signed receipt in the hit player's panel. Frozen sheet: live dashed window, hatched E, partially depleted HP, previous interrupt receipt. Reduced motion uses the same static states.

| Surface       | Treatment                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Home          | Compact command list: Create lobby, Join by code, Training; later Find match alongside private play.                     |
| Lobby         | Left/right seat cards around a shared code; readiness by each seat, settings below, spectators in a separate lower rail. |
| Training      | Same lateral duel and central decision channel; collapsible statistics below the arena, reset next to loadout.           |
| Loadout       | Three-column element/context, equipped slots, replacement catalog. Click slot then spell; drag optional, never required. |
| Queue/results | Queue replaces the context rail with status/Cancel; results reuse left/right player comparison and a round ledger.       |

**Tradeoff:** central channel repeats enemy cast status and consumes arena width. On smaller landscape screens, shorten its prose but keep S and enemy cast timing visible. Lowest art/layout implementation effort of the three; still requires DOM/PixiJS alignment and accessibility review.

[Battle](mockups/split-console/battle.html) · [Loadout](mockups/split-console/loadout.html)

## 2. Duel Folio

**Rationale:** connect preparation with learning. The book interaction teaches spells one at a time; combat puts incoming information above the player and uses a recognisable keyboard map to the right. The vertical duel is fundamentally different from the lateral console.

**Palette/type:** parchment `#F4EDDD`, ivory `#FFFAF0`, ink `#252B30`, secondary `#48535B`, boundaries `#65727B`, HP `#245D62`, attention `#70430B`. Georgia headings with system sans body and monospace keys. Optional free SIL OFL fonts: Literata headings and Source Sans 3 body, self-hosted. No texture behind text.

**Feedback:** incoming attack indicated by a downward marker between lanes. Confirmed interrupt stamps × INTERRUPTED across the enemy track; damage is a signed notation in the affected lane. Page movement belongs only in preparation, never during combat. Frozen sheet shows the arrow, cooldown stamp and historical interruption. Reduced motion swaps any stamp transition/page turn for an immediate state change.

| Surface       | Treatment                                                                                                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home          | Table of contents: Duel, Join, Practice; later Matchmaking is a named chapter.                                                                                                         |
| Lobby         | Facing preparation pages for two players, code at the binding, spectator list beneath the book.                                                                                        |
| Training      | Upper dummy lane/lower player lane, keyboard map right, practice ledger below.                                                                                                         |
| Loadout       | Browse entry → bind bookmark to key. Left page holds four element bookmarks; right page holds fixed S and two general bookmarks. Pagination works by buttons/keyboard; not swipe-only. |
| Queue/results | Queue ticket inside cover with status/Cancel; results appear as a new ledger page with round scores.                                                                                   |

**Tradeoff:** learning emphasis costs more eye travel between upper cast and right-hand S. Needs usability testing under fast interrupts; book ornament must never encroach on the lane labels. Medium effort: pagination, bookmark interaction and separate combat layout.

[Battle](mockups/duel-folio/battle.html) · [Loadout](mockups/duel-folio/loadout.html)

## 3. Anchor Ring

**Rationale:** make the duel feel located in the arena. Wizard identity, health and casting share a local station, with your ability arc attached to your own anchor. A build-summary draft prepares the same clustered kit before combat.

**Palette/type:** void `#17142B`, panels `#2C2542`, text `#FAF5FF`, secondary `#D3C9E3`, boundaries `#BAA9CF`, HP `#B9DEFF`, attention `#FFE39A`. System sans and monospace; optional free SIL OFL Space Grotesk headings and Atkinson Hyperlegible body, self-hosted. Flat, opaque data plates protect legibility against arena art.

**Feedback:** cast energy can travel along a local tether toward the opponent; labels and straight progress track remain still. On confirmed interrupt a single broken ring expands at the caster and leaves × INTERRUPTED plus lock time. Damage rises beside the hit wizard. Frozen sheet shows local cast window, hit receipt and hatched E; reduced motion retains stationary labels and ring outline. No camera motion on HUD anchors.

| Surface       | Treatment                                                                                                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home          | Central training arena preview with destination stations around its edge; normal labelled links preserve keyboard navigation.                                                                                        |
| Lobby         | Two diagonal player anchors with the code in open central space; host settings and separate spectator roster outside the ring.                                                                                       |
| Training      | Opponent dummy at upper-right anchor, own controls at lower-left anchor; metrics in an outer rail.                                                                                                                   |
| Loadout       | Build summary first in a left rail; select four tiles from element grid, then two general tiles. Deselect before replacing at capacity. Review/reorder Q–R and D/F explicitly before confirming. S is never drafted. |
| Queue/results | Queue status/Cancel occupies summary rail; result summary occupies the centre with round ledger below, no third player station.                                                                                      |

**Tradeoff:** largest attention distance between enemy casting and own cooldown arc. Anchors must stay stable even if scene art moves. Highest effort: responsive spatial anchors and local VFX need careful occlusion/readability testing. This is not a camera-following HUD or an unlabeled gesture wheel.

[Battle](mockups/anchor-ring/battle.html) · [Loadout](mockups/anchor-ring/loadout.html)

## Short comparison

| Direction     | Best reason to choose                                       | Main risk                             | Relative effort |
| ------------- | ----------------------------------------------------------- | ------------------------------------- | --------------- |
| Split Console | Centralised interrupt decision, familiar linear keys        | Repeated cast cue takes space         | Lowest          |
| Duel Folio    | Strong learning/preparation identity; physical keyboard map | Upper-lane to right-column eye travel | Medium          |
| Anchor Ring   | Strong arena identity and character-local information       | Diagonal scanning and overlapping VFX | Highest         |

## Recommendation — Split Console

**Recommend Split Console** because the central Counterspell channel makes the core interrupt decision easiest to locate while preserving familiar linear spell ordering. Validate it against Folio's keyboard cluster and Ring's local threat cue with a short mid-fight recognition exercise before implementing. Measure whether players can identify an active enemy cast, S readiness and their cooling spell immediately; these static studies do not establish playtest results.

**Owner decision:** choose Split Console, Duel Folio or Anchor Ring. No additional product decisions are required to review these directions. Approval selects a direction only; implementation should be tracked separately.
