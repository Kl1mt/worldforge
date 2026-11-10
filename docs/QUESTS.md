# Quests & contracts

Ticket 2.4 (GDD §6.4, §11.1, §4.2). The Tavern's notice board offers a short story chain through Graumark and three repeatable contracts a day. Rules and content live in `packages/game-core/src/quests/`; state in `apps/server/src/quests/` (table `character_quests`, `docs/DATA_MODEL.md`); the UI in `apps/web/src/screens/TavernScreen.tsx` and the area screen's tracker (`apps/web/src/quests/`).

## Content
- **Objectives** (`QuestObjective`): `kill { enemyId, count }`, `gather { materialId, count }`, `reach { areaId }`, `defeatBoss { bossId }`.
- **Rewards** (`QuestReward`): XP, gold, materials, and sometimes a fixed item (`{ baseId, rarityId, itemLevel }`, affixes rolled with a server seed at turn-in, `source = 'quest'`). Reward items are jewelry, so every class can wear them.
- **Story chain** (`STORY_QUESTS`, each once per character, in order, gated by level and the previous quest being turned in):

| Quest | Level | Objectives | Reward |
|---|---|---|---|
| The Furrows of the Dead | 1 | 12 Risen Farmhands | 600 XP, 40 gold |
| Wolves at the Fence | 2 | 10 Carrion Wolves, 15 Timber | 1,800 XP, 70 gold, 5 Ashwort |
| The Crowwood Road | 5 | fight in Crowwood, 15 Bandit Cutthroats | 10,000 XP, 160 gold, 6 Raw Hide |
| What the Crows Guard | 9 | fight in the Old Burial Grounds, 15 Risen Skeletons, 8 Soul Shards | 30,000 XP, 320 gold, rare Grave-Gold Ring (ilvl 11) |
| The Nameless Crypt | 12 | defeat the Gravewarden | 60,000 XP, 900 gold, 10 Soul Shards, epic Raven Talisman (ilvl 16) |

- **Contracts** (`CONTRACT_TEMPLATES`, derived from the area content): one bounty per area enemy (25 kills) and one gathering contract per material at the first area that yields it (20 units; Soul Shards 10, Abbey Silver 3). Reward at acceptance: `round(xpToNextLevel(level) · 0.3 · scale)` XP and `round((20 + 6 · level) · scale)` gold.

First-pass numbers; tune in B.1.

## Targeted contract rewards (ticket 3.6)
**Abbey contracts** (`offersRewardSlot`: contracts whose area is the Sunken Abbey) let the hero choose the slot of a reward item when accepting (`{ kind: 'contract', slot, rewardSlot }`), on top of the usual XP and gold: an **Epic** of the hero's level (clamped to the Abbey's item levels, 16–23) for that slot, from the Abbey's bases the class can wear (`targetedRewardSlots`: head, chest, hands, feet, neck, ring, weapon, and the off-hand for warriors). The choice is optional (without it the contract pays as before) and fixed in the stored reward (`QuestTargetedItemReward { slot, rarityId, itemLevel, lootTableId }`). At the turn-in the item is generated from a server-random seed stored with the reward at acceptance and never shown to the client (`QuestTargetedItemReward.seed`, `generateTargetedItem`; ticket 3.9 — before, the seed was derived from the client-visible quest row id, `targetedRewardSeed`, so the item could be computed in advance; such older rows keep it): fixed from the moment the contract is taken, so a retried, raced or replayed turn-in can never roll another item; it has the Abbey's affix tier bias, never Void. A slot the contract does not offer, or a choice on another contract, is `422 reward_slot_unavailable`. With up to three Abbey contracts a day this is a slow, plannable trickle next to the Abbey's ≈ 1.5 random Epics an hour. The Tavern shows the choice as slot buttons on the notice; taking the contract needs a slot picked (screenshot: `docs/screenshots/phase-3/tavern-abbey-contract-slot-*`).

## Daily contracts
`dailyContracts(characterId, day, level, progress, world)` picks 3 distinct templates from the areas the character has unlocked (by the map's own rules, `isAreaUnlocked`, with the server's world flags since ticket F.1), with the RNG seeded server-side by `contracts:<characterId>:<UTC day>`; newer areas weigh more. Each slot can be accepted once per day (unique index on `(character, day, slot)`), and a character holds at most 3 contracts at a time (`422 contract_limit`). Accepted contracts do not expire; the offer shown for an untaken slot may change after a level-up (it is computed from the current level), but a slot can only ever be taken once that day.

**Ashen Pass contracts (ticket F.1).** The Pass's templates (one bounty per Pass foe: `slay.ashWraith`, `slay.cinderHound`, `slay.pyreCultist`, `slay.emberGolem`; its materials are bountied in earlier areas) are offered exactly when the hero can enter the Pass: the world flag `ashenPassCleared` is set (`app.worldState.flags()`, docs/COMMUNITY.md) **and** the area's own unlock holds (level 24, Gravewarden slain; `UnlockRule.worldFlag` plus the level rule, as on the world map). Before 4.11's review found it, the board never received the flags, so these contracts were never offered. The server checks the same rule three times: the board (`questBoard`) and the accept path draw with the flags; accepting re-checks the drawn template's area (`contractAreaBlockers`, `422 contract_area_locked` with `details.blockers`); and a turn-in of a contract whose area the hero cannot reach right now (the flag closed again after the offer was taken) is refused with the same error and nothing granted; it pays once the area is open again.

*What changes in the offers.* The Pass is the last area in `AREAS`, so for every hero who cannot reach it (flag closed, under level 24, or the Gravewarden not slain) the pool, the weights and the seed are exactly as before: their offers do not change, on any day (game-core and server tests check it across heroes, days and levels). Only a hero who can reach the Pass draws from a larger pool (4 Pass templates, weight 11 each, the newest area), so their whole day's draw changes once, on the day the flag is set or they reach level 24, as it already does after a level-up; a slot taken that day stays taken. Such a hero sees ≈ 1.1 Pass contracts a day (at least one on ≈ 77 % of days). Rewards depend on the level and the template's scale, not the area, so XP and gold per contract and the three contracts a day are unchanged: the gold and XP income does not move, only where the work is done. Pass contracts carry no item reward (only the Abbey's do).

## The week's boss notice (ticket 6.3)
Above the notice board the Tavern keeper announces **this week's boss modifier** (every boss but the crypt's tier I) (`docs/DUNGEONS.md` "Weekly boss modifiers"): its name, what it does in plain words, the hoard's focus and until when it holds (the next Monday 00:00 UTC, shown as a local date). It reads `GET /api/world/boss-modifier` (the game clock's week, public: the rotation is announced, not secret), with loading and error (Try again) states. No quest or contract depends on it.

## Progress comes from events, never from the client
`QuestEvent` (game-core `quests/events.ts`):

```ts
| { type: 'enemyKilled'; enemyId; count }
| { type: 'materialGathered'; materialId; count }
| { type: 'areaReached'; areaId }
| { type: 'bossDefeated'; bossId }   // ticket 2.5: { type: 'bossDefeated', bossId: 'gravewarden' }
```

- **Farming:** `settleActivityTx` turns each settlement into events (`questEventsFromSettlement`: `areaReached` once a cycle there is committed, kills from `killsByEnemy`, materials) and applies them with `recordQuestEventsTx` in the settlement transaction, under the character lock.
- **Dungeons (ticket 2.5):** the run claim calls `recordQuestEventsTx(tx, characterId, [{ type: 'bossDefeated', bossId: 'gravewarden' }])` inside its transaction, after locking the character row. Only `bossDefeated` advances `defeatBoss`; an `enemyKilled` of the boss does not. Only quests accepted at or before the run's start count its events (`acceptedBy: run.startedAt`, ticket 2.8): the run was fought then, so taking the step after the run has ended but before claiming it does not complete it.
- Only **active** (accepted, not turned in) quests advance. Accepting settles the running activity first, so time farmed before the acceptance never counts.
- **Invariance:** `applyQuestEvents` only adds and caps at the target, and settlement results are split-invariant (ticket 1.9), so quest progress is the same however often the client settles (tested in `quests.test.ts`).

## Turn-in
`POST …/quests/:id/turn-in` with an `Idempotency-Key`, through ticket 2.6's `idempotentTransaction` (`apps/server/src/idempotency/`, `docs/API_CONVENTIONS.md`). In one transaction: claim the key, lock and settle the character, lock the quest row, check it is active and complete, grant XP (level-ups via `applyXp`), gold, materials and the item, set `turnedIn`, audit `quest.turn_in`. A replay with the same key returns the stored response; another key gets `409 quest_already_turned_in`. An item reward into a full pack is refused (`422 inventory_full`) and grants nothing. Tested on PGlite and on real PostgreSQL (`concurrency.pg.test.ts`).
