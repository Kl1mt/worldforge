# World content (game-core)

Ticket 2.1. Data and pure rules in `packages/game-core/src/world/` (areas, dungeons, enemies, materials, unlocks) and `packages/game-core/src/loot/tables.ts` (area loot tables). The ids are the Phase 2 content contract in `docs/ROADMAP.md`; art tickets name their files after them. Ticket 2.2 made them playable: the activity start checks `isAreaUnlocked` server-side, `GET /api/characters/:id/world` reports each place's unlock state and blockers (`characters.progress` holds `gravewardenDefeated`), and the web app has the hub, the world map and an area screen for every area (`docs/DESIGN_SYSTEM.md`). Area switches let the cycle in progress finish first (`docs/FARMING.md`, "Area switches").

## Areas and the dungeon
| Place | Enemy levels | Unlock | Enemies (spawn weight) | Materials | Loot table (item levels) |
|---|---|---|---|---|---|
| `abandonedFields` | 1–6 | start | `risenFarmhand` 50, `carrionWolf` 35, `boneScarecrow` 15 | `timber`, `ashwort` | tier 1 (1–7) |
| `crowwood` | 5–10 | level 5 | `banditCutthroat` 55, `corruptedCrow` 45 | `timber`, `rawHide` | tier 1 ×2, tier 2 ×1 (4–11) |
| `oldBurialGrounds` | 9–14 | level 9 | `risenSkeleton` 55, `graveCrawler` 45 | `soulShard` | tier 1 ×1, tier 2 ×2 (8–15) |
| `blackwater` | 13–18 | level 13 | `drownedThrall` 60, `bogHorror` 40 | `ashwort`, `ironOre` | tiers 1/2/3 ×1/2/1 (12–19) |
| `sunkenAbbey` | 17–22 | level 17 + Gravewarden defeated | `fallenKnight` 55, `abbeyWraith` 45 | `ironOre`, `abbeySilver` | tier 2 ×1, tier 3 ×2 (16–23) |
| Dungeon `namelessCrypt` | 12–16 | level 12 | rooms: `cryptGhoul` 55, `boneAcolyte` 45; boss `gravewarden` (level 16) | boss drop `gravewardenSeal` | tier 2 ×2, tier 3 ×1 (11–17), 18 % item chance |
| `ashenPass` (ticket 4.8) | 24–28 | level 24 + Gravewarden defeated + world flag `ashenPassCleared` | `ashWraith` 30, `cinderHound` 30, `pyreCultist` 25, `emberGolem` 15 | `ironOre`, `soulShard` (wraiths) | tier 3 (23–29), gold × 1.6 |
| Dungeon `ashenWatch` (ticket 4.8) | — (no chambers) | level 26 + Gravewarden + `ashenPassCleared` | boss `ashenWarden` (level 28) | — | boss hoard only: `ashenWarden` (27–29) |
| `ashfallVerge` (ticket 6.1, the Cinderwastes) | 28–34 | level 28 + Ashen Warden defeated | `cinderRevenant` 30, `slagHound` 30, `emberWisp` 25, `ashColossus` 15 | `ironOre`, `soulShard` (revenants) | tier 4 (29–35), gold × 2.3 |
| `cinderDepths` (ticket 6.2, the Cinderwastes) | 34–40 | level 34 + Ashen Warden defeated (the Verge's top) | `forgeRevenant` 30, `slagMastiff` 30, `ashflameWisp` 25, `slagColossus` 15 | `ironOre`, `soulShard` (revenants) | tier 4 (35–41), gold × 3 |
| Dungeon `tyrantsForge` (ticket 6.2) | — (no chambers) | level 36 + Ashen Warden defeated | boss `forgeTyrant` (level 40) | boss drop `tyrantsEmber` | boss hoard only: `forgeTyrant` (39–41) |
| `paleMarches` (ticket 8.1, the Hollow Reach) | 40–46 | level 40 + Forge Tyrant defeated | `hollowKnight` 30, `reachStalker` 30, `paleChoir` 25, `huskTitan` 15 | `ironOre`, `soulShard` (knights, choir) | tier 5 (41–47), gold × 3.9 |
| `hollowDeep` (ticket 8.2, the Hollow Reach) | 46–52 | level 46 + Forge Tyrant defeated + world flag `deepLanternsLit` | `hollowSentinel` 30, `deepStalker` 30, `dirgeChoir` 25, `huskColossus` 15 | `ironOre`, `soulShard` (sentinels, choir) | tier 5 (47–53), gold × 4.6 |
| Dungeon `hollowThrone` (ticket 8.2) | — (no chambers) | level 48 + Forge Tyrant defeated + `deepLanternsLit` | boss `hollowSovereign` (level 52) | boss drop `crownShard` | boss hoard only: `hollowSovereign` (51–53) |

- Each Graumark area overlaps the next by one level step (`next.minLevel = prev.maxLevel − 1`); the area's unlock level is its minimum enemy level. The Ashen Pass starts two levels above the Abbey's top (24 vs 22): crypt tier III (21–24) bridges the gap.
- Rooms, run timing, the boss enrage and the boss loot (`gravewarden` table, boss-exclusive bases, cooldown) are data on `DungeonDefinition` since ticket 2.5; rules in `docs/DUNGEONS.md`.

## The Cinderwastes: the Ashfall Verge (ticket 6.1)

The first area of the endgame region beyond the Ashen Pass (GDD §15 Phase 6; ROADMAP Phase 6 defaults: the Cinderwastes for levels 28–40 in two areas and a region boss; 6.2 adds the second area and the boss). Its region is `The Cinderwastes`, its area id `ashfallVerge`, "The Ashfall Verge": the ash plain past the Warden's tower. Map marker in the map's north-west corner, beyond the Watch.

**Unlock.** Level 28 and the Ashen Warden slain (`UnlockRule.ashenWardenDefeated`, blocker `{ kind: 'ashenWardenDefeated' }`, "Defeat the Ashen Warden"). The Warden can only be fought once the Pass is open, so its world flag guards the Verge too. **Seam (unused since 6.7):** the region's community project could add `worldFlag` to the Verge's rule; every server path already passes the world flags. Ticket 6.7 did not use it: the Verge is live and open, and no access is taken away (its Forgeward Outpost opens new things instead, `docs/COMMUNITY.md`); `world.test.ts` and `world-progression.test.ts` assert that the flags, the new one included, change nothing for it.

**Art (A.11).** Backdrop `area.cinderwastes`; foes `enemy.cinder-revenant`, `enemy.slag-hound`, `enemy.ember-wisp`, `enemy.ash-colossus` (the names 6.1 was built on). **Art (A.15).** The ten tier-4 item icons (`item.<base id>`, see `docs/ASSET_GUIDELINES.md` "Tier-4 item icons"). Until they existed the web showed their tier-3 counterparts with an ember tint; that stand-in (`ART_STAND_INS` in `apps/web/src/content/assets.ts`) remains only as a fallback for a name whose art is missing, and registered art always wins.

| Enemy | Asset | Type | Health | Damage | Notes |
|---|---|---|---|---|---|
| `cinderRevenant` Cinder Revenant | `cinder-revenant` | physical | 96 + 58/level | 12.2 + 3.51 | undead (soul shards), armoured (20 + 3.8), attack speed 0.9 |
| `slagHound` Slag Hound | `slag-hound` | physical | 74 + 48/level | 8.1 + 2.43 | fast (1.5), light |
| `emberWisp` Ember Wisp | `ember-wisp` | magic | 58 + 38/level | 8.6 + 2.56 | quick (1.3), frail, warded (resistance 22 + 3.6) |
| `ashColossus` Ash Colossus | `ash-colossus` | physical | 192 + 86/level | 20.2 + 5.67 | slow (0.5), huge, heavy armour (30 + 5) |

Per level they have 1.8–1.9 × the Pass's health at about 1.5 × its damage; XP per kill is about 1.4 × the Pass's. Each foe tests a different defence (armour, burst, resistance, bulk), on the existing engine.

**Rewards.** The loot table `ashfallVerge`: **tier-4 bases only** (ten, one per slot kind and weapon family, from item level 29, each about a tenth above its tier-3 counterpart at the same item level), item levels **29–35** (the first area table above the Pass's 29), affix bias 1.0, the Pass's late-game odds (Mythics, sets on their tier-3 bases, Legendary weight, Void), kill gold × 2.3. **Tier-5 affixes** (flat damage, health, armour, resistance) unlock at item level 31, Epic and better from 30, never at 29 or below (`AffixTier.minBaseItemLevel`), so no earlier source rolls differently. Gathering: iron ore (7 %; tier-4 items salvage to 3 ore a unit, so their upgrades ask for more of it) and soul shards from the revenants (3 %). No new material (none would have a sink yet; 6.2's boss material gets one).

**Older content stays relevant** (asserted in `balance.test.ts` "the Ashfall Verge" and `builds.test.ts`): the Pass's best builds (4.8's search, +10 Void and +5, item level 27) farm it at 16–20 kills a minute with no deaths and earn more XP and gold an hour than at the Pass; the Pass's Legendaries +10 farm it with no deaths; older drops keep their salvage yields and Forge paths (their materials drop in the Verge). Numbers in `docs/COMBAT.md` "The Cinderwastes".

## The Cinderwastes: the Cinder Depths and the Tyrant's Forge (ticket 6.2)

The region's second area and its boss (GDD §15 Phase 6; the ROADMAP Phase 6 default: the Cinderwastes for 28–40 in two areas plus a region boss). Area id `cinderDepths`, "The Cinder Depths": the slag pits under the Verge where the Forge Tyrant's furnace burns. Its boss is fought alone in **the Tyrant's Forge** (`tyrantsForge`, `docs/DUNGEONS.md` "The Tyrant's Forge"). Map markers on the west edge under the Pass (`MAP_MARKERS`).

**Unlock.** Level 34 and the Ashen Warden slain: the Verge's top milestone ("The Ashfall Verge, level 34" on PvE Progress), with no new progress flag. The Forge opens at 36 on the same condition. Blockers `{ kind: 'level', required: 34 }`, `{ kind: 'ashenWardenDefeated' }`. **Seam (unused since 6.7):** a community project could add `worldFlag` to the Depths' and the Forge's rules; every server path already passes the world flags. Ticket 6.7 left them open (live content; no access taken away), and `world-progression.test.ts` asserts that the flags change nothing for them.

**Art (no new art).** Backdrop `area.cinder-depths` (A.11) for the area and the Forge; boss `enemy.forge-tyrant` (A.11, 128×128, front; the code animation, like every boss). The four foes have their own asset ids (`enemy.forge-revenant`, `enemy.slag-mastiff`, `enemy.ashflame-wisp`, `enemy.slag-colossus`) that the web draws as their Verge kin's sprites (and attack frames, where the kin has them) with the Depths' **ember treatment** (`ART_VARIANTS` in `apps/web/src/content/assets.ts`, CSS `pixel--tint-ember`). The Tyrant's Ember is a soul shard drawn the same way.

| Enemy | Drawn as | Type | Health | Damage | Notes |
|---|---|---|---|---|---|
| `forgeRevenant` Forge-tempered Revenant | `cinder-revenant` | physical | 120 + 78/level | 13.6 + 3.9 | undead (soul shards), the heaviest armour of any regular foe (26 + 4.6), attack speed 0.9 |
| `slagMastiff` Slag Mastiff | `slag-hound` | physical | 90 + 61/level | 8.0 + 2.4 | the fastest bites in the game (1.7) |
| `ashflameWisp` Ashflame Wisp | `ember-wisp` | magic | 70 + 50/level | 9.6 + 2.86 | quick (1.3), warded far beyond the Verge's wisps (resistance 28 + 4.4) |
| `slagColossus` Slag Colossus | `ash-colossus` | physical | 240 + 118/level | 23.5 + 6.6 | the slowest (0.45) and the most health of any regular foe, heavy armour |
| `forgeTyrant` The Forge Tyrant (boss) | `forge-tyrant` | physical | 1,500 + 400/level (17,100 at 40) | 10 + 2.2 | slag shell and hammer (`docs/DUNGEONS.md`) |

Per level they have 1.27–1.37 × the Verge's health at 1–1.16 × its damage, and about 1.1 × its XP per kill. Each leans harder on its kin's defence (armour, speed, resistance, bulk), on the existing engine.

**Rewards.** The loot table `cinderDepths`: the Verge's table one band higher: tier-4 bases only, item levels **35–41** (more tier-5 affixes; no new affix tier), affix bias 1.0, the late-game odds, kill gold × 3 (its foes take longer to kill). Gathering: iron ore (7 %) and soul shards from the revenants (3 %); no new gathering material. The Tyrant's hoard and his ember: `docs/DUNGEONS.md`, the ember's sink: `docs/ECONOMY.md` "The Tyrant's Forge".

**Older content stays relevant** (asserted in `balance.test.ts` "the Cinder Depths" and "the Forge Tyrant"): good Verge gear (the Verge's plain Legendaries +10, item level 33) farms the Depths at 34–40 with no deaths and more XP and gold an hour than the Verge's top, while the Verge's rares fall; the Depths' own drops (item level 39) kill 1.07–1.22 × as fast at 40. The Pass's and the Verge's drops keep their salvage yields and Forge paths (their materials drop in the Depths). Numbers in `docs/COMBAT.md` "The Cinder Depths".

## Region III, the Hollow Reach: the Pale Marches (ticket 8.1)

The first area of Phase 8's new region (ROADMAP Phase 8 defaults: Region III, working name the Hollow Reach, levels 40–52 in two areas plus a region boss; ticket 8.2 adds the second area, the boss and the community gate). Its region is `The Hollow Reach`, its area id `paleMarches`, "The Pale Marches": the grey land past the Forge Tyrant's furnace, where the fire has gone out and the knights who guard it are empty plate. Map marker on the map's west edge below the Depths (`MAP_MARKERS`).

**Unlock.** Level 40 and the Forge Tyrant slain (`UnlockRule.forgeTyrantDefeated`, blocker `{ kind: 'forgeTyrantDefeated' }`, "Defeat the Forge Tyrant"; the hero's `progress.forgeTyrantDefeated`, set by a Tyrant's Forge kill since 6.2 and by D.4's progress tool). **Seam for 8.2's community gate:** a project's flag can go on the `worldFlag` of the region's *later* places (8.2's area and boss); every server path already passes the world flags. The Pale Marches are live from their release, so they never get one (no access is ever taken away): `world.test.ts` and `world/pale-marches.test.ts` assert that every flag leaves them as they are.

**Art (A.17, in parallel).** Backdrop `area.hollow-reach`; foes `enemy.hollow-knight`, `enemy.reach-stalker`, `enemy.pale-choir`, `enemy.husk-titan` (with `-attack` frame sheets); the ten tier-5 icons `item.<base id>`. Until A.17 registers them, the web draws each as its nearest existing sprite with a pale "hollow" tint (`HOLLOW_STAND_INS` in `apps/web/src/content/assets.ts`, CSS `pixel--tint-hollow`): the Verge's backdrop, the fallen knight, the wolf, the pyre cultist and the ash colossus (all with attack frames, so the A.14 scene and the admin gallery animate them), and each tier-5 icon as its tier-4 counterpart. Registered art always wins, so each stand-in switches itself off when A.17's art lands. A.17 (PR #140) drew every name, so `HOLLOW_STAND_INS` is empty now; it stays as the fallback for Hollow Reach art still missing.

| Enemy | Drawn as (until A.17) | Type | Health | Damage | Trait | Notes |
|---|---|---|---|---|---|---|
| `hollowKnight` Hollow Knight | `fallen-knight` | physical | 130 + 84/level | 13.8 + 3.95 | its blows ignore 25 % of the hero's armour (`defensePierce`) | undead (soul shards), armoured (30 + 5), attack speed 0.9 |
| `reachStalker` Reach Stalker | `wolf` | physical | 100 + 70/level | 8.6 + 2.55 | −15 points of the hero's crit chance (`critEvasion`) | fast (1.6), light |
| `paleChoir` Pale Choir | `pyre-cultist` | magic | 80 + 57/level | 9.6 + 2.85 | the class skill keeps 60 % of its extra damage (`skillGuard` 0.4) | undead (soul shards), warded (resistance 28 + 4.4), 1.2 |
| `huskTitan` Husk Titan | `ash-colossus` | physical | 250 + 124/level | 21 + 5.9 | crits deal half their bonus (`critGuard` 0.5) | slow (0.45), the most health of any regular foe, heavy armour |

**Fight traits** (`EnemyTraits` on `EnemyDefinition`, game-core `combat/encounter.ts`): optional data, fixed numbers the encounter is built with (no extra draw, no new timeline rule, the same in the detailed and the aggregate simulation). A foe without traits (every foe before 8.1) builds exactly the encounter it did (`encounter.test.ts`; the no-effects hashes and the 6.1/6.2/8.1 curve pins are unchanged). Each trait answers a different build: armour-stacking (the knight), crit chance (the stalker), skill-damage builds (the choir), crit damage (the titan).

Per level they have about 1.05–1.15 × the Depths' health at about the same damage plus their trait, and about 1.2 × its XP per kill; kill gold × 3.9 (the Depths × 3). A fight costs today's best gear about 1.2–1.3 × the Depths' share of its health.

**Rewards.** The loot table `paleMarches`: **tier-5 bases only** (ten, one per slot kind and weapon family like tiers 2–4, from item level 41, each about a tenth above its tier-4 counterpart at the same item level), item levels **41–47** (one above the Depths' top), affix bias 1.0, the late-game odds (Mythics, a third of Legendaries as set pieces, Legendary weight 1.5, Void 10 %, Prismatic 5 %), kill gold × 3.9. **Tier-6 affixes** (flat damage, health, armour, resistance) from item level 43, Epic and better from 42, never at 41 or below (`docs/LOOT.md`). Gathering: iron ore (8 %; tier-5 items salvage to 4 ore a unit, so their upgrades ask for more of it) and soul shards from the knights and the choir (3 %). **No new material:** none would have a real sink yet (8.2's region boss material gets one); Phase 6's Tyrant's Ember keeps its sink (Tyrantforged Work, tier 4).

**The merchant** stocks the Marches every day for every hero (F.7's floor: a level-40 offer is stocked at 41, the tier-5 bases' first level; `pale-marches-balance.test.ts` and the server test check every outcome, not a lucky seed).

**Older content stays relevant** (asserted in `balance/pale-marches-balance.test.ts` and `phase6-exit-criterion.test.ts`): a level-40 hero in today's best gear (the Depths' Legendaries +10, plain or awakened, the Heroic crypt's, the best Depths build at +10 Void) farms the Marches with no deaths and more XP and gold an hour than the Depths; the Phase 6 drops salvage into the ore and shards the tier-5 Forge spends, and the Marches drop both. Numbers in `docs/COMBAT.md` "The Hollow Reach".

## Region III, the Hollow Reach: the Hollow Deep and the Hollow Throne (ticket 8.2)

The Hollow Reach's second area and its region boss. Area id `hollowDeep`, "The Hollow Deep": the pit below the Pale Marches with no bottom anyone has seen, where the hollow kin are older and something at the bottom wears a crown. Backdrop `area.hollow-depths` (A.17). Map markers along the map's south edge (`hollowDeep` at 140,190, `hollowThrone` at 196,204).

**Unlock: the first community gate on new content.** Level 46, the Forge Tyrant slain **and the world flag `deepLanternsLit`** (the "Light the Lanterns of the Deep" project, `docs/COMMUNITY.md`). The Throne needs level 48, the Tyrant and the same flag. Unlike 6.7's chain this flag gates content from its release; it is allowed here because nothing live is taken away (the Deep and the Throne are new). `world/hollow-reach-gate.test.ts` (game-core) and `community/deep-lanterns.test.ts` (server) assert that every other area and dungeon tier answers exactly the same with and without the flag at every level and progress. Blockers on the map: "The town must light the lanterns of the deep first." (`WORLD_FLAGS` `lockedText`) plus the usual level and Tyrant lines.

**Foes: older kin, two traits each.** The Deep's four foes are kin of the Marches' (A.17's sprites and attack frames with the Deep's colder tint, `DEEP_VARIANTS` in `apps/web/src/content/assets.ts`, CSS `pixel--tint-deep`; no new art). Each pairs two of 8.1's `EnemyTraits` (build-time numbers, no draws), so no single build answers all four:

| Foe | Kin of | Damage | Traits |
| --- | --- | --- | --- |
| Hollow Sentinel (`hollowSentinel`) | the hollow knight | physical, undead | armour pierce 25 %, skill guard 20 % |
| Deep Stalker (`deepStalker`) | the reach stalker | physical, fast | crit evasion 12 points, armour pierce 12 % |
| Dirge Choir (`dirgeChoir`) | the pale choir | magic, undead | skill guard 30 %, crit guard 25 % |
| Husk Colossus (`huskColossus`) | the husk titan | physical, slow | crit guard 40 %, crit evasion 8 points |

About 1.1 × the Marches' foes' health and damage per level, about 1.1 × their XP per kill. **Loot:** tier-5 bases (the Marches' ten; no new base) at item levels 47–53, gold × 4.6; tier-6 affixes as before (no new affix tier). **Materials:** iron ore and soul shards (gathering at the Marches' odds; no new gathering material, since nothing new would have a sink). **The merchant** stocks the Deep's two offers every day at item levels 46–52 (tier 5 starts at 41, so every level it can roll has a base; F.7's lesson, asserted for 30 days × 4 classes).

**The Hollow Throne** (`docs/DUNGEONS.md` "The Hollow Throne"): the Hollow Sovereign (128×128, A.17, his own art untinted) at the bottom of the Deep, a boss-only run like the Tyrant's Forge, with a siphon and a crown-blow. His hoard is always bound and carries a **Shard of the Hollow Crown** (`crownShard`, epic, boss drop, never tradeable; drawn as a soul shard in the Deep's tint), whose one sink is the Crownforged Work recipe (`docs/ECONOMY.md`).

**Older content stays relevant** (`balance/hollow-deep-balance.test.ts`, `phase6-exit-criterion.test.ts` "extended again"): the best Marches gear (its Legendaries +10 at item level 47, plain or awakened) farms the Deep with no deaths at 46, 49 and 52 and more XP and gold an hour than the Marches' top; the Phase 6 and Marches drops salvage into the ore and shards the Deep's Forge spends; the Tyrant's Ember gains a second one-off use (the lanterns' last stage). Numbers in `docs/COMBAT.md` "The Hollow Deep".

## Enemies
`EnemyDefinition` adds `undead` (undead drop `soulShard`, ticket 2.3) and `rank` (`normal` or `boss`) to the Phase 1 fields; `damageType` is the damage family (physical → armor, magic → resistance). Each enemy is in exactly one roster. Asset ids are `enemy.<kebab-case id>` (the three Phase 1 enemies keep their existing ids).

Enemy damage was retuned in ticket B.1 (`docs/COMBAT.md`): each later area hits harder than the previous one at the same level, so a geared hero loses 15–19 % of its health per fight on entering an area and 10–15 % at its top. The Gravewarden (3,520 health at level 16) is a gear check against its enrage timer (`docs/DUNGEONS.md`).

## Materials and professions
`MATERIALS`: id, name, description, icon (`material.<kebab-case id>`, in `apps/web/public/assets/materials/`, A.4), rarity, source and profession, and the areas that list it.
- `gathering`: `timber` (Woodcutting), `ashwort` (Herbalism), `rawHide` (Skinning), `ironOre` and `abbeySilver` (Mining; silver is rare).
- `undeadDrop`: `soulShard` (listed in the Old Burial Grounds, where every enemy is undead; since 4.8 / 6.1 / 6.2 / 8.1 also in the Ashen Pass, the Ashfall Verge, the Cinder Depths and the Pale Marches).
- `bossDrop`: `gravewardenSeal`; `tyrantsEmber` (ticket 6.2, the Forge Tyrant; never tradeable, spent only by Tyrantforged Work).

Yields, gathering and profession levels (ticket 2.3): `packages/game-core/src/professions/`, rules in `docs/FARMING.md` ("Gathering & professions").

## Unlocks
Ticket 4.6: a rule may also need a global world flag (`UnlockRule.worldFlag`, set by a completed community project, `docs/COMMUNITY.md`); the caller passes the flags as `character.world`, and without them such a place stays closed (blocker `{ kind: 'worldFlag', flag }`, after the others). Ticket 4.8: the Ashen Pass and the Warden's Watch use `ashenPassCleared`; every server path that checks an unlock passes `await app.worldState.flags()` (world map, farming start, merchant stock and purchase, dungeon state and start).

`isAreaUnlocked(areaId, character, progress)` and `isDungeonUnlocked(…)` with `character = { level }` and `progress = { gravewardenDefeated }`. `areaUnlockBlockers` / `dungeonUnlockBlockers` return the unmet conditions in a stable order (`{ kind: 'level', required }`, then `{ kind: 'gravewardenDefeated' }`) for the world map. A non-integer or < 1 level throws. The rules live in `UnlockRule` on each place (data), so new places need no code.

## Item tiers
Every item base has a `tier` (`items/bases.ts`): tier 1 are the 17 Phase 1 bases; tiers 2, 3, 4 and 5 add one base per slot kind with art and per weapon family (10 each: warrior sword, mage/warlock staff, hunter bow, shield, head, chest, hands, feet, neck, ring). Tier 2 drops from item level 9–10, tier 3 from 15–16, tier 4 (ticket 6.1, appended after every earlier base) from 29 and only in the Cinderwastes (the Ashfall Verge, since 6.2 the Cinder Depths and the Forge Tyrant's hoard), tier 5 (ticket 8.1, appended after tier 4) from 41 and only in the Hollow Reach (the Pale Marches), and each beats the tier below at the same item level. Each new base has its own icon `item.<base id>` (A.4).

## Loot in settlement
`settleFarming` rolls the area's loot table (`AreaDefinition.lootTableId`) instead of the global `standard` table. Tables may set an `itemLevel` range that clamps the rolled item level (a clamp, no extra RNG draw). The `standard` table is now explicitly the tier-1 bases, so `generateItem` without a table and every stored Phase 1 seed reproduce what they did before. The Abandoned Fields table has the same entries and drop chance, so Fields settlements are bit-identical to Phase 1 (pinned in `world.test.ts`; checked against `main` over 48 class/level/seed combinations).

`FarmingResult.killsByEnemy` is now `Partial<Record<EnemyId, number>>` holding the area's roster only (each present, possibly 0).

## Balance baseline (ticket 2.1, before B.1)
One-hour `settleFarming` window, mean of 6 seeds, character at the area's middle level with 0 XP. "Kit" is one common item at the character's level of the best base per slot the area table drops (two rings).

| Area (level) | Bare: kills / deaths per h (warrior · mage · hunter · warlock) | Kit: deaths per h |
|---|---|---|
| Abandoned Fields (4) | 467/6 · 384/46 · 472/22 · 368/40 | 0 · 0 · 0 · 0 |
| Crowwood (8) | 410/30 · 310/77 · 399/54 · 296/72 | 0 · 0 · 0 · 0 |
| Old Burial Grounds (12) | 324/34 · 252/83 · 337/50 · 285/60 | 0 · 0 · 0 · 0 |
| Blackwater (16) | 252/55 · 222/83 · 244/75 · 196/80 | 0 · 0 · 0 · 0 |
| Sunken Abbey (20) | 252/59 · 198/95 · 246/78 · 204/80 | 0 · 0 · 0 · 0 |

No timeouts anywhere. Two things for B.1: unequipped characters die far more in each new area than in the Fields (Phase 1 class scaling falls behind enemy scaling), and even common gear removes deaths entirely, so armor from gear is very strong.

## The Ashen Pass (ticket 4.8)

The top-end region, GDD §4.3 / §12.2. Closed for everyone until the community finishes *Clear the Ashen Pass* (world flag `ashenPassCleared`, `docs/COMMUNITY.md`); then open to every hero of level 24 who has slain the Gravewarden. Its boss, the Ashen Warden, is fought in its own boss-only run, the Warden's Watch (`docs/DUNGEONS.md` "The Warden's Watch"). Art from A.7 (`area.ashen-pass`, `enemy.ash-wraith`, `enemy.cinder-hound`, `enemy.pyre-cultist`, `enemy.ember-golem`, `enemy.ashen-warden`); map markers in the north-west mountains (`MAP_MARKERS`).

**What it is for.** Content ended at 24 while heroes reached 22–28, and past ~22 every late-game build one-shot the Abbey (B.2's farming breakpoint), so nothing at the top rewarded a better build. The Pass is tuned against **Phase 3 gear** (rares at +5 upward, what a hero has who cleared crypt tier II and spends Abbey gold on upgrades), not against commons: a common kit falls 35–50 times an hour there. Its foes have 1.7–2.4 × the health per level of the Abbey's at similar damage, so the late-game builds need several blows again and the build shows in the kill rate (`docs/COMBAT.md` "The top end").

| Enemy | Type | Health | Damage | Notes |
|---|---|---|---|---|
| `ashWraith` Ash Wraith | magic | 50 + 32/level | 7.9 + 2.28 | undead (drops soul shards), attack speed 1.0 |
| `cinderHound` Cinder Hound | physical | 40 + 27/level | 5.6 + 1.66 | fast (1.4) |
| `pyreCultist` Pyre Cultist | magic | 56 + 34/level | 9.2 + 2.61 | high resistance |
| `emberGolem` Ember Golem | physical | 96 + 45/level | 11.8 + 3.28 | slow (0.6), heavy armour |
| `ashenWarden` The Ashen Warden (boss) | magic | 1,900 + 460/level (14,320 at 28) | 8 + 1.6 | undead; `docs/DUNGEONS.md` |

XP per kill is about 1.4 × the Abbey's per level (so an hour pays more XP despite the slower kills).

**Rewards.** The loot table `ashenPass` drops tier-3 bases only, at item levels **23–29** (above every other area; tier-4 affixes unlock at 25), with an affix bias of 0.8 (the Abbey's 0.6, crypt tier II's chambers) and the Abbey's late-game odds (Mythics, sets, Legendary weight, Void). Kill gold × 1.6 (`LootTableDefinition.goldMultiplier`, applied after the roll, so no extra draw and no other table changes). Gathering: iron ore (6 %, the tier-3 upgrade material) and, from the wraiths, soul shards (3 %, the +8 → +10 binding material). No new material: the Warden drops none either (a material without a recipe would only be salvage; B.3 or a later recipe ticket can add one).

**Asserted** (`balance.test.ts` "the Ashen Pass"; rares +5 at item level = level − 1, 3 seeds × 1 h):

| | Measured (warrior / mage / hunter / warlock) | Band |
|---|---|---|
| Deaths per hour at 24 / 26 / 28 | 0 / 0.3 / 0 / 0 · 0 · 0 / 0 / 0 / 0.3 | ≤ 2 |
| Damage share per fight at 24 | 14 / 19 / 15 / 16 % | < 21 %, > 1.15 × the Abbey's top with the same kit (8–9 %), casters within × 1.45 |
| Kills per minute at 26 | 7.4 / 8.6 / 9.0 / 6.9 | 6.5–12; Legendary +10 kit ≥ 1.25 × (11–15) |
| XP per hour at 24 | 77k / 71k / 86k / 81k (Abbey 22, same kit: 63–72k) | above the Abbey's top |
| Gold per hour at 24 | 997 / 909 / 1,258 / 1,238 (Abbey 22: 786–1,018) | mean > 1.05 × the Abbey's top, < 2,500 at 26 |
| Levels 24 → 28 | 23 / 23.5 / 20 / 23 h | 15–35 h; a 3 h window from 24 stays ≤ 26 |
| Iron ore · soul shards per hour | 27–33 · 3–5 | ≤ 60 · ≤ 45 |
| Commons at 24 | 36–52 deaths per hour | > 20 (top-end content) |
| Merchant (its stock at 26) | common 12 min, uncommon 25 min of its gold | common 3–20, uncommon ≤ 35 min |

The existing Graumark bands (B.1: commons, `GRAUMARK` in the test) are unchanged and no longer include the Pass.

## Eras of Graumark (ticket 6.7)

A visible, long-term progression of the town, read from the world flags the community projects set (game-core `world/eras.ts`). **Cosmetic and world-flavour only:** an era is words and a tint key; nothing in combat, loot, prices, unlocks or progress reads it (`world-progression.test.ts`: every field of every era is text). A power or price change belongs to a project's own flag rule (e.g. the Forgeward bellows, `docs/ECONOMY.md`).

| # | Era (`id`) | Begins with | Town | Crier (one call a day, in turn) |
| --- | --- | --- | --- | --- |
| 1 | The Long Dusk (`longDusk`) | — (a fresh world) | cold blue dusk, bare banner poles | the storehouse needs hands; bar the doors |
| 2 | The Ashen Siege (`ashenSiege`) | `warehouseRestored` | grey ash light, grey watch pennants | the Warehouse is open; scouts wanted for the pass |
| 3 | **The Rekindling** (`rekindling`) — **live today** | `ashenPassCleared` | warm ember dusk, ember-red pennants | the pass is open; the Cinderwastes burn; the forgeward fort wants gold and ore |
| 4 | The Forgeward Age (`forgewardAge`) | `forgewardRaised` | the beacon's brass glow, brass-and-ember banners | the beacon is lit, the Forge works the Tyrant's fire for less; the outpost keeps watch; the Hollow Deep wants lantern-iron (ticket 8.2) |
| 5 | The Lantern Vigil (`lanternVigil`, ticket 8.2) | `deepLanternsLit` | cold lantern-light over the street, pale lantern-cloth banners | the lanterns of the deep are lit; a throne waits at the bottom; the lantern smithy works crown-iron for less |

- **Derivation:** `worldEra(flags)` is the **latest** era whose flag is set, so the era only moves forward as projects complete; an older flag cleared by hand doesn't move it back. It is never stored: **live starts in the Rekindling** (the Warehouse and the Ashen Pass are done), so nothing jumps backward on deploy. New eras are appended with a new project's flag; ids are never renamed.
- **Where it shows** (web `community/Era.tsx`, `era.css`, all classes `hub-era*`): a small "Era of …" title in the town header; a tint and light over the town backdrop and a row of banners along its top edge (CSS gradients and shapes over the existing picture, no new art); the crier's call of the day and the banners' words under the event banner; the Tavern's ambient line under its title. Until the first world poll answers (or after a failed one) the town shows no era and the Tavern its old line.
- **Server:** `GET /api/world` returns `era { id, index, name, title, crier }` (the crier's call of the game-clock UTC day). Every flag change (a completing project, an admin toggle) compares the era before and after under a world lock and writes `world.era_change` (from, to, cause) plus telemetry `world.era` when it moved (`docs/TELEMETRY.md`). The admin world folio shows the era; it changes there only through the audited flag toggles (`docs/COMMUNITY.md` "Owner CLI").
