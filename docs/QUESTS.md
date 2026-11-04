# Quests & contracts

Ticket 2.4 (GDD §6.4, §11.1, §4.2). The Tavern's notice board offers a short story chain through Graumark and three repeatable contracts a day. Rules and content live in `packages/game-core/src/quests/`; state in `apps/server/src/quests/` (table `character_quests`, `docs/DATA_MODEL.md`); the UI in `apps/web/src/screens/TavernScreen.tsx` and the area screen's tracker (`apps/web/src/quests/`).

## Content
- **Objectives** (`QuestObjective`): `kill { enemyId, count }`, `gather { materialId, count }`, `reach { areaId }`, `defeatBoss { bossId }`.
- **Rewards** (`QuestReward`): XP, gold, materials, and sometimes a fixed item (`{ baseId, rarityId, itemLevel }`, affixes rolled with a server seed at turn-in, `source = 'quest'`). Reward items are jewelry, so every class can wear them.
- **Story chain** (`STORY_QUESTS`, each once per character, in order, gated by level and the previous quest being turned in):

| Quest | Level | Objectives | Reward |
|---|---|---|---|
| The Furrows of the Dead | 1 | 12 Risen Farmhands | 120 XP, 40 gold |
| Wolves at the Fence | 2 | 10 Carrion Wolves, 15 Timber | 300 XP, 70 gold, 5 Ashwort |
| The Crowwood Road | 5 | fight in Crowwood, 15 Bandit Cutthroats | 800 XP, 160 gold, 6 Raw Hide |
| What the Crows Guard | 9 | fight in the Old Burial Grounds, 15 Risen Skeletons, 8 Soul Shards | 1,800 XP, 320 gold, rare Grave-Gold Ring (ilvl 11) |
| The Nameless Crypt | 12 | defeat the Gravewarden | 4,500 XP, 900 gold, 10 Soul Shards, epic Raven Talisman (ilvl 16) |

- **Contracts** (`CONTRACT_TEMPLATES`, derived from the area content): one bounty per area enemy (25 kills) and one gathering contract per material at the first area that yields it (20 units; Soul Shards 10, Abbey Silver 3). Reward at acceptance: `round(xpToNextLevel(level) · 0.3 · scale)` XP and `round((20 + 6 · level) · scale)` gold.

First-pass numbers; tune in B.1.

## Daily contracts
`dailyContracts(characterId, day, level, progress)` picks 3 distinct templates from the areas the character has unlocked, with the RNG seeded server-side by `contracts:<characterId>:<UTC day>`; newer areas weigh more. Each slot can be accepted once per day (unique index on `(character, day, slot)`), and a character holds at most 3 contracts at a time (`422 contract_limit`). Accepted contracts do not expire; the offer shown for an untaken slot may change after a level-up (it is computed from the current level), but a slot can only ever be taken once that day.

## Progress comes from events, never from the client
`QuestEvent` (game-core `quests/events.ts`):

```ts
| { type: 'enemyKilled'; enemyId; count }
| { type: 'materialGathered'; materialId; count }
| { type: 'areaReached'; areaId }
| { type: 'bossDefeated'; bossId }   // ticket 2.5: { type: 'bossDefeated', bossId: 'gravewarden' }
```

- **Farming:** `settleActivityTx` turns each settlement into events (`questEventsFromSettlement`: `areaReached` once a cycle there is committed, kills from `killsByEnemy`, materials) and applies them with `recordQuestEventsTx` in the settlement transaction, under the character lock.
- **Dungeons (ticket 2.5):** the run claim calls `recordQuestEventsTx(tx, characterId, [{ type: 'bossDefeated', bossId: 'gravewarden' }])` inside its transaction, after locking the character row. Only `bossDefeated` advances `defeatBoss`; an `enemyKilled` of the boss does not.
- Only **active** (accepted, not turned in) quests advance. Accepting settles the running activity first, so time farmed before the acceptance never counts.
- **Invariance:** `applyQuestEvents` only adds and caps at the target, and settlement results are split-invariant (ticket 1.9), so quest progress is the same however often the client settles (tested in `quests.test.ts`).

## Turn-in
`POST …/quests/:id/turn-in` with an `Idempotency-Key`, through ticket 2.6's `idempotentTransaction` (`apps/server/src/idempotency/`, `docs/API_CONVENTIONS.md`). In one transaction: claim the key, lock and settle the character, lock the quest row, check it is active and complete, grant XP (level-ups via `applyXp`), gold, materials and the item, set `turnedIn`, audit `quest.turn_in`. A replay with the same key returns the stored response; another key gets `409 quest_already_turned_in`. An item reward into a full pack is refused (`422 inventory_full`) and grants nothing. Tested on PGlite and on real PostgreSQL (`concurrency.pg.test.ts`).
