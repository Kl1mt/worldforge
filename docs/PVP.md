# PvP duels: the combat model and normalisation (ticket 5.4), the arena (ticket 5.5), rating and matchmaking (ticket 5.6)

GDD §10.3; Phase 5 ground rules and owner decisions in `ROADMAP.md`. This ticket is the rules only: a duel simulation and a PvP normalisation layer in game-core, with balance tests. Defence snapshots, challenges, the daily limit and friendly challenges are 5.5 ("The arena" below); rating, matchmaking, the ladder and the win-trading rules are 5.6 ("Rating, matchmaking and the ladder" below).

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
- **Your rating** (ticket 5.6) belongs to your hero and to the season. Every hero starts a season at 1,500; a rated duel moves both heroes' ratings, the challenger's and the defender's, by how surprising the result was. Until a hero has fought **10 rated duels** (attacking or defending) its rating is **provisional** and it is not ranked on the Arena Ladder; the arena shows how sure the rating is ("likely 1,380–1,660"). When a new season begins, your rating starts halfway back toward 1,500.
- **Whom the arena names:** heroes whose gear is about as strong as yours (their Character Power at your bracket's middle level within 5 %, or 10 % or 20 % if too few are that close) and, among those, the ones closest to your rating. Each shows whether you are favoured, evenly matched or the underdog.
- **Friends and guildmates** never meet in rated duels (challenge them in a friendly duel). **The same player again and again** within a week counts for half, then a quarter, then nothing, and the arena stops naming them until the week has passed.
- **Season honours:** the Arena Ladder honours its best at the season's end like the other boards: Champion, Exalted, Renowned or Veteran **Duellist**, and a frame. For glory only.
- **Players you block, or who block you, never meet you in the arena.**
- **A loss never takes anything from you.**

## The arena (ticket 5.5)

Code: game-core `pvp/arena.ts` (limits, `duelDay`, `duelDecision`, `duelSnapshot`, `duelFighter`), server `apps/server/src/arena/` (`model.ts`, `routes.ts`), web `screens/ArenaScreen.tsx` (`#/arena`). Endpoints in `API_CONVENTIONS.md`, tables in `DATA_MODEL.md` (`duel_defences`, `duel_offers`, `duels`). Tests: `pvp/arena.test.ts`, `arena/duels.test.ts`, `arena/duels.pg.test.ts` (real PostgreSQL), the journey step `playDuelStep` (`e2e/duel-journey.test.ts`).

**Defence.** `POST /api/arena/defence` stores a snapshot of what one of your heroes wears now (any level), with the time it was set. Every worn item is checked with 5.1's `checkEquipment` (valid by `validateItem`, sane upgrade, fitting slot, usable by the class, one per slot); a rejected item is left out (counts 0) and its reason listed; the stored snapshot is checked again when a duel reads it. The defence is what others fight; changing gear changes nothing until it is refreshed (the screen marks it "grown since" when the hero's level moved on). One defence per hero; its opaque id stays the same across refreshes.

**Rated duels.**
- Level 10 or more (owner decision); the 1–9 bracket has none. Inside one bracket (the challenger's; the defence must be in it).
- **Opponent list from the server:** `POST /api/arena/opponents` draws up to 5 defences in the hero's bracket at level ≥ 10, at most one per account, never the own account, never blocked either way, never an account with an active sanction of any kind; since 5.6 by matchmaking ("Matchmaking" below), never a friend, guildmate or account sharing a sign-up signal, never a pair whose next duel would count for nothing. A rated duel may only name a defence on the hero's current list (`404 not_offered` otherwise, also for an id from another hero's list); a fought one drops out. A fresh list can be drawn once the current one is 5 minutes old or used up (`409 offer_fresh`), so the list cannot be re-rolled for a favourite. Blocks and sanctions that arrive after the draw take an opponent off at read time, and the duel refuses it.
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
| friend, guildmate | 409 friendly_only (5.6) | ✓ |
| shared sign-up signal (5.6) | 404 not_offered | as the relation |

Then for rated: below level 10 `403 level_too_low`, another bracket `409 wrong_bracket`, friend or guildmate `409 friendly_only`, a shared signal `404 not_offered` (never announced), 10 already today `409 no_duels_left`, not on the list `404 not_offered`. The challenger's own sanctions follow the social-write rules: a suspended account has no request at all (`403 account_suspended`); a mute does not stop a duel (`duel` is mute-exempt, like guild boss attempts: it carries no text). A block is never announced (`404` like an unknown defence).

**Resolution.** In one transaction: the account row (share, sanctions), the account's duel lock, the challenger's hero (share: an equip waits; farming is never settled), the defence row (share: a refresh racing the duel lands before or after it). The challenger's attack snapshot is taken from its worn items (checked like a defence); the defender's side is the stored defence snapshot, never the live hero. `simulateDuel` runs with a seed of 16 random bytes from `crypto`, drawn on the server for this duel. The row stores the seed, `PVP_RULES_VERSION`, both snapshots, when the defence was set, the outcome, reason, sides and log, the duel day and the time: any duel can be replayed and audited (tested: the replay equals the stored result). The seed never leaves the server.

**No re-roll.** `POST /api/arena/duels` requires an `Idempotency-Key`: a retry or replay with the same key answers the stored duel (`Idempotency-Replayed: true`); a concurrent double submit waits and replays; only a success is stored, and a failure shows nothing of the fight. A new key is a new duel and, rated, costs one of the day's ten.

**A loss changes nothing you own.** No route of the arena writes gold, items, XP, materials or a score; it never settles farming and is outside `/api/characters…` (so leaderboards are not refreshed). Tested: hashes of both heroes' rows, items, materials, leaderboard rows and 5.1 scores before and after rated and friendly duels are equal; the audit log and telemetry reconcile; the journey's holdings reconcile with the audit log.

**Audit and telemetry.** `duel.defence` (level, bracket, items, rejected) and `duel.fight` (duel id, kind, bracket, defender account, outcome, reason, rules version, day) on the challenger's account; rollup `duel.fight` (kind, bracket, outcome) in the same transaction, reconciled per kind (`duels: rated`, `duels: friendly`).

**Privacy.** Opponents are shown by display name (null while a moderator hides it); the name links to the profile and the hero's name shows only where `canViewProfile` allows (the 5.2 board pattern). No account, character or item id, item, or time finer than a day of the other side's defence. A duel is visible to its two players only. A block after a duel hides the other's name in the duel book and the result. A bout's result has "Report this player" (the 4.1 report flow, target `player`).

**The seam for 5.6.** `duels` holds kind, bracket, outcome, both accounts, the day and time; 5.6 adds the rating record (`duels.rating`) and reads the pairs from it (below). Duels fought before 5.6 carry no rating and need no backfill (no season had begun).

## Rating, matchmaking and the ladder (ticket 5.6)

Code: game-core `pvp/rating.ts` (Glicko-2, ageing, `rateDuel`, standings, the season reset), `pvp/matchmaking.ts` (`bracketPower`, `pickOpponents`), `pvp/integrity.ts` (repeat-pair factors, exclusions, `mailboxKey`, pattern flags), `prestige.ts` (`PRESTIGE_METRICS` with `arena`); server `apps/server/src/arena/rating.ts` (locks, the update, exclusions), `model.ts` (`drawOpponents`), `ladder.ts` (`GET /api/arena/ladder`), `patterns.ts` (`GET /api/mod/arena/patterns`), `seasons/model.ts` (archive). Tables in `DATA_MODEL.md` (`arena_ratings`; `duels.rating`; `duel_defences.power`), endpoints in `API_CONVENTIONS.md`. Migration `0028_arena_rating` (additive: one table, nullable columns, two widened checks; no backfill). Tests: `pvp/rating.test.ts`, `pvp/matchmaking.test.ts`, `pvp/arena.test.ts`, `balance/arena-fairness.test.ts` (game-core); `arena/rating.test.ts`, `arena/rating.pg.test.ts` (real PostgreSQL), `arena/duels.test.ts`; the journey step `playDuelStep`. Measurements: `tools/balance/arena.ts`.

### Rating
**Per hero, per season** (*decision*). A rating answers "how strong is this build in duels", and builds are heroes: classes differ, brackets are by hero level, and the ladder is filtered by class and bracket like the other boards, which are per hero too. Per account would mix a level-12 hunter and a level-31 warlock into one number. The per-account parts stay per account: the daily limit (10 rated duels per account), the repeat-pair window (per pair of accounts) and the season honours (an account's best hero per board, as in 5.3). A hero that levels into the next bracket keeps its rating for the season (it now meets that bracket's heroes, and the rating adjusts; brackets are 10 levels wide).

**Glicko-2** (Glickman 2012), `ARENA_RATING_VERSION` = 1, every number in `DEFAULT_RATING_CONFIG`: start **1500 / deviation 350 / volatility 0.06**, **τ = 0.5**, convergence 10⁻⁶; the deviation stays within 30–350. Tested against the paper's worked example (1500 / 200 / 0.06 against three opponents → 1464.06 / 151.52 / 0.05999).

**Rating periods in async play.** Glicko-2 rates batches at the end of a period; duels must show their result at once. So **every rated duel is a rating period of one game for each of its two heroes**, and idle time counts as empty periods of **one day**: before a duel each whole day since the hero's last rated duel grows its deviation as Glicko-2's no-games step does (φ² + σ² per day), never above 350. A hero that stops duelling becomes less certain, so its next results move it more. Pure: `ageRating(rating, lastRatedAt, now)` and `rateDuel` take the clock; nothing reads the wall clock.

**Both sides move; defence results count in full.** Only the challenger chooses the duel, but the defender plays it too: a challenger win is a defence loss. Both are rated on the one game against the other's rating *from before the duel* (both aged to the duel's time). *Decision:* defence losses are not discounted: matchmaking offers a defence only to challengers close in Power and rating, so a defence loss costs about what the same win would gain, and discounting would let defences drift upward unearned. A draw counts half.

**When:** inside the duel's transaction, after 5.5's locks (account row → the challenger's duel lock → the hero → the defence row), then: the season's **shared** lock (`season:<n>`; the archive takes it exclusively, so no rating is written into a sealed season) → the **pair lock** (`arena-pair:<a>:<b>`, the two account ids sorted: the repeat-pair count is exact under races) → both heroes' **rating locks** (`arena-rating:<season>:<hero>`, sorted by id: two duels against one defender serialise; two heroes attacking each other never deadlock). All transaction-scoped advisory locks. A rated duel at a moment no season holds (before the owner schedules the first one, or in a gap) is fought, stored and counted toward the ten, but moves no rating (`duel.unrated`).

**Stored:** `arena_ratings` (season, hero: rating, deviation, volatility, games, wins, losses, draws, the latest rated duel's time, copies of class, level and bracket for the ladder's filters), and on the duel row `duels.rating`: season, version, factor, the pair count before it, and both sides' rating before and after, so every change can be audited and recomputed with `rateDuel`.

**Plain words** (`ratingStanding`, `ratingRange`): **provisional** until `PROVISIONAL_GAMES` = 10 rated duels this season (attacking or defending); then **settled** at a deviation of 100 or less, else **still settling**. The likely range is the rating ± 2 deviations, rounded to 10 ("1,520, likely 1,380–1,660").

### Season reset (soft) and the archive
- **Reset:** a hero's first rating of a season starts from its latest rating of an earlier season **pulled halfway back to 1500** (`SEASON_CARRY` 0.5), deviation **at least 250**, volatility 0.06 (`seasonStartRating`); a hero new to the arena starts at 1500 / 350. Applied lazily on the hero's first rated duel (or offer) of the season; a past season's rows are never changed.
- **Archive:** 5.3's `archiveSeason` (same transaction, same exclusive season lock) also copies the ladder into `season_standings` as metric **`arena`**: established heroes only (≥ 10 rated duels), accounts with an active sanction left out, ranked by rating, then more duels, then the earlier latest duel, then the hero id; `value` = the rounded rating, `sort_key` = [rating × 100, duels], `formula_version` = the rating version. The full rating stays in `arena_ratings`. Tested: the archive equals the ladder read just before the end; duels racing the archive (real PG) leave the standings equal to the ratings in every order and write nothing after.
- **Honours:** 5.3's `awardSeason` reads the archive, so the ladder gives the same tiers (Champion 1st, Exalted top 10, Renowned top 100, Veteran any other place at level ≥ 10: every ladder hero is), exactly once per (season, account, `arena`), resumable. Title noun **Duellist** ("Exalted Duellist, Season 2"); the badge reuses Character Power's crossed blades (`title-badge-power`); frames are the 5.3 tier frames. No new art.

### Matchmaking
`POST /api/arena/opponents` (5.5's list: ≤ 5, one per account, refresh after 5 minutes or when used up) now draws in two steps.
1. **Eligible** (server): defences in the bracket at level ≥ 10, never the own account, blocked either way, sanctioned, a friend, a guildmate or an account sharing a sign-up signal, never a pair whose next duel would count for nothing; up to 500 sampled at random when a bracket is larger.
2. **Picked** (game-core `pickOpponents`, `MATCHMAKING_VERSION` 1, `DEFAULT_MATCHMAKING`): a **Power range** first, then **rating**. A defence is in range when its **bracket Power** is within **5 %** of the challenger's (relative to the stronger; Powers below 400 count as 400); with fewer than **5 accounts** in range it widens to **10 %**, then **20 %**, **and never further**: a hero with nobody within 20 % gets an empty list (the 5.5 empty state), never a lopsided pair. In range, the 10 accounts closest in rating are kept (one defence each: its closest), and 5 of them are drawn from a `crypto` seed, so a list cannot be predicted or re-rolled for a favourite. Each offered opponent shows its rating and the odds in words (favoured ≥ 60 %, even, underdog ≤ 40 %, by Glicko's expected score with both deviations).

**Bracket Power** (*decision*): 5.1's Character Power of the snapshot's checked gear **at the bracket's reference level** (`bracketPower`). A duel fights every hero at that level (5.4: level does not count inside a bracket), so raw Power's level part says nothing about a duel; measured with raw Power, 4 % of offered pairs in 10–19 had a 95 %+ favourite, with bracket Power 1 %. It is stored on the defence when it is set (`duel_defences.power`, with Power's formula version; a defence set before 5.6 or under an older Power version is computed at draw time), and the challenger's is computed from what it wears at the draw (~2 ms).

**The fairness band** (`balance/arena-fairness.test.ts`, `tools/balance/arena.ts`): a synthetic population of 120 heroes per rated bracket, every class and level, dressed commons 30 %, rares 24 %, epics 18 %, Legendaries 12 %, B.2 builds 6 % (from 20), Legendary +5 6 %, Legendary +10 Void 4 %. Every hero asks for a list; every offered pair is fought 32 times from fixed seeds (alternating sides). The **favourite** of a pair is the side that wins more of them; its share is the pair's expected win chance (a perfectly even pair measures ~57 % over 32 duels by chance alone). Asserted per bracket: mean ≤ 72 %, pairs with a 90 %+ favourite ≤ 8 %, with a 95 %+ favourite ≤ 3 %, pairs three or more gear tiers apart (e.g. commons against Legendary +5) ≤ 3 %, no empty list, ≤ 25 % of lists widened; and at least 15 points better than random lists.

| Bracket | 5.5 random lists: mean / 90 %+ / 95 %+ / 3+ tiers apart | 5.6 at season start (all 1500) | after a simulated season (30 rounds) | lists widened |
|---|---|---|---|---|
| 10–19 | 89 % / 65 % / 54 % / 27 % | 66 % / 2 % / 1 % / 2 % | 65 % / 3 % / 1 % / 2 % | 15 % |
| 20–29 | 87 % / 60 % / 51 % / 19 % | 67 % / 3 % / 1 % / 0 % | 66 % / 4 % / 1 % / 0 % | 8 % |
| 30+ | 89 % / 67 % / 59 % / 28 % | 68 % / 6 % / 2 % / 0 % | 66 % / 3 % / 1 % / 0 % | 3 % |

So the 5.4 risk (a full Legendary +10 Void kit beats commons 99–100 %) stays rare: such a pair is three or more tiers apart, which matchmaking offers in 0–2 % of pairs against 19–28 % for random lists. The rest of the spread is what Power does not see (class matchups, the luck roll); ratings then pair heroes by results. With a small population (20 heroes per bracket) lists widen more often and up to 16–19 % of pairs in 30+ have a 95 %+ favourite: the band holds best once the arena is busy (B.4 re-measures with telemetry: `arena.offer` counts lists per range used).

### Win-trading
- **Diminishing returns** (`ratingFactor`, `PAIR_FACTORS`): rated duels between the **same two accounts** (either challenging, any of their heroes) in the **7 days** before a duel set its factor: **1, ½, ¼, then 0**. The factor scales the whole change (rating, deviation and volatility), so at 0 a duel moves nothing. Matchmaking does not offer a pair at 0 until the window has passed. Counted under the pair lock (exact under races; real-PG tested: two accounts attacking each other at once see 0, 1, 2, … in commit order).
- **Never rated together** (`ratedPairExclusion`): **friends**, **guildmates** (both read live, at the draw and at the duel) and **accounts sharing a sign-up signal**. Friendly challenges stay open to friends and guildmates. **Signals** (*decision*, only data the server already stores and may use; nothing new is collected): **the same mailbox**: the stored email with case, `+tags` and Gmail's dots folded (`mailboxKey`), compared on the server in memory only, never returned, logged, audited or stored in another form. The server keeps no IP address, device or browser data, so there is no other signal. A shared invite code is *not* an exclusion (one beta invite may bring a whole group of real friends); it is shown in the pattern report instead. A refused pair is answered `404 not_offered`, like an opponent never offered: a signal is never announced.
- **Pattern report** (moderators and admins, `GET /api/mod/arena/patterns?days=14`, the Moderation screen's "Arena patterns"): pairs of accounts with **3 or more** rated duels against each other in the window, with each side's wins, draws, who challenged, the rating each gained from these duels, how many counted for nothing, the dates, and flags (`PATTERN_RULES`): **repeated** (≥ 5 duels), **lopsided** (one side won ≥ 80 % of ≥ 4), **one way** (always the same challenger), plus **same invite** (both accounts were created with one invite, by its id). Only pairs where the viewer may act on at least one side, never the viewer's own; handles and display names only, no ids or emails; each view writes `mod.arena.patterns` (window, pair count). Acting happens through the queue's sanctions (a sanctioned account leaves the ladder at once, and the archive).

### The ladder
`GET /api/arena/ladder` (web: the Arena Ladder next to the Roll of Renown): a season's ladder (the one asked for, else the season under way, else the latest begun; `404 season_not_found` for others), filters by class and level bracket (10–19, 20–29, 30+; by the hero's level at its latest rated duel), pages of 1–100 with an offset cursor, ETag polling and the board read limit (60 a minute per account, its own counter). The 5.2 board rules apply: everyone listed by display name (no opt-out), the name links to the profile and the hero's name shows only where `canViewProfile` allows, names a moderator hides are withheld, accounts with any active sanction are left out at read time (and see `youExcluded`), a report action per entry. **Ranked:** heroes with at least 10 rated duels this season, by rating, then more duels, then the earlier latest duel, then the hero id. Your own provisional heroes are listed under "your place" without a rank. A past season reads its final standings.

### Telemetry and audit
- `duel.fight` audit rows carry `rating: { season, factor, challenger, defender }` (the rounded changes). Rollups `arena.rated` (bracket, `full` / `reduced` / `none` / `no_season`) per rated duel and `arena.offer` (bracket, `range0`–`range2` or `none`; amount: opponents offered) per list (`TELEMETRY.md`).

### Invariance
A rating is no score and no holding: nothing a player owns changes (tested: heroes' rows and items before and after rated duels are equal; the 5.5 invariance test covers gold, items, XP, materials, leaderboard rows and 5.1 scores with rated duels to a stranger and friendly ones to a friend). No PvE number and no 5.4 duel rule changed (`PVP_RULES_VERSION` stays 1; the pinned duel hashes, the no-effects hashes and the balance suites pass unchanged).

### Open points (for the owner and B.4)
- The fairness band is measured on a synthetic population; B.4 re-measures with real defences (`arena.offer`, the pattern report).
- The power range caps at 20 %: in a thin bracket a strong hero may get an empty list. The owner can widen the last step (data) if lists stay empty in practice.
- The mailbox is the only shared signal the server has; one person with two unrelated mailboxes looks like two strangers (like trading's multi-account note in `TRADING.md`). Repeated pairs are capped by the factors and visible in the pattern report.

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
- 5.6's open points are under "Rating, matchmaking and the ladder".
