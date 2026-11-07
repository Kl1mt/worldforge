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
| II | level 18 + tier I cleared | 18–21 | level 21, health × 1.8, damage × 1.3, resistance × 0.5 (B.2) | 2000/3500/2400/350/30 · 260–380 | the Drowned Vigil (`sets`) |
| III | level 21 + tier II cleared | 21–24 | level 24, health × 2.4, damage × 2.4 (4.8; was × 1.5), resistance × 0.5 (B.2) | 1000/3500/3000/500/45 · 420–600 | the Ashen Choir (`sets`) + Tyrant's Bane and Headsman's Due × 4 (`effects`) |

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
The crypt door lists the depths as a choice (Tier I–III: levels, loot focus, or what bars it), defaulting to the deepest open tier; the facts follow the chosen tier (levels, boss level, the enrage window, the focus, the shared hoard). A run's panel names its tier; the reckoning names it and, on a first clear, the tier it opens. Screenshots: `docs/screenshots/phase-3/crypt-tiers-*`, `crypt-tier3-enraged-*`, `crypt-tier2-reckoning-*` (`node tools/screenshots/crypt-tiers.mjs`).
