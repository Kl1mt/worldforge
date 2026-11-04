# Farming & offline progress (ticket 1.6)

Server-authoritative farming of an area (Phase 1: Abandoned Fields). Rules are pure functions in `packages/game-core/src/activity/`; persistence, locking and routes in `apps/server/src/activity/`. Endpoints: `docs/API_CONVENTIONS.md`. Table: `activities` in `docs/DATA_MODEL.md`.

## Lifecycle
- **Start** (`POST /api/characters/:id/activity`): only the account's active character. One activity per account: starting one settles and stops the other. Same area again is a no-op; another area settles first, then switches.
- **Settle** (`POST …/activity/settle`): credits elapsed server time and returns the return summary. Clients poll this during active play.
- **Scheduled settle**: every `SETTLE_INTERVAL_SECONDS` (default 300, `0` = off), the server settles activities not settled for one interval. That keeps rewards current while the player is away. It does not count as client contact.
- **Stop** (`POST …/activity/stop`): settles, returns the final summary, saves the farm state on the character and deletes the row.
- **Farm state survives stop/start (ticket 1.9).** Ending an activity (stop, or starting another character) saves `seed_secret`, `cycle_index` and `health` to `characters.farm_state`; the next start restores them. Without this, stop → start healed the character to full and re-rolled its next encounter: cycling it after every kill gave a level-1 mage 0 deaths and +25 % kills. Unsettled carry time is forfeited on stop. Health does not regenerate while stopped (the first search of the next cycle regenerates as usual).
- **Equipment changes settle first (ticket 1.9).** Equip, unequip and discard settle the running activity (with client contact) before changing anything, so the time before the change is credited with the gear and inventory that were really there: no swapping in a gold-find set just before settling, and no discarding to dodge the capacity rule retroactively.

## Time and the offline cap
- Credited window = `[settled_at, min(now, last_seen_at + OFFLINE_CAP_SECONDS)]`, server clock only. Later time earns nothing and is reported as `cappedMs`. `settled_at` then moves to `now`.
- Client contact (start, settle, stop) moves `last_seen_at` to `now` after settling. While the client keeps settling, nothing is capped. A player who is away earns at most 3 h (`OFFLINE_CAP_SECONDS`, default 10800) however many scheduled settlements happen.
- **Active vs offline (Phase 1 rule):** the reward rate is the same. Active play is "more efficient" only because it never hits the cap. Active-only bonuses come with later activities (GDD §9.2).
- `unusedMs` (an unfinished cycle at the window end) is stored as `carry_ms` and added to the next window. No time is lost or awarded twice.

## Settlement (`settleFarming`, game-core)
- Inputs: class, level, xp, health, equipped items, area, server seed, window (incl. carry), inventory count. No client input reaches it.
- Combat: one `simulateFarmingAggregate` over the whole window with **per-cycle RNG**: cycle `i` (global index, `activities.cycle_index` + position) draws from `${seed}:${i}`.
- Loot: one `rollLoot` per kill, RNG `${seed}:loot:${i}` for the kill's cycle. The source level is the character's level at the start of that cycle, clamped to the area's enemy levels.
- **Splitting a window changes nothing (ticket 1.9).** The unfinished cycle at the window end is not applied; its time is carried and the next settlement replays it with the same streams and the same starting state. Settling every second gives exactly what one settlement at the end gives (game-core tests pin this). Before ticket 1.9, each settlement re-rolled the unfinished cycle, so settle spam avoided deaths and long fights (≈ +20 % kills).
- **Equipment → stats:** `itemContribution` / `equipmentModifiers` sum implicit stats and affixes. Core stats go to `deriveCharacterStats`. **Gold find is summed, then capped** at `modifierCaps.goldFind` (default +100 %) before `rollLoot` (GDD §6.2).
- **Seed:** `seed_secret` (128 random bits, never sent to clients) plus `cycle_index`. Same secret, index, state and window give the same result (tests pin this). `settlement_seq` is kept for the audit log only.

## Inventory capacity
`inventory.capacity` (default 60 unequipped items). Drops beyond the free space are **auto-salvaged to gold**: `round((2 + 0.5 · itemLevel) · rarity)`, rarity × 1/2/4/8/16/32 from common to mythic. The summary reports `itemsSalvaged` and `goldSalvaged`. All values are in `DEFAULT_ACTIVITY_CONFIG`.

## Concurrency and idempotency
Each settlement runs in one transaction. It locks the `characters` row (`SELECT … FOR NO KEY UPDATE`), then the `activities` row (`FOR UPDATE`). Start also locks the `accounts` row first; inventory changes lock the character, then settle. Account and character locks use `FOR NO KEY UPDATE` (ticket 1.9): it serialises these transactions just like `FOR UPDATE`, but does not conflict with the `FOR KEY SHARE` locks that foreign-key checks take when an audit, activity or item row is inserted, which deadlocked start (account → character) against stop/settle (character → account). These races are tested against a real PostgreSQL server with parallel transactions (`apps/server/src/concurrency.pg.test.ts`, ticket 1.9), not only on PGlite. A concurrent settle waits, then sees the moved `settled_at` and credits ~0, so a window is never credited twice. XP, level, gold (`gold = gold + n`), item rows, the activity row and the `activity.reward` audit entry commit together.

## Return summary
`activities.summary` accumulates every settlement since the client last collected it: settlements, simulated/capped ms, kills, deaths, XP, levels, gold (incl. salvaged), items gained (last 100 listed) and salvaged. `settle` returns it with `since`/`until` and starts a new one. Rewards are already granted when it is computed, so a lost response loses only the summary, never the loot.

## Open points
- Health persists between settlements and across stop/start; regeneration while stopped is not modelled.
- Accepted residual (ticket 1.9): a change of equipment or area re-simulates the unfinished cycle with the new stats/area (same RNG stream, different outcome). Players cannot see an unfinished cycle's outcome, so this is not a usable re-roll in Phase 1 (one area); revisit when more areas arrive.
- Item ids in the summary may refer to items discarded since (ticket 1.7).
- Per-settlement history beyond the audit log (an `offline_settlement` table) is deferred.
