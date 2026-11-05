# Merchant, Forge & the gold and material economy (tickets 2.6, B.1)

GDD §4.2, §8, §11.3. Rules and numbers live in `packages/game-core/src/economy/` (`DEFAULT_ECONOMY_CONFIG`, `FORGE_RECIPES`); the server (`apps/server/src/merchant/`, `apps/server/src/forge/`) only applies them under the character lock. Numbers tuned in ticket B.1 (section below).

## Prices
- **Sell price** (what the merchant pays): `round((1 + 0.4 × itemLevel) × rarity)`, at least 1, with rarity multipliers common 1, uncommon 2, rare 4, epic 8, legendary 16, mythic 32. A level-10 rare sells for 20 gold. This is above the overflow salvage (`salvageValue`, `docs/FARMING.md`), so selling by hand pays better than letting a full pack auto-salvage.
- **Buy price**: sell price × 20 (ticket B.1; the merchant pays little for drops and asks a real price for a chosen item).
- **Forge salvage gold**: a quarter of the sell price (at least 1).
- Invariant (tested): buying always costs more than selling or salvaging returns, so no buy → sell/salvage loop makes gold. Buying common gear to salvage it turns gold into materials; that is an accepted gold sink.

## Merchant stock
- Per character and UTC day: `offersPerArea` (2) offers for each unlocked area. Each offer is a common (weight 3) or uncommon (1) item from the area's loot table, usable by the character's class, at an item level within the area's enemy levels.
- Seeded by `merchant:<characterId>:<day>:<areaId>` (`areaStock`), so the stock the client sees is exactly what the buy endpoint recomputes, and an area unlocked mid-day only adds offers. The seed is not secret: a player could predict their own stock for future days. That reveals nothing exploitable (prices are fixed and items are basic), so no server secret is used.
- Offer ids are `<day>.<areaId>.<index>`. Each sells once per day (`merchant_purchases` primary key). A purchase on another day is `409 offer_expired`; stock restocks at UTC midnight.

## Salvage
Breaking an item down gives materials by its base's tier, multiplied by rarity units (common 1, uncommon 1, rare 2, epic 3, legendary 4, mythic 5):

| Tier | Materials per unit |
|---|---|
| 1 | 1 timber |
| 2 | 1 raw hide, 1 timber |
| 3 | 2 iron ore |

Rare and better items also give soul shards (rare 1, epic 2, legendary 3, mythic 4). Items whose base left the content salvage as tier 1.

## Crafting (Phase 2 scope)
A recipe makes gear of its tier in a slot the player picks; the base (among the class's bases for that slot and tier), the rarity (uncommon 70, rare 25, epic 5; never common) and the affixes are rolled from a server-chosen random seed stored on the item. Item level = character level, raised to the lowest base minimum for that slot. Idempotency replays return the same item.

| Recipe | Tier | Level | Gold | Materials |
|---|---|---|---|---|
| Fieldsmith’s Work | 1 | 1 | 30 | 30 timber, 15 ashwort |
| Marchwarden’s Work | 2 | 9 | 150 | 25 raw hide, 25 timber, 4 soul shards |
| Knightly Work | 3 | 15 | 400 | 30 iron ore, 8 soul shards, 20 ashwort |

Upgrades (+0 to +10), affix rerolls and affix improvement are Phase 3 (GDD §8.1) and are not built.

## Server rules
- Buy, sell, salvage and craft need an `Idempotency-Key` (`docs/API_CONVENTIONS.md`), lock the character row, settle its running activity first (ticket 1.9), check against stored state, and write an audit event in the same transaction.
- Gold and material changes are `quantity ± n` updates under the lock, backed by `CHECK (>= 0)` constraints. Buying and crafting refuse a full pack (`inventory_full`) instead of salvaging the new item.
- Real-PostgreSQL races (`concurrency.pg.test.ts`): racing sells of one item, one key raced N times, racing buys of one offer, buys exceeding the purse, sell vs salvage vs discard vs settle on one item, crafts exceeding the materials. None causes a retry.

## Balance (ticket B.1)
Before B.1 a farming window paid thousands of gold, hundreds of materials and a dozen profession levels, so prices and recipes meant nothing. The levers, all data in `packages/game-core`: kill gold (`DEFAULT_LOOT_CONFIG.gold`), the area tables' item drop chance (`loot/tables.ts`), sell/buy/salvage prices (`DEFAULT_ECONOMY_CONFIG`, `DEFAULT_ACTIVITY_CONFIG.inventory.salvage`), gathering chances and the profession curve (`DEFAULT_PROFESSION_CONFIG`), recipe costs (`FORGE_RECIPES`) and the boss purse. `src/balance/balance.test.ts` holds the targets.

**Targets.** A merchant item costs 10–30 minutes of farming gold at its level (common 5–20, uncommon 10–35 min in the test); farming gold stays in the hundreds per hour; a Forge recipe takes 0.4–2 h of farming in the areas that yield its materials; profession levelling takes days of play (level 10 after 6–20 h in a matching area, 25 after 25–80 h, 50 after 80–240 h; ≤ level 6 after the first 3 h window); no material arrives faster than 60 units an hour (45 for uncommon ones).

**Changes.**
- Kill gold: 20 % chance (was 60 %), 1–3 (was 1–4), +10 % per level (was +15 %): about 0.4 gold per kill at level 1 and 1.2 at level 20, × gold find. Boss purse 120–180 (was 60–90).
- Area kills drop an item 6 % of the time (was 12 %; the Phase 1 `standard` table and the crypt keep theirs): ~35 items an hour still fill every slot quickly, without a pack that overflows in under an hour. This halves sell and salvage income as well.
- Sell `round((1 + 0.4 × itemLevel) × rarity)` (was `(3 + itemLevel)`), buy × 20 (was × 5): a common level-10 offer costs 100 (was 65). Overflow salvage `round((0.5 + 0.15 × itemLevel) × rarity)` (was `(2 + 0.5 × itemLevel)`), still below the sell price. Forge salvage gold stays a quarter of the sell price.
- Gathering chances per cycle 5–6 % for commons and iron ore (were 25–35 %), abbey silver 0.8 % (was 4 %), soul shards 3 % per undead kill in the Old Burial Grounds (was 25 %); about 30–35 units of each material an hour at profession level 1. Profession XP: `round(230 × level^0.7)` (was `round(20 × level^1.5)`, which made the first levels nearly free) and 15 XP per common unit (uncommon 20, rare 50), so every level costs a similar 0.5–2.5 h.
- Recipes cost about three times the materials (table above) and a little more gold; salvaging drops (1 tier material per unit) still shortens the wait.

**Before → after** (geared hero at each area's middle level, 1 h, mean of the classes; a 3 h window from the area's entry level includes overflow salvage with an empty pack):

| Area (level) | Kill gold/h | Common offer (min of gold) | Materials/h | 3 h window: gold | 3 h window: materials | 3 h window: profession levels |
|---|---|---|---|---|---|---|
| Abandoned Fields (3) | 1,561 → 310 | 30 (1.2) → 40 (7.7) | 336 → 60 | 6,329 → 912 | 1,228 → 188 | +14 → +3 |
| Crowwood (7) | 2,144 → 447 | 50 (1.4) → 80 (10.7) | 440 → 68 | 8,252 → 1,266 | 1,461 → 212 | +15 → +3 |
| Old Burial Grounds (11) | 2,659 → 532 | 70 (1.6) → 100 (11.3) | 149 → 18 | 9,747 → 1,444 | 434 → 51 | — |
| Blackwater (15) | 2,759 → 557 | 90 (2.0) → 140 (15) | 339 → 57 | 10,709 → 1,600 | 1,170 → 190 | +14 → +4 |
| Sunken Abbey (19) | 3,491 → 719 | 110 (1.9) → 180 (15) | 219 → 41 | 13,388 → 2,130 | 758 → 126 | +19 → +5 |

An uncommon offer costs twice the common one (15–30 min). Recipes now take ~0.8 h (Fieldsmith), ~0.75 h (Marchwarden) and ~0.9 h (Knightly) of gathering, and 6–50 min of gold. Professions (geared warrior farming one area in 3 h windows): level 10 after 9–15 h, 25 after 42–63 h, 50 after 108–140 h (was: +6 levels and ~700 units in one window).

**Open.** Story-quest and contract gold (`docs/QUESTS.md`) were not changed: 40–900 gold for the story, `(20 + 6 × level) × scale` per contract, now worth 10–120 min of farming each. Gold sinks beyond the merchant and the Forge (upgrades, rerolls) are Phase 3.
