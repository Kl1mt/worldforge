# Rotating events (ticket 6.6)

GDD §12, §13; Phase 6 ground rules in `ROADMAP.md` (**events never grant power**). An event is a short, admin-scheduled stretch of days with a theme, one world modifier, a quest line in the Tavern and a cosmetic reward track. One runs at a time. The first is the **Harvest of Bones**.

Code: game-core `packages/game-core/src/events/` (definitions, cosmetics, calendar rules, progress rules, tests); server `apps/server/src/events/` (`model.ts` calendar, close and reward sweep; `progress.ts` the only writer of event progress; `routes.ts` player and admin routes; `event-cli.ts`); web `apps/web/src/events/` (the Tavern notice, the banner, words), the admin panel's Events tab (`screens/AdminEvents.tsx`), the event title in `HonoursPanel.tsx` and `social/Prestige.tsx` (`ShownTitle`). Screenshots: `docs/screenshots/phase-6/events-*.png` (`node tools/screenshots/events.mjs`, a dev server on a scratch database).

## For players
- A banner in the town and on the world map says when an event is on; the Tavern has its notice: the story, what changes while it lasts, the tasks and the reward track.
- **Join in the Tavern** (per hero). Only what the hero does from then on counts; the modifier's bonus comes only to heroes who joined.
- Tasks pay **tallies**; the tallies of all your heroes fill **one reward track** for your account. Each tier gives a keepsake once, for good.
- Rewards are cosmetic: they change no number in the game. Titles are shown from your profile → Season honours (one title at a time) or the collection book; banner styles and title colours are worn from the collection book (6.8, `docs/COSMETICS.md`).
- **At the end** unfinished tasks lapse. Everything earned while it ran (bonus materials, tallies, keepsakes) stays yours. If the same event comes back later, it starts fresh; a keepsake you already own is not given twice.

## The first event: Harvest of Bones (`harvestOfBones`)
*Every autumn the furrows give back what they were given…* Posted by Old Reeve Hadric. Default length 7 days.

**Modifier: "The dead rise thick"** (`killBounty`): in the Abandoned Fields and the Old Burial Grounds, every **40** of the risen dead (Risen Farmhand, Bone Scarecrow, Risen Skeleton, Grave Crawler) a joined hero puts down yield **one extra Soul Shard**. A running count per hero and event (`event_participants.bounty_kills`), so the bonus is the same however farming is split into settlements. One per 40 is at most 2.5 % of a Soul Shard per kill, under the Burial Grounds' own 3 % undead drop (`docs/ECONOMY.md` "Event materials"). Measured: a level-6 hero without gear in the Fields put down 271 risen in an hour, **6 bonus shards** (`events.test.ts`, pinned seed). Nothing else changes: XP, gold, items and drop odds are untouched, tested.

**Tasks** (each once per hero and run):

| Task | Goal | Tallies |
|---|---|---|
| Turn the Furrows | put down 60 of the risen dead in the Fields or the Burial Grounds | 10 |
| The Ossuary Tithe | 12 Soul Shards (drops, gathering or the Harvest's own bonus) | 10 |
| The Long Reaping | put down 400 foes anywhere | 15 |
| Still a Warden | defeat any dungeon master (the Gravewarden, the Ashen Warden, the Forge Tyrant) | 15 |

**Reward track** (tallies per account):

| Tier | Tallies | Keepsake | Cosmetic id | Shown today |
|---|---|---|---|---|
| 1 | 10 | Sheaf-and-Bone banner | `banner.harvest-sheaf` | yes (collection book, 6.8) |
| 2 | 25 | Bone-white title colour | `title-colour.bone-white` | yes (collection book, 6.8) |
| 3 | 50 | title "Reaper of the Harvest" | `title.reaper-of-the-harvest` | yes (Season honours) |

A level-1 hero can reach tier 2 (the first three tasks: the bonus shards count for the Tithe); tier 3 needs a dungeon master (the crypt opens at 12) or a second hero.

## Event definitions (data)
`EventDefinition` (game-core `events/definitions.ts`): id, name, tagline, giver, Tavern text, tally name, default length, a `modifier`, 3–5 `quests` (`EventObjective`: `kill` with a foe list or any, `gather` a material, `defeatBoss` with a list or any; and its tallies) and a `track` of tiers (tallies, cosmetic id). `validateEventDefinition` checks the content (known foes, bosses, materials and cosmetics, rising tiers reachable by the quests, a modest modifier) in `events.test.ts`. Modifier kinds today: `killBounty` only; a new kind is a new branch in `killBounty`'s caller and must stay "ordinary loot at ordinary odds" (bonus materials, modest, documented in ECONOMY.md). Events are not imported by any combat, loot, farming, dungeon, scoring or PvP rule (an import scan in `events.test.ts`).

## Scheduling
`world_events` (`DATA_MODEL.md`): number, definition, `[starts_at, ends_at)` in UTC (the game clock), `cancelled_at`, `closed_at`, `rewards_swept_at`. game-core `events/plan.ts` decides every plan change, the server runs it under one advisory lock (`events:plan`) and audits it (`event.schedule`, `event.extend`, `event.end`, `event.cancel`, with `via: admin|cli`):
- **One at a time.** Windows of events that are not cancelled never overlap, and at most one event waits to begin (`one_scheduled`). An event may start now (a minute's slack) or later; it lasts **1 hour to 4 weeks**.
- **Extend or bring forward** the end of the event under way or the next one (never into the past, never over the next one); **end early** = now (may leave it shorter than an hour). **Cancel** only one that has not begun; numbers are never reused. Refusals are `409 event_plan_refused` with `details.problem`.
- Nothing starts by itself: there is no automatic next event (unlike seasons).
- Admin panel: `#/admin/events` (admins only, D.3's not-found `404` for everyone else, the role re-read in the plan transaction). CLI: `pnpm admin:events …` / `deploy/admin.sh events …` (`DEPLOY.md` "Events").

## The window rule at the boundaries
As 5.3's seasons: **progress counts when the request that made it arrived inside `[starts_at, ends_at)`** (the settlement's or the dungeon claim's game clock). A settlement at or after the end changes nothing for the event (its kills are still the hero's), one 1 ms before the end counts (tested with an injected clock). Joining settles the hero first, so farming before the join never counts; a dungeon claim counts only for heroes who joined before the run started (`joinedBy`, like quests' `acceptedBy`). The scheduler settles active heroes regularly, so at most the last interval before the end goes uncounted, as for seasons.

**Closing.** Once `now ≥ ends_at + 5 min` (`EVENT_CLOSE_GRACE_MS`) the scheduler (or `admin:events close`) closes the event under its exclusive advisory lock (`event:<n>`); every progress write takes it shared and re-checks `closed_at`, so writes in flight finish first and none follow. `event.close` is audited with counts. Unfinished quests are **expired by the clock**: nothing is deleted; `event_participants` keeps every hero's progress, bonus and tallies as they were at the end.

## Progress (`events/progress.ts`)
`recordEventProgressTx` runs in the settlement (`settleActivityTx`) and the dungeon claim, right after `recordQuestEventsTx`, under the character lock. For a hero who joined the event under way: the bounty (`killBounty`) gives bonus material (granted to the hero's stacks), the settlement's quest events plus the bonus as `materialGathered` advance the event's tasks (`applyEventProgress`: adds and caps, split-invariant), finished tasks add their tallies to the hero's row and the account's `event_tracks` row, and every tier those tallies reach is granted (below). Ordinary quests never see the bonus. Audited `event.progress` (completed tasks, tallies, bonus) only when something was completed or given.

## The reward track: exactly once
`grantTiersTx` inserts one `event_track_grants` row per (event, account, tier) and the tier's `cosmetic_unlocks` row, each `on conflict do nothing`; it audits (`event.reward`) and counts only what it inserted. It runs **in the transaction that completes a task**, so a tier arrives with the tally that reached it; two heroes of one account finishing at once serialise on the account's track row and the primary key keeps each tier once (real-PG test). **The sweep:** after the close, `sweepEventRewards` checks every account's tallies against the track as it stands and grants any tier still missing (a backstop, e.g. a threshold lowered between releases), one transaction per account; `rewards_swept_at` is set only after the last batch, so a crash leaves it null and the next run finishes the same set (`event.sweep` audited once). Tested on PGlite and real Postgres: sweeps racing and crashing mid-way, then resumed.

## Cosmetics
`cosmetic_unlocks` (account, cosmetic id, source `event:<n>:tier:<t>`, granted_at), the store 6.8's collection book extends (`docs/COSMETICS.md`: more sources, equip, display). Catalogue: game-core `cosmetics/catalogue.ts` since 6.8 (was `events/cosmetics.ts`; ids kept). `GET /api/account/cosmetics` lists an account's unlocks. **Titles** show today through 5.3's prestige display: `prestige_displays.cosmetic_title` (a composite foreign key to the account's own unlock; never together with a season title) and `POST /api/account/prestige { title: null, frame, cosmeticTitle }` (`422 one_title`, `422 award_not_earned`); `prestigeFor` returns `cosmeticTitle` for boards, profiles and rosters (`ShownTitle`). Since 6.8 every keepsake is shown (`shownToday` is true for every catalogued kind) and worn from the collection book.

## Test accounts and rankings
There is no event leaderboard. The admin view's and the CLI's participation counts leave test accounts out (D.4); their telemetry goes to `telemetry_daily_test` as for every value path. Sanctions don't block joining (nothing is ranked).

## Telemetry
`event.join` (event id), `event.quest` (event, task; amount = tallies), `event.reward` (event, `tier<n>`, cosmetic id) and `material.in` source `event` (material, event id). The report has an "Events" section; `--reconcile` checks joins, tasks, tallies, bonus materials and grants against the audit log, and two holdings: the grants ledger equals the audited grants, the tracks hold exactly the audited tallies (`TELEMETRY.md`).

## API
- `GET /api/events` → `{ now, current, next }` (`EventView`: the definition's words, tasks with targets, the track with its cosmetics, the window and status).
- `GET /api/characters/:id/event` → the same plus `hero` (null until joined: tasks with progress, tallies, bounty count, bonus) and `track` (the account's tallies and granted tiers).
- `POST /api/characters/:id/event/join` → `201` the first time, `200` after (repeat-safe); `422 no_event` outside an event.
- `GET /api/account/cosmetics` → `{ unlocks }`.
- Admin: `GET /api/admin/events`, `POST /api/admin/events { definitionId, startsAt, endsAt }`, `POST /api/admin/events/:n/end { endsAt? }`, `POST /api/admin/events/:n/cancel`.

## Tests
- `packages/game-core/src/events/events.test.ts`: content validity, the window and statuses, plan rules (one at a time, overlaps, lengths, end early, extend, cancel), progress caps and completion once, split invariance of progress and the bounty over 200 random splits, the bounty's limits.
- `apps/server/src/events/events.test.ts`: the boundary with an injected clock (join only while it runs; 1 ms before the end counts, the end does not; closed once, nothing after), one at a time and the admin permission matrix (404 for anonymous, players, moderators before the body; audit), the CLI, two heroes filling one track (each tier and cosmetic once), the title through the picker, an event ending mid-quest (expired, nothing lost, a fresh next run), the sweep across a crash, **invariance** (the same hour farmed without an event, outside an event and joined: identical XP, gold and items; materials differ only by the bounty), the import scan, test accounts out of the counts, reconciliation.
- `apps/server/src/events/events.pg.test.ts` (real Postgres): heroes of the same accounts completing tasks at once (each tier once), progress racing the close (before it or not at all), sweeps racing and crashing then resumed.
- Journey: `playEventStep` (`e2e/journey.ts`; `event-journey.test.ts`).

## Open points (owner)
- **B.5** (`docs/BALANCE.md` "B.5", item 7): a hero who can beat a dungeon master finishes the Harvest's whole track in about an hour of play, a newcomer reaches tier 2 in about two hours. Cosmetic only, so nothing to tune for balance; a longer chase (more tasks or tiers) would be a content decision.
- Should the modifier apply to every hero, not only those who joined? Joining keeps the boundary exact (no kills from before the start) and gives the participation count; applying it to all would need a per-hero counter for every farmer.
- Tallies are per account (alts help fill one track). Per hero instead?
- No automatic next event: each is scheduled by hand. A rotation (like seasons) could come later.
