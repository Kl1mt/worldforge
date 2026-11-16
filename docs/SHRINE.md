# The Reward Shrine (ticket 9.5)

GDD §13.1–13.3; Phase 9 ground rules and owner decisions in `ROADMAP.md` (9.5). The Summoning Shrine in Graumark's square is a cosmetic draw: every draw gives a keepsake for the collection book, or **Shrine marks** when you already have it, and marks buy the keepsake you choose. **Cosmetic only:** nothing at the Shrine changes a number in the game (no stats, no power, no drop odds). **Nothing sells draws:** every draw is earned in play, and a free one comes every day.

Code: game-core `packages/game-core/src/cosmetics/shrine.ts` (pool, odds, the draw, marks, the bank; tests `shrine.test.ts`) and the catalogue's `shrine`-sourced entries (`cosmetics/catalogue.ts`); server `apps/server/src/shrine/` (`model.ts` the only writer of Shrine rows, `routes.ts`); web `apps/web/src/shrine/` (API, the Shrine screen `#/shrine`, words) and the companion in the combat scene (`scene/`). Art: A.19 (`hub.shrine`, `companion.<name>`).

## For players
- **Open the Shrine** from the town square (the Summoning Shrine). It shows the draws you hold, your marks, the odds and the marks shop.
- **One free draw a day** (a new one each day at midnight UTC). Unused free draws are kept, up to **7**, so missing a day never loses it; while 7 are waiting, no more are added. A new account starts with today's draw; an account older than a week opens the Shrine with all 7.
- **Extra draws from play:** each tier of an event's reward track (1 draw), each deed (achievement) earned (1 draw), and a season's honours (by your best tier that season: Veteran 1, Renowned 2, Exalted 3, Champion 4). Extra draws never expire and have no limit.
- **Duplicates become marks:** a common keepsake you already own gives 2 marks, a rare one 5, a hallowed one 15. Marks buy any keepsake of the Shrine you choose: common 10, rare 25, hallowed 75.
- **Companions** are a new kind of keepsake: a small animal or wisp that walks beside your active hero in the fight. Choose one in the collection book (Companions); it has no stats.

## The odds (published)
A draw first picks a rarity by its weight, then one keepsake of that rarity, each equally likely. What you already own does not change the odds; it only turns the keepsake into marks.

| Rarity | Chance | Duplicate marks | Price in marks |
|---|---|---|---|
| common | 70 % | 2 | 10 |
| rare | 25 % | 5 | 25 |
| hallowed | 5 % | 15 | 75 |

Every keepsake's chance (a test checks this table against game-core's `shrineOdds()`, and game-core measures them over 60,000 seeds):

| Cosmetic id | Name | Kind | Rarity | Chance |
|---|---|---|---|---|
| `companion.grave-moth` | Grave moth | companion | common | 11.667 % |
| `companion.bone-rat` | Bone rat | companion | common | 11.667 % |
| `companion.bog-toad` | Bog toad | companion | common | 11.667 % |
| `companion.ash-raven` | Ash raven | companion | common | 11.667 % |
| `companion.candle-wisp` | Candle wisp | companion | rare | 4.167 % |
| `companion.crypt-cat` | Crypt cat | companion | rare | 4.167 % |
| `companion.ember-newt` | Ember newt | companion | rare | 4.167 % |
| `companion.barrow-owl` | Barrow owl | companion | rare | 4.167 % |
| `companion.hollow-wisp` | Hollow wisp | companion | hallowed | 1.667 % |
| `companion.cinder-pup` | Cinder pup | companion | hallowed | 1.667 % |
| `title-colour.votive-gold` | Votive gold | titleColour | common | 11.667 % |
| `crest.votive-ash` | Votive-ash crest | crest | common | 11.667 % |
| `title-colour.shrine-ember` | Shrine ember | titleColour | rare | 4.167 % |
| `banner.votive-veil` | Votive veil | banner | rare | 4.167 % |
| `appearance.candlelight` | Candlelight | appearance | hallowed | 1.667 % |

## The pools
The pool is the catalogue's entries with source `{ kind: 'shrine', rarity }` (game-core `SHRINE_POOL`, in catalogue order): ten companions and five Shrine-only looks (A.19's palette variants of a banner, a crest and a hero appearance, and two CSS title colours). Shrine keepsakes come only from the Shrine. **Adding one:** append a catalogue entry with a `shrine` source and update the table above (the test fails until it matches); adding to a rarity lowers each of its keepsakes' chance, never another rarity's.

## Rules (game-core)
- **The draw** (`drawShrine(seed)`): `createRng('shrine:' + seed)`, one integer roll in `[0, 1000)` against the rarity weights (700 / 250 / 50), then one uniform pick within the rarity. Pure: the server stores the seed and anyone can replay a draw. `shrineOutcome(seed, owned)` adds the payout: `grant`, or `marks` with the rarity's duplicate marks.
- **The bank** (`shrineAccrual(through, unspent, today)`): days are UTC day numbers. Each day after `through` up to today adds one free draw while fewer than `SHRINE_BANK_LIMIT` (7) are unspent; `through` moves to today either way, so days a full bank sat through are never paid back later. A clock that goes back adds nothing. The bank starts the day before the account was made (`shrineBankStart`).
- **Spending** (`shrineSpendSource`): free daily draws first (so the bank makes room for tomorrow's), then play draws, then (later) shop draws.
- **The marks shop** (`shrinePurchaseProblem`): only pool keepsakes, each once, at its rarity's price.

## Server
- **Tables** (migration `0050`, additive): `shrine_accounts` (per account: `daily_through`, `marks`; the lock row), `shrine_draw_grants` (`source` `daily | play | shop`, `source_key` unique per account, `count`), `shrine_draws` (`spent_source`, `seed`, `cosmetic_id`, `rarity`, `outcome`, `marks`), `shrine_purchases` (once per account and cosmetic), and `cosmetic_displays.companion` (a composite foreign key to the account's own unlocks, like the banner). `DATA_MODEL.md`.
- **One at a time:** every Shrine read and write takes the account's `shrine_accounts` row `for update` first and accrues the bank in the same transaction, so draws, purchases and the day's accrual of one account never interleave (two tabs drawing at once spend two draws, never one twice).
- **Grants are exactly once:** a grant's `source_key` (`daily:<YYYY-MM-DD>`, `event:<n>:tier:<t>`, `achievement:<id>`, `season:<n>`) is unique per account and inserted with `on conflict do nothing`; only the insert that made the row writes `shrine.grant`. The play grants run in the transaction of what earned them: 6.6's `grantTiersTx` (event tiers), `awardAchievements` (live awards only; the achievement backfill pays no draws for old deeds) and `awardSeason` (season honours).
- **Draws:** a fresh 16-byte `crypto` seed per draw, stored with it; a new keepsake is granted through `grantCosmeticsTx` with source `shrine:draw:<draw id>`, a duplicate adds its marks. Audit `shrine.draw` (the seed, what it spent, drew and paid). A draw needs an `Idempotency-Key`: a replayed key returns the stored answer and pays nothing again.
- **The shop source:** `shop` is in the check constraints already; nothing grants it until ROADMAP 8.8's legal review (a paid random draw is a loot box under EU and German youth-protection rules). If the review says no, the shop sells marks or chosen keepsakes instead. The free daily draw and the play sources stay either way, so paying is never needed. `GET /api/account/shrine` says `paidDraws: false`.
- **Reconciliation** (`reconcileShrine(accountId)`): draws = grants + marks draws (each grant draw has its `shrine:draw:<id>` unlock); marks held = marks earned − marks spent; per source, draws spent ≤ draws granted; every stored seed replays to what it drew. `reconcileWithAudit` checks `shrine: draws granted`, `shrine: draws`, `shrine: duplicate marks` and `shrine: marks spent` against the rollups.
- **Test accounts** draw like anyone; their Shrine telemetry goes to `telemetry_daily_test` with the rest of their play (D.4), so the balance report never counts their draws.

## API
- `GET /api/account/shrine` → `{ unspent: { daily, play, shop }, draws, bankLimit, nextFreeAt, marks, paidDraws: false, rarities: [{ rarity, chance, duplicateMarks, price }], pool: [{ cosmeticId, kind, name, description, rarity, chance, price, owned }], recent: [{ id, cosmeticId, rarity, outcome, marks, spentSource, seed, drawnAt }] }`. Accrues the bank.
- `POST /api/account/shrine/draw` (Idempotency-Key) → `{ draw: { drawId, seed, spentSource, cosmeticId, rarity, outcome, marks }, shrine }`. `409 no_draws`.
- `POST /api/account/shrine/buy` `{ cosmeticId }` (Idempotency-Key) → `{ bought: { cosmeticId, price }, shrine }`. `409 already_owned`, `422 unknown_offer | insufficient_marks`.
- Companions: `POST /api/account/cosmetics/equip` `{ companion }` (an owned companion id or null); the collection's `equipped.companion`.
- Audit: `shrine.grant`, `shrine.draw`, `shrine.buy`, `cosmetic.grant` (source `shrine:draw:<id>` or `shrine:marks`), `cosmetic.equip`.

## Web
- The hub's Summoning Shrine hotspot opens `#/shrine` (the lit shrine `hub.shrine` when A.19's art is in; until then the square's own art). The Shrine screen: draws held (free and from play), the next free draw, marks, a **Draw** button with a short draw animation (the keepsake revealed, or the marks it turned into), the odds one click away, the marks shop, and the latest draws with their seeds.
- The collection book has a **Companions** filter; wearing one shows it beside the active hero in the area and crypt scenes. A companion's art is `companion.<name>` from the asset manifest (a two-frame idle); without it, a small plain wisp is drawn in code.

## Tests
- game-core `cosmetics/shrine.test.ts`: the pool (8–12 companions, every rarity filled), odds sum to 1 and are uniform within a rarity, the odds measured over 60,000 seeds, the replay, marks and prices, the shop's refusals at the price edge, the bank at its edges (new account, full bank, day boundary, a clock going back, days a full bank sat through), spending order, season draws.
- server `shrine/shrine.test.ts`: the published odds equal game-core's (this file's table), the bank across days and its limit, a replayed draw key pays once, no draws, play grants once (event tier, deed, season; the backfill pays none), duplicates to marks and the shop, companions equipped, reconciliation (`reconcileShrine` and `reconcileWithAudit`), test accounts' telemetry. `shrine.pg.test.ts` (real Postgres): two draws racing for the last draw, a draw racing a purchase.
- `phase8-no-pay-to-win.test.ts` (8.7): a worn companion and Shrine draws leave the hero's scores and defence identical; no power rule imports the Shrine.
- Journey: `playShrineStep` (after the collection step).

## Open points (owner)
- The pool, rarities, odds, duplicate marks and prices are a first pass (data in `shrine.ts` and the catalogue).
- Play draws count from the Shrine's opening: deeds, event tiers and seasons from before it pay no draws (the full bank of 7 on the first visit is the opening gift).
