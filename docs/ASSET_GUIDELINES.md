# Asset guidelines

How Worldforge pixel art is produced, stored and rendered. Art direction comes from GDD §3.1 and §3.3; rarity colours from GDD §7.2; variant treatment from GDD §7.5.

## Folders

| Path | Contents |
|---|---|
| `art/source/pixellab/<batch>/` | Raw generator output, unedited: `NN.png`, `_contact-sheet.png`, `_job.json` (prompt, size, seed, job id). Never served. |
| `apps/web/public/assets/{items,enemies,characters,areas,hub,map,materials,achievements,guild-emblems,frames,badges}/` | Curated picks at **native resolution**, kebab-case names (`iron-helm.png`). |
| `apps/web/public/assets/manifest.json` | One entry per curated asset (see below). |
| `art/preview-phase-0.png` | Combined preview of all curated Phase 0 assets. |
| `art/preview-class-portraits.png` | The four class portraits side by side at ×3. |
| `art/preview-hub-map-areas.png` | Hub, world map and all area backdrops at ×2. |
| `art/preview-hub-map-layout.png` | Hub hotspots and map markers from the manifest, drawn over the art at ×3. |
| `art/preview-boss-uniques.png` | The three Gravewarden unique icons (after) below the shared icons they replaced (before), at ×4. |
| `art/preview-mythic-set-icons.png` | The six named Mythic icons and the three sets' pieces, below a row of tier-3 gear, at ×4. |
| `art/preview-heraldry.png` | The achievement icons and guild emblems at ×4, below a row of item icons for scale. |
| `art/preview-project-achievements.png` | The two community-project achievement icons (A.9) below A.8's achievement set, at ×4. |
| `art/preview-ashen-pass.png` | The Ashen Pass backdrop next to the Sunken Abbey, its four enemies below the existing ones, and the Ashen Warden next to the Gravewarden. |
| `art/preview-prestige.png` | The season frames around a sample crest (×1, ×2) and the warrior portrait (×4), the title badges (×2, ×1, 24 and 16 px), and the arena backdrop next to the Ashen Pass and the Sunken Abbey (A.10). Same image as `docs/screenshots/phase-5/a10-contact-sheet.png`; rebuild with `python3 tools/art/preview_prestige.py`. |
| `art/preview-hero-frames.png` | The four hero attack loops (A.14): raw PixelLab frames above the cleaned sheet, per class, at ×2. Rebuild with `python3 tools/art/hero_frames.py`. |
| `tools/art/pixellab_gen.py` | Generate/collect/contact-sheet helper. |
| `tools/art/pixellab_animate.py` | Frame-animation helper (`animate-with-text-v3`, async). |

Curated files are byte-for-byte copies of a raw variant. Do not hand-edit them in place. If an asset needs fixing, save the edit as a new file and record it in the manifest `source`.

## Native pixel scales

| Kind | Native size | Notes |
|---|---|---|
| Item icon | 32×32 | Transparent background, object centred, roughly 45° for weapons. |
| Achievement icon, guild emblem | 32×32 | Same pixel scale as item icons. Emblems are a single charge, upright and centred. |
| Season frame | 64×64 | Transparent outside and inside the bands. Fixed layout (not 9-slice): content fills the 36×36 window at (14, 14) and the frame is drawn on top. |
| Title badge | 32×32 | Same pixel scale as item icons: a brass-rimmed dark disc with one emblem. |
| Enemy | 64×64 | Transparent background, full body, feet on the bottom rows. |
| Character | 128×128 | Transparent background, full body. |
| Frame sheet | N × (frame size) in one row | Same frame size and treatment as the still; frame 0 is the still itself (A.14). |
| Area backdrop, arena | 384×216 | Opaque, 16:9. It fills the scene. |
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
- `kind` is one of `item | material | enemy | character | area | hub | map | achievement | guild-emblem | frame | badge`.
- `frames` (frame sheets only): the number of frames in the row; `size` is one frame's size, so the PNG is `frames × width` wide.
- The optional fields are `slot` (items, using the GDD §7.1 slot family: `weapon`, `offhand`, `head`, `chest`, `hands`, `feet`, `neck`, `ring`) and `facing` (sprites).
- `hotspots` (`hub` only): clickable buildings as `{ id, label, x, y, width, height }` rectangles in native image pixels (origin top-left). Building ids: `forge`, `merchant`, `tavern`, `guildHall`, `warehouse`, `summoningShrine`, `worldMap` (the signpost and map table). Rectangles do not overlap. Whether a building is locked is game state, not art data.
- `window` (`frame` only): `{ x, y, width, height }`, the content box in native frame pixels (see the A.10 section).
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

## The Ashen Pass (ticket A.7)

- Art for the top-end region that ticket 4.8 builds. The content ids are fixed: area `ashenPass` (levels 24–28), enemies `ashWraith`, `cinderHound`, `pyreCultist`, `emberGolem`, and boss `ashenWarden`. Their asset ids follow the usual rule: `area.ashen-pass`, `enemy.ash-wraith`, `enemy.cinder-hound`, `enemy.pyre-cultist`, `enemy.ember-golem` and `enemy.ashen-warden` (128×128).
- The look is burnt and cold: ash-grey and charcoal with dim ember-orange accents (cracks, seams, embers). Orange stays a small accent, as crimson does elsewhere. The Ashen Warden is scorched black plate with brass trim and a smouldering greatsword on its shoulder. It has no shield, lantern or horns, so its silhouette differs from the Gravewarden's.
- Four jobs and no regeneration. `area-ashen-pass-01` used `sunken-abbey.png` as its style image. `enemies-ashen-pass-01` (wraith and cultist) used `abbey-wraith.png`. `enemies-ashen-pass-02` (hound and golem) used `fallen-knight.png`. `boss-ashen-warden-01` used `gravewarden.png`.
- The art is registered in the manifest and `assets.ts`. Ticket 4.8 wired it: each enemy and the area carry these `assetId`s in game-core, and the Warden's Watch (the boss-only run) reuses `area.ashen-pass` as its backdrop. The map art has no painted spot for the pass, so `MAP_MARKERS` (and the manifest's `map.graumark` markers) place `ashenPass` (52, 40) and `ashenWatch` (104, 26) in the north-west mountains.
- Preview: `art/preview-ashen-pass.png`.

## Achievement & guild heraldry icons (ticket A.8)

- Each achievement (`ACHIEVEMENTS`, ticket 4.2) has a 32×32 icon at `/assets/achievements/<kebab-id>.png` (manifest id = the definition's `assetId`, e.g. `achievement.gravewarden-slain`). Each is an emblematic object for the deed (a violet-gem medallion, an ember-wreathed blade, a blood chalice, a helm on its breastplate, hammer, anvil, iron and brass laurels, a snapped crypt key, the crypt stair, a candle-skull, a sealed scroll, a coin purse, a contract pinned by a dagger). They are slightly more medallion-like than items, but they use the same palette and pixel scale.
- Each guild emblem (`GUILD_EMBLEMS`, ticket 4.4) has a 32×32 charge at `/assets/guild-emblems/<id>.png` (`guild-emblem.<id>`). They are bone-white and aged brass with a near-black outline and flat heraldic shading, so they read on every shield dye. A.8 added six emblems to the first six: `wolf`, `key`, `crown`, `moon`, `serpent`, `chalice` (data only; each also needs a `--dye` in `social/crest.css`).
- Two jobs, no regeneration. `icons-achievements-01` (style image `seal-of-the-nameless.png`) and `emblems-guild-01` (style image `raven-talisman.png`).
- Every key in the achievements batch came out whole, so the Gravewarden's "broken crypt key" is an edit: `icons-achievements-01/edits/48-broken.png` cuts brass key `48.png` across the shaft and knocks the bit end one pixel down-left, re-outlining the broken ends. The raw `48.png` is kept unchanged.
- The UI draws them at integer scales (the crest at ×1/×2, deed seals at ×2/×1). If an id is not registered or the file fails to load, it falls back to the 4.2/4.4 placeholders (wax seal with an initial, glyph on the shield). A web test checks that every achievement and emblem has a 32×32 entry.
- Preview: `art/preview-heraldry.png`. Screenshots: `docs/screenshots/phase-4/heraldry-*.png` (`node tools/screenshots/heraldry.mjs`, plus `guilds.mjs` for the crest choice).

## Community project achievement icons (ticket A.9)

- The two 4.6 project deeds have icons now, so every achievement in `ACHIEVEMENTS` is drawn: `achievement.warehouse-restorer` ("Mender of Graumark", an iron key in the lock of a restored, iron-banded oak door) and `achievement.ashen-pass-breaker` ("Through the Ash", a cracked watchtower with an ember at its broken top).
- One 32px job, no regeneration: `icons-achievements-02` (style image `achievements/contracts-10.png`). Picks `00.png` and `28.png`, unedited. The batch also holds a crate with a hammer, key rings, broken chains on ash and an ember-wreathed gate, unused.
- Preview: `art/preview-project-achievements.png`.

## Season frames, title badges & the arena (ticket A.10)

- Art for season prestige (ticket 5.3) and the duel screen (ticket 5.5). It is registered but not drawn anywhere yet. The file names are fixed, because 5.3 and 5.5 build on them:
  - **Profile frames**, best to least: `frames/season-frame-champion.png` (grave-gold with crimson gems and a small spiked crown), `season-frame-exalted.png` (engraved aged brass with skull bosses), `season-frame-renowned.png` (dark iron with brass corner plates), `season-frame-veteran.png` (plain riveted iron). Ids `frame.season-frame-<tier>`; helper `seasonFrameAsset(tier)` over `SEASON_FRAME_TIERS`.
  - **Title badges**, one per leaderboard metric: `badges/title-badge-level.png` (stacked chevrons), `title-badge-gear-score.png` (crossed swords over a shield), `title-badge-power.png` (a clenched gauntlet), `title-badge-pve-progress.png` (a crimson pennant planted on a skull). Ids `badge.title-badge-<metric>`; helper `titleBadgeAsset(metric)` takes game-core's `ScoreMetric`.
  - **Arena backdrop**: `areas/arena.png` (`area.arena`, helper `arenaBackdrop()`), an empty ruined round arena with a sand floor, crimson banners and braziers, at the area backdrop size and treatment.
- **Frame layout.** All four frames share one fixed layout (not 9-slice: the bands are textured and the corners ornamented, so they don't tile). The frame is 64×64 and has transparent margins, so the tiers can be swapped without moving anything. Fill the **window** `{ x: 14, y: 14, width: 36, height: 36 }` (`SEASON_FRAME_WINDOW`, also in the manifest) with the content and its well, then draw the frame on top at the same integer scale. The bands cover the window's edge in every tier, and the corner bosses of exalted and champion overlap its corners. The central 32×32 at (16, 16) is always visible. Scales: ×1 (64 px) around a 32 px charge or a small crest, ×2 (128 px) around a 64 px avatar or crest, ×4 (256 px) around the 128 px class portrait. The champion's crown rises about 5 px above the other frames' top bands, still inside the 64×64 box.
- **Badges at small sizes.** Draw a badge at ×1 (32 px) where there is room. In a 16–24 px slot (a board row, a name line) it may be shrunk with smooth filtering, which is the one exception to the integer-scaling rule. Prefer 24 px. At 16 px the ring and the emblem's colour carry it, so put the badge next to its text label (the title or the board name), never alone.
- Three jobs, no regeneration (35 generations): `frames-season-01` (64×64, style image `achievements/level-10.png`; one row of four variants per tier), `badges-titles-01` (32×32, style image `achievements/level-20.png`) and `area-arena-01` (style image `areas/sunken-abbey.png`). Picks: frames `00` (veteran), `04` (renowned), `08` (exalted), `12` (champion); badges `00`, `01`, `02`, `19`; arena `00`. All are alpha-keyed with no partial alpha, like the rest of the art.
- Two edits, saved next to the raw files (which stay unchanged). `frames-season-01/edits/12-trim.png` drops one duplicated row of the champion's side posts (row 50), so its opening ends at row 49 like the others and the shared window is centred. `badges-titles-01/edits/02-lifted.png` lifts the gauntlet (×1.6 brightness with a warm bias, then snapped to the batch's own palette) so it reads on the dark disc like the other emblems. The outline and the ring are untouched.
- Preview: `art/preview-prestige.png`. A web test checks that every tier, metric and the arena resolves to a manifest entry and a file of the right size, and that the frames carry the shared window.

## Hero attack frames (ticket A.14)

- Each class has an attack loop next to its portrait: `/assets/characters/<classId>-attack.png`, manifest id `character.<classId>-attack`, helper `classAttackSheet(classId)`. One row of **8 frames of 128×128** (1024×128 PNG, `"frames": 8`). Frame 0 is the portrait itself (pasted, unchanged), so the sheet rests on the familiar pose; frames 1–7 are the swing and the return.
- **Frame sheets in general:** one row, every frame the still's size, anchored the same way (feet on the same rows), alpha 0 or 255 only, the still's own palette. The UI plays a sheet with a CSS `steps(frames)` slide of the strip inside a one-frame window (`PixelSprite`), at an integer scale; nothing is resampled.
- Made with `animate-with-text-v3` (async; `tools/art/pixellab_animate.py --loop`): the portrait as `first_frame` and as `last_frame`, 8 frames, an action that names the motion toward the right of the image. The job's last frame (a near-copy of the portrait) is dropped.
- **Clean-up** (`tools/art/hero_frames.py`): every frame is snapped to the colours of its own portrait (nearest colour, weighted RGB) and alpha is forced to 0/255. That pulls the mage's cyan flare onto the crystal's pale blue and the warrior's slash onto his blade greys; outline and shading stay the portrait's.
- **Budget:** 5 jobs (4 + the one regeneration). `anim-warrior-01` asked for an idle and an attack in one 12-frame loop: the first frames were usable but every frame redraws 3,000–6,000 pixels of the portrait, so an idle made from them shimmers instead of breathing, and the "attack" only turned the knight to face front. Rejected; **no generated idle ships**, the idle breath is code (DESIGN_SYSTEM "Motion"). `anim-warrior-02`, `anim-mage-01`, `anim-hunter-01`, `anim-warlock-01` (attack only, looped on the portrait) are the picks. The jobs report 11 generations in their `_job.json`.
- Enemies have no frames yet; they use the code animation only.
- Preview: `art/preview-hero-frames.png`. A web test checks that every class has an 8-frame 128 px sheet of the right PNG size.
