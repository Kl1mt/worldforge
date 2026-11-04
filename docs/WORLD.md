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

- Each area overlaps the next by one level step (`next.minLevel = prev.maxLevel − 1`); the area's unlock level is its minimum enemy level.
- `DungeonDefinition` is data only. Rooms, run timing, the boss mechanic and the boss loot table are ticket 2.5.

## Enemies
`EnemyDefinition` adds `undead` (undead drop `soulShard`, ticket 2.3) and `rank` (`normal` or `boss`) to the Phase 1 fields; `damageType` is the damage family (physical → armor, magic → resistance). Each enemy is in exactly one roster. Asset ids are `enemy.<kebab-case id>` (the three Phase 1 enemies keep their existing ids).

The Abandoned Fields enemies keep their Phase 1 numbers. The new enemies use the same stat shape with damage tuned so that, at an area's middle level and without gear, a hit sequence costs about as much health as the Fields enemies do at level 4 (roughly 25–55 % of max health per fight, depending on class). The Gravewarden (1,600 health at level 16) is a gear check: an unequipped level-14 character cannot kill it inside the 30 s fight timeout; with common tier-appropriate gear every class can.

## Materials and professions
`MATERIALS`: id, name, description, icon (`material.<kebab-case id>`, icons arrive with A.4), rarity, source and profession, and the areas that list it.
- `gathering`: `timber` (Woodcutting), `ashwort` (Herbalism), `rawHide` (Skinning), `ironOre` and `abbeySilver` (Mining; silver is rare).
- `undeadDrop`: `soulShard` (listed in the Old Burial Grounds, where every enemy is undead).
- `bossDrop`: `gravewardenSeal`.

Yields, gathering and profession levels are ticket 2.3.

## Unlocks
`isAreaUnlocked(areaId, character, progress)` and `isDungeonUnlocked(…)` with `character = { level }` and `progress = { gravewardenDefeated }`. `areaUnlockBlockers` / `dungeonUnlockBlockers` return the unmet conditions in a stable order (`{ kind: 'level', required }`, then `{ kind: 'gravewardenDefeated' }`) for the world map. A non-integer or < 1 level throws. The rules live in `UnlockRule` on each place (data), so new places need no code.

## Item tiers
Every item base has a `tier` (`items/bases.ts`): tier 1 are the 17 Phase 1 bases; tiers 2 and 3 add one base per slot kind with art and per weapon family (10 each: warrior sword, mage/warlock staff, hunter bow, shield, head, chest, hands, feet, neck, ring). Tier 2 drops from item level 9–10, tier 3 from 15–16, and each beats the tier below at the same item level. The new bases point at the closest tier-1 icon until A.4 delivers their own.

## Loot in settlement
`settleFarming` rolls the area's loot table (`AreaDefinition.lootTableId`) instead of the global `standard` table. Tables may set an `itemLevel` range that clamps the rolled item level (a clamp, no extra RNG draw). The `standard` table is now explicitly the tier-1 bases, so `generateItem` without a table and every stored Phase 1 seed reproduce what they did before. The Abandoned Fields table has the same entries and drop chance, so Fields settlements are bit-identical to Phase 1 (pinned in `world.test.ts`; checked against `main` over 48 class/level/seed combinations).

`FarmingResult.killsByEnemy` is now `Partial<Record<EnemyId, number>>` holding the area's roster only (each present, possibly 0).

## Balance baseline (ticket 2.1, not tuned)
One-hour `settleFarming` window, mean of 6 seeds, character at the area's middle level with 0 XP. "Kit" is one common item at the character's level of the best base per slot the area table drops (two rings).

| Area (level) | Bare: kills / deaths per h (warrior · mage · hunter · warlock) | Kit: deaths per h |
|---|---|---|
| Abandoned Fields (4) | 467/6 · 384/46 · 472/22 · 368/40 | 0 · 0 · 0 · 0 |
| Crowwood (8) | 410/30 · 310/77 · 399/54 · 296/72 | 0 · 0 · 0 · 0 |
| Old Burial Grounds (12) | 324/34 · 252/83 · 337/50 · 285/60 | 0 · 0 · 0 · 0 |
| Blackwater (16) | 252/55 · 222/83 · 244/75 · 196/80 | 0 · 0 · 0 · 0 |
| Sunken Abbey (20) | 252/59 · 198/95 · 246/78 · 204/80 | 0 · 0 · 0 · 0 |

No timeouts anywhere. Two things for B.1: unequipped characters die far more in each new area than in the Fields (Phase 1 class scaling falls behind enemy scaling), and even common gear removes deaths entirely, so armor from gear is very strong.
