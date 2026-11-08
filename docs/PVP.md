# PvP duels: the combat model and normalisation (ticket 5.4), the arena (ticket 5.5)

GDD §10.3; Phase 5 ground rules and owner decisions in `ROADMAP.md`. This ticket is the rules only: a duel simulation and a PvP normalisation layer in game-core, with balance tests. Defence snapshots, challenges, the daily limit and friendly challenges are 5.5 ("The arena" below); rating and matchmaking are 5.6.

Code: `packages/game-core/src/pvp/` (`normalise.ts`: brackets, reference heroes, `normaliseFighter`, `DEFAULT_PVP_CONFIG`; `duel.ts`: `simulateDuel`). Tests: `src/pvp/pvp.test.ts` (rules, log, determinism, pinned hashes, PvE invariance, speed) and `src/balance/pvp-balance.test.ts` (the bands below). Measurements: `tools/balance/pvp.ts report` (and `tune` for the class factors).

## For players: how a duel works

*(Shown in the arena screen's "How duels work", ticket 5.5.)*

- **You fight a saved copy of another hero.** Both heroes fight on their own: the same attacks, class skill, crits, Legendary effects and set bonuses as against monsters. Nobody needs to be online, and the result is there at once.
- **Only heroes of your bracket.** The brackets are the leaderboard brackets: levels 1–9, 10–19, 20–29, and 30 and above.
- **Your level does not count inside a bracket, your gear does — a quarter of it.** Every hero in a duel fights as a hero of the bracket's middle level. What your gear adds above (or below) a standard kit for that bracket counts for **25 %**. Your Legendary effects and set bonuses also count at 25 % of their bonus damage. So better gear wins more often, but a hero who has just arrived in a bracket still has a real chance.
- **Armour and resistance count together.** Each blow is reduced by the average of the two, whatever its kind.
- **Every blow has some luck in it:** it lands for between three quarters and one and a quarter times its damage, and crits come on top. A small edge makes you the favourite, not the certain winner.
- **What does nothing in a duel:** gold, item and experience find, boss damage and boss effects (Tyrant's Bane), and effects that act after a kill (Carrion Feast, Bloodrush): a duel ends at the first fall.
- **The time limit:** a duel lasts at most 60 seconds. After 30 seconds, sudden death: every blow grows 10 % stronger per second. If time still runs out, the hero with more of their health left wins; an exact tie is a draw. In practice duels end in 7–8 seconds and almost never reach sudden death.
- **Friendly challenges** with friends and guildmates may cross brackets: both heroes then fight in the **lower** hero's bracket.
- **Who strikes first when both strike at the same moment** is decided once per duel by a fair coin.
- **Your defence** is a saved copy of your hero: what it wore when you saved it. Changing your gear later changes nothing until you refresh it.
- **Rated duels** open at level 10: **10 a day** (the day turns at midnight UTC), against opponents of your bracket that the arena names for you. Friendly challenges are not counted.
- **Players you block, or who block you, never meet you in the arena.**
- **A loss never takes anything from you.**

## The arena (ticket 5.5)

Code: game-core `pvp/arena.ts` (limits, `duelDay`, `duelDecision`, `duelSnapshot`, `duelFighter`), server `apps/server/src/arena/` (`model.ts`, `routes.ts`), web `screens/ArenaScreen.tsx` (`#/arena`). Endpoints in `API_CONVENTIONS.md`, tables in `DATA_MODEL.md` (`duel_defences`, `duel_offers`, `duels`). Tests: `pvp/arena.test.ts`, `arena/duels.test.ts`, `arena/duels.pg.test.ts` (real PostgreSQL), the journey step `playDuelStep` (`e2e/duel-journey.test.ts`).

**Defence.** `POST /api/arena/defence` stores a snapshot of what one of your heroes wears now (any level), with the time it was set. Every worn item is checked with 5.1's `checkEquipment` (valid by `validateItem`, sane upgrade, fitting slot, usable by the class, one per slot); a rejected item is left out (counts 0) and its reason listed; the stored snapshot is checked again when a duel reads it. The defence is what others fight; changing gear changes nothing until it is refreshed (the screen marks it "grown since" when the hero's level moved on). One defence per hero; its opaque id stays the same across refreshes.

**Rated duels.**
- Level 10 or more (owner decision); the 1–9 bracket has none. Inside one bracket (the challenger's; the defence must be in it).
- **Opponent list from the server:** `POST /api/arena/opponents` draws up to 5 defences in the hero's bracket at level ≥ 10, at most one per account, never the own account, never blocked either way, never an account with an active sanction of any kind, in a random order (matchmaking by rating and power range is 5.6). A rated duel may only name a defence on the hero's current list (`404 not_offered` otherwise, also for an id from another hero's list); a fought one drops out. A fresh list can be drawn once the current one is 5 minutes old or used up (`409 offer_fresh`), so the list cannot be re-rolled for a favourite. Blocks and sanctions that arrive after the draw take an opponent off at read time, and the duel refuses it.
- **10 a day per account** (`RATED_DUELS_PER_DAY`), counted on the duel day: the UTC date of the game clock (`duelDay`), stored with each duel (the window rule: a duel counts on the day it committed). Counted under the account's duel lock, so exact under races.

**Friendly challenges.** With friends and guildmates (read live) only; never blocked either way, never a sanctioned defender. Any level, across brackets: both fight in the lower hero's bracket (`friendlyBracket`). No rating, no rewards, no daily limit (only the social-write class: 12 a minute, 240 an hour).
- *Decision:* **instant resolution against the friend's saved defence**, not send/accept. A duel is always challenger vs saved snapshot in this game, so a friendly one needs no new state (no pending challenges to expire, cancel or block mid-way), no second player online, and reuses the rated path exactly. The friend sees it in their duel book. Send/accept can come later without changing the stored duel.
- Reached from the arena's friendly list, and from a "Duel" link in the friend list and the guild roster (`#/arena/friendly/<handle>`).

**The permission matrix** (`duelDecision`, checked in this order; tested per relation × kind in game-core and through the API against a hand-written table):

| relation ↓ / kind → | rated | friendly |
|---|---|---|
| self (own account) | 422 cannot_target_self | 422 cannot_target_self |
| blocked-by-me, blocked-by-them | 404 not_found | 404 not_found |
| defender sanctioned (any kind) | 404 not_found | 404 not_found |
| stranger, requested-by-me, requested-by-them | ✓ | 403 not_friend_or_guildmate (✓ if guildmates) |
| friend, guildmate | ✓ | ✓ |

Then for rated: below level 10 `403 level_too_low`, another bracket `409 wrong_bracket`, 10 already today `409 no_duels_left`, not on the list `404 not_offered`. The challenger's own sanctions follow the social-write rules: a suspended account has no request at all (`403 account_suspended`); a mute does not stop a duel (`duel` is mute-exempt, like guild boss attempts: it carries no text). A block is never announced (`404` like an unknown defence).

**Resolution.** In one transaction: the account row (share, sanctions), the account's duel lock, the challenger's hero (share: an equip waits; farming is never settled), the defence row (share: a refresh racing the duel lands before or after it). The challenger's attack snapshot is taken from its worn items (checked like a defence); the defender's side is the stored defence snapshot, never the live hero. `simulateDuel` runs with a seed of 16 random bytes from `crypto`, drawn on the server for this duel. The row stores the seed, `PVP_RULES_VERSION`, both snapshots, when the defence was set, the outcome, reason, sides and log, the duel day and the time: any duel can be replayed and audited (tested: the replay equals the stored result). The seed never leaves the server.

**No re-roll.** `POST /api/arena/duels` requires an `Idempotency-Key`: a retry or replay with the same key answers the stored duel (`Idempotency-Replayed: true`); a concurrent double submit waits and replays; only a success is stored, and a failure shows nothing of the fight. A new key is a new duel and, rated, costs one of the day's ten.

**A loss changes nothing you own.** No route of the arena writes gold, items, XP, materials or a score; it never settles farming and is outside `/api/characters…` (so leaderboards are not refreshed). Tested: hashes of both heroes' rows, items, materials, leaderboard rows and 5.1 scores before and after rated and friendly duels are equal; the audit log and telemetry reconcile; the journey's holdings reconcile with the audit log.

**Audit and telemetry.** `duel.defence` (level, bracket, items, rejected) and `duel.fight` (duel id, kind, bracket, defender account, outcome, reason, rules version, day) on the challenger's account; rollup `duel.fight` (kind, bracket, outcome) in the same transaction, reconciled per kind (`duels: rated`, `duels: friendly`).

**Privacy.** Opponents are shown by display name (null while a moderator hides it); the name links to the profile and the hero's name shows only where `canViewProfile` allows (the 5.2 board pattern). No account, character or item id, item, or time finer than a day of the other side's defence. A duel is visible to its two players only. A block after a duel hides the other's name in the duel book and the result. A bout's result has "Report this player" (the 4.1 report flow, target `player`).

**The seam for 5.6.** `duels` holds kind, bracket, outcome, both accounts, the day and time; rating, matchmaking by rating and power range, friends/guildmates out of rated matches, and rewards are 5.6. Nothing in 5.5 computes a rating.

## The rules (game-core)

### Brackets
`PVP_BRACKETS` are the 5.2 `LEVEL_BRACKETS` (ids, labels and ranges asserted equal), so a leaderboard's bracket filter is the arena's bracket. Each adds a **reference level**: 5, 15, 25 and 30 (30 for 30+: realistic heroes there are 30–37, and items stop at item level 29, the top content's drops). `simulateDuel` requires both fighters in one bracket, unless the caller names a `bracketId`, which normalises both toward that bracket.

**Friendly challenges** (owner decision): friends and guildmates may duel across brackets, and both then fight normalised toward the **lower** hero's bracket. 5.5 passes `friendlyBracket(levelA, levelB).id` as `bracketId`. Rated duels stay inside one bracket.

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
- **Luck of the blow** (`damageSpread` = 0.25, owner decision; 0.5 at first): each hit (not thorns) × uniform [0.75, 1.25], drawn after the crit roll from the striker's stream. Without it duels are nearly decided before they start (crits are the only other chance). At ±25 % outcomes are steep: a few percent of class damage moves a class's average by 5–10 points, so the class factors carry three decimals, and the biggest gear steps reach 96–97 % (they were at most 92 % at ±50 %).
- **Timeline:** as in PvE, each side strikes at `j · interval` (whole ms); on the same millisecond the side with the **initiative** goes first. A blow to 0 ends the duel at once (thorns can end it too).
- **Time limit** `maxDuelMs` = 60 s; **sudden death** from 30 s: every blow and thorns × (1 + 0.1 · seconds past 30 s). At the limit: the larger share of health left wins (compared exactly in integers), an exact tie is a **draw**.
- **Seed:** the caller's server secret (5.5 draws it with `crypto`; never from a client). Streams: `${seed}:initiative` (one draw), `${seed}:challenger` and `${seed}:defender` (each side's crit and luck rolls), so one side's rolls never shift the other's.
- **Log** (`DuelEvent`, the crypt log's style; `t` = ms since the start, health after the event): `start` (initiative, both healths), `attack` (side, damage, crit, skill, target's health), `thorns` (side whose thorns hurt the striker, damage, striker's health), `suddenDeath`, `defeat`, `timeLimit`, `end` (outcome, reason). `DuelResult` adds per side the normalised stats, max and final health, attacks, crits and damage dealt.
- **Speed:** ≈ 0.1 ms per late-game duel, normalisation included (asserted < 2 ms); a duel is 15–30 events.

## Balance (asserted in `pvp-balance.test.ts`)
Every duel in the suite draws from a fixed seed, so each number is a measurement that is the same in every run; a band fails only when a rule, a factor or content changes (~4 s). Terms: **kits** are one item per droppable slot (both rings) of the best regular base at item level − 1 in a rarity (B.1's "geared" kit in common), sampled over several kit seeds; **builds** are B.2's late-game shape (a set layout, an affix package, a distinct Legendary effect per free slot), sampled; the **typical opponent** is a reference-level hero in B.1's geared commons; a **fresh hero** is the bracket's lowest level in B.1's geared kit for that level (nothing at level 1).

| What | Band | Measured |
|---|---|---|
| Class matchups (equal tier: common, rare, epic, Legendary kits; builds from 20 up; 6 samples × 12 duels per tier) | every pair 40–60 %; every class against the other three 45–55 % | pairs 41–60 %; classes 48–54 % |
| Gear step (each ladder step against the one below, same class) | > 52 %; ≤ 98 % from common up (was ≤ 95 % at ±50 %; see below) | 55–97 % |
| Gear ladder against a typical opponent | never more than 3 points below the step before; top − common > 40 points | monotone (the top tiers saturate at 99–100 %) |
| Fresh hero against a typical opponent of every class | ≥ 8 % per class; ≥ 15 % on average; **1–9: ≥ 3 % / ≥ 7 %** (see below) | see below |
| Duel length (builds and typical heroes) | median 4–15 s; ≤ 1 % reach the time limit | median 6.8–8 s, p95 10–11 s, none of 3,200 |

**Worst class pair per bracket:** 1–9 warlock vs warrior 55 %; 10–19 warlock vs warrior 54 %; 20–29 mage vs warlock 43 %; 30+ hunter vs warlock 60 % (at the band's edge: the pair spread in 30+ comes from class shape, and one damage factor per class cannot even out all six pairs).

**Gear steps** (win share of the better kit, all classes; naked → common, common → rare, rare → epic, epic → Legendary, Legendary → +5, +5 → +10 Void):

| Bracket | common | rare | epic | Legendary | +5 | +10 Void |
|---|---|---|---|---|---|---|
| 1–9 | 92 % | 92 % | 66 % | 93 % | 65 % | 64 % |
| 10–19 | 99 % | 89 % | 82 % | 89 % | 55 % | 69 % |
| 20–29 | 99 % | 96 % | 78 % | 91 % | 65 % | 77 % |
| 30+ | 99 % | 86 % | 86 % | 97 % | 71 % | 85 % |

The biggest step is epic → Legendary: the Legendary affixes and nine effects together, even at a quarter. A full Legendary +10 Void kit beats a typical commons kit 99–100 % of the time: two or more full steps apart, gear decides. Matchmaking by power range (5.6) keeps such pairs rare.

**Fresh hero** (warrior / mage / hunter / warlock, mean): 1–9 (naked level 1 vs level 5 in commons) 4 / 12 / 4 / 13 %, 8 %; 10–19: 16 / 32 / 21 / 33 %, 26 %; 20–29: 25 / 36 / 30 / 42 %, 33 %; 30+: 31 / 56 / 52 / 59 %, 49 %. The documented minimum is **8 % per class and 15 % on average**, and it holds from 10 up.

**Exception, 1–9 — owner decision (2026-11-08): rated duels open at level 10.** The 1–9 bracket has no rated duels, so this case never reaches the arena; the measured floor stays asserted in the suite. At ±25 % luck a level-1 hero with nothing equipped against a level-5 hero in commons cannot reach that minimum: the gap is all gear, and the allowed lever (the class factors) only moves the classes against each other. The best measured is 4–13 % per class, 8 % on average (at ±50 % it was 10–27 %, 19 %). A stronger reference kit (epic or Legendary instead of rare) gained at most 1–2 points. The suite asserts the measured floor for 1–9 (≥ 3 % per class, ≥ 7 % on average) so it cannot slip further unseen.

### Class tuning
PvE class profiles are tuned against monsters, and a class's shape changes with level; between heroes they are not even (with blended defences and no tuning, the hunter averaged 74–80 %, the warrior 53–70 %, the mage 31–39 % and the warlock 23–28 %). The factor on each class's primary damage, fitted by `tools/balance/pvp.ts tune` to an even average per bracket and then searched to narrow the worst pair:

| Bracket | Warrior | Mage | Hunter | Warlock |
|---|---|---|---|---|
| 1–9 | 1.003 | 1.105 | 0.936 | 1.124 |
| 10–19 | 0.946 | 1.097 | 0.925 | 1.111 |
| 20–29 | 0.96 | 1.1 | 0.92 | 1.135 |
| 30+ | 0.941 | 1.097 | 0.915 | 1.126 |

### Choices and their alternatives
- **keep 0.25** (confirmed by the owner; measured at ±50 % luck against 0.5 and 0.15, same seeds; steps from common → rare to +5 → +10 Void): at 0.5 the rarity steps won 87–98 % (gear decides); at 0.15 every step shrank to 52–83 % (an upgrade is barely felt: +5 → +10 Void 57–74 %). 0.25 keeps every step a clear but not certain win (55–92 %), and the fresh-hero minimum holds at both 0.15 and 0.25.
- **levelKeep 0** (measured at ±50 % luck): with level kept at 0.25, a hero at a bracket's entry won 2–7 % in 1–9 (4 % on average) and 19–28 % on average in 10–29, against 13–27 % and 32–38 % with levelKeep 0. Level still counts through item level.
- **No health multiplier:** × 3 health (tried first) only stretched duels to ~25 s and took more chance out of them; duels of about 7 blows each read well in a log.

## PvE stays untouched
- Nothing in `combat/`, `effects/`, `items/`, `loot/` or `scoring/` changed; the PvP layer only reads them. The no-effects hashes, the balance and build suites and the 5.1 Power pins pass unchanged.
- `pvp.test.ts` runs duels between two Power and farming evaluations of the same hero and asserts identical results and unchanged default configs.

## Open points (for 5.5/5.6 and B.4)
- The fresh-hero exception in 1–9 (above).
- The arena screen shows the log and, per side, PvE versus normalised stats ("your 1,218 health counts as 920").
- B.4 re-checks the bands with real defence snapshots (telemetry) and the owner's playtest feedback.
