# Cosmetics and the collection book (ticket 6.8)

GDD §13; Phase 6 ground rules in `ROADMAP.md` (**cosmetics never grant power**; owner decision 2026-11-11: a cosmetic shop selling cosmetics for real money may come later, cosmetics only, see ROADMAP 8.8). The collection book holds every cosmetic in Graumark: those an account owns and those still to earn, each with how it is earned, a preview on the hero and equip. Cosmetics change how a player is seen, never a number in the game.

Code: game-core `packages/game-core/src/cosmetics/` (catalogue, sources, earning rules, equip rule, tests); server `apps/server/src/cosmetics/` (`grant.ts` the only writer of unlocks besides 6.6's event track, `backfill.ts`, `display.ts`, `routes.ts`); web `apps/web/src/cosmetics/` (API, store, words, display pieces), `screens/CollectionScreen.tsx` (`#/collection`), `content/appearance.ts` (A.13's art and fallbacks), `components/paletteSwap.ts` (palettes drawn in code), `admin/PalettePreview.tsx` (the animation gallery's Palettes table). Art: A.13 (`content/palettes.ts`, `/assets/banners/`, `/assets/crests/`, contact sheet `art/preview-cosmetics.png`). Screenshots: `node tools/screenshots/cosmetics.mjs` (a dev server on a scratch database).

## For players
- Open **Collection book** from the bar at the bottom. Filter by kind (appearances, banners, crests, title colours, titles) and by earned or still to earn. Every page says how it is earned.
- **Try it on:** the mirror shows the chosen hero with the page's look, banner, crest and title colour, owned or not.
- **Wear it:** an appearance is chosen per hero; the banner style, crest style and title colour are for the whole account; a title is the one title shown (also under your profile → Season honours).
- The keepsakes in the book today are earned in play, bound to the account and never traded. A shop selling cosmetics for real money may come later (ROADMAP 8.8); it sells looks only, never power. What was earned before the book opened is already in it.
- **Ticket 6.11:** five more come from the Forge's **Seal and Silver Counter**, traded for Gravewarden's Seals and Abbey silver earned in play (each once per account). The Forge's **Engraver** cuts words into gear (below).

## The catalogue (game-core `COSMETICS`)
Each entry: `id` (`<kind>.<name>`, stored in `cosmetic_unlocks`, never renamed or reused), `kind`, `name`, `description` and one `source`. No price, no numbers (a test checks every entry's keys); an `exchange` entry's price lives in `cosmetics/exchange.ts`.

| Id | Kind | Source |
|---|---|---|
| `appearance.default` | appearance | default (every hero; never stored) |
| `appearance.grave-moss` | appearance | deed: Gravewarden slain (`gravewardenSlain`) |
| `appearance.ashen` | appearance | milestone: a hero reaches level 40 |
| `appearance.ember` | appearance | milestone: the Forge Tyrant slain |
| `appearance.midnight` | appearance | milestone: the Nameless Crypt cleared on Heroic (tier IV) |
| `banner.harvest-sheaf` | banner | event: Harvest of Bones, tier 1 (6.6) |
| `banner.crypt-seal` | banner | deed: the crypt's Legendary tier cleared (`cryptTier3`) |
| `banner.warden-flame` | banner | milestone: the Ashen Warden slain |
| `banner.ember-standard` | banner | deed: helped clear the Ashen Pass (`ashenPassBreaker`) |
| `banner.forgeward` | banner | deed: helped rebuild the Forgeward Outpost (`forgewardBuilder`, 6.7) |
| `banner.season-laurel` | banner | season: any honour (Veteran or better) |
| `crest.iron` | crest | deed: ten contracts (`contracts10`) |
| `crest.bone` | crest | deed: the guild boss laid to rest (`guildBossLaidToRest`) |
| `crest.ember` | crest | deed: an item at +10 (`forgePlus10`) |
| `crest.gilt` | crest | season: an Exalted honour or better |
| `title-colour.bone-white` | title colour | event: Harvest of Bones, tier 2 (6.6) |
| `title-colour.ember` | title colour | deed: a Legendary found (`firstLegendary`) |
| `title-colour.verdigris` | title colour | deed: fifty contracts (`contracts50`) |
| `title-colour.royal` | title colour | season: a Champion honour |
| `title.reaper-of-the-harvest` | title | event: Harvest of Bones, tier 3 (6.6) |
| `title-colour.seal-wax` | title colour | exchange: 3 Seals (6.11) |
| `title-colour.abbey-silver` | title colour | exchange: 25 Abbey silver (6.11) |
| `banner.silvered-seal` | banner | exchange: 2 Seals + 20 Abbey silver (6.11; the crypt-seal art, silvered) |
| `crest.abbey-silver` | crest | exchange: 30 Abbey silver (6.11; the iron crest art, silvered) |
| `crest.seal-wax` | crest | exchange: 4 Seals (6.11; the iron crest art in wax red) |

**Adding one:** append a definition with a source the server already grants (above), list its art for an art ticket, and add words if the source is new. The next deploy's backfill grants it to accounts that already earned it (the backfill id hashes every id and source).

## Granting: exactly once
`cosmetic_unlocks` has the primary key `(account_id, cosmetic_id)`. Every grant (`grantCosmeticsTx`) reads what the account owns, inserts the rest with `on conflict do nothing` and audits `cosmetic.grant` (cosmetic, kind, source) only for rows it inserted, so two heroes, a live grant and the backfill, or two backfills racing end with one row and one audit row (real-PG tests `cosmetics.pg.test.ts`). Grants run in the transaction of the source event:
- **deeds:** `awardAchievements` grants the cosmetics of the achievements it just awarded (every live award: settlements, crypt claims, quests, forge, merchant, equip, the guild boss, a community project's completion, and the achievement backfill). Source `achievement:<id>`.
- **milestones:** `refreshAchievements` (settlements that changed the level or brought drops, dungeon claims, quest turn-ins, forge, merchant, equip) checks the hero's level and progress flags. Source `milestone:<character id>`.
- **season honours:** `awardSeason`'s last transaction (with `awarded_at`) grants each account's season cosmetics by its best tier this season. Source `season:<n>`.
- **events:** 6.6's `grantTiersTx` (`event:<n>:tier:<t>`, audited `event.reward`).
- **admin progress tools (D.4b):** set progress, set level, grant XP and grant an item call `refreshAchievements` in their transaction, so deeds and milestones arrive at once with their normal sources; the tool's `admin.*` audit row lists them under `earned`. Clearing a flag or lowering a level takes nothing back.
Test accounts unlock like anyone (nothing is ranked); D.4's rules apply to everything they touch (counts, telemetry). Nothing a grant does touches a gameplay row.

## The exchange and engravings (ticket 6.11)
Sinks for the Gravewarden's Seals left over after awakening and for Abbey silver (prices and the economy: `docs/ECONOMY.md` "Seal and silver sinks"; the flow: `BALANCE.md` "6.11").
- **The exchange** (the Forge's "Seal and Silver Counter"): the catalogue's `exchange`-sourced entries, each with one price in Seals and/or Abbey silver (`COSMETIC_EXCHANGE`). Bought once per account by any hero, from that hero's spendable holdings. The grant is an ordinary one (`grantCosmeticsTx`, source `exchange:<character id>`, audited `cosmetic.grant`) made **before** paying in the same transaction: the unlock's primary key decides a race between two heroes (the loser `409 already_owned`, nothing paid; real-PG test `forge/seal-sinks.pg.test.ts`). The backfill grants nothing from this source. Nothing is taken back, and the entries are worn from the book like any other.
- **No new art.** The banner and the crests draw A.13's crypt-seal banner and iron crest (`content/appearance.ts` `ART_TINTS`) through a CSS filter on the art (`cosmetics.css`: silver drains the colour and lifts it, wax turns it dark red; the hero portrait's device too); the title colours are CSS like the others. Without art, the plain fallbacks in the style's metal (silver, wax red).
- **Engravings** (the Forge's "Engraver"): words from a fixed list of twelve (`ENGRAVINGS`; no free text, nothing to moderate) and a finish, **seal-wax** (2 Seals) or **silver inlay** (15 Abbey silver). Stored on the item as `<finish>:<id>` (`item_instances.engraving`, migration `0043_item_engraving`), shown in the item's tooltip ("Pressed in seal-wax “Unbowed”"), read by nothing else. Repeatable: a new engraving replaces the old and pays again; the same one twice is refused. It doesn't bind the item.
- **Invariance:** `cosmetics/exchange.ts` sits in the cosmetics module, so the import scan covers it; engraving an equipped item and buying every offer leave the hero's 5.1 scores identical (server test and journey).

## Backfill
`backfillCosmetics` (`migrate-cli`, after the achievement backfill; `docs/DEPLOY.md` "Data backfills"): for every account, one transaction each, the cosmetics of its achievements, its heroes' milestones and its season honours, sourced `backfill:…`. Once per database and catalogue (`data_backfills` id `cosmetics:<hash>`); a crash half-way leaves no row and the next run finishes (each grant is exactly once). **On live** at the first deploy: every account that already reached a source gets its cosmetics (e.g. every Forgeward contributor the Forgeward banner, every hero past level 40 the Ashen look), nothing is equipped for them, and the Harvest keepsakes they already had become wearable.

## Equip and display
- `cosmetic_displays` (per account: banner, crest, title colour; null = plain) and `hero_appearances` (per hero; no row = own colours). Composite foreign keys to `cosmetic_unlocks` mean only the account's own unlocks can be stored; the routes check first (`equipProblem`: unknown, wrong kind, not owned).
- **Shown:** `prestigeFor` returns `banner`, `crest` and `titleColour` with the title and frame, so boards, profiles, both guild rosters and the arena ladder carry them where they carry honours (a member the viewer blocks shows none). Rows: the crest as a small mark beside the frame mark, the title in its colour. Profile: the hero banners carry the banner style's device, the frame plate (or, without a frame, the crest style) holds the first hero, heroes in their appearance. The area and crypt scenes draw the active hero in its appearance (its frame sheet too); the duel screen draws both heroes in theirs.
- **Privacy (5.2):** a hero's appearance is shown where its name is (the profile when it may be viewed; in the arena when `canViewProfile` and the name is not hidden by a moderator), else the class's own colours. Account cosmetics follow the prestige display.
- **5.3 keeps working:** frames and titles as before; a title colour colours whichever title is shown (season or cosmetic); no colour leaves 5.3's look unchanged (tested).

## Art and fallbacks
Palettes are A.13's colour substitutions (`heroPaletteSwaps`), applied in the browser on a canvas (A.13's `recolourPixels`) once per sprite and look, cached; until it is drawn, without a canvas, or for an unknown look the hero wears its own colours. Banner styles (32×32) and crest-style frames (48×56 around a 40×48 window) are sprites; when one is missing or fails to load the book and the profile draw a plain banner and a plain rim in the style's metal (tested; screenshots with the art blocked). Title colours are CSS only (`cosm-tint--<name>`). The admin animation gallery's **Palettes** table shows every look on every class (portrait and frame sheet).

## Invariance
Nothing in game-core's rules imports `cosmetics/` (an import scan); the no-effects hashes are unchanged; equipping every cosmetic leaves a hero's 5.1 scores and its character row identical (server test and journey). Cosmetics are not items: no trade, mail, shelf or merchant route can carry one.

## API
- `GET /api/account/collection` → `{ entries: [{ id, kind, name, description, source, owned, grantedOn }], equipped: { banner, crest, titleColour, cosmeticTitle }, heroes: [{ id, name, classId, banner, palette }] }`.
- `POST /api/account/cosmetics/equip` `{ banner?, crest?, titleColour? }` (at least one; an owned id of that kind or null) → the collection. Needs `Idempotency-Key`. `422 not_owned | wrong_kind | unknown_cosmetic`.
- `POST /api/characters/:characterId/appearance` `{ appearance }` (owned appearance id, `appearance.default` or null) → the collection. Needs `Idempotency-Key`; `404` for a hero not the account's.
- Titles: `POST /api/account/prestige { title: null, frame, cosmeticTitle }` (5.3 / 6.6).
- Ticket 6.11: `GET /api/characters/:characterId/exchange` → `{ characterId, materials, offers: [{ cosmeticId, kind, name, description, price, owned, blockers }] }`; `POST /api/characters/:characterId/exchange` `{ cosmeticId }` (Idempotency-Key) → the same plus `bought`, `paid`. `409 already_owned`, `422 unknown_offer | insufficient_materials`. The engraver: `POST /api/characters/:characterId/forge/engrave` `{ itemId, finish: 'seal' | 'silver', engravingId }` (a Forge action; the Forge item view carries `engrave: { current, finishes }`). Audit `cosmetic.exchange`, `forge.engrave`.
- `GET /api/account/cosmetics` (6.6) still lists the unlocks.
- Audit: `cosmetic.grant`, `cosmetic.equip` (`scope: account|hero`).

## Tests
- game-core `cosmetics/cosmetics.test.ts`: ids, kinds and sources valid (achievements and events exist, A.13's ids all present), no price or stats, earning rules (achievements, milestones, season tiers), the equip rule.
- server `cosmetics/cosmetics.test.ts`: each source grants once (refreshes repeated), season honours by tier through `awardSeason`, the backfill (idempotent, forced re-run grants nothing, a crash then resume), equip validation (key required, owned only, kind, unknown, other account's hero, replay, partial changes, audit), the foreign keys, display privacy (rosters with a block, hidden profiles in the arena), invariance (scores and the row unchanged) and the import scan. `cosmetics.pg.test.ts` (real Postgres): heroes racing to the same milestones, live grants racing the backfill, two backfills.
- Journey: `playCollectionStep` (after the event step in `event-journey.test.ts`), then `playSealSinkStep` (6.11).
- Ticket 6.11: game-core `cosmetics/cosmetics.test.ts` (offers, prices, epithets, refusals), `balance/seal-flow.test.ts` (awakening's pace unchanged); server `forge/seal-sinks.test.ts` (prices, hold rule, exactly once, refusals, invariance, reconciliation, test accounts) and `seal-sinks.pg.test.ts`; web `screens/economy/seal-sinks.test.tsx`.
- web `cosmetics/cosmetics.test.tsx`: palettes for every look and class, own colours until drawn, banner and crest art and the plain fallbacks, title colours on season and cosmetic titles, the book's filters and what is worn, the words.

## Open points (owner)
- The mapping of each cosmetic to its source is a first pass (see the table); change any source by editing the catalogue (the backfill reruns, nothing granted is taken back).
- Guild crests: crest styles frame the account's crest mark and profile plate; a guild-wide crest style chosen by the leader could come later.
- Seasons grant by the best tier of the season; past seasons count through the backfill.
