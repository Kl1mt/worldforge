# Loot generation (ticket 1.5)

Pure, deterministic rules in `@worldforge/game-core`. Content lives in `packages/game-core/src/items/`, rules and drop rates in `packages/game-core/src/loot/`. The server is the only caller that grants loot; clients may use the same code to render tooltips.

## Content
- **Item bases** (`items/bases.ts`): tier 1 is one base per curated icon in `apps/web/public/assets/items/` (17); tiers 2 and 3 (ticket 2.1, 10 each) drop in later areas and use placeholder icons until A.4 (`docs/WORLD.md`). Each base has a slot kind, allowed classes, a minimum item level and implicit stats (`base + perLevel × (itemLevel − 1)`, × rarity multiplier, rounded).
- **Slot kinds** equal the 12 equipment slots, except that `ring` fits `ring1` and `ring2` (`equipmentSlotsForKind`, `itemFitsSlot`). Shoulders, legs and relic have no art yet, so they have **no bases and never drop** until icons exist.
- **Class restrictions:** longswords and shields are warrior-only, skull staff is mage/warlock, hunting bow is hunter. All armor and jewelry are usable by every class (GDD §7.1).
- **Affixes** (`items/affixes.ts`): physical/magic damage, attack speed, crit chance, crit damage, health, armor, resistance, gold find. Each affix lists the slot kinds it may roll on and value **tiers** gated by item level. Values are additive in the stat's own unit (flat stats as integers; crit chance, crit damage, gold find as fractions; attack speed in attacks/s) on a fixed step grid. How these combine into character stats is not loot's concern (tickets 1.4/1.7).

## Rules (`loot/generate.ts`)
- `rollLoot({ rng, sourceLevel, lootTable?, goldFind? })` → `{ gold, items }` for one kill: gold drop chance and amount, then at most one item at the table's `itemDropChance`.
- Item level = source level ± `itemLevelVariance`, clamped to `[1, maxItemLevel]`. Only bases with `minItemLevel ≤ itemLevel` can drop.
- Rarity is rolled by weight (`DEFAULT_LOOT_CONFIG.rarities`). Each rarity sets the affix count (0/1/2/3/4/5) and implicit multiplier. Affixes are distinct, picked by weight; each affix tier is picked by weight among the tiers the item level unlocks.
- **Legendary/Mythic** roll in Phase 1 as stronger stat items only (no unique effects until Phase 3). A weight of `0` disables a rarity.
- **Per-item seeds:** every generated item carries its own 32-bit `seed`. `generateItem({ seed, itemLevel })` regenerates exactly the same item (base, rarity, affixes), matching the `item.seed` column in `docs/DATA_MODEL.md`. A pinned test guards against drift; changing content or roll order changes what a stored seed reproduces, so store the rolled result (not only the seed) and treat the seed as audit data.
- `validateItem(item)` checks that an item could have come from the generator (base, rarity, level, affix count, slot, tier, value range/step). Use it on anything not freshly rolled.

## Default rates (Phase 1, tunable in `loot/config.ts`)
| Rarity | Weight | Share | Affixes | Implicit × |
|---|---|---|---|---|
| Common | 6000 | 60 % | 0 | 1.0 |
| Uncommon | 2600 | 26 % | 1 | 1.1 |
| Rare | 1000 | 10 % | 2 | 1.2 |
| Epic | 350 | 3.5 % | 3 | 1.35 |
| Legendary | 45 | 0.45 % | 4 | 1.5 |
| Mythic | 5 | 0.05 % | 5 | 1.7 |

Item drop chance per kill 12 % (`standard` table: the tier-1 bases, used when no table is given). Settlement rolls the area's table (`loot/tables.ts`, ticket 2.1): per-area tier weights and an item-level range that clamps the rolled level; the Abandoned Fields table equals `standard`. See `docs/WORLD.md`. Gold: 60 % chance, 1–4 at level 1, +15 % per level, × (1 + gold find).
