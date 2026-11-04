# Farming & offline progress (ticket 1.6)

Server-authoritative farming of an area (Phase 1: Abandoned Fields). Rules are pure functions in `packages/game-core/src/activity/`; persistence, locking and routes in `apps/server/src/activity/`. Endpoints: `docs/API_CONVENTIONS.md`. Table: `activities` in `docs/DATA_MODEL.md`.

## Lifecycle
- **Start** (`POST /api/characters/:id/activity`): only the account's active character. One activity per account: starting one settles and stops the other. Same area again is a no-op; another area settles first, then switches.
- **Settle** (`POST …/activity/settle`): credits elapsed server time and returns the return summary. Clients poll this during active play.
- **Scheduled settle**: every `SETTLE_INTERVAL_SECONDS` (default 300, `0` = off), the server settles activities not settled for one interval. That keeps rewards current while the player is away. It does not count as client contact.
- **Stop** (`POST …/activity/stop`): settles, returns the final summary, deletes the row.

## Time and the offline cap
- Credited window = `[settled_at, min(now, last_seen_at + OFFLINE_CAP_SECONDS)]`, server clock only. Later time earns nothing and is reported as `cappedMs`. `settled_at` then moves to `now`.
- Client contact (start, settle, stop) moves `last_seen_at` to `now` after settling. While the client keeps settling, nothing is capped. A player who is away earns at most 3 h (`OFFLINE_CAP_SECONDS`, default 10800) however many scheduled settlements happen.
- **Active vs offline (Phase 1 rule):** the reward rate is the same. Active play is "more efficient" only because it never hits the cap. Active-only bonuses come with later activities (GDD §9.2).
- `unusedMs` (an unfinished cycle at the window end) is stored as `carry_ms` and added to the next window. No time is lost or awarded twice.

## Settlement (`settleFarming`, game-core)
- Inputs: class, level, xp, health, equipped items, area, server seed, window (incl. carry), inventory count. No client input reaches it.
- Combat: `simulateFarmingAggregate` in 15-minute chunks (`chunkMs`), chained level/xp/health. Seeds `${seed}:combat:${chunk}`.
- Loot: one `rollLoot` per kill, RNG `${seed}:loot:${chunk}`. The source level is the character's level at the chunk start, clamped to the area's enemy levels: the aggregate sim does not report per-kill enemy levels, and enemies roll at character level ±1, so this matches on average.
- **Equipment → stats:** `itemContribution` / `equipmentModifiers` sum implicit stats and affixes. Core stats go to `deriveCharacterStats`. **Gold find is summed, then capped** at `modifierCaps.goldFind` (default +100 %) before `rollLoot` (GDD §6.2).
- **Seed:** `${seed_secret}:${settlement_seq}`. The secret is 128 random bits per activity, never sent to clients. Same secret, sequence and window give the same result (tests pin this).

## Inventory capacity
`inventory.capacity` (default 60 unequipped items). Drops beyond the free space are **auto-salvaged to gold**: `round((2 + 0.5 · itemLevel) · rarity)`, rarity × 1/2/4/8/16/32 from common to mythic. The summary reports `itemsSalvaged` and `goldSalvaged`. All values are in `DEFAULT_ACTIVITY_CONFIG`.

## Concurrency and idempotency
Each settlement runs in one transaction. It locks the `characters` row, then the `activities` row (`SELECT … FOR UPDATE`). Start also locks the `accounts` row first. A concurrent settle waits, then sees the moved `settled_at` and credits ~0, so a window is never credited twice. XP, level, gold (`gold = gold + n`), item rows, the activity row and the `activity.reward` audit entry commit together.

## Return summary
`activities.summary` accumulates every settlement since the client last collected it: settlements, simulated/capped ms, kills, deaths, XP, levels, gold (incl. salvaged), items gained (last 100 listed) and salvaged. `settle` returns it with `since`/`until` and starts a new one. Rewards are already granted when it is computed, so a lost response loses only the summary, never the loot.

## Open points
- Health persists between settlements; regeneration while stopped is not modelled (it restarts at full).
- Item ids in the summary may refer to items discarded since (ticket 1.7).
- Per-settlement history beyond the audit log (an `offline_settlement` table) is deferred.
