# Community projects & world state

Ticket 4.6, GDD §12.1–§12.2. The town builds things together: global projects with stages that need gold and materials. Any player gives from one of their heroes' holdings; when the last stage is done, the project sets a **world flag** for everyone, and content opens on it.

Code: game-core `world/projects.ts` (definitions, caps, the contribution plan, world flags) and `world/unlocks.ts` (`UnlockRule.worldFlag`); server `apps/server/src/community/` (`model.ts` locks and completion, `routes.ts`, `world-state.ts` the cache, `project-cli.ts`); web `screens/WorksScreen.tsx` (`#/works`, "Town works"), the hub's works slip (`HubScreen.tsx`) and the world notice (`onboarding/notices.ts` `worldNotices`). Endpoints in `API_CONVENTIONS.md`, tables in `DATA_MODEL.md`, telemetry in `TELEMETRY.md`.

## The projects (data)

| Project | Opens after | Sets flag | Used by | Contributor reward |
| --- | --- | --- | --- | --- |
| `restoreWarehouse` — Restore the Graumark Warehouse | — | `warehouseRestored` | 4.7 opens the Warehouse building (`docs/WAREHOUSE.md`: every warehouse route answers `409 warehouse_closed` and the hub shows it locked until then) | achievement `warehouseRestorer` "Mender of Graumark" |
| `clearAshenPass` — Clear the Ashen Pass | `restoreWarehouse` | `ashenPassCleared` | 4.8 opens the area `ashenPass` and its boss run `ashenWatch` (`UnlockRule.worldFlag: 'ashenPassCleared'`) | achievement `ashenPassBreaker` "Through the Ash" |
| `forgewardOutpost` — Rebuild the Forgeward Outpost (ticket 6.7) | `clearAshenPass` | `forgewardRaised` | the town upgrade *Forgeward bellows* (`docs/ECONOMY.md` "Town upgrades") and the era *the Forgeward Age* (`docs/WORLD.md` "Eras of Graumark"); free for later content. **Gates nothing players reach today** | achievement `forgewardBuilder` "Keeper of the Forgeward" (icon awaiting art: the wax-seal placeholder) |

Every completed project also moves the town's **era** (ticket 6.7, below and `docs/WORLD.md`).

Never rename or reuse a project, stage or flag id: progress rows, contributions, flags and achievements keep them. Adding a project: append a definition (stages, needs, `grantsFlag`, `rewardAchievementId`), a flag in `WORLD_FLAG_IDS`/`WORLD_FLAGS`, and the achievement (criterion `communityProject`).

### Numbers

Each stage needs gold and one to three materials. The **cap** is the share of each need one player (account, all heroes together) may give per window (the UTC game day). On a stage's first day it is `COMMUNITY_PROJECT_CONFIG.capShare` = **20 %** (rounded up, at least 1; a stage may override it with `capShare`: the Forgeward Outpost's stages use **10 %** since ticket B.5b), so **five players are needed to finish a stage on the day it opens** (ten for the Outpost). Since ticket B.3 the share **grows by `capGrowthPerDay` = 20 points for every day the stage has stood since its first gift**, up to `capShareMax` = **60 %** (20 → 40 → 60 %; game-core `stageCapShare`, `stageAgeDays`; the server reads the stage's first gift day under the project lock, no new column). A big town finishes each stage on its first day under the 20 % rule; a small one is no longer held five days per stage.

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

## The Forgeward Outpost (ticket 6.7)

The Cinderwastes chain: one project of three stages after the Ashen Pass, in B.3's model unchanged (gold and materials from a hero's holdings, the 20 → 40 → 60 % cap per account per need and day, no over-fill, the window rule). It is a late-game sink (300,000 gold, more than three times the Pass) and the first to take **Tyrant's Embers**, sparingly: ten, all in the last stage, two per account on its first day.

| Stage | Needs | Cap per account, day 1 · day 2 · day 3+ |
| --- | --- | --- |
| Forgeward 1 · Clear the slag road (`slagRoad`) | 60,000 gold · 1,000 iron ore · 400 soul shards | 12,000 · 24,000 · 36,000; 200 · 400 · 600; 80 · 160 · 240 |
| Forgeward 2 · Raise the forgeward walls (`forgewardWalls`) | 100,000 gold · 1,500 iron ore · 80 Abbey silver | 20,000 · 40,000 · 60,000; 300 · 600 · 900; 16 · 32 · 48 |
| Forgeward 3 · Kindle the beacon (`kindleBeacon`) | 140,000 gold · 800 soul shards · 10 Tyrant's Embers | 28,000 · 56,000 · 84,000; 160 · 320 · 480; 2 · 4 · 6 |

**What it opens.** The flag `forgewardRaised` opens the **Forgeward bellows** (Tyrantforged Work 20 % cheaper in gold; `docs/ECONOMY.md`) and begins the **Forgeward Age** (`docs/WORLD.md`). It is a world flag like the others, free for later content to read.

**No access is taken away.** The Ashfall Verge, the Cinder Depths and the Tyrant's Forge are live and open under their level and boss rules; the chain does **not** gate them (their `worldFlag` seams from 6.1/6.2 stay documented and unused). `world-progression.test.ts` (game-core) asserts that no area or dungeon tier waits for the new flag and that every unlock answers the same with or without it at every level and progress; the server test compares the world map and the dungeon list for heroes of 27–40 before and after the flag. *Gating considered:* putting the Depths or the Forge behind the chain would add a reason to give, but it would close content heroes reach today on live and hold endgame players hostage to a small town's ember supply; nothing about the chain is clearly better gated, so it is not proposed.

**Test accounts never give** (D.4): a contribution from an account with `is_test` set is `403 test_account`, read in the contribution's transaction, for every project; nothing is taken or counted. Their play stays out of the shared world.

### At scale: 20, 100 and 500 players (ticket 6.7)

`balance/forgeward-balance.test.ts` plays the chain from the day it opens with B.3's model (now `balance/community-town.ts`, shared; B.3's own suite is pinned to its two projects and its table above is unchanged). The **realistic player** for a larger town (`largeTown`): a sixth **endgame** players (the Cinderwastes: 15,000 gold, 170 ore and 170 shards spared a day, half a Tyrant's Ember a day since not every Forge run is won and Item Awakening wants three), a third veterans, the rest newcomers (B.3's two profiles). Embers and seals are kept from day to day until given. *Cap-bound*: endless means, only the caps limit. Days (1-based) until done; per stage: days it stood · distinct givers · the largest share of the stage one account gave.

**Before** (the town before 6.7: the Warehouse and the Ashen Pass, B.3's town; days to the Warehouse + days from there to the Pass):

| Active players | Cap-bound | With gathering | Givers per stage (gathering) | Largest share of one account |
| --- | --- | --- | --- | --- |
| 20 | 1 + 2 | 1 + 2 | 5–8 | 20 % (38 % in the two-day wardstones) |
| 100 | 1 + 1 | 1 + 1 | 5–10 | 20 % |
| 500 | 1 + 1 | 1 + 1 | 5–10 | 20 % |

**After** (the Forgeward Outpost as 6.7 shipped it, 20 % on every stage's first day; the stages' days in brackets):

| Active players | Cap-bound | With gathering | Givers per stage (gathering) | Largest share of one account (gathering) |
| --- | --- | --- | --- | --- |
| 1 | 7 (3/3/3) | 30 (6/16/10) | 1 | 100 % |
| 3 | 4 (2/2/2) | 20 (3/4/15) | 3 | 40–69 % |
| 10 | 2 (1/1/2) | 10 (1/3/8) | 7–10 | 19–30 % |
| **20** | 1 (1/1/1) | **8** (1/2/7) | 6 / 16 / 20 | 16–20 % |
| **100** | 1 (1/1/1) | **2** (1/1/2) | 6 / 14 / 24 | 5–19 % |
| **500** | 1 (1/1/1) | **2** (1/1/2) | 6 / 16 / 20 | 10–19 % |

**Since B.5b** (owner decision 2026-11-11: `capShare: 0.1` on all three stages, ten givers on a first day; pinned in `forgeward-balance.test.ts`, its 20/100/500 gathering rows from the 6.7 shape too):

| Active players | Cap-bound | With gathering | Givers per stage (gathering) | Largest share of one account (gathering) |
| --- | --- | --- | --- | --- |
| 1 | 10 (4/4/4) | 31 (7/16/10) | 1 | 100 % |
| 3 | 4 (2/2/2) | 20 (3/4/15) | 3 | 45–68 % |
| 10 | 3 (1/2/2) | 10 (2/2/8) | 10 | 19–29 % |
| **20** | 2 (1/1/2) | **8** (1/2/7) | **10** / 16 / 20 | 10–18 % |
| **100** | 1 (1/1/1) | **2** (1/1/2) | **10** / 13 / 24 | 5–10 % |
| **500** | 1 (1/1/1) | **2** (1/1/2) | **10** / 16 / 20 | 7–10 % |

The realistic town's pace is unchanged at every size from 3 players up (one day more for a player alone); the first stage, which a big town finishes on its first day, now has ten givers instead of six and nobody gives more than a tenth of it. In the cap-bound view a town of 20 now takes a second day for the beacon (it opens late on day one, after the walls, with few accounts left to give).

**Reading.** At 20 players the chain is about a week, held by the beacon's embers (three endgame players, half an ember a day each); at 100 and 500 the gold and ore go on the first day and the embers on the second (nobody is modelled holding a stockpile on day one; a live town of Tyrant hunters could finish on day one). A small town still gets there in three to four weeks. The needs do not scale with the town (B.3's trade-off, kept: a fixed sink, a target that doesn't move while people give).

**No monopoly at scale** (asserted for every size and both towns): nobody gives more than a stage's first-day share of a need on its first day (a fifth; **a tenth for the Forgeward stages since B.5b**); a stage finished on its first day had at least five givers (**ten** for the Forgeward), and nobody carried more than that share of it; nobody ever gives more than 60 % of a need in a day; **nine** accounts with endless means (embers included) can't finish a Forgeward stage on its first day. In the cap-bound view a big town finishes each Forgeward stage with exactly ten accounts at a tenth each: **the cap guarantees ten givers, not more**. With the realistic player the largest share of any account from 20 players up is under a fifth (18 % at 20, in the two-day walls, where the second day's cap is 30 %). Embers are the only need a few high-level players hold, and they can't carry a stage with them alone: the gold and shards of the same stage need the rest of the town, and one ember per account on the first day needs ten ember holders to finish that day.

## The lanterns of the deep (ticket 8.2)

The Hollow Reach chain: one project of three stages after the Forgeward Outpost (`requires: 'forgewardOutpost'`), in B.3's model unchanged. **The first project that gates content from its release:** its flag `deepLanternsLit` opens the Hollow Deep and the Hollow Throne (`docs/WORLD.md`). That is allowed because nothing live is taken away: they are new, and every other place opens exactly as before (asserted in game-core `world/hollow-reach-gate.test.ts` and the server's `community/deep-lanterns.test.ts`, which compares every other area and dungeon for heroes of 28–52 before and after the flag). Every stage uses **B.5b's tenth** (`capShare: 0.1`): ten givers to finish a stage on its first day, growing by the default rule (10 → 30 → 50 → 60 %). Materials come from what Hollow Reach heroes already hold (the Marches' ore and shards, Abbey silver from stock) and, once more, **ten Tyrant's Embers** in the last stage (a second one-off use of his hoard; nothing from behind the gate, so no crown shard).

| Stage | Needs | Cap per account, day 1 · day 2 · day 3 · day 4+ |
| --- | --- | --- |
| Lanterns 1 · Sink the lantern posts (`lanternPosts`) | 90,000 gold · 1,200 iron ore · 500 soul shards | 9,000 · 27,000 · 45,000 · 54,000; 120 · 360 · 600 · 720; 50 · 150 · 250 · 300 |
| Lanterns 2 · Hang the chains (`lanternChains`) | 130,000 gold · 1,800 iron ore · 90 Abbey silver | 13,000 · 39,000 · 65,000 · 78,000; 180 · 540 · 900 · 1,080; 9 · 27 · 45 · 54 |
| Lanterns 3 · Kindle the lanterns (`kindleLanterns`) | 180,000 gold · 900 soul shards · 10 Tyrant's Embers | 18,000 · 54,000 · 90,000 · 108,000; 90 · 270 · 450 · 540; 1 · 3 · 5 · 6 |

**What else it opens.** The **lantern smithy** (Crownforged Work 20 % cheaper in gold, 4,500 → 3,600; `docs/ECONOMY.md` "Town upgrades"; a price, never power) and the **Lantern Vigil**, the fifth era (`docs/WORLD.md`). Contributors earn the deed **Lantern-bearer of the Deep** (`deepLanternBearer`; its icon shows the wax-seal placeholder until it is drawn).

**Test accounts never give** (D.4): `403 test_account`, nothing taken or counted (asserted for this project).

### Pacing at 20, 100 and 500 players (ticket 8.2)

`balance/deep-lanterns-balance.test.ts` plays the chain from the day it opens with B.3's model (`balance/community-town.ts`). The realistic town when the lanterns open (`reachTown`): a tenth **Hollow Reach** heroes (`REACH`: ~22,000 gold, 180 ore and 110 shards spared a day, 4 silver from stock, half an ember a day), a tenth Cinderwastes heroes (6.7's `ENDGAME`), a third veterans, the rest newcomers; embers kept from day to day. Days (1-based) until done; per stage: days it stood · distinct givers · the largest share of the stage one account gave.

| Active players | Cap-bound | With gathering | Givers per stage (gathering) | Largest share of one account (gathering) |
| --- | --- | --- | --- | --- |
| 1 | 10 (4/4/4) | 37 (7/23/9) | 1 | 100 % |
| 3 | 4 (2/2/2) | 20 (3/5/14) | 3 | 48–69 % |
| 5 | 4 (2/2/2) | 10 (2/3/7) | 5 | 30–38 % |
| 10 | 3 (1/2/2) | 10 (2/2/8) | 10 | 20–34 % |
| **20** | 2 (1/1/2) | **6** (1/2/5) | **10** / 18 / 20 | 10–17 % |
| **100** | 1 (1/1/1) | **2** (1/1/2) | **10** / 15 / 28 | 4–10 % |
| **500** | 1 (1/1/1) | **2** (1/1/2) | **10** / 23 / 20 | 7–10 % |

**Reading.** A town of 20 lights the lanterns in about **six days** (held by the chains' ore and the last stage's embers); 100 and 500 players in **two**. **A small town still finishes it:** five to ten active players in about **ten days**, three in about **three weeks**, a player alone in a little over five weeks (the cap-bound row: ten days if the means are there). The needs do not scale with the town (B.3's trade-off). **No monopoly** (asserted for every size): nobody gives more than a tenth of a need on a stage's first day, a stage finished on its first day had at least ten givers and nobody carried more than a tenth of it, nobody ever gives more than 60 % of a need a day, nine accounts with endless means can't finish a stage on its first day, and from 20 players up the largest share of any account is under a fifth.

**The window rule at a stage completion** (server test): a gift at 23:59:59 counts on that day, the next stage's cap grows from its own first day (its first gift, the same second), and a gift to the finished stage is refused (`stage_changed`) and takes nothing.

### Eras (ticket 6.7)

Every completed project moves the town's era (`docs/WORLD.md` "Eras of Graumark"): the Warehouse begins the Ashen Siege, the Ashen Pass the Rekindling, the Forgeward Outpost the Forgeward Age, and (ticket 8.2) the lanterns of the deep the Lantern Vigil. The era is derived from the world flags, never stored, so live starts where its finished projects put it (the Rekindling) and nothing jumps backward. The transaction that writes the flag (under the project lock and a world lock, `lockWorldFlags`) compares the era before and after and writes `world.era_change` (from, to, the project) with telemetry `world.era`.

**B.5: a lower first-day cap for big towns?** (6.7's open point, `docs/BALANCE.md` "B.5", item 5.) Played with a 10 % cap on every stage (ten givers to finish one on its first day) instead of 20 %: the same days at 20, 100 and 500 players (8 / 2 / 2), the first stage given by ten accounts instead of six, its largest share 19 % → 10 %. **Owner decision (B.5b, 2026-11-11): shipped** as `capShare: 0.1` on the Outpost's three stages; the measurement re-run with the shipped data is identical (tables above). The other projects keep 20 %.

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
- **Admin panel** (D.3 status): each project's stage and current totals, and the contributor counts. Ticket 6.7: the D.4 world folio shows the era and each project's stage too.
- **The era** (ticket 6.7): the town header's "Era of …" title, the tint and banners over the town picture, the crier's call of the day under it, and the Tavern's ambient line (`community/Era.tsx`, `docs/WORLD.md`).

**Polling** (3.9's limits: 900 requests and 300 actions a minute per account): the board polls `GET /api/community/projects` every 60 s while the works screen or the hub is open, every game screen polls `GET /api/world` every 120 s; both send an `ETag` (`304` when unchanged). That is ≤ 2 requests a minute per tab. A contribution is one action and no social write.

## Owner CLI (playtesting)

`pnpm admin:project status` prints every project's state; `pnpm admin:project complete <projectId>` finishes an **open** project's remaining stages through the same path as the last contribution (world flag, contributor achievements, era change, telemetry), with the audit rows marked `by: admin` plus `community.admin_complete`. It refuses an unknown, locked or finished project. There is no API path, and no undo (a flag is never removed). On the VPS: `deploy/admin.sh project status|complete <projectId>`. Running servers see the flag within a minute (cache TTL).

Ticket 6.7: `pnpm admin:project stage <projectId>` finishes **only the current stage** the same way (audit `community.admin_stage`; the flag, achievements and era change when it was the last) and is for **test setups only**: it refuses when `NODE_ENV=production`, so it can't move a stage on live. The admin panel's world folio shows the era and every project's stage (read-only); the era changes there only through the audited flag toggles with the every-player warning (the writ says when a toggle would move the era, and the server records the change as `world.era_change` `by: admin`).

## Races

`community.pg.test.ts` (real PostgreSQL, part of `test:pg`, three rounds each in varied orders, no retries): eight players racing their full caps into a stage with less left than they offer (exact totals, one completion, each hero paid exactly what it was told was accepted and what the audit says, the accepted amounts sum to the gap, the rest `stage_changed`); one account racing from four heroes (gives exactly its cap); eight players racing the last stage (one completion, one flag, the achievement for exactly the contributors, `reconcileWithAudit` all matching). Without the project lock all three fail.

Ticket 6.7, `world-era.pg.test.ts` (part of `test:pg`): the Forgeward Outpost completing races an admin toggling the Ashen Pass's flag off, both moving the era. In either order the `world.era_change` rows chain (each starts where the last ended, exactly one starts from the Rekindling) and end at the era of the final flags, reconciled. Without the world lock (`lockWorldFlags`) it fails: both start from the Rekindling.

## Screenshots

`docs/screenshots/phase-4/`: `works-*`, `works-complete-*` (with the world notice), `hub-works-*` (desktop and mobile) and `hub-warehouse-restored-desktop`, from `node tools/screenshots/community.mjs` against a dev server on a scratch database (the script's header).
