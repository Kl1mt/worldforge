# Telemetry (ticket 3.8)

Server-side, privacy-conscious aggregates for balance work (GDD §16.4, §15 Phase 3: "telemetry for drop rates, item usage and build distribution"). There is no client tracking and no personal data: counters hold content ids, small enums and numbers only. The report is a command (`pnpm report:telemetry`); there is no admin UI yet (see "Exposing it later").

## Design: rollups in the transaction

Every value path already writes an audit row in its own transaction. Next to that `writeAudit`, it now calls `recordTelemetry(tx, now, counts)` (`apps/server/src/telemetry/record.ts`). Nothing is written then: counts are summed in memory per transaction, and `withTransaction` writes them in **one** `INSERT … ON CONFLICT DO UPDATE` into `telemetry_daily` as the transaction's **last** statement.

Why not derive the numbers from the audit log instead:
- **The audit log does not hold what telemetry needs.** It lists Epic+ farming drops individually and everything else as totals; drop rarity, Void, effects and sets per drop, upgrade outcomes per level and the hoard/chamber split would all have to be added to every audit row. Fatter audit rows on the hottest path (farming settlement) cost more than a few counter upserts, and the audit log is a ledger, not an analytics store.
- **Reports stay cheap.** A report sums a few hundred rollup rows per day instead of scanning and parsing every `jsonb` audit row ever written.
- **Consistency is the same.** The counters commit or roll back with the audit row they mirror, so they cannot drift from it. `reconcileWithAudit` proves it: it recomputes its totals from the audit log (gold, items kept/overflowed/filtered, materials, crypt wins/losses/hoards, turn-ins, merchant and forge counts and spending, guild founding, and since 4.6 community contributions, their gold and materials and the stages completed; since 4.7 warehouse items deposited and withdrawn, upgrades and their gold; since T.3 account shelf moves per direction and kind) and compares them with the rollups, exactly. Since T.3 it also checks a conservation rule against stored state: what every account shelf holds (items, material units, gold) equals shelf deposits minus withdrawals in the audit log. Since T.5: completed trades, traded items (`trade.items` and `item.fate trade traded`), trade gold and material units **in = out** against the `trade.accept` rows; escrow conservation (items, gold and material units in open offers = `trade.offer` minus what endings returned and accepts handed over); held gold = what accepts gave minus `trade.release`; and every hold released at most once. Since T.6: reversals (`trade.reverse` count and items moved back) and their gold and material units **in = out** (source `trade_reverse`) against the `trade.reverse` rows; a hold a reversal ends writes its own `trade.release` (`via: 'reverse'`), so "held = received − released" and "released once" still hold.

Guarantees:
- **Commit together, roll back together.** A refused request (`4xx`), a thrown error and a rolled-back attempt leave no counts. A deadlock/serialization retry re-runs the callback on a fresh transaction, whose counts start empty.
- **Idempotent replays never double-count.** A replayed `Idempotency-Key` returns the stored response without running the handler, so it records nothing; a raced key blocks on the claim and then replays.
- **No extra writes beyond counters, and short locks.** One statement per transaction, and only when something was recorded. The hot counter rows (e.g. today's `gold.in farming_loot abandonedFields`) are locked only between that statement and the commit.
- **No deadlocks.** Every transaction flushes at most once, with its rows sorted by key, so all transactions take counter-row locks in the same order, and after every other lock they take. The real-PostgreSQL suite races settles, claims, sells and upgrades of many characters on the same rows and asserts zero retries.
- **Never changes gameplay.** The builders (`telemetry/counts.ts`) only read results the path already computed; game-core is untouched. The one extra computation is in a crypt claim with a boss hoard: the run is replayed without the hoard (pure, its own RNG stream) to tell hoard drops from chamber drops. All existing tests, the no-effects/no-filter hashes and the exit-criteria runs are unchanged.
- **No personal data by construction.** `recordTelemetry` refuses a dimension that is not a content id (`[A-Za-z0-9_:+.-]{0,64}`, never uuid-shaped), so an id, email or name fails loudly in tests instead of reaching a rollup. Tests assert that neither the table nor the report contains any account or character id, email, name or token.

### Day buckets and windows

Each count is stamped with the **game-clock day (UTC)** of the transaction that recorded it: the moment value moved. This is the window rule from the Phase 3 ground rules, stored explicitly:
- A farming settlement counts on the day it settles, even when its window started the day before (offline time is credited at settlement).
- A crypt run counts `crypt.start` on the day it was entered and `crypt.claim` (with all its loot) on the day it was claimed. Tested: a run entered at 23:59 and claimed after midnight shows its start in one day and its claim in the next.
- Drops of a settlement that switched area mid-window count under the area it started in (the audit row's `areaId`).

The audit log is stamped by the database clock, the rollups by the game clock, so reconciliation compares all-time totals. `telemetry_daily.day` is part of the playtest clock floor (`latestStoredTimeMs`).

## Metrics

`events` counts occurrences; `amount` sums a quantity. Sources: `farming`, `crypt` (chamber drops), `crypt_hoard` (the Gravewarden's hoard), `quest` (story), `contract`, `merchant` (bought), `craft`.

| Metric | dim1 | dim2 | dim3 | events / amount |
| --- | --- | --- | --- | --- |
| `item.drop` | source | area id, `<dungeon>:<tier>`, quest/contract id, merchant area or recipe id | rarity | items that entered the game (every rolled drop, whatever became of it) |
| `item.variant` | source | variant (`void`) | rarity | items |
| `item.effect` | source | effect id (Legendary effect or Mythic signature) | rarity | items |
| `item.set` | source | set id | | items |
| `item.fate` | source | `kept`, `kept_over_capacity` (B.2: a valuable drop kept beyond a full pack), `filter_sold`, `filter_salvaged`, `overflow_salvaged` | rarity | items / filter gold per item |
| `item.sold` · `item.salvaged` · `item.discarded` | rarity | | | **manual** merchant sells, forge salvages, discards / gold |
| `pack.overflow` | `farming` or `crypt` | area or tier | | settlements/claims that hit a full pack / items auto-salvaged |
| `pack.over_capacity` | `farming` or `crypt` | area or tier | | settlements/claims that kept valuable drops beyond the capacity (B.2) / those items |
| `gold.in` | `trade`, `trade_reverse` (tickets T.5, T.6: see `gold.out`), `farming_loot`, `farming_overflow`, `farming_filter`, `crypt_loot`, `crypt_overflow`, `crypt_filter`, `quest`, `contract`, `merchant_sell`, `forge_salvage`, `guild_boss` (ticket 4.9, context empty) | area, tier or quest id | | / gold |
| `material.in` | `trade`, `trade_reverse` (tickets T.5, T.6), `farming_gather`, `farming_filter`, `crypt_loot`, `crypt_filter`, `quest`, `contract`, `forge_salvage`, `guild_boss` | material id | | / quantity |
| `gold.out` | `trade` (ticket T.5: gold given in an accepted trade, context empty; `gold.in trade` is the same gold arriving, so the two always match), `trade_reverse` (ticket T.6: the same gold going back in a reversal; matched by `gold.in trade_reverse`), `merchant_buy`, `forge_craft`, `forge_upgrade`, `forge_reroll`, `forge_improve`, `guild_create` (ticket 4.4, context empty), `community_project` (ticket 4.6, context the project id), `warehouse_upgrade` (ticket 4.7, context empty) | rarity, recipe or project id | | / gold |
| `material.out` | `trade` (ticket T.5, matched by `material.in trade`), `trade_reverse` (ticket T.6, matched by `material.in trade_reverse`), `forge_craft`, `forge_upgrade`, `forge_reroll`, `forge_improve`, `community_project` (ticket 4.6) | material id | | / quantity |
| `community.contribute` | project id | stage id | | contributions (ticket 4.6) |
| `community.stage` | project id | stage id | | stages completed (ticket 4.6) |
| `warehouse.move` | `deposit` or `withdraw` | | | moves that changed something / items moved (ticket 4.7) |
| `warehouse.upgrade` | `level1`…`level6` (the level bought) | | | upgrades (ticket 4.7) |
| `shelf.move` | `deposit` or `withdraw` | `items`, `materials` or `gold` | | moves (one per kind per request) / items, material units or gold moved (ticket T.3, the account shelf). Shelf gold is not `gold.in`/`gold.out`: it stays with the account |
| `trade.complete` | `gift` or `swap` | | | accepted trades (ticket T.5) |
| `trade.items` | rarity | variant or `none` | | items that changed hands (both sides) |
| `trade.reverse` | `gift` or `swap` | | | / items moved back: trades a moderator reversed (ticket T.6) |
| `xp.in` | `farming`, `crypt`, `quest`, `contract` | area, tier or quest id | | / XP |
| `farming.settle` | area | | | settlements with a reward (one per `activity.reward` row) / simulated seconds |
| `crypt.start` | `<dungeon>:<tier>` | `hoard_eligible` or `on_cooldown` | | runs entered |
| `crypt.claim` | `<dungeon>:<tier>` | `won` or `lost` | `hoard` or `no_hoard` | claims |

Ticket 4.8: the Warden's Watch records under the same metrics as `ashenWatch:1` (`crypt.start`, `crypt.claim`, `item.drop` source `ashenWatch:1`), and the Ashen Pass as the area `ashenPass`. Since B.3 the telemetry simulation farms both (below).
| `quest.reward` | `story` or `contract` | quest/template id | `no_item`, `fixed`, `targeted` | turn-ins |
| `guild_boss.attempt` | boss id | `fell` or `endured` | | attempts / counted damage (ticket 4.9) |
| `guild_boss.stage` | boss id | stage | | stages reached |
| `duel.fight` | `rated` or `friendly` | bracket id | `challenger`, `defender` or `draw` | duels (ticket 5.5; no amount: a duel moves no value). Reconciled per kind with `duel.fight` audit rows (`duels: rated`, `duels: friendly`) |
| `arena.rated` | bracket id | `full`, `reduced` (a repeat pair at ½ or ¼), `none` (factor 0) or `no_season` | | rated duels by how much they counted (ticket 5.6) |
| `arena.offer` | bracket id | `range0`, `range1`, `range2` (the Power range used: 5 %, 10 %, 20 %) or `none` (nobody in range) | | opponent lists drawn / opponents offered (ticket 5.6; how often matchmaking had to widen, for B.4) |
| `auth.login` | `ok`, `failed`, `locked` (a failure that started a per-account lock) or `throttled` (refused while locked) | | | login attempts by outcome (ticket 5.7; real clock day). No address or account in any dimension |
| `mail.send` | mail kind (`verify_email`, `reset_password`, `password_changed`, `email_changed`) | `sent` or `failed` | | letters handed to the SMTP provider (ticket 5.7) |
| `boss_modifier.run` | weekly boss modifier (`none` for runs started before 6.3) | `<dungeon>:<tier>` | `won` or `lost` | dungeon runs claimed (ticket 6.3): win rates per modifier and boss. Reconciled with `dungeon.claim` audit rows that carry `bossModifier` |
| `boss_modifier.hoard` | modifier | `<dungeon>:<tier>` | rarity | claims with hoard drops / hoard items (sold, salvaged and filtered included) |
| `boss_modifier.guild_boss` | modifier | boss id | `fell` or `endured` | guild boss attempts / counted damage. Reconciled with `guild_boss.attempt` audit rows that carry `bossModifier` |
| `forge` | `salvage`, `craft`, `upgrade`, `reroll`, `improve` | recipe id; for upgrades the level tried (`+1`…`+10`); for rerolls/improvements the item's rarity | upgrades: `success`, `guaranteed` (certain or pity), `failure`; rerolls/improvements: the resulting affix id | uses (salvage: items) |

The loot filter's drops (`item.fate filter_*`, `gold.in *_filter`, `material.in *_filter`) are kept apart from manual sells and salvages (`item.sold`, `item.salvaged`, `gold.in merchant_sell`/`forge_salvage`). Drop rates use `item.drop`, which includes filtered and overflowed drops, so a filter does not hide what dropped.

**State, not events: equipment and builds.** What is equipped is current state, so the report reads it at report time from `item_instances` (no rollup, no hot-path write): usage per class by base, effect, set and variant, and a **build signature** per character: the three affixes on the most equipped items (ties by id), every equipped effect and every set worn with two or more pieces, e.g. `crit-chance+health+resistance | effect:tyrants-bane | set:drowned-vigil`. Character ids group rows in memory and are never output.

## The report

```
pnpm report:telemetry                              # everything recorded
pnpm report:telemetry -- --from 2026-11-01 --to 2026-11-06
pnpm report:telemetry -- --reconcile               # also check the rollups against the audit log
pnpm -s report:telemetry -- --json > telemetry.json   # machine-readable (ticket B.2)
pnpm report:telemetry -- --out telemetry.json      # text on screen, JSON to a file
```

- **Source:** Postgres when `DATABASE_URL` is set (environment or `apps/server/.env`), else the playtest PGlite database (`PLAYTEST_DATA_DIR`, default `.playtest-data/`); `--db playtest|postgres` chooses explicitly. PGlite allows one process per folder, so the report refuses while the playtest server runs (stop it first). On Postgres it needs `pnpm db:migrate` to have run.
- **Window:** `--from`/`--to` are inclusive game days (UTC); the header shows the window and the recorded days in it.
- **Empty state:** a window without counters prints "No telemetry recorded in this window." and what records them; a database without equipped gear says so.
- **Exit code** 2 when `--reconcile` finds a difference.
- **JSON:** `{ source, window, rollups: [{ metric, dims, events, amount }], snapshot: { equippedCharacters, usage, builds }, reconcile? }`. `rollups` are the raw sums over the window, so B.2 can compute any rate from them.

A sample dataset: `pnpm --filter @worldforge/server telemetry:simulate` plays 24 simulated heroes (six per class, levels 1–23, half with a loot filter, crypt tiers I–III) through the real API for three game days into `.telemetry-sample/` (git-ignored; about a minute), then `PLAYTEST_DATA_DIR=.telemetry-sample pnpm report:telemetry`. Seeds are server-random, so numbers vary slightly between runs. Since ticket B.2 the default player is **realistic** (`--play realistic`: an earned starting purse, five visits a day, and at every visit it wears its best finds, sells and salvages the rest and spends its gold on upgrades; `docs/ECONOMY.md` "Balance pass: loot depth & economy"), and `--days 7` gives the week B.2 measured (about 8 minutes). `--play crude` is 3.8's player (it sells commons, salvages rares, upgrades its first epic; a fat purse and a settle every 3 h around the clock), a smoke test only.

**The Phase 4 economy in the simulation (ticket B.3, `--social on`, the default; `--social off` is B.2's player).** The realistic player now also: moves up to the best area open to it as it levels and to the deepest crypt tier it has opened (B.2's player stayed in its starting area and tier); gives a daily share to the open community project (up to its cap, at most a quarter of its gold, its materials up to the cap), so the projects complete through the real API and open the Warehouse, the Ashen Pass and the Warden's Watch; stores its keepsakes (set pieces, Mythics, Void) in the warehouse and buys the next shelves when they don't fit; joins one of two guilds (4 and 20 members, founded through the API for 5,000 gold each; the members are added directly, a shortcut) and fights the weekly guild boss on Monday, Wednesday and Friday mornings, claiming its spoils every evening; runs the Warden's Watch once a day once open. A seventh profile starts at level 25 (28 heroes). The run ends with a log of the social economy (projects, stages, guild boss stages, warehouse upgrades, heroes reaching the Pass); `tools/balance/sim-state.ts` prints each hero's end state. A 7-day run takes about 9 minutes.

**A whole season (ticket B.4).** `--days 56 --snapshots` also writes every hero's 5.1 scoring input (class, level, XP, worn items, progress, world flags, guild boss stage) at the start and at the end of each game day to `<dir>/snapshots/day-NN.json`; `tools/balance/competitive.ts` builds season populations from one or more such runs (`LEADERBOARDS.md` and `PVP.md` "Balance pass: competitive systems"). A 56-day run takes about 30 minutes; three run side by side on a 4-core machine.

**Trading and the shelf (ticket T.7).** `--trading on` opens trading through the `game_settings` row (the master switch, "Trade: items / materials / gold" and "Shelf: items / materials / gold"; the "Tradeable" categories stay at their defaults, Mythic and Void off); `--trading all` also opens Mythic and Void. Accounts and guild memberships are dated 30 days back and emails verified (a shortcut, like the journey's trade step), so every guild member with a hero at 15 or higher can trade from day one; trades, holds and account age then run on the game clock. At every visit a hero takes the gifts in its inbox (a swap when what it asks leaves 300 or more behind; an offer over a weekly cap is declined), and before salvaging it gifts the Epic and better finds it would salvage, or keepsakes its class can't wear, to the guildmate whose slot they improve most (by 15 % or more; several to one guildmate in one offer). Each morning it may send a guildmate one material gift (a stock of 600+ to one under 60, 150 units; soul shards 20, Abbey silver 3) or a swap when it is short of something they have plenty of, and every other day a hero at 20+ with 20,000 gold or more gives 3,000 to a poorer guildmate four or more levels below. `--alts` (implied by `--trading`) gives the accounts of the eight level-21 and level-23 heroes a second hero (the next class, level 14): one hero of an account farms at a time, so the alt farms the night and the main the day; with the shelf on, the alt shelves three quarters of its gold, half of each material stack over 20 and the finds its main can wear each morning, and the main takes everything out. The run ends with a tally of trades, shelf moves and refusals (caps, open-offer limits); `tools/balance/trading.ts` measures the runs side by side (`docs/ECONOMY.md` "Balance check: trading and the shelf"). A 7-day run with trading takes about 12 minutes.

**Boss modifiers (ticket 6.3).** The report has a "Boss modifiers" section: per modifier and boss (`<dungeon>:<tier>`) the runs won and lost, the win rate, hoard items and how many were Legendary or Mythic; and per modifier the guild boss attempts, how many fell, counted damage and damage per attempt. Runs started before 6.3 show as `none`. `--reconcile` checks `boss_modifier.run` against the `dungeon.claim` and `boss_modifier.guild_boss` against the `guild_boss.attempt` audit rows written since 6.3 (those carry `bossModifier`, older ones are left out on both sides). This is what B.5 tunes the modifiers from; the game-core measurements are in `docs/DUNGEONS.md` and `tools/balance/heroic.ts`.

## Admin view (ticket D.3)

The admin panel's Telemetry tab (`#/admin/telemetry`) shows this report in the browser:
- `GET /api/admin/telemetry?from=&to=&reconcile=true` (admins only, the not-found `404` for everyone else) returns `{ report, sections }`: `report` is exactly `buildTelemetryReport`'s JSON; `sections` are the rollup sections as the text report prints them. Both the CLI text (`renderTelemetryReport`) and the page come from `telemetrySections(report)`, so they never disagree. Read-only, on the primary (no replica yet).
- `reconcile=true` scans the audit log, so it has its own limit: 3 per 5 minutes per admin (`429 rate_limited`, `details.limit: 'reconcile'`).
- The window is the same inclusive UTC game days; a malformed day or `from > to` is `400`.
- Privacy: aggregate rows only, as before. Small-group suppression (e.g. builds with fewer than 5 heroes) is **not** applied, because only admins (the owner) see the page; add it before exposing any of this beyond admins.

## Limits

- Hot rows: at very high concurrency, every settlement in an area waits briefly for the same counter row at commit. If that shows up, shard the rows (an extra `shard` key column from a hash of the transaction, summed in the report); the recorder is the only writer, so this is a local change.
- Counts start with this ticket; earlier history is in the audit log only.
- Rollups are append-only sums; a deleted character's counts stay (they hold no ids).

## Admin tools and test accounts (ticket D.4)

- **Own sources.** Admin tools record under their own sources, so drop rates, sinks and faucets aren't polluted and `reconcileWithAudit` still balances: `gold.in` / `material.in` `admin_grant` (testing) and `admin_refund` (support), `gold.out` / `material.out` `admin_remove`, `xp.in admin`, and the metric `admin.item` (`grant` or `remove`, rarity; amount = items). Granted items are not `item.drop`. The reconciliation checks each against the `admin.gold`, `admin.materials`, `admin.xp`, `admin.item.grant` and `admin.item.remove` audit rows, and the shelf conservation subtracts items an admin removed from a shelf.
- **Test accounts out of the report.** `writeAudit` notes each account a transaction's audit rows name; at the flush, a transaction that named a test account writes its counters to `telemetry_daily_test` (same shape) instead of `telemetry_daily` (one extra indexed read per transaction with telemetry and an account). The balance report (CLI and admin page) reads `telemetry_daily` only; `reconcileWithAudit` sums both tables against the whole audit log, so it balances whatever the flag was when a row was written. The equipped-state snapshot leaves out test accounts and deleted heroes.
