# Loot generation (ticket 1.5)

Pure, deterministic rules in `@worldforge/game-core`. Content lives in `packages/game-core/src/items/`, rules and drop rates in `packages/game-core/src/loot/`. The server is the only caller that grants loot; clients may use the same code to render tooltips.

## Content
- **Item bases** (`items/bases.ts`): tier 1 is one base per curated icon in `apps/web/public/assets/items/` (17); tiers 2 and 3 (ticket 2.1, 10 each) drop in later areas, each with its own icon from A.4 (`docs/WORLD.md`). Each base has a slot kind, allowed classes, a minimum item level and implicit stats (`base + perLevel × (itemLevel − 1)`, × rarity multiplier, rounded).
- **Slot kinds** equal the 12 equipment slots, except that `ring` fits `ring1` and `ring2` (`equipmentSlotsForKind`, `itemFitsSlot`). Shoulders, legs and relic have no art yet, so they have **no bases and never drop** until icons exist.
- **Class restrictions:** longswords and shields are warrior-only, skull staff is mage/warlock, hunting bow is hunter. All armor and jewelry are usable by every class (GDD §7.1).
- **Affixes** (`items/affixes.ts`): physical/magic damage, attack speed, crit chance, crit damage, health, armor, resistance, gold find, and since ticket 3.1 item find, XP gain, resource yield, boss damage and one class-flavoured skill affix per class (see "Affix depth" below). Each affix lists the slot kinds it may roll on and value **tiers** gated by item level. Values are additive in the stat's own unit (flat stats as integers; crit chance, crit damage, gold find as fractions; attack speed in attacks/s) on a fixed step grid. How these combine into character stats is not loot's concern (tickets 1.4/1.7).

## Rules (`loot/generate.ts`)
- `rollLoot({ rng, sourceLevel, lootTable?, goldFind? })` → `{ gold, items }` for one kill: gold drop chance and amount, then at most one item at the table's `itemDropChance`.
- Item level = source level ± `itemLevelVariance`, clamped to `[1, maxItemLevel]`. Only bases with `minItemLevel ≤ itemLevel` can drop.
- Rarity is rolled by weight (`DEFAULT_LOOT_CONFIG.rarities`). Each rarity sets the affix count (0/1/2/3/4/5) and implicit multiplier. Affixes are distinct, picked by weight; each affix tier is picked by weight among the tiers the item level unlocks.
- **Legendary/Mythic** (ticket 3.2, `docs/EFFECTS.md`): a Legendary also rolls one effect from the registry (slot- and class-filtered, drawn after the affixes). A Mythic roll becomes a named Mythic (fixed base and signature) in tables with `mythics: true` (Sunken Abbey, Gravewarden) and a Legendary elsewhere; an explicitly requested Mythic rarity without a named Mythic stays a stat-only Mythic. Pre-3.2 items have no effect and stay valid. A weight of `0` disables a rarity.
- **Set pieces** (ticket 3.3, `docs/EFFECTS.md`): in tables with `setShare` (Sunken Abbey, Nameless Crypt, Gravewarden; `SET_SHARE` = 1/3 since ticket B.2, was 0.5) that share of Legendary rolls at item level 14+ becomes a set piece: a random piece of `ITEM_SETS` (16 pieces, all classes), on its fixed base, Legendary rarity and affixes, `setId`, no effect. The extra draw happens only on such a Legendary roll, so every other item rolls as before. A requested set base is always its piece (rarity forced to Legendary).
- **Late-game Legendary weight** (ticket B.2): the same tables carry `legendaryWeight` = `LEGENDARY_WEIGHT` = 1.5, which multiplies the Legendary rarity weight of their rolls (45 → 67.5; `rollRarity(rng, config, legendaryWeight)`). With a third of those rolls becoming set pieces, plain Legendaries drop there as often as before 3.3 and set pieces as often as before B.2. It changes which rarity some seeds roll in those tables only; every other table rolls exactly as before (`effects/noEffects.test.ts` reproduces the pinned hashes with the pre-B.2 weights restored, and checks that only Abbey and crypt hashes moved).
- **Void** (ticket 3.5, `docs/EFFECTS.md`): in tables with `voidChance` (Sunken Abbey, Nameless Crypt, Gravewarden; `VOID_CHANCE` = 0.1, capped by `LootConfig.maxVoidChance` = 0.15) a Legendary or Mythic (set pieces included) draws once more, last, and is Void at that chance (`item.variant = 'void'`). Requested bases are never Void. Every other item, and every other part of a Void item, rolls as before. `validateItem` allows Void only on Legendary and Mythic.
- **Loot focus** (ticket 3.6, `docs/DUNGEONS.md` "Targeted loot"): a table may carry a `focus` (`LootFocus`): `slots` (+ `slotWeight`) multiply those bases' weights in the base pick (`eligibleBases`), `sets` limit a set-piece roll to those sets' pieces (`focusedSetPieces`), `effects` (+ `effectWeight`) multiply those Legendary effects' weights (`focusedEffectWeight`). Each only reweights a draw that is made anyway, so rarity, item level, the set/Mythic outcome and the Void flag of a seed are the same with or without a focus (`loot/focus.test.ts`). Only the crypt's tables have one (`CRYPT_LOOT_FOCI`); the areas and the Abbey roll exactly as before. New tables (ticket 3.6): `namelessCryptII` / `namelessCryptIII` (chambers, item levels 17–22 / 20–25, tier bias 0.8 / 1) and `gravewardenII` / `gravewardenIII` (boss, 20–22 / 23–25, bias 1.2 / 1.4); all are late-game sources (Mythics in the boss tables, set pieces and Void in all four).
- **Class:** `generateItem`/`rollLoot` take an optional `classId` (the character the loot is for; settlement, the crypt, merchant, forge and quest rewards pass it). It only enables that class's class affixes and is part of the reproduction inputs.
- **Per-item seeds:** every generated item carries its own 32-bit `seed`. `generateItem({ seed, itemLevel })` regenerates exactly the same item (base, rarity, affixes), matching the `item.seed` column in `docs/DATA_MODEL.md`. A pinned test guards against drift; changing content or roll order changes what a stored seed reproduces, so store the rolled result (not only the seed) and treat the seed as audit data.
- `validateItem(item)` checks that an item could have come from the generator (base, rarity, level, affix count, slot, content tier, class, tier unlock incl. the rarity bonus, value range/step; since 3.2 the effect: Legendary effect allowed on the base with a roll on the 0.05 grid, Mythic base ↔ named Mythic ↔ signature; since 3.3 set base ↔ `setId`, Legendary, no effect). The dropping class is not stored, so a class affix only needs some class of it to be able to use the base. Use it on anything not freshly rolled.
- Ticket 3.1 changed the pool and the tier roll, so the pinned seed now reproduces a different item. Stored items are unaffected: they keep their rolled affixes.

## Affix depth (ticket 3.1)
**New affixes.** All are fractions on a 0.01 grid, three tiers (item level 1, 10 or 12, 20):
| Affix | Stat | Slots | Gate | Tiers |
|---|---|---|---|---|
| `item-find` | itemFind | head, hands, feet, ring, neck, relic | base tier ≥ 2 | 3–6 %, 7–10 %, 11–15 % |
| `xp-gain` | xpGain | head, ring, neck, relic | — | 2–4 %, 5–7 %, 8–10 % |
| `resource-yield` | resourceYield | chest, hands, feet, ring, relic | — | 3–6 %, 7–10 %, 11–15 % |
| `boss-damage` | bossDamage | weapon, offhand, ring, neck, relic | base tier ≥ 2 | 3–6 %, 7–10 % (ilvl 12), 11–15 % |
| `rage-heavy-strike`, `mana-firebolt`, `focus-aimed-shot`, `soul-shadow-bolt` | skillDamage | weapon, offhand, hands, neck, relic | its class only, on bases that class can use | 5–10 %, 11–16 %, 17–24 % |

**Gates.** An affix rolls on a base when its slot matches, the base's content tier (`ItemBaseDefinition.tier`) is at least `minBaseTier`, and for class affixes the item is generated for that class and the class can use the base (`affixAllowedOn`, `affixPoolFor`). Without a `classId`, class affixes never roll.

**Tier scaling.** A tier is unlocked when `minItemLevel ≤ itemLevel + rarity.affixLevelBonus`, and weighted `weight × (1 + bias)^(tier − 1)` with `bias = rarity.affixTierBias + table.affixTierBias`:
| Rarity | Level bonus | Tier bias |
|---|---|---|
| Common, Uncommon | 0 | 0 |
| Rare | 0 | 0.25 |
| Epic | 2 | 0.5 |
| Legendary | 4 | 1 |
| Mythic | 6 | 1.5 |

Table bias: Abandoned Fields 0, Crowwood 0.15, Old Burial Grounds 0.3, Blackwater 0.45, Sunken Abbey and the crypt's chambers 0.6, the Gravewarden 1.

**What the modifiers do.** Equipped secondary modifiers are summed, then each is capped (`ActivityConfig.modifierCaps`) before use. Every one is applied in a path both combat simulations share, so the detailed/aggregate equivalence and split-invariance hold:
| Modifier | Cap | Applied to |
|---|---|---|
| goldFind | 100 % | gold per kill and the boss purse |
| itemFind | 50 % | the per-kill item drop chance, `min(1, chance × (1 + itemFind))` (not the boss's fixed item count) |
| xpGain | 30 % | the encounter's XP reward (farming and crypt) |
| resourceYield | 50 % | units per gathering find (folded into the single units draw); undead combat drops are not affected |
| bossDamage | 25 % | damage dealt to `boss`-rank enemies (the Gravewarden) |
| skillDamage | 25 % | the class auto-skill's damage multiplier |

Boss and skill damage caps are low on purpose: the crypt's entry-level check was a cliff (an L12 hero in item-level-11 commons lost every run, yet +12 % boss and skill damage turned some classes into near-certain wins; ticket 3.6 turned it into a curve, `docs/DUNGEONS.md`). `balance.test.ts` checks that capped boss and skill damage still leave the boss fight 90 % of the earliest enrage moment (27 s), and that XP, item and resource bonuses stay within their caps.


## Loot filter (ticket 3.7)
Rules in `packages/game-core/src/economy/lootFilter.ts`, placement in `activity/placement.ts`; per character in `characters.loot_filter` (`docs/DATA_MODEL.md`), edited at `…/loot-filter` (`docs/API_CONVENTIONS.md`), UI in the Pack's "Loot filter" tab.
- **Rules** (`LootFilterRules`): `action` (`salvage`: the forge's `salvageYield`, materials and a little gold; `sell`: the merchant's `sellPrice`), `belowRarity` (drops of a lower rarity are handled), `wantedAffixes` / `wantedEffects` (when any is listed, a drop with none of them is handled; effects are the Legendary pool) and `include`. Either rule is enough (OR). Rules that can handle nothing (none set, or "below Common") are stored as no filter.
- **Protected categories** (`LOOT_FILTER_CATEGORIES`): Legendary (non-set), Mythic, set pieces and Void are **always kept** unless the player ticked the category in `include`. An item in several categories (a Void set piece, a Void Legendary) needs all of them ticked.
- **Only new drops.** The filter runs in `createDropPlacer`, after `rollLoot`/`rollBossLoot`, on the generated item. It never changes what drops: the same seeds give the same items, the filter only decides whether each goes to the pack or is sold/salvaged on the spot. Equipped, packed and locked items are never seen by it. Quest and contract rewards (targeted ones included), merchant purchases and crafts are not drops and are never filtered.
- **Order and capacity.** Drops are placed in drop order: a handled drop takes no pack space; any other drop goes into the pack while there is room and is overflow-salvaged to gold once it is full (the old rule), except a valuable one (Legendary, Mythic, set, Void), which is kept beyond the capacity (ticket B.2, `docs/FARMING.md`). The filter runs first, so the categories a player ticked in `include` are still sold or salvaged. With no filter the placement is exactly the pre-3.7 rule; the pinned no-effects hashes (`effects/noEffects.test.ts`) run with a null, an empty and a "below Common" filter.
- **Where.** Farming settlement (`settleFarming`, `lootFilter` input) and the crypt claim, all tiers (`simulateDungeonRun`, `lootFilter` input). The result carries `filtered: FilteredDrop[]` (item, action, gold, materials) only when a filter was given. Its gold and materials are kept apart from `goldLooted`/`materials`, so gathering quests never count salvage.
- **Which rules.** Settlement reads the rules with the locked character row once per window; a rule change settles first with the old rules, so every committed cycle is filtered by the rules in force when it was committed, and settling every few seconds gives the same result as one settlement (split-invariant, tested in game-core and on the server). The crypt claim uses the rules in force at the claim.
- **Audited.** `activity.reward` and `dungeon.claim` carry `filtered: { sold, salvaged, gold, materials, items: [{ baseId, rarityId, itemLevel, seed, action, gold }] }`; rule changes write `loot_filter.update` (before, after).

## Default rates (Phase 1, tunable in `loot/config.ts`)
| Rarity | Weight | Share | Affixes | Implicit × |
|---|---|---|---|---|
| Common | 6000 | 60 % | 0 | 1.0 |
| Uncommon | 2600 | 26 % | 1 | 1.1 |
| Rare | 1000 | 10 % | 2 | 1.2 |
| Epic | 350 | 3.5 % | 3 | 1.35 |
| Legendary | 45 | 0.45 % | 4 | 1.5 |
| Mythic | 5 | 0.05 % | 5 | 1.7 |

Item drop chance per kill 12 % in the `standard` table (the tier-1 bases, used when no table is given). Settlement rolls the area's table (`loot/tables.ts`, ticket 2.1): per-area tier weights, an item-level range that clamps the rolled level, and a 6 % item chance (ticket B.1; the crypt's chambers 18 %); the Abandoned Fields table has the `standard` bases. See `docs/WORLD.md`. Gold (ticket B.1): 20 % chance, 1–3 at level 1, +10 % per level, × (1 + gold find).
