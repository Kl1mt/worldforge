# Dungeons: the Nameless Crypt & the Gravewarden (ticket 2.5)

Server-authoritative dungeon runs (GDD §6.4, §11.2). Rules are pure functions in `packages/game-core/src/dungeon/`; data in `packages/game-core/src/world/dungeons.ts`; persistence and routes in `apps/server/src/dungeon/`; UI in `apps/web/src/screens/CryptScreen.tsx` (`#/crypt`, entered from the world map). Endpoints: `docs/API_CONVENTIONS.md`. Table: `dungeon_runs` (and 2.6's `idempotency_keys`) in `docs/DATA_MODEL.md`.

## A run
- **Shape (data):** 4 chambers of 2 enemies each (`cryptGhoul` 55 / `boneAcolyte` 45, level = hero level ± 1 clamped to the tier's range, 12–16 in tier I), then the Gravewarden (tier I: level 16). Tiers: below. A 20 s walk into every chamber and into the boss chamber (out-of-combat regeneration applies), `searchMs` (2 s) between the two enemies of a chamber.
- **Combat:** the deterministic attack-by-attack engine (`resolveDungeonFight`, same timeline rules as `resolveFightDetailed`). The hero starts at full health; XP is applied per kill and a level-up recomputes stats and heals, as in farming. Stats and gold find come from the **snapshot** of level, XP and equipped items taken at the start; gear changes during a run change nothing.
- **Boss mechanic — enrage timer:** the Gravewarden enrages: ×1.8 damage and ×1.4 attack speed (ticket B.1). Since ticket 3.6 the moment is **drawn per run between 30 and 70 s** into the fight (whole seconds; it was fixed at 45 s), so a hero who needs about as long as the window's middle wins some runs and loses others (see "Tiers and balance"). The boss fight is lost after 150 s. Before the enrage its blows are bearable; after it, an under-geared hero falls within seconds, so the fight is a race against the enrage: a geared level-15 hero wins it with a third or more of its health gone. The run result carries `enrageAtMs`; the log shows the enrage when it happens (never earlier).
- **End:** a death or timeout ends the run as `failed`; killing the boss `cleared`. A real run takes ~2.5–3 min (it is an active-play goal).
- **Failure** keeps the XP, gold and items of the kills before it, drops nothing from the boss and never removes progress.

## Determinism and invariance
- The run is **fully decided at the start** by `dungeon_runs.seed_secret` (128 random bits, server-only) and the snapshot. Per-encounter RNG streams (like farming's per-cycle streams, `docs/FARMING.md`): chamber `r` enemy `k` draws its encounter and fight from `${seed}:room:${r}:${k}` and its loot from `${seed}:loot:${r}:${k}`; the boss fight from `${seed}:boss`, its loot from `${seed}:boss-loot`, and (ticket 3.6) the enrage moment from `${seed}:boss-enrage`, so it never shifts another draw. The tier is part of the run row (`dungeon_runs.tier`) and of the replay input.
- The server stores no run progress. Every view replays the run (`simulateDungeonRun`) and reveals it up to the elapsed server time (`dungeonRunProgress`): events with `t ≤ elapsed`, the cleared chambers, health, the current foe, the enrage. The outcome stays `null` until the end. So settling every second, every minute or never gives the same run and the same claim (tests: `dungeonRunProgress … invariance` in game-core; `settling often or never gives the same claimed result` on the server compares the stored rows of two runs with the same seed).
- Accepted: `endsAt` is part of the view, so a client could guess from an early end that the hero falls. A run cannot be abandoned or re-rolled, so there is nothing to gain.

## Rewards and the boss-loot cooldown
- Chamber kills roll the `namelessCrypt` loot table (gold + 18 % item chance) with the enemy's level as source level. No gathering in the crypt.
- **Boss loot** (when the boss dies and loot is off cooldown): 1 `gravewardenSeal`, 120–180 gold (× gold find) and 2 items from the `gravewarden` table — tier-3 bases plus three **boss-exclusive bases** (`gravewardens-cowl`, `seal-of-the-nameless`, `wardens-bone-chain`; `unique: true`, skipped by area tables, each with its own icon since A.5) — with boosted rarity weights (no commons; uncommon 3000, rare 3500, epic 1800, legendary 250, mythic 20). Since 3.2 a Legendary carries an effect and a Mythic roll is a named Mythic (the hoard is a Mythic source; `docs/EFFECTS.md`).
- **Cooldown:** boss loot drops at most once per 20 h per character, counted from the start of the run that granted it. Since ticket 3.6 the cooldown is **shared by every tier** (`DungeonDefinition.bossLootCooldownHours`): the player chooses which tier's hoard (and loot focus) to take. Eligibility is decided at the run's start (`boss_loot_eligible`), so the run stays fixed. On cooldown the boss can still be fought: its XP and the kill (`gravewardenDefeated`, the quest event) count.
- The loot filter (ticket 3.7, `docs/LOOT.md`) and inventory capacity apply at the claim like in farming, for every tier: the rules in force at the claim (read under the character lock) sell or salvage handled drops, and drops beyond free space are salvaged to gold, except Legendary, Mythic, set and Void drops, which are kept beyond the capacity (ticket B.2, `docs/FARMING.md`). The run itself (and what drops) never depends on them.
- Defeating the Gravewarden sets `characters.progress.gravewardenDefeated` (the Sunken Abbey's boss gate) and, since ticket 3.6, `cryptTierCleared` = max(stored, the run's tier) (the next tier's gate; the claim result says `firstTierClear`).

## Quest events (ticket 2.4)
A boss kill emits the ticket 2.4 `QuestEvent` `{ type: 'bossDefeated', bossId: 'gravewarden' }` (game-core `quests/events.ts`): in `DungeonRunResult.questEvents`, in the claim response (`result.questEvents`) and in the `dungeon.claim` audit entry. The claim calls `recordQuestEventsTx` with these events inside its transaction, after locking the character row, so the story's last step ("defeat the Gravewarden", `docs/QUESTS.md`) completes with the claim, exactly once. Only quests accepted at or before the run's start count them (ticket 2.8): accepting the step after a won run has ended, but before claiming it, does not complete it. Chamber kills emit no `enemyKilled` events yet (quests count farming kills only).

## Lifecycle and exclusivity
- **Start** (`POST …/dungeon`, body `{ dungeonId, tier? }`, tier 1–3, default 1): the account's active character only, the tier must be unlocked (tier I: level 12; deeper tiers: below; `409 dungeon_locked` with the tier's blockers, `400` for an unknown tier). Locks account → character (same order as the farming start). **Every farming activity of the account is settled and stopped first** (`activity.stop` with `reason: dungeon_started`). One unclaimed run per **account** (partial unique index `dungeon_runs_account_open_key`), so a run never stacks with farming of the same or another hero.
- **While a run is unclaimed**, `POST …/activity` answers `409 in_dungeon` for every character of the account.
- **Settle** (`POST …/dungeon/settle`) and `GET …/dungeon`: read-only reveal (nothing to write: the run is fixed).
- **Claim** (`POST …/dungeon/claim`, `Idempotency-Key` required, via ticket 2.6's `idempotentTransaction`; the web client uses one key per run, `claim-<runId>`, since a run is claimed once): only once `now ≥ ends_at` (`409 run_in_progress` before). Locks the character, then the run row; grants XP, gold, items (`source: dungeon:namelessCrypt`), materials and progress, sets `claimed_at`, `outcome`, `boss_loot_granted`, `result`, and writes `dungeon.claim`, all in one transaction. Granted once by state (`claimed_at`); a retry with the same key replays the stored response; another key gets `409 no_dungeon_run`. Real-Postgres races (`concurrency.pg.test.ts`): parallel claims with different keys and with one key grant once; racing dungeon and farming starts never leave a run and an activity together.

## Balance (ticket B.1)
The Gravewarden has 880 + 176/level health (3,520 at level 16) and 4 + 0.86/level damage, so the fight lasts 40–60 s and the enrage decides it; XP 600 + 160/level (3,000 at 16), so a run (~3.3 min) pays 1–2 × the XP of farming for the same time. Win rates (20 seeds; common kit at level − 1 unless noted; warrior / mage / hunter / warlock): level 12 0 / 0 / 0 / 0 %, level 13 0 / 0 / ≤ 20 / 0 %, level 14 100 / 30 / 100 / 50 %, level 15 100 % for all, uncommon kit at level 12 and above 100 %; naked heroes never win. (These are with the enrage fixed at 45 s; ticket 3.6 replaced the cliff with a curve, "Tiers and balance" below.) Before B.1 the fight ended after 20–27 s, before the 60 s enrage (a pure damage race): common gear lost every run at 12 and won every run at 14; at 15 the mage won 0 % and the warlock 15 %. The chamber enemies hit harder too (ghoul × 1.9, acolyte × 1.3), but the 20 s walk between chambers heals fully, so chambers rarely kill a geared hero. Targets are asserted in `packages/game-core/src/balance/balance.test.ts`; numbers live in `DUNGEONS` (`world/dungeons.ts`) and the enemy definitions.

## Effects in runs (ticket 3.2)
Equipped effects are part of the run snapshot and act in every fight (thorns and life-on-kill appear in the log as `thorns` / `heal` events). A Bloodrush streak starts at 0 each run and fades by one stack per 10 s walk. How each effect moved the level-12 entry cliff before 3.6: `docs/EFFECTS.md`; since 3.6 see "Tiers and balance".

## Tiers and balance (ticket 3.6)
Every tier reuses the crypt's rooms, enemies, boss, art and rules; a tier is data (`DungeonDefinition.tiers`, `getDungeonTier`): level range, boss level and stat scale, enrage window, chamber and boss loot tables (which carry the loot focus) and the unlock.

| Tier | Unlock | Chambers | Gravewarden | Boss loot (rarity weights U/R/E/L/M · gold) | Loot focus |
|---|---|---|---|---|---|
| I | level 12 | 12–16 | level 16 | 3000/3500/1800/250/20 · 120–180 | rings and amulets × 3 (`slots`) |
| II | level 18 + tier I cleared | 18–21 | level 21, health × 1.8, damage × 1.3 | 2000/3500/2400/350/30 · 260–380 | the Drowned Vigil (`sets`) |
| III | level 21 + tier II cleared | 21–24 | level 24, health × 2.4, damage × 1.5 | 1000/3500/3000/500/45 · 420–600 | the Ashen Choir (`sets`) + Tyrant's Bane and Headsman's Due × 4 (`effects`) |

All tiers: enrage window 30–70 s, × 1.8 damage and × 1.4 attack speed, 150 s limit, 2 boss items, one Gravewarden Seal. A Gravewarden kill of a character from before 3.6 counts as tier I cleared (`cryptTierCleared(progress)`), so nobody has to clear tier I again. The state (`GET …/dungeon`) lists every tier with `unlocked`, `blockers` (`{ kind: 'cryptTier', tier }` for the gate), levels and `lootFocus`, and the deepest `tierCleared`. Items from every tier keep the source `dungeon:namelessCrypt`; the audit entries (`dungeon.start`, `dungeon.claim`, `activity.stop`) carry the tier.

**The cliff, and the decision (resolved here for tier I, not left to B.2).** With the enrage fixed at 45 s the boss fight was a pure damage threshold: the per-fight randomness (≈ 5 % crits over ~50 attacks) is tiny, so a given kit won either (almost) every seed or none. Hero level hardly moves it (a level-12 and a level-15 hero in commons need 66 s and 54 s against the same level-16 boss), gear does. So every power source moved the entry from 0 % straight to 100 % (Tyrant's Bane, 4 Vigil pieces, +7 upgrades). **Decision:** draw the enrage moment per run from a 30–70 s window and keep every stat. A kit's chance is now roughly the share of the window in which it finishes the boss (plus what it survives after the enrage): a curve over gear and level instead of a step. Nothing else in tier I changed (checked: with the enrage pinned back to 45 s every pinned pre-3.2 crypt hash in `noEffects.test.ts` is reproduced exactly). B.1's targets "geared level 12 never wins" became "a small chance", "geared 15 ≥ 90 %" stays. The Phase 2 note (farmed gear makes the crypt easier than its target) is answered by the curve: farmed gear *should* raise the odds; only best-in-slot makes a level-12 entry certain.

Win rates (warrior / mage / hunter / warlock; `kit` as in `balance.test.ts`: one item per slot, the class's best bases, item level = hero level − 1 unless noted; tier I 64 seeds, II and III 32):

| Tier I (boss 16) | before 3.6 | 3.6 |
|---|---|---|
| level 12, commons | 0 / 0 / 0 / 0 % | 25 / 11 / 42 / 13 % |
| level 12, commons +3 · +5 · +7 | ≤ 25 % · hunter 63 % · 63–100 % | 45/34/56/28 · 53/45/58/41 · 58/59/66/55 % |
| level 12, uncommons (item level 12) | 100 % | 70 / 80 / 61 / 50 % |
| level 12, commons + Tyrant's Bane | 100 / 13 / 100 / 19 % | 61 / 53 / 64 / 52 % |
| level 12, rares (item level 12) | 100 % | 100 % |
| level 12, full Vigil or Legendaries (item level 14) | 100 % | 100 % |
| level 13 · 14 · 15, commons | 0–≤ 20 % · 30–100 % · 100 % | 52/44/58/41 · 70/55/75/56 · 95/100/100/95 % |
| level 16, naked | 0 % | 0 % |

| Tier II (entry 18, boss 21) | | Tier III (entry 21, boss 24) | |
|---|---|---|---|
| commons (+0 or +5) | 0 % | commons, rares | 0 % |
| rares | 63 / 3 / 56 / 44 % | rares +5 | 44 / 0 / 16 / 0 % |
| rares +5 | 100 / 50 / 100 / 84 % | epics | 13 / 0 / 13 / 31 % |
| epics | 53 / 100 / 100 / 59 % | epics +5 | 72 / 25 / 63 / 69 % |
| rares at level 20 | 72 / 59 / 100 / 75 % | rares at level 23 | 3 / 0 / 0 / 0 % |
| Legendaries, Vigil 6 or Choir 6 + Legendaries, Legendaries +10, Void +10 | 100 % | Legendaries | 100 / 94 / 100 / 100 % |
| naked at 21 | 0 % | Vigil 6 or Choir 6 + Legendaries, Legendaries +10, Void +10, Mythic + Legendaries | 100 % |

The spread between classes at one rarity comes from the generated kits' affix rolls (a rare kit is two random affixes per slot), so `balance.test.ts` asserts class means where a single kit decides it, and per-class bands where it doesn't. Tier II is where Abbey gear (rares, epics, upgrades) earns a real chance; tier III is the Legendary tier, where the Phase 3 power sources (Legendaries, Mythics, sets, +10, Void) make the run reliable but the boss still takes 18–60 s (the deeper boss is scaled because a level-for-level boss falls behind the hero: unscaled, commons won tier II and III every time). The best builds out-grow tier II (Void Legendaries +10 or a Mythic: 11–14 s), which is what tier III is for.

**Asserted per tier** (`balance.test.ts`, "the Nameless Crypt (tiers: ticket 3.6)"): tier I — naked 0 %; level-12 commons ≤ 50 % per class and 5–30 % on average; commons +5, uncommons and commons + Tyrant's Bane 25–90 % per class; every upgrade step and every level raises the mean; +7 commons stay < 90 %; geared 15, level-12 rares, the full Vigil and Legendaries ≥ 90–95 % per class; the boss still takes > 1.2 × the earliest enrage and a third of a geared-15 hero's health. Tier II — naked 0 %; commons +5 ≤ 10 %; rares 20–70 %; rares +5, epics and rares two levels on raise it but stay ≤ 95 %; every best-in-slot build ≥ 95 % per class. Tier III — naked and commons 0 %; rares ≤ 10 %; epics ≤ 40 % and below tier II's; epics +5 30–85 %; Legendaries ≥ 90 %, every other best-in-slot build ≥ 95 % per class. No build kills the tier II boss in under 0.35 × and the tier III boss in under 0.55 × the earliest enrage. A winning run pays 0.8–2.2 × the XP of farming the matching area for the same time, in every tier.

## Targeted loot (ticket 3.6)
Each tier declares a **loot focus** (`LootFocus` on its chamber and boss tables, `CRYPT_LOOT_FOCI`), shown at the crypt door, so the player can farm toward a build: a slot group (bases of those slots weigh × `slotWeight`), a set (a set-piece roll picks only that set's pieces) and/or an effect family (those Legendary effects weigh × `effectWeight`). A focus only reweights draws the generator makes anyway, so the same item seed rolls the same rarity, item level, set/Mythic outcome and Void flag with or without it (`loot/focus.test.ts`), and every drop stays deterministic per kill stream and split-invariant. Measured (warrior with a Legendary kit at each tier's level, boss loot eligible, 3,000 runs):

| | Tier I (15) | Tier II (21) | Tier III (23) |
|---|---|---|---|
| items per run | 3.55 | 3.64 | 3.44 |
| rings and amulets among them | 60 % (boss table: 45 % → 71 %; chambers: 20 % → 43 %) | 33 % | 34 % |
| set pieces per run | 0.034 (any set) | 0.044 (all Drowned Vigil) | 0.076 (all Ashen Choir) |
| Legendaries (not set) per run | 0.035 | 0.053 | 0.069 |
| Tyrant's Bane or Headsman's Due among Legendary effects | 28 % | 32 % | 51 % (unfocused: 28 %) |
| Mythics · Void items per run | 0.009 · 0.008 | 0.007 · 0.012 | 0.015 · 0.013 |

So a given Vigil piece drops about once per 140 tier II runs and a given Choir piece about once per 80 tier III runs (one boss hoard per 20 h; the chambers drop every run). Abbey contracts add a slot choice for a reward item (`docs/QUESTS.md`).

## UI (ticket 3.6)
The crypt door lists the depths as a choice (Tier I–III: levels, loot focus, or what bars it), defaulting to the deepest open tier; the facts follow the chosen tier (levels, boss level, the enrage window, the focus, the shared hoard). A run's panel names its tier; the reckoning names it and, on a first clear, the tier it opens. Screenshots: `docs/screenshots/phase-3/crypt-tiers-*`, `crypt-tier3-enraged-*`, `crypt-tier2-reckoning-*` (`node tools/screenshots/crypt-tiers.mjs`).
