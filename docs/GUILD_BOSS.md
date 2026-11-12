# The weekly guild boss (ticket 4.9)

GDD §10.1 (group activities), §11.2, §12.2. Owner-confirmed Phase 4 default: an **asynchronous weekly guild boss** — members fight it alone, at their own time, and the damage adds up for their guild — not real-time co-op.

Code: game-core `guild-boss/` (week window, data, fight, permission matrix), server `apps/server/src/guild-boss/` (`model.ts` locks and rewards, `routes.ts`), web `screens/GuildBoss.tsx` (the siege plate in the Guild Hall). Endpoints: `API_CONVENTIONS.md`; tables: `DATA_MODEL.md`; telemetry: `TELEMETRY.md`.

## The boss (data)
`GUILD_BOSSES` in game-core: **The Risen Gravewarden** (reuses the Gravewarden's stats and 128 px art; no new art). A boss is an existing enemy with a damage scale (× 1.6), a level of *hero level + 2*, a 60 s fight window and a rage drawn per attempt between 20 and 40 s (× 2.2 damage, × 1.5 attack speed). Its health is unbounded (`BOSS_HEALTH`): an attempt never kills it, it is a damage race until the hero falls or the minute ends. Heroes from level 10 may fight. `guildBossOfWeek(week)` picks the boss from the (public) week only; with one boss it is always this one.

## The week (window rule)
A week runs from **Monday 00:00:00.000 UTC** (inclusive) to the next Monday 00:00 UTC (exclusive), `guildBossWeek(ms)`; its key is the Monday's date (`2026-11-02`). Each attempt reads the game clock once inside its transaction and stores that week (`guild_boss_attempts.week`); the week is never recomputed later. So Sunday 23:59:59.999 counts in the old week and Monday 00:00 in the new one, and a request in flight at midnight counts in the week of the moment its transaction read the clock (tested in game-core, through the API and, racing, on real PostgreSQL). Attempts, the guild total and the board start over every Monday; earned rewards do not expire.

## The weekly modifier (ticket 6.3)
The guild boss fights with the **weekly boss modifier** like every other boss (`docs/DUNGEONS.md` "Weekly boss modifiers": Burning, Warded, Frenzied, Unyielding, Relentless), on the same week as its attempts. An attempt is fought, stored and replayed with the modifier **of the week it was made in**: the attempt's transaction reads the game clock once, takes that week (`guild_boss_attempts.week`, the window rule above) and its modifier, and stores both (`guild_boss_attempts.boss_modifier`); every later replay uses the stored one. So an attempt at Sunday 23:59:59.999 fights the old week's modifier and counts in the old week, one at Monday 00:00 the new week's, and a request in flight at midnight fights the modifier of the week it counts in (tested in game-core, through the API and, racing, on real PostgreSQL, where every stored attempt replays from its stream, snapshot and stored modifier). Attempts from before 6.3 store `null` and replay as they were.

Because the guild boss cannot fall, a modifier that reads the boss's health share (Warded's ward, Frenzied's frenzy) reads it from the fight's clock instead: 1 at the start of the minute, 0 at its end (the ward stands from 40 % to 55 % of the minute, the frenzy from 60 %). Unyielding's extra health means nothing here: only its slower blows count, so it is the one modifier that raises a week's damage (by 1–9 %); the others lower it by 1–8 % (`docs/DUNGEONS.md` has the table). The guild boss has no hoard, so the modifier's loot focus does not apply; stage rewards are unchanged. The siege plate shows the week's modifier, and the last attempt's blow-by-blow names it. Telemetry: `boss_modifier.guild_boss` (modifier, boss, end; amount = counted damage).

## Attempts
- **3 attempts per account per week** (`GUILD_BOSS_ATTEMPTS_PER_WEEK`), with any of the account's heroes (not only the active one), whatever guild the account is in: the unique key is `(account, week, attempt_no)`, so switching guilds never refreshes them.
- `POST /api/guild/boss/attempts` (`Idempotency-Key`; a retry with the key replays the stored answer). The fight is simulated at once on the server from the hero's **snapshot** (level and equipped items, the crypt's snapshot shape, after settling its farming); farming is not interrupted. The response carries the fight log for the client to show.
- **No re-roll.** Each account has one server-only secret (`guild_boss_streams`, 128 random bits, never sent). Attempt `n` of week `W` fights from `${secret}:${W}:${n}` (`:fight` and `:enrage` sub-streams). An attempt is unknown until it is spent and fixed once it is: a retry replays, a failed request spends nothing and the next one draws the same `n`, and timing changes nothing (invariance test: two accounts given the same secret and hero fight identical fights whether they attack in one minute or across the week; the real-PG races replay every stored attempt from its stream and snapshot).
- **What counts:** damage dealt (blows and thorns). One attempt counts at most **30,000** for the guild (`attemptDamageCap`, the no-monopoly rule); the rest is shown, not counted.

## Stages and rewards
The guild's weekly total (`guild_boss_weeks.total`, written in the attempt's transaction under the guild's lock) climbs five stages: **Cracked** 18,000 · **Staggered** 100,000 (120,000 before ticket B.3) · **Broken** 400,000 · **Shattered** 1,000,000 · **Laid to Rest** 2,200,000. Each stage pays every participant a personal reward: 250 / 400 / 600 / 800 / 1,000 gold, 3 / 5 / 6 / 8 / 10 Soul Shards and a Gravewarden Seal at stages 3 and 5 (at most 3,050 gold a week, about four hours of Sunken Abbey farming gold: no outsized power). Achievements (4.2): **Shoulder to Shoulder** (a stage-1 reward earned) and **Laid to Rest** (stage 5), awarded when the reward is earned.

**When a reward is earned.** A stage's reward is earned by an account that **was a member of the guild when the guild reached the stage and fought for that guild in that week** (before or after the stage was reached):
- When an attempt breaks a stage, every current member gets a reward row: `earned` if they have already fought for the guild this week, else `pending`.
- A member's first attempt for the guild in the week turns their `pending` rows of that guild and week into `earned`.
- A member who leaves (or is kicked) before fighting never earns the pending stage; a late joiner gets no row for stages reached before they joined, so **joining late can't claim rewards already earned**.
- One row per account, week and stage (the primary key), **whatever the guild**: a player who switches guilds mid-week takes each stage at most once that week (an earned row is never overwritten; a pending row left in a former guild moves to the new guild if that guild reaches the stage while they are in it).
- **Damage stays with the guild it was fought for** (`guild_boss_attempts.guild_id`), whatever happens to the player afterwards; it shows on that guild's board as "A former member".

**When it is claimed.** `POST /api/guild/boss/claim` (`Idempotency-Key`, body `{ characterId }`) pays every earned, unclaimed reward of the account — any week, any guild, in or out of a guild — to the chosen hero: gold and materials, `claimed_at` and the hero recorded, `guild_boss.claim` audited and telemetry recorded in one transaction. Earned rewards never expire. A leaver keeps theirs.

## Permissions (game-core `guildBossDecision`)
| Action ↓ / standing → | leader | officer | member | not a member |
|---|---|---|---|---|
| view (the guild part of `GET /guild/boss`) | ✓ | ✓ | ✓ | `guild: null` |
| attempt | ✓ | ✓ | ✓ | 404 not_in_guild |
| claim one's earned rewards | ✓ | ✓ | ✓ | ✓ |

Then the state refusals: `409 no_attempts_left`, `409 hero_too_low`, `409 nothing_to_claim`; `403 test_account` for a test account (D.4) in a guild with any member that is not one (ticket 6.10: the admin cheat tools may have built its hero, and its stages pay every member; read under the guild lock). Ticket 8.7: since the stages such a guild breaks stay with it, a real account may not join a guild whose members are all test accounts (`403 test_guild` at the invite's or the application's accept, under the guild lock); another account's or an unknown hero `404 not_found`. An attempt is a social write (`guildBossAttempt`: the social rate limit, a suspension blocks it) that a **mute does not block** (it carries no text and reaches no one). A block blocks no one from fighting; on the board a player blocked either way shows without a name ("A blocked player"), as do former members and names a moderator hid. Tested through the API in `guild-boss.test.ts` (every standing × action, blocks, mutes, a kick).

## Locks and races
Order: the account row (share, the sanction check) → the account's guild boss lock (`guildboss:<account>` advisory lock: one account's attempts and claims run one at a time, across guilds) → the hero (`lockOwnedCharacter`, settles its farming) → the guild lock (the lock every membership change takes; the membership is re-read under it). A kick or leave racing an attempt lands before it (refused, `404`) or after it (counted for the guild). Claims take the account's guild boss lock and the hero. Real-PostgreSQL races (`guild-boss.pg.test.ts`, three rounds in varied orders, no retries): one account racing eight attempts across two heroes (exactly three land); one key racing itself (one attempt, one answer); a whole guild racing across the stage thresholds (the total equals the sum of its attempts, each stage reached and audited once, every fighter earns each stage exactly once); attempts racing a kick (each lands before the kick in the audit log or is refused); attempts racing a guild switch (one weekly budget); and attempts on both sides of Monday 00:00 (each in the window of its own moment, never more than three per account and week). Each race also replays every stored attempt and reconciles telemetry with the audit log.

## Balance (`balance/guild-boss-balance.test.ts`)
Measured damage per attempt (24 seeds, warrior / mage / hunter / warlock): level 10 naked ≈ 650; level 12 commons ≈ 1,900; level 14 commons ≈ 2,200; level 18 rares ≈ 5,200; level 21 epics ≈ 7,400; level 24 Legendaries ≈ 15,600; level 28 Legendaries +10 ≈ 27,000; best-in-slot ≈ 86,000 (counted 30,000). Asserted:
- **A small guild finishes the first stage in a week**: three level-14 heroes in commons with all their attempts (but not with one attempt each), and five level-12 heroes in commons.
- **A small guild of late-game heroes breaks the second stage** (ticket B.3): three heroes at the Pass's entry (level 24, Legendaries) or five at the Abbey's top (level 21, epics); three level-18 heroes in rares stop at the first.
- **A large guild cannot trivialise every stage**: 30 best-in-slot heroes all hit the cap, so the last stage needs more than three quarters of every attempt a full guild has (they reach it with all attempts, not with two each, and twenty of them fall short). 30 level-24 Legendary heroes reach stage 3–4, not the last; 30 level-18 rare heroes stage 3.
- **One hero cannot carry a guild**: a best-in-slot hero's whole week (3 × the cap = 90,000) is below stage 2.
- Every class deals a useful share from the minimum level.

### Ticket B.3: the cap and the thresholds
4.9 flagged the per-attempt cap and the thresholds for tuning. Weekly counted damage with every attempt (`tools/balance/guild-boss.ts`, generated kits, 12 seeds per class; the stage reached before → after B.3, where it differs):

| Heroes (gear) | per attempt | 1 hero | 3 | 4 | 5 | 10 | 30 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| level 14, commons | 2,400 | 7k (–) | 21k (1) | 28k (1) | 35k (1) | 71k (1) | 213k (2) |
| level 18, rares | 5,100 | 15k (–) | 46k (1) | 62k (1) | 77k (1) | 154k (2) | 462k (3) |
| level 18, rares +5 | 6,200 | 18k (1) | 55k (1) | 74k (1) | 92k (1) | 185k (2) | 554k (3) |
| level 21, epics | 8,100 | 24k (1) | 73k (1) | 97k (1) | 122k (2) | 244k (2) | 731k (3) |
| level 21, epics +5 | 9,800 | 29k (1) | 88k (1) | 118k (1 → **2**) | 147k (2) | 295k (2) | 884k (3) |
| level 24, Legendaries | 17,700 | 53k (1) | 159k (2) | 212k (2) | 265k (2) | 530k (3) | 1.59M (4) |
| level 26, Legendaries +5 | 21,600 | 65k (1) | 195k (2) | 260k (2) | 324k (2) | 649k (3) | 1.95M (4) |
| best-in-slot (capped) | 30,000 | 90k (1) | 270k (2) | 360k (2) | 450k (3) | 900k (3) | 2.7M (5) |

**Changed: stage 2 120,000 → 100,000.** Before, a guild of 3–5 needed five Abbey-top heroes in epics (122k, barely) or three at the Pass to break it; now four upgraded Abbey heroes or six level-18 heroes with +5 rares do too, and the margins of the asserted guilds are wider. 100,000 stays above one capped hero's week (90,000), so a lone best-in-slot hero still can't take stage 2 alone. A threshold lowered mid-week is paid at the guild's next attempt: new stages are counted from the stage the week has recorded, not from the total before the attempt (`stagesAfter`, tested), so a guild that stood between 100,000 and 120,000 when this shipped gets stage 2 with its next blow.

**Kept: the 30,000 cap and stages 1, 3–5.** Only best-in-slot builds reach the cap (Legendaries +5 at 26 average 21,600), so it does what it is for: past it gear stops mattering for the guild, and a full guild of the strongest builds needs 82 % of its attempts for the last stage. Lowering it would push stage 5 out of reach of anything but a full best-in-slot roster; raising it would let one hero take stage 2 alone. Stage 1 can be taken by one geared Abbey hero (an epic kit at 21): that is a solo guild's 250 gold and 3 soul shards a week, harmless.

**Rewards against the economy** (kept). At most 3,050 gold a week (stages 1–5) against ≈ 25,000–35,000 gold a *day* of realistic income at the Abbey and the Pass: 1–2 % of a late-game week, a garnish, not a source. In the B.3 telemetry week (two guilds of 4 and 20) the guild boss paid 0.5 % of all gold. Its materials matter more than its gold: soul shards for the +8 → +10 steps and two Gravewarden's seals a week at stages 3 and 5 (the Pass project needs 10).

## UI
The Guild Hall shows the **siege plate** above the chat (`screens/GuildBoss.tsx`): the boss in a stone niche with the week and when it rises again; the chain of five stage seals with the total; the attempt diamonds, the week's own attempts, the hero picker and "Face the boss"; the last attempt blow by blow (damage, how much counted, crits, the rage, how the hero ended, a broken stage); the guild-only damage board; and "Spoils waiting" with the claim. A player without a guild sees their unclaimed spoils on the hall page. Loading, error (Try again), stale, empty board and no-ready-hero states. Polled every 2 min while open (≈ 6 indexed reads, well inside the per-account limits). Screenshots: `docs/screenshots/phase-4/guild-boss-*` (`node tools/screenshots/guild-boss.mjs`).

## Audit and telemetry
Audit: `guild_boss.attempt` (attempt id, guild, week, number, boss, level, damage, counted, end, the total after, stages broken), `guild_boss.stage` (one per stage reached), `guild_boss.earn` (per account and attempt: stages, gold, materials), `guild_boss.claim` (gold, gold after, materials, the rewards). Telemetry: `guild_boss.attempt` (boss, end; amount = counted damage), `guild_boss.stage` (boss, stage), `gold.in guild_boss`, `material.in guild_boss`. `report:telemetry --reconcile` checks attempts, counted damage, stages, reward gold and reward materials against the audit log.

## Accepted risks
- An attempt is resolved instantly; the client replays the log. Its result is visible at once, which is harmless because an attempt can neither be undone nor re-rolled.
- The best builds hit the per-attempt cap, so past it gear stops mattering for the guild (by design: no monopoly). B.3 revisited the cap and thresholds on simulations (above); real guild data may move them again (all data in `GUILD_BOSSES`).
- Accounts deleted later keep their damage in the guild's total (`account_id` set null); their rewards go with the account.
