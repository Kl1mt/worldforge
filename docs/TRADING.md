# Trading & item binding: the proposal (ticket 4.10)

**Status: proposed, awaiting the owner's sign-off.** Nothing here is built. Trading stays off in Phase 4. This document says what a later phase would build, and why, so the owner can decide in one message (see "Questions for the owner").

GDD §10.1 ("carefully controlled trading"), §16.3 (audit, rate limits and abuse controls for trading), §17 (the open decision). It builds on what exists: items and the Forge (`docs/LOOT.md`, `docs/EFFECTS.md`, `docs/ECONOMY.md`), the item row (`docs/DATA_MODEL.md`), the Warehouse (`docs/WAREHOUSE.md`), the safety layer (`docs/SOCIAL.md`), guilds and the guild boss (`docs/GUILD_BOSS.md`), community projects (`docs/COMMUNITY.md`) and telemetry (`docs/TELEMETRY.md`).

## The proposal in one page

| Question | Recommendation |
|---|---|
| Should players trade at all? | Yes, but small and social: a gift or swap between friends and guildmates, not a market. |
| What can be traded? | **Items only.** No gold, no materials. |
| Which items? | Epic, Legendary and set pieces that are **fresh** (never worn, never forged) and come from open-world drops or crafting. |
| Which items never? | Mythic, Void, boss-hoard drops, quest and contract rewards, anything worn or forged, anything already traded once. |
| How? | An **offer**: one player puts items on both sides, the other accepts or declines. Items wait in escrow. No live window, no mailbox, no guild bank, no auction house. |
| With whom? | A friend or guildmate of at least 7 days, both accounts eligible (14 days old, a hero at level 15, no active sanction). |
| How much? | Small weekly caps per account (e.g. 3 Legendary/set pieces received a week). |
| After a trade? | The item is bound to the new account (tradeable once), and held for 72 hours: it can be worn but not sold, salvaged, discarded or forged, so a moderator can still undo the trade. |
| Own heroes? | A **shared account shelf** in the Warehouse moves items between your own heroes. No gold or materials between heroes at first. |

The short reasoning: gold is what real-money sellers sell and what the economy's balance is measured in, so it stays out. Items are bounded by drop rates, carry their own id and history, and the Forge spend stays with whoever upgrades them. Making traded items "tradeable once" stops resale chains, which is what turns trading into a market and a laundering channel.

## Words used here

- **Account-bound:** the item belongs to your account. Any of your heroes can use it (through the shared shelf), nobody else can get it.
- **Tradeable:** the item may be offered to another player once. Today every item is effectively bound to its hero.
- **Bind on pickup:** account-bound the moment it drops. **Bind on equip:** tradeable until worn the first time, then account-bound.
- **Fresh:** never worn, never forged (no upgrade, reroll or improvement), not locked while offered.
- **Escrow:** while an offer is open its items sit with the offer, out of reach of selling, salvaging, the Forge and the Warehouse, like a stored item today.

## 1. Item binding

### Options

| Option | Good | Bad |
|---|---|---|
| A. Everything bound (no trading) | Nothing to abuse; the economy stays exactly as balanced in B.2. | Loses the social side: a Legendary for the wrong class or a duplicate set piece is just salvage. |
| B. Everything tradeable | Simplest to explain. | Turns every valuable drop into currency; real-money trading and alt funnelling become easy; best rolls concentrate in few hands. |
| C. **Tradeable by rarity, source and state** (recommended) | Trading is useful where it is social (duplicates, wrong class, gearing a friend) and closed where it is dangerous (chase items, boss loot, invested items). | More rules to show; the item tooltip must say clearly whether an item can be traded. |

### Recommendation: by rarity and variant

| Item | Binding | Why |
|---|---|---|
| Common, uncommon, rare | Account-bound | Worthless to trade (the merchant sells commons and uncommons; rares drop all the time) and not individually audited, so no provenance check is possible. |
| Epic | Bind on equip | Useful gearing help; individually audited at creation. |
| Legendary (not a set piece) | Bind on equip | The main social trade (an effect for another class or build). |
| Set piece | Bind on equip | Helps finish a set; B.2 shows sets compete with but don't beat Legendary builds, so faster sets don't hurt build diversity. |
| Mythic | Bind on pickup (account-bound) | Six named chase items; the rarest power in the game. Trading them would make them a currency. |
| Void (any rarity) | Bind on pickup (account-bound) | ~10 % of late-game Legendaries and Mythics: the long chase. Keep it earned. |

### By source

| Source | Binding | Why |
|---|---|---|
| Farming drops | As the rarity table | The open world; drop rates bound the supply. |
| Crypt chamber drops | As the rarity table | Same: every run drops them. |
| Boss hoards (Gravewarden, Ashen Warden) | Bind on pickup | Limited by a 20 h cooldown per hero; a second account would turn that into a hoard farm for a main. |
| Quest and contract rewards (incl. targeted Abbey contracts) | Bind on pickup | Personal rewards; targeted rewards are chosen loot. |
| Merchant purchases | Account-bound | Commons and uncommons only; nothing to gain. |
| Crafted at the Forge | As the rarity table (a crafted Epic is bind on equip) | Lets a crafter make gear for friends; crafting is still paid in full by the crafter (a sink). |
| Guild boss and community project rewards | Not items (gold, materials, achievements) | Nothing to bind. Achievements are account-bound already. |

### By state

| State | Effect | Why |
|---|---|---|
| Worn once | Becomes account-bound (bind on equip) | Stops "use it, then pass it on". |
| Any Forge work (upgrade, reroll, improve) | Becomes account-bound | An upgraded item holds up to ~25k gold of Forge spend per item (+5 → +10 at the Abbey). If it could be traded, it would carry gold to another account: the gold ban would leak through items. |
| Locked | Can't be offered (unlock first) | The lock means "keep this"; an extra click guards against offering the wrong item. |
| In the Warehouse | Must be taken out to offer | One place for escrow rules. |
| Traded once | Becomes account-bound for the receiver | No resale chains, no middlemen, laundering stops after one hop. |
| Items that exist before trading ships | Use the same rules, from their stored `source`, rarity, variant, upgrade and reroll counts | No special case. Worn status is not stored today, so items equipped before the launch count as fresh unless forged (accepted; low risk, see "Accepted risks"). |

## 2. What a trade may contain, and the format

### Contents

| Option | Good | Bad |
|---|---|---|
| Items only (recommended) | No currency to sell, no price discovery, no bypass of gold sinks. | Swaps must be item for item; a "fair" trade is the players' judgement. |
| Items + materials | Helps the tier-2 material gate B.2 found. | Materials stack without limit and are the easiest thing to funnel from alts; they gate Forge spend directly. |
| Items + gold | A real market. | Gold is what gold sellers sell; it bypasses every sink and makes B.2/B.3 balance per hero meaningless. |

**Recommendation: items only.** Revisit materials after B.3 has measured the social economy, as a guild-only option with a small cap.

### Format

| Option | Good | Bad |
|---|---|---|
| Live two-sided window | Familiar from other games. | Both must be online at once, which rarely happens in an idle game; needs sockets (Phase 4 polls). |
| **Asynchronous offer with escrow** (recommended) | Fits idle play; the offer can't change after sending, so no bait-and-switch; uses polling like guild chat. | Items are tied up until the other side answers (an expiry fixes that). |
| Mailbox | Async and simple. | One-sided by nature: the classic mule and gift-funnel tool; harder to make a swap atomic. |
| Guild bank | Social. | Shared ownership invites theft by officers and disputes the moderators must settle; members leave. |
| Auction house | Efficient. | Needs gold; a full market with RMT, bots and price manipulation. Not for a small invited group. |
| None at first | Safest. | Fine as the starting point; the shared shelf alone answers most "move my items" needs. |

**How an offer works** (recommended):
1. The sender picks a friend or guildmate, picks up to 6 of their own tradeable items, and may ask for up to 6 tradeable items the receiver holds (an empty side is a gift).
2. A confirm screen shows every item in full (rarity, level, affixes, effect, set, binding) and says plainly "you get nothing back" for a gift. Sending moves the sender's items into escrow.
3. The offer is fixed: to change it, cancel and send a new one. It expires after 48 hours.
4. The receiver sees the same full view and accepts or declines. Accepting checks everything again (eligibility, caps, that every item still exists and is tradeable) and swaps both sides in one transaction, all or nothing. The receiver's items are taken from their pack at that moment.
5. Cancel, decline, expiry, a block, a sanction or a hero being deleted returns the escrowed items to the sender's pack (over capacity if needed, like valuable drops in B.2).
6. Offers carry **no free text**: nothing to filter, nothing to scam with in the game's own voice.

## 3. Moving items between your own heroes

Ticket 4.7 said no transfers because there was no binding rule yet. With binding decided:

| Option | Good | Bad |
|---|---|---|
| No transfers (today) | Simplest. | A Legendary for the other class is salvage; the GDD lists shared storage as account progression (§5.3). |
| **A shared account shelf in the Warehouse** (recommended) | One place, reuses the Warehouse's "marker on the item row" design; account-bound items can finally reach your other hero. | A second hero's boss and contract loot can now feed the main (already true of its gold being spendable on itself; see below). |
| Account shelf plus gold and materials | Convenient. | Each hero's purse is the unit B.2 balanced the sinks for; moving gold lets an alt fund a main's Forge. |

**Recommendation:** a shared shelf (e.g. 20 places, opened with the Warehouse, upgradable later as a sink) for **items of every binding**, Mythic and Void included: they are account-bound, not hero-bound. **No gold or materials between heroes** at first; B.3's numbers decide later. Moving to the shelf is not a trade: it doesn't count against trade caps or bind a tradeable item, and it never crosses accounts. Accounts have two hero slots (GDD §5.3), so the alt-feeding effect is bounded; boss cooldowns are already per hero (Phase 2 accepted risk).

## 4. Anti-abuse rules

### Eligibility (both sides, checked at send and at accept)

| Rule | Proposed value | Defeats |
|---|---|---|
| Account age | ≥ 14 days | Fresh mule and bot accounts. |
| Progress | A hero at level 15 or higher (≈ 20–30 game hours) | Throwaway accounts made to feed a main. |
| Relation | Friends (accepted ≥ 7 days ago) or guildmates (joined ≥ 7 days ago) | Stranger scams, gold-seller spam, fresh funnel pairs. |
| Standing | No active mute, suspension or trade restriction | Sanctioned players moving items out of reach. |
| Block | No block either way | Contact the other player said no to. |
| Feature switch | Server setting, off by default | The owner turns it on when ready, and off at once if something goes wrong. |

### Per-account limits (exact under races, like the friend caps)

| Limit | Proposed value |
|---|---|
| Open offers sent | 3 |
| Open offers received | 10 |
| Items per side of one offer | 6 |
| Completed trades per day | 5 |
| Items received per week | 3 Legendary or set pieces, 10 Epics |
| Items given per week | the same caps |
| Trade rate-limit class | e.g. 20 trade writes a minute, tighter than social writes, on top of 3.9's limits |

### Cooldowns

- **72-hour hold on traded items:** the new owner can wear them but not sell, salvage, discard or forge them, and can't put them in the shared shelf, until the hold ends. This keeps a trade reversible and stops "trade, then turn into gold" laundering.
- **No re-trading:** a traded item is account-bound from then on (stronger than any cooldown).
- **Relation age** (7 days, above) is the cooldown on new pairs.

### Value caps

Gold isn't traded, so value is counted in items, by rarity: the weekly caps above are the value cap. There is no "fair trade" check: gifts between friends are allowed, and fairness can't be judged by the server (the sell price says nothing about how good a Legendary roll is). The caps keep one-sided flows small; the pattern report (below) surfaces them.

### Full audit

- Every step is an audit row: `trade.offer`, `trade.cancel`, `trade.decline`, `trade.expire`, `trade.accept`, `trade.void` (cancelled by a block, sanction or deletion), `trade.reverse`, plus `shelf.deposit` / `shelf.withdraw`.
- Each row carries a full snapshot of every item (id, base, rarity, level, affixes, effect, set, variant, upgrade, source, previous and new owner).
- **Provenance:** an item may be offered only if its creation is in the audit log (farming settlement already lists every Epic and better drop by id; T.1 makes sure every tradeable source, crypt chambers and crafting included, records the item id, and backfills what it can). An item without one is refused and flagged: that is where a duplicated item would show.
- The item keeps its id across the trade, so its whole life (drop → offer → accept → reversal) is one search.
- Telemetry (no personal data): `trade.complete` (gift or swap), `trade.items` by rarity, `item.fate traded`, `shelf.move`; `reconcileWithAudit` compares them with the audit log.

### Moderator reversal and its limits

- A moderator or admin can reverse a trade within **14 days**, with a reason, from the trade's case (report or pattern flag).
- A reversal moves **every** item back to where it came from, or nothing. It is possible only while every item still exists and is untouched; the 72-hour hold guarantees this for at least three days.
- A reversal never creates an item or gold. If an item is gone (salvaged after the hold, for example), the trade can't be reversed: the moderator sanctions instead.
- Both players see the reversal and its reason. Every reversal is audited; nobody reverses their own trades.

### What blocks and sanctions do

| Event | Effect |
|---|---|
| A block (either way) | Open offers between the two are voided (items back); no new offers; the blocked player is invisible in the trade picker. |
| Mute | Can't send or accept offers (trading reaches someone); can still cancel and decline. |
| Suspension | All open offers voided at once; nothing else changes. |
| New sanction kind: **trade restriction** (4.1 extension) | Only trading is off (offers voided); play and chat continue. The usual reason, expiry and audit. |
| Leaving a guild | Offers that relied on the guild relation are voided. |

## 5. The attacks it must defeat

| Attack | How it works | Defence | Prevented or only detected? |
|---|---|---|---|
| Real-money trading / gold selling | Sell in-game value for real money. | No gold in trades. Weekly caps, tradeable once (a buyer can't resell), friends/guild only, Mythic/Void/hoards bound. Legal pages forbid it. | **Gold selling: prevented. Selling an item for money paid outside the game: only detected** (payment happens elsewhere); the caps make it small. |
| Multi-account funnelling | Alts farm and gift to a main. | Account age, level 15, 7-day relation, weekly caps, boss loot bound, Forge spend bound. Pattern report: one-directional flows, pairs that only trade with each other. | **Only detected**: one person with two accounts looks like two friends. Limits make it slow and small. |
| Funnelling with invite codes | One multi-use invite brings in a cluster of accounts that feed one. | Only admins create codes (D.2); the admin panel shows which invite each account used; the pattern report groups trades by invite. Open registration would need stricter eligibility. | Only detected. |
| Bait-and-switch | Change the offer just before the other side accepts. | Offers can't change; accept checks the exact items. | Prevented. |
| Look-alike items | Pass off a weaker item as a famous one. | Full item view with rarity colour, affixes, effect and binding on both screens; Mythics and Void aren't tradeable at all. | Prevented in the game; persuasion is a player's choice. |
| "Trust trade" / "you first" | Ask for a gift with a promise to give something back. | Swaps are atomic, so nobody ever needs to go first; gifts say "you get nothing back". | Prevented technically; social persuasion only detected (reports). |
| Staff impersonation | "I'm a moderator, give me your item to check it." | Reserved names (4.1); staff never ask for items (said in the UI); no free text in offers. | Mostly prevented; off-game contact only detected. |
| Account theft | Log into someone's account and gift everything away. | Weekly caps limit the damage; 72-hour hold plus reversal undo it. (Login throttling per account and email verification are open carry-overs; worth doing before trading.) | Limited and reversible. |
| Laundering duplicated items | A duped item is traded on so it looks clean. | Provenance check (creation audit row), one hop only, hold plus reversal, items keep their id. | Detected and refused at the trade; a dupe itself is a bug the exploit review must find. |
| Bots | Scripts farm and feed trades. | Farming is server-simulated and capped (an idle game gives a bot little); rate limits; eligibility; caps. | Only detected (patterns, rate-limit hits). |
| Race exploits | Accept twice, accept while selling the item, etc. | Locks in a fixed order, escrow marker, all-or-nothing transaction, `Idempotency-Key`; real-Postgres race tests. | Prevented (and tested). |

## 6. Economy impact

- **Gold sinks:** untouched. No gold moves, the Forge spend stays bound to the item, and the Warehouse, guild and community sinks are per hero or per account as before. The only loss is a few merchant sales of items that are traded instead (sell prices are tiny).
- **B.2/B.3 balance:** each hero's purse stays the balance unit. New inflow per account is at most the weekly caps (3 Legendary/set pieces, 10 Epics); B.3's realistic player finds more than that by drops in the late game, so trading tops up rather than replaces farming. Telemetry should show traded items as a share of dropped ones; a target of "under 10 % of Legendary/set items in use came from trades" is a reasonable alarm.
- **Build diversity:** the risk is that trading lets everyone get the best-rolled effect for the meta build. Mitigations: caps, one hop, bind on equip, Mythic/Void bound, and effects already count once with caps (B.2). B.2's build-diversity test is about which builds can compete, which trading doesn't change; B.3 or the trading phase should add a check on the worn-effect distribution.
- **Possibly better:** fewer good items salvaged for want of the right class; set completion becomes social; crafters get a role.

## 7. What can't be prevented, only detected

- One person with two accounts (no IP or device tracking: the privacy rule stands).
- Real money paid outside the game for a gift.
- Persuasion and promises made outside the game.
- Account sharing or account sale.

These are why the caps are small and why the trading phase includes a **pattern report** for the owner (a command like `report:telemetry`): one-directional flows, pairs that only trade with each other, clusters by invite code, accounts at the cap every week, items reversed. A flag opens a moderator case; it never sanctions on its own.

## Accepted risks (if signed off as proposed)

- Items equipped before the launch aren't known to have been worn, so they count as fresh unless forged. Low risk: their owners mostly forged their best gear, and caps apply.
- A trade restriction or reversal can't recover an item salvaged after the hold.
- Two accounts of one person can always gift within the caps.
- Rate limits and caps live in one API instance's memory or in the database; a scaled deployment needs a shared store (as for 3.9's limits).

## Questions for the owner

Answer with the numbers and a letter each (for example "1a 2a 3a …"), or "all as recommended".

1. **Trading at all in the next phase?** (a) Yes, small and social as proposed, behind a server switch that starts off; (b) only the shared shelf for your own heroes, no player trading yet; (c) nothing. **Recommended: (a).**
2. **What may a trade contain?** (a) Items only; (b) items and materials; (c) items, materials and gold. **Recommended: (a).**
3. **Which items are tradeable?** (a) Fresh Epic, Legendary and set pieces from farming, crypt chambers and crafting; Mythic, Void, boss hoards and quest/contract rewards always bound; (b) the same plus Mythic and Void; (c) Legendary and set pieces only. **Recommended: (a).**
4. **Format?** (a) Asynchronous offer with escrow (fixed once sent, 48 h expiry, no text); (b) live trade window; (c) mailbox. **Recommended: (a).**
5. **With whom?** (a) Friends or guildmates of at least 7 days; (b) any eligible player. **Recommended: (a).**
6. **Eligibility?** (a) Account ≥ 14 days, a hero at level 15, no active sanction; (b) stricter: 30 days and level 20; (c) looser: 7 days and level 10. **Recommended: (a).**
7. **Weekly caps per account?** (a) Receive and give at most 3 Legendary/set pieces and 10 Epics a week, 5 trades a day, 6 items per side; (b) half of that; (c) no weekly caps, only rate limits. **Recommended: (a).**
8. **Your own heroes?** (a) A shared account shelf in the Warehouse for items only; (b) the shelf plus materials; (c) the shelf plus materials and gold; (d) no transfers. **Recommended: (a).**
9. **Reversal and sanctions?** (a) A 72-hour hold on traded items, moderator reversal within 14 days (all or nothing, never creating items), a new "trade restriction" sanction, mutes and suspensions also stop trading; (b) the same without reversal (sanctions only). **Recommended: (a).**

## Ticket outline for the phase that builds it

Not part of `docs/ROADMAP.md`; the owner places it after sign-off. Ground rules from Phases 1–4 apply (vertical slices, invariance tests, real-Postgres races from the ticket that adds a lock, `Idempotency-Key` on every value route, the migration rule, nothing secret from public ids, permission matrices, extend the journey).

Before it: per-account login throttling and email verification (open carry-overs since 1.2), because account theft is the worst case for trading.

| Order | Ticket | Content | Migration |
|---|---|---|---|
| T.1 | Item binding & provenance | game-core `itemBinding(item)` as a data table (rarity, variant, source, state → account-bound / bind on equip / tradeable); item columns for the binding, the bound account, `traded_count`, `hold_until`, first-equipped; equip and Forge work set the binding; tooltips show it; backfill for existing rows from their stored fields. No trading yet. | Additive item columns + backfill (`data_backfills`, like 4.2). |
| T.2 | Shared account shelf | Warehouse account tab (marker on the item row, like 4.7), deposit from one hero, withdraw to another, capacity and upgrade (sink). | Account shelf column(s) on items, capacity on accounts. |
| T.3 | Trade rules, eligibility & sanctions | game-core permission matrix (relation × standing × action), caps and limits, the `trade` rate-limit class, the trade-restriction sanction (4.1 queue), the server switch. | Sanction kind; caps table if needed. |
| T.4 | Trade offers (vertical) | Send, cancel, decline, accept, expire; escrow marker; all-or-nothing swap; audit and telemetry; polling inbox; the full-item confirm screens with loading, empty, error and success states. | `trade_offers`, `trade_offer_items`; escrow column on items. |
| T.5 | Moderation & reversal | Trade history in the admin panel and the moderator case view, reversal (all or nothing), report a trade, the pattern report command. | None or an index. |
| T.6 | Hardening, exploit review & balance | Exploit review of T.1–T.5, extended journey with three players, a balance check of traded share and worn-effect diversity (B.3's telemetry). | None. |

### Test strategy

- **Real-Postgres races** (three rounds, varied orders, assert only what holds in every order, no retries): two accepts of one offer; accept vs cancel, decline, expiry, a block and a suspension; one item in two offers; accept racing a sell, salvage, discard, Forge action, deposit, equip and settle of an item on either side; both players accepting offers to each other at once (lock order: both accounts in id order, then heroes, then items); caps at the boundary (the 4th Legendary in a week); reversal vs use of the item when the hold ends.
- **Value reconciliation:** across all accounts, items in = items out (a trade creates and destroys nothing); every item's owner equals a replay of its audit rows; telemetry `trade.*` matches the audit log (`reconcileWithAudit`); the e2e holdings check runs across the trading players.
- **Invariance:** with trading switched off, or with no trades, every existing test, hash and exit run is unchanged; a traded item's Forge stream behaves exactly as it would have for the first owner (secret never sent).
- **Permission matrices:** every relation (stranger, friend < 7 days, friend, guildmate, blocked either way) × standing (eligible, too new, too low, muted, suspended, trade-restricted) × action, through the API.
- **The exploit review (T.6):** client-trusted values (item ids, counts, a forged "fresh" flag), ownership (`404` for foreign items and offers), provenance refusals, replays and expired keys, caps across day/week boundaries (window rule: the transaction's clock), deleted heroes and accounts with open offers, and a red-team pass over the attack table above.
