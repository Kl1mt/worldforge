# Community projects & world state

Ticket 4.6, GDD §12.1–§12.2. The town builds things together: global projects with stages that need gold and materials. Any player gives from one of their heroes' holdings; when the last stage is done, the project sets a **world flag** for everyone, and content opens on it.

Code: game-core `world/projects.ts` (definitions, caps, the contribution plan, world flags) and `world/unlocks.ts` (`UnlockRule.worldFlag`); server `apps/server/src/community/` (`model.ts` locks and completion, `routes.ts`, `world-state.ts` the cache, `project-cli.ts`); web `screens/WorksScreen.tsx` (`#/works`, "Town works"), the hub's works slip (`HubScreen.tsx`) and the world notice (`onboarding/notices.ts` `worldNotices`). Endpoints in `API_CONVENTIONS.md`, tables in `DATA_MODEL.md`, telemetry in `TELEMETRY.md`.

## The projects (data)

| Project | Opens after | Sets flag | Used by | Contributor reward |
| --- | --- | --- | --- | --- |
| `restoreWarehouse` — Restore the Graumark Warehouse | — | `warehouseRestored` | 4.7 opens the Warehouse building (`docs/WAREHOUSE.md`: every warehouse route answers `409 warehouse_closed` and the hub shows it locked until then) | achievement `warehouseRestorer` "Mender of Graumark" |
| `clearAshenPass` — Clear the Ashen Pass | `restoreWarehouse` | `ashenPassCleared` | 4.8 opens the area `ashenPass` and its boss run `ashenWatch` (`UnlockRule.worldFlag: 'ashenPassCleared'`) | achievement `ashenPassBreaker` "Through the Ash" |

Never rename or reuse a project, stage or flag id: progress rows, contributions, flags and achievements keep them. Adding a project: append a definition (stages, needs, `grantsFlag`, `rewardAchievementId`), a flag in `WORLD_FLAG_IDS`/`WORLD_FLAGS`, and the achievement (criterion `communityProject`).

### Numbers

Each stage needs gold and one to three materials. The **cap** is the share of each need one player (account, all heroes together) may give per window (the UTC game day). On a stage's first day it is `COMMUNITY_PROJECT_CONFIG.capShare` = **20 %** (rounded up, at least 1; a stage may override it with `capShare`), so **five players are needed to finish a stage on the day it opens**. Since ticket B.3 the share **grows by `capGrowthPerDay` = 20 points for every day the stage has stood since its first gift**, up to `capShareMax` = **60 %** (20 → 40 → 60 %; game-core `stageCapShare`, `stageAgeDays`; the server reads the stage's first gift day under the project lock, no new column). A big town finishes each stage on its first day under the 20 % rule; a small one is no longer held five days per stage.

| Stage | Needs (B.3: before → after) | Cap per player, day 1 · day 2 · day 3+ |
| --- | --- | --- |
| Warehouse 1 · Clear the rubble | 4,000 gold · timber 400 → **250** | 800 · 1,600 · 2,400 gold; 50 · 100 · 150 timber |
| Warehouse 2 · Raise the roof | 8,000 gold · timber 300 → **200** · raw hide 300 → **200** | 1,600 · 3,200 · 4,800; 40 · 80 · 120 each |
| Warehouse 3 · Hang the iron doors | 12,000 gold · iron ore 250 → **200** | 2,400 · 4,800 · 7,200; 40 · 80 · 120 |
| Ashen Pass 1 · Scout the pass | 15,000 gold · 300 soul shards · 200 ashwort | 3,000 · 6,000 · 9,000; 60 · 120 · 180; 40 · 80 · 120 |
| Ashen Pass 2 · Raise the wardstones | 30,000 gold · 500 iron ore · 40 Abbey silver | 6,000 · 12,000 · 18,000; 100 · 200 · 300; 8 · 16 · 24 |
| Ashen Pass 3 · Break the warden's ward | 45,000 gold · 60 Abbey silver · 10 Gravewarden's seals | 9,000 · 18,000 · 27,000; 12 · 24 · 36; 2 · 4 · 6 |

**Why these sizes (small live player base).** A realistic hero earns ~300 gold an hour in the Fields and ~1,650 in the Abbey (~2,000 in the Ashen Pass) and gathers 30–36 units of each of its area's materials an hour (`ECONOMY.md`); an idle player farms most of the day. The Warehouse is gathered in the early areas, so newer players can help; the Ashen Pass is a late-game sink (90,000 gold) that needs Abbey materials and crypt seals. All of it is data in `projects.ts`.

### How long a stage takes (ticket B.3)
`balance/community-balance.test.ts` plays a town day by day with the real caps: every player gives what the current stage still needs, up to its cap that day and what it can spare, and a stage finished mid-day opens the next at once (as on the server). Two views: **cap-bound** (players with endless means: the fastest a town of that size can go) and **with gathering** (what a player spares a day: about a third of its area's gathering and a quarter of a newcomer's or a third of a veteran's gold, see the test; a third of the town are veterans, at least one). Days until the Warehouse opens + days from there until the Ashen Pass opens (the test pins this table):

| Active players | Cap-bound, before → after | With gathering, before → after | Days per stage after (cap-bound) |
| --- | --- | --- | --- |
| 1 | 13 + 12 → **7 + 6** | 16 + 13 → **10 + 11** | 3 (was 5) |
| 3 | 5 + 4 → **4 + 3** | 5 + 10 → **4 + 6** | 2 (was 2–3) |
| 10 | 2 + 1 → 2 + 1 | 2 + 3 → 2 + 2 | 1–2 |
| 30 | 1 + 0 → 1 + 0 | 1 + 1 → 1 + 1 | 1 |

**Reading.** The flat 20 % cap was the whole delay for a solo player (five days a stage, 25 days for both projects) and half of it for three; past ten players the caps never bind. With gathering, materials and gold bind instead: one player alone still needs about three weeks for both projects (the Pass's 45,000 gold and the seals at one per crypt hoard), three players about ten days. The telemetry run (28 accounts, all giving a daily share) finished both projects on its first two days.

**No monopoly** (asserted): on a stage's first day nobody gives more than a fifth of a need, so a stage finished that day had at least five givers; four players with endless means can't finish any stage on its first day; nobody ever gives more than 60 % of a need in a day. The growth only matters where a stage stands unfinished, which is a small town by definition.

**The trade-off, and what was not done.** *Scaling needs* to the number of active players (from presence) would keep a stage the same number of days for any town, but the target moves while people give, a few active players make it small enough to finish alone, and the total sink changes with the population. *Decaying needs* would do the same as the growing cap with less gold sunk. The growing cap keeps every need and the total sink fixed and changes only how fast a small town may pay it. The Warehouse's material needs were trimmed (it is the first project and the live town is tiny; materials are plentiful in the economy, e.g. 240k iron ore surplus in the telemetry week), the Ashen Pass's left alone. **Lowering a need is safe on live:** a stage that already holds its new needs is finished at the next contribution attempt, in its own transaction (`catchUpProject`; that attempt answers `stage_changed` and the board shows the next stage); anything given above the new need stays given.

## Contributing

`POST /api/community/projects/:projectId/contribute`, body `{ characterId, stageId, offer: [{ resource, amount }] }` (`resource` `gold` or a material id), `Idempotency-Key` required. In one transaction:

1. **Hero lock** (`lockOwnedCharacter`): the hero's farming settles first, so gold and materials earned offline count (settle before spending, like every value path).
2. **Project lock** (`community_projects` row `for update`, created on first use): every contribution, stage change and completion of the project serialises here.
3. The project must be open (its prerequisite complete: `409 project_locked`), not finished (`409 project_complete`), and the stage must be the one the client saw (`409 stage_changed` with `details.currentStageId`: nothing is spent when the stage moved on meanwhile). Each offered resource must be needed (`422 not_needed`) and **held in full** (`422 insufficient_gold` / `insufficient_materials`).
4. game-core `planContribution` takes, per resource, the least of the offer, what the stage still needs (**no over-fill**) and what the account may still give in this window (**the cap**, grown by the stage's age since B.3). The rest is not taken and stays with the hero (`limited: { gold: 'stage' | 'cap' }` says why). Nothing taken at all: `409 contribution_capped` with `details.resetsAt`.
5. Gold and materials leave the hero; the stage totals and the account's window row grow; `community.contribute` is audited (project, stage, day, gold, materials, gold after) and telemetry recorded (`community.contribute`, `gold.out community_project`, `material.out community_project`).
6. If every need of the stage is met, the project moves on (`community.stage_complete`, telemetry `community.stage`). After the last stage: `completed_at` is set, the world flag is written, every account that ever gave to the project is awarded its achievement (at most once: the achievements primary key), and `community.project_complete` is audited (flag, contributor count).

After the commit the route invalidates the world-state cache, so the next read sees the flag at once.

**Exact under concurrency.** Totals, caps and completion are decided under the project lock, so contributions racing at a stage boundary never over-fill it, a contribution that loses the race spends nothing (`stage_changed`) or only what still fitted, and exactly one transaction completes each stage and the project. Several heroes of one account racing share the cap exactly.

**No monopoly.** Caps per account per window, growing with a stage's age (above); rewards for contributors are cosmetic only (achievements, 4.2), never power. Every contributor gets the same mark, however much they gave. Mutes do not block contributions (no player text, nobody is reached).

### The window

The contribution window is the **game-clock UTC day** (`contributionWindow(now)`, the window rule): each `community_contributions` row stores its `day`, written in the transaction that took the gift, so a gift at 23:59 counts on that day and one at 00:01 on the next, with a fresh cap (tested). The board shows `window.resetsAt`. Caps are per stage: a player who gave their share to stage 1 may give to stage 2 the same day once it opens.

## World state

- **One source of truth:** the `world_flags` table. A flag is written only in the transaction that completes its project (or by the owner's CLI, below), never removed.
- **Read** through `app.worldState` (`WorldStateCache`): `get()` → `{ flags, completed }`, `flags()` → game-core `WorldFlags`. Cached per server process, **invalidated** after a completing commit, with a **60 s TTL** as the backstop for changes by another process (the CLI). A load that started before an invalidation is returned but not stored (generation check), so a read racing a completion cannot cache the old flags. A restart starts empty and reads the table: nothing is lost or stale across restarts.
- Inside a value transaction that must be exact, read the table (`loadWorldState(tx)`, `completedProjectIds(tx)`), not the cache.
- **Content reads it** through game-core: `UnlockRule.worldFlag` with `UnlockCharacter.world` (the flags). A rule with a flag stays closed when the caller passes no flags (the safe default); `unlockBlockers` then reports `{ kind: 'worldFlag', flag }`, and the map and crypt show the flag's `lockedText`. Ticket 4.8: `ashenPass` and the Warden's Watch (`ashenWatch`) carry `worldFlag: 'ashenPassCleared'`, and every server unlock check (world map, farming start, merchant, dungeon state and start) passes `await app.worldState.flags()`; the map shows them *sealed* with the flag's `lockedText` and a link to the town works (`docs/WORLD.md` "The Ashen Pass"). 4.7 checks `warehouseRestored` on its routes (`WAREHOUSE_UNLOCK`, `docs/WAREHOUSE.md`).

## UI

- **Town works** (`#/works`): the Warehouse niche from the hub picture as the header; each project as a ledger panel with its stage track, overall progress, and for the stage under way each need with the town's progress, *your share today / cap*, what the active hero holds and an amount field (pre-filled with the most that would be taken). Locked projects say what they wait for; finished ones the day and the number of players. Facts: what it opens, the contributor achievement (marked when yours), what you gave in all. Loading, error (retry), stale (last board kept) and success states; failures in plain words, nothing taken.
- **Hub:** a works slip under the town picture (the project under way, its progress and stage, "Lend a hand"); the Warehouse's line says it is restored once it is.
- **World notice** (2.7's herald slips, kind `world`): when a project completes, every player gets "Restore the Graumark Warehouse: done", once per device and account, if they come by within a week.
- **Admin panel** (D.3 status): each project's stage and current totals, and the contributor counts.

**Polling** (3.9's limits: 900 requests and 300 actions a minute per account): the board polls `GET /api/community/projects` every 60 s while the works screen or the hub is open, every game screen polls `GET /api/world` every 120 s; both send an `ETag` (`304` when unchanged). That is ≤ 2 requests a minute per tab. A contribution is one action and no social write.

## Owner CLI (playtesting)

`pnpm admin:project status` prints every project's state; `pnpm admin:project complete <projectId>` finishes an **open** project's remaining stages through the same path as the last contribution (world flag, contributor achievements, telemetry), with the audit rows marked `by: admin` plus `community.admin_complete`. It refuses an unknown, locked or finished project. There is no API path, and no undo (a flag is never removed). On the VPS: `deploy/admin.sh project status|complete <projectId>`. Running servers see the flag within a minute (cache TTL).

## Races

`community.pg.test.ts` (real PostgreSQL, part of `test:pg`, three rounds each in varied orders, no retries): eight players racing their full caps into a stage with less left than they offer (exact totals, one completion, each hero paid exactly what it was told was accepted and what the audit says, the accepted amounts sum to the gap, the rest `stage_changed`); one account racing from four heroes (gives exactly its cap); eight players racing the last stage (one completion, one flag, the achievement for exactly the contributors, `reconcileWithAudit` all matching). Without the project lock all three fail.

## Screenshots

`docs/screenshots/phase-4/`: `works-*`, `works-complete-*` (with the world notice), `hub-works-*` (desktop and mobile) and `hub-warehouse-restored-desktop`, from `node tools/screenshots/community.mjs` against a dev server on a scratch database (the script's header).
