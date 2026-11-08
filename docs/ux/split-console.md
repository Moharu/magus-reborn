# Split Console

Chosen direction for [#90](https://github.com/Moharu/magus-reborn/issues/90), refined in [PR #95](https://github.com/Moharu/magus-reborn/pull/95). [Open the four static sheets](mockups/index.html). These are self-contained, script-free design studies; numbers illustrate states, not balance. Implementation follows separately.

## Arena and attention

Keep the current client's blue/red robed wizards, staffs, stars, violet night gradient, mountains, moon and elliptical ring floor. Retain green HP and rounded warm Fire / violet general icons with desktop key labels. Use opaque dark-violet backing for text; the previous midnight/mint/amber console palette is retired.

You stand left, opponent right, each with numeric HP above. Round score and timer stay at top centre. Enemy cast name and short fill sit under enemy HP. Charge indicates progress, not a promised release deadline: the opponent controls release. The centre is a spell log, never a Counterspell prompt. Read readiness from your own bar.

## Floating spell log

Newest event enters at the bottom of a narrow central stack; older names move upward and leave after about 4 seconds. Show at most four on desktop and phone, coalescing repeated ticks into one named event. Event ordering follows server resolution order; simultaneous events retain their side cues. Every entry is exactly one short, non-wrapping line: one spell name or a compact outcome plus name. No sentences, receipts, secondary lines or historical lock explanations in the log. Examples: **Living Bomb**, **INTERRUPTED Fireball**, **Haste**. Keep the names short enough to fit the phone layout; ellipsis is a last-resort text-zoom safeguard, with the full event available to assistive technology and retained history. Never expose an equipped or hovered spell before it is used.

- **● own event** (YOU in its accessible label): pale sky blue `#B6E3FF`, symbol on the left, left rule and centred text.
- **enemy event ◆** (RIVAL in its accessible label): pale gold `#FFE0A8`, symbol on the right, right rule and centred text, mirroring the opponent’s position. These colours distinguish the log independently of the blue/red wizard robes.
- Successful use shows only the spell name. When needed, prefix the name with **INTERRUPTED**, **CANCELLED** or **MISS** on the same line. An interrupt entry uses the interrupting side’s cue (the source of the action), then the interrupted spell name. Do not conflate a cancelled cast with a failed Counterspell. Active casting remains by its caster; completed events enter the log.
- Interrupt breaks the affected cast track into two segments with ×; show **LOCKED 3.0s** at that caster and a lock glyph with remaining seconds over each of their seven slot icons while active. Historical interrupt entries must not imply a current lock. The sheets show an expired previous lock and a new enemy cast.
- Damage receipts such as **−12 HP** appear beside the hit wizard, paired with HP reduction. Healing uses **+**. Receipts do not replace spell outcomes.

## Equal-width MMO bar

Exactly seven equal-width targets: **Q Living Bomb · W Ignite · E Combustion · R Meteor · Space Counterspell · D Haste · F Temporal Shield**. Names are sample loadout choices; Counterspell and its position are fixed. All seven retain visible names and visual states; key reminders appear only on desktop. Never show a status caption below a spell name, including READY, FIXED or COOLDOWN. Space is a normal-width slot.

| State    | Visible treatment                                                                                                                               |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Ready    | Unobscured icon; Counterspell has a steady light border, no caption or central duplicate                                                        |
| Cooldown | Hatched icon overlay plus remaining seconds; name remains readable; desktop key remains visible                                                 |
| Locked   | Lock glyph + remaining seconds over every affected slot icon; personal cooldown continues underneath and is available in accessible description |
| GCD      | Short local sweep only when applicable; distinguish from personal cooldown and all-spell lock                                                   |

Space/D/F do not trigger or wait for the global cooldown; personal cooldowns and all-spell locks still apply. Do not add a global-cooldown exemption label to the interface. Accepted instants cancel your ongoing cast unless usable while casting. Rejected actions do not cancel it. A blocked touch gives the reason locally, without moving focus. Scope Space handling to active combat and prevent page scrolling there.

## Feedback and motion

Hard cut to ready/locked states; cast fills update locally, without pulsing. Confirmed interrupt cuts the track and retains its word/lock timer. Damage receipts hold briefly (about 600ms), then disappear; no camera shake. Log entries translate upward over about 150ms. HP uses a short fill adjustment, about 120ms. These are presentation targets, not gameplay timing. Reduced motion uses stationary log rows and immediate bar/value changes; no essential information depends on movement, sound or colour.

## Landscape phones

[Phone sheet](mockups/split-console/battle-mobile-landscape.html) shows the same instant as [desktop](mockups/split-console/battle-desktop.html). Target **844×390** and **667×375** CSS pixels. Preserve left/right fighters and top HP, compact score/timer and enemy cast; scale decorative art first. Keep the log in the gap between fighters and above the bar. Never stack the duel vertically.

Seven targets remain in a single row, equal width, at least **44×44px**, with at least 4px gaps. At 667px the sheet allocates about 84px per target; at 844px about 101px. Spell names remain visible; hide all keybind reminders on mobile, including spellbook headings, equipped-slot labels and helper text. No hover is required. Reserve bottom space for controls and apply safe-area insets in production, reducing arena ornament before touch targets. Support both thumb and keyboard input. At larger text sizes allow the HUD to occupy more height; validate on real devices with browser chrome and safe areas. Portrait offers a rotate hint and access to setup; this proposal targets landscape combat.

## Two private loadout flows

**Shared geometry:** The editable bar is the battle bar, anchored inside the same arena viewport with identical width, height, seven equal slots, icon/name sizing and desktop-only key sizing, padding and gaps. Desktop: 1200×720 arena, 86% bar width, 134px height, 18px bottom offset. At 844×390: 92% width, 86px height, 6px bottom offset. At 667×375: 96% width with 4px gaps, same 86px height and 6px bottom offset. These dimensions apply to battle, pre-game and swapping; changing screens must never move or resize a slot. The dedicated phone battle sheet also previews this compact geometry on desktop. The setup and swap sheets switch to it automatically below 901px viewport width.

**Spellbook placement:** Show all six available Fire spells (Living Bomb, Ignite, Combustion, Meteor, Fireball, Afterburn) in the left section, and all four swappable general spells (Haste, Temporal Shield, Magic Eater, Blur) in the right section. Keep both groups visible together, including equipped entries labelled with their slot on desktop only. Give the spellbook its own wider section proportions (4:2.5), rather than reserving a whole column above Space; its outer edges, padding and gap still match the bar. A clean vertical divider separates the element and general sections above the fixed Counterspell area. There is no Space/Counterspell heading, panel or replacement tile; Counterspell remains fixed on the bar.

Each entry shows its spell icon using the same glyph and warm Fire or violet general gradient as the spell bar. Desktop cards are at least 94px high with 48×48px icons and 34px glyphs. Landscape phone cards are at least 54px high, with a 32×32px icon and 26px glyph beside a readable wrapping name. Both sections have two rows (three Fire cards or two general cards per row), with padding around every icon. Spell names have no secondary status captions; selection uses a gold outline and accessible pressed state. No slot-first filtering or separate catalog panel. The spellbook bottom sits 10px above the bar. All entries fit at 844×390 and 667×375 without scrolling the controls; preserve the battle bar geometry while giving the spellbook more room.

**Pre-game:** [setup sheet](mockups/split-console/setup-pregame.html). Choose Fire; Frost and Lightning are disabled with “Locked · coming later”. Confirm a complete loadout before lobby/queue. Element then stays locked for the match. The frozen sheet selects Fireball in the spellbook (gold outline and accessible pressed state), with E marked as a compatible destination.

**Between rounds:** [swap sheet](mockups/split-console/swap-between-rounds.html). Quick private editor over the paused arena after every non-final round of Bo3/Bo5. Show score, upcoming round, countdown, own editing/ready and opponent ready state. Element is locked; no element picker. Reuse the exact same bar, complete spellbook and selection treatment as pre-game. Valid changes save immediately. Countdown expiry retains the latest complete valid loadout; incomplete drag/selection never empties a slot. Ready locks editing and exposes **Edit loadout**, which reopens it until phase end. Both ready advances to round countdown. Server owns phase deadlines; at expiry selection closes. Match result replaces swapping after a final round or draw resolution.

**Interaction on desktop and landscape phone:**

- Drag any spellbook entry onto a compatible bar slot to equip it. Drag a bar slot onto another compatible bar slot to swap them. Keep the source equipped until a valid drop commits atomically. Highlight compatible targets; show a written reason for an invalid target, including the fixed Space slot.
- Click a spellbook entry, then click a compatible bar slot to equip it. Click one bar slot, then another compatible bar slot to swap. On touch, the same paths use tap-tap. A selected source has a persistent gold outline and an accessible pressed state; a destination cue is visually distinct (dashed border). Tap/click the selected source again, press Escape or leave the phase to cancel selection.
- Element spells only enter Q/W/E/R; general spells only enter D/F. Space cannot be selected, dragged, swapped or replaced. No duplicate spells: moving an already equipped spell to another compatible slot swaps the two; a new spell replaces only the destination. Invalid drops or clicks retain the current loadout and selected source, with an accessible explanation.
- Keyboard users focus a source and press Enter/Space, then focus a destination and activate it. Suppress browser drag/scroll gestures only during an intentional spell drag; support pointer capture and cancellation without committing. These are implementation requirements; the script-free sheets freeze the selected state.

Return focus to the destination after replacement. Opponents and spectators see readiness only, never loadout names, slots, spellbook choices or swap activity. Authoritative transport must preserve that privacy, not merely hide UI.

## Accessibility and follow-through

Use semantic buttons, descriptive accessible names, visible focus and logical reading order: own HP, score/time, opponent HP/cast, log, own bar. Announce discrete outcomes in a polite bounded log; avoid tick-by-tick countdown announcements. Provide a retained event history outside the live arena for events that have scrolled away. Static sheets freeze the motion and illustrate ready/cooldown; the table specifies lock states.

Aim for WCAG AA text contrast, 3:1 meaningful boundaries, 200% text zoom and 44px targets. Validate colour-blind/grayscale recognition, keyboard-only slot replacement, screen-reader event rate, touch reach and safe-area fit before implementation approval; these sheets are not an accessibility certification.

Home/lobby/training retain the current identity. Lobby keeps two seats, private readiness, code/join actions and a separate spectator roster. Training reuses this battle HUD. Queue needs waiting/cancel; connection loss needs explicit reconnect status; results distinguish round, match and draw. Those secondary states are outside these four sheets. No owner questions remain from this round.
