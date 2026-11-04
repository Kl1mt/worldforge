# Design system

The Worldforge UI language, set up in ticket 0.3. It covers GDD §3.2–§3.4. Pixel-art rules are in `ASSET_GUIDELINES.md`. Tokens live in `apps/web/src/styles/tokens.css`. Shared primitives (panels, meters, buttons, rarity classes) live in `apps/web/src/styles/base.css`.

The aim is a weathered artefact, not a dashboard. Iron, brass, dark wood and ledger paper set the tone. Corners are square, gradients appear only where light would actually fall, and glow is reserved for Legendary and Mythic items.

Screenshots of the prototype are in `docs/screenshots/phase-0/`. Regenerate them with `node tools/screenshots/phase-0.mjs` while `pnpm dev` is running.

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

Grain (`--texture-grain`, an inline SVG noise tile) is the only texture. Keep its opacity low.

## Components

- **PixelSprite**: renders a manifest asset at an integer scale with `image-rendering: pixelated`. It floors fractional scales. If the image fails to load, it shows a dashed "art missing" box (the error state).
- **ItemFrame**: a 32 px icon socket (×1 or ×2). It handles rarity frame, empty state (slot name), selected state, and keyboard/button semantics.
- **ItemTooltip**: name, rarity and base type, slot and item level, base stats, affixes (blue), unique effect (rarity-coloured rule), flavour (brass italic), and an optional comparison block with ▲/▼ deltas. Comparison math is in `apps/web/src/lib/compare.ts`.
- **Meter**: health / rage / xp bars with `role="meter"`.
- **Buttons**: `.btn`, an iron plate. The pressed state (`aria-pressed`) gets a brass underline.
- **Rule heading**: `.rule-heading`, display face with a brass rule that fades to the right.

## Pixel-art scaling in layouts

- **Area scene:** backdrop at an even scale N (`pixelScale(width, 384, { step: 2, min: 2, max: 4 })`), sprites at N/2. Below 768 px the backdrop stays ×2 and is cropped around its centre. It is never shrunk. On phones the scene runs edge to edge.
- **Character portrait:** ×3 on desktop, ×2 on narrow screens.
- **Item icons:** ×2 in the inventory, paper doll and tooltips. ×1 in compact lists (recent spoils, enemy roster).

## Layout and responsiveness

- Breakpoints: `760px` (phone: bottom navigation, single column, compact headings), `1080–1180px` (tablet: side columns drop below the main content).
- Navigation: a top bar on desktop. On phones, a fixed bottom bar with three 56 px tap targets, and the top bar keeps only the wordmark and gold.
- No horizontal page scroll down to 375 px. The screenshot script warns if it finds any.
- Screens: Area = scene + Chronicle side column, with foes and spoils below. Character = three-column paper doll around the niche, with the attributes ledger and the inspected item beside it. On phones, the doll becomes a 4 × 3 socket grid under the portrait. Inventory = stash chest + pinned tooltips (selected with comparison, then currently equipped). On phones, the grid has five sockets per row, shows four rows, and gives a free-slot count.

## States

- **Loading / success / error:** the status bar's server line (`HealthLine`) shows "Reaching the server…", "Server online", or "Server offline: …" (`role="alert"`).
- **Empty:** empty equipment sockets show the slot name. An inventory filter with no matches shows an explanation and a "Show all items" action. An empty Chronicle shows a quiet line. An unequipped selected slot shows a dashed hint.
- **Missing art:** `PixelSprite` fallback.

## Accessibility

- A visible focus ring everywhere: 2 px `--focus-ring` (brass-300), offset 2 px.
- A skip link. Focus moves to `<main>` after navigation.
- Interactive sockets are `<button>`s with `aria-pressed` and full labels (slot, item, rarity). Rarity filters are a labelled button group.
- `prefers-reduced-motion` disables transitions.

## Open points for ticket 0.4

- Review the screenshots against GDD §3.2 / §3.4 with the owner.
- The selected-socket outline and the focus ring are both brass. They are distinct (1 px vs 2 px, different tone), but this may need a stronger difference.
- Mana, Focus and Soul Fragments meter colours are not defined yet. They are needed once other classes are playable.
