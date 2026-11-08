# PvP duels: the combat model and normalisation (ticket 5.4)

GDD §10.3; Phase 5 ground rules and owner decisions in `ROADMAP.md`. This ticket is the rules only: a duel simulation and a PvP normalisation layer in game-core, with balance tests. Defence snapshots, challenges, the daily limit and friendly challenges are 5.5; rating and matchmaking are 5.6.

Code: `packages/game-core/src/pvp/` (`normalise.ts`: brackets, reference heroes, `normaliseFighter`, `DEFAULT_PVP_CONFIG`; `duel.ts`: `simulateDuel`). Tests: `src/pvp/pvp.test.ts` (rules, log, determinism, pinned hashes, PvE invariance, speed) and `src/balance/pvp-balance.test.ts` (the bands below). Measurements: `tools/balance/pvp.ts report` (and `tune` for the class factors).

## For players: how a duel works

*(A summary for the arena screen in 5.5.)*

- **You fight a saved copy of another hero.** Both heroes fight on their own: the same attacks, class skill, crits, Legendary effects and set bonuses as against monsters. Nobody needs to be online, and the result is there at once.
- **Only heroes of your bracket.** The brackets are the leaderboard brackets: levels 1–9, 10–19, 20–29, and 30 and above.
- **Your level does not count inside a bracket, your gear does — a quarter of it.** Every hero in a duel fights as a hero of the bracket's middle level. What your gear adds above (or below) a standard kit for that bracket counts for **25 %**. Your Legendary effects and set bonuses also count at 25 % of their bonus damage. So better gear wins more often, but a hero who has just arrived in a bracket still has a real chance.
- **Armour and resistance count together.** Each blow is reduced by the average of the two, whatever its kind.
- **Every blow has some luck in it:** it lands for between half and one and a half times its damage, and crits come on top. A small edge makes you the favourite, not the certain winner.
- **What does nothing in a duel:** gold, item and experience find, boss damage and boss effects (Tyrant's Bane), and effects that act after a kill (Carrion Feast, Bloodrush): a duel ends at the first fall.
- **The time limit:** a duel lasts at most 60 seconds. After 30 seconds, sudden death: every blow grows 10 % stronger per second. If time still runs out, the hero with more of their health left wins; an exact tie is a draw. In practice duels end in 7–8 seconds and almost never reach sudden death.
- **Who strikes first when both strike at the same moment** is decided once per duel by a fair coin.
- **A loss never takes anything from you.**

## The rules (game-core)

### Brackets
`PVP_BRACKETS` are the 5.2 `LEVEL_BRACKETS` (ids, labels and ranges asserted equal), so a leaderboard's bracket filter is the arena's bracket. Each adds a **reference level**: 5, 15, 25 and 30 (30 for 30+: realistic heroes there are 30–37, and items stop at item level 29, the top content's drops). `simulateDuel` requires both fighters in one bracket, unless the caller names a `bracketId` (a friendly challenge across brackets is normalised toward the named one; 5.5 decides whether to allow it).

*Decision:* reusing the board brackets keeps one notion of "bracket" for players. Ten levels are wide, but with level normalised away (below) the width only matters through item level, and the fresh-hero band holds.

### Normalisation (`normaliseFighter`)
1. The hero's PvE stats come from the PvE rules unchanged: `equipmentModifiers` (with set bonuses), `deriveCharacterStats`. Nothing in PvE calls the PvP code.
2. The **reference hero** of a class in a bracket: the class at the reference level, in the class's best regular base for every slot at item level reference − 1, **rare** rarity, implicit stats only (no affixes, effects or upgrades). Data only, no random rolls, so no class gets a lucky reference.
3. For each core stat: `reference + levelKeep × (own level's class value − reference level's) + keep × (what the hero's gear adds − what the reference kit adds)`, within `STAT_LIMITS`. **`keep` = 0.25, `levelKeep` = 0.**
4. **Effects** (`pvpEffects`): bonus magnitudes × **`effectKeep` = 0.25** (crit burn, execute bonus, fortitude bonus, thorns, skill rage, skill opener, skill rot) and the class-skill damage affix too. Thresholds, stack counts and the surge's power are mechanics, not bonuses, and stay (a surge at × 0.25 would hit softer than a plain attack). Boss slayer, life on kill and bloodrush are off. Other secondary modifiers (gold, item and XP find, resource yield, boss damage) are not read.
5. **Class tuning** (`classDamage`, per bracket): the class's primary damage × a PvP-only factor (below).

`DEFAULT_PVP_CONFIG` holds every number. **`PVP_RULES_VERSION` = 1** is in every `DuelResult`; bump it whenever a duel can end differently for the same input (a factor, a bracket, a reference, the engine, or a combat rule the duel runs through). Two pinned duel hashes in `pvp.test.ts` fail when a number moves without a bump, like the 5.1 formulas.

### The duel (`simulateDuel`)
- **On the PvE engine:** each side strikes the other through `buildEncounter` (the target as the "enemy": its duel health, primary damage, defences and attack speed, `rank: 'normal'`), `attackHit` (class skill every n-th attack, crits, every in-fight effect against the opponent's health) and `thornsDamage`. Both use the bracket's **reference level** as the attacker level in the mitigation formula, so level never sneaks back in.
- **Mirrored:** both sides are built the same way; the side names only label the log and the RNG streams. Thorns answer every blow the target survives, for whichever side wears them (tested both ways).
- **Defences blended** (`blendDefences`): armour and resistance are replaced by their mean for both sides. In PvE they face different foes; between heroes, armour scales about twice as fast as resistance, so physical classes always met the higher defence. Without it (and with the class tuning below) the casters averaged 75–82 % and the physical classes 18–25 %.
- **Luck of the blow** (`damageSpread` = 0.5): each hit (not thorns) × uniform [0.5, 1.5], drawn after the crit roll from the striker's stream. Without enough of it duels are nearly decided before they start (crits are the only other chance): at a spread of 0.25, 12 % less damage took the warrior from 71 % to 18 % against the field, and no class fit settled.
- **Timeline:** as in PvE, each side strikes at `j · interval` (whole ms); on the same millisecond the side with the **initiative** goes first. A blow to 0 ends the duel at once (thorns can end it too).
- **Time limit** `maxDuelMs` = 60 s; **sudden death** from 30 s: every blow and thorns × (1 + 0.1 · seconds past 30 s). At the limit: the larger share of health left wins (compared exactly in integers), an exact tie is a **draw**.
- **Seed:** the caller's server secret (5.5 draws it with `crypto`; never from a client). Streams: `${seed}:initiative` (one draw), `${seed}:challenger` and `${seed}:defender` (each side's crit and luck rolls), so one side's rolls never shift the other's.
- **Log** (`DuelEvent`, the crypt log's style; `t` = ms since the start, health after the event): `start` (initiative, both healths), `attack` (side, damage, crit, skill, target's health), `thorns` (side whose thorns hurt the striker, damage, striker's health), `suddenDeath`, `defeat`, `timeLimit`, `end` (outcome, reason). `DuelResult` adds per side the normalised stats, max and final health, attacks, crits and damage dealt.
- **Speed:** ≈ 0.1 ms per late-game duel, normalisation included (asserted < 2 ms); a duel is 15–30 events.

## Balance (asserted in `pvp-balance.test.ts`)
Every duel in the suite draws from a fixed seed, so each number is a measurement that is the same in every run; a band fails only when a rule, a factor or content changes (~4 s). Terms: **kits** are one item per droppable slot (both rings) of the best regular base at item level − 1 in a rarity (B.1's "geared" kit in common), sampled over several kit seeds; **builds** are B.2's late-game shape (a set layout, an affix package, a distinct Legendary effect per free slot), sampled; the **typical opponent** is a reference-level hero in B.1's geared commons; a **fresh hero** is the bracket's lowest level in B.1's geared kit for that level (nothing at level 1).

| What | Band | Measured |
|---|---|---|
| Class matchups (equal tier: common, rare, epic, Legendary kits; builds from 20 up; 6 samples × 12 duels per tier) | every pair 40–60 %; every class against the other three 45–55 % | pairs 45–55 %; classes 48–53 % |
| Gear step (each ladder step against the one below, same class) | > 52 %; ≤ 95 % from common up | 55–92 % |
| Gear ladder against a typical opponent | never more than 3 points below the step before; top − common > 40 points | monotone (the top tiers saturate at 99–100 %) |
| Fresh hero against a typical opponent of every class | ≥ 8 % per class; ≥ 15 % on average | see below |
| Duel length (builds and typical heroes) | median 4–15 s; ≤ 1 % reach the time limit | median 7–8 s, p95 10–11 s, none of 3,200 |

**Worst class pair per bracket:** 1–9 hunter vs mage 45 %; 10–19 hunter vs warlock 46 %; 20–29 hunter vs warlock 55 %; 30+ hunter vs warrior 46 %.

**Gear steps** (win share of the better kit, all classes; naked → common, common → rare, rare → epic, epic → Legendary, Legendary → +5, +5 → +10 Void):

| Bracket | common | rare | epic | Legendary | +5 | +10 Void |
|---|---|---|---|---|---|---|
| 1–9 | 79 % | 85 % | 64 % | 89 % | 61 % | 62 % |
| 10–19 | 92 % | 78 % | 74 % | 84 % | 55 % | 65 % |
| 20–29 | 96 % | 87 % | 70 % | 85 % | 60 % | 74 % |
| 30+ | 96 % | 81 % | 81 % | 92 % | 68 % | 79 % |

The biggest step is epic → Legendary: the Legendary affixes and nine effects together, even at a quarter. A full Legendary +10 Void kit beats a typical commons kit 99–100 % of the time: two or more full steps apart, gear decides. Matchmaking by power range (5.6) keeps such pairs rare.

**Fresh hero** (warrior / mage / hunter / warlock, mean): 1–9 (naked level 1 vs level 5 in commons) 16 / 27 / 10 / 25 %, 19 %; 10–19: 27 / 41 / 27 / 41 %, 34 %; 20–29: 36 / 37 / 36 / 45 %, 38 %; 30+: 37 / 57 / 48 / 55 %, 49 %. The documented minimum is **8 % per class and 15 % on average** (the naked level-1 hunter is the worst case, at about 1 in 10).

### Class tuning
PvE class profiles are tuned against monsters, and a class's shape changes with level; between heroes they are not even (with blended defences and no tuning, the hunter averaged 74–80 %, the warrior 53–70 %, the mage 31–39 % and the warlock 23–28 %). The factor on each class's primary damage, fitted by `tools/balance/pvp.ts tune` to an even average per bracket:

| Bracket | Warrior | Mage | Hunter | Warlock |
|---|---|---|---|---|
| 1–9 | 1.00 | 1.10 | 0.91 | 1.12 |
| 10–19 | 0.95 | 1.11 | 0.92 | 1.13 |
| 20–29 | 0.96 | 1.09 | 0.92 | 1.14 |
| 30+ | 0.94 | 1.11 | 0.91 | 1.14 |

### Choices and their alternatives
- **keep 0.25** (also measured: 0.5 and 0.15, same seeds; steps from common → rare to +5 → +10 Void): at 0.5 the rarity steps won 87–98 % (gear decides); at 0.15 every step shrank to 52–83 % (an upgrade is barely felt: +5 → +10 Void 57–74 %). 0.25 keeps every step a clear but not certain win (55–92 %), and the fresh-hero minimum holds at both 0.15 and 0.25.
- **levelKeep 0:** with level kept at 0.25, a hero at a bracket's entry won 2–7 % in 1–9 (4 % on average) and 19–28 % on average in 10–29, against 13–27 % and 32–38 % now. Level still counts through item level.
- **No health multiplier:** × 3 health (tried first) only stretched duels to ~25 s and took more chance out of them; duels of 7–8 blows each read well in a log.

## PvE stays untouched
- Nothing in `combat/`, `effects/`, `items/`, `loot/` or `scoring/` changed; the PvP layer only reads them. The no-effects hashes, the balance and build suites and the 5.1 Power pins pass unchanged.
- `pvp.test.ts` runs duels between two Power and farming evaluations of the same hero and asserts identical results and unchanged default configs.

## Open points (for 5.5/5.6 and B.4)
- Whether friendly challenges may cross brackets (`bracketId`), and which bracket then applies.
- The arena screen shows the log and, per side, PvE versus normalised stats ("your 1,218 health counts as 920").
- B.4 re-checks the bands with real defence snapshots (telemetry) and the owner's playtest feedback.
