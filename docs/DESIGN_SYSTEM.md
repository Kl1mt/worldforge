# Design system

The Worldforge UI language, set up in ticket 0.3. It covers GDD §3.2–§3.4. Pixel-art rules are in `ASSET_GUIDELINES.md`. Tokens live in `apps/web/src/styles/tokens.css`. Shared primitives (panels, meters, buttons, rarity classes) live in `apps/web/src/styles/base.css`.

The aim is a weathered artefact, not a dashboard. Iron, brass, dark wood and ledger paper set the tone. Corners are square, gradients appear only where light would actually fall, and glow is reserved for Legendary and Mythic items.

Screenshots of the prototype are in `docs/screenshots/phase-0/`. Regenerate them with `node tools/screenshots/phase-0.mjs` while `pnpm dev` is running. The login and register screens (ticket 1.2) are in `docs/screenshots/phase-1/` (`node tools/screenshots/auth.mjs`).

## Colour tokens

Grounds and frames come from the palette sampled in `ASSET_GUIDELINES.md`, so the UI sits in the same light as the art.

| Group | Tokens | Use |
|---|---|---|
| Grounds | `--ink-950` … `--ink-750` | Page (`950`), sunken wells (`900`), surfaces (`850`). |
| Iron | `--iron-800` … `--iron-500` | Frame bands, rules, empty sockets. |
| Wood | `--wood-800` … `--wood-600` | Stash chest, character plaque. |
| Bone (text) | `--bone-100` … `--bone-400` | Primary text → faint captions. `100`–`300` pass WCAG AA on `--ink-850` (13.3, 9.2, 5.5:1). `--bone-400` (3.1:1) is only for non-essential captions. |
| Brass (primary accent) | `--brass-700` … `--brass-300` | Headings, active navigation, focus ring, crits, gold. |
| Crimson (secondary) | `--crimson-800` … `--crimson-400` | "Fighting" status, damage taken, error states. |
| Magic / nature | `--arcane-violet`, `--arcane-blue`, `--moss-*` | Affix text (blue), kills and nature (moss). |
| Meters | `--health`, `--rage` (+ `-back`) | Resource bars. Later classes add `--mana`, `--focus` and `--soul`. |
| Deltas | `--delta-up`, `--delta-down` | Comparison gains and losses. Always shown with ▲/▼ and a hidden "Gain"/"Loss" label, never by colour alone. |

Semantic aliases (`--bg-page`, `--text`, `--text-dim`, `--accent`, `--line`, …) are what components use. Raw scale tokens are for the treatments below.

### Rarity

| Rarity | Token | Value |
|---|---|---|
| Common | `--rarity-common` | `#a7a198` |
| Uncommon | `--rarity-uncommon` | `#79a95a` |
| Rare | `--rarity-rare` | `#5292dc` |
| Epic | `--rarity-epic` | `#a46cd6` |
| Legendary | `--rarity-legendary` | `#e38b2f` |
| Mythic | `--rarity-mythic` | `#ec4a3c` |

All six pass WCAG AA as text on `--ink-850` (4.8:1 or better). Use them through the classes `.rarity-<id>`, which set `--rarity`. Components then read `var(--rarity)`. The rarity ids come from `game-core` (`RARITIES`).

Rarity is shown four ways: the frame border, a corner notch, the name colour, and the rarity word in the tooltip. Colour is never the only cue. Only Legendary and Mythic frames get a soft outer glow (GDD §3.2: effects for meaningful events). The Mythic red is deliberately brighter and warmer than the crimson accent, so a Mythic drop never reads as a UI error.

## Typography

| Role | Token | Face | Rules |
|---|---|---|---|
| Display | `--font-display` | IM Fell English SC (self-hosted via `@fontsource`) | Screen titles, section headings, the wordmark, nav labels, the crit number. Never body text, stats or numbers in tables. |
| Body / numeric | `--font-body` | Alegreya Sans 400/500/700 + italic | Everything else. `tabular-nums` is on globally, so stat columns line up. |

Scale: `--text-xs` 12, `sm` 14, `md` 16, `lg` 18, `xl` 22, `2xl` 28, `3xl` 36 px. Small caps labels use `.caps` (12 px, uppercase, `0.08em` tracking).

## Spacing, borders, radii

- Spacing is on a 4 px base: `--space-1` (4) … `--space-12` (48). The page gutter is `--gutter` (16 px), and the content max-width is `--content-max` (1320 px).
- Radius is `0`. Iron is never rounded. The two exceptions are intentional shapes, not rounded cards: the character niche's arch, and the chamfered tooltip corners (`clip-path`).
- Borders: `--border-hair` (iron-700), `--border-iron` (iron-600), `--border-brass`. Frames are built from layered `box-shadow` rings: a dark outline, an iron band, and an inner brass hairline (`--frame-iron`).

## Surface treatments

Each screen uses a different treatment, so screens do not all look like the same card (GDD §3.2).

| Treatment | Class / where | Look | Used for |
|---|---|---|---|
| Iron panel | `.panel-iron` | Riveted corners (`--rivets`), iron band, brass hairline, grain | Character attributes ledger. |
| Ledger | `.panel-ledger` | Sunken, faint ruled lines, brass top and bottom edges | Combat Chronicle. |
| Stash chest | `.stash` (inventory) | Dark-wood planks, iron straps, recessed sockets | Inventory grid. |
| Niche | `.doll__niche` (character) | Arched stone alcove, crimson under-light, wood plaque | Character portrait. |
| Scene frame | `.scene__stage` | Thick iron border, vignette | Area backdrop. |
| Tooltip plate | `.tooltip` | Chamfered corners, rim in the rarity colour, rarity wash behind the name | Item details. |
| Gate | `.gate` (`screens/gate.css`) | Lintel with the wordmark only; the fields backdrop at ×2 in the scene-stage frame beside an iron form plate. Tabs (Enter / Join) hang from the plate like the lintel nav: brass bar + diamond | Login, register, session check, server offline. |

Grain (`--texture-grain`, an inline SVG noise tile) is the only texture. Keep its opacity low.

## Components

- **PixelSprite**: renders a manifest asset at an integer scale with `image-rendering: pixelated`. It floors fractional scales. If the image fails to load, it shows a dashed "art missing" box (the error state).
- **ItemFrame**: a 32 px icon socket (×1, ×2 or ×3). Its outer size is `socketSize(scale)` = 32 × scale + 8 px (`lib/pixel.ts`). It handles rarity frame, empty state (slot name), selected state, and keyboard/button semantics.
- **ItemTooltip**: name, rarity and base type, slot and item level, base stats, affixes (blue), unique effect (rarity-coloured rule), flavour (brass italic), and an optional comparison block with ▲/▼ deltas. Comparison math is in `apps/web/src/lib/compare.ts`.
- **Meter**: health / rage / xp bars with `role="meter"`.
- **LabeledMeter**: a Meter with its name and value written above it ("Health 842 / 1,046", "Rage 62 / 100"). Used for the combatant HUD on the area scene and the character plaque. The visible text is `aria-hidden`; the meter keeps its accessible name and values.
- **Buttons**: `.btn`, an iron plate. The pressed state (`aria-pressed`) gets a brass underline. `.btn--brass` is a brass plate for the single primary action of a screen (the gate's submit); do not use it for secondary actions. Disabled buttons fade to 70 %.
- **Fields** (`.field`, in `gate.css`): a caps label, a sunken well with an iron rim (brass when focused, crimson when invalid), a faint hint, or an error line marked with ✕ plus text. Errors are tied to the input with `aria-describedby` and `aria-invalid`. Password wells have a Show/Hide toggle (`aria-pressed`).
- **Rule heading**: `.rule-heading`, display face with a brass rule that fades to the right.

## Pixel-art scaling in layouts

Ticket 0.4 raised every sprite on desktop by one integer step. Phone sizes (≤ 760 px, `PHONE_QUERY`) are the approved 0.3 sizes and do not change. Helpers and thresholds live in `apps/web/src/lib/pixel.ts`.

| Where | Phone (≤ 760 px) | Wider screens | Rule |
|---|---|---|---|
| Area backdrop | ×2, cropped around its centre | even N from `pixelScale(width, 384, { step: 2, min: 2, max: 4 })`, ×2 in the 768 px desktop column | Never shrunk. On phones the scene runs edge to edge. |
| Area hero and enemies | N/2 (×1) | **N (×2)** | `sceneSpriteScale`. Off-phone, sprites share the backdrop's pixel density. |
| Foes roster | ×1 | **×2** | Plinth grows to 140 × 136. |
| Recent spoils | ×1 | **×2** | Three per row. |
| Character portrait | ×2 / ×3 by niche width | **×4** in a 512 px niche when the doll has room | "Room" = `DOLL_LARGE_MIN_WIDTH` (936 px), the doll gets the `doll--large` class. Otherwise ×3. |
| Paper-doll sockets | ×2 | **×3** with the large doll | Slot text may wrap to two lines. |
| Inventory sockets | ×2, five per row | **×3, 8 × 5 grid** when the pack is ≥ `PACK_LARGE_MIN_WIDTH` (1270 px) | Otherwise ×2 in ten (or eight below 1260 px) columns. |
| Tooltips | ×2 | ×2 | Unchanged. |

The large character and inventory variants are chosen from the measured width of the doll and the pack body, not from the viewport, so they only switch on when the bigger art actually fits. At 1440 px both are on. At 1280 px the approved ×3 / ×2 layout is used.

## Layout and responsiveness

- Breakpoints: `760px` (phone: bottom navigation, single column, compact headings), `1080–1180px` (tablet: side columns drop below the main content).
- Navigation: a top bar on desktop. On phones, a fixed bottom bar with three 56 px tap targets, and the top bar keeps only the wordmark and gold.
- No horizontal page scroll down to 375 px. The screenshot script warns if it finds any.
- Screens: Area = scene + Chronicle side column, with foes and spoils below. On desktop the Chronicle never sets the row height: it sizes to its entries and is capped at the height of the scene and the row below it, then scrolls. It never shows empty ruled rows. Every enemy has a small name above its health bar. The current target's name is brass with a marker. On wide screens the bar spans the middle 62.5 % of the sprite so plates never touch. On phones names are 10 px. Character = three-column paper doll around the niche, with the attributes ledger and the inspected item beside it. On phones, the doll becomes a 4 × 3 socket grid under the portrait. Inventory = stash chest + pinned tooltips (selected with comparison, then currently equipped). On desktop with room, the chest is an 8 × 5 grid at ×3, about as tall as the tooltip column, so there is no empty floor under it. On phones, the grid has five sockets per row, shows four rows, and gives a free-slot count. The rarity filters sit on one horizontally scrollable row that runs to the screen edges (no visible scrollbar; the cut-off chip signals more).

## States

- **Loading / success / error:** the status bar's server line (`HealthLine`) shows "Reaching the server…", "Server online", or "Server offline: …" (`role="alert"`).
- **Session check:** while the client asks `GET /api/account`, the gate shows "Opening the gate / Checking your session…" (`role="status"`). If the server cannot be reached, it shows "The road is closed" with a Try again button. Forms show a busy label on submit ("Entering…", "Signing…"), a crimson-edged form alert (`role="alert"`) and per-field errors, and focus the first invalid field.
- **Empty:** empty equipment sockets show the slot name. An inventory filter with no matches shows an explanation and a "Show all items" action. An empty Chronicle shows a quiet line. An unequipped selected slot shows a dashed hint.
- **Missing art:** `PixelSprite` fallback.

## Accessibility

- A visible focus ring everywhere: 2 px `--focus-ring` (brass-300), offset 2 px.
- A skip link. Focus moves to `<main>` after navigation.
- Interactive sockets are `<button>`s with `aria-pressed` and full labels (slot, item, rarity). Rarity filters are a labelled button group.
- `prefers-reduced-motion` disables transitions.

## Open points

- The selected-socket outline and the focus ring are both brass. They are distinct (1 px vs 2 px, different tone), but this may need a stronger difference.
- Mana, Focus and Soul Fragments meter colours are not defined yet. They are needed once other classes are playable.
