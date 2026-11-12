# Balance passes

The balance passes (B-tickets) record their method, before/after tables and decisions in the docs of the system they tune (`COMBAT.md`, `ECONOMY.md`, `DUNGEONS.md`, `PVP.md`, `LEADERBOARDS.md`, `COMMUNITY.md`). This file holds the endgame pass, which spans all of them, and points to the others.

- B.1 (levels 1–12, classes): `docs/COMBAT.md` "Balance".
- B.2 (loot depth, economy): `docs/COMBAT.md`, `docs/ECONOMY.md` "Balance pass: loot depth & economy", `docs/DUNGEONS.md`.
- B.3 (top end, social economy): `docs/ECONOMY.md`, `docs/COMMUNITY.md`, `docs/DUNGEONS.md`.
- B.4 (competitive systems): `docs/LEADERBOARDS.md`, `docs/PVP.md` "Balance pass: competitive systems".
- **B.5 (endgame, Phase 6): below.** Owner decisions on its questions: **B.5b** at the end of the section.
- **Phase 6 exit criterion (ticket 6.10): at the end.** A record, not a pass: nothing changes. **Ticket 8.1** extends it to the Hollow Reach (its own section below).
- **Phase 8 exit criterion (ticket 8.7): at the end.** A record, not a pass: nothing changes.

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
- **The hunter's fast kills** (item 2): accepted risk (B.5b), watched in live data.
- **Spare Seals** (item 8) have no sink after a full awakened kit: a sink is planned (B.5b, ROADMAP 6.11).
- **The API simulator** doesn't play Phase 6 content, so B.5 models the endgame player in game-core; a Phase 6 season run of the realistic player (and a new `realistic-arena.json`) would let a later pass check these numbers against telemetry.

## B.5b: the owner's decisions on B.5 (2026-11-11)

1. **The hunter's burst build** (item 2): left as it is until real player data shows a problem. An **accepted risk**; no change.
2. **Spare Gravewarden Seals** (item 8): a Seal sink will be added later, a cosmetic or a modest Forge recipe with no new power (`docs/ROADMAP.md` 6.11, a placeholder; not built).
3. **Event length** (item 7): the Harvest of Bones stays; the next event should be a longer chase (`docs/EVENTS.md` "Guidance for future events").
4. **The Forgeward first-day cap** (item 5): **`capShare: 0.1`** on all three Forgeward Outpost stages (ten givers to finish a stage on its first day; 10 → 30 → 50 → 60 % by B.3's growth). Every other stage keeps `COMMUNITY_PROJECT_CONFIG` (20 % → 60 %). Item 5's table re-run with the shipped data (`endgame.ts forgeward`, `balance/forgeward-balance.test.ts`): identical, 8 / 2 / 2 days at 20 / 100 / 500 players, the first stage's givers 6 → 10, its largest share 19 → 10 %. Small towns: 1 player 30 → 31 days, 3 and 10 players unchanged (20 and 10 days). While wiring it, `stageCapShare` gained a rounding step: 0.1 + 0.2 is 0.30000000000000004 in floating point and would have made a second-day cap one unit larger (4 embers instead of 3); the 20 % stages were exact and don't change.

## Phase 6 exit criterion (ticket 6.10)

GDD §15 Phase 6: "Endgame systems add meaningful choices without making older content or most item drops irrelevant." Concretely (ROADMAP Phase 6): a level-28 hero in good Ashen Pass gear can still farm and progress in the new region, Phase 1–5 drops keep a use, and no new system is required to stay competitive in PvE. This section records the numbers that say so. **It changes nothing**: no gameplay number, rule or content moved, so every value below is the same before and after. Everything is game-core from fixed seeds (`tools/balance/phase6-exit.ts`, which reuses B.2's build search and B.5's kits and seeds); the guard is `packages/game-core/src/balance/phase6-exit-criterion.test.ts` (21 tests, 10–20 s, deterministic).

### 1. Older content stays relevant

**A level-28 hero in good Pass gear farms the Ashfall Verge.** "Good Pass gear": the class's best Ashen Pass farming build (4.8's search) at +5, item level 27 (the Pass's top drops), no Void, no Prismatic, no awakening. 2 seeds × 1 h.

| Class (build) | Pass 28: kills/min · XP/h · gold/h | Verge 28: kills/min · deaths/h · XP/h · gold/h | Verge ÷ Pass: kills · XP · gold | Verge 34: kills/min · deaths/h |
|---|---|---|---|---|
| Warrior (Bloodmoon 4, speed) | 21.0 · 230k · 3,198 | 16.1 · 0 · 270k · 3,490 | 0.77 · 1.18 · 1.09 | 15.7 · 0 |
| Mage (Bloodmoon 4, speed) | 19.1 · 209k · 2,904 | 16.1 · 0 · 271k · 3,490 | 0.85 · 1.30 · 1.20 | 15.6 · 0 |
| Hunter (Vigil 4, Ambush, speed) | 21.9 · 240k · 3,309 | 18.9 · 0 · 318k · 4,148 | 0.87 · 1.33 · 1.25 | 18.2 · 0 |
| Warlock (Bloodmoon 4, speed) | 19.2 · 210k · 2,907 | 16.2 · 0 · 272k · 3,499 | 0.85 · 1.30 · 1.20 | 15.4 · 0 |

A step up (kills × 0.77–0.87), never a wall (no deaths at 28 or at the Verge's top), and it pays: 18–33 % more XP and 9–25 % more gold an hour than staying in the Pass. Asserted: ≤ 1 death an hour at 28 and ≤ 2 at 34, > 14 kills a minute at 28 and > 13 at 34, kills × 0.7–0.95, XP > × 1.1, gold > × 1.05 (6.1's `builds.test.ts` asserts the same shape at +10 Void).

**Pass set pieces in a Depths kit** (B.5 item 10, re-measured): the best build at +10 Void, set pieces from the Pass (item level 25), the rest from the Depths (39), farming the Depths at 40 (kills/min):

| | warrior | mage | hunter | warlock |
|---|---|---|---|---|
| all Depths (39) | 15.3 | 15.7 | 18.1 | 15.7 |
| Pass set pieces + Depths | 15.2 (× 0.987) | 15.2 (× 0.971) | 17.8 (× 0.983) | 15.3 (× 0.976) |
| all Pass (25) | 12.8 (× 0.834) | 12.8 (× 0.818) | 15.4 (× 0.852) | 12.8 (× 0.821) |

An older set piece costs 1–3 % and keeps its slot until a newer copy drops (the mixed kit beats the Tyrant at 38 in every run); a whole older kit trails by 15–18 %, so newer drops still pay. Asserted: mixed ≥ × 0.95, all-Pass ≤ × 0.9, the mixed kit 8/8 at the Tyrant.

**Salvage.** Every older drop salvages into gold and materials the Forge still spends. A Legendary at item level 25: 44 gold and 3 soul shards, plus 4 timber (tier 1), 4 timber and 4 raw hide (tier 2) or 8 iron ore (tier 3, the Pass). Ore and shards are what the endgame's Forge asks for: the Tyrantforged Work (60 ore and 12 shards: the ore of 7.5 Pass Legendaries), every tier-4 upgrade, reroll and improvement, a Depths item's +10 path (B.5 item 10: 677 ore, 41 shards).

**Materials and their live sinks** (a scan of the content data: Forge recipes, the Forge's upgrade/reroll/improve costs by item tier, awakening, community stages):

| Material (phase) | Repeatable sinks | One-off sinks (community stages) | Spent by Phase 6 |
|---|---|---|---|
| Timber (2) | Fieldsmith's and Marchwarden's Work; the Forge on tier-1 and tier-2 items | the Warehouse | |
| Ashwort (2) | Fieldsmith's and Knightly Work | the Ashen Pass | |
| Raw hide (2) | Marchwarden's Work; the Forge on tier-2 items | the Warehouse | |
| Iron ore (2) | Knightly Work, **Tyrantforged Work**; the Forge on tier-3 and **tier-4** items | the Warehouse, the Ashen Pass, **the Forgeward Outpost** | yes |
| Soul shards (2) | Marchwarden's, Knightly and **Tyrantforged Work**; the Forge's essence on every item; **awakening** | the Ashen Pass, **the Forgeward Outpost** | yes |
| Abbey silver (2) | **none** (6.11: **the engraver's silver inlay**) | the Ashen Pass, **the Forgeward Outpost** (6.11: the exchange) | one-off only (6.11: yes) |
| Gravewarden Seal (2) | **awakening** (6.11: and **the engraver's seal-wax**) | the Ashen Pass (6.11: the exchange) | yes |
| Tyrant's Ember (6) | Tyrantforged Work, awakening | the Forgeward Outpost | (Phase 6's own) |

Every older material but Abbey silver has a repeatable sink, and the endgame's own sinks spend three of them (ore, shards, Seals). **Abbey silver** is the exception: once a town has built the Forgeward Outpost (80 silver) it is only traded. A known gap, recorded for the owner (like B.5 item 8's spare Seals), not changed here. Asserted exactly, so a new sink (or a lost one) shows up in the guard. **Since 6.11** (below, "6.11"): every older material has a repeatable sink; the engraver spends Seals and Abbey silver, and the guard asserts the new list.

**Older sources still drop what the endgame uses.** The crypt's hoard drops a Gravewarden Seal at every tier, I–III included (an awakening input). Every set piece in the endgame's best builds (the Pass farming builds and the Tyrant builds below: the Drowned Vigil, the Ashen Choir, the Bloodmoon Hunt) drops from older tables (the Abbey, the crypt's tiers I–III, the Pass and their bosses), and the crypt's tiers II and III still focus the Vigil and the Choir. Every older area yields at least one material with a repeatable sink (the Abbey's ore; its silver, above, had none until 6.11's engraver).

### 2. Meaningful choices

**Void against Prismatic** (B.2 search, every piece +10 of one variant; the Tyrant at 38 with item level 37, kill time over 12 seeds; the Depths at 40 with item level 39, kills a minute). Prismatic ÷ Void:

| | warrior | mage | hunter | warlock |
|---|---|---|---|---|
| Tyrant 38, kill time (below 1: Prismatic faster) | 0.970 (10.43 vs 10.75 s) | 1.010 (8.61 vs 8.52 s) | 0.985 (9.12 vs 9.26 s) | 1.007 (10.58 vs 10.50 s) |
| Depths 40, kills (above 1: Prismatic faster) | 0.999 | 1.011 | 1.007 | 0.998 |

A sidegrade (within 3 % everywhere; asserted 0.95–1.05), and which one leads depends on the build and the job: Prismatic for the warrior's and hunter's Choir builds at the Tyrant, Void for the mage's and warlock's Vigil builds; in the Depths Prismatic for the mage and hunter, Void for the warrior and warlock. Asserted: each variant leads at least twice. (Duels: B.5 item 4, unchanged.)

**Awakening** (the shipped option, an item's own effect × 1.1, on the better of each class's two Tyrant builds; the same build awakened, not re-searched):

| | warrior (Prismatic) | mage (Void) | hunter (Prismatic) | warlock (Void) |
|---|---|---|---|---|
| Tyrant 38: full kit | 10.43 → 9.70 s (+7.5 %) | 8.52 → 8.27 s (+3.1 %) | 9.12 → 8.21 s (+11.0 %) | 10.50 → 9.94 s (+5.6 %) |
| Tyrant 38: best single piece | +0.0 % | +0.8 % | +4.9 % | +1.2 % |
| Heroic 36: full kit | +4.5 % | +5.5 % | +10.0 % | +6.1 % |
| unawakened: Tyrant · Heroic win rate | 100 · 100 % | 100 · 100 % | 100 · 100 % | 100 · 100 % |

One awakened piece is small (under 5 %), a whole awakened kit kills the late bosses 3–11 % faster (6.5 measured 4.8–9.5 % with the build re-searched for it), and it is not required: the same kit unawakened wins every run. Asserted: full kit +2 to +12 % at both bosses, every single piece < 5 % at the Tyrant, unawakened 12/12 at both. The hunter's +11 % at the top of the range is B.5's hunter burst build (an accepted risk, B.5b item 1).

**The weekly modifiers** (B.5 item 6's seeds; 8 Legendary kits at +5, item level 33 (item level 25 without upgrades at the Warden), × 32 seeds per class; win-rate change in points, burning / warded / frenzied / unyielding / relentless):

| Boss (no modifier) | warrior | mage | hunter | warlock | mean | hardest per class |
|---|---|---|---|---|---|---|
| Heroic 34 (90 / 82 / 79 / 93 %) | −1.6 / −6.3 / −7.0 / −4.7 / −7.0 | −3.5 / −10.2 / −10.5 / −10.9 / −14.5 | −3.1 / −8.2 / −8.2 / −11.3 / −12.9 | −1.6 / −3.9 / −5.5 / −3.9 / −7.8 | −2.4 / −7.1 / −7.8 / −7.7 / −10.5 | Frenzied = Relentless, Relentless, Relentless, Relentless |
| Tyrant 36 (91 / 78 / 78 / 91 %) | −3.5 / −7.0 / −4.7 / −7.0 / −11.3 | −8.2 / −8.6 / −7.0 / −7.0 / −10.2 | −14.5 / −9.4 / −9.4 / −8.6 / −8.6 | −2.3 / −2.0 / −5.5 / −1.6 / −6.3 | −7.1 / −6.7 / −6.6 / −6.1 / −9.1 | Relentless, Relentless, **Burning**, Relentless |
| Ashen Warden 26 (73 / 57 / 71 / 74 %; not asserted) | −3.5 / −7.4 / −7.0 / −8.2 / −9.8 | −9.0 / −12.1 / −11.3 / −11.3 / −16.4 | −3.9 / −4.3 / −3.5 / −3.5 / −6.6 | −11.7 / −12.1 / −12.9 / −12.5 / −18.8 | −7.0 / −9.0 / −8.7 / −8.9 / −12.9 | Relentless everywhere |

Every modifier makes the week harder (−2 to −11 points on average at the endgame bosses), and classes feel them differently: Burning costs the warlock 2 points at the Tyrant and the hunter 14.5; Unyielding costs the warrior 5 at Heroic and the hunter 11. **Relentless is the hardest on average at every boss**, but by only 2.0–2.7 points over the next at the endgame bosses (3.9 at the Warden), not the 5–10 points by which Warded led before B.5; Burning is the mildest at Heroic. Asserted at Heroic 34 and the Tyrant 36: every mean below 0 and above −15 points, the hardest within 5 points of the next, some modifier's cost differs by 6+ points between classes (measured 7.4 and 12.2), and at least two different modifiers are some class's hardest. A watch item, not a change: if live data shows Relentless weeks skipped, it is the next modifier to soften (as Warded was in B.5).

### 3. No new system is required in PvE

Verge drops only (item level 33): no Prismatic, no awakening, no Tyrantforged Work, no Heroic loot, no Forgeward bellows. B.5's boss seeds (`b5-boss`), so the Tyrant 36 row equals B.5 item 2's +5 column.

| Kit | warrior | mage | hunter | warlock |
|---|---|---|---|---|
| Plain Legendaries +5 (8 kits × 12 seeds): Tyrant 36 · 38 · Heroic 34 | 80 · 86 · 85 % | 71 · 76 · 72 % | 68 · 75 · 70 % | 91 · 92 · 91 % |
| Best Pass build at +5 (no Void): Tyrant 38 · Heroic 34 | 100 · 100 % | 100 · 100 % | 100 · 100 % | 100 · 100 % |
| Best Pass build at +10 Void: Tyrant 38 · Heroic 34 | 100 · 100 % | 100 · 100 % | 100 · 100 % | 100 · 100 % |

Plain upgraded Verge Legendaries beat both late bosses seven to nine times in ten; a built kit of the same drops never loses. Asserted: plain Legendaries +5 ≥ 65 % at the Tyrant 38 and Heroic 34 for every class, the built kits 16/16 at both. Farming needs no new system either: the Verge (section 1) and the Depths (B.5 item 10, 6.2) are farmed in plain and Void kits.

### Verdict and open points

The criterion holds on every measure: older gear moves into the new region and earns more there, older drops keep a slot, a salvage value and a sink, the new systems are choices (a sidegrade, a modest late step, a weekly twist), and none is needed to beat the hardest PvE content. Open points for the owner, none blocking: **Abbey silver** has no repeatable sink once the Forgeward Outpost is built; **spare Gravewarden Seals** (B.5 item 8, sink planned in 6.11); **Relentless** is the hardest modifier on average by a small margin (watch); the hunter's full awakened kit at +11 % is its accepted burst build (B.5b).

## 6.11: the Gravewarden Seal and Abbey silver sinks

Owner decisions on B.5 (item 8, the spare Seals) and on 6.10 (question 1, Abbey silver): sinks for both, **no new power**. Built: the Forge's **engraver** (repeatable) and **the Seal and Silver Counter**, an exchange for five collection-book cosmetics (once each per account). Prices and rules: `docs/ECONOMY.md` "Seal and silver sinks", `docs/COSMETICS.md` "The exchange and engravings". Tool: `pnpm --filter @worldforge/server exec tsx ../../tools/balance/endgame.ts sinks` (`SEASON_DAYS`, `SILVER`); guard `packages/game-core/src/balance/seal-flow.test.ts`; the season model is game-core's `balance/seal-flow.ts` (expected values a day at a time).

**The realistic player** (B.5): a dedicated hero in Verge Legendaries +10 at 38, five tries a day at the Tyrant's and the crypt's hoards (one Ember and one Seal a day for every class: 1.00 / 1.00), the guild boss's two Seals a week, an awakening whenever it can pay (Embers and Seals gate it; gold takes 4–9 hours). With the sinks it spends **only the Seals above its reserve** (two per piece still to awaken, the Forge's warning) on the exchange first, then on an engraving of each kit piece (seal-wax while Seals are spare, silver inlay with silver beyond what the unbought offers need). **Abbey silver**: only gathered in the Sunken Abbey; a dedicated hero levelling 17 → 23 there (Epic gear +5, 24–27 h of farming, 1.6–1.8 days) gathers **195–219** (7.3–8.8 an hour) and none at the endgame; after its share of the town works (the Ashen Pass and the Forgeward ask 180 of the whole town) **150** is the modelled stock.

**Before and after** (a 56-day season from the first Tyrant win):

| class (pieces) | before: kit done · spare Seals then · at season end | after: kit done · spare Seals then (spent on sinks by then) · season: Seals to sinks · engravings · Seals left · silver left |
|---|---|---|
| warrior (9) | day 27 · 16.7 · 54.0 | day 27 · 3.7 (13) · 17 (all 5 offers) · 9 · 37.0 · 0 of 150 |
| mage (8) | day 25 · 16.1 · 56.0 | day 25 · 1.1 (15) · 15 (all 5) · 8 · 41.0 · 0 of 150 |
| hunter (8) | day 24 · 14.9 · 56.0 | day 24 · 3.9 (11) · 15 (all 5) · 8 · 41.0 · 0 of 150 |
| warlock (8) | day 24 · 14.9 · 56.0 | day 24 · 3.9 (11) · 15 (all 5) · 8 · 41.0 · 0 of 150 |

With only 40 silver (`SILVER=40`, a player who gave most of it to the town): the same kit days, spare Seals at the kit 1.1–1.9, 23–25 Seals to the sinks over the season (3 of 5 offers, the rest Seal-pressed engravings), 15 silver left.

**Reading.**
- **Awakening isn't starved:** the kit lands on the same day with and without the sinks for every class (24–27 days, B.5's band, about one season), because the sinks only take Seals above the reserve. The guard asserts the day, the Seals awakening used, and the band.
- **The spare Seals get a use:** 15–17 spare at the kit → 1–4; the exchange (9 Seals once) and engraving a kit (2 Seals a piece) are about what a dedicated player has left over.
- **After the kit** Seals still come in (about 1.3 a day); the engraver is the repeatable sink for them (a new engraving on every new piece or a change of words, 2 Seals each). It is a sink, not a drain: nobody has to spend them, and it is never needed.
- **Abbey silver** has a repeatable sink again (15 a silver inlay) and 75 in the exchange; a dedicated hero's Abbey stock lasts the exchange and a kit's worth of inlays.
- **Regular and casual players** reach the kit later (48–54 and 96–108 days, B.5); the reserve rule is the same for them, so the sinks never slow their awakening either.
- **Unchanged:** no gameplay number moved. No rule reads an engraving or an exchanged cosmetic (the cosmetics import scan covers `cosmetics/exchange.ts`); the no-effects hashes, the curve pins, Gear Score, Power, PvE Progress and the duel rules are unchanged (no version), and the server tests assert that engraving and buying every offer leave a hero's 5.1 scores identical.

## 8.2: the Hollow Deep, the Hollow Sovereign and the exit criterion again
Ticket 8.2 adds Region III's second area, the Hollow Deep (46–52), its region boss, the Hollow Sovereign (the Hollow Throne, level 48 door, boss level 52), and the community gate in front of both (`docs/WORLD.md`, `DUNGEONS.md`, `COMMUNITY.md`), tuned against the best Pale Marches gear. **No value at or below level 46 moved** (`balance/curve-pins-8-2.test.ts`, hashes computed on `main` before 8.2, commit 5f6e017: the Marches at 40 / 43 / 46 and the Depths at 40, Tyrant runs at 46 with and without a modifier, a Heroic run, the Marches' and the Tyrant's rolls at 41–47, the merchant, the XP curve to 46; 8.1's, 6.2's and 6.1's pins, the no-effects hashes and every earlier balance suite pass unchanged). New numbers, all new content (before → after):

| | Before 8.2 | After |
|---|---|---|
| Top area | the Pale Marches, 40–46 (tier-5 drops 41–47) | the Hollow Deep, 46–52 (tier 5, 47–53) |
| Region boss | the Forge Tyrant (40) | + the Hollow Sovereign (52): siphon (heals half of each landed blow), crown-blow every 4th × 2.5 |
| Boss material · sink | Tyrant's Ember · Tyrantforged Work, awakening, the beacon | + Shard of the Hollow Crown · Crownforged Work (tier 5, Rare/Epic, ≤ 53); embers gain the lanterns |
| XP soft cap (a level takes > 40 h) | about 54 | about **57–58** (no constant changed) |
| PvE Progress · Power · Gear Score | 5 (21) · 3 · 2 | **6 (25)**, chained after 8.1's pending switch · 3 (trials at 48 and 52 exist) · 2 |
| Community · era | the Forgeward Outpost · the Forgeward Age | + the lanterns of the deep (3 stages, 400,000 gold, ten givers a first day) · the Lantern Vigil |
| 30+ 90 %+ / 95 %+ favourites (heroes to the top level) | 3.7 % / 1.2 % (to 46) | 2.2 % / 0.8 % (to 52) |

**The exit criterion, extended again** (`balance/hollow-deep-balance.test.ts`, `phase6-exit-criterion.test.ts` "extended again: the Hollow Deep"):
- **The best Marches gear farms the new area.** The Marches' Legendaries +10 (item level 47, with class effects), plain and awakened, farm the Deep at 46, 49 and 52 with **no deaths**: 6.6–9.9 kills a minute, 0.92–0.95 × their Marches pace at 46, XP × 1.07–1.11 and gold × 1.06–1.13 the Marches' top (`docs/COMBAT.md` "The Hollow Deep").
- **The Sovereign is beatable around 48–50 in good Marches gear, but not trivially** (win rates over 4 classes × 4 kit samples × 12 seeds, `docs/DUNGEONS.md` "The Hollow Throne"): Marches Legendaries +0 about 10 %, +5 about 40–55 %, **+10 about 85 %** (every class above 50 %), awakened about 89 %; the Deep's own Legendaries +10 win every run; the Depths' best +10 about 40 %, always below the Marches' +10. The weekly modifiers cost the +10 kits 3–8 points.
- **Heroic, the Tyrant and the Cinderwastes keep uses.** Their tier-4 drops salvage into the ore and shards the Crownforged Work and the tier-5 Forge spend (and the Deep yields both); the Tyrant's Ember keeps its recipe and awakening and gains a one-off sink (the lanterns' ten); the crown shard's only sink is its recipe (no awakening input, no project need). Every older material keeps a repeatable sink (unchanged scan).
- **Its own drops are worth chasing:** a level-46 hero's Marches gear holds the Deep, but the Deep's Legendaries +10 take the Sovereign from 85 % to 100 %.

**The curves.** Hours per level for the Marches' Legendaries +10 farming the best open area (`hollow-deep-balance.test.ts`, `tools/balance/hollow-deep.ts xp`): before the Deep 7–8 h at 50, 11–15 h at 52 and 47–64 h from 54; with it 4–5 h at 50 and 52, 4–6 h at 54, 7–9 h at 56 and 12–16 h at 58. The XP formula and the level penalty are unchanged: with foes up to 52 the penalty's floor arrives about four levels later, so the soft cap moved with the content again, from about 54 to about **57–58** (the roadmap's "about 55" plus the Deep's extra level of reach; documented, not tuned).

**Open points.** (1) Class spread at the Sovereign: with Marches +10 the hunter wins every run, the mage and the warlock 69–81 % (a wider spread than the Tyrant's 17–23 points after B.5); the siphon punishes slower kills. Left for B.6 with live data. (2) The Depths' best +10 still wins about 40 % (the warrior's and hunter's kits far more than the mage's 0 %): older gear is a long shot, not a wall. (3) Live telemetry should confirm the lanterns' pace with the real town.

## 8.1: the Hollow Reach and the Phase 6 exit criterion
Ticket 8.1 adds Region III's first area, the Pale Marches (40–46, `docs/WORLD.md`), tuned against today's best gear. **No value at or below level 40 moved** (`balance/curve-pins-8-1.test.ts`, hashes computed on `main` before 8.1; the no-effects hashes, 6.1's and 6.2's pins and every earlier balance suite pass unchanged). New numbers, all new content (before → after):

| | Before 8.1 | After |
|---|---|---|
| Top area | the Cinder Depths, 34–40 | the Pale Marches, 40–46 (tier-5 drops 41–47) |
| Top item tier · affix tier | 4 (from 29) · 5 (from 31, base ≥ 30) | 5 (from 41) · 6 (from 43, base ≥ 42) |
| XP soft cap (a level takes > 40 h) | about 48 | about 54 (no constant changed) |
| Power · PvE Progress | 2 (22 trials) · 4 (18 milestones) | 3 (24 trials) · 5 (21), between seasons |
| 30+ 90 %+ / 95 %+ favourites (heroes to the top level) | 4.0 % / 0.7 % (to 40) | 3.7 % / 1.2 % (to 46) |

**The Phase 6 exit criterion, extended** (`phase6-exit-criterion.test.ts` "Phase 6 exit, extended"): Phase 6 content stays relevant in the Hollow Reach.
- **Phase 6 gear farms the new area.** The best Depths build per class (the file's own search, +10 Void, item level 39), plain and awakened, farms the Marches at 40 with no deaths (and none at 46): 14.5–18.1 kills a minute, 0.88–0.93 × its Depths pace, XP × 1.09–1.14 and gold × 1.17–1.21 the Depths' at 40. The plain Depths and Heroic Legendaries +10 do the same at 6.5–10 kills a minute (`pale-marches-balance.test.ts`, `docs/COMBAT.md` "The Hollow Reach").
- **Phase 6 drops keep their uses.** A tier-4 Legendary salvages to 12 iron ore and 3 soul shards; the tier-5 Forge spends both (4 ore a unit), and the Marches drop both, so every Pass, Verge and Depths drop's salvage and +10 path stays live. The Tyrant's Ember keeps its sink (Tyrantforged Work). No new material and no new recipe.
- **Its own drops are worth chasing:** the Marches' plain Legendaries +5 (item level 45) kill 1.10–1.32 × as fast at 46 as the same kits at 39 (four kits each), without a new power curve beyond the tier step.

**Open points:** at the area's top (46) a plain item-level-39 kit without class effects can begin to fall (the tool's mage sample: about 7 deaths an hour), the intended gear check before 8.2's second area. Live telemetry (B.6) should confirm the entry pace and the soft cap with real players.

## Phase 8 exit criterion (ticket 8.7)

*The live town has a new endgame region beyond level 40 that keeps Phase 6 content relevant, a self-running calendar of events, better everyday comfort, and a clear going-live checklist. Everything is reconciled, fair and free of pay-to-win.* A record, not a pass: no number changed. game-core `balance/phase8-exit-criterion.test.ts` (fixed seeds, four one-hour settlements per case, Legendary kits +10 from `kits.ts`); server `phase8-no-pay-to-win.test.ts`. The farming numbers here are kit-level means, so they differ a little from 8.1's and 8.2's build searches (`pale-marches-balance.test.ts`, `hollow-deep-balance.test.ts`).

**1. Phase 6 content stays relevant next to Region III.** Class order: warrior / mage / hunter / warlock.

| | warrior | mage | hunter | warlock |
| --- | --- | --- | --- | --- |
| Depths Legendaries +10 at 40: Pale Marches ÷ Cinder Depths, kills a minute | 0.90 | 0.91 | 0.86 | 0.91 |
| … XP an hour | 1.12 | 1.13 | 1.06 | 1.13 |
| … gold an hour | 1.25 | 1.10 | 1.10 | 1.31 |
| Heroic Legendaries +10 (item level 37) in the Marches at 40, kills a minute (no deaths) | 8.2 | 7.5 | 8.5 | 7.1 |
| Marches Legendaries +10 at 46: Hollow Deep ÷ Marches, kills a minute | 0.96 | 0.92 | 0.92 | 0.93 |
| … XP an hour | 1.12 | 1.07 | 1.08 | 1.09 |
| … gold an hour | 1.00 | 1.11 | 1.13 | 1.07 |

- **No deaths.** Phase 6's best drops open the Hollow Reach as a step up (slower kills, more XP and gold), and the Marches' best open the Deep the same way.
- **The Tyrant's Ember** comes only from the Tyrant's Forge, and **the Gravewarden's Seal** only from the crypt (Heroic its top tier); no Region III place drops either. Both still pay for Item Awakening, which also works on tier-5 Legendaries (3 Embers and 2 Seals a piece), and the town needed ten Embers for the lanterns of the deep.
- **Heroic keeps the best Prismatic odds** (7.5 % against the Hollow Reach's 5 %).
- Phase 6 drops salvage into the ore and shards the Crownforged Work and tier-5 Forge work spend (8.1, 8.2 extensions of the Phase 6 guard).

**2. The calendar runs on its own.** A year with nobody touching it, from the rotation the exit run uses (the Lantern Procession 28 days, the Harvest of Bones 7):
- every event starts on a Monday at 00:00 UTC, gets its full length (the Procession all four of its weeks, 8.3b), never overlaps, and follows the rotation in turn;
- **15 events a year (8 Processions), 273 days with an event**, whatever the gap from 0 to 7 days. Both events end on a Monday, so a gap of 0–7 days always lands on the following Monday: a one-week pause. The gap only matters above a week, or for an event that ends mid-week.
- The exit run saw it for real: created once at the next Monday, the weeks opening on their boundaries, closed once at the end, the Harvest put on the first Monday at least the gap later, once.

**3. No pay-to-win.**
- Event tracks grant only catalogue cosmetics (keys `tier`, `tallies`, `cosmeticId`), and the two world modifiers (`killBounty`, `gatherBounty`) hand out a material, never a stat, odds or XP.
- Cosmetics carry only `id`, `kind`, `name`, `description`, `source`. Hall upgrades carry only `id`, `kind`, `name`, `description`, `price`. Guild honours are catalogue cosmetics.
- The import scan: no game-core rule (combat, scoring, PvP, loot, dungeons, items, farming, economy, world, quests) imports the cosmetics, guild-hall, guild-season or event modules. On the server, the scores, the boards and the arena import them only for looks (the duel screen's palettes) and the guild roll's recompute check.
- Invariance: a level-46 hunter's four scores, its stored duel defence (snapshot and bracket Power) are equal before and after its account owns and wears every cosmetic and its guild buys and hangs every hall upgrade.

