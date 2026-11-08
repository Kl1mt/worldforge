# Leaderboards: what is measured (5.1), the boards (5.2), seasons and prestige (5.3), the arena ladder (5.6)

GDD §10.2, §16.3; Phase 5 ground rules in `ROADMAP.md`. This ticket defines the four scores, their published formulas and a read-only breakdown on the character screen ("Standing"). Boards, storage and filters are ticket 5.2; seasons 5.3.

Code: game-core `packages/game-core/src/scoring/` (formulas, data, tests), server `apps/server/src/scores/routes.ts` (`GET /api/characters/:characterId/scores`, `API_CONVENTIONS.md`), web `apps/web/src/screens/StandingPanel.tsx`. Screenshots: `docs/screenshots/phase-5/standing-*.png` (`node tools/screenshots/standing.mjs`).

## For players: how each score is measured

Every score is worked out by the server from what your hero has done and wears. Nothing your browser sends is ever taken as a score. On the character screen, **Standing** shows your four scores; open a line to see what counted and why.

**Everyone on a board is listed by name** (owner decision): there is no opt-out and no anonymous entry. Your profile settings still decide whether your name links to your profile.

### Seasons
A season lasts eight weeks (times in UTC). Every board can be shown for all time or for one season.

- **Who is on a season board:** every hero whose score on that board **rose during the season**. A hero that only fell, or fell and came back to where it started, is not on it.
- **What counts:** your score **when the season ends** (or now, while it is under way). It is the same score as on the all-time board; only who is listed differs.
- **The boundary:** a change counts in a season if you made it before the season's end. The moment the season ends belongs to the next one.
- **At the end** the season board is sealed for good (the "final standings") and stays readable. A few minutes after the end, every hero on it is honoured by place (below). Players with an active sanction at that moment are left off the final standings.
- The next season starts the moment the last one ends, unless the town has planned another start.

### Prestige rewards
Honours are given once per season, on each of the four boards, by your best hero's place on the final standings:

| Honour | Place on a season board | Frame |
|---|---|---|
| **Champion** | 1st | gilt |
| **Exalted** | top 10 | brass |
| **Renowned** | top 100 | pewter |
| **Veteran** | any other place, with a hero of level 10 or more | iron |

Each honour gives a **title** for that board (Climber for Character Level, Armsbearer for Gear Score, Blade for Character Power, Pathfinder for PvE Progress, and since 5.6 **Duellist** for the Arena Ladder: "Exalted Pathfinder, Season 2") and a **profile frame** of its tier. On your profile, under **Season honours**, choose one title and one frame to show (or none); they appear beside your name on the boards, your profile and your guild's roster. Your first honour is shown automatically until you choose. **Honours are for glory only: they change no number in the game.**

### Character Level
Your level. Between heroes of the same level, whoever has earned more experience toward the next level is ahead.

### Gear Score
How good your equipped items are, item by item, and nothing else. It does not ask whether they work well together; that is what Character Power is for.

For each item you wear:

> **item level × 10 × rarity × upgrades × Void**

| Part | Value |
|---|---|
| Rarity | Common × 1 · Uncommon × 1.15 · Rare × 1.3 · Epic × 1.5 · Legendary × 1.75 (set pieces are Legendary) · Mythic × 2 |
| Upgrades | + 4 % per upgrade level (+10 is × 1.4) |
| Void | × 1.1 |
| Two-handed weapons | A mage's staff, a hunter's bow and a warlock's staff take both hands (these classes have no off-hand), so they count twice. A warrior's sword and shield count once each. Every class can reach the same total. |

Each item is rounded to a whole number and the items are added up. Example: a +5 Legendary at item level 20 is 20 × 10 × 1.75 × 1.2 = 420.

A better item (higher item level, rarer, more upgrades, or Void) never lowers your Gear Score. An item that fails the server's item check (it could not have dropped as it is) counts 0 and says so in the breakdown.

### Character Power
How strong your hero is as equipped, from an actual fight, so your build counts and not only your numbers: crits, speed, set bonuses, Legendary effects and Mythic signatures all fight.

Your hero runs the **Proving Grounds**: 20 trials at levels 4, 8, 12 … 80. Each trial is three foes back to back (a brute, a hexer, a brute: physical and magic damage) and then a champion two levels higher, a boss that enrages after 40 seconds. Between fights the hero searches for 2 seconds and heals as in the field; kill effects and bloodrush streaks carry from fight to fight.

- **Getting through:** up to 100 points per trial: 15 for each foe and 55 for the champion. A fight you lose still counts for the share of its health you took.
- **Clearing fast:** a cleared trial adds up to 100 more: 100 × (1 − time ÷ 120 seconds).

Power is the sum over the trials (at most 4,000). The trials, the foes and every dice roll are fixed, so the same hero always gets the same Power. Gold find, item find, XP gain and resource yield do not fight and do not count. Items that fail the server's item check are left out, as if the slot were empty.

Power reflects class balance too: with the same kind of kit the classes are within about 20 % of each other (the hunter highest at level 28, the warlock lowest). Boards can be filtered by class.

### PvE Progress
How far your hero has come. There are ten milestones, in the order heroes usually meet them:

1. Abandoned Fields reached
2. Crowwood reached (level 5)
3. Old Burial Grounds reached (level 9)
4. Blackwater reached (level 13)
5. The Nameless Crypt, tier I cleared
6. Sunken Abbey reached (level 17 and the Gravewarden slain)
7. The Nameless Crypt, tier II cleared
8. The Nameless Crypt, tier III cleared
9. The Ashen Pass reached (level 24, the Gravewarden slain, and the Pass opened by the community)
10. The Ashen Warden defeated

Your score is how many of them you have reached ("7 of 10"). If two heroes have the same number, the one whose furthest milestone is further down the list is ahead; then the one who helped break the higher **guild boss stage** (a stage your account earned the reward for, in a week this hero fought the boss for that guild). On the boards (5.2), a remaining tie goes to whoever got there first.

## Boards (ticket 5.2)

Code: game-core `scoring/boards.ts` (board names, `BOARD_SCOPES`, `LEVEL_BRACKETS`, `compareBoardEntries`) and `scoring/scores.ts` (`computeScore`, `metricInput`); server `apps/server/src/leaderboards/` (`snapshot.ts` refresh and sweep, `check.ts` recompute check, `leaderboard-cli.ts`, `routes.ts` hook and `GET /api/leaderboards/:metric`); web `apps/web/src/screens/BoardsScreen.tsx` (`#/boards/<metric>?class=&bracket=`, the "Roll of Renown"; linked from the status bar and the Standing panel). Screenshots: `docs/screenshots/phase-5/boards-*.png` (`node tools/screenshots/boards.mjs` against `E2E_TIME_SCALE=3000 pnpm --filter @worldforge/server e2e:serve`).

### Snapshots
`leaderboard_entries` (`DATA_MODEL.md`) holds one row per hero and metric: `formula_version`, `value`, `sort_key`, `inputs_hash`, the full stored `input`, `achieved_at`, plus copies of class and level for the filters.
- **When:** after every successful write a player makes to a hero (an `onSend` hook on every non-GET route under `/api/characters`: settle, stop, equip, unequip, forge, merchant, quests, crypt and Watch claims, warehouse, character creation; and `POST /api/guild/boss/attempts`, which can earn a stage for all the account's heroes). It runs after the value transaction has committed and before the answer is sent, so the player's next board read sees it. A failed refresh is logged and repaired by the sweep, never answered as an error.
- **Debounce:** each metric's slice of the input (`metricInput`: Level reads level and XP; Gear Score class and equipment; Power class, level and equipment; PvE Progress level, progress, world flags and guild stage) is hashed; only metrics whose slice changed are recomputed. A settlement that only adds XP recomputes Character Level, never Power; an unchanged hero costs three small reads. A game-core test checks that a change outside a metric's slice never moves it.
- **Window rule:** `achieved_at` is the game clock when the request that moved the score arrived (before its transaction), not the moment of the refresh; for changes the sweep finds, it is the sweep's time. It changes only when the `sort_key` changes (a formula bump that changes nothing in the input keeps it). Seasons (5.3) compare it with their boundaries.
- **Races:** refreshes of one hero serialise on a transaction-scoped advisory lock (`leaderboard:<id>`) and re-read the state under it, so the last one writes the newest committed state; gameplay rows are only read, never locked. World flags are read once before the lock (from the 60 s cache); a refresh that read flags just before a project completes may write the old flags, which the next sweep corrects.
- **Sweep and backfill:** each run of the settlement scheduler (`SETTLE_INTERVAL_SECONDS`) refreshes up to 200 heroes: first heroes without a current row for every metric (existing heroes after deploy, every hero after a formula bump), then a rotation over all heroes, which catches what no request of the hero's own saw (scheduled settlements while away, a world flag, a guild boss stage broken by a guildmate). A board read also backfills the viewer's own heroes. Rows of an older formula version are never shown.

### Recompute check
`checkLeaderboards` (CLI: `pnpm admin:leaderboards check`, `deploy/admin.sh leaderboards check`) recomputes every row: **wrong** (stored value or key differs from `computeScore(metric, stored input)`, or the hash does not match the stored input; exit 1), **outdated** (older formula version), **stale** (the hero's current state hashes differently), **missing**. `refresh` rewrites every hero's rows from current state. Tests: `leaderboards.test.ts` (after API events and the sweep, every row matches; tampering is told apart from a bump), the journey step (no wrong rows, the hero's rows current).

### What a board shows
- **Order:** `sort_key` (higher first, the metric's own tie-breakers included), then `achieved_at` (reached first wins), then the hero id. game-core's `compareBoardEntries` is the reference; a test checks the SQL order against it.
- **Filters:** all-time (`scope=allTime`) or a season (`scope=season`, 5.3), class, level bracket (`LEVEL_BRACKETS`: 1–9, 10–19, 20–29, 30+, by the hero's level at its latest refresh). Pages of 25 (API: 1–100), with an offset cursor; ranks are recomputed on every read, so a page boundary can shift between reads while scores move.
- **Your place:** each of your heroes that fits the filters, with its rank.
- **Who is listed (owner decision):** every hero, by its player's display name, no opt-out; blocks hide no one. The name links to the profile only where `canViewProfile(visibility, relation)` allows it for this viewer, and the **hero's name is shown only there** (a hidden profile keeps its heroes' names private; the board shows class and level). Names a moderator hides read "Name withheld". **Accounts with any active sanction** (mute, suspend, rename, hide) are left out at read time and come back when it ends; their scores keep being stored.
- **Report:** each other player's entry has Report → their display name (`profileField`), and the hero's name (`characterName`) where it is shown, through the shared report dialog.
- **Polling:** the page re-reads once a minute with the `ETag` (`304` when unchanged); board reads have their own limit of 60 a minute per account, on top of 3.9's limits.
- **Invariance:** boards only read. No gameplay number changes; the no-effects hashes and balance suites are untouched (`leaderboards.test.ts` "invariance").

## Seasons and prestige (ticket 5.3)

Code: game-core `scoring/seasons.ts` (windows, plan rules, `SEASON_CLOSE_GRACE_MS`, the automatic next season) and `scoring/prestige.ts` (`PRESTIGE_TIERS`, `SEASON_TITLES`, `seasonAwards`, `bestAward`); server `apps/server/src/seasons/` (`model.ts` season rows, archive, awards, plan changes, `prestigeFor`; `routes.ts` player and admin routes; `season-cli.ts`); web `BoardsScreen.tsx` (the Time filter, `#/boards/<metric>?season=current|<n>`), `social/Prestige.tsx` (marks), `HonoursPanel.tsx` (the chooser on your profile), the Seasons tab of the admin panel. Screenshots: `docs/screenshots/phase-5/seasons-*.png`, `honours-*.png`, `admin-seasons-*.png` (`node tools/screenshots/seasons.mjs`, a dev server on a scratch database).

### The season model
- `seasons` (`DATA_MODEL.md`): number, `[starts_at, ends_at)` in UTC (the game clock; equal to the wall clock in production), `archived_at`, `awarded_at`. Default length 8 weeks; 1 day to 26 weeks. Seasons never overlap.
- **Plan changes** (the admin panel and the CLI, one rule set in game-core, serialised on an advisory lock, audited `season.schedule` / `season.end` / `season.extend` with `via`): schedule the next season (or re-plan the one not yet begun; it may not start before the latest begun season ends); move the end of the current or the next season, earlier (**end early**: now) or later (**extend**). A next season that starts exactly where the moved one ended moves along with it, keeping its length; any other overlap is refused (`409 season_plan_refused`, `details.problem`). An ended season cannot change.
- **The first season** is scheduled by the owner; nothing starts by itself. Once a season has begun and nothing follows it, the scheduler adds the next one back to back (8 weeks; after a server outage longer than a season, it starts at once instead).

### Definition of a season score
A season board ranks `season_entries`: each hero's standing on that board within the season, written by 5.2's refresh **in the same transaction** as its all-time row, whenever the hero's `sort_key` moves and the refresh's clock lies in the season's window. That clock is the **request's arrival** (`achieved_at`, the window rule): a change requested before the end counts even if its refresh commits a moment after; one at or after the end goes to the next season. Changes the sweep finds (settlements while away, a world flag) count at the sweep's time.
- `value`, `sort_key`, `achieved_at`: the latest standing reached inside the window, i.e. **the score at the season's end**.
- `base_sort_key`: the hero's all-time `sort_key` just before its first change in the season (null: none yet). The board lists rows with `sort_key > base_sort_key` (lexicographic, as `compareSortKeys`), so a hero that only fell, or fell and recovered, is not listed. Order and filters as on the all-time board (`compareBoardEntries`, class, level bracket by the level at the latest in-season change).
- A formula version bump mid-season updates the season rows' value and key but keeps their base and time (a known limit: bump formulas between seasons).

### Archive (final standings)
`archiveSeason` runs from the scheduler once `now ≥ ends_at + 5 min` (`SEASON_CLOSE_GRACE_MS`). One transaction under the season's exclusive advisory lock (`season:<n>`): refreshes take it shared before writing a season row and re-check `archived_at`, so the archive waits for every refresh in flight and none writes after it. Per board, the listed rows of accounts **without an active sanction at that moment** are copied to `season_standings` with `rank` 1…n (the board order), then `archived_at` is set. A past season's board reads the archive (filters re-rank within it; accounts sanctioned now are left out, ranks kept). Tested: the archive equals every season board (metrics, filters, pages) read just before the end.

### Awards (exactly once, resumable)
`awardSeason` recomputes the awards from the archive with game-core `seasonAwards` (per account and board: the best tier among its heroes, then the better place; deterministic) and inserts them in batches with `on conflict do nothing` on `season_awards`' primary key `(season, account, metric)`. Only after the last batch, in one transaction under the season lock, it gives each account decorated this season that never chose a display its default (`bestAward`: best tier, newest season, board order), sets `awarded_at` and audits `season.award` once. A crash mid-way leaves `awarded_at` null; the next scheduler run (or `admin:seasons close`) finishes the same set. Two instances at once insert each award once (real-PG test).

**Tier thresholds** (game-core `PRESTIGE_TIERS`, data): Champion rank 1, Exalted ≤ 10, Renowned ≤ 100, Veteran any rank with the hero at level ≥ 10 at its last in-season change (`VETERAN_MIN_LEVEL`, the minimum activity: a hero must rise on the board and be past the first areas, so throwaway heroes earn nothing). Asset names (A.10): frames `season-frame-champion|exalted|renowned|veteran`, title badges `title-badge-level|gear-score|power|pve-progress`, drawn from A.10's `frame.<name>` / `badge.<name>` (`prestigeSprite` in `apps/web/src/content/assets.ts`): on the profile the chosen frame sits at ×4 around the first hero's class portrait (in `SEASON_FRAME_WINDOW`), in the honours preview at ×1 around the board's badge; title badges are 32 px, shrunk smoothly to 24 px in board and roster rows (the guidelines' one exception). A 64 px frame does not fit a row, so rows show a small rim in the tier's metal. Missing or failing art falls back to a CSS rim and an enamelled lozenge.

### Display
`prestige_displays` holds each account's chosen title and frame (each a reference to one of its own awards, composite foreign keys; nulls = shows none; no row = never chosen). `prestigeFor` resolves it for boards (`player.prestige`), profiles (`prestige`) and both guild rosters (`members[].prestige`; not for a member the viewer blocks). Cosmetic only: nothing in game-core's rules reads `prestige.ts` or `seasons.ts` (a test scans the imports), and awards and displays change no gameplay row, score input or score (invariance test). Privacy is unchanged: everyone is listed by name; the profile link and the hero's name follow `canViewProfile` (tested on season boards and archives for each visibility × relation).

## The arena ladder (ticket 5.6)

A fifth season board, next to the four: the season's rated duel ladder (`GET /api/arena/ladder`), by **arena rating** (Glicko-2, per hero and season), never by Power or Gear Score (GDD §10.3). Everything about the rating, matchmaking and win-trading is in `PVP.md` "Rating, matchmaking and the ladder"; what concerns the boards:
- **Same rules as the 5.2/5.3 boards:** everyone listed by name, profile link and hero name per `canViewProfile`, hidden names withheld, sanctioned accounts left out at read time, class and level-bracket filters (10–19, 20–29, 30+: rated duels open at 10), pages, ETag polling, the board read limit, report from an entry.
- **Who is ranked:** heroes with at least 10 rated duels in the season (attacking or defending); fewer are "provisional" and appear only under your own place, without a rank. Order: rating, then more rated duels, then the earlier latest duel, then the hero id. Shown in plain words: the rating, its likely range (± 2 deviations) and "provisional", "still settling" or "settled".
- **Seasons:** a rating lives in one 5.3 season. At the season's end the archive copies the ladder into `season_standings` as metric `arena` (same transaction and lock as the four boards; established heroes, sanctioned accounts left out), and `awardSeason` honours it with the same tiers, exactly once (title noun **Duellist**, the Character Power badge, the tier frames). The next season starts every hero halfway back toward 1,500.
- **Not a score:** the ladder has no `leaderboard_entries` rows, no formula version of the 5.1 kind and no recompute check; every rating change is stored on its duel (`duels.rating`) and can be recomputed with game-core's `rateDuel`.

## Technical spec (for 5.2)

### Versioning
`FORMULA_VERSIONS` (game-core `scoring/types.ts`) holds one version per metric (`level`, `gearScore`, `power`, `pveProgress`; all 1 now). Bump a metric's version whenever its value can change for the same inputs: a weight, a reference foe, a trial, a milestone, or a combat rule that Power runs through (`buildEncounter`, `resolveDungeonFight`, effects, stat derivation, `validateItem`). The pinned values in `scoring/scoring.test.ts` fail when a number moves; the fix is a version bump, a new pin and an update here in the same change. The pinned no-effects hashes and balance suites are untouched by scoring (scoring only reads the rules).

### Inputs
`ScoringInput` (game-core `scoring/scores.ts`), built by the server only (`scoringInput` in `apps/server/src/scores/routes.ts`):
- `classId`, `level`, `experience` (the `characters` row);
- `equipment`: the equipped `item_instances` rows with their slot, as stored (seed, base, rarity, item level, affixes, upgrade level, variant, effect, effect roll, Mythic, set);
- `progress` (`characters.progress`) and `world` (the world flags);
- `guildBossStage`: the highest stage of `guild_boss_rewards` with `status = 'earned'` for the hero's account, in a (guild, week) for which this hero has a `guild_boss_attempts` row.

`computeScores(input)` returns all four `Score`s: `{ metric, formulaVersion, value, sortKey, summary, lines }`. `sortKey` is compared lexicographically, higher first: Level `[level, xp]`, Gear Score `[total]`, Power `[power]`, PvE Progress `[count, furthest, guildStage]`. 5.2 appends "reached first" (earlier wins).

### Validation (stat-inflation resistance)
Before an item counts (`checkEquipment`): `validateItem` must find no problem, the upgrade level must be a whole number 0–10, the slot must be a real equipment slot that the base fits and the class can use, and only one item may sit in a slot (two in one slot: neither counts). A rejected item counts 0 for Gear Score and is left out of Power. Level and XP outside what the server stores are refused (`RangeError`), not clamped; a guild boss stage that is not a whole number counts 0 and is capped at the boss's last stage.

### Determinism
Pure functions over the input: no clock, no `Math.random`, no ambient state. Power's fights draw from fixed seeds (`power:v<version>:<trial>:<run>:<fight>`, two runs per trial, averaged) and a fixed enrage moment; its foes are scoring data (`PROVING_BRUTE`, `PROVING_CASTER`, `PROVING_CHAMPION`, `DEFAULT_POWER_CONFIG`), not world enemies, so a content retune of an area does not move Power (a change to the combat rules does: bump the version). Tested: equal results across calls, pinned values across processes, and the server route equals `computeScores` on the stored input.

### Cost
Power is the only non-trivial score: 20 trials × 2 runs × at most 4 fights (≤ 160 short fights, detailed resolution, no distributions). About 2 ms per hero on a laptop, independent of the hero's level; the test budget is 25 ms (`scoring.test.ts`). Gear Score, Level and PvE Progress are microseconds. Computing all four on every relevant change is cheap; 5.2 should still compute after the change's transaction, not inside the character lock.

### Recompute rule
5.2 stores per hero and metric: `(metric, formulaVersion, input, value, sortKey, reachedAt)`. Any stored value must equal `computeScores(input)` for its version (an audit query can check every row). Recompute from server state when:
- the level or XP changes (Level, Power) — settlement, crypt and Watch claims, quests;
- an equipped item changes: equip, unequip, upgrade, reroll or improve of a worn item, warehouse moves of a worn item (Gear Score, Power);
- `characters.progress` changes: crypt and Watch claims (PvE Progress);
- a guild boss reward becomes `earned` (PvE Progress of the heroes of that account that fought that week);
- a world flag changes (PvE Progress of every hero; a background job);
- a metric's formula version is bumped (recompute every stored row from its stored input, then from current state on the hero's next change).
`reachedAt` changes only when the `sortKey` changes. Sanctioned accounts are excluded at read time (5.2), not by changing their scores.

### Known limits and owner decisions
- **Guild boss stages are a tie-breaker, not milestones** (the ticket listed them among the milestones). A stage is broken by a whole guild; counting it as a personal milestone would let a weak hero in a strong guild outrank a stronger solo hero. Owner can override (e.g. stage 5 as an 11th milestone).
- **Areas count when they are open to the hero** (the unlock rule: level, Gravewarden, world flag), not when first visited: no "visited" record exists. When the community opens the Ashen Pass, every hero of level 24 with the Gravewarden slain gains milestone 9 at once.
- **Power's scale** saturates at 4,000 (20 trials); today's best builds at level 23 score about 3,500–3,700 and level-35 heroes in epics +5 about 2,700–3,050. Content above level 28 (Phase 6) can add trials in a new version.
- **Power and class balance:** the spread between classes (up to × 1.21 with the same kit) is the combat balance, not the formula; a per-class board (5.2 filter) compares like with like.
- **Farming-only value** (kill speed in an area, gold, item find) is not in Power. The three foes per trial let kill effects (Carrion Feast, Bloodrush, Ambush, the Bloodmoon opener) count, but Power leans toward the boss: against the B.2 build search it follows the tier III Gravewarden's boss times (Spearman 0.65–0.78 per class) more than farming rates.

## Tests
- `packages/game-core/src/scoring/scoring.test.ts`: determinism and pinned values; Level order and refusals; Gear Score weights, the two-handed rule, monotonicity (over 10,000 item pairs: each better item level, rarity, upgrade and Void; and every slot swap to a better item); stat-inflation resistance (14 forged items count 0 and leave Power unchanged, duplicate slots, a class item on another class, no false rejections over generated kits); Power grows with level and gear tiers, class spread, breakdown, performance budget; PvE milestones cover every area and crypt tier, order, ties, guild stage bounds.
- `packages/game-core/src/scoring/power-ranking.test.ts`: Power against the B.2 build search (48 builds per class at level 23): Spearman with boss time > 0.5, every top build (within 7 %) above the median, the slowest quarter below the best top build, +5 and +10 Void add Power.
- `packages/game-core/src/scoring/boards.test.ts` (5.2): `computeScore` equals `computeScores`, each metric's slice covers what it reads, brackets cover every level once, board order.
- `apps/server/src/leaderboards/leaderboards.test.ts` (5.2): refresh on equip with the request clock, XP-only debounce, bracket levels, sweep backfill and a world flag, wrong vs outdated, board order and pages, ties, filters and your rank, ETag, every sanction kind excluded and restored, no ids in answers, bad queries, read limit, viewer backfill, the profile-link matrix (each visibility × self, friend, guildmate, pending, stranger, blocked either way; the profile route agrees), invariance.
- `apps/server/src/leaderboards/leaderboards.pg.test.ts` (5.2, real PostgreSQL): a score change racing board reads (old or new value, never another); equips and stray refreshes racing (every row current afterwards); no retries.
- Journey: `playLeaderboardStep` (`e2e/journey.ts`; `leaderboard-journey.test.ts` and the Phase 4 exit run under its leak guard).
- `packages/game-core/src/scoring/seasons.test.ts` (5.3): windows and the boundary, status, plan rules (schedule, re-plan, end early, extend, followers, refusals), the automatic next season, tiers and asset names, awards independent of order, the default display.
- `apps/server/src/seasons/seasons.test.ts` (5.3): the window rule at the boundary (a request 1 ms before the end refreshed after it counts; the end moment goes to the next season; nothing written after the archive), season boards list only risers in board order, archive integrity (every metric, filters, pages; sanctioned left out; ranks 1…n), awards exactly once and the default display, choosing a title and frame (refusals; shown on boards, profiles and both guild rosters), a crash mid-award then a rerun, the profile-link privacy matrix on season boards and archives, 404s, admin controls (404 to everyone else, schedule, extend, end early, audit), the CLI, invariance and the import scan.
- `apps/server/src/seasons/seasons.pg.test.ts` (5.3, real PostgreSQL): award runs racing (some crashing mid-way): each award once, one default display per account, one audit row; a restart mid-award then three resumes racing; a score change racing the archive: the archive equals the season board in every order, and nothing is written after it.
- Journey: `playSeasonStep` (`e2e/journey.ts`; `season-journey.test.ts`): the owner schedules a season in the admin panel, the hero rises on its board, the season ends, the hero is honoured once and shows its title and frame to another player; scores unchanged.
- `apps/server/src/scores/scores.test.ts`: the route equals `computeScores` on the stored input, a forged item row counts 0, the guild boss stage rule, 404 for another account's hero, 401 without a session.
