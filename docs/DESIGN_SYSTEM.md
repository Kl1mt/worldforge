# Design system

The Worldforge UI language, set up in ticket 0.3. It covers GDD §3.2–§3.4. Pixel-art rules are in `ASSET_GUIDELINES.md`. Tokens live in `apps/web/src/styles/tokens.css`. Shared primitives (panels, meters, buttons, rarity classes) live in `apps/web/src/styles/base.css`.

The aim is a weathered artefact, not a dashboard. Iron, brass, dark wood and ledger paper set the tone. Corners are square, gradients appear only where light would actually fall, and glow is reserved for Legendary and Mythic items.

Screenshots of the prototype are in `docs/screenshots/phase-0/`. Regenerate them with `node tools/screenshots/phase-0.mjs` while `pnpm dev` is running. The login and register screens (ticket 1.2) are in `docs/screenshots/phase-1/` (`node tools/screenshots/auth.mjs`), and the character select and creation screens (ticket 1.3) next to them (`node tools/screenshots/characters.mjs`). The live game screens (ticket 1.8: area idle and farming, empty pack, comparison, after equip, character, return summary) come from the end-to-end run, `node tools/e2e/farm-loop.mjs` (see `docs/TECH_STACK.md`). The hub, world map and two areas (ticket 2.2) are in `docs/screenshots/phase-2/` (`node tools/screenshots/world.mjs` against the fast-clock e2e server). The Tavern and quest tracker (ticket 2.4) are next to them (`node tools/screenshots/tavern.mjs`, same servers). The first-session flow, the notices and the map list (ticket 2.7) are there too, from `node tools/e2e/first-session.mjs` (×600 clock, see `docs/TECH_STACK.md`). The report dialog, moderator queue and account standing (ticket 4.1) are in `docs/screenshots/phase-4/` (`node tools/screenshots/safety.mjs` against `E2E_SEED_MODERATOR=warden@graumark.test pnpm --filter @worldforge/server e2e:serve`).

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
| Banners | `--banner-ash`, `--banner-ember`, `--banner-moss`, `--banner-dusk` | The character banner cosmetic, through `.banner-<id>` (sets `--banner`). Muted dyed-cloth tones that sit behind the art. |
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

**Void (ticket 3.5).** A variant, not a rarity, so it never takes a rarity colour or the rarity's place. Tokens `--void-light` (`#b9c3e0`, a cold voidlight, 10.3:1 on `--ink-850`) and `--void-rift` (`#07060d`). On the `ItemFrame` (`.item-frame--void`) it is the one treatment that touches the art: the icon is drained (`saturate(0.4)`) and edged with one art pixel of voidlight at 70 % (a hard pixel outline via `drop-shadow`, not a glow), it sits in a dark rift instead of the rarity wash, a voidlight hairline runs inside the rarity ring, and a hollow diamond ◇ marks the lower left corner. It keeps the rarity's border, notch and (Legendary/Mythic) outer glow, so a Void Legendary still reads Legendary first. In text: "Void" in voidlight before the rarity word in the tooltip, a "◇ Void" note with the bonus, the accessible label "…, Void legendary", and the drop moment ("A Void Legendary find", the item name prefixed "Void"). No new art, no animation.

**Void in motion (ticket A.12b).** Void's own motion, cold and inward where Prismatic's sweep is warm and crosses the icon. While motion is on (the same gate as Prismatic: `prefers-reduced-motion: no-preference`, no `navigator.webdriver` unless A.14's `worldforge.sceneMotion` says `on`), the voidlight edge moves from the icon's filter to its own layer behind the icon (`.item-frame__void-edge`: a masked silhouette with four one-art-pixel drop-shadows), which **breathes** in four opacity steps (55–100 %) over 7.2 s and once a cycle **glitches** one art pixel sideways at full light for ~0.1 s; **motes** of voidlight (`void-motes.png`, a 16-frame 32 px strip) are pulled through the rift toward the centre one art pixel per 180 ms and vanish under the icon. Both layers share the icon's grid cell at its integer scale (no layout change), animate only opacity, a whole-pixel `translateX` and a stepped strip, and are not drawn while still: then the frame is exactly the 3.5 look (the still contact sheet is pixel-identical). Everywhere `ItemFrame` draws a Void item; the gallery's Variants table plays it after Play.
