# Rotating events (tickets 6.6, 8.3)

GDD §12, §13; Phase 6 and 8 ground rules in `ROADMAP.md` (**events never grant power**). An event is a stretch of days with a theme, one world modifier, a quest line in the Tavern and a cosmetic reward track. One runs at a time. The first is the **Harvest of Bones** (a week); ticket 8.3 adds the longer chase, **the Lantern Procession** (four weeks, a quest line that opens a week at a time), and the **automatic calendar** that puts events on by itself in a rotation the owner sets.

Code: game-core `packages/game-core/src/events/` (definitions, cosmetics, calendar rules, progress rules, tests); server `apps/server/src/events/` (`model.ts` calendar, close and reward sweep; `progress.ts` the only writer of event progress; `routes.ts` player and admin routes; `event-cli.ts`); web `apps/web/src/events/` (the Tavern notice, the banner, words), the admin panel's Events tab (`screens/AdminEvents.tsx`), the event title in `HonoursPanel.tsx` and `social/Prestige.tsx` (`ShownTitle`). Screenshots: `docs/screenshots/phase-6/events-*.png` (`node tools/screenshots/events.mjs`, a dev server on a scratch database).

## For players
- A banner in the town and on the world map says when an event is on; the Tavern has its notice: the story, what changes while it lasts, the tasks and the reward track.
- **Join in the Tavern** (per hero). Only what the hero does from then on counts; the modifier's bonus comes only to heroes who joined.
- Tasks pay **tallies**; the tallies of all your heroes fill **one reward track** for your account. Each tier gives a keepsake once, for good.
- Rewards are cosmetic: they change no number in the game. Titles are shown from your profile → Season honours (one title at a time) or the collection book; banner styles and title colours are worn from the collection book (6.8, `docs/COSMETICS.md`).
- **At the end** unfinished tasks lapse. Everything earned while it ran (bonus materials, tallies, keepsakes) stays yours. If the same event comes back later, it starts fresh; a keepsake you already own is not given twice.
- **Longer events (8.3)** open their tasks a week at a time: the Tavern shows every week, the weeks to come with the day they open. A week's tasks stay open until the event ends. Some tasks are for heroes of a level and up (the notice says which, and whether your hero has it yet).

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

## The second event: the Lantern Procession (`lanternProcession`, ticket 8.3)
*When the nights grow longest, Graumark walks its lanterns out: from the town gate down the Ashen Road, past the burning Verge, to the edge of the Hollow, one stage each week…* Posted by Mother Ansel of the lantern-house. Default length **28 days** (four weeks); the tally is **lantern marks**. The owner's B.5b decision asked for a longer chase: the track takes the whole four weeks, and a week of tasks needs several days of ordinary play.

**Modifier: "Iron for the lantern frames"** (`gatherBounty`, new in 8.3): for a hero who joined, every **25** Timber, Ashwort, Raw Hide or Iron Ore gathered while farming (the settlement's own materials; never a dungeon hoard, never the bonus itself) yield **one extra Iron Ore**. A running count per hero and event (`event_participants.bounty_kills`, now "the bounty count"), split-invariant like the Harvest's. Measured (`tools/balance/endgame.ts procession`, 3 seeded hours per class): **1.1–1.9 ore an hour** for endgame heroes (about **+4 %** on the 28–48 ore an hour they gather), 1.5–2.1 for a level-20 hero in the Abbey, 3.0–3.9 for a level-12 hero in Crowwood, 1.8–1.9 for a newcomer in the Fields (a new trickle; ore is first used by tier-3 gear at 17). `docs/ECONOMY.md` "Event materials". XP, gold, items and drop odds are untouched (tested).

**Weeks and tasks.** Week *w* opens **(w − 1) × 7 days after the start**, to the millisecond (the window rule: a request that arrives before that moment does not advance the week's tasks; one at it does). Earlier weeks stay open until the end. Each week has two tasks open to every hero (the **open road**) and one for heroes of **level 28** and up (the **deeper road**; the hero's level when the request arrives, so a hero who reaches 28 from then on counts, and every earlier week's deeper task opens for it too).

| Week | Task | Goal | Level | Marks |
|---|---|---|---|---|
| 1 · the town gate | Clear the Gate Road | put down 1,500 foes anywhere | any | 10 |
| 1 | Wick and Frame | gather 150 Timber, Ashwort, Raw Hide or Iron Ore | any | 10 |
| 1 | Wardens at the Gate | defeat any dungeon master twice | 28+ | 15 |
| 2 · the Ashen Road | The Ashen Road | put down 2,500 foes anywhere | any | 15 |
| 2 | Oil for the Lanterns | gather 250 of them | any | 15 |
| 2 | Through the Cinders | put down 2,000 foes of the Cinderwastes or the Hollow Reach | 28+ | 20 |
| 3 · the burning Verge | Hold the Verge | put down 3,500 foes anywhere | any | 20 |
| 3 | Brass for the Frames | gather 350 of them | any | 20 |
| 3 | Keepers of the Flame | defeat any dungeon master four times | 28+ | 25 |
| 4 · the Hollow's edge | To the Hollow's Edge | put down 5,000 foes anywhere | any | 25 |
| 4 | The Last Light | gather 450 of them | any | 25 |
| 4 | Into the Dark | put down 3,000 foes of the Cinderwastes or the Hollow Reach | 28+ | 30 |

Gathering counts the modifier's own ore (as the Harvest's Tithe counts its shards). Dungeon masters: the Gravewarden (any tier), the Ashen Warden, the Forge Tyrant, the Hollow Sovereign; a boss fought on its hoard cooldown still counts (its kill is a quest event).

**Reward track** (marks per account; seven keepsakes, all existing art with code treatments, no new PixelLab art):

| Tier | Marks | Keepsake | Cosmetic id | Treatment |
|---|---|---|---|---|
| 1 | 10 | Wick-amber title colour | `title-colour.wick-amber` | CSS colour |
| 2 | 30 | Procession banner | `banner.procession-lantern` | A.13's Warden-flame device, re-dyed lantern gold (CSS filter) |
| 3 | 60 | Lantern-brass crest | `crest.lantern-brass` | A.13's iron rim, sooted brass (CSS filter and metal colour) |
| 4 | 100 | Deep-lantern title colour | `title-colour.deep-lantern` | CSS colour |
| 5 | 140 | Procession bearer appearance | `appearance.lantern-bearer` | a palette swap of every class (`tools/art/hero_palettes.py`) |
| 6 | 190 | Hollow procession banner | `banner.hollow-procession` | A.13's ember standard, bleached pale (CSS filter) |
| 7 | 230 | title "Keeper of the Long Road" | `title.keeper-of-the-long-road` | title |

**Participation tiers** (by level): the open road alone gives **140 marks: tier 5** (the appearance) for one hero of any level who plays every week; the deeper road's 90 marks take an account to **tier 7**. A second hero's open road also counts (marks are per account), so a newcomer with two heroes can reach the top. **Pacing** for one hero doing every task as it opens: 35 / 85 / 150 / 230 marks after weeks 1–4 (tiers 2 / 3 / 5 / 7; the title only in the fourth week). Hours of farming for a week's open-road tasks (the slower of the kill and the gathering task; measured as above): newcomer in the Fields 3.5–3.9 / 5.8–6.4 / 8.1–9.0 / 11.6–12.9 h; level 12 in Crowwood 1.9–2.3 / 3.1–3.8 / 4.3–5.3 / 6.2–7.6 h; level 20 in the Abbey 2.7–3.8 / 4.5–6.4 / 6.3–8.9 / 8.1–11.5 h; level 40 in the Depths 4.0–5.1 / 6.7–8.5 / 9.4–11.9 / 12.1–15.3 h; level 46 in the Pale Marches 3.3–3.9 / 5.5–6.4 / 7.7–9.0 / 11.0–12.9 h. The deeper road's kill tasks are farmed in the same hours by heroes in the Cinderwastes or the Hollow Reach (4.2–5.2 h for week 2's, 6.3–7.7 h for week 4's). With the 3 h offline cap, a week's open road is two to four days of ordinary play, so the track is a four-week chase, not an hour (B.5b).

## Event definitions (data)
`EventDefinition` (game-core `events/definitions.ts`): id, name, tagline, giver, Tavern text, tally name, default length, a `modifier`, `quests` (`EventObjective`: `kill` with a foe list or any, `gather` a material, 8.3's `gatherAny` several materials summed, `defeatBoss` with a list or any; its tallies; 8.3's optional `week`, default 1, and `minLevel`, default none) and a `track` of tiers (tallies, cosmetic id). `validateEventDefinition` checks the content in `events.test.ts`: known foes, bosses, materials and cosmetics; **3–5 quests in each week**, weeks 1…n without a gap, every week opening before the default end, at most 20 quests; **3–7 tiers** numbered 1…n with rising tallies, the top reachable by the quests and the first by quests open to every level; a modest modifier. Modifier kinds: `killBounty` (6.6) and `gatherBounty` (8.3), both through `eventBounty`; a new kind is a new branch there and must stay "ordinary loot at ordinary odds" (bonus materials, modest, documented in ECONOMY.md). Progress rules take the **request's context** (`EventProgressContext`: the event week it arrived in, `eventWeekAt`, and the hero's level then); a quest whose week has not begun, or whose level the hero lacks, does not advance. Events are not imported by any combat, loot, farming, dungeon, scoring or PvP rule (an import scan in `events.test.ts`).

## Scheduling
`world_events` (`DATA_MODEL.md`): number, definition, `[starts_at, ends_at)` in UTC (the game clock), `cancelled_at`, `closed_at`, `rewards_swept_at`. game-core `events/plan.ts` decides every plan change, the server runs it under one advisory lock (`events:plan`) and audits it (`event.schedule`, `event.extend`, `event.end`, `event.cancel`, with `via: admin|cli`):
- **One at a time.** Windows of events that are not cancelled never overlap, and at most one event waits to begin (`one_scheduled`). An event may start now (a minute's slack) or later; it lasts **1 hour to 4 weeks**.
- **Extend or bring forward** the end of the event under way or the next one (never into the past, never over the next one); **end early** = now (may leave it shorter than an hour). **Cancel** only one that has not begun; numbers are never reused. Refusals are `409 event_plan_refused` with `details.problem`.
- Since 8.3 the **automatic calendar** may put events on by itself (below); events scheduled by hand keep every rule here, and win over automatic ones. Each row records who put it on (`source`: `manual` or `calendar`).
- Admin panel: `#/admin/events` (admins only, D.3's not-found `404` for everyone else, the role re-read in the plan transaction). CLI: `pnpm admin:events …` / `deploy/admin.sh events …` (`DEPLOY.md` "Events").

## The calendar (ticket 8.3)
game-core `events/calendar.ts` decides, server `events/calendar.ts` runs it under the same plan lock as every manual change, so the calendar and the owner never race.
- **Settings** (`event_calendar`, one row; `DATA_MODEL.md`): **paused** or on; the **rotation** (which events, in order, each with its own length in whole days, 1–28; an event may appear twice; at most 12 entries); the **gap** between one event's end and the next one's start (whole days, 0–60); the next entry. With no row the defaults hold: **paused**, the Lantern Procession (28 days) then the Harvest of Bones (7 days), a 7-day gap. **The calendar starts paused everywhere, production included, until the owner turns it on.**
- **Creation.** The scheduler's `eventJobs` step (on the 6.9 leader only: closing, sweeping, then the calendar) creates the next rotation entry when the calendar is on and **every event that is not cancelled has closed** (none under way, waiting or in the close's grace). It starts at **the last event's end plus the gap**, but never before the next full hour after the run (so never in the past: a calendar turned on after a long pause starts the next event within the hour; a gap of 0 starts it within the hour after the close). It is inserted with `source = 'calendar'` and `calendar_slot = created_count + 1` (a unique index), and the cursor moves on, in one transaction; game-core's `planEventSchedule` still checks it (one at a time, never overlapping). **Exactly once:** a crash before the commit leaves nothing (the next run makes it); two instances or a restart overlapping a run serialise on the plan lock and the second finds the event already waiting; the slot's unique index is the last guard (real-PG tests). Audited `event.schedule` with `via: 'calendar'`, the slot and the rotation index.
- **Pause and resume.** Paused: nothing new is created; an event already on the calendar (waiting or under way) still runs and closes. Resumed: the next creation follows the rule above, the rotation where it was.
- **Skip.** If an automatic event waits to begin, it is cancelled (`event.cancel`, `reason: 'skip'`) and the next entry takes its place at the next run; otherwise the rotation passes over its next entry. Works while paused too.
- **Manual always wins.** Scheduling an event by hand (admin panel or CLI) while an automatic one waits to begin cancels the automatic one first (`event.cancel`, `reason: 'manual_override'`, in the same transaction; rolled back if the manual plan is refused) and puts the rotation back to its entry, so it comes **after** the owner's event. An event under way is never displaced: end it early first. A waiting event that was scheduled by hand blocks the calendar (it waits for it) and is never cancelled by it.
- **The next three** (`projectCalendar`): the event waiting to begin (by hand or automatic), then the rotation from the last end on, each a gap after the one before. Shown while paused too, marked "once the calendar is on". The admin panel shows them with their origin; the CLI's `calendar status` prints them.
- **Every change is audited** (`event.calendar` with `action` `set`, `pause`, `resume` or `skip`, `via: admin|cli`, the settings before and after).
- **Seasons (5.3).** Seasons run back to back by themselves and events do not look at them: **an event may span a season boundary**. Nothing about an event is season-bound: tallies, keepsakes and bonus materials are not scores, not archived with a season and not reset by one, and an event changes no board (`LEADERBOARDS.md`). The weeks of a weekly event count from its own start, not from ISO weeks, so they do not line up with the weekly boss modifiers (`DUNGEONS.md`), which events never change.
- Admin panel: the Events tab's "The automatic calendar" (turn on with a confirmation, pause, skip with a confirmation, the next three, the rotation editor with order, length and gap). CLI: `deploy/admin.sh events calendar status|pause|resume|skip|set --rotation id:days,… --gap N` (`DEPLOY.md` "Events").

## The window rule at the boundaries
As 5.3's seasons: **progress counts when the request that made it arrived inside `[starts_at, ends_at)`** (the settlement's or the dungeon claim's game clock). A settlement at or after the end changes nothing for the event (its kills are still the hero's), one 1 ms before the end counts (tested with an injected clock). Joining settles the hero first, so farming before the join never counts; a dungeon claim counts only for heroes who joined before the run started (`joinedBy`, like quests' `acceptedBy`). The scheduler settles active heroes regularly, so at most the last interval before the end goes uncounted, as for seasons.

**Closing.** Once `now ≥ ends_at + 5 min` (`EVENT_CLOSE_GRACE_MS`) the scheduler (or `admin:events close`) closes the event under its exclusive advisory lock (`event:<n>`); every progress write takes it shared and re-checks `closed_at`, so writes in flight finish first and none follow. `event.close` is audited with counts. Unfinished quests are **expired by the clock**: nothing is deleted; `event_participants` keeps every hero's progress, bonus and tallies as they were at the end.

## Progress (`events/progress.ts`)
`recordEventProgressTx` runs in the settlement (`settleActivityTx`) and the dungeon claim, right after `recordQuestEventsTx`, under the character lock. For a hero who joined the event under way: the bounty (`eventBounty`: the kill bounty from the settlement's kills, 8.3's gather bounty from its own materials) gives bonus material (granted to the hero's stacks), the settlement's quest events plus the bonus as `materialGathered` advance the event's tasks (`applyEventProgress`: adds and caps, split-invariant; 8.3: only tasks whose week had begun when the request arrived and whose level the hero had then, its level before the settlement), finished tasks add their tallies to the hero's row and the account's `event_tracks` row, and every tier those tallies reach is granted (below). Ordinary quests never see the bonus. Audited `event.progress` (completed tasks, tallies, bonus) only when something was completed or given.

## The reward track: exactly once
`grantTiersTx` inserts one `event_track_grants` row per (event, account, tier) and the tier's `cosmetic_unlocks` row, each `on conflict do nothing`; it audits (`event.reward`) and counts only what it inserted. It runs **in the transaction that completes a task**, so a tier arrives with the tally that reached it; two heroes of one account finishing at once serialise on the account's track row and the primary key keeps each tier once (real-PG test). **The sweep:** after the close, `sweepEventRewards` checks every account's tallies against the track as it stands and grants any tier still missing (a backstop, e.g. a threshold lowered between releases), one transaction per account; `rewards_swept_at` is set only after the last batch, so a crash leaves it null and the next run finishes the same set (`event.sweep` audited once). Tested on PGlite and real Postgres: sweeps racing and crashing mid-way, then resumed.

## Cosmetics
`cosmetic_unlocks` (account, cosmetic id, source `event:<n>:tier:<t>`, granted_at), the store 6.8's collection book extends (`docs/COSMETICS.md`: more sources, equip, display). Catalogue: game-core `cosmetics/catalogue.ts` since 6.8 (was `events/cosmetics.ts`; ids kept). `GET /api/account/cosmetics` lists an account's unlocks. **Titles** show today through 5.3's prestige display: `prestige_displays.cosmetic_title` (a composite foreign key to the account's own unlock; never together with a season title) and `POST /api/account/prestige { title: null, frame, cosmeticTitle }` (`422 one_title`, `422 award_not_earned`); `prestigeFor` returns `cosmeticTitle` for boards, profiles and rosters (`ShownTitle`). Since 6.8 every keepsake is shown (`shownToday` is true for every catalogued kind) and worn from the collection book.

## Test accounts and rankings
There is no event leaderboard. The admin view's and the CLI's participation counts leave test accounts out (D.4); their telemetry goes to `telemetry_daily_test` as for every value path. Sanctions don't block joining (nothing is ranked).

## Telemetry
`event.join` (event id), `event.quest` (event, task; amount = tallies), `event.reward` (event, `tier<n>`, cosmetic id), 8.3's `event.schedule` (event id, `admin`, `cli` or `calendar`) and `material.in` source `event` (material, event id). The report has an "Events" section (since 8.3 with the events scheduled by hand and by the calendar); `--reconcile` checks joins, tasks, tallies, bonus materials and grants against the audit log, and two holdings: the grants ledger equals the audited grants, the tracks hold exactly the audited tallies (`TELEMETRY.md`).

## API
- `GET /api/events` → `{ now, current, next }` (`EventView`: the definition's words, tasks with targets, the track with its cosmetics, the window and status; 8.3: each task's `week`, `minLevel` and `opensAt`, the event's `weeks` and current `week`, and its `source`).
- `GET /api/characters/:id/event` → the same plus `hero` (null until joined: tasks with progress and, since 8.3, `open`: its week has begun and the hero has its level; tallies, bounty count, bonus) and `track` (the account's tallies and granted tiers).
- `POST /api/characters/:id/event/join` → `201` the first time, `200` after (repeat-safe); `422 no_event` outside an event.
- `GET /api/account/cosmetics` → `{ unlocks }`.
- Admin: `GET /api/admin/events` (8.3: with `calendar`: the settings and the next three `planned`), `POST /api/admin/events { definitionId, startsAt, endsAt }`, `POST /api/admin/events/:n/end { endsAt? }`, `POST /api/admin/events/:n/cancel`; 8.3: `POST /api/admin/events/calendar { paused?, rotation?: [{ definitionId, days }], gapDays? }` (at least one; `409 calendar_refused` with `details.problem`) and `POST /api/admin/events/calendar/skip`.

## Tests
- `packages/game-core/src/events/events.test.ts`: content validity, the window and statuses, plan rules (one at a time, overlaps, lengths, end early, extend, cancel), progress caps and completion once, split invariance of progress and the bounty over 200 random splits, the bounty's limits.
- `apps/server/src/events/events.test.ts`: the boundary with an injected clock (join only while it runs; 1 ms before the end counts, the end does not; closed once, nothing after), one at a time and the admin permission matrix (404 for anonymous, players, moderators before the body; audit), the CLI, two heroes filling one track (each tier and cosmetic once), the title through the picker, an event ending mid-quest (expired, nothing lost, a fresh next run), the sweep across a crash, **invariance** (the same hour farmed without an event, outside an event and joined: identical XP, gold and items; materials differ only by the bounty), the import scan, test accounts out of the counts, reconciliation.
- `apps/server/src/events/events.pg.test.ts` (real Postgres): heroes of the same accounts completing tasks at once (each tier once), progress racing the close (before it or not at all), sweeps racing and crashing then resumed.
- Journey: `playEventStep` (`e2e/journey.ts`; `event-journey.test.ts`).
- Ticket 8.3: game-core `events/procession.test.ts` (four weeks of three tasks, the week boundaries to the millisecond, a request advancing only the weeks begun, the level gate, participation tiers and weekly pacing, the gather bounty over 200 random splits, the Harvest unchanged) and `events/calendar.test.ts` (settings checks; the first start at the next hour; gap and length exact over many cycles; a gap of 0; never two events, whatever the history; pause and resume; skip; a manual event in between; the next three matching what is then created). Server `events/calendar.test.ts` (the admin permission matrix; paused by default; refusals; on → created once at the next hour, nothing while one waits, runs or closes, the next exactly the gap after the end; pause and resume; skip of a waiting and of a planned entry; manual over automatic, the displaced entry after it, a refused manual plan rolling back; no overlaps over the whole history; audits; the CLI; the Procession's weekly unlocks and level gate through the progress writer, 1 ms before each week and at it; every tier once with the sweep adding nothing; invariance of a farmed hour without the event, outside it and joined, materials differing only by the ore; test accounts left out of the counts with their keepsakes still once; reconciliation). Real PG `events/calendar.pg.test.ts` (eight creators at once over six cycles: one per slot, never overlapping; a restart mid-create leaving nothing; two API instances with the 6.9 leader election, one restarting: created once). Journey `playCalendarStep` (`event-journey.test.ts`). Web `screens/admin-event-calendar.test.tsx`, `events/text.test.ts`.

## Open points (owner)
- **B.5** (`docs/BALANCE.md` "B.5", item 7): a hero who can beat a dungeon master finishes the Harvest's whole track in about an hour of play, a newcomer reaches tier 2 in about two hours. Cosmetic only, so nothing to tune for balance. **Owner decision (B.5b, 2026-11-11):** the Harvest of Bones stays as it is; see "Guidance for future events".

## Guidance for future events
- **The next event should be a longer chase** (owner, B.5b): an endgame hero should not finish the whole track in an hour. Size its tallies and tiers against the event's length (more or bigger tasks, more tiers, or tiers that need several days of play), measured for a newcomer, a mid-game hero and an endgame hero as B.5 measured the Harvest (`tools/balance/endgame.ts event`). The rules above still hold: cosmetic rewards only, a modest modifier, ordinary loot at ordinary odds.
- Should the modifier apply to every hero, not only those who joined? Joining keeps the boundary exact (no kills from before the start) and gives the participation count; applying it to all would need a per-hero counter for every farmer.
- Tallies are per account (alts help fill one track). Per hero instead?
- ~~No automatic next event~~: since 8.3 the calendar rotates events (starts paused; the owner turns it on).
- **8.3 open points:** the deeper road's level (28) and the open road's sizes are a first pass from the measurement above, before live data (B.6). Should the calendar align automatic starts to a weekday or 00:00 UTC rather than the last end plus the gap?
