# Asset guidelines

How Worldforge pixel art is produced, stored and rendered. Art direction comes from GDD §3.1 and §3.3; rarity colours from GDD §7.2; variant treatment from GDD §7.5.

## Folders

| Path | Contents |
|---|---|
| `art/source/pixellab/<batch>/` | Raw generator output, unedited: `NN.png`, `_contact-sheet.png`, `_job.json` (prompt, size, seed, job id). Never served. |
| `apps/web/public/assets/{items,enemies,characters,areas,hub,map}/` | Curated picks at **native resolution**, kebab-case names (`iron-helm.png`). |
| `apps/web/public/assets/manifest.json` | One entry per curated asset (see below). |
| `art/preview-phase-0.png` | Combined preview of all curated Phase 0 assets. |
| `art/preview-class-portraits.png` | The four class portraits side by side at ×3. |
| `art/preview-hub-map-areas.png` | Hub, world map and all area backdrops at ×2. |
| `art/preview-hub-map-layout.png` | Hub hotspots and map markers from the manifest, drawn over the art at ×3. |
| `art/preview-boss-uniques.png` | The three Gravewarden unique icons (after) below the shared icons they replaced (before), at ×4. |
| `art/preview-mythic-set-icons.png` | The six named Mythic icons and the three sets' pieces, below a row of tier-3 gear, at ×4. |
| `tools/art/pixellab_gen.py` | Generate/collect/contact-sheet helper. |

Curated files are byte-for-byte copies of a raw variant. Do not hand-edit them in place. If an asset needs fixing, save the edit as a new file and record it in the manifest `source`.

## Native pixel scales

| Kind | Native size | Notes |
|---|---|---|
| Item icon | 32×32 | Transparent background, object centred, roughly 45° for weapons. |
| Enemy | 64×64 | Transparent background, full body, feet on the bottom rows. |
| Character | 128×128 | Transparent background, full body. |
| Area backdrop | 384×216 | Opaque, 16:9. It fills the scene. |
| Hub, world map | 384×216 | Opaque, 16:9, same pixel scale as the backdrops. |

Assets are always stored at native size. All enlargement happens at render time.

## Rendering rules

- **Integer scaling only** (×1, ×2, ×3…). Never use fractional scales, never use CSS `width: 100%` on a sprite, and never let the browser resample it.
- Use `image-rendering: pixelated;` on every pixel-art `<img>`/canvas. Use canvas `imageSmoothingEnabled = false`.
- Pick the scale from the available space: `scale = max(1, floor(available / native))`. Centre or letterbox the remainder with the background colour. Do not stretch.
- **Scenes:** the backdrop and the sprites are scaled independently. The reference composition (see the preview) draws the backdrop at ×N and sprites at ×N/2. At ×2, for example, a 64 px enemy covers about 30% of the scene height and the 128 px warrior about 60%. Keep that ratio so enemies read as smaller than the hero.
- **Facing:** the manifest `facing` field records the source orientation (`front`, `right`). The hero stands on the left and enemies stand on the right, facing left. Mirror sprites at render time (`transform: scaleX(-1)`) rather than storing flipped copies.

## Palette

Palette follows GDD §3.3: charcoal, near-black and deep-brown grounds; weathered iron, dark wood and stone; muted gold or aged brass as the primary accent; deep crimson as the secondary accent; restrained violet and blue for magic; desaturated green for nature.

Anchors sampled from the curated art. These are reference values for UI tokens (ticket 0.3), not a hard sprite palette.

| Role | Sample | Source |
|---|---|---|
| Fog / stone grey | `#4b443f`, `#635b53` | Abandoned Fields backdrop |
| Deep brown ground | `#241d18`, `#1b1512` | Abandoned Fields backdrop |
| Crimson (cloak) | `#5c282c`, `#3f171f` | Warrior |
| Undead / nature green | `#606652`, `#43453a` | Undead farmer |

Generated sprites have about 20–40 colours (icons) and 30–50 colours (64/128 px). Backdrops have about 25 colours. Keep new art in that range. Outlines are dark (near-black) rather than coloured.

**Rarity is never baked into the art.** One base icon serves every rarity. The UI adds rarity through the frame, border, name colour and a subtle glow, using the GDD §7.2 colours (grey, green, blue, purple, orange, red). Ticket 0.3 defines the exact token values.

## Variants (Void, later Prismatic)

Variants reuse the base art (GDD §7.5). There are no separate variant sprites. Apply the treatment as layers at render time:

1. Base icon (unchanged).
2. A tint or palette-shift pass on the icon's alpha mask. For Void, that is a dark violet multiply plus lifted highlights.
3. An overlay above it: animated void motes or a crack texture, clipped to the icon's alpha (CSS `mask-image` with the icon itself, or a canvas `source-atop` composite).
4. An outer glow or rim in the variant colour, drawn outside the 32×32 sprite so the silhouette stays readable.

Overlays are authored once at native icon size (32×32, a tileable strip for animation) and live in `apps/web/public/assets/overlays/` when they are added. Any variant must stay recognisable as its base item at ×1.

## Prompt conventions (PixelLab `generate-image-v2`)

Structure: `dark fantasy pixel art, <subject>, <pose/view>, <materials and wear>, muted desaturated palette, <background>`.

- Lead with the style phrase so batches stay consistent.
- Subjects: `item icon, <object>` for icons; `full body, <creature>` for enemies and characters; `backdrop, <place>, <weather/light>` for areas.
- Materials: weathered, rusted, worn leather, old wood, aged brass. Avoid "shiny", "glowing" or "epic", because rarity and variant effects come from the UI.
- Background: `transparent background` for sprites (the helper sends `no_background: true` by default); use `--keep-background` for backdrops.
- One subject family per job. A single job returns many variants (a 32 px job yields 64), so ask for a family ("helms, gloves, rings…") and curate.
- Record the exact prompt. The API does not return it, so the helper stores it in `_job.json`, and the manifest copies it into `prompt`. Prompts marked `(reconstructed)` belong to bootstrap batches whose original prompt text was not kept.

## Using the helper

```sh
# New job (spends generations; check the budget first)
python3 tools/art/pixellab_gen.py generate --width 64 --height 64 \
  --prompt "dark fantasy pixel art, full body, bandit with hooded cloak, muted desaturated palette, transparent background" \
  --out art/source/pixellab/enemies-crowwood-01

# Match an existing sprite's pixel scale, palette, outline and shading (sent as `style_image`)
python3 tools/art/pixellab_gen.py generate --width 128 --height 128 \
  --style-image apps/web/public/assets/characters/warrior.png \
  --prompt "dark fantasy pixel art, full body, mage in frayed hooded arcane robes, ..." \
  --out art/source/pixellab/character-mage-01

# Collect a job that was already submitted (free)
python3 tools/art/pixellab_gen.py collect --job <uuid> --prompt "<prompt used>" --out art/source/pixellab/<batch>

# Rebuild a contact sheet
python3 tools/art/pixellab_gen.py sheet art/source/pixellab/<batch>
```

It uses only the async flow: it POSTs, then polls `GET /background-jobs/{id}` every 8 s. Auth is injected by the cloud proxy. Contact sheets are row-major with index labels, and small sprites are integer-upscaled.

## Manifest format

```json
{
  "version": 1,
  "assets": [
    {
      "id": "item.iron-helm",
      "path": "/assets/items/iron-helm.png",
      "kind": "item",
      "size": { "width": 32, "height": 32 },
      "prompt": "...",
      "source": "art/source/pixellab/icons-batch-01/04.png",
      "slot": "head"
    }
  ]
}
```

- `id` is `<kind>.<kebab-name>` and stays stable once referenced by content data.
- `kind` is one of `item | enemy | character | area | hub | map`.
- The optional fields are `slot` (items, using the GDD §7.1 slot family: `weapon`, `offhand`, `head`, `chest`, `hands`, `feet`, `neck`, `ring`) and `facing` (sprites).
- `hotspots` (`hub` only): clickable buildings as `{ id, label, x, y, width, height }` rectangles in native image pixels (origin top-left). Building ids: `forge`, `merchant`, `tavern`, `guildHall`, `warehouse`, `summoningShrine`, `worldMap` (the signpost and map table). Rectangles do not overlap. Whether a building is locked is game state, not art data.
- `markers` (`map` only): `{ id, x, y }` centre points in native image pixels, one per `AreaId` (including the dungeon `namelessCrypt`) plus `hub` for the town of Graumark.

When the UI scales a hub or map by an integer ×N, multiply hotspot and marker coordinates by the same N.
- Content definitions (items, enemies) should reference art by manifest `id`, not by path.

## Class portraits

Each class has a 128×128 full-body portrait at `/assets/characters/<classId>.png` (manifest id `character.<classId>`). Mage, Hunter and Warlock were generated with the warrior as `style_image`, so they share its pixel scale and palette. The web app picks the portrait with `classPortrait(classId)` (`apps/web/src/content/assets.ts`). A test checks that every class in `CLASS_IDS` has one.

## Hub, world map and area backdrops (ticket A.2)

All generated with `abandoned-fields.png` as `style_image`, so they share its pixel scale, palette (about 15–25 colours) and overcast light. Each area's backdrop id is `area.<kebab-area-id>` (`area.crowwood`, `area.old-burial-grounds`, `area.blackwater`, `area.sunken-abbey`, `area.nameless-crypt`). The hub is `hub.graumark` and the world map is `map.graumark`.

The world map came out with opaque white pixels along its burnt edge (about 1,150, all on the outer border). The curated file is `map-graumark-02/00-edge-fill.png`, which fills only those pixels with the map's own darkest colour (`#040202`); the raw `00.png` is kept unchanged. The first map attempt (`map-graumark-01`) was rejected for garbled lettering, so map prompts ask for `no text, no lettering`.

## Known gaps (Phase 0)

- There are no icons yet for the `shoulders`, `legs` or `relic` slots. Generate them in a later icons batch when those slots appear in the UI.

## Enemies & bosses (Phase 2, ticket A.3)

- Each content-contract enemy has a 64×64 sprite at `/assets/enemies/<kebab-id>.png` (manifest id `enemy.<kebab-id>`, e.g. `banditCutthroat` → `enemy.bandit-cutthroat`). They were generated per area (two enemies per job) with `undead-farmer.png` as `style_image`.
- Bosses are **128×128** at the same pixel scale (`enemy.gravewarden`, generated with the warrior as `style_image`). At the scene's sprite scale, a boss is drawn as tall as the hero and twice the size of a normal enemy.
- `facing` may also be `left`. A left-facing sprite already faces the hero, so like `front`, it is not mirrored. Only `right` is mirrored.
- Preview: `art/preview-enemies-phase-2.png` (all new enemies next to the three existing ones, plus the boss, at ×3).

## Boss-unique item icons (ticket A.5)

- The Gravewarden's three uniques have their own 32×32 icons: `item.gravewardens-cowl`, `item.seal-of-the-nameless` and `item.wardens-bone-chain`. Motifs are crypt and warden ones (seal emblem, keyhole seal on crimson wax, bone links with a crypt key) in the same palette and pixel scale as the other item icons.
- `icons-boss-uniques-01` (style image `grave-gold-ring.png`, all three items) produced the cowl and the chain. Its rings were near-copies of the style image and its chains were gold, not bone, so the one allowed regeneration, `icons-boss-uniques-02` (style image `bone-amulet.png`, ring and chain only), produced the seal ring.
- Preview: `art/preview-boss-uniques.png`.

## Mythic & set item icons (ticket A.6)

- The six named Mythics (ticket 3.2) and the 16 set pieces (ticket 3.3) have their own 32×32 icons. Each icon's manifest id is `item.<base-id>` (`item.crown-of-the-hollow-king`, `item.vigil-helm`, `item.choir-band`, `item.bloodmoon-loop`, …).
- Each set has one family look: the **Drowned Vigil** uses verdigris-green, barnacled iron with seaweed, anchor and wave motifs. The **Ashen Choir** uses soot-grey and ash-white cloth with aged-brass censer and hymn details. The **Bloodmoon Hunt** uses dark leather and iron with a blood-red crescent moon, plus fang and red-stone accents. The Mythics use blackened iron with grave-gold and crimson details. Their silhouettes (spiked crown, skull crossguard, star-caged sceptre, barbed bow, clawed heart, fanged ring) are busier than tier-3 gear, but they keep the same palette and pixel scale.
- Two jobs, no regeneration. `icons-mythic-bloodmoon-01` (style image `gravewardens-cowl.png`) produced the Mythics and the Bloodmoon Hunt. `icons-sets-vigil-choir-01` (style image `knights-plate.png`) produced the Drowned Vigil and the Ashen Choir.
- Non-named Legendary items keep their base icons. Their frame treatment comes from the UI (ticket 3.2).
- Preview: `art/preview-mythic-set-icons.png`.
