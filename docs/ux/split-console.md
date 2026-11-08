# Split Console

Chosen direction for [#90](https://github.com/Moharu/magus-reborn/issues/90), refined in [PR #95](https://github.com/Moharu/magus-reborn/pull/95). [Open the four static sheets](mockups/index.html). These are self-contained, script-free design studies; numbers illustrate states, not balance. Implementation follows separately.

## Arena and attention

Keep the current client's blue/red robed wizards, staffs, stars, violet night gradient, mountains, moon and elliptical ring floor. Retain green HP and rounded warm Fire / violet general icons with key labels. Use opaque dark-violet backing for text; the previous midnight/mint/amber console palette is retired.

You stand left, opponent right, each with numeric HP above. Round score and timer stay at top centre. Enemy cast name and short fill sit under enemy HP. Charge indicates progress, not a promised release deadline: the opponent controls release. The centre is a spell log, never a Counterspell prompt. Read readiness from your own bar.

## Floating spell log

Newest event enters at the bottom of a narrow central stack; older names move upward and leave after about 4 seconds. Show at most four on desktop and phone, coalescing repeated ticks into one named event. Event ordering follows server resolution order; simultaneous events retain their side labels. Never expose an equipped or hovered spell before it is used.

- **● YOU**: pale sky blue `#B6E3FF`, left rule and left alignment.
- **◆ RIVAL**: pale gold `#FFE0A8`, right rule and right alignment. These colours distinguish the log independently of the blue/red wizard robes.
- Include spell name and explicit outcome: **HIT**, **× INTERRUPTED [spell]**, **CANCELLED**, **MISS**. Do not conflate a cancelled cast with a failed Counterspell. Active casting remains by its caster; completed events enter the log.
- Interrupt breaks the affected cast track into two segments with ×; show **LOCKED 3.0s** at that caster and on their own seven slots while active. Historical interrupt entries must not imply a current lock. The sheets show an expired previous lock and a new enemy cast.
- Damage receipts such as **−12 HP** appear beside the hit wizard, paired with HP reduction. Healing uses **+**. Receipts do not replace spell outcomes.

## Equal-width MMO bar

Exactly seven equal-width targets: **Q Living Bomb · W Ignite · E Combustion · R Meteor · Space Counterspell · D Haste · F Temporal Shield**. Names are sample loadout choices; Counterspell and its position are fixed. All seven retain visible keys, names and states. Space is a normal-width slot.

| State    | Visible treatment                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ready    | READY text; Counterspell has a steady light border, no central duplicate                                                                          |
| Cooldown | Hatched icon overlay plus remaining seconds; key and name remain readable                                                                         |
| Locked   | Lock glyph + LOCKED + remaining seconds on every affected slot; personal cooldown continues underneath and is available in accessible description |
| GCD      | Short local sweep only when applicable; distinguish from personal cooldown and all-spell lock                                                     |

Space/D/F are **OFF GCD**: no GCD trigger or wait, but personal cooldowns and all-spell locks still apply. Accepted instants cancel your ongoing cast unless usable while casting. Rejected actions do not cancel it. A blocked touch gives the reason locally, without moving focus. Scope Space handling to active combat and prevent page scrolling there.

## Feedback and motion

Hard cut to ready/locked states; cast fills update locally, without pulsing. Confirmed interrupt cuts the track and retains its word/lock timer. Damage receipts hold briefly (about 600ms), then disappear; no camera shake. Log entries translate upward over about 150ms. HP uses a short fill adjustment, about 120ms. These are presentation targets, not gameplay timing. Reduced motion uses stationary log rows and immediate bar/value changes; no essential information depends on movement, sound or colour.

## Landscape phones

[Phone sheet](mockups/split-console/battle-mobile-landscape.html) shows the same instant as [desktop](mockups/split-console/battle-desktop.html). Target **844×390** and **667×375** CSS pixels. Preserve left/right fighters and top HP, compact score/timer and enemy cast; scale decorative art first. Keep the log in the gap between fighters and above the bar. Never stack the duel vertically.

Seven targets remain in a single row, equal width, at least **44×44px**, with at least 4px gaps. At 667px the sheet allocates about 84px per target; at 844px about 101px. Compact labels remain visible; no hover is required. Reserve bottom space for controls and apply safe-area insets in production, reducing arena ornament before touch targets. Support both thumb and keyboard input. At larger text sizes allow the HUD to occupy more height; validate on real devices with browser chrome and safe areas. Portrait offers a rotate hint and access to setup; this proposal targets landscape combat.

## Two private loadout flows

**Pre-game:** [setup sheet](mockups/split-console/setup-pregame.html). Choose Fire; Frost and Lightning are disabled with “Locked · coming later”. Choose a slot, then choose a compatible spell from the catalog. Four element slots, fixed Counterspell, two general slots. Selection highlights both slot and equipped catalog entry; choosing a replacement commits it and announces the change. Prevent duplicates and incompatible choices with a written reason. Confirm a complete loadout before lobby/queue. Element then stays locked for the match.

**Between rounds:** [swap sheet](mockups/split-console/swap-between-rounds.html). Compact overlay on the paused arena after every non-final round of Bo3/Bo5. Show score, upcoming round, countdown, own editing/ready and opponent ready state. Element is locked; only Q–R and D/F are editable. No element picker. Same slot-first catalog, with immediate valid saves. Countdown expiry retains the latest complete valid loadout; incomplete drag/selection never empties a slot. Ready locks editing; Edit loadout reopens it until phase end. Both ready advances to round countdown. Server owns phase deadlines; at expiry selection closes. Match result replaces swapping after a final round or draw resolution.

In both flows, dragging is optional; click/tap and keyboard selection are complete paths. Return focus to the chosen slot after replacement. Opponents and spectators see readiness only, never loadout names, slots, catalog choices or swap activity. Authoritative transport must preserve that privacy, not merely hide UI.

## Accessibility and follow-through

Use semantic buttons, descriptive accessible names, visible focus and logical reading order: own HP, score/time, opponent HP/cast, log, own bar. Announce discrete outcomes in a polite bounded log; avoid tick-by-tick countdown announcements. Provide a retained event history outside the live arena for events that have scrolled away. Static sheets freeze the motion and illustrate ready/cooldown; the table specifies lock states.

Aim for WCAG AA text contrast, 3:1 meaningful boundaries, 200% text zoom and 44px targets. Validate colour-blind/grayscale recognition, keyboard-only slot replacement, screen-reader event rate, touch reach and safe-area fit before implementation approval; these sheets are not an accessibility certification.

Home/lobby/training retain the current identity. Lobby keeps two seats, private readiness, code/join actions and a separate spectator roster. Training reuses this battle HUD. Queue needs waiting/cancel; connection loss needs explicit reconnect status; results distinguish round, match and draw. Those secondary states are outside these four sheets. No owner questions remain from this round.
