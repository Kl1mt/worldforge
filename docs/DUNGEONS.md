# Dungeons: the Nameless Crypt & the Gravewarden (ticket 2.5)

Server-authoritative dungeon runs (GDD §6.4, §11.2). Rules are pure functions in `packages/game-core/src/dungeon/`; data in `packages/game-core/src/world/dungeons.ts`; persistence and routes in `apps/server/src/dungeon/`; UI in `apps/web/src/screens/CryptScreen.tsx` (`#/crypt`, entered from the world map; since ticket 4.8 the same screen, `DungeonScreen`, also shows the Warden's Watch at `#/watch`, with its words in `apps/web/src/content/dungeons.ts`). Endpoints: `docs/API_CONVENTIONS.md`. Table: `dungeon_runs` (and 2.6's `idempotency_keys`) in `docs/DATA_MODEL.md`.

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
- **Start** (`POST …/dungeon`, body `{ dungeonId, tier? }`, tier 1–4 since 6.3 (1–3 before), default 1): the account's active character only, the tier must be unlocked (tier I: level 12; deeper tiers: below; `409 dungeon_locked` with the tier's blockers, `400` for an unknown tier). Locks account → character (same order as the farming start). **Every farming activity of the account is settled and stopped first** (`activity.stop` with `reason: dungeon_started`). One unclaimed run per **account** (partial unique index `dungeon_runs_account_open_key`), so a run never stacks with farming of the same or another hero.
- **While a run is unclaimed**, `POST …/activity` answers `409 in_dungeon` for every character of the account.
- **Settle** (`POST …/dungeon/settle`) and `GET …/dungeon`: read-only reveal (nothing to write: the run is fixed).
- **Claim** (`POST …/dungeon/claim`, `Idempotency-Key` required, via ticket 2.6's `idempotentTransaction`; the web client uses one key per run, `claim-<runId>`, since a run is claimed once): only once `now ≥ ends_at` (`409 run_in_progress` before). Locks the character, then the run row; grants XP, gold, items (`source: dungeon:namelessCrypt`; ticket T.1: boss-hoard drops `hoard:namelessCrypt`, recognised by replaying the run without the hoard as the 3.8 telemetry does, and account-bound), materials and progress, sets `claimed_at`, `outcome`, `boss_loot_granted`, `result`, and writes `dungeon.claim`, all in one transaction. Granted once by state (`claimed_at`); a retry with the same key replays the stored response; another key gets `409 no_dungeon_run`. Real-Postgres races (`concurrency.pg.test.ts`): parallel claims with different keys and with one key grant once; racing dungeon and farming starts never leave a run and an activity together.

## Balance (ticket B.1)
The Gravewarden has 880 + 176/level health (3,520 at level 16) and 4 + 0.86/level damage, so the fight lasts 40–60 s and the enrage decides it; XP 600 + 160/level (3,000 at 16), so a run (~3.3 min) pays 1–2 × the XP of farming for the same time. Win rates (20 seeds; common kit at level − 1 unless noted; warrior / mage / hunter / warlock): level 12 0 / 0 / 0 / 0 %, level 13 0 / 0 / ≤ 20 / 0 %, level 14 100 / 30 / 100 / 50 %, level 15 100 % for all, uncommon kit at level 12 and above 100 %; naked heroes never win. (These are with the enrage fixed at 45 s; ticket 3.6 replaced the cliff with a curve, "Tiers and balance" below.) Before B.1 the fight ended after 20–27 s, before the 60 s enrage (a pure damage race): common gear lost every run at 12 and won every run at 14; at 15 the mage won 0 % and the warlock 15 %. The chamber enemies hit harder too (ghoul × 1.9, acolyte × 1.3), but the 20 s walk between chambers heals fully, so chambers rarely kill a geared hero. Targets are asserted in `packages/game-core/src/balance/balance.test.ts`; numbers live in `DUNGEONS` (`world/dungeons.ts`) and the enemy definitions.

## Effects in runs (ticket 3.2)
Equipped effects are part of the run snapshot and act in every fight (thorns and life-on-kill appear in the log as `thorns` / `heal` events). A Bloodrush streak starts at 0 each run and fades by one stack per 10 s walk. How each effect moved the level-12 entry cliff before 3.6: `docs/EFFECTS.md`; since 3.6 see "Tiers and balance".

## Tiers and balance (ticket 3.6)
Every tier reuses the crypt's rooms, enemies, boss, art and rules; a tier is data (`DungeonDefinition.tiers`, `getDungeonTier`): level range, boss level and stat scale, enrage window, chamber and boss loot tables (which carry the loot focus) and the unlock.

| Tier | Unlock | Chambers | Gravewarden | Boss loot (rarity weights U/R/E/L/M · gold) | Loot focus |
|---|---|---|---|---|---|
| I | level 12 | 12–16 | level 16 | 3000/3500/1800/250/20 · 120–180 | rings and amulets × 3 (`slots`) |
| II | level 18 + tier I cleared | 18–21 | level 21, health × 1.8, damage × 1.3, resistance × 0.5 (B.2) | 2000/3500/2400/350/30 · 260–380 | the Drowned Vigil (`sets`) |
| III | level 21 + tier II cleared | 21–24 | level 24, health × 2.4, damage × 2.4 (4.8; was × 1.5), resistance × 0.5 (B.2) | 1000/3500/3000/500/45 · 420–600 | the Ashen Choir (`sets`) + Tyrant's Bane and Headsman's Due × 4 (`effects`) |
| IV, Heroic (6.3) | level 32 + tier III cleared | 32–36, foes health and damage × 1.6 | level 36, health × 3.4, damage × 2.6, resistance × 0.5, every 4th blow × 3; enrage 30–60 s, × 2 | 0/2500/3500/1100/110 · 1,000–1,500 | *Heroic spoils*: better top-rarity odds (below) |

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

**Asserted per tier** (`balance.test.ts`, "the Nameless Crypt (tiers: ticket 3.6)"): tier I — naked 0 %; level-12 commons ≤ 50 % per class and 5–30 % on average; commons +5, uncommons and commons + Tyrant's Bane 25–90 % per class; every upgrade step and every level raises the mean; +7 commons stay < 90 %; geared 15, level-12 rares, the full Vigil and Legendaries ≥ 90–95 % per class; the boss still takes > 1.2 × the earliest enrage and a third of a geared-15 hero's health. Tier II — naked 0 %; commons +5 ≤ 10 %; rares 20–70 %; rares +5, epics and rares two levels on raise it but stay ≤ 95 %; every best-in-slot build ≥ 95 % per class. Tier III (since 4.8) — naked and commons 0 %; rares and rares +5 ≤ 10 %; epics ≤ 40 % and below tier II's; epics +5 5–35 %, +8 30–75 % and more than +5; epics +8 two levels on > 70 %; Legendaries ≥ 70 % at the entry and ≥ 95 % two levels on; every other best-in-slot build ≥ 95 % per class. No build kills the tier II boss in under 0.35 × and the tier III boss in under 0.55 × the earliest enrage. A winning run pays 0.8–2.2 × the XP of farming the matching area for the same time, in every tier.

### Farmed gear (ticket B.2)
The tables above use generated kits. B.2 measured the tiers against **farmed** gear instead: a hero farms the matching area for 10 or 30 hours (the real settlement), wears the best drop per slot (by item level, rarity and affix count) and upgrades it to +0 or +5 (cheap at these item levels). 12 seeds per cell, warrior / mage / hunter / warlock, before → after B.2 (`tools/balance/crypt-farmed.ts`):

| Tier · level (farmed in) | 10 h, +0 | 10 h, +5 | 30 h, +0 | 30 h, +5 |
|---|---|---|---|---|
| I · 12 (Burial Grounds) | 75/83/92/100 → same | 100 % → same | 100 % | 100 % |
| II · 18 (Abbey) | 67/50/42/42 → 67/58/42/42 | 83/67/92/58 → 83/83/92/83 | 92/58/100/42 → 100/92/100/83 | 100/92/100/83 → 100/100/100/92 |
| II · 20 | 83/75/75/67 → 92/83/83/92 | 100/92/100/92 → 100 % | 100 % | 100 % |
| III · 21 (Abbey) | 0 % → same | 8/8/8/0 → 8/8/8/17 | 17/8/33/17 → 17/25/42/42 | 67/33/67/58 → 67/75/67/83 |
| III · 22 | 0/0/8/0 → 0/8/8/0 | 17/17/17/0 → 17/42/17/25 | 42/25/58/25 → 50/58/58/50 | 75/58/83/58 → 75/83/83/83 |
| III · 23 | 17/8/25/0 → 25/17/25/25 | 67/33/50/25 → 75/42/50/42 | 50/33/83/67 → 50/58/83/83 | 92/67/100/100 → 92/92/100/100 |

**Reading and decisions.** Tiers II and III are curves over farming time and upgrades, as intended; only the casters were off: with farmed gear the mage and the warlock won about half as often as the warrior and the hunter in tier III (24 seeds at 22, 30 h + 5: 79 / 67 / 92 / 67 %; they died after the enrage, ~15 % slower to kill). **Fixed:** the tier II and III Gravewarden resists magic half as much (`EnemyScale.resistance` = 0.5, tier I unchanged): 79 / 79 / 92 / 83 % now. Tier I is a near-certain win for farmed gear even at its entry level 12 (75–100 % with 10 h of Burial Grounds gear, 100 % from +5). That is 3.6's decision ("farmed gear *should* raise the odds"), and tier I is the Phase 2 gate a player has already passed, so it stays.

### Tier III against upgraded gear (ticket 4.8)
3.9's exit runs saw tier III fall on the first attempt at its entry level 21 for every hero that spent its gold on upgrades: B.2 measured farmed gear at +0 and +5, but by 21 a realistic hero wears its Abbey drops at +5 to +8. **Changed:** the tier III Gravewarden's damage × 1.5 → × 2.4 (health, enrage window, level, loot: unchanged). The enrage phase decides it now: a kit that needs past the enrage (≥ 30 s) to kill the boss has to survive a much harder last stretch, while builds that kill it before the earliest enrage (Legendary kits, every best-in-slot build: 10–30 s) are untouched. Tiers I and II, and every other number, are bit-identical to before (checked: hashes of Graumark settlements, tier I/II runs, loot rolls and merchant stock against `main`, `tools/balance` scratch check in the PR).

Generated kits (`balance.test.ts` kits, 32 runs per class, warrior / mage / hunter / warlock, class mean in brackets), before → after:

| Level 21 (entry) | before | after |
|---|---|---|
| rares +5 | 38/19/44/19 (30) | 0 % |
| rares +8 | 69/53/72/53 (62) | 16/0/0/0 (4) |
| epics | 13/9/9/72 (26) | 0 % |
| epics +5 | 69/59/63/100 (73) | 0/0/3/59 (16) |
| epics +8 | 100 % | 28/31/38/81 (45) |
| Legendaries | 100 % | 100/34/100/100 (84) |
| Legendaries +5 · +10 | 100 % · 100 % | 100/69/100/100 (92) · 100 % |

| Level 23 | before | after |
|---|---|---|
| epics +5 | 100 % | 31/56/69/25 (45) |
| epics +8 | 100 % | 63/91/100/53 (77) |
| rares +8 | 100/91/81/47 (80) | 25/19/16/0 (15) |
| Legendaries (any) | 100 % | 100 % |

Farmed gear (`tools/balance/crypt-farmed.ts`, Abbey drops, 12 seeds), before → after:

| Tier III at | 30 h, +0 | 30 h, +5 | 30 h, +8 | 10 h, +8 |
|---|---|---|---|---|
| 21 | 17/25/42/42 → 0/8/0/25 | 67/75/67/83 → 8/25/33/33 | 92/75/83/83 → 33/33/50/42 | 50/25/33/50 → 8/8/0/0 |
| 22 | 50/58/58/50 → 25/25/25/25 | 75/83/83/83 → 33/33/50/42 | 92/100/100/100 → 67/67/58/58 | 75/58/58/58 → 8/25/8/8 |
| 23 | 50/58/83/83 → 8/17/25/58 | 92/92/100/100 → 42/58/67/67 | 100 % → 58/75/83/92 | 83/83/83/67 → 50/17/33/25 |

**The exit runs** (`phase3-exit-criteria.test.ts`, one run per class, after 4.8): the warrior, mage and hunter still won tier III at 21 on the first attempt; the warlock lost at 21 and 22 and won at 23. Those heroes wear mostly Legendaries and set pieces at +3 to +6 by 21 (contracts, crypt hoards and Abbey drops: e.g. the warrior's kit was 5 Legendary/set pieces +5–6 and 3 epics +5), which is the Legendary tier's job: 3.6 made tier III the tier where Legendaries make the run reliable. Making those kits uncertain at 21 would need ~1.5 × boss health, which would also slow every best-in-slot build by half and break B.2's build diversity (the Ashen Choir's rot grows with fight length). B.3 may revisit it with playtest data. B.2's build search on the tier III boss is unchanged except the warlock (best 11.6 s, 5 builds within 7 % → 11.4 s, 4 builds).

### Tier III is the Legendary tier (ticket B.3: decided)
4.8's exit runs still saw 3 of 4 heroes beat tier III on the first try at 21, wearing 5+ Legendary or set pieces at +3 to +6. B.3 looked for a lever that makes those kits uncertain without the ~1.5 × boss health 4.8 rejected. The B.2 build search, every one of its 48 layouts per class (sets, Legendaries, affix packages) worn at the entry (`tools/balance/top-end.ts tier3`, 16 runs each):

| Level 21, +0 · +3 · +6 | fastest build | middle build | slowest build (`guard` package) |
| --- | --- | --- | --- |
| warrior | 100 % in 14 · 13 · 13 s | 100 % in 18 · 18 · 17 s | 100 % in 27 · 25 · 25 s |
| mage | 100 % in 13 · 12 · 11 s | 100 % in 19 · 18 · 17 s | 100 % in 27 · 26 · 25 s |
| hunter | 100 % in 12 · 12 · 11 s | 100 % in 16 · 15 · 14 s | 100 % in 26 · 25 · 23 s |
| warlock | 100 % in 14 · 13 · 13 s | 100 % in 20 · 19 · 18 s | 100 % in 28 · 27 · 26 s |

Every all-Legendary/set build kills the boss before the earliest enrage (30 s), so the enrage lever 4.8 used cannot touch them, and an earlier enrage would only reach the slowest builds (the defensive ones) while leaving the crit builds untouched: it would pick a winner. Making them uncertain at 21 needs the boss to survive past 30 s against the 11–14 s builds, i.e. roughly 2.5 × health, which halves the speed of every best-in-slot build at the boss and breaks B.2's build diversity (the Ashen Choir's rot grows with fight length; 4.8 measured it at 1.5 ×). **Decision: accepted, no change.** Tier III is where Legendaries and sets make the run reliable (3.6's design); what it gates is *having* such a kit, and the gear below it is uncertain there as intended (upgraded epics 16–45 % at 21, farmed Abbey gear at +8 33–50 %, 4.8's tables). The lever, if the owner's playtests want tier III harder for Legendary kits, is the supply of Legendaries before 21 (Abbey contracts' targeted rewards, crypt hoards), not the boss. Nothing in this section changes any number.

**Owner decision (2026-11-07, recorded in F.1):** tier III stays the Legendary tier: Legendary and set kits win it at 21, epic kits find it a wall. It is not made harder. A harder crypt mode (a tier IV or heroic crypt, tuned for upgraded Legendary kits) comes later, as part of the content above level 28 (ROADMAP "Phase 4 follow-ups", GDD §17). No numbers changed.

**The Ashen Warden's material (decided: none).** The Warden's hoard stays items and gold. A boss material needs a sink to mean anything: the Gravewarden's seal has one (the Ashen Pass project); nothing is planned to use a Warden material before Item Awakening (GDD §8.2, optional) or trading (`TRADING.md`), it would need a new icon (an art ticket), and the Pass already feeds the upgrade track (iron ore, soul shards). Add it with the first content that consumes it.

## The Warden's Watch (ticket 4.8)

*Ticket 6.1:* slaying the Ashen Warden (`progress.ashenWardenDefeated`) opens the Cinderwastes' first area, the Ashfall Verge, at level 28 (`docs/WORLD.md`); *ticket 6.2:* its second, the Cinder Depths, at 34, and the Tyrant's Forge at 36.
The Ashen Pass's boss (`docs/WORLD.md` "The Ashen Pass"), fought like the Gravewarden in a dungeon run, but **boss-only**: no chambers, a 30 s climb, then the Ashen Warden. Same engine and rules as the crypt (`simulateDungeonRun`: snapshot, server-only seed streams, enrage window, claim with `Idempotency-Key`, one unclaimed run per account across both dungeons, the farming stopped while it runs). Data: `DUNGEONS` entry `ashenWatch` (one tier), enemy `ashenWarden`. Screen: `#/watch` (the map marker beside the Pass, and a link in the Pass's description).

- **Gate:** level 26, the Gravewarden slain, and the world flag `ashenPassCleared` (`409 dungeon_locked` with the blockers otherwise). A tier other than 1 is `400 validation_failed` ("Choose one of: 1.").
- **The boss:** level 28, magic damage, 1,900 + 460 per level above 1 (14,320 health), enrage drawn per run between **25 and 55 s** for **× 2** damage and × 1.4 attack speed (harsher than the crypt's), 150 s limit. XP 600 + 105 per level above 1 (3,435): a winning run pays 0.8–2.2 × the XP of farming the Pass for the same time (asserted).
- **Hoard** (its own 20 h cooldown, separate from the crypt's, so a top hero takes both): 2 items from `ashenWarden` (tier-3 bases at item level 27–29, affix bias 1.4, the late-game Legendary/set/Mythic/Void odds) with rarity weights uncommon 500 / rare 3000 / epic 3500 / legendary 700 / mythic 60, and 700–1,000 gold. Loot focus *The Warden's armoury*: weapons and off-hands × 3. No boss material.
- **Progress:** a kill sets `characters.progress.ashenWardenDefeated` (nothing gates on it yet) and never touches the crypt's `gravewardenDefeated` / `cryptTierCleared`; the state's `tierCleared` for the Watch is 1 once he fell. Items carry the source `dungeon:ashenWatch`; telemetry dimensions `ashenWatch:1`. The boss kill emits the quest event `bossDefeated` with `bossId: 'ashenWarden'` (no quest uses it yet).

**Balance** (`balance.test.ts` "the Ashen Warden", `builds.test.ts`; generated kits at item level = level − 1, 24 runs per class, warrior / mage / hunter / warlock):

| Level 26 (entry) | Win rate | Asserted |
|---|---|---|
| rares +5, epics +5 | 0 % | 0 % (the gear that farms the Pass does not beat its warden) |
| epics +10 | 0/4/38/0 % | mean ≤ 30 % |
| Legendaries | 71/83/100/71 % (boss down in 27–47 s) | mean 50–90 %, above epics +10, below tier III's at the same level |
| Legendaries +5 | 96/100/100/96 % | mean ≥ 90 % |
| Legendaries +10 | 100 % | — |
| at 28: every best-in-slot build (sets, Mythic, +10, Void +10) | ≥ 95 % on average, ≥ 85 % per class | as measured |

No best-in-slot build kills him in under 0.4 × the earliest enrage. The B.2 build search at level 28 (item level 27) finds several distinct builds within 7 % for every class with no set in all of them, and every class's best build needs longer than at the tier III Gravewarden (`builds.test.ts`). His health is set so that the best builds take about as long as at tier III: more health made the hunter's top builds all Ashen Choir (its rot grows with fight length), so the Watch is harder through its earlier, harsher enrage instead.

## The Tyrant's Forge (ticket 6.2)

The Cinderwastes' region boss (`docs/WORLD.md` "The Cinder Depths and the Tyrant's Forge"), fought like the Ashen Warden: a **boss-only** run, a 30 s descent, then the Forge Tyrant. Same engine and rules as the crypt and the Watch (`simulateDungeonRun`: snapshot, server-only seed streams, the enrage window drawn per run from its own stream, claim with `Idempotency-Key`, one unclaimed run per account across every dungeon, the farming stopped while it runs, replay of the stored run for every view). Data: `DUNGEONS` entry `tyrantsForge` (one tier, "The Forge"), enemy `forgeTyrant`. Screen: `#/tyrant` (the map marker beside the Depths, and a link in the Depths' description); `forge` stays the town's Forge.

- **Gate:** level 36 and the Ashen Warden slain (the Depths open), `409 dungeon_locked` with the blockers otherwise. No world flag yet (6.7's seam, as for the Depths).
- **The boss:** level 40, physical damage, 1,500 + 400 per level above 1 (17,100 health), enrage drawn per run between **35 and 65 s** for **× 2** damage and × 1.4 attack speed, 150 s limit. XP 900 + 150 per level above 1 (6,750): a winning run pays 0.8–2.5 × the XP of farming the Depths for the same time (asserted).
- **His mechanics** (`BossMechanics` on the tier, ticket 6.2; data, no random draws, so every seed stream and replay stays as it was, and no earlier boss has any):
  - **Slag shell:** while he holds more than 70 % of his health, the hero's blows (and thorns) deal × 0.6. It breaks once (a `shellBroken` event, a log line): a damage check before the enrage window opens.
  - **The hammer:** every third blow is a heavy one, × 4 (on top of the enrage; `enemyAttack` events carry `heavy: true`, a log line): a health check in every phase of the fight.
- **Hoard** (its own 20 h cooldown, separate from the crypt's and the Watch's): 2 items from `forgeTyrant` (tier-4 bases at item level 39–41, affix bias 1.4, the late-game Legendary/set/Mythic/Void odds) with the Watch's rarity weights (uncommon 500 / rare 3000 / epic 3500 / legendary 700 / mythic 60), 1,400–2,000 gold, and **one Tyrant's Ember** (`bossDrops`). Loot focus *The Tyrant's anvil*: helms, chest pieces, gloves and boots × 2. Hoard items are stored with the source `hoard:tyrantsForge`, so they are **always bound** (T.1, `docs/TRADING.md`), whatever their rarity; the ember is never tradeable (`UNTRADEABLE_MATERIALS`).
- **Progress:** a kill sets `characters.progress.forgeTyrantDefeated` (the dungeon's `bossProgress`; since 6.2 every dungeon names its flag and the claim reads it, so the crypt's and the Watch's are unchanged); it gates nothing yet and counts for PvE Progress 3. The state's `tierCleared` for the Forge is 1 once he fell. Telemetry dimensions `tyrantsForge:1`; quest event `bossDefeated` with `bossId: 'forgeTyrant'` (no quest uses it yet). The admin progress tool (D.4) sets and clears the flag on test accounts (`forgeTyrantDefeated`, optional in the request).

**Balance** (`balance.test.ts` "the Forge Tyrant"; balance.test's kits at item level 33, the Verge's drops, 24 pinned seeds per class; warrior / mage / hunter / warlock, mean):

| Gear (item level 33) | Level 36 | Level 37 | Level 38 | Level 40 | Asserted at 36 and 38 |
|---|---|---|---|---|---|
| rares +5, epics +5 | 0 % | 0 % | 0 % | 0 % | 0 % (the gear that farms the Verge) |
| epics +10 | 0 % | 0 % | 0/0/0/4 % (1 %) | 13/0/0/25 % | mean ≤ 15 % |
| Legendaries (with effects) | 50/0/88/0 % (34 %) | 35 % | 79/0/88/0 % (42 %) | 49 % | mean 20–60 %, above epics +10 |
| Legendaries +5 | 92/0/100/88 % (70 %) | 71 % | 71 % | 73 % | mean 55–90 %, above +0 |
| Legendaries +10 | 100/63/100/100 % (91 %) | 94 % | 100/79/100/100 % (95 %) | 97 % | mean ≥ 80 %, every class ≥ 50 % |
| plain Legendaries +10 (no effects) | 100/38/100/92 % (82 %) | 83 % | 88 % | 90 % | mean 60–95 % |
| at 40: every best-in-slot build in the Depths' drops (item level 39) | | | | ≥ 94 % per class | mean ≥ 95 %, each class ≥ 85 % |

So good Verge gear beats him at 36–38, not trivially: upgraded Verge Legendaries win most runs, plain ones a third to a half, and nothing short of Legendaries wins. The mage (cloth against his physical blows) is the weakest class here, the hunter the strongest (as at the Watch); B.5 owns class balance. No best-in-slot build kills him in under 0.4 × the earliest enrage, and his shell breaks before every kill. He is harder than the Ashen Warden for the same kind of kit at each boss's entry (asserted). Measured with `tools/balance/cinder-depths.ts boss` too: the B.2 build search's best builds at item level 33 win every run at +5 and at +10 Void from 36 to 40, in 18–25 s (the warrior, mage and warlock) and 12–15 s (the hunter's Drowned Vigil with Ambush, 9 s at the fastest: below 0.4 × the earliest enrage, as that build was at the Watch; class balance is B.5's).

**B.5 (the endgame balance pass, `docs/BALANCE.md` "B.5", item 2):** his slag turns blades more than spells: `bossScale` resistance × 0.7, armour × 1.2 (`EnemyScale.armor`, new and optional, default 1; health and damage × 1). Over 8 Legendary kits per class the casters had trailed (Legendaries +5 at 38: 92/57/88/82 %, spread 34 points); now 86/76/75/92 % (17), at 36 80/71/68/91 % (was 89/54/78/75 %). The table above is 6.2's single kit per class, whose rolled effects happen to be the mage's worst; its bands still hold. The hunter's best build still kills him in 13–15 s (fastest 11–12 s): an open point for the owner (`docs/BALANCE.md`).

## The Heroic crypt (ticket 6.3)

The harder crypt mode the owner asked for (4.11 follow-up, F.1): **tier IV, "Heroic"**, the same Nameless Crypt with harder chambers and a harder Gravewarden, tuned for upgraded Cinderwastes Legendaries. Owner decisions: tier III stays "the Legendary tier"; Heroic pays in **better top-rarity odds, not a new power curve**.

- **Gate:** level 32 and tier III cleared (`{ level: 32, cryptTierCleared: 3 }`); a clear sets `cryptTierCleared` to 4 ("Heroic cleared", PvE Progress 4's milestone 18).
- **The run:** the crypt's run model unchanged (four chambers of two foes, the boss, the snapshot, the server-only seed streams, replay for every view, the shared 20 h hoard cooldown, one Gravewarden Seal). The tier is data on `DUNGEONS` (`heroic: true`, name "Heroic"):
  - **Chambers:** the crypt's ghouls and acolytes at levels 32–36 with health and damage × 1.6 (`DungeonTierDefinition.roomScale`, new and optional: the same enemy and level draws, only the drawn foe is tougher; tiers I–III have none).
  - **The Heroic Gravewarden:** level 36, health × 3.4, damage × 2.6, resistance × 0.5, an enrage window of 30–60 s for × 2 damage and × 1.4 attack speed, and a **grave-bell** heavy blow (every fourth blow × 3, the 6.2 `BossMechanics.heavyBlow`, its log line "The grave-bell tolls").
- **Loot (the focus *Heroic spoils*):** item levels **31–37** in the chambers and **34–36** in the hoard, inside the Verge's (29–35) and the Depths' (35–41) bands: no new item level, no new affix tier, tier-3 and tier-4 bases (the hoard also the three Gravewarden bases). Its tables (`namelessCryptIV`, `gravewardenIV`) carry the top-rarity odds: Legendary weight × 2.5 (`HEROIC_LEGENDARY_WEIGHT`; the other late-game sources × 1.5), Void 15 % (`HEROIC_VOID_CHANCE`, the cap), since ticket 6.4 Prismatic 7.5 % of the non-Void top rolls (`HEROIC_PRISMATIC_CHANCE`, the cap; ~0.044 Prismatic items per run against Void's ~0.098, `docs/EFFECTS.md` "Prismatic variants"), Mythics in the chambers too, a third of Legendaries as set pieces; the hoard's rarity weights 0/2500/3500/1100/110 (tier III 1000/3500/3000/500/45). Items keep the source `dungeon:namelessCrypt` (hoard `hoard:namelessCrypt`, always bound).
- **Art:** no new art. The crypt's backdrop, foes, Gravewarden and their attack frames are drawn with the **Heroic treatment** (`heroicSprite`, the `pixel--tint-heroic` filter: grave-cold, harder contrast, crisp pixels) and a cold rim and "Heroic" plaque on the stage; the admin animation gallery shows it as "The Nameless Crypt · Heroic".

**Odds against tier III** (game-core, a Legendary +10 kit at item level 39 at each tier's top level, boss loot eligible, 200 runs per class; `tools/balance/heroic.ts odds`):

| Per run | Tier III (24) | Heroic (36) |
|---|---|---|
| items | 3.54 | 3.54 |
| Legendaries (not set) | 0.110 | 0.421 |
| Mythics | 0.010 | 0.022 |
| set pieces | 0.068 | 0.205 |
| Void items | 0.029 | 0.113 |
| top-rarity share of items (Legendary, Mythic, set) | 5.3 % | 18.3 % |
| highest item level | 25 | 37 (today's top: 41) |

**Win rates** (game-core, `balance.test.ts` kits: one item per slot, the class's best bases; 16 pinned seeds per class; warrior / mage / hunter / warlock, mean in brackets; `tools/balance/heroic.ts heroic`):

| Verge gear (item level 33) | Level 32 (entry) | Level 35 |
|---|---|---|
| naked, epics +10 | 0 % | 0 / 0 / 0 / 0 % |
| Legendaries (with effects) | 31/0/75/19 (31) | 56/0/94/31 (45) |
| Legendaries +5 | 94/0/100/81 (69) | 100/0/100/94 (73) |
| Legendaries +10 | 100/69/100/100 (92) | 100/88/100/100 (97) |
| for comparison: tier III, Legendaries | 100 % | 100 % |

So Heroic sits where the Forge Tyrant sits for the same kit (34 / 70 / 91 % at +0 / +5 / +10): upgraded Verge Legendaries win it, plain ones a third of the time, epics never. The mage (cloth against the Gravewarden's physical blows) is the weakest class, as at the Tyrant; class balance is B.5's. Asserted in `balance/heroic-balance.test.ts`: naked 0 %; epics +10 ≤ 10 %; Legendaries 15–60 %; +5 above +0 and ≤ 85 %; +10 ≥ 85 % with every class ≥ 50 %; harder than tier III for the same kit; far more top rarities than tier III and no item above item level 41.

**B.5 (`docs/BALANCE.md` "B.5", item 2):** the Heroic Gravewarden's resistance 0.5 → **0.4** and armour × **1.15** (`bossScale`), to even the classes: over 8 Legendary kits per class with Legendaries +5 the mage won 59–74 % and the others 72–92 %; now mage 66–79 %, every class 66–94 %, the spread 17–21 points (was 18–24). The table above (one kit per class) after B.5: at 32 Legendaries 25/0/58/46 (32), +5 92/0/100/96 (72), +10 100/88/100/100 (97); at 34 +0 42/0/71/58 (43), +5 96/8/100/96 (75), +10 100/92/100/100 (98); at 36 +5 96/17/100/96 (77), +10 100/96/100/100 (99).

**Invariance.** Tiers I–III, the Watch and the Forge are untouched: the pinned no-effects hashes, 6.1's and 6.2's curve pins and every earlier balance suite pass unchanged.

## Weekly boss modifiers (ticket 6.3)

Every week one **modifier** holds at every boss but the first: the crypt's Gravewarden in tiers II–IV, the Ashen Warden, the Forge Tyrant and the guild boss. **Crypt tier I never takes one** (owner decision on this ticket: beginners meet a stable first boss; data `bossModifiers: false` on the tier, `tierTakesBossModifier`): its runs store `null` like runs from before 6.3 and replay identically, `simulateDungeonRun` ignores a modifier given for it, and its door and run panel say "No omen here" (`takesModifier: false` on the tier in `GET …/dungeon`). It changes how the boss fights and gives its hoard a small loot focus. Data in game-core `dungeon/modifiers.ts` (`BOSS_MODIFIERS`); the fight rules are optional `BossMechanics` and boss-data changes on the existing engine, and none draws a random number, so a seed's other streams (rooms, loot, the enrage moment) stay as they are.

| Modifier | Effect (as players read it) | Mechanics | Hoard focus |
|---|---|---|---|
| Burning | Every 4 seconds its flames burn you for a third of one of its blows, whatever your armour. | `burn`: a tick of ⅓ × its ordinary blow every 4 s (its own timeline; never enraged) | *Fire-hardened mail*: helms and chest pieces × 1.5 |
| Warded | A ward rises at 60 % health and holds until 45 %: your blows deal 25 % less (30 % before B.5). | `ward` 0.6 → 0.45, hero blows and thorns × 0.75 (× 0.7 before B.5) | *Warding trinkets*: rings and amulets × 1.5 |
| Frenzied | Below 40 % health the boss strikes a quarter faster. | `frenzy` below 0.4, attack speed × 1.25 | *Quick hands and feet*: gloves and boots × 1.5 |
| Unyielding | 15 % more health, strikes 15 % slower. | health × 1.15, attack speed × 0.85 | *Siege arms*: weapons and off-hands × 1.5 |
| Relentless | Its rage comes 5 seconds sooner. | enrage window − 5 s | *Slayer's lore*: Tyrant's Bane and Headsman's Due × 2 |

- **The week (window rule):** the guild boss's week, Monday 00:00:00.000 UTC (inclusive) to the next Monday (exclusive), `guildBossWeek`. `bossModifierOfWeek(week)` is deterministic and public: weeks come in cycles of five (one week per modifier), each cycle in an order shuffled from its number, and a cycle never opens with the modifier the last one closed with, so no modifier holds two weeks running (pinned: the week of 2 November 2026 is Relentless, 9 November Warded, 16 November Burning, 23 November Frenzied, 30 November Unyielding).
- **Stored with the run:** a run's start reads the game clock once in its transaction and stores that week's modifier (`dungeon_runs.boss_modifier`). Settles, claims and every view replay the run with the stored modifier, never the current week's: a run started on Sunday 23:59:59.999 that ends after midnight keeps Sunday's modifier. Runs from before 6.3 store `null` and replay exactly as they were (`simulateDungeonRun` without a modifier is bit-identical; the result has no `bossModifier` key, so the pinned hashes hold). The guild boss stores it the same way (`docs/GUILD_BOSS.md`).
- **Its loot focus** is added to the hoard's table only (`LootTableDefinition.modifierFocus`): its slot and effect weights multiply those of the dungeon's own focus; it never limits set pieces, never touches the chambers, and only reweights the base and effect picks, so the hoard's rarities, item levels and set/Mythic/Void outcomes are the same with or without it (tested). The guild boss has no hoard: there the modifier changes the fight only.
- **Shown:** the Tavern's notice (`docs/QUESTS.md`), every boss door (`GET …/dungeon` `bossModifier`, the run's own in `run.bossModifier`), the run panel ("This run's boss is"), the guild boss's siege plate and its blow-by-blow, and the admin world folio (this week and next). The log names the first burn, the ward rising and breaking and the frenzy.
- **Telemetry** per modifier (`docs/TELEMETRY.md`): runs won and lost and hoard loot by rarity per boss, guild boss attempts and counted damage.

**Win rates per modifier** (game-core, 16 pinned seeds per class, warrior / mage / hunter / warlock, mean; `tools/balance/heroic.ts modifiers`):

| Boss · kit | none | Burning | Warded | Frenzied | Unyielding | Relentless |
|---|---|---|---|---|---|---|
| crypt I · 14, commons | 73 | 73 | 73 | 73 | 73 | 73 (tier I takes no modifier; before the owner's decision it measured 55–61) |
| crypt I · 12, uncommons | 97 | 97 | 97 | 97 | 97 | 97 (was 86–91) |
| crypt II · 18, rares | 58 | 48 | 45 | 47 | 48 | 50 |
| crypt II · 18, rares +5 | 98 | 95 | 94 | 91 | 95 | 95 |
| crypt III · 21, epics +8 | 42 | 22 | 19 | 22 | 23 | 28 |
| crypt III · 21, Legendaries | 81 | 77 | 78 | 77 | 77 | 81 |
| Heroic · 34, Legendaries +5 | 75 | 75 | 72 | 70 | 75 | 72 |
| Heroic · 34, Legendaries +10 | 94 | 94 | 89 | 91 | 94 | 91 |
| Ashen Warden · 26, Legendaries | 73 | 61 | 52 | 61 | 55 | 55 |
| Ashen Warden · 26, Legendaries +5 | 98 | 97 | 97 | 95 | 98 | 95 |
| Forge Tyrant · 36, Legendaries +5 | 70 | 67 | 69 | 69 | 67 | 66 |
| Forge Tyrant · 36, Legendaries +10 | 89 | 83 | 81 | 88 | 83 | 83 |

**B.5:** Warded was the hardest modifier at most bosses (the Warded column above: up to 23 points at the edge kits) and now deals × 0.75 (was × 0.7): crypt II rares 50 %, crypt III epics +8 27 %, Legendaries 80 %, the Ashen Warden's Legendaries 56 %, Heroic +5 72 %, among the other modifiers (`docs/BALANCE.md` "B.5", item 6). The Heroic and Tyrant rows moved with item 2's scales (the table above is 6.3's).

A modifier makes a boss somewhat harder for a kit at the edge (up to about 20 points, most for the kits that only just win: epics +8 at tier III) and barely moves the best kits (0–8 points). Asserted (`heroic-balance.test.ts`, 12 seeds per class, one reference kit per boss): tier I's win rate is the same under every modifier; elsewhere no modifier raises a boss's win rate by more than 5 points or lowers it by more than 30. The first tuning (Warded at half damage from 60 % to 35 %, Unyielding with a third more health, Relentless 10 s) cost up to 50 points and was toned down to these numbers. Guild boss damage per attempt (24 seeds, every class, level 14 commons · level 21 epics · level 28 Legendaries +10): Burning −3 to −4 %, Warded −5 to −8 %, Frenzied −1 to −5 %, **Unyielding +1 to +9 %** (its slower blows let a hero last longer; the extra health means nothing to a boss that can't fall), Relentless −1 to −8 % (asserted within ± 15 %).

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

**Since B.2** (late-game Legendary weight × 1.5, a third of those rolls set pieces; a rare kit labelled Legendary at each tier's level, all classes, boss loot eligible, 4,000 runs per tier; before → after): plain Legendaries per run 0.037 → 0.071 (I), 0.041 → 0.088 (II), 0.045 → 0.099 (III); set pieces 0.033 → 0.031, 0.047 → 0.045, 0.042 → 0.053; Void 0.009 → 0.012, 0.009 → 0.014, 0.013 → 0.019; Mythics unchanged (0.005–0.009). That kit wins tier III 55 % → 71 % of runs (the boss's lower resistance, above).

So a given Vigil piece drops about once per 140 tier II runs and a given Choir piece about once per 80 tier III runs (one boss hoard per 20 h; the chambers drop every run). Abbey contracts add a slot choice for a reward item (`docs/QUESTS.md`).

## UI (ticket 3.6)
The crypt door lists the depths as a choice (Tier I–III, since 6.3 also Heroic with its own cold frame: levels, loot focus, or what bars it), defaulting to the deepest open tier; the facts follow the chosen tier (levels, boss level, the enrage window, the focus, the shared hoard). A run's panel names its tier; the reckoning names it and, on a first clear, the tier it opens. Screenshots: `docs/screenshots/phase-3/crypt-tiers-*`, `crypt-tier3-enraged-*`, `crypt-tier2-reckoning-*` (`node tools/screenshots/crypt-tiers.mjs`).
