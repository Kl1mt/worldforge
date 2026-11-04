# Merchant & Forge (ticket 2.6)

GDD §4.2, §8, §11.3. Rules and numbers live in `packages/game-core/src/economy/` (`DEFAULT_ECONOMY_CONFIG`, `FORGE_RECIPES`); the server (`apps/server/src/merchant/`, `apps/server/src/forge/`) only applies them under the character lock. First-pass numbers; tune in B.1.

## Prices
- **Sell price** (what the merchant pays): `round((3 + itemLevel) × rarity)`, at least 1, with rarity multipliers common 1, uncommon 2, rare 4, epic 8, legendary 16, mythic 32. A level-10 rare sells for 52 gold. This is above the Phase 1 overflow salvage (`salvageValue`), so selling by hand pays better than letting a full pack auto-salvage.
- **Buy price**: sell price × 5.
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
| Fieldsmith’s Work | 1 | 1 | 25 | 10 timber, 5 ashwort |
| Marchwarden’s Work | 2 | 9 | 120 | 8 raw hide, 8 timber, 2 soul shards |
| Knightly Work | 3 | 15 | 400 | 10 iron ore, 5 soul shards, 6 ashwort |

Upgrades (+0 to +10), affix rerolls and affix improvement are Phase 3 (GDD §8.1) and are not built.

## Server rules
- Buy, sell, salvage and craft need an `Idempotency-Key` (`docs/API_CONVENTIONS.md`), lock the character row, settle its running activity first (ticket 1.9), check against stored state, and write an audit event in the same transaction.
- Gold and material changes are `quantity ± n` updates under the lock, backed by `CHECK (>= 0)` constraints. Buying and crafting refuse a full pack (`inventory_full`) instead of salvaging the new item.
- Real-PostgreSQL races (`concurrency.pg.test.ts`): racing sells of one item, one key raced N times, racing buys of one offer, buys exceeding the purse, sell vs salvage vs discard vs settle on one item, crafts exceeding the materials. None causes a retry.
