# Dungeons: the Nameless Crypt & the Gravewarden (ticket 2.5)

Server-authoritative dungeon runs (GDD §6.4, §11.2). Rules are pure functions in `packages/game-core/src/dungeon/`; data in `packages/game-core/src/world/dungeons.ts`; persistence and routes in `apps/server/src/dungeon/`; UI in `apps/web/src/screens/CryptScreen.tsx` (`#/crypt`, entered from the world map). Endpoints: `docs/API_CONVENTIONS.md`. Table: `dungeon_runs` (and 2.6's `idempotency_keys`) in `docs/DATA_MODEL.md`.

## A run
- **Shape (data):** 4 chambers of 2 enemies each (`cryptGhoul` 55 / `boneAcolyte` 45, level = hero level ± 1 clamped to 12–16), then the Gravewarden (level 16). A 20 s walk into every chamber and into the boss chamber (out-of-combat regeneration applies), `searchMs` (2 s) between the two enemies of a chamber.
- **Combat:** the deterministic attack-by-attack engine (`resolveDungeonFight`, same timeline rules as `resolveFightDetailed`). The hero starts at full health; XP is applied per kill and a level-up recomputes stats and heals, as in farming. Stats and gold find come from the **snapshot** of level, XP and equipped items taken at the start; gear changes during a run change nothing.
- **Boss mechanic — enrage timer:** 60 s into the fight the Gravewarden enrages: ×2 damage and ×1.5 attack speed. The boss fight is lost after 150 s. Under-geared heroes die soon after the enrage; a geared level-14+ hero kills it before.
- **End:** a death or timeout ends the run as `failed`; killing the boss `cleared`. A real run takes ~2.5–3 min (it is an active-play goal).
- **Failure** keeps the XP, gold and items of the kills before it, drops nothing from the boss and never removes progress.

## Determinism and invariance
- The run is **fully decided at the start** by `dungeon_runs.seed_secret` (128 random bits, server-only) and the snapshot. Per-encounter RNG streams (like farming's per-cycle streams, `docs/FARMING.md`): chamber `r` enemy `k` draws its encounter and fight from `${seed}:room:${r}:${k}` and its loot from `${seed}:loot:${r}:${k}`; the boss fight from `${seed}:boss`, its loot from `${seed}:boss-loot`.
- The server stores no run progress. Every view replays the run (`simulateDungeonRun`) and reveals it up to the elapsed server time (`dungeonRunProgress`): events with `t ≤ elapsed`, the cleared chambers, health, the current foe, the enrage. The outcome stays `null` until the end. So settling every second, every minute or never gives the same run and the same claim (tests: `dungeonRunProgress … invariance` in game-core; `settling often or never gives the same claimed result` on the server compares the stored rows of two runs with the same seed).
- Accepted: `endsAt` is part of the view, so a client could guess from an early end that the hero falls. A run cannot be abandoned or re-rolled, so there is nothing to gain.

## Rewards and the boss-loot cooldown
- Chamber kills roll the `namelessCrypt` loot table (gold + 18 % item chance) with the enemy's level as source level. No gathering in the crypt.
- **Boss loot** (when the boss dies and loot is off cooldown): 1 `gravewardenSeal`, 60–90 gold (× gold find) and 2 items from the `gravewarden` table — tier-3 bases plus three **boss-exclusive bases** (`gravewardens-cowl`, `seal-of-the-nameless`, `wardens-bone-chain`; `unique: true`, skipped by area tables, borrowing existing icons until they get art) — with boosted rarity weights (no commons; uncommon 3000, rare 3500, epic 1800, legendary 250, mythic 20). Unique *effects* are Phase 3.
- **Cooldown:** boss loot drops at most once per 20 h per character, counted from the start of the run that granted it. Eligibility is decided at the run's start (`boss_loot_eligible`), so the run stays fixed. On cooldown the boss can still be fought: its XP and the kill (`gravewardenDefeated`, the quest event) count.
- Inventory capacity applies at the claim like in farming: drops beyond free space are salvaged to gold.
- Defeating the Gravewarden sets `characters.progress.gravewardenDefeated` (the Sunken Abbey's boss gate).

## Quest events (for ticket 2.4)
`packages/game-core/src/events.ts` defines `GameEvent` (for now `{ type: 'bossDefeated', bossId: EnemyId }`). A boss kill emits `{ type: 'bossDefeated', bossId: 'gravewarden' }`: in `DungeonRunResult.questEvents`, in the claim response (`result.questEvents`) and in the `dungeon.claim` audit entry. Ticket 2.4 can consume them in the claim transaction (`apps/server/src/dungeon/routes.ts`, where the result is granted) and merge `GameEvent` into its quest event type.

## Lifecycle and exclusivity
- **Start** (`POST …/dungeon`): the account's active character only, the dungeon must be unlocked (level 12). Locks account → character (same order as the farming start). **Every farming activity of the account is settled and stopped first** (`activity.stop` with `reason: dungeon_started`). One unclaimed run per **account** (partial unique index `dungeon_runs_account_open_key`), so a run never stacks with farming of the same or another hero.
- **While a run is unclaimed**, `POST …/activity` answers `409 in_dungeon` for every character of the account.
- **Settle** (`POST …/dungeon/settle`) and `GET …/dungeon`: read-only reveal (nothing to write: the run is fixed).
- **Claim** (`POST …/dungeon/claim`, `Idempotency-Key` required, via ticket 2.6's `idempotentTransaction`; the web client uses one key per run, `claim-<runId>`, since a run is claimed once): only once `now ≥ ends_at` (`409 run_in_progress` before). Locks the character, then the run row; grants XP, gold, items (`source: dungeon:namelessCrypt`), materials and progress, sets `claimed_at`, `outcome`, `boss_loot_granted`, `result`, and writes `dungeon.claim`, all in one transaction. Granted once by state (`claimed_at`); a retry with the same key replays the stored response; another key gets `409 no_dungeon_run`. Real-Postgres races (`concurrency.pg.test.ts`): parallel claims with different keys and with one key grant once; racing dungeon and farming starts never leave a run and an activity together.

## Balance (first pass; B.1 tunes)
Simulated, 200 seeds each, with one item per slot at the hero's level: naked heroes never beat the boss (all clear the chambers); common tier-3 gear wins at level 16 for every class and at 14 for warriors and hunters; uncommon gear at 14 wins 72–100 %. Numbers live in `DUNGEONS` (`world/dungeons.ts`) and the Gravewarden enemy definition.
