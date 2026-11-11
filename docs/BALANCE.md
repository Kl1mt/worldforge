# Balance passes

The balance passes (B-tickets) record their method, before/after tables and decisions in the docs of the system they tune (`COMBAT.md`, `ECONOMY.md`, `DUNGEONS.md`, `PVP.md`, `LEADERBOARDS.md`, `COMMUNITY.md`). This file holds the endgame pass, which spans all of them, and points to the others.

- B.1 (levels 1–12, classes): `docs/COMBAT.md` "Balance".
- B.2 (loot depth, economy): `docs/COMBAT.md`, `docs/ECONOMY.md` "Balance pass: loot depth & economy", `docs/DUNGEONS.md`.
- B.3 (top end, social economy): `docs/ECONOMY.md`, `docs/COMMUNITY.md`, `docs/DUNGEONS.md`.
- B.4 (competitive systems): `docs/LEADERBOARDS.md`, `docs/PVP.md` "Balance pass: competitive systems".
- **B.5 (endgame, Phase 6): below.**

## B.5: the endgame (Phase 6)

GDD §16.4. Everything below is measured with game-core from fixed seeds (`tools/balance/endgame.ts`, `arena.ts`, `heroic.ts`, `awakening.ts`; guards in `packages/game-core/src/balance/`), never against the live site or production data. The owner's playtest feedback (`docs/PLAYTEST_FEEDBACK.md`) has not arrived yet: the template is still empty, so nothing here answers it.

**The realistic player at the endgame.** The API simulator (`telemetry:simulate`) does not play Phase 6 content yet (the Verge, the Depths, Heroic, the Tyrant, awakening), so B.5 models the endgame with game-core at the realistic player's cadence (B.2/B.3, 6.5): a dedicated player is credited about **15 hours of farming a day** over five visits, makes **up to five boss or crypt runs a day** and takes each boss hoard once a day (the 20 h cooldowns); regular and casual players play a half and a quarter of that (B.4's population). The kit is what B.4's realistic season showed in 30+: Legendaries at +5 to +10 (median level 40, half the pieces Legendary, +8.7 on average), modelled as Legendaries with effects at +5, item level = level − 2 within each area's drops.

### Changes at a glance

| What | Before | After | Why |
|---|---|---|---|
| Arena matchmaking in 30+ | ranked by Character Power (bracket Power 2) | ranked by **duel Power** (bracket Power 3, matchmaking 4) | 30+ had 13–14.5 % pairs with a 90 %+ favourite; now 2.5–4 % |
| The Forge Tyrant | no scale | resistance × 0.7, armour × 1.2 | the mage won 54–57 % with Legendaries +5, the others 75–92 % |
| The Heroic Gravewarden | resistance × 0.5 | resistance × 0.4, armour × 1.15 | the mage won 59–74 % with Legendaries +5, the others 72–92 % |
| The Warded modifier | blows −30 % from 60 % to 45 % health | **−25 %** | the hardest modifier at most bosses |

No duel rule, Character Power, Gear Score or PvE Progress formula changed (`PVP_RULES_VERSION` 2, Power 2, Gear Score 2, PvE Progress 4). No migration. Levels ≤ 28 are untouched except the Warded modifier, which also holds at the crypt's tiers II–III and the Ashen Warden (issue 6 requires it); every earlier suite (the no-effects hashes, the curve pins, B.1–B.4's bands) passes unchanged.

### 1. PvP 30+ matchmaking fairness

**The problem** (6.1, 6.2, 6.5b): in 30+ the share of offered pairs with a 90 %+ favourite rose to 13–14.5 % (band ≤ 14 %) and 95 %+ to 6.5–9 % (band ≤ 7 %). Most of those pairs were **within 1 % of each other on bracket Power**: of the 79 lopsided pairs at the season's start, 47 were within 1 % and 78 within 5 %, mostly Legendary +5 / +10 Void kits and B.2 builds against plain Legendaries. Character Power is a PvE measure (twenty trials against monsters) and saturates at the top, while a duel at `keep` 0.25 still separates those kits. A narrower Power range cannot help pairs that sit inside 1 %, so the fix is a measure that sees what the duel sees.

**Duel Power** (`duelPower`, game-core `pvp/matchmaking.ts`, `duelStrength` in `pvp/duel.ts`): the hero is normalised exactly as for a duel (`normaliseFighter`: gear at `keep`, effects at `effectKeep`, the class tuning, awakening) and fights the bracket's four reference heroes (one per class: the reference kit, implicit stats, the class tuning, no effects) in an **expected-value duel**: every blow at its expected damage (crit chance × crit + the rest × normal, the luck of the blow at its mean, a surge weighted by the chance the blow before was a crit), both sides on their own timelines, thorns on every blow, a fall interpolated inside the killing blow, no sudden death. The strength is the mean over the four classes of ln(time the reference needs to fell the hero ÷ time the hero needs to fell the reference); duel Power = 1000 × e^(0.6 × strength). Deterministic (no seed), about 0.2 ms.

- **Only in 30+** (`DUEL_POWER_BRACKETS`). Tried in 10–19 and 20–29, it ranked worse than Character Power there (10–19 2.3 % → 6.0 % 90 %+ favourites; 20–29 after a season 3.7 % → 5.3 %), so they keep it: their lists are drawn exactly as before (the offer's seed keeps matchmaking 3's prefix).
- **The exponent 0.6** compresses the measure so each Power step holds enough accounts: at 1.0 a week of rated duels among the realistic 30+ heroes counted only 41 % in full (repeat pairs; B.4: 45 %), at 0.75 45 %, at 0.6 **51 %** (a quarter: B.4 17 % → **9 %**), with 90 %+ favourites at 3.2 % (1.8 % at 1.0, 2.3 % at 0.75).
- **Class scale** (matchmaking 4, `DUEL_POWER_MATCHMAKING`): B.4's Power scale (warrior ÷ 1.035, warlock ÷ 0.967) would count the class twice (it took the synthetic 90 %+ share from 3 % back to 6 %). Fitted on the realistic heroes instead: duel Power, measured against references without effects, rates the warrior slightly high against real opponents (41 % over offered pairs at 1.0); **warrior ÷ 1.02** puts every class at 44.5–53.4 %.
- **Versions.** `BRACKET_POWER_VERSION` 2 → 3 and `MATCHMAKING_VERSION` 3 → 4; `PVP_RULES_VERSION` stays 2 (no duel changed). Bracket Power is matchmaking's own measure, not a board formula: nothing ranks by it, no stored score changes, so it switches at once like 6.5b's version 2 and B.4's matchmaking 2 (no season boundary; the 5.3 rule is for boards). Stored defences: a version-2 or (without an awakening) version-1 value is reused in 1–29, where version 3 equals it; a 30+ defence stored before B.5 is recomputed when matchmaking reads it (`defencePower`, ≈ 0.2 ms each, at most 500 per draw) and stored as version 3 the next time it is set.

**Measured** (`tools/balance/arena.ts 120 32 20`; 120 heroes, every offered pair fought 32 times from fixed seeds; start of season / after 20 simulated rounds):

| 30+ | 90 %+ favourites | 95 %+ favourites | mean favourite | lists widened | pairs with one +10 Void hero: mean · 90 %+ |
|---|---|---|---|---|---|
| levels 30–35 (the suite's population), before | 13.2 % / 5.7 % | 6.5 % / 1.8 % | 69.3 % / 66.3 % | 3.3 % | 86.3 % · 51.0 % |
| levels 30–35, **after** | **3.2 %** / 4.3 % | **1.0 %** / 1.3 % | 64.3 % / 66.9 % | 1.7 % | 73.4 % · 19.4 % |
| levels 30–40 (with the Depths), before | 13.8 % / 4.8 % | 8.8 % / 1.5 % | 70.6 % / 66.4 % | 0.8 % | 83.3 % · 39.1 % |
| levels 30–40, **after** | **4.0 %** / 6.0 % | **0.7 %** / 1.5 % | 66.6 % / 68.2 % | 1.7 % | 74.0 % · 15.6 % |
| 30–35, every +10 Void kit awakened, before (bracket Power 2) | 14.5 % / 6.0 % | 6.7 % / 1.0 % | 69.4 % / 66.3 % | 3.3 % | 85.1 % · 55.6 % |
| 30–35, awakened, **after** | **2.5 %** / 4.3 % | **0.5 %** / 1.0 % | 64.2 % / 67.0 % | 1.7 % | 72.1 % · 14.3 % |
| 30–40, awakened, before | 12.8 % / 4.7 % | 7.3 % / 1.5 % | 70.6 % / 66.4 % | 0.0 % | 80.9 % · 32.7 % |
| 30–40, awakened, **after** | **3.8 %** / 6.2 % | **0.7 %** / 1.3 % | 66.8 % / 68.5 % | 1.7 % | 75.3 % · 9.1 % |
| 20–29 (unchanged) | 3.3 % / 3.7 % | 0.7 % / 1.2 % | 66.3 % / 66.8 % | 6.7 % | |
| 10–19 (unchanged) | 2.3 % / 2.7 % | 0.5 % / 0.5 % | 65.5 % / 64.9 % | 14.2 % | |

So 30+ is back inside every bracket's original band (≤ 9 % / ≤ 5 %) and under the ideal ≤ 8 % in every population, awakened or not; nothing is loosened (the suite now asserts ≤ 9 % / ≤ 5 % for 30+ like the other brackets, and ≤ 8 % / ≤ 5 % on the 30–40 populations). After a season the 30–40 population settles at 6 % (Power: 4.8 %): ratings had been hiding Power's misranking, and duel Power starts the season right instead.

**On realistic heroes** (B.4's 120 realistic 30+ defences, `realistic-arena.json`; offered pairs × 16 duels):

| | warrior / mage / hunter / warlock over offered pairs | mean favourite | 90 %+ | 95 %+ | a week of rated duels: in full · at ¼ |
|---|---|---|---|---|---|
| 5.6 (raw Power) | | | | | 39 % · 28 % |
| B.4 (bracket Power 2, matchmaking 3) | 47.3 / 48.6 / 50.3 / 53.9 % | 70.3 % | 8.2 % | 3.3 % | 45 % · 17 % |
| **B.5** (bracket Power 3, matchmaking 4) | 52.3 / 44.5 / 53.4 / 49.9 % | **65.1 %** | **2.3 %** | **0.3 %** | **51 % · 9 %** |

Guards: `arena-fairness.test.ts` (every bracket ≤ 9 % / ≤ 5 %; 30+ to level 40, plain and awakened, ≤ 8 % / ≤ 5 %), `awakening-pvp.test.ts`, `competitive-balance.test.ts` (B.4's comparisons on bracket Power 2, today's matchmaking on the same bands and no less fair), `matchmaking.test.ts`, the server's `arena/power-version.test.ts` (stored values across versions).

### 2. Class spread at the Forge Tyrant and the Heroic crypt

**Measured over 8 Legendary kits per class** (with effects, item level 33: the Verge's drops; 12 seeds each). The suites' single kit (`legendaryKit`, sample 0) happens to be the mage's worst of eight (0 % at +5 at Heroic 34); over eight kits the mage trailed by 25–35 points, not 75. Its kit is not the cause (its armour equals the hunter's and warlock's); its single-target damage is the lowest of the four (271 magic × 0.88 attacks a second against the warlock's 304 × 0.96), so it reaches the enrage more often.

**The lever** is the one B.2 used at the deeper Gravewarden (`EnemyScale.resistance`), plus a new optional `EnemyScale.armor` (default 1, so every other boss is unchanged): both bosses mitigate spells less and blades more. The Tyrant's slag "turns blades more than spells" (resistance × 0.7, armour × 1.2); the Heroic Gravewarden resistance 0.5 → 0.4, armour × 1.15.

| Legendaries (8 kits × 12 seeds), warrior / mage / hunter / warlock | +0 before | +0 after | +5 before | **+5 after** | +10 before | +10 after |
|---|---|---|---|---|---|---|
| Forge Tyrant at 36 | 58/9/36/25 (spread 49) | 41/19/28/31 (22) | 89/54/78/75 (34) | **80/71/68/91 (23)** | 100/92/99/97 | 100/95/97/99 |
| Forge Tyrant at 38 | 69/15/42/30 (54) | 58/29/34/47 (29) | 92/57/88/82 (34) | **86/76/75/92 (17)** | 100/94/100/99 | 100/95/99/100 |
| Heroic at 32 | 52/21/32/48 (31) | 47/24/26/50 (26) | 83/59/72/77 (24) | **78/66/67/85 (20)** | 100/94/99/99 | 100/94/97/100 |
| Heroic at 34 | 57/28/38/55 (29) | 52/31/33/58 (27) | 90/68/77/89 (22) | **85/72/70/91 (21)** | 100/94/100/100 | 100/95/99/100 |
| Heroic at 36 | 67/34/49/60 (32) | 63/41/40/65 (25) | 92/74/82/92 (18) | **89/79/77/94 (17)** | 100/94/100/100 | 100/97/100/100 |

Means stay where 6.2 and 6.3 put them (Tyrant +5 74 → 77 %, Heroic 34 +5 81 → 79 %); upgraded Verge Legendaries still win, plain ones a third to a half of the time. The suites' own tables (`balance.test.ts` "the Forge Tyrant", `heroic-balance.test.ts`, sample 0) pass unchanged; `docs/DUNGEONS.md` has their after-values.

**The hunter's fast kills are not fixed by boss data.** Its best farming build (the Drowned Vigil's Hold the Line, Ambush, Headsman's Due on the neck, Emberbrand on a ring) kills the Tyrant in 13–15 s on average (fastest 11–12 s) and the Heroic Gravewarden in 14–17 s (fastest 11–14 s), against 18–27 s for the other classes' best builds. Before B.5: 13–16 s (fastest 10–14 s). It stacks crit burn (which ignores armour) and execute, and Hold the Line's +30 % holds for a fight this short, so armour × 1.2–1.4, a longer or stronger slag shell, and a forge-heat burn each moved it by about a second while costing every class's Legendary kits 5–30 points. Its average Heroic kill is now above 0.4 × the earliest enrage (12 s), its fastest still at it; at the Tyrant both stay below (14 s). Taming it means touching the hunter's set bonus or where Headsman's Due and Emberbrand may roll, which moves the Ashen Pass and the Watch (levels ≤ 28): **a question for the owner**, not done here.

Guard: `endgame-balance.test.ts` (every class ≥ 60 % at +5 and ≥ 90 % at +10, spread ≤ 25 points at +5 and ≤ 33 at +0, upgrades pay for every class, at both bosses and every level above).

### 3. Heroic loot pace

6.3 measured 0.42 Legendaries a Heroic run against 0.11 in tier III, set pieces 0.21 vs 0.07, Void 0.11 vs 0.03. Per run that is a lot; what matters is how fast it completes a build. **Measured** (`endgame.ts loot`): each class's best farming build (four set pieces of its set and a Legendary with each chosen effect in its slot), a drop counting at item level 31 or more. Rates per needed piece from 1,500 hours of Depths farming at 38 and 2,000 runs of each kind; days sampled 4,000 times. A dedicated day: 15 h in the Depths, the Tyrant's hoard, five Heroic runs (one with the crypt's hoard).

| Days to the best build (dedicated) | warrior | mage | hunter | warlock |
|---|---|---|---|---|
| Depths farming + the Tyrant (no Heroic), median (p90) | 33 (63) | 90 (204) | 47 (102) | 34 (62) |
| **with the Heroic crypt**, median (p90) | **26 (47)** | **58 (119)** | **33 (67)** | **28 (50)** |

The Heroic crypt adds 0.01–0.05 of each needed piece a day against 0.01–0.14 from farming, so it shortens the median by a fifth to a third: half a season (warrior, warlock) to a whole one (mage). A build is gated by its rarest piece (the mage's Emberbrand weapon and Bloodrush ring), and after it come +10 (130–200 h of income, B.3), Void and awakening (24–27 days, below). **"Too fast"** would be a dedicated player finishing the chase in the first quarter of an 8-week season (two weeks): no class is there, so the odds stay.

### 4. Prismatic against Void in duels

No duel rule changed, so 6.4's numbers stand: +10 Prismatic kits against +10 Void kits 37 % in 20–29 (random affixes, find affixes included, which Prismatic never raises) and 47 % in 30+, while on B.2-shaped builds Prismatic wins 64 % (20–29) and 58 % (30+). Which variant wins depends on the item's affixes, as in PvE, and neither wins more than about two duels in three in either shape (`pvp-balance.test.ts`). Not clearly off: **no change**. Matchmaking now ranks 30+ by duel Power, which reads both variants as the duel does.

### 5. The Forgeward Outpost's first-day givers

6.7 guarantees five givers on a stage finished on its first day (B.3's 20 % first-day cap). **Would a big town need a 10 % first-day cap (ten givers)?** (`endgame.ts forgeward`, 6.7's realistic town):

| Players | 20 % cap (today): days · givers per stage · top giver | 10 % cap |
|---|---|---|
| 20 | 8 days · 6/16/20 · 19/16/20 % | 8 days · 10/16/20 · 10/18/17 % |
| 100 | 2 days · 6/14/24 · 19/11/5 % | 2 days · 10/13/24 · 10/10/5 % |
| 500 | 2 days · 6/16/20 · 19/11/10 % | 2 days · 10/16/20 · 10/9/7 % |

A 10 % cap changes no pace and only spreads the first stage over ten givers instead of six. Nobody carries more than a fifth of any stage at 20+ players with today's cap, so it **isn't needed**: no change (a cap by town size would also be a new rule, since today's cap is per stage, not per town). If the owner wants more names on the first stage, `capShare: 0.1` on the Outpost's stages is a data change that costs a big town nothing (small towns of 3–10 would take longer).

### 6. Weekly boss modifiers

Win rates per modifier (6.3's table shape, `heroic.ts modifiers`, 16 seeds per class, means): **Warded** was the hardest modifier at most bosses (crypt II rares −13, crypt III epics +8 −23, the Ashen Warden's Legendaries −21 points, against −8 to −20 for the others). At **−25 %** (was −30 %) it sits among them:

| Boss · kit | none | Warded before | **Warded after** | the others (after) |
|---|---|---|---|---|
| crypt II · 18, rares | 58 | 45 | **50** | 47–50 |
| crypt III · 21, epics +8 | 42 | 19 | **27** | 22–28 |
| crypt III · 21, Legendaries | 81 | 78 | **80** | 77–81 |
| Heroic · 34, Legendaries +5 | 77 | 70 | **72** | 73–75 |
| Ashen Warden · 26, Legendaries | 73 | 52 | **56** | 55–61 |
| Forge Tyrant · 36, Legendaries +5 | 75 | 75 | **75** | 67–75 |

(Heroic and Tyrant rows are after item 2's scales.) The guild boss: Warded costs −4 to −6 % damage per attempt (was −5 to −8 %). Its text now says 25 %. Guard: `endgame-balance.test.ts` (Warded is not the hardest at the two kits where it was worst; 6.3's bounds in `heroic-balance.test.ts` hold).

### 7. Events: the Harvest of Bones

(`endgame.ts event`; per farmed hour, game-core.)

| Hero | Area | kills/h (risen) | bounty shards | the area's own shards | Turn the Furrows · the Ossuary Tithe · the Long Reaping |
|---|---|---|---|---|---|
| newcomer, level 6, no gear | the Fields | 388–429 (251–276) | 6 | 0 | 13–14 · 120 · 56–62 min |
| level 20, rares +5 | the Fields | 949–1,102 (623–715) | 15–17 | 0 | 5–6 · 42–48 · 22–25 min |
| level 40, Legendaries +5 | the Burial Grounds | 1,196–1,340 (all risen) | 29–33 | 38–40 | 3 · 10–11 · 18–20 min |

**Reward pacing:** the four tasks pay exactly the 50 tallies of the last tier; a hero who can beat any dungeon master finishes the whole track in about an hour, a newcomer reaches tier 2 in about two hours of farming the Fields and tier 3 once it opens the crypt (level 12) or with a second hero. For a 7-day event that is quick, by design (6.6: cosmetic keepsakes, never power): nothing to tune for balance. Whether the owner wants a longer chase (more tasks or tiers) is a content question.

**The shard bonus against the economy:** it never touches gold, XP or items. At most it roughly doubles a farmer's shards in the Burial Grounds (38 → 70 an hour at level 40), and an endgame hero who farms there for it gives up half its gold (1.3–1.7k against 2.7–3.5k in the Depths) and 97 % of its XP. Shards were already plentiful (B.3: a surplus of 26k a week at the top; a +10 path needs 41, an awakening 30), so **no change**.

### 8. The awakening economy

(`awakening.ts time`, re-measured after items 2 and 6; a dedicated player in Verge Legendaries +10 at level 38.) Sources: one Tyrant's Ember a day (his hoard; five tries make it near-certain for every class: Tyrant 90–100 %), one Gravewarden Seal a day (the crypt's hoard) plus the guild boss's stage rewards (up to 2 a week). Sinks: an awakening takes 3 Embers, 2 Seals, 25,200 gold and 30 shards; Tyrantforged Work 1 Ember; the Forgeward beacon 10 Embers for the whole town, once.

| | one awakening | full kit (8; the warrior 9) | gold for one, in farming hours |
|---|---|---|---|
| dedicated | 3.0 days (Ember-bound) | 24–27 days | 4.3–9.4 h |
| regular | 6 days | 48–54 days | |
| casual | 12 days | 96–108 days | |

**Against the target** (about one season for a dedicated player): a dedicated player reaches the Tyrant (level 36) early in a season (28 → 36 takes 1.6–2.2 days of play, item 9; B.4's realistic season filled 30+, "the bracket every busy player reaches within a week or two") and needs +10 eligible items first, so a whole awakened kit lands around week 6–8: **about one season, as intended; no change.** Embers are the gate and gold isn't, so gold can't buy speed. One imbalance to note: Seals come in faster than awakening uses them (about 1.3 a day in, 0.67 out), so a dedicated player ends a kit with 15–17 spare Seals and nothing to spend them on: **an owner question** (a future Seal sink), not a balance problem.

### 9. Endgame XP and gold pacing, levels 28–48

(`endgame.ts pace`: the best open area for XP, a realistic kit, one hour per level.)

| Level span | hours of farming | dedicated | regular | casual |
|---|---|---|---|---|
| 28 → 34 (the Verge) | 18–25 h | 1.2–1.6 days | 2.4–3.3 days | 5–7 days |
| 28 → 36 (the Tyrant opens) | 24–33 h | 1.6–2.2 days | 3.2–4.4 days | 6–9 days |
| 28 → 40 | 38–52 h | 2.5–3.5 days | 5–7 days | 10–14 days |
| 28 → 44 | 55–75 h | 3.7–5 days | 7–10 days | 15–20 days |
| 28 → 48 (the soft cap) | 99–138 h | 6.6–9.2 days | 13–18 days | 26–37 days |

Each level from 28 to 42 takes 3.5–5.5 hours (the Verge to 33, the Depths from 34); the XP penalty bites from 43 (6–8 h), 46 (11–16 h) and 47 → 48 (19–68 h): the soft cap sits at 47–48 as 6.2 set it. Gold: 2.1–3.9k an hour of kill gold in the Verge and the Depths, rising with the area (the Depths' gold × 3); the awakening's 25,200 gold is 7–12 hours, the Tyrantforged Work's 2,400–3,000 one hour. Levels come in days and the endgame's goals (builds, +10, Void, awakening) in weeks, which is the shape Phase 6 wanted (levels are no longer the long goal: B.4 measured Level boards topping out). **No change.** Guard: `endgame-balance.test.ts` (2–8 h a level from 28 to 40 for every class, 30–70 h from 28 to 40, ≥ 12 h for 47 → 48).

### 10. Do older drops still matter?

(The Phase 6 exit criterion; `endgame.ts older`.)

- **Salvage:** an Ashen Pass Legendary (item level 25, tier 3) salvages to 44 gold, 8 iron ore and 3 soul shards; a Depths item's whole +0 → +10 path (item level 39) expects 49,364 gold, 677 ore and 41 shards. So older drops feed the endgame's Forge: one +10 path takes the ore of ~85 old Legendaries (or of any farming) and the shards of ~14. 6.1's assertions (tier-3 salvage unchanged, the +10 path priced in materials the Verge yields) hold.
- **Set completion:** each class's best build at +10 Void with its four set pieces from the Pass (item level 25) and the rest from the Depths (39) farms the Depths at 40 within 1–3 % of the all-Depths kit (warrior 15.2 vs 15.3 kills/min, mage 15.2 vs 15.7, hunter 17.8 vs 18.1, warlock 15.3 vs 15.7) and beats the Tyrant every run, 1–2 s slower: an older set piece keeps its place until a newer copy of the same piece drops.
- **Newer drops still pay:** an all-Pass +10 Void kit farms 14–18 % slower (12.8–15.4 kills/min) and kills the Tyrant in 18–31 s against 12–20 s. An awakened older piece still loses its slot to a plain newer one (6.5's assertion, unchanged).
- **The Forge:** Tyrantforged Work turns Embers into slot-targeted tier-4 items, and upgrades keep their value on any item.

Guard: `endgame-balance.test.ts` (Pass set pieces in a Depths kit ≥ 95 % of its farming, an all-Pass kit ≤ 92 %, the mixed kit beats the Tyrant every run).

### Risks and open points

- **Replays across the deploy:** a dungeon run is replayed from its seed and snapshot for every view and the claim. A Tyrant, Heroic or Warded-week run that is under way while B.5 deploys (a few minutes at most) replays under the new numbers: its claim and its last views agree with each other, but its `endsAt` came from the old ones. Earlier balance passes accepted the same window.
- **The hunter's fast kills** (item 2) need an owner decision on the hunter's set bonus or effect slots.
- **Spare Seals** (item 8) have no sink after a full awakened kit.
- **The API simulator** doesn't play Phase 6 content, so B.5 models the endgame player in game-core; a Phase 6 season run of the realistic player (and a new `realistic-arena.json`) would let a later pass check these numbers against telemetry.
