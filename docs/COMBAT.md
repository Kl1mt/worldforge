# Combat simulation (game-core)

Ticket 1.4. Pure, deterministic rules in `packages/game-core/src/combat/`; content in `packages/game-core/src/world/`.
The server (ticket 1.6) is the only caller that may award results; it derives the seed itself.

## Content
- `world/enemies.ts`: all enemies of Graumark (ticket 2.1 added the Phase 2 areas, the crypt and the Gravewarden; see `docs/WORLD.md`). Each stat is `base + perLevel · (level − 1)`; `damageType` picks the defense that mitigates it.
- `world/areas.ts`: the five areas with level ranges, spawn weights, unlock rules and loot tables (`docs/WORLD.md`). Abandoned Fields: enemy levels 1–6, spawn weights 50 / 35 / 15.
- `combat/characterStats.ts`: per-class base stats and per-level growth (`CLASS_STAT_PROFILES`).
- `combat/skills.ts`: one auto-skill per class that replaces every n-th basic attack (Heavy Strike, Firebolt, Aimed Shot, Shadow Bolt). No resource costs yet.
- `combat/encounter.ts`: `DEFAULT_COMBAT_CONFIG` holds every tunable (search time, regeneration, respawn delay, fight timeout, mitigation and XP-penalty constants).

## Stats
`deriveCharacterStats(classId, level, equipment)` adds class base, level growth and each item's `EquipmentStatContribution` (additive, in stat units), then clamps to `STAT_LIMITS` (crit chance ≤ 75 %, attack speed 0.25–4/s, nothing negative). Units: `attackSpeed` attacks/s, `critChance` 0–1, `critDamage` multiplier (1.5 = 150 %). Non-finite inputs throw.

Loot → combat bridge (`packages/game-core/src/equipment.ts`, ticket 1.7): `itemStatContribution(item)` turns a `GeneratedItem` into its `EquipmentStatContribution`: implicit stats (`getImplicitStats`: base scaled by item level and rarity) plus every affix on a core stat, summed. Gold find is not a combat stat and is left out; `itemSecondaryModifiers(item)` returns it uncapped (the cap before `rollLoot` is ticket 1.6's). `deriveEquippedStats(classId, level, items)` is `deriveCharacterStats` over those contributions. `checkEquip(baseId, classId, slot)` holds the equip rules (slot fits the base's kind, class allowed; GDD §7.1) and `defaultEquipSlot` picks a slot when the player names none (first free ring slot for rings).

## Rules
- **Damage:** the class's primary damage stat (physical or magic) × skill multiplier × crit multiplier × (1 − mitigation), rounded, at least 1. Enemies never crit.
- **Mitigation:** `defense / (defense + 50 + 10 · attackerLevel)`, capped at 75 %. Armor applies to physical damage, resistance to magic.
- **Enemy roll:** weighted enemy pick, then level = character level ± 1, clamped to the area range.
- **XP:** enemy XP × level factor (−15 % per level the character is more than 2 above the enemy, minimum 10 %). `xpToNextLevel(L) = 700 · L²` (ticket B.1; Phase 1 was `round(80 · L^1.6)`), cap level 60. A new curve must never ask less than an older one at any level, or stored XP could exceed the requirement. Level-ups recompute stats and restore full health.
- **Cycle:** search 2 s (regenerate 10 % max health per second) → fight → if the character died, respawn after 10 s at full health. A fight that lasts more than 30 s is abandoned without reward (timeout).
- **Timeline:** times are whole milliseconds. The character attacks at `j · interval`, the enemy at `k · interval` (j, k ≥ 1, interval = round(1000 / attack speed)). On equal timestamps the character acts first.
- **Window end:** a cycle that would finish after the window is not applied. Its time is returned as `unusedMs`; the caller carries it into the next settlement, so no time is lost and nothing is half-awarded.

## Two simulations, one model
Both run the same cycle loop (`runFarming`); only the fight resolution differs.
- `simulateFarming` (detailed): rolls the crit of every attack and records a compact event log (`spawn`, `attack`, `enemyAttack`, `kill`, `timeout`, `death`, `respawn`, `levelUp`), keeping the most recent `maxEvents` (default 200).
- `simulateFarmingAggregate` (offline settlement): for each fight it computes the exact distribution of the killing attack (dynamic programming over damage totals, cached per encounter setup), samples it with a single RNG draw, and derives enemy hits, death and timing in closed form. No events.

**Per-cycle RNG (ticket 1.9).** With `firstCycle` set, cycle `i` of a window draws from its own stream `${seed}:${firstCycle + i}` instead of one stream per window, and `onCycle` reports each committed cycle (index, outcome, enemy, level at its start). A cycle's outcome then depends only on the seed, its global index and the state at its start, so a window cut short just ends earlier on the same sequence: settling every second gives exactly the result of one settlement at the end. Offline settlement (`settleFarming`) always uses it. Before, each settlement re-rolled the unfinished cycle; long cycles (deaths with respawn, slow fights) were discarded more often, and settling every second cut a level-1 warrior's deaths from ≈6.4 to 0.1 per hour and raised kills by ~20 %.

Both are deterministic for a given seed. They consume the RNG differently, so the same seed gives different (but equally distributed) results. Tests compare them per fight (20,000 trials) and per farming window (300 seeds, means within 4 standard errors). A 3-hour window settles in about 10 ms with either function at Phase 1 numbers.

## Unique effects (ticket 3.2)
Legendary effects and Mythic signatures act in both simulations through one pricing function (`attackHit`), an extended exact distribution (`killDistribution`) and the shared cycle loop (life on kill, bloodrush stacks carried as `momentum`). With no effect equipped every number is unchanged (pinned test). Details, numbers and the balance results: `docs/EFFECTS.md`.

## Results
`FarmingResult`: kills (total and per enemy of the area's roster), deaths, timeouts, encounters, XP gained, start/end level and XP, levels gained, damage taken, final and max health, bloodrush `momentum` (3.2), `simulatedMs` / `unusedMs`, and the event log.

## Balance (ticket B.1)
Every number below is data or config in `packages/game-core` (no rule changed). `src/balance/balance.test.ts` simulates every class in every area and fails if a value leaves its band, so new content cannot silently break the pacing (runs in ~3 s; it fails 13 of its 15 checks against the pre-B.1 numbers). Gold, prices and materials: `docs/ECONOMY.md`.

**Terms.** *Geared* = one common item per droppable slot (both rings) of the best tier the class can use, at item level = character level − 1: what a player who equips their drops wears. *Lagging* = the same kit three levels behind. *Damage share* = damage taken per encounter ÷ max health.

**How deaths work.** Between fights the hero regenerates 20 % of max health (2 s search at 10 %/s). While the damage share per fight stays below that, the hero is back at full health before every fight and practically never dies; above ~20 % health ratchets down and deaths become frequent. Deaths per hour are therefore a cliff in the damage share, so the tuning targets the share: a geared hero sits at 10–20 %, a lagging one near 20 %, an unequipped one far above it outside the Fields. Within an area the enemies' level follows the hero's (± 1), so an area's difficulty is set by its enemy stats, not by the hero's level.

### Targets (asserted in the balance test)
| What | Target |
|---|---|
| Fresh level-1 hero, no gear, Fields, 30 min | ≤ 3 deaths/h for every class |
| Geared hero at any area's min, middle and max level | ≤ 2 deaths/h; damage share < 21 % |
| Class fairness (area min and middle level) | damage share max/min < 1.35; deaths differ by ≤ 2/h |
| Lagging gear at an area's middle level | ≤ 10 deaths/h (costly, not constant) |
| Step up | an area's entry damage share > 1.15 × the previous area's at its top level, and > 12 % |
| Kill rate (geared, middle level) | 7–12 kills/min |
| Hours of farming per area, fresh hero re-equipping every 30 min | Fields 1→5: 1.2–4 h · Crowwood 5→9: 4–10 h · Burial 9→13: 8–16 h · Blackwater 13→17: 10–22 h · Abbey 17→22: 18–40 h · total to 22: 45–85 h |
| One 3 h offline window from an area's entry | ≤ +2 levels (Fields from level 1: ≤ level 6) |
| Crypt (see `docs/DUNGEONS.md`) | naked level 16 and geared level 12 never win; geared level 15 ≥ 90 %; uncommon level 14 always; boss fight > 80 % of the enrage time and costs > 30 % health; run XP per hour 1–2.2 × farming |

### Changes
- **Class profiles** (`CLASS_STAT_PROFILES`): mage health 100 + 10/level → 125 + 14/level, armor 8 + 1/level → 18 + 3/level; hunter health 110 + 11 → 125 + 12.5, armor 12 + 2 → 15 + 2.5; warlock health 115 + 12 → 130 + 14, armor 10 + 1.5 → 17 + 2.8, resistance 15 → 16, magic damage 10 + 2.1 → 11 + 2.2. The warrior is unchanged and stays the tankiest (shield, most armor); the mage keeps the highest burst. The casters died 4–5× more because their armor did not scale while most enemies deal physical damage.
- **Enemy damage** (`world/enemies.ts`, health and XP unchanged): Fields −12 % (farmhand 5.3 + 1.45/level, wolf 4.4 + 1.15, scarecrow 7 + 1.8) so a naked start is safe; later areas were softer against level-appropriate gear than the Fields and now step up: Crowwood × 1.22, Old Burial Grounds × 1.9, Blackwater × 1.7, Sunken Abbey × 2.25, crypt ghoul × 1.9, bone acolyte × 1.3.
- **XP curve** `700 · L²` (was `80 · L^1.6`, 9–60× more per level). Enemy XP is unchanged; story-quest XP is rescaled to the same share of a level (600, 1,800, 10,000, 30,000, 60,000); contract XP already scales with the curve.
- **Gravewarden**: 880 + 176/level health (3,520 at 16, was 1,600), 4 + 0.86/level damage, enrage at 45 s for × 1.8 damage and × 1.4 attack speed (was 60 s, × 2, × 1.5), XP 600 + 160/level.

### Before → after
Fresh level-1 hero without gear, Fields, deaths per 30 min (10 seeds): warrior 6.5 → 0.0, mage 29.1 → ≤ 0.2, hunter 20.0 → 0.0, warlock 24.7 → ≤ 0.2.

One 3 h offline window starting at each area's entry level, geared for the entry level and not re-equipped (2 seeds; deaths warrior / mage / hunter / warlock):

| Area (entry) | Deaths before | Deaths after | Levels gained before → after |
|---|---|---|---|
| Abandoned Fields (1) | 0 / 9.5 / 0.5 / 5.5 | 0 / 0 / 0 / 0 | +12.3 → +4.0 |
| Crowwood (5) | 0 / 6.0 / 0 / 7.5 | 0 / 0 / 0 / 0 | +12.0 → +2.0 |
| Old Burial Grounds (9) | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | +11.3 → +1.0 |
| Blackwater (13) | 0 / 0 / 0 / 0 | 0 / 0.5 / 0 / 0 | +11.0 → +0.0 |
| Sunken Abbey (17) | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | +11.0 → +0.0 |

Geared hero at each area's middle level, 1 h (3 seeds, mean of the classes):

| Area (level) | Kills/min | XP/h before → after | Hours for that level before → after |
|---|---|---|---|
| Abandoned Fields (3) | 9.6 → 9.4 | 13,679 → 11,333 | 0.03 → 0.56 |
| Crowwood (7) | 10.3 → 10.3 | 22,824 → 19,252 | 0.08 → 1.8 |
| Old Burial Grounds (11) | 9.9 → 10.1 | 31,666 → 28,158 | 0.12 → 3.0 |
| Blackwater (15) | 8.7 → 9.0 | 39,593 → 37,120 | 0.15 → 4.2 |
| Sunken Abbey (19) | 9.4 → 9.6 | 51,978 → 48,917 | 0.17 → 5.2 |

Fresh hero farming the highest open area and re-equipping every 30 min reaches level 5 / 9 / 13 / 17 / 22 after 0.5 / 1 / 1.5 / 2 / 3 h before, and 2–2.5 / 8–9 / 19–21 / 33.5–38 / 57–65 h after (all classes within ~15 % of each other; 0–3 deaths in the whole run).

Damage share of a geared hero (warrior / mage / hunter / warlock), area entry → top: Fields 11/11/10/11 → 9/10/9/10 %, Crowwood 18/16/15/15 → 12/11/11/11 %, Burial 15/18/16/17 → 12/15/12/14 %, Blackwater 16/19/16/17 → 12/13/11/14 %, Abbey 16/18/15/17 → 16/18/14/16 %.

**Known limits.** An unequipped hero beyond the Fields dies every minute or two (damage share 35–60 %): gear is the core loop and onboarding (2.7) teaches equipping. A lagging kit at an area's *entry* (above all the Sunken Abbey at 17, where tier-3 gear starts at item level 15) still costs 3–40 deaths/h (worst: mage and warlock), and a kit with only 5 of 9 slots costs 5–24 deaths/h in Blackwater and the Abbey. Casters remain the squishier classes against the physical-only Old Burial Grounds (damage share ~1.2 × the warrior's).

### Phase 1 baseline (ticket 1.9, before B.1)
Starting numbers for later balancing: a fresh level-1 character farming Abandoned Fields, no equipment, one `settleFarming` window, mean of 20 seeds (game-core defaults at ticket 1.9). Items = drops before the capacity rule.

| Class   | Window | Kills | Deaths | Timeouts | Level reached | Gold  | Items |
| ------- | ------ | ----- | ------ | -------- | ------------- | ----- | ----- |
| warrior | 30 min | 205   | 6.5    | 0        | 7             | 476   | 24    |
| warrior | 3 h    | 1629  | 6.8    | 0        | 13            | 4334  | 195   |
| mage    | 30 min | 165   | 28.8   | 0        | 6             | 368   | 19    |
| mage    | 3 h    | 1551  | 49.9   | 0        | 13            | 4129  | 187   |
| hunter  | 30 min | 196   | 19.1   | 0        | 7             | 451   | 23    |
| hunter  | 3 h    | 1734  | 23.8   | 0        | 13            | 4627  | 207   |
| warlock | 30 min | 159   | 24.6   | 0        | 6             | 352   | 19    |
| warlock | 3 h    | 1471  | 44.5   | 0        | 13            | 3907  | 177   |

Observations: almost all deaths happen in the first levels (a mage dies about once a minute at level 1–3, then rarely); the warrior barely dies. Casters lose ~15–20 % of their early kills to deaths and respawns. Every class reaches level 13 (the area's top) within 3 h, so the Fields stop giving XP-relevant challenge well inside one offline cap. The browser e2e runs (×120 clock, 30 min cap) match: warrior 1 death and mage 26 deaths in ~32 simulated minutes (ticket 1.8 saw 12 deaths in ~30 min).

## Build diversity (ticket B.2)
GDD §15 Phase 3 exit: "different item combinations create meaningful build choices … no single item or affix dominates all builds". `packages/game-core/src/balance/builds.test.ts` makes it testable (≈ 14 s, in parallel with `balance.test.ts`).

**The search** (`balance/builds.ts`). A late-game build per class: a set layout (none; the Drowned Vigil or the Ashen Choir at 2, 4 or 6 pieces; the Bloodmoon Hunt at 4; and the four two-set mixes; 12 in all), a Legendary in every other slot (base: the class's best regular base, median effect roll), an affix package for every item (`crit`: crit chance and damage; `speed`: attack speed; `power`: flat damage and the class skill; `guard`: health and defences; each item takes the first affixes its slot allows, at the middle of the highest tier its level unlocks), and a greedy effect search per layout and package (each slot in turn keeps the effect that helps most, never a copy). Two jobs: the **tier III Gravewarden** at level 23 in item-level-22 gear (mean boss time over 16 runs, a loss = 150 s) and **farming the Sunken Abbey** at level 19 in item-level-18 gear (kills/min, 2 × 40 min). Mythics are left out of the search (one per ~50 h of Abbey farming, a given one far rarer): a top-build check must not hinge on a drop nobody can plan for; they get their own band.

**Asserted.** Per class and job, at least three distinct builds (layout or package) within **7 %** of the best ("a few percent": boss times move by about 2 % between seed sets), from at least two set layouts; at the boss, no set in all of them. Over both jobs' top builds, no set, Mythic, Legendary effect or leading affix (the three most frequent, as in the 3.8 build signature) is in every one. The top boss builds stay within 12 % of each other at +10 Void (upgrades and Void pick no winner). The class Mythic weapon on the best build is faster, at most × 1.4.

**Before → after** (the same search on `main` before B.2; tier III Gravewarden; builds within 7 % · set layouts among them · what every one of them wears):

| Class | Before | After | Class Mythic weapon on the best build (after) |
|---|---|---|---|
| Warrior | 9.6 s; 2 builds · 1 layout, all Ashen Choir 6 | 10.6 s; 4 · 3 (Choir 6, Vigil 6, Vigil 4 + Choir 2) | 10.4 s (× 1.02) |
| Mage | 10.4 s; 1 · 1, Choir 6 | 9.6 s; 3 · 3 (Vigil 4, Choir 4, Choir 2) | 7.4 s (× 1.30) |
| Hunter | 8.1 s; 1 · 1, Choir 6 | 9.7 s; 3 · 3 (Choir 6, Choir 4, Vigil 6) | 8.2 s (× 1.18) |
| Warlock | 12.5 s; 3 · 2 | 11.6 s; 5 · 4 (Vigil 6, Choir 4, Vigil 4, …) | 9.3 s (× 1.25) |

Every top boss build of every class carries Tyrant's Bane, Emberbrand and crit chance: they are the boss's tools (boss damage, crit burn) and no farming top build needs them, so neither effect nor affix is in all top builds. Farming is unchanged by B.2 and decided by a breakpoint, not by the build: at 19 the Abbey dies in one or two blows and kills/min is capped near 23–24 by the 2 s search. The Bloodmoon Hunt's 4-piece opener (the class skill as the first hit) reaches the one-shot two or three levels earlier than other builds, so it is in every farming top build (hunters: Ambush does the same, so 42 builds of all 12 layouts tie); that is the farming set's job (3.3), and the best build without it is asserted within 20 % (≈ 17 % behind). Past level ~22 every late-game build one-shots the Abbey.

**What changed** (data and two rules; game-core):
- **An effect counts once** (`distinctEffects`): stacking copies of one Legendary effect (three Unbrokens, two Tyrant's Banes) was the shape of every best build. Different effects still add up to the caps.
- **Skill surges don't chain:** a surged class skill's crit no longer surges the next attack (`AttackHit.surged`). With its +25 % skill crit, the hunter chained Aimed Shots through the Ashen Choir's Hymn of Cinders.
- **Sets:** Last Rite (Choir 6) + 10 % to bosses and 1 % rot (were 15 % and 2 %): the full Choir was every class's best boss build. Hold the Line (Vigil 4) + 30 % (was 25 %), Undertow (Vigil 6) execute + 80 % (was 60 %).
- **Headsman's Due also rolls on rings**, so a second ring has a boss effect now that copies count once.
- Crypt tiers II and III: `docs/DUNGEONS.md`; drop rates: `docs/EFFECTS.md`; forge costs: `docs/ECONOMY.md`.

**The ticket's suspects.** *Ambush* (the strongest farming Legendary) works through the same one-shot breakpoint as the Bloodmoon opener: a levelling advantage that ends at the farming cap; at the boss it is not in the hunter's top builds. *The hunter's perfect Legendary build* stacked Unbroken; with copies counting once, Legendaries alone are not among the hunter's top boss builds, but on the tier I boss with a common kit the six-Legendary build stays × 1.46 faster than the best set build (was × 1.28; `balance.test.ts` records it). *Crit-dependent effects* (Mana Surge, Emberbrand, Starfall, Ashen Choir 2/4), evaluated with crit kits, are strong, not weak: Emberbrand is in every top boss build, Mana Surge in every mage one, the Choir in most. *Mage kits in tier III* were the slowest with farmed gear (with best-in-slot builds the warlock was): fixed for both casters with the tier II/III Gravewarden's lower resistance.

## The top end (ticket 4.8)
The Phase 3 retrospective: content ended at 24 while heroes reached 22–28, and past ~22 every late-game build one-shot the Abbey, so kills per minute were capped near 23–24 (the 2 s search) whatever the build. The Ashen Pass (levels 24–28, `docs/WORLD.md`) answers it: its foes have about twice the health per level of the Abbey's at similar damage, tuned against Phase 3 gear (rares +5 farm it at 7–9 kills a minute with no deaths; commons fall 35–50 times an hour), so the late-game builds need several blows again.

The B.2 build search (`builds.test.ts`, the same 48 builds per class: 12 set layouts × 4 affix packages, greedy Legendary effects) on the Abbey at 19 (item level 18) and on the Pass at 26 (item level 25), kills per minute:

| Class | Abbey 19: best · builds within 7 % | Pass 26: best · builds within 7 % | Rares +5 at the Pass |
|---|---|---|---|
| Warrior | 23.4 (at the cap) · 12 | 20.9 · 7 | 7.4 |
| Mage | 22.8 · 12 | 18.6 · 7 | 8.6 |
| Hunter | 23.8 · 42 (all layouts tie) | 21.8 · 29 | 9.1 |
| Warlock | 23.0 · 10 | 18.7 · 5 | 7.0 |

**Asserted** (Pass job, 2 × 20 min per build): every class's best build stays below 0.95 × its Abbey best (off the cap), fewer builds tie within 7 % than at the Abbey (< 0.8 ×), the best still makes > 15 kills a minute, and the B.2 diversity rules hold (three distinct builds within 7 % from two layouts; the farming set may be in all, as at the Abbey). The Bloodmoon Hunt's opener still leads the farming builds of three classes; the hunter's Ambush build is still the closest to the cap (its first-hit bonus), but no longer ties with almost everything. A Legendary +10 kit kills 1.25–2 × as fast as rares +5 there (`balance.test.ts`). A **third job**, the Ashen Warden at 28 (item level 27), joins the boss diversity check: several distinct builds within 7 % per class, no set in all, and every class's best build needs longer than at the tier III Gravewarden.

**Crypt tier III** (`docs/DUNGEONS.md` "Tier III against upgraded gear"): the boss's damage × 1.5 → × 2.4, so upgraded epics (3.9's "upgraded Abbey gear") have a chance at the entry instead of a certainty; Legendary and best-in-slot kits are unchanged.

**Existing players.** Nothing else changes for them: every Graumark area, crypt tiers I and II, loot rolls and the merchant's stock are bit-identical (hashes compared with `main`; the B.1/B.2 bands now name Graumark's areas, `GRAUMARK`, and pass unchanged). The Pass and the Watch stay closed until the community sets `ashenPassCleared`.

## The top end, checked (ticket B.3)
No combat number changed in B.3. What was checked (`tools/balance/top-end.ts`, guarded in `builds.test.ts`):

**The Pass breakpoint holds with upgrades and Void.** The three best Pass builds per class (4.8's search) at +0 · +5 · +10 · +10 Void, kills per minute at level 26 (item level 25) and level 28 (item level 27):

| Class (best build) | Level 26 | Level 28 | Abbey 19 best (the cap) |
| --- | --- | --- | --- |
| Warrior (Bloodmoon 4, speed) | 20.5 · 21.1 · 21.6 · 21.9 | 20.5 · 20.8 · 21.6 · 22.1 | 23.4 |
| Mage (Bloodmoon 4, speed) | 18.5 · 19.4 · 20.1 · 20.1 | 18.3 · 18.9 · 20.1 · 20.1 | 22.8 |
| Hunter (Vigil 4, Ambush, speed) | 21.5 · 21.9 · 22.4 · 22.6 | 21.5 · 21.7 · 22.3 · 22.5 | 23.8 |
| Warlock (Bloodmoon 4, speed) | 18.6 · 18.9 · 20.0 · 20.3 | 18.4 · 19.1 · 19.8 · 20.4 | 23.0 |

+10 Void adds 5–9 % and no build returns to the Abbey's one-shot cap (asserted: the top three at +10 Void stay below 0.97 × the class's Abbey best; the hunter's Ambush build is the closest, at 0.95 ×).

**Heroes past the content's top.** Realistic heroes keep levelling past 28 (B.3's telemetry week ended at levels 26–37; the cap is 60). Levels add little next to gear: the best +10 Void build in item-level-27 gear makes the same kills at 26, 30 and 38 (warrior 22.4 · 22.1 · 22.6, mage 20.1 throughout, hunter 22.7 · 22.4 · 22.9, warlock 20.4 throughout; asserted: 35 is < 1.05 × 26). XP slows the climb: the Pass pays 210–250k XP an hour up to 30 (2–3 h a level), 160–180k at 32, 56–63k at 35 (14–15 h a level) and 23–26k at 38 (40–45 h a level), the B.1 XP penalty working as a soft cap around 35. A hard level cap or content above 28 is a design decision for a later phase (owner).

**Crypt tier III** stays the Legendary tier (decided, no change: `docs/DUNGEONS.md` "Tier III is the Legendary tier").

## Open points
- Balance is tuned (ticket B.1, above) against simulations; the owner's playtest feedback may still move it. Keep `src/balance/balance.test.ts` green when adding content.
- Item stats are only an input; the loot module (ticket 1.5) produces them.
- Damage over time, resources and skill loadouts come in later phases.
- Windows shorter than a cycle return no progress; carry `unusedMs` forward (with per-cycle RNG this never changes the result).
