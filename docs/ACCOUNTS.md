# Account growth: character slots & the offline cap

Ticket 9.4, GDD §5.3 (character slots are account-bound), §9.1 (the offline cap "to be raised later through player progression") and §17. An account grows by playing: more hero slots and more hours of farming while away. Nothing here is sold today. The offline cap is **never** sold (more offline hours are more progress, which is power). Extra slots may be sold later in the 8.8 shop (owner decision 2026-11-12); the grant model already records a source for that, so it needs no migration.

Code: game-core `account/growth.ts` (the rules, the steps, `offlineCapEndMs`); server `apps/server/src/account-growth/` (`grant.ts` grants and reads, `backfill.ts`, `routes.ts`); web `screens/AccountGrowthPanel.tsx` (the account page's "Muster & vigil") and the locked slot in `screens/CharactersScreen.tsx`.

## The rules (data)

Each rule has an id (stored as the grant id and the source: never rename or reuse one), a kind and an unlock read from **one hero's row** (its level and world progress). Any hero of the account can earn it, once for the account.

| Rule id | Kind | Unlock | Gives |
| --- | --- | --- | --- |
| `level28` | slot | any hero reaches level 28 | the 3rd slot |
| `heroicCrypt` | slot | a hero clears the Heroic crypt (Nameless Crypt tier IV) | the 4th slot |
| `community` | slot | the town's next community project (**not built yet**, see below) | the 5th slot |
| `offlineLevel10` | offline | any hero reaches level 10 | one step |
| `offlineCrypt1` | offline | a hero defeats the Gravewarden (crypt tier I) | one step |
| `offlineCrypt3` | offline | a hero clears the crypt at tier III | one step |
| `offlineCinderwastes` | offline | a hero slays the Ashen Warden (the way into the Cinderwastes) | one step |

Owner defaults (2026-11-13): slots as above; the offline cap grows 3 → 4 → 5 → 6 → 8 h through account deeds (levels, regions, the crypt tiers). The four deeds above are this ticket's pick of those kinds: a level, two crypt tiers and a region's gate. **Every deed is one step**, whatever order they come in: the cap is the base (`OFFLINE_CAP_SECONDS`, default 3 h, stays the server's value) plus `OFFLINE_BONUS_STEPS_MS[deeds]` = 0 / +1 / +2 / +3 / +5 h.

Slots: the account's total is `accounts.character_slots` (the base, 2 for every account; an admin value stays possible) plus its slot grants of any source.

### The 5th slot: a seam

The "town's next community project" doesn't exist yet. The rule `community` is defined with the unlock `{ kind: 'futureCommunityProject' }`, which no hero row can meet, so it is **never granted** (asserted in game-core and the server tests). The account page lists it as the 5th slot, "The town's next great work. It has not been proclaimed yet.", and the hero list shows it as the locked slot once the 4th is earned. When the project lands: change that rule's unlock to the project (its completion awards contributors, like the community achievements), keep the id `community`, and the backfill (its id hashes every rule's unlock) runs again on deploy and grants it to every contributor.

### Later: the shop (8.8)

A bought slot is a row with `kind = 'slot'`, `source = 'shop'` and its own `grant_id` (e.g. `shop:<order id>`, so an account may own several). The slot total counts every slot grant, so nothing else changes: no migration, no new check. The offline cap has no shop source and must never get one.

## Granting

- **Where:** `refreshAchievements` (achievements/award.ts) calls `grantAccountGrowthTx` with the hero row after its change, inside the event's own transaction: settlements that change the level, dungeon claims (crypt tiers, the Ashen Warden), the D.4b admin progress tools. **Test accounts follow the same rules** (D.4): their heroes earn through the same hook.
- **At most once, audited, never removed:** the insert is `on conflict do nothing` on the primary key `(account_id, grant_id)`; only the insert that created the row writes the `account.grow` audit row (`grantId`, `kind`, `source`, `backfill`). Two heroes, a live grant and the backfill, or two backfills can race; the account gets one row and one audit row. No route, tool or job deletes a grant; a deleted hero's grants stay with the account.
- **Account-bound:** a grant belongs to the account (`account_id`), with the earning hero kept for the record (`character_id`, set null if the hero row is ever purged).
- **Server only:** no request writes a grant or names one. `GET /api/account/growth` only reads.

## The offline cap

The credited window is `[settled_at, min(now, capEnd)]` (docs/FARMING.md "Time and the offline cap"). Ticket 9.4 makes `capEnd` per account: game-core `offlineCapEndMs(last_seen_at, base, grant times)`:

1. Start with `last_seen_at + base + bonus(deeds granted at or before last_seen_at)`.
2. Walk the later offline grants by `granted_at`. A grant **at or before** the current end raises the cap to the next step (the end moves to `last_seen_at + base + bonus(deeds)`). A grant **after** the end changes nothing for this absence: the cap had already run out, and time already lost is never paid back.

So a deed counts from the moment it is earned (`granted_at`, the server clock of the transaction that granted it). Examples with the 3 h base, `last_seen_at` = 0: a deed at 2 h → credit until 4 h; at exactly 3 h → until 4 h; at 3 h + 1 s → until 3 h. The next contact (start, settle, stop) starts a new absence with every step in force.

**A deed earned during a settlement** (a level-up, say) is granted at that settlement's `now`, after its window was computed with the steps in force before it. It counts for every later settlement of the same absence if the cap was still running at that moment (scheduled settlements, `SETTLE_INTERVAL_SECONDS`, make this the usual case), and never for time before it. Tested: a level-9 hero levels in a scheduled settlement at 30 min, then stays away 6 h: credit ends at 4 h.

The settlement reads the grants only when `now` is past the base cap (the steps can only move the end later), so active play costs no extra query. The read is inside the settlement's transaction; a grant committed by another hero's transaction at that very moment may be seen only by the next settlement (it can only shorten that one window's credit, never lengthen it).

`GET /api/characters/:id/activity` returns the account's current cap as `offlineCapMs` (the "what continues offline" note shows it).

## Slots in hero creation

`POST /api/characters` locks the account row (`for no key update`), counts live heroes and compares with the base plus the slot grants: `422 no_free_slot` with `details.slots { used, total }`. The admin hero delete and restore (D.4) take the same account lock, and the restore checks the same total (`409 no_free_slot`). A grant is not taken under that lock: a creation racing a grant may miss a slot granted at that instant (it is refused, and the next try succeeds), but can never create one hero too many.

## Backfill

`backfillAccountGrowthAll` (`account-growth/backfill.ts`) runs in `migrate-cli` after the cosmetics backfill: for every account, each hero's row (soft-deleted heroes too: their deeds were earned) goes through the same `grantAccountGrowthTx` with `backfill = true`. Recorded once per database and rule set in `data_backfills` (`account-growth:<hash of every rule's id, kind and unlock>`), so a new or changed rule runs it again. Safe to run twice (tested: a crash half-way, a resume, a second run, a forced run that grants nothing). A backfilled grant's `granted_at` is the backfill's time: an offline step counts from the deploy and pays back nothing from before it.

## API

`GET /api/account/growth` (session; read-only) →
```
{ slots: { base, total, used, entries: [{ source, description, available, grantedAt }] },
  offline: { baseMs, capMs, nextCapMs, stepsMs, deeds: [{ source, description, available, grantedAt }] } }
```
`slots.entries` lists the earnable slots in order (`available: false` for the community seam), then any slot from another source (the later shop). `offline.capMs` is the cap in force now, `nextCapMs` after one more deed (null at 8 h), `stepsMs` every step.

`GET /api/characters` adds `slots.locked: { source, description, available } | null`: the next slot still to earn, shown in the hero list.

## UI

- **Account page, "Muster & vigil":** the hero slots one per line (the two every account has, the earned ones with their date, the next one marked "Next:" with how to earn it, the community slot sealed), and the hours away: a strip of steps (3 · 4 · 5 · 6 · 8 h, the current one lit), each deed with its seal and date, and the rule "a new step counts from the moment it is earned".
- **Hero list:** after the heroes and empty slots, one **locked slot** card (barred alcove, sealed lozenge) with its unlock and a link to the account page.

## Races (real PostgreSQL, `account-growth.pg.test.ts`)

- Creation vs an admin deletion at full slots: the freed slot is used or the creation is refused; live heroes never exceed the total.
- Creation vs an admin restore for the last free slot: exactly one of them takes it.
- Creations vs two concurrent grants of the 3rd slot: one grant row, one audit row, at most one extra hero.
- Eight creations with an earned slot: exactly three heroes.
