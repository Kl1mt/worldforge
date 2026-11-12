# Guild halls & the guild treasury (ticket 8.4)

GDD §12, §13 (cosmetics never grant power); Phase 8 defaults in `ROADMAP.md` ("guild halls with cosmetic upgrades; no guild-vs-guild combat"). A guild's members fund a shared **treasury** with gold and materials; the leader and officers spend it on **cosmetic upgrades** for the guild's hall. **No stats, no drop odds, no power.** The guild season ranking and its honours are in `LEADERBOARDS.md` "Guild seasons".

Code: game-core `guild-halls/` (`GUILD_HALL_UPGRADES`, prices, `treasuryCap`, `treasuryRoom`, `planTreasuryGift`, `guildHallDecision`, `TREASURY_NO_REFUND_NOTICE`); server `apps/server/src/guild-halls/` (`model.ts` treasury rows, gifts, the disband forfeit; `routes.ts`); web `screens/TreasuryScreen.tsx` (`#/treasury`, "The treasury & the hall"), `social/HallLook.tsx` (how the looks are drawn), the Guild Hall's banner (`GuildScreen.tsx`). Tables in `DATA_MODEL.md`, routes in `API_CONVENTIONS.md`, telemetry in `TELEMETRY.md`. Screenshots: `node tools/screenshots/guild-hall.mjs` (a dev server on a scratch database).

## For players
- Open **The treasury & the hall** from your Guild Hall. Every member may give gold or materials from any of their heroes; the leader and officers buy the hall's looks and hang them.
- **Gifts are never given back** — not if you leave the guild, are removed from it, or the guild is disbanded; a disbanded guild's treasury is lost. The treasury says so above the form, and every gift needs the box "I understand this gift is never given back" ticked (the server refuses a gift without it: `422 no_refund_unacknowledged`).
- **A daily share:** no one gives more than a tenth of the whole hall's price in any one thing per day (UTC). Anything above it, or above what the hall still needs, stays with your hero.
- What the hall shows: on the guild's page (its banner takes the hall's light, the crest its frame, the name its colour) and on the Guild Roll. Anyone who may see the guild sees its look.

## The upgrades (data, `GUILD_HALL_UPGRADES`)

| Id | Kind | Price | Drawn with |
|---|---|---|---|
| `hall-banner.iron-drapes` Ironbound drapes | hall banner | 8,000 gold · 80 iron ore | the crypt-seal banner art, greyed |
| `hall-banner.ember-hangings` Ember hangings | hall banner | 20,000 gold · 150 iron ore · 40 soul shards | the ember standard on crimson cloth |
| `hall-banner.pale-silks` Pale silks of the Reach | hall banner | 45,000 gold · 120 soul shards · 30 Abbey silver | the Forgeward banner, bleached |
| `crest-frame.iron-rim` Iron rim | crest frame | 6,000 gold · 60 iron ore | the iron crest frame |
| `crest-frame.bone-ring` Bone ring | crest frame | 18,000 gold · 80 soul shards | the bone crest frame |
| `crest-frame.gilt-wreath` Gilt wreath | crest frame | 50,000 gold · 40 Abbey silver | the gilt crest frame |
| `backdrop.hearth-glow` Hearth glow | hall light | 10,000 gold · 120 timber | CSS tint |
| `backdrop.moonlit-stone` Moonlit stone | hall light | 15,000 gold · 100 raw hide | CSS tint |
| `backdrop.hollow-lantern` Hollow lantern-light | hall light | 30,000 gold · 150 soul shards | CSS tint (a slow flicker, off with reduced motion) |
| `guild-colour.forge-gold` / `grave-green` / `blood-wine` | name colour | 12,000 gold each | CSS colour |

The whole hall: **238,000 gold**, 120 timber, 100 raw hide, 290 iron ore, 390 soul shards, 70 Abbey silver. No new PixelLab art: banners and frames reuse A.13's sprites with CSS filters (`social/hall-look.css`, classes scoped `gh-`); without art, a plain cloth or a plain rim. Each upgrade is bought once per guild; one of each kind is shown (or none). Never rename or reuse an id.

**Cosmetic only.** An upgrade has an id, a kind, words and a price, nothing else (a test checks every entry's keys); nothing in the rules imports `guild-halls/` (the import scan in `guild-seasons.test.ts`); giving, buying and hanging leave every 5.1 score and the hero row unchanged except for what was given (`guild-halls.test.ts` "invariance", the journey).

## The treasury
- `guild_treasuries` holds gold and materials; it changes only under the **guild's lock** (`lockGuild`, the lock every membership change takes).
- **Gifts** (`POST /api/guild/hall/contribute`, `Idempotency-Key`, a social write `guildTreasury` that a mute does not block): lock order account (share, sanctions) → hero (`lockOwnedCharacter`, its farming settles first) → guild lock (membership re-read under it) → treasury row. The offer must be held in full (`422 insufficient_gold|insufficient_materials`). game-core `planTreasuryGift` takes per resource the least of the offer, what the hall still needs (**no over-fill**: the price of the upgrades not bought yet, less what the treasury holds) and what the account may still give today (**the cap**); the rest stays with the hero (`limited: { gold: 'cap' | 'room' }`). Nothing taken: `409 treasury_capped` with `resetsAt`. In one transaction: the hero pays, the treasury grows, the account's window row (`guild_treasury_gifts`) grows, `guild.treasury_contribute` is audited and telemetry recorded.
- **The anti-monopoly cap** (B.3's model, a share of a fixed total per account and UTC day, the window rule): `GUILD_TREASURY_CONFIG.capShare` = **10 %** of the whole hall's price in each resource: 23,800 gold, 12 timber, 10 raw hide, 29 iron ore, 39 soul shards, 7 Abbey silver a day. **One member alone needs at least ten days to fund the hall; ten members can do it in one.** B.3's growing cap is not used: there is no deadline to protect a small town from (an unbought look waits harmlessly). Several heroes of one account share the cap exactly (real-PG race).
- **Buying** (`POST /api/guild/hall/buy`, leader or officer): under the guild lock, refused when owned (`409 already_owned`) or not affordable (`409 treasury_short`); the price leaves the treasury, `guild_hall_upgrades` records it, `guild.hall_buy` audited. **Hanging** (`POST /api/guild/hall/display`, leader or officer): one bought upgrade per kind or null (composite foreign keys keep it to the guild's own upgrades), `guild.hall_display` audited.

### Roles (game-core `guildHallDecision`, tested through the API)
| Action ↓ / standing → | leader | officer | member | not a member |
|---|---|---|---|---|
| view the hall | ✓ | ✓ | ✓ | 404 not_in_guild |
| give to the treasury | ✓ | ✓ | ✓ | 404 |
| buy an upgrade | ✓ | ✓ | 403 guild_forbidden | 404 |
| hang an upgrade | ✓ | ✓ | 403 | 404 |

Account roles (moderator, admin) stay CLI-only and play no part here.

### Leaving, kicks and disbanding
- **Leave or kick:** nothing moves. The member's gifts stay in the treasury and are never refunded; their window rows stay with the guild. (Tested: the hero's gold is unchanged after leaving and after a kick.)
- **Disband** (the leader's or a moderator's, `disbandGuildTx`): the treasury is **forfeit** in the disband's transaction: set to nothing, audited `guild.treasury_forfeit` (gold, materials, `byModerator`), counted `guild_treasury.forfeit`. Gifts racing a disband land wholly before it (and are forfeit) or are refused (`404`, no longer a member) — real-PG race, reconciled in every order.

### Test accounts (D.4)
A test account gives to, buys for and (ticket 8.7) chooses the display of only a guild made entirely of test accounts (`403 test_account`, read under the guild lock), and a real account may not join such a guild (`403 test_guild`, `docs/GUILD_BOSS.md`). A guild of test accounts may use every hall feature for testing; it never appears on the Guild Roll (its members never count).

## Reconciliation and telemetry
`report:telemetry --reconcile` (`reconcileWithAudit`) checks: gifts, gold given (`gold.out guild_treasury` and the counter), materials given (`material.out guild_treasury`), upgrades bought and the treasury gold they spent (`guild_hall.buy`), forfeits, and the holdings: **gold and materials held in all treasuries = gifts − buys − forfeits** in the audit log. The treasury is a sink at the moment of the gift (the gold leaves the economy then; a buy moves nothing out of a hero).

## Tests
game-core `guild-halls/guild-halls.test.ts` (catalogue keys, pinned prices and caps, the plan, ten days for one account, the matrix); server `guild-halls/guild-halls.test.ts` (matrix through the API, the acknowledgement, caps and the new day, buying and hanging, no over-fill, leave and kick, the disband forfeit, test accounts, idempotent replay, reconciliation, invariance), `guild-seasons/guild-seasons.pg.test.ts` (heroes racing the cap, gifts racing a disband); the journey step `playGuildHallStep` (`guild-hall-journey.test.ts`); web `screens/guild-hall.test.tsx`.
