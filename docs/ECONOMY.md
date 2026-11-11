# Merchant, Forge & the gold and material economy (tickets 2.6, B.1, 3.4)

GDD §4.2, §8, §11.3. Rules and numbers live in `packages/game-core/src/economy/` (`DEFAULT_ECONOMY_CONFIG`, `FORGE_RECIPES`); the server (`apps/server/src/merchant/`, `apps/server/src/forge/`) only applies them under the character lock. Numbers tuned in ticket B.1 (section below).

## Prices
- **Sell price** (what the merchant pays): `round((1 + 0.4 × itemLevel) × rarity)`, at least 1, with rarity multipliers common 1, uncommon 2, rare 4, epic 8, legendary 16, mythic 32. A level-10 rare sells for 20 gold. This is above the overflow salvage (`salvageValue`, `docs/FARMING.md`), so selling by hand pays better than letting a full pack auto-salvage.
- **Buy price**: sell price × 20 (ticket B.1; the merchant pays little for drops and asks a real price for a chosen item).
- **Forge salvage gold**: a quarter of the sell price (at least 1).
- Invariant (tested): buying always costs more than selling or salvaging returns, so no buy → sell/salvage loop makes gold. Buying common gear to salvage it turns gold into materials; that is an accepted gold sink.

## Merchant stock
- Per character and UTC day: `offersPerArea` (2) offers for each unlocked area. Each offer is a common (weight 3) or uncommon (1) item from the area's loot table, usable by the character's class, at an item level within the area's enemy levels. When the rolled level is below every usable base of the area's table (only the Ashfall Verge: level 28, tier-4 bases from 29), the offer is stocked at the lowest level a usable base allows, with its base drawn from a stream of its own (`merchant-floor:<characterId>:<day>:<areaId>:<index>`), so no offer is dropped and every other offer keeps its item (ticket F.7; before it, about 1 Verge stock in 4 came up one short and 1 in 50 empty).
- Seeded by `merchant:<characterId>:<day>:<areaId>` (`areaStock`), so the stock the client sees is exactly what the buy endpoint recomputes, and an area unlocked mid-day only adds offers. The seed is not secret: a player could predict their own stock for future days. That reveals nothing exploitable (prices are fixed and items are basic), so no server secret is used.
- Offer ids are `<day>.<areaId>.<index>`. Each sells once per day (`merchant_purchases` primary key). A purchase on another day is `409 offer_expired`; stock restocks at UTC midnight.

## Salvage
Breaking an item down gives materials by its base's tier, multiplied by rarity units (common 1, uncommon 1, rare 2, epic 3, legendary 4, mythic 5):

| Tier | Materials per unit |
|---|---|
| 1 | 1 timber |
| 2 | 1 raw hide, 1 timber |
| 3 | 2 iron ore |
| 4 (ticket 6.1) | 3 iron ore |

Rare and better items also give soul shards (rare 1, epic 2, legendary 3, mythic 4). Items whose base left the content salvage as tier 1.

## Crafting (Phase 2 scope)
A recipe makes gear of its tier in a slot the player picks; the base (among the class's bases for that slot and tier), the rarity (uncommon 70, rare 25, epic 5; never common) and the affixes are rolled from a server-chosen random seed stored on the item. Item level = character level, raised to the lowest base minimum for that slot. Idempotency replays return the same item.

| Recipe | Tier | Level | Gold | Materials |
|---|---|---|---|---|
| Fieldsmith’s Work | 1 | 1 | 30 | 30 timber, 15 ashwort |
| Marchwarden’s Work | 2 | 9 | 150 | 25 raw hide, 25 timber, 4 soul shards |
| Knightly Work | 3 | 15 | 400 | 30 iron ore, 8 soul shards, 20 ashwort |

Upgrades (+0 to +10), affix rerolls and affix improvement: see **Forge work (ticket 3.4)** below.

## Server rules
- Buy, sell, salvage and craft need an `Idempotency-Key` (`docs/API_CONVENTIONS.md`), lock the character row, settle its running activity first (ticket 1.9), check against stored state, and write an audit event in the same transaction.
- Gold and material changes are `quantity ± n` updates under the lock, backed by `CHECK (>= 0)` constraints. Buying and crafting refuse a full pack (`inventory_full`) instead of salvaging the new item.
- **Item lock (ticket 3.7):** a locked item can't be sold, salvaged or discarded (`409 item_locked`, the whole batch refused). The Pack sells and salvages several items at once through the same endpoints (multi-select, locked items left out).
- **Loot filter (ticket 3.7):** auto-sell pays exactly `sellPrice`, auto-salvage exactly `salvageYield` (`docs/LOOT.md`), so the filter is a convenience, not a better rate; both are above the overflow salvage.
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

**Open.** Story-quest and contract gold (`docs/QUESTS.md`) were not changed: 40–900 gold for the story, `(20 + 6 × level) × scale` per contract, now worth 10–120 min of farming each. Ticket 3.4's Forge work (below) is the main gold sink.

## Forge work: upgrades, rerolls, affix improvement (ticket 3.4)
GDD §8.1, §8.3. Rules and numbers in `packages/game-core/src/economy/forgeActions.ts` (`DEFAULT_FORGE_ACTION_CONFIG`) and `items/model.ts` (`UPGRADE_IMPLICIT_BONUS`); the server (`apps/server/src/forge/work.ts`) applies them. Works on worn and packed items alike.

**Costs.** Every action costs gold plus the item's own **tier materials** (the salvage table's units: tier 1 timber, tier 2 raw hide + timber, tier 3 two iron ore per unit, tier 4 three since ticket 6.1) and soul shards. Everything scales with the item level by `(itemLevel + 5) / 25` (× 1 at item level 20, × 0.4 at 5), so cheap gear is cheap to work. Upgrades and sell/salvage prices are independent: an upgraded item sells and salvages for the same as at +0 (the investment is a sink, not a deposit).

**Upgrades +0 → +10.** Raise the item's implicit (base) stats only: cumulative +4, 8, 12, 16, 21, 26, 31, 37, 43, **50 %** at +10. Affixes and effects are untouched. A failure costs that attempt's gold and materials, **never** destroys or downgrades the item, and adds one to the pity; when the pity reaches the step's threshold the next attempt cannot fail; a success resets it.

| Step | Chance | Pity (fails) | Gold at il 20 | Tier units | Soul shards | Mean attempts | Worst |
|---|---|---|---|---|---|---|---|
| +0→+1 | 100 % | – | 50 | 2 | 0 | 1 | 1 |
| +1→+2 | 90 % | 2 | 80 | 3 | 0 | 1.11 | 3 |
| +2→+3 | 80 % | 2 | 120 | 4 | 0 | 1.24 | 3 |
| +3→+4 | 70 % | 3 | 180 | 5 | 0 | 1.42 | 4 |
| +4→+5 | 60 % | 3 | 260 | 6 | 1 | 1.62 | 4 |
| +5→+6 | 50 % | 4 | 760 (was 380) | 8 | 1 | 1.94 | 5 |
| +6→+7 | 40 % | 4 | 1,080 (was 540) | 10 | 2 | 2.31 | 5 |
| +7→+8 | 33 % | 5 | 1,520 (was 760) | 12 | 2 | 2.76 | 6 |
| +8→+9 | 25 % | 6 | 2,100 (was 1,050) | 15 | 3 | 3.47 | 7 |
| +9→+10 | 20 % | 7 | 2,800 (was 1,400) | 18 | 4 | 4.16 | 8 |

**Void items (ticket 3.5).** Forge work never adds or removes a variant: upgrades, rerolls and improvements keep a Void item Void and a plain item plain, at the same prices (Void is not a cost factor). Void's +10 % base values add to the upgrade bonus (+10 Void = +60 %). Sell and salvage prices ignore the variant.

**Prismatic items (ticket 6.4).** The same rules: Forge work never adds, removes or swaps a variant, at the same prices (not a cost factor). Prismatic's bonus is on the item's combat affixes (× 1.1 when read), so a reroll's new affix and an improvement's higher stored value count × 1.1 too; the tier caps and the improvement cap read the stored values, unchanged. Upgrades raise base values as on any item. Sell and salvage prices ignore it; find affixes are never raised, so gold and drop income are unchanged.

**Affix reroll.** The player picks one affix; it is replaced by an affix from the base's pool for the owner's class (slot, content tier and class gates as in generation), never one the item keeps and never the same affix again (unless nothing else is left). Its tier and value are rolled as generation does for the item's level and rarity (rarity tier bias, no loot-table bias); the new affix is marked `rerolled` and starts without improvements. Price at il 20: 200 gold × (1 + 0.5 × earlier rerolls of this item), 3 tier units, 2 soul shards + 1 per earlier reroll (at most 12).

**Affix improvement.** Raises one affix by a rolled 15–35 % of its tier's range (on the step grid, at least one step), never above the tier's maximum; at most **3** improvements per affix. Price at il 20: 150 gold × (1 + improvements so far), 4 × (1 + so far) tier units, 1 + so far soul shards. Refused at the cap (`improvement_cap`) or at the maximum (`affix_at_max`).

**No save-scumming.** Every random outcome (upgrade success, reroll result, improvement roll) is drawn from the item's server-only stream ``createRng(`${forge_secret}:${forge_counter}`)``; the transaction that pays and applies the result advances `forge_counter` by one. An outcome is therefore fixed by the item's state before the action: replaying the request returns the stored response (`Idempotency-Key`), a retry with a new key is a new paid attempt on the next draw, racing requests are serialised by the character → item locks and each sees the advanced counter, and the client never sees `forge_secret`. Tested in `forge/work.test.ts` (server predictions from the stream, replay, same secret + counter on two items give the same outcome, refusals move nothing) and `concurrency.pg.test.ts` (below).

### Gold and material sink (measured; asserted in `balance.test.ts`)
*Ticket 3.4's numbers, in hours of kill gold. Ticket B.2 doubled the gold of +5 → +10 and restated the targets in realistic income: "Balance pass: loot depth & economy" below.*

Expected cost of one kit item at the area's middle level (exact means with the pity), against the classes' mean farming gold per hour there, and the best gathering rate of each material:

| Area (level) | Gold/h | First attempt | +0→+5 | +5→+10 | Kit (9 items) to +5 | Kit to +10 | Materials +0→+5 / +5→+10 |
|---|---|---|---|---|---|---|---|
| Abandoned Fields (3) | 279 | 14 g (3 min) | 270 g (1.0 h) | 3.8k (13.6 h) | 2.4k (9 h) | 37k (131 h) | 0.7 h / 5.5 h |
| Crowwood (7) | 422 | 22 g (3 min) | 424 g (1.0 h) | 6.0k (14.1 h) | 3.8k (9 h) | 57k (136 h) | 0.7 h / 5.5 h |
| Old Burial Grounds (11) | 490 | 30 g (4 min) | 579 g (1.2 h) | 8.1k (16.6 h) | 5.2k (11 h) | 78k (160 h) | 1.1 h / 7.9 h |
| Blackwater (15) | 505 | 38 g (5 min) | 734 g (1.5 h) | 10.3k (20.4 h) | 6.6k (13 h) | 99k (197 h) | 1.1 h / 7.9 h |
| Sunken Abbey (19) | 651 | 46 g (4 min) | 888 g (1.4 h) | 12.5k (19.1 h) | 8.0k (12 h) | 120k (185 h) | 1.6 h / 11.6 h |

Plus about 41 soul shards per item for the whole track. **Reading:** the first steps are cheap and nearly certain, so every player upgrades; +5 on a whole kit is a 9–13 h goal; the last five steps of one item are a 14–20 h project, and a whole +10 kit 130–200 h of farming gold. The Phase 2 purse (25–30k by level 17) buys a full kit to +5 plus one or two items to +10, not everything: the sink is meaningful and keeps absorbing gold for the rest of the game. **Not punishing:** a failure costs only that attempt; with the pity, the worst case of a whole +0→+10 track is ≈ 2.1 × its mean (a single cheap step at most 3 attempts). Rerolls (≈ 15–20 min of gold each, rising 50 % per reroll) and improvements (≈ 10–40 min) are smaller, repeatable sinks.

### Power (asserted in `balance.test.ts`)
Upgrades are a moderate edge, mostly safety (base armour and health). A **+10 common kit** at every area's middle and top level: kills × 1.04–1.16 of the same kit at +0, damage share down by about a third, deaths ≤ 2/h; monotone from +0 to +5 to +10; asserted below × 1.25. A +10 rare kit in the Abbey (19, 22) stays in the same bands. A geared +10 hero at 15 always beats the Gravewarden, who still takes > 70 % of the pre-enrage window; +0 is unchanged everywhere (`noEffects.test.ts` reruns the pinned hashes with +0 items carrying forge counters and affix marks).

**Crypt entry (the 3.1 cliff as it was before ticket 3.6).** Win rate of a level-12 hero in item-level-11 commons at each upgrade level (16 seeds):

| Kit | Warrior | Mage | Hunter | Warlock |
|---|---|---|---|---|
| +0 | 0 % | 0 % | 0 % | 0 % |
| +3 | 0 % | 0 % | 6 % | 0 % |
| +5 | 6 % | 0 % | 63 % | 0 % |
| +7 | 100 % | 88 % | 100 % | 63 % |
| +10 | 100 % | 100 % | 100 % | 100 % |

Upgrades move the cliff like the boss effects do: a +7 kit of commons (≈ 9 × 2–4k gold at item level 11) turns the level-12 entry into a near-certain win; +3 does not move it. Ticket 3.6 resolved the cliff (`docs/DUNGEONS.md`, "Tiers and balance"): with the enrage drawn per run from 30–70 s, level-12 commons win 11–42 % at +0, 28–56 % at +3, 41–58 % at +5 and 55–66 % at +7, so every upgrade step helps and none makes the entry certain. Asserted now: each step raises the mean win rate, +3 stays below 75 % per class, +7 below 90 % on average, and a +10 kit at 15 always wins with the boss taking over 31.5 s.

### Server rules
- `GET /characters/:id/forge/items/:itemId` quotes the next upgrade (chance, pity, cost, blockers), the reroll price and options per affix (affixes and tier ranges) and each affix's improvement state. `POST …/forge/upgrade` `{ itemId }`, `…/forge/reroll` and `…/forge/improve` `{ itemId, affixIndex }` need an `Idempotency-Key`, lock the character (settling its activity first), then the item, check refusals and the purse **before** paying or drawing, and write `forge.upgrade` / `forge.reroll` / `forge.improve` audit events (item, `forgeCounter` drawn, gold, materials, outcome; never the secret).
- Real-PostgreSQL races (`concurrency.pg.test.ts`): N upgrades of one item with different keys (each counter drawn once; the item equals a sequential replay of the audit log), one key raced (one attempt, the rest replay), upgrades, rerolls and improvements mixed on one item, forge actions racing a sell and a salvage of the same item (one order wins; gold reconciles with the audit log), and forge actions on an equipped item racing settles (time credited once).
- The crypt run snapshot stores each worn item's `upgradeLevel` (older snapshots replay at +0).

## Community projects (ticket 4.6)
A shared sink: the two projects take 114,000 gold and ~2,150 materials in all (B.3 trimmed the Warehouse's materials), at most 20 % of each stage's need per player on its first day, growing 20 points a day to 60 % (B.3) (`docs/COMMUNITY.md` "Numbers"). Telemetry: `gold.out community_project`, `material.out community_project`.

## The Warehouse (ticket 4.7)
A gold sink with a use: six upgrades from 30 to 120 shelves cost 1,000 · 3,000 · 7,500 · 15,000 · 30,000 · 50,000 gold (106,500 in all, `docs/WAREHOUSE.md`). Stored items are never sold or salvaged until moved back; they keep their sell and salvage prices. Telemetry: `gold.out warehouse_upgrade`.

## Held value after a trade (ticket T.5)
Gold and materials received in a trade sit in the hero's purse and stacks, but for 72 hours they are **held**: no spend path may dip into them (`docs/TRADING.md` "Cooldowns", "T.5 as built"). Every spend goes through two helpers, `changeGold` and `changeMaterialsTx`, which refuse with `422 insufficient_gold` / `insufficient_materials` (`details.onHold`) when a spend would leave less than the held amount (`heldValueOf`, the transaction's clock). The paths covered: merchant purchases, Forge crafting, upgrades, rerolls and improvements, guild founding, community project contributions (gold and materials), warehouse upgrades, shelf deposits and trade offers themselves; `trading/holds.test.ts` tries each one with a purse that is all held, and a static guard fails if any other file writes a hero's gold or material stacks. Held items (`hold_until`) can be worn, never sold, salvaged, discarded, forged, stored in the Warehouse, shelved or traded. Trading creates and destroys nothing: what one hero gives the other receives (telemetry `gold.in/out trade`, `material.in/out trade`, reconciled in = out); B.2's sink numbers are unchanged.

## Balance pass: loot depth & economy (ticket B.2)
The owner's playtest feedback had not arrived (`docs/PLAYTEST_FEEDBACK.md` is still the template), so B.2 balances on simulations and telemetry. Build diversity, effects and sets: `docs/COMBAT.md` "Build diversity"; crypt tiers: `docs/DUNGEONS.md` "Farmed gear"; drop rates: `docs/EFFECTS.md`.

**Measuring with realistic play.** 3.8's sample (`telemetry:simulate`) showed ~1.9M gold in against ~0.1M out (~5 % sunk) and ~39k drops lost to full packs, but its players barely spent: a 5,000 × level starting purse, 200 of every material, one tidy and one forged item a day, and a settle every 3 h around the clock. B.2 adds a **realistic player** (now the default, `--play realistic`; `--play crude` is 3.8's): a purse it could have earned (1,500 × level), 10 × level of each material, **five visits a day** (about 15 credited hours; the night is capped at 3 h), and at every visit it wears any find that beats the piece in its slot (item level, rarity, upgrades), sells commons and uncommons, salvages rares, epics and plain Legendaries it doesn't wear (set pieces, Mythics and Void are kept), and spends its gold on upgrades of worn gear, lowest level first, until gold or materials run out (at most 60 attempts). Half the heroes use a loot filter, as before. 24 heroes (6 profiles × 4 classes, levels 1–23 at the start), 7 game days.

| 7 game days, 24 heroes, 2,555 farming hours | 3.8 crude player (3 days, main) | Realistic, rules before B.2 | Realistic, B.2 |
|---|---|---|---|
| Gold in · out · sunk | 1.91M · 0.10M · 5 % | 3.36M · 2.02M · 60 % | 3.28M · 3.27M · **99.7 %** |
| Forge upgrade attempts · items reaching +10 | 288 · 1 | 4,156 · 156 | 3,927 · 73 |
| Heroes with a whole kit at +10 at the end | 0 | 19 of 24 | 2 of 24 |
| Gold left at the end (median hero) | — | ≈ 75k | ≈ 2.4k |
| Drops auto-salvaged to full packs | 39,156 | 41,016 (188 Legendary/Mythic) | 39,289 (**0** Legendary/Mythic; 227 kept over capacity) |

**Reading.**
- **Income.** A realistic player earns 2–2.5 × the kill gold the B.1 tables measure: in the Sunken Abbey ≈ 1,650 gold an hour of farming gold (kill gold with gold find, loot-filter and overflow gold; manual sells and salvages add ~10 % more), against 651 for a common kit without gold find. Faster kills (late-game builds hit the farming cap), gold find and selling drops make the difference.
- **The sink before B.2 ran out.** Against that income a whole kit reached +10 in about 70–100 h of play (19 of 24 heroes in a week; low-level kits are cheap, `(itemLevel + 5) / 25`), and then gold piled up (median 75k, up to 176k) with nothing left to buy: rerolls and improvements are small.
- **Tuned:** the gold of the steps **+5 → +10 doubled** (table above; +0 → +5 unchanged, so the first steps stay cheap and nearly certain). Everything else about the Forge is unchanged (chances, pity, materials, rerolls, improvements). Now nearly all income is sunk, the median hero is still working toward +10 after a week, and a whole +10 kit is a 90–220 h project at realistic income (asserted).
- **No grind wall.** A single item's +0 → +5 costs 0.2–1.5 h of realistic income, a whole kit to +5 under 10 h; failure still costs only the attempt and the pity bounds a whole track at ≈ 2.1 × its mean (asserted in `balance.test.ts`, "the gold sink").
- **Materials vs gathering.** Tier-3 upgrades (iron ore, soul shards) never ran out for Abbey farmers (100k+ iron ore surplus overall, soul shards from salvaging). The one material gate: upgrading **tier-2** gear (raw hide and timber) while farming the Abbey, which gathers neither. Those heroes stopped at +7–8 with 80–110k gold left (in the simulation they keep their upgraded tier-2 pieces; a player would replace them with Abbey drops). Accepted: upgrading old-tier gear asks the player to farm (or salvage) that tier's materials. Soul shards bind briefly at +8 → +10 (2–4 a step, 41 an item over the whole track), and salvaging rares covers it.
- **Drops lost to full packs** are almost all ordinary drops of heroes without a loot filter (an Abbey hero finds ~60 items an hour, and one visit's window holds three hours of drops): ~31 an hour per such hero, 60 % commons, 26 % uncommons. They pay the overflow salvage gold (6 % of all income). Since B.2 no Legendary, Mythic, set or Void drop is among them (`docs/FARMING.md`).

| Gold sink (B.2; kit = 9 items at the area's middle level, `balance.test.ts`) | Before | After |
|---|---|---|
| One item +5 → +10, Sunken Abbey 19 | 12.5k (19 h of kill gold, ≈ 8 h realistic) | 25k (≈ 15 h realistic) |
| Whole kit to +10, Sunken Abbey 19 | 120k (185 h of kill gold, ≈ 74 h realistic) | 232k (≈ 143 h realistic) |
| Whole kit to +5 (unchanged) | 2.4–8k (≈ 3–5 h realistic) | same |
| The Phase 2 purse (25–30k at 17) | a kit to +5 and one or two items to +10 | a kit to +5 and one item most of the way to +10 |

How to reproduce: `pnpm --filter @worldforge/server telemetry:simulate -- --days 7` (about 8 minutes), then `PLAYTEST_DATA_DIR=.telemetry-sample pnpm report:telemetry`. Seeds are server-random, so numbers move by a few percent between runs.

## The top end (ticket 4.8)
**The Ashfall Verge (ticket 6.1).** The same gear earns more there than at the Pass's top: the Pass's Legendaries +10 (item level 27) 1,570–2,720 kill gold an hour at 28 (the Pass at 28: 2,120–2,350), its best builds +10 Void 3,500–4,200 (Pass: 2,890–3,400), from × 2.3 kill gold (`goldMultiplier`). It yields 30–90 iron ore and 2–10 soul shards an hour (the revenants are undead); tier-4 items salvage to 3 iron ore a unit (tier 3: 2), so their Forge upgrades ask for more of the ore the Verge itself yields; sell and salvage gold depend only on rarity and item level, as before. Its merchant stock (item level 31) costs 3–20 minutes (common) of its kill gold (`balance.test.ts`). No new material.

The Ashen Pass (`docs/WORLD.md`) pays more per hour than the Abbey's top for the gear that farms it: rares +5 earn 900–1,260 kill gold an hour at 24 (Abbey 22, same kit: 790–1,020), Legendary +10 kits 2,100–2,850 at 26. Its kills are slower (7–9 a minute), so its loot table multiplies kill gold by 1.6 (`goldMultiplier`; no other table is touched). It yields the upgrade track's materials: 27–36 iron ore and 3–5 soul shards an hour (the wraiths are undead), so the Pass feeds the +8 → +10 soul-shard step that bound Abbey farmers in B.2. The Ashen Warden's purse is 700–1,000 gold per hoard (20 h cooldown). Its merchant stock (item level 26) costs about 12 minutes (common) and 25 minutes (uncommon) of its kill gold. Forge costs are unchanged; B.3 measures the new income against the sinks with the realistic player.

**The Cinder Depths (ticket 6.2).** Good Verge gear (plain Legendaries +10, item level 33) earns 2,400–4,600 kill gold an hour at 34 (more than the Verge's top with the same gear: kill gold × 3, `goldMultiplier`), and yields 34–43 iron ore and 3–5 soul shards an hour. Drops salvage and sell as any tier-4 item (rarity and item level); no new gathering material. The Forge Tyrant's purse is 1,400–2,000 gold per hoard (20 h cooldown).

### The Tyrant's Forge: the ember and its sink (ticket 6.2)
The Forge Tyrant's hoard holds one **Tyrant's Ember** (`tyrantsEmber`, epic boss material, never tradeable: `UNTRADEABLE_MATERIALS`), so at most one per hero per 20 hours. Its only use, and a modest one, is a Forge recipe:

| Recipe | Tier | Level | Gold | Materials | Rarity | Item level |
|---|---|---|---|---|---|---|
| Tyrantforged Work | 4 | 36 | 3,000 | 1 Tyrant's Ember, 60 iron ore, 12 soul shards | rare 65, epic 35 (never below Rare) | the hero's level, at most 41 (`ForgeRecipe.maxItemLevel`) |

- **What it buys:** a Cinderwastes (tier-4) piece **in the slot the player picks**, at the Depths' item levels. That is the targeting the hoard and the farming lack: the hoard's two items are random within its anvil focus. It never makes a Legendary, so it doesn't compete with the hoard or with farming for the top rarities; its value is a guaranteed Rare/Epic base to upgrade in a slot the hero still lacks.
- **What it costs:** the ember (one hoard), about 0.7–1.3 h of Depths kill gold, 1.5–2 h of Depths ore and 2.5–4 h of soul shards. It sits beside the +10 upgrade track (which keeps absorbing gold and ore) instead of replacing it.
- **Crafted items** follow the T.1 table like every craft (by rarity: an Epic is bind-on-equip and tradeable only when the switches allow it). The ember itself never leaves the hero.
- **No change elsewhere:** the earlier recipes keep their uncapped item level (only this recipe sets `maxItemLevel`); every Forge price and path is unchanged. Its second sink is **Item Awakening** (ticket 6.5b, `docs/AWAKENING.md`): 3 Embers per awakening, so each awakening is 3 crafts not made.
- **Tested:** `economy.test.ts` (rarities, the item-level cap, the ember blocker, older recipes uncapped), `world/cinder-depths.test.ts` (the craft through the API spends exactly one ember, 3,000 gold, 60 ore and 12 shards and makes a tier-4 piece in the chosen slot; refused without the ember), the journey step (`playCinderDepthsStep`: the hoard's ember is spent on it).

## Balance pass: top end & social economy (ticket B.3)
The owner's playtest feedback had not arrived (`docs/PLAYTEST_FEEDBACK.md` is still the template), so B.3 balances on simulations and telemetry. Top end: `docs/COMBAT.md` "The top end, checked" and `docs/DUNGEONS.md` "Tier III is the Legendary tier"; projects: `docs/COMMUNITY.md` "How long a stage takes"; guild boss: `docs/GUILD_BOSS.md` "Ticket B.3".

**Measuring the Phase 4 economy.** `telemetry:simulate`'s realistic player now plays the new sinks and sources (`docs/TELEMETRY.md`): it moves up areas and crypt tiers as it levels, gives a daily share to the community projects (which open the Warehouse, the Ashen Pass and the Warden's Watch through the real API), stores keepsakes and buys shelves, founds or joins one of two guilds (4 and 20 members) and fights the guild boss three times a week, and farms the Pass and runs the Watch once open. 28 heroes (7 profiles × 4 classes, levels 1–25 at the start), 7 game days, the same simulator on `main` (before) and on this branch (after). Both runs reconcile with the audit log (all 70 checks).

| 7 game days, 28 heroes, ~3,100 farming hours | Before B.3 (main) | After B.3 |
| --- | --- | --- |
| Gold in · out · sunk | 6.11M · 5.23M · 86 % | 6.21M · 5.11M · 82 % |
| Farming hours (gold/h) at the Ashen Pass · Abbey · Blackwater | 2,018 h (2,007) · 643 h (1,417) · 249 h (941) | 2,013 h (2,043) · 645 h (1,430) · 249 h (943) |
| Forge upgrades (sink share) | 5.10M (97.4 %) | 4.98M (97.4 %) |
| Community projects · guild founding · warehouse upgrades | 114,000 · 10,000 · 0 | 114,000 · 10,000 · 0 |
| Guild boss rewards (gold in) | 27,600 (0.45 %) | 27,600 (0.44 %) |
| Both projects done · the Pass reached by its first hero | day 2 · day 2 | day 2 · day 2 |
| Guild boss: small (4) · large (20) guild | stage 2 · stage 3 | stage 2 · stage 3 |
| Heroes with a whole kit at +10 · median gold left | 7 of 28 · 29.6k | 9 of 28 · 21.5k |
| Keepsakes stored in warehouses (most by one hero) | 427 (24) | 383 (24) |

The two columns differ only by seed noise: with 28 accounts every project stage closes on its first day and both guilds clear their stages either way, so B.3's changes (the growing cap, the trimmed Warehouse needs, guild boss stage 2) don't bind; they matter for small towns and small guilds, which the timeline model and the guild-boss table measure.

**Reading.**
- **The social sinks are small next to the Forge.** Projects (a one-off 114,000 gold for the whole town), guild founding (5,000 per guild, ~2–3 h of mid-game income) and the guild boss's rewards (≤ 3,050 a week each) together move under 3 % of the gold. The Forge stays the economy's sink (97 % of gold out).
- **The Ashen Pass's × 1.6 kill gold** makes it the best gold an hour (≈ 2,000 against the Abbey's ≈ 1,400 at the same kits), as 4.8 intended: about a third more for the players who reached it, and it also yields the +8 → +10 materials. Kept.
- **"The sink works without a grind wall" still holds at the Pass.** A whole kit +0 → +10 at item level 27 costs about 1.3 × the Abbey's (the cost scales with `(itemLevel + 5) / 25`): ≈ 300k gold, ≈ 140 h of realistic Pass income, inside B.2's 90–220 h band. 7–9 of 28 heroes finished a whole +10 kit in the week (all of them heroes that started at 21–25; B.2's week had 2 of 24 without the Pass); the median hero still has upgrades to buy. The heroes with 70k–150k gold left are B.2's accepted material gate (old tier-2 pieces that need raw hide and timber while they farm the Pass, where neither drops), not a missing sink. No Forge number changed.
- **The warehouse upgrades were not bought in the week.** A top hero stores ≤ 24 keepsakes in seven days, under the 30 free shelves, so the first upgrade (1,000) comes in week 2 and 120 shelves after roughly 5–8 weeks. The 106,500 gold in all is ≈ 3–4 days of Pass income or ≈ 6 days of Blackwater income, spread over those weeks: a sink with a use, not a wall. **Kept as is** (4.7's "untuned" prices are now measured).
- **Materials are plentiful** at the top (≈ 265k iron ore, 26k soul shards, 6k Abbey silver net in the week): the projects' material needs are a small-town problem, not an economy one, which is why the Warehouse's were trimmed (`docs/COMMUNITY.md`).

| Social sink or source (B.3) | Before | After | Why |
| --- | --- | --- | --- |
| Project cap per player and day | 20 % of each need | 20 % on a stage's first day, + 20 points a day it stands, ≤ 60 % | small towns not held 5 days a stage; five players still needed on day one |
| Warehouse needs | timber 400 · 300, raw hide 300, iron ore 250 | 250 · 200, 200, 200 (gold unchanged) | the solo / tiny-town time was material-bound |
| Ashen Pass needs | — | unchanged | |
| Guild boss stage 2 | 120,000 | 100,000 | 3–5 late-game heroes break it weekly; one capped hero still can't |
| Guild boss cap, other stages, rewards | 30,000; 18k / 400k / 1M / 2.2M; ≤ 3,050 gold a week | unchanged | measured, fit |
| Guild founding | 5,000 | unchanged | ~2–3 h of mid-game income |
| Warehouse upgrades | 1,000 … 50,000 (106,500) | unchanged | used over weeks, not a wall |
| Ashen Pass kill gold | × 1.6 | unchanged | best gold an hour at the top, as intended |

**Input for trading (`docs/TRADING.md`, a later phase).** When trading opens, gold will flow between players whose incomes differ by × 5–6 (Fields ≈ 350/h against the Pass ≈ 2,000/h), and high-level players end weeks with 20k–150k spare gold and large material surpluses (iron ore, soul shards). Price limits, listing fees or a trade tax should be sized against that; the material surplus means material trades will be cheap, so they're no RMT lever. The project caps and the guild boss rewards are per account and need no change for trading (gifts to projects are not tradeable). Re-run this simulation with trading included when it's built.

How to reproduce: `pnpm --filter @worldforge/server telemetry:simulate -- --days 7` (about 9 minutes, `--social off` for B.2's player), `PLAYTEST_DATA_DIR=.telemetry-sample pnpm report:telemetry`, and `tools/balance/sim-state.ts` for the end state of each hero.

## Balance check: trading and the shelf (ticket T.7)
TRADING.md §6 asked for B.2/B.3's realistic player to be re-run with trading on: the traded share of what drops, of what is worn and of income (alarm: more than 10 % of Legendary/set items in use, or more than 5 % of gold income, from trades), the shelf's effect on B.2's sink numbers ("one hero's purse" against "one account's purse"), and the worn-effect distribution.

**In short.** With the default limits, trades move very little value: 0.3 % of gold income, 0.3–0.6 % of material income, 1.2–1.4 % of Epic and 4 % of Legendary drops. But because a gift goes exactly where it is an upgrade, **12–15 % of the Legendaries worn after the week came from a trade**, over the 10 % alarm (the weekly cap of 3 Legendary/set pieces per receiving account binds: most refusals were caps). The gifted pieces are finds that would otherwise have been salvaged for want of the right class, so no item enters the economy and the worn-effect distribution doesn't move. The shelf can't double an account's income (only one hero of an account farms at a time), so "one account's purse" earns what one hero would; it lets an alt's idle gold reach the main's Forge (14 % on top of the main's own income) and so raises the share sunk, as do material gifts to heroes held at B.2's tier-2 material gate. No limit or default changed.

**Method.** `telemetry:simulate` (`docs/TELEMETRY.md` "Trading and the shelf") gained `--trading on|all` and `--alts`. Four 7-day runs side by side (about 13 minutes): **base**, B.3's player unchanged (28 heroes, 28 accounts); **alts**, the accounts of the eight level-21 and level-23 heroes get a second hero (level 14, the next class) who farms the night while the main farms the day, trading off; **on**, the same with trading and the shelf open (the "Tradeable" categories at their defaults, Mythic and Void off); **all**, also Mythic and Void. Accounts and guild memberships are dated 30 days back and emails verified, so every guild member with a hero at 15+ is eligible from day one (the two guilds of 4 and 20 are the relations; the level-1 heroes stay out). Guildmates gift the Epic and better finds they would salvage, and keepsakes their class can't wear, to whoever they improve most; small gold gifts (3,000) and material gifts or swaps (150 units; 20 soul shards); inboxes are emptied every visit. Every trade and shelf move goes through the real API, and the four runs reconcile with the audit log (**99 of 99 checks** each, trades' and the shelf's conservation checks included). Measured with `tools/balance/trading.ts`; seeds are server-random, so runs differ by a few percent (a first pair of on/all runs gave 11.8 % and 12.3 % for the Legendary alarm).

| 7 game days | base | alts | on | all |
| --- | --- | --- | --- | --- |
| Heroes · accounts | 28 · 28 | 36 · 28 | 36 · 28 | 36 · 28 |
| Gold in · out · sunk (trades excluded) | 6.13M · 5.00M · 81.6 % | 6.09M · 4.78M · 78.6 % | 6.21M · 6.05M · 97.5 % | 6.20M · 5.60M · 90.3 % |
| Trades completed (offers over a cap declined) | — | — | 92 (16) | 81 (17) |
| Epic: traded / dropped | — | — | 67 / 5,376 (1.2 %) | 71 / 5,205 (1.4 %) |
| Legendary (not set): traded / dropped | — | — | 27 / 699 (3.9 %) | 27 / 669 (4.0 %) |
| Set · Mythic · Void traded | — | — | 0 · 0 · 0 | 0 · 0 · 0 |
| Epics worn at the end from a trade | 0 of 107 | 0 of 131 | 22 of 134 (16.4 %) | 23 of 132 (17.4 %) |
| **Legendary + set worn from a trade (alarm > 10 %)** | 0 % | 0 % | **15.4 %** (20 of 130) | **12.1 %** (17 of 141) |
| **Gold traded / gold income (alarm > 5 %)** | — | — | 18,000 (**0.3 %**) | 21,000 (**0.3 %**) |
| Materials traded / material income | — | — | 2,550 (0.6 %) | 1,350 (0.3 %) |

| The shelf: the 8 accounts with two heroes | alts (shelf off) | on | all |
| --- | --- | --- | --- |
| Gold earned: main · alt | 1.77M · 131k | 1.76M · 131k | 1.79M · 133k |
| Moved over the shelf: gold · materials · items | 0 | 252k · 19.5k · 0 | 248k · 19.2k · 0 |
| Shelf gold / the mains' own income | — | 14.3 % | 13.9 % |
| Gold sunk: main · alt | 1.84M · 171k | 2.02M · 42k | 1.96M · 47k |
| One hero's purse (main): sunk / earned | 103.9 % | 114.7 % | 109.4 % |
| The main with the shelf: sunk / (earned + taken from the shelf) | 103.9 % | 100.3 % | 96.1 % |
| One account's purse: sunk / earned | 105.7 % | 108.9 % | 104.3 % |
| Gold left: mains · alts (median main) | 195k · 128k (7.0k) | 257k · 5.5k (36k) | 338k · 5.8k (42k) |
| Upgrades bought: main · alt | 1,327 · 673 | 1,391 · 447 | 1,350 · 472 |
| Mains' pieces at +10 · whole +10 kits | 47 · 2 of 8 | 65 · 7 of 8 | 61 · 5 of 8 |
| The 20 one-hero accounts: sunk · whole +10 kits · median gold left | 66.3 % · 3 · 97k | 92.5 % · 3 · 7.1k | 84.0 % · 3 · 24k |

Sunk shares over 100 % spend the starting purse (1,500 × level), as in B.2.

| Worn at the end (all heroes) | base | alts | on | all |
| --- | --- | --- | --- | --- |
| Legendary effects worn · distinct | 108 · 11 | 127 · 11 | 130 · 10 | 140 · 11 |
| Top effect (share) | `bramblemail` 16.7 % | `unbroken` 19.7 % | `unbroken` 16.9 % | `unbroken` 18.6 % |
| Effects HHI · entropy | 0.134 · 3.02 bits | 0.140 · 2.97 | 0.132 · 3.04 | 0.134 · 3.03 |
| Distinct effects per class (hunter · mage · warlock · warrior) | 8 · 8 · 8 · 8 | 8 · 8 · 8 · 8 | 8 · 9 · 7 · 9 | 8 · 8 · 8 · 8 |
| Set pieces worn | 0 | 1 | 0 | 1 |

**Reading.**
- **Gold and materials are far under their alarms.** Gold gifts need a rich giver, and the realistic player spends nearly everything at the Forge, so a week saw 6–8 gifts of 3,000 (0.3 % of income against the 5 % alarm; the 10,000-a-week cap was reached once or twice). Material gifts and swaps are a fraction of a percent of what is gathered, as B.3 expected.
- **The Legendary alarm trips in every run (12–15 %), with traded Legendaries only ~4 % of Legendary drops.** The alarm counts what is *worn*, and gifts are targeted: a Legendary goes to the guildmate whose slot it beats most, and the receiver's 3-a-week cap is the binding limit (63–65 item offers refused at send and 16–17 declined at accept for a cap). This is the sim's cooperative upper bound (a 20-member guild where everyone gifts every useful find from day one), and every gifted piece would otherwise have been salvaged for want of the right class, which TRADING.md §6 lists as a gain. Epics show the same pattern (16–17 % of worn Epics), with no alarm set for them.
- **Build diversity is unchanged.** Distinct effects (10–11), the top effect's share (17–20 %), HHI (0.13–0.14) and entropy (≈ 3.0 bits) are within the noise between the two runs without trading. Gifts follow the receiver's class and slot, not one strongest effect. Mythic and Void being tradeable (`all`) changed nothing in the week: no Mythic, Void or set piece was traded, because to this player (who scores gear by level, rarity and upgrades) a fresh +0 Mythic or set piece never beats a guildmate's upgraded Legendary, and set pieces are hardly worn even without trading. **The simulation doesn't measure set completion or Mythic chasing**; the live telemetry (`trade.items` by rarity and variant, `docs/TELEMETRY.md`) must.
- **The shelf changes the unit, not the income.** Only one hero of an account farms at a time (the activity is per account), so an account earns what one hero would (alts: the main's 1.77M plus the alt's 131k for its night, against 6.13M / 28 ≈ 219k a hero in base). TRADING.md §3's "at most doubles" doesn't happen. With the shelf, the alt's gold reaches the main (252k in the week, 14 % on top of the main's own income) instead of sitting on the alt (128k idle without it), and the main's purse stays fully spent (sunk / (earned + shelf) ≈ 100 %). The mains finished more +10 pieces (47 → 61–65) and kits (2 → 5–7 of 8). Finds didn't move over the shelf: a level-14 alt's drops never beat its level-21+ main's.
- **The tier-2 material gate eases.** The one-hero accounts sank 84–93 % of their income with trading against 66 % without (median gold left 7–24k against 97k): small material gifts (raw hide, timber, 150 units) and gifted pieces unblock the heroes B.2 found stopped at +7–8 for want of old-tier materials. That's the gate TRADING.md expected trading to ease; the 300-units-a-week cap kept it a gift.

**Decision: no limit or default changed.** Gold, materials and diversity give no reason to. The Legendary/set alarm is the one number over its line; it is reached with traded Legendaries at ~4 % of drops and binding caps, by items that would have been salvaged. If the owner wants the alarm to hold even for a guild that gifts everything, the lever is **"Legendary and set pieces per week" 3 → 2** (within its hard maximum of 10; at 2 the worn share would fall roughly in proportion, to ≈ 8–10 % in the first week). Recommended instead: keep 3, and watch the alarm in the live telemetry over several weeks, where gifting is rarer than in the simulation.

How to reproduce (`tools/balance/README.md`): four runs side by side, `telemetry:simulate -- --days 7 --dir .telemetry-sample/t7-base` (also `t7-alts --alts`, `t7-on --trading on`, `t7-all --trading all`), then `tools/balance/trading.ts base=… alts=… on=… all=…`.

## Event materials (ticket 6.6)
Events add a modest, documented amount of one material and nothing else (`docs/EVENTS.md`; Phase 6 rule "ordinary loot at ordinary odds"). **The Harvest of Bones:** for heroes who joined, every 40 risen dead put down in the Abandoned Fields or the Old Burial Grounds yield one Soul Shard (`material.in` source `event`): at most 2.5 % of a shard per kill, under the Burial Grounds' 3 % undead drop, so at most about × 1.8 their soul shards while it lasts, and a new trickle in the Fields (≈ 6 an hour for a level-6 hero there, `events.test.ts`). Against the sinks: a whole +0 → +10 track needs about 41 shards an item and B.3 measured a surplus of 26k shards a week at the top, so a week of the Harvest moves no upgrade pace measurably. **B.5** measured it at the top: a level-40 hero in the Burial Grounds puts down 1,200–1,340 risen an hour, 29–33 bonus shards on top of the area's own 38–40, while giving up half its Depths gold and nearly all its XP; unchanged (`docs/BALANCE.md` "B.5", item 7, with the awakening economy in item 8). XP, gold, items and drop odds are unchanged; event tasks and the reward track pay no gold, XP or items.

## Town upgrades (ticket 6.7)
A completed community project may open a town upgrade for everyone: a modest service, never power (no stats, drops, odds or XP). Data in game-core `economy/town.ts` (`TOWN_UPGRADES`), keyed on a world flag.

| Upgrade | Opened by | Effect | Size |
| --- | --- | --- | --- |
| **The Forgeward bellows** (`forgewardBellows`) | `forgewardRaised` (the Forgeward Outpost, `docs/COMMUNITY.md`) | Tyrantforged Work costs **20 % less gold**: 3,000 → **2,400** | 600 gold per craft |

- **Why this one.** The recipe's pace is set by the Tyrant's Ember (one per 20-hour hoard), not by its gold, so a cheaper price changes no item rate, rarity or level: it only shrinks a sink by 600 gold a craft (about a fifth of an hour of Depths gold). The other candidates were weighed: an extra Tavern contract slot pays more XP, gold and items a day (power), and a Cinderwastes waystation has nothing to speed up (farming has no travel time).
- **Server:** the Forge's recipe list (`GET …/forge`) and the craft price the recipe with `townPricedRecipe` from the world flags; the craft reads the flags table in its transaction (exact), and the audit row, the `gold.out forge_craft` telemetry and the hero's gold all carry the lowered price, so `reconcileWithAudit` still balances. The recipe view says which upgrade lowered it (`townUpgrade: { id, name, baseGold }`), and the Forge shows "The Forgeward bellows: was 3,000". Every other recipe, and this one without the flag, is untouched (same object; tested).
- **The ember's sinks** now are three: Tyrantforged Work (one each), Item Awakening (three each) and, once, the Forgeward Outpost's beacon (ten for the whole town, at most two per account on its first day).
- **The chain as a sink:** 300,000 gold, 2,500 iron ore, 1,200 soul shards, 80 Abbey silver and 10 embers, once for the whole town (the Ashen Pass took 90,000 gold).

## Item Awakening (ticket 6.5b)
The Forge's last path for a finished item (`docs/AWAKENING.md`): a +10 Legendary, Mythic or set item at item level 23 or higher is awakened once, permanently; its effect (or its set's bonuses, piece by piece) counts × 1.1. **Price** (`DEFAULT_AWAKENING_SETTINGS.cost`, data): 3 Tyrant's Embers, 2 Gravewarden's Seals (one per crypt hoard of any tier, Heroic included: the Seal's lasting sink), 15,000 gold at item level 20 scaled like every Forge price by `(itemLevel + 5) / 25` (25,200 at item level 37) and 30 soul shards. Gold and materials on hold after a trade don't count. Embers and Seals are untradeable and come from 20-hour boss hoards, so time, not gold, paces it (about 3 days per item for a dedicated player). No random draw. Afterwards rerolls and improvements stay available at their usual prices. Audit `forge.awaken`; telemetry sink source `forge_awaken` (`gold.out`, `material.out`), reconciled.

## Seal and silver sinks (ticket 6.11)
Owner decisions (B.5 item 8, 6.10 question 1): a sink for the Gravewarden's Seals left over after awakening and for Abbey silver once the Forgeward stands. **No new power**: nothing here is read by a combat, loot, scoring, PvP or trading rule, nothing counts in duels, boards, Gear Score or Power. Data in game-core `cosmetics/exchange.ts` (`COSMETIC_EXCHANGE`, `ENGRAVING_PRICES`, `ENGRAVINGS`); details of the cosmetics in `docs/COSMETICS.md` "The exchange and engravings".

| Sink | Price | Repeatable? | What it gives |
|---|---|---|---|
| **The engraver**, seal-wax (`POST …/forge/engrave`, finish `seal`) | **2 Gravewarden's Seals** | yes: every engraving pays, a re-engraving included | words from a fixed list of twelve epithets, shown in the item's tooltip in wax red |
| **The engraver**, silver inlay (finish `silver`) | **15 Abbey silver** | yes | the same words in tarnished silver |
| **The Seal and Silver Counter** (`POST …/exchange`): Seal-wax title colour | 3 Seals | once per account | collection-book entry |
| Abbey-silver title colour | 25 silver | once | 〃 |
| Silvered seal banner | 2 Seals + 20 silver | once | 〃 |
| Abbey-silver crest | 30 silver | once | 〃 |
| Wax-sealed crest | 4 Seals | once | 〃 |

Exchange in all: 9 Seals and 75 silver. No gold (gold has its sinks). Two Seals is an awakening's Seal share, so engraving a whole kit costs about what a dedicated player has left over after awakening it.

- **Rules.** Paid from the hero's own holdings; gold and materials on hold after a trade don't count (the quote names what is missing and the spend refuses it, T.5). The engraver works on worn and packed items (not stored, shelved or held ones), has no random draw, refuses the same engraving twice (`409 same_engraving`) and words off the list (`422 unknown_engraving`) before paying, and doesn't bind the item (an engraving is cosmetic; it travels with the item through the shelf or a trade). The exchange grants through the collection book's `grantCosmeticsTx` before paying, in one transaction, so a cosmetic is bought exactly once per account even when two heroes race (`409 already_owned`, nothing paid). Both need an `Idempotency-Key`.
- **Audit and telemetry, reconciled:** `forge.engrave` (engraving, previous, finish, materials; the `forge` metric `engrave, <rarity>, <finish>`, `material.out` source `forge_engrave`); `cosmetic.exchange` (cosmetic, kind, materials; metric `cosmetic.exchange`, `material.out` source `cosmetic_exchange`) next to the grant's `cosmetic.grant`. `reconcileWithAudit` checks both ("forge: engrave…", "cosmetics: exchange…"), and the journey's holdings replay counts them.
- **Test accounts** may use both (cosmetics rank nothing); their telemetry goes to the test rollups like everything they do (D.4).
- **The awakening reserve.** The Forge warns when seal-wax would leave fewer Seals than the hero's ready-to-awaken items need (two each); silver inlay spends none.

**The flow before and after** (`docs/BALANCE.md` "6.11", the realistic dedicated player over a 56-day season): Seals come in at about 1.3 a day (a crypt hoard a day and the guild boss's two a week) and awakening takes 0.67 a day.

| class | before: full awakened kit · spare Seals then | after: full awakened kit · spare Seals then | Seals / silver to the sinks over the season |
|---|---|---|---|
| warrior (9 pieces) | day 27 · 16.7 | day 27 · 3.7 | 17 / 150 |
| mage, hunter, warlock (8) | day 24–25 · 14.9–16.1 | day 24–25 · 1.1–3.9 | 15 / 150 |

The kit day is the same with and without the sinks (they take only Seals above the reserve). Abbey silver: a dedicated hero gathers about 200 levelling through the Abbey (17 → 23) and none later; with 150 left after the town works the exchange and a kit's silver inlays use it up, and with 40 the Seal side carries the engravings. After the kit, the engraver keeps taking Seals (2 an engraving) for every new piece.
