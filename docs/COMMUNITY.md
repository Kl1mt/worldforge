# Community projects & world state

Ticket 4.6, GDD §12.1–§12.2. The town builds things together: global projects with stages that need gold and materials. Any player gives from one of their heroes' holdings; when the last stage is done, the project sets a **world flag** for everyone, and content opens on it.

Code: game-core `world/projects.ts` (definitions, caps, the contribution plan, world flags) and `world/unlocks.ts` (`UnlockRule.worldFlag`); server `apps/server/src/community/` (`model.ts` locks and completion, `routes.ts`, `world-state.ts` the cache, `project-cli.ts`); web `screens/WorksScreen.tsx` (`#/works`, "Town works"), the hub's works slip (`HubScreen.tsx`) and the world notice (`onboarding/notices.ts` `worldNotices`). Endpoints in `API_CONVENTIONS.md`, tables in `DATA_MODEL.md`, telemetry in `TELEMETRY.md`.

## The projects (data)

| Project | Opens after | Sets flag | Used by | Contributor reward |
| --- | --- | --- | --- | --- |
| `restoreWarehouse` — Restore the Graumark Warehouse | — | `warehouseRestored` | 4.7 opens the Warehouse building (the hub shows it locked until then; once restored the hub says so) | achievement `warehouseRestorer` "Mender of Graumark" |
| `clearAshenPass` — Clear the Ashen Pass | `restoreWarehouse` | `ashenPassCleared` | 4.8 opens the area `ashenPass` (`UnlockRule.worldFlag: 'ashenPassCleared'`) | achievement `ashenPassBreaker` "Through the Ash" |

Never rename or reuse a project, stage or flag id: progress rows, contributions, flags and achievements keep them. Adding a project: append a definition (stages, needs, `grantsFlag`, `rewardAchievementId`), a flag in `WORLD_FLAG_IDS`/`WORLD_FLAGS`, and the achievement (criterion `communityProject`).

### Numbers

Each stage needs gold and one to three materials. The **cap** is the share of each need one player (account, all heroes together) may give per window: `COMMUNITY_PROJECT_CONFIG.capShare` = **20 %** (rounded up, at least 1; a stage may override it with `capShare`). So every stage takes at least **five player-days**, whoever plays, and a project of three stages at least fifteen.

| Stage | Needs | Cap per player and day |
| --- | --- | --- |
| Warehouse 1 · Clear the rubble | 4,000 gold · 400 timber | 800 gold · 80 timber |
| Warehouse 2 · Raise the roof | 8,000 gold · 300 timber · 300 raw hide | 1,600 · 60 · 60 |
| Warehouse 3 · Hang the iron doors | 12,000 gold · 250 iron ore | 2,400 · 50 |
| Ashen Pass 1 · Scout the pass | 15,000 gold · 300 soul shards · 200 ashwort | 3,000 · 60 · 40 |
| Ashen Pass 2 · Raise the wardstones | 30,000 gold · 500 iron ore · 40 Abbey silver | 6,000 · 100 · 8 |
| Ashen Pass 3 · Break the warden's ward | 45,000 gold · 60 Abbey silver · 10 Gravewarden's seals | 9,000 · 12 · 2 |

**Why these sizes (small live player base).** A realistic hero earns ~300 gold an hour in the Fields and ~1,650 in the Abbey and gathers 40–60 units of its area's materials an hour (`ECONOMY.md`); an idle player farms most of the day. The Warehouse's daily share (at most 2,400 gold and 80 materials per stage) is a few hours of income for a mid-level hero and is gathered in the early areas, so newer players can help. With **four players** giving their full share each day the Warehouse is done in **about 4 days** (15 player-days); with two, in about 8; one player alone can never finish a stage in a day and needs at least 15 days. The Ashen Pass is a late-game gold sink (90,000 gold in all, where B.2 found gold piling up past +10) and needs Abbey materials and crypt seals; four Abbey-level players finish it in about the same 4 days. All of it is data in `projects.ts` for B.3 to tune with playtest numbers.

## Contributing

`POST /api/community/projects/:projectId/contribute`, body `{ characterId, stageId, offer: [{ resource, amount }] }` (`resource` `gold` or a material id), `Idempotency-Key` required. In one transaction:

1. **Hero lock** (`lockOwnedCharacter`): the hero's farming settles first, so gold and materials earned offline count (settle before spending, like every value path).
2. **Project lock** (`community_projects` row `for update`, created on first use): every contribution, stage change and completion of the project serialises here.
3. The project must be open (its prerequisite complete: `409 project_locked`), not finished (`409 project_complete`), and the stage must be the one the client saw (`409 stage_changed` with `details.currentStageId`: nothing is spent when the stage moved on meanwhile). Each offered resource must be needed (`422 not_needed`) and **held in full** (`422 insufficient_gold` / `insufficient_materials`).
4. game-core `planContribution` takes, per resource, the least of the offer, what the stage still needs (**no over-fill**) and what the account may still give in this window (**the cap**). The rest is not taken and stays with the hero (`limited: { gold: 'stage' | 'cap' }` says why). Nothing taken at all: `409 contribution_capped` with `details.resetsAt`.
5. Gold and materials leave the hero; the stage totals and the account's window row grow; `community.contribute` is audited (project, stage, day, gold, materials, gold after) and telemetry recorded (`community.contribute`, `gold.out community_project`, `material.out community_project`).
6. If every need of the stage is met, the project moves on (`community.stage_complete`, telemetry `community.stage`). After the last stage: `completed_at` is set, the world flag is written, every account that ever gave to the project is awarded its achievement (at most once: the achievements primary key), and `community.project_complete` is audited (flag, contributor count).

After the commit the route invalidates the world-state cache, so the next read sees the flag at once.

**Exact under concurrency.** Totals, caps and completion are decided under the project lock, so contributions racing at a stage boundary never over-fill it, a contribution that loses the race spends nothing (`stage_changed`) or only what still fitted, and exactly one transaction completes each stage and the project. Several heroes of one account racing share the cap exactly.

**No monopoly.** Caps per account per window (above); rewards for contributors are cosmetic only (achievements, 4.2), never power. Every contributor gets the same mark, however much they gave. Mutes do not block contributions (no player text, nobody is reached).

### The window

The contribution window is the **game-clock UTC day** (`contributionWindow(now)`, the window rule): each `community_contributions` row stores its `day`, written in the transaction that took the gift, so a gift at 23:59 counts on that day and one at 00:01 on the next, with a fresh cap (tested). The board shows `window.resetsAt`. Caps are per stage: a player who gave their share to stage 1 may give to stage 2 the same day once it opens.

## World state

- **One source of truth:** the `world_flags` table. A flag is written only in the transaction that completes its project (or by the owner's CLI, below), never removed.
- **Read** through `app.worldState` (`WorldStateCache`): `get()` → `{ flags, completed }`, `flags()` → game-core `WorldFlags`. Cached per server process, **invalidated** after a completing commit, with a **60 s TTL** as the backstop for changes by another process (the CLI). A load that started before an invalidation is returned but not stored (generation check), so a read racing a completion cannot cache the old flags. A restart starts empty and reads the table: nothing is lost or stale across restarts.
- Inside a value transaction that must be exact, read the table (`loadWorldState(tx)`, `completedProjectIds(tx)`), not the cache.
- **Content reads it** through game-core: `UnlockRule.worldFlag` with `UnlockCharacter.world` (the flags). A rule with a flag stays closed when the caller passes no flags (the safe default); `unlockBlockers` then reports `{ kind: 'worldFlag', flag }`, and the map and crypt show the flag's `lockedText`. No place uses a flag yet: 4.8 sets `worldFlag: 'ashenPassCleared'` on `ashenPass` and passes `await app.worldState.flags()` where it checks unlocks; 4.7 checks `warehouseRestored` on its routes.

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
