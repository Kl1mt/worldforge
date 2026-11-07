# Telemetry (ticket 3.8)

Server-side, privacy-conscious aggregates for balance work (GDD §16.4, §15 Phase 3: "telemetry for drop rates, item usage and build distribution"). There is no client tracking and no personal data: counters hold content ids, small enums and numbers only. The report is a command (`pnpm report:telemetry`); there is no admin UI yet (see "Exposing it later").

## Design: rollups in the transaction

Every value path already writes an audit row in its own transaction. Next to that `writeAudit`, it now calls `recordTelemetry(tx, now, counts)` (`apps/server/src/telemetry/record.ts`). Nothing is written then: counts are summed in memory per transaction, and `withTransaction` writes them in **one** `INSERT … ON CONFLICT DO UPDATE` into `telemetry_daily` as the transaction's **last** statement.

Why not derive the numbers from the audit log instead:
- **The audit log does not hold what telemetry needs.** It lists Epic+ farming drops individually and everything else as totals; drop rarity, Void, effects and sets per drop, upgrade outcomes per level and the hoard/chamber split would all have to be added to every audit row. Fatter audit rows on the hottest path (farming settlement) cost more than a few counter upserts, and the audit log is a ledger, not an analytics store.
- **Reports stay cheap.** A report sums a few hundred rollup rows per day instead of scanning and parsing every `jsonb` audit row ever written.
- **Consistency is the same.** The counters commit or roll back with the audit row they mirror, so they cannot drift from it. `reconcileWithAudit` proves it: it recomputes its totals from the audit log (gold, items kept/overflowed/filtered, materials, crypt wins/losses/hoards, turn-ins, merchant and forge counts and spending, guild founding, and since 4.6 community contributions, their gold and materials and the stages completed) and compares them with the rollups, exactly.

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
| `gold.in` | `farming_loot`, `farming_overflow`, `farming_filter`, `crypt_loot`, `crypt_overflow`, `crypt_filter`, `quest`, `contract`, `merchant_sell`, `forge_salvage`, `guild_boss` (ticket 4.9, context empty) | area, tier or quest id | | / gold |
| `gold.out` | `merchant_buy`, `forge_craft`, `forge_upgrade`, `forge_reroll`, `forge_improve`, `guild_create` (ticket 4.4, context empty) | rarity or recipe id | | / gold |
| `material.in` | `farming_gather`, `farming_filter`, `crypt_loot`, `crypt_filter`, `quest`, `contract`, `forge_salvage`, `guild_boss` | material id | | / quantity |
| `material.out` | `forge_craft`, `forge_upgrade`, `forge_reroll`, `forge_improve` | material id | | / quantity |
| `gold.in` | `farming_loot`, `farming_overflow`, `farming_filter`, `crypt_loot`, `crypt_overflow`, `crypt_filter`, `quest`, `contract`, `merchant_sell`, `forge_salvage` | area, tier or quest id | | / gold |
| `gold.out` | `merchant_buy`, `forge_craft`, `forge_upgrade`, `forge_reroll`, `forge_improve`, `guild_create` (ticket 4.4, context empty), `community_project` (ticket 4.6, context the project id) | rarity, recipe or project id | | / gold |
| `material.in` | `farming_gather`, `farming_filter`, `crypt_loot`, `crypt_filter`, `quest`, `contract`, `forge_salvage` | material id | | / quantity |
| `material.out` | `forge_craft`, `forge_upgrade`, `forge_reroll`, `forge_improve`, `community_project` (ticket 4.6) | material id | | / quantity |
| `community.contribute` | project id | stage id | | contributions (ticket 4.6) |
| `community.stage` | project id | stage id | | stages completed (ticket 4.6) |
| `xp.in` | `farming`, `crypt`, `quest`, `contract` | area, tier or quest id | | / XP |
| `farming.settle` | area | | | settlements with a reward (one per `activity.reward` row) / simulated seconds |
| `crypt.start` | `<dungeon>:<tier>` | `hoard_eligible` or `on_cooldown` | | runs entered |
| `crypt.claim` | `<dungeon>:<tier>` | `won` or `lost` | `hoard` or `no_hoard` | claims |
| `quest.reward` | `story` or `contract` | quest/template id | `no_item`, `fixed`, `targeted` | turn-ins |
| `guild_boss.attempt` | boss id | `fell` or `endured` | | attempts / counted damage (ticket 4.9) |
| `guild_boss.stage` | boss id | stage | | stages reached |
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
