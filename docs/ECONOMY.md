# Merchant, Forge & the gold and material economy (tickets 2.6, B.1, 3.4)

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

**Costs.** Every action costs gold plus the item's own **tier materials** (the salvage table's units: tier 1 timber, tier 2 raw hide + timber, tier 3 two iron ore per unit) and soul shards. Everything scales with the item level by `(itemLevel + 5) / 25` (× 1 at item level 20, × 0.4 at 5), so cheap gear is cheap to work. Upgrades and sell/salvage prices are independent: an upgraded item sells and salvages for the same as at +0 (the investment is a sink, not a deposit).

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
A shared sink: the two projects take 114,000 gold and ~2,400 materials in all, at most 20 % of each stage's need per player and day (`docs/COMMUNITY.md` "Numbers"). Telemetry: `gold.out community_project`, `material.out community_project`.

## The Warehouse (ticket 4.7)
A gold sink with a use: six upgrades from 30 to 120 shelves cost 1,000 · 3,000 · 7,500 · 15,000 · 30,000 · 50,000 gold (106,500 in all, `docs/WAREHOUSE.md`). Stored items are never sold or salvaged until moved back; they keep their sell and salvage prices. Telemetry: `gold.out warehouse_upgrade`.

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
The Ashen Pass (`docs/WORLD.md`) pays more per hour than the Abbey's top for the gear that farms it: rares +5 earn 900–1,260 kill gold an hour at 24 (Abbey 22, same kit: 790–1,020), Legendary +10 kits 2,100–2,850 at 26. Its kills are slower (7–9 a minute), so its loot table multiplies kill gold by 1.6 (`goldMultiplier`; no other table is touched). It yields the upgrade track's materials: 27–36 iron ore and 3–5 soul shards an hour (the wraiths are undead), so the Pass feeds the +8 → +10 soul-shard step that bound Abbey farmers in B.2. The Ashen Warden's purse is 700–1,000 gold per hoard (20 h cooldown). Its merchant stock (item level 26) costs about 12 minutes (common) and 25 minutes (uncommon) of its kill gold. Forge costs are unchanged; B.3 measures the new income against the sinks with the realistic player.
