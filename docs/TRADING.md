# Trading & item binding (ticket 4.10)

**Status: decided by the owner, 2026-11-07. T.1 (item binding & provenance), T.2 (trading settings in the admin panel), T.3 (the shared account shelf, off until its switches are turned on), T.4 (the trade rules, eligibility, caps and the trade-restriction sanction), T.5 (offers, escrow, the swap and the 72-hour hold), T.6 (moderation, reversal, reporting a trade and the pattern report) and T.7 (the exploit review, its fixes and the balance check) are built. Trading stays closed until the owner turns on the master switch.** This document is the rulebook for the later phase that builds it ("Ticket outline" at the end). The owner's answers are recorded under "The owner's decisions".

GDD §10.1 ("carefully controlled trading"), §16.3 (audit, rate limits and abuse controls for trading), §17. It builds on what exists: items and the Forge (`docs/LOOT.md`, `docs/EFFECTS.md`, `docs/ECONOMY.md`), the item row (`docs/DATA_MODEL.md`), the Warehouse (`docs/WAREHOUSE.md`), the safety layer (`docs/SOCIAL.md`), the admin panel (`docs/DEPLOY.md`, D.3), guilds and the guild boss (`docs/GUILD_BOSS.md`), community projects (`docs/COMMUNITY.md`) and telemetry (`docs/TELEMETRY.md`).

## The decision in one page

| Question | Decided |
|---|---|
| Should players trade at all? | Yes, small and social: gifts and swaps between friends and guildmates, not a market. Behind a master switch that starts **off**. |
| What can a trade contain? | **Items, materials and gold**, each switched on or off separately in the admin panel (all off at first). |
| Which items? | Fresh (never worn, never forged) Epic, Legendary, set pieces, **Mythic and Void**, from farming, crypt chambers and crafting. Each category has its own switch; Mythic and Void start off. |
| Which items never? | Boss-hoard drops, quest and contract rewards, anything worn or forged, anything already traded once. Guild boss and community rewards are not items. |
| How? | An **offer**: one player puts items, materials and gold on both sides, the other accepts or declines. Everything waits in escrow. No live window, no mailbox, no guild bank, no auction house. |
| With whom? | A friend or guildmate of at least 7 days; both accounts eligible (14 days old, a hero at level 15, no active sanction). |
| How much? | Weekly caps per account for items (by rarity, with a separate cap for Mythic/Void), gold and materials, all adjustable in the admin panel within hard limits. |
| After a trade? | A traded item is bound to the new account (tradeable once). Everything received is **held for 72 hours**: items can be worn but not sold, salvaged, discarded or forged; gold and materials can't be spent. A moderator can still undo the trade. |
| Own heroes? | A **shared account shelf** in the Warehouse moves items, materials and gold between your own heroes, each kind with its own switch. No caps, everything audited. |

## Words used here

- **Account-bound:** the item belongs to your account. Any of your heroes can use it (through the shared shelf), nobody else can get it.
- **Tradeable:** the item may be offered to another player once. Today every item is effectively bound to its hero.
- **Bind on pickup:** account-bound the moment it drops. **Bind on equip:** tradeable until worn the first time, then account-bound.
- **Fresh:** never worn, never forged (no upgrade, reroll or improvement), not locked while offered.
- **Escrow:** while an offer is open its contents sit with the offer, out of reach of selling, salvaging, spending, the Forge and the Warehouse, like a stored item today.
- **Held:** received in a trade less than 72 hours ago. Held gold and materials show on the hero but can't be spent.
- **Switch:** a setting the owner changes in the admin panel, without a deploy (see "Admin switches").

## The owner's decisions (2026-11-07)

The owner's answers to the nine questions, and what each means here:

| # | Question | Answer | Meaning |
|---|---|---|---|
| 1 | Trading at all? | 1a | Yes, small and social, behind a master switch that starts off. |
| 2 | What may a trade contain? | 2c, with an admin switch | Items, materials and gold, each switchable. |
| 3 | Which items are tradeable? | 3b, with an admin switch | Fresh Epic, Legendary, set, Mythic and Void items from open-world sources and crafting; each category switchable. |
| 4 | Format? | 4a | Asynchronous offer with escrow (fixed once sent, 48 h expiry, no text). |
| 5 | With whom? | 5a | Friends or guildmates of at least 7 days. |
| 6 | Eligibility? | 6a | Account ≥ 14 days, a hero at level 15, no active sanction. |
| 7 | Weekly caps? | 7a, keeping 3 in mind | 7a's limits, plus a Mythic/Void cap and gold and material caps (below), all adjustable. |
| 8 | Your own heroes? | 8c, with an admin switch | A shared account shelf for items, materials and gold, each switchable. |
| 9 | Reversal and sanctions? | 9a | 72-hour hold, moderator reversal within 14 days, a "trade restriction" sanction, mutes and suspensions stop trading. |

## Admin switches

All trading settings live in the **D.3 admin panel**, in a new "Trading settings" section. They are:
- **admin-only** (moderators see them read-only, players never);
- **stored on the server** in the database, not in environment variables, so a change takes effect within a minute, without a deploy;
- **audited**: every change writes a `settings.update` row (who, when, old value, new value) and shows in the panel's history;
- **bounded**: every number has a hard maximum in code, so a typo can't open the floodgates;
- **safe to switch off**: switching something off never traps anything a player owns (see the last column).

| Switch | What it controls | Default | When switched off |
|---|---|---|---|
| **Trading** (master) | Whether players can trade at all | Off | Every open offer is voided at once; everything in escrow goes back to its sender. |
| Trade: items | Items in offers | Off | Open offers containing an item can't be accepted and are voided; escrow back to the sender. |
| Trade: materials | Materials in offers | Off | Same, for offers containing materials. |
| Trade: gold | Gold in offers | Off | Same, for offers containing gold. |
| Tradeable: Epic | Fresh Epic items | On | Open offers with an Epic are voided; escrow back. The item stays tradeable for later. |
| Tradeable: Legendary | Fresh Legendary items (not set pieces) | On | Same. |
| Tradeable: set pieces | Fresh set pieces | On | Same. |
| Tradeable: Mythic | Fresh Mythic items | **Off** | Same. |
| Tradeable: Void | Fresh Void items (a Void set piece or Mythic needs this switch and its own) | **Off** | Same. |
| Tradeable: Prismatic (ticket 6.4) | Fresh Prismatic items (a Prismatic set piece or Mythic needs this switch and its own) | **Off** | Same. |
| Weekly limits (numbers) | Every cap in "Per-account limits" | The values there | Lowering a limit never voids an offer: an offer that would now go over the limit can't be accepted (the player is told why) and expires as usual. |
| Shelf: items | Moving items to and from the account shelf | Off | No new deposits; anything on the shelf can still be taken out to any hero. |
| Shelf: materials | Moving materials to and from the shelf | Off | Same. |
| Shelf: gold | Moving gold to and from the shelf | Off | Same. |

The category switches matter only once "Trading" and "Trade: items" are on. That's why Epic, Legendary and set pieces can start on: nothing is tradeable until the master switch is on. **Suggested launch order:** turn on Trading with items (Epic, Legendary, set) and the shelf for items; add materials and the shelf for materials after a few weeks of clean telemetry; add gold, Mythic and Void last, one at a time.

"Voided" means: the offer ends with a `trade.void` audit row naming the switch, the sender's items go back to their pack (over capacity if needed, like valuable drops in B.2), their gold and materials go back to the hero they came from, and both players see "This offer was withdrawn: trading of … is paused". Nothing is lost and nothing is held, because nothing changed hands.

## 1. Item binding

### Options considered

| Option | Good | Bad |
|---|---|---|
| A. Everything bound (no trading) | Nothing to abuse; the economy stays exactly as balanced in B.2. | Loses the social side. |
| B. Everything tradeable | Simplest to explain. | Turns every valuable drop into currency; boss loot and invested items become currency too. |
| C. **By rarity, source and state, with switches** (decided) | Trading is useful where it is social and closed where it is dangerous; the owner can open or close each category. | More rules to show; the tooltip must say whether an item can be traded right now. |

### By rarity and variant

| Item | Binding | Switch | Why |
|---|---|---|---|
| Common, uncommon, rare | Account-bound | — | Worthless to trade and not individually audited, so no provenance check is possible. |
| Epic | Bind on equip | Tradeable: Epic (on) | Useful gearing help. |
| Legendary (not a set piece) | Bind on equip | Tradeable: Legendary (on) | The main social trade (an effect for another class or build). |
| Set piece | Bind on equip | Tradeable: set pieces (on) | Helps finish a set; B.2 shows sets compete with but don't beat Legendary builds. |
| Mythic | Bind on equip | Tradeable: Mythic (**off**) | Six named chase items. Owner decision 3b: tradeable, but off at first, with its own weekly cap of one. |
| Void (on a Legendary, set piece or Mythic) | Bind on equip | Tradeable: Void (**off**) plus the item's own category | The long chase (~10 % of late-game Legendaries and Mythics). Same treatment as Mythic. |
| Prismatic (on a Legendary, set piece or Mythic; ticket 6.4) | Bind on equip | Tradeable: Prismatic (**off**) plus the item's own category | Rarer than Void (~4.5 % of Ashen-tier Legendaries and Mythics, never with Void). Same treatment as Void; its switch is separate, so Void opening never opens Prismatic. |

### By source

| Source | Binding | Why |
|---|---|---|
| Farming drops | As the rarity table | The open world; drop rates bound the supply. |
| Crypt chamber drops | As the rarity table | Same: every run drops them. |
| Boss hoards (Gravewarden, Ashen Warden, since 6.2 the Forge Tyrant: `hoard:tyrantsForge`) | Always bound (bind on pickup) | Limited by a 20 h cooldown per hero; a second account would turn that into a hoard farm for a main. |
| Quest and contract rewards (incl. targeted Abbey contracts) | Always bound | Personal rewards; targeted rewards are chosen loot. |
| Merchant purchases | Account-bound | Commons and uncommons only. |
| Crafted at the Forge | As the rarity table (a crafted Epic is bind on equip) | Lets a crafter make gear for friends; crafting is still paid in full by the crafter (a sink). |
| Guild boss and community project rewards | Not items | Their gold and materials join the hero's purse like any other (see "Materials" for the Gravewarden's seal). Achievements are account-bound. |

### By state

| State | Effect | Why |
|---|---|---|
| Worn once | Becomes account-bound | Stops "use it, then pass it on". |
| Any Forge work (upgrade, reroll, improve) | Becomes account-bound | An upgraded item holds up to ~25k gold of Forge spend (+5 → +10 at the Abbey). Trading it would move gold past the gold caps. |
| Locked | Can't be offered (unlock first) | The lock means "keep this". |
| In the Warehouse or on the shelf | Must be taken out to offer | One place for escrow rules. |
| Traded once | Account-bound for the receiver | No resale chains, no middlemen; laundering stops after one hop. |
| Items that exist before trading ships | Same rules, from their stored source, rarity, variant and Forge counts | Worn status isn't stored today, so items equipped before launch count as fresh unless forged (accepted risk). |

## 2. What a trade may contain, and the format

### Contents

Every offer may contain **items, materials and gold** on either side, each kind only while its switch is on.

| Kind | Rules |
|---|---|
| Items | Up to 6 per side; tradeable items only (above). |
| Materials | Any amount within the weekly caps, from the offering hero's stock. **Gravewarden's seals are never tradeable**: they are boss loot, like the hoards, and gate the Ashen Pass project. Nor are **Tyrant's Embers** (ticket 6.2): the Forge Tyrant's boss material, spent only on Tyrantforged Work. |
| Gold | Up to 5,000 per side per offer, within the weekly caps, from the offering hero's purse. |

Each side of an offer comes from **one hero**: the sender picks the hero whose items, materials and gold go in; the receiver picks the hero who answers. What arrives goes to that hero.

### Format (decided: asynchronous offer with escrow)

| Option | Why not (or why) |
|---|---|
| Live two-sided window | Both must be online at once, rare in an idle game; needs sockets. |
| **Asynchronous offer with escrow** | Fits idle play; the offer can't change after sending, so no bait-and-switch; polls like guild chat. |
| Mailbox | One-sided by nature: the classic mule and gift-funnel tool. |
| Guild bank | Shared ownership invites theft by officers and disputes. |
| Auction house | A full market with real-money trading, bots and price manipulation. |

**How an offer works:**
1. The sender picks a friend or guildmate and a hero, then puts in up to 6 tradeable items, materials and gold. They may also ask for up to 6 items, materials and gold from the receiver. An empty side is a gift.
2. A confirm screen shows every item in full (rarity, level, affixes, effect, set, variant, binding) and every amount. A gift says plainly "you get nothing back". Sending moves the sender's side into escrow.
3. The offer is fixed: to change it, cancel and send a new one. It expires after 48 hours.
4. The receiver sees the same full view and accepts or declines. Accepting checks everything again (switches, eligibility, caps, that every item still exists and is tradeable, that the receiver's hero holds what was asked) and swaps both sides in one transaction, all or nothing.
5. Cancel, decline, expiry, a switch turned off, a block, a sanction or a hero being deleted voids the offer and returns the escrow to the sender.
6. Offers carry **no free text**: nothing to filter, nothing to scam with in the game's own voice.

## 3. The shared account shelf (your own heroes)

Ticket 4.7 made the Warehouse per hero and said no transfers until binding was decided. Decided (8c): a **shared account shelf**, a second tab in the same Warehouse building.

| | Per-hero Warehouse (4.7) | Account shelf |
|---|---|---|
| Who uses it | One hero | Every hero of the account |
| What it holds | Items | Items (every binding, Mythic and Void included), materials, gold, each with its own switch |
| Opens | With the Warehouse (community project) | With the Warehouse, and only while its switch is on |
| Capacity | 30–120 places (upgrades, 4.7) | 20 item places to start, upgradeable later as a sink (B.3 sets the prices); materials and gold unlimited |
| Caps | None | **None**: moving value between your own heroes counts toward nothing |
| Audit | `warehouse.deposit` / `withdraw` | `shelf.deposit` / `shelf.withdraw` with the kind, amount, items and both heroes |

- An item on the shelf is the same item row (the 4.7 "marker, not a copy" design), out of reach of selling, salvaging and the Forge until taken out. A shelf item is never tradeable while on the shelf, and moving it doesn't bind it or count as a trade.
- Gold and materials on the shelf belong to the account, not a hero. Depositing takes them from a hero, withdrawing gives them to any hero of the account.
- **Held** value (received in a trade under 72 hours ago) can't go onto the shelf until the hold ends, so a reversal can always find it.
- When a shelf switch is turned off, deposits of that kind stop; withdrawals always work.
- **Balance note:** with gold and materials on, a second hero's boss loot, contracts and gold can feed the main. Accounts have two hero slots (GDD §5.3), so this at most doubles what one player earns, the same as playing both heroes. *(Measured in T.7: only one hero of an account farms at a time, so it doesn't double income; it pools what the alt earned. "T.7 as built".)* It also makes a second *account* less attractive, because one account already shares everything.

## 4. Anti-abuse rules

### Eligibility (both sides, checked at send and at accept)

| Rule | Value | Defeats |
|---|---|---|
| Switches | Trading on, and the switches for everything in the offer | The owner closes anything at once. |
| Account age | ≥ 14 days | Fresh mule and bot accounts. |
| Progress | A hero at level 15 or higher (≈ 20–30 game hours) | Throwaway accounts made to feed a main. |
| Relation | Friends (accepted ≥ 7 days ago) or guildmates (joined ≥ 7 days ago) | Stranger scams, gold-seller spam, fresh funnel pairs. |
| Standing | No active mute, suspension or trade restriction | Sanctioned players moving value out of reach. |
| Email | A verified email address (5.7's `isEmailVerified`, added in T.4) | Throwaway and stolen accounts. |
| Block | No block either way | Contact the other player said no to. |

### Per-account limits

Exact under races (like the friend caps), counted per account per **UTC week** (Monday 00:00 to Monday 00:00) and, for completed trades, per **UTC day**, for **given and received separately** (T.4 chose fixed windows over the rolling 7 days first written here: see "T.4 as built"). All numbers are admin settings with hard maxima.

| Limit | Default | Hard maximum |
|---|---|---|
| Open offers sent · received | 3 · 10 | 10 · 30 |
| Items per side of one offer | 6 | 12 |
| Completed trades per day | 5 | 20 |
| Legendary and set pieces per week | 3 | 10 |
| **Mythic, Void or Prismatic items per week** | **1** (and it also counts toward the 3 above) | 3 |
| Epic items per week | 10 | 30 |
| **Gold per offer** | **5,000** | 25,000 |
| **Gold per week** | **10,000** | 50,000 |
| **Common materials per week** (timber, ashwort, raw hide, iron ore, together) | **300 units** | 1,500 |
| **Soul shards per week** | **40** | 200 |
| **Abbey silver per week** | **10** | 50 |
| Trade rate-limit class | 20 trade writes a minute, on top of 3.9's limits (built in T.4) | — |

A Void Mythic counts once toward the Mythic/Void cap. Ticket 6.4: Prismatic items count toward it like Void (the setting keeps its key `mythicVoidPerWeek`, so stored settings need no migration; its label now reads "Mythic, Void or Prismatic items per week"), and a Prismatic Mythic counts once.

**Why these numbers** (`docs/ECONOMY.md`, B.2's realistic player, `docs/COMMUNITY.md`):
- **Gold:** a realistic Sunken Abbey hero earns ~1,650 gold an hour and has ~15 credited hours a day, so about 25k a day and 170k a week; Ashen Pass kits earn more. 10,000 a week is about **6 hours of Abbey income, ~6 % of a week's**. That is a real help for a friend (a few +5 upgrades, a warehouse step) and well below one item's +5 → +10 track (25k), so gold can't buy a finished build. It's also more than three times the guild boss's whole weekly purse (3,050), so it stays "help a friend", not a second income.
- **Common materials:** heroes gather 40–60 units of their area's materials an hour, so 300 units is about 5–8 hours of gathering: enough to unblock the tier-2 raw-hide gate B.2 found, not enough to skip gathering.
- **Soul shards:** 41 shards take one item through its whole upgrade track; the Ashen Pass gathers 3–5 an hour. 40 a week is about one item's track.
- **Abbey silver:** rare (0.8 % per cycle) and gates the Ashen Pass project; 10 a week is a gift, not a supply.

### Cooldowns

- **72-hour hold** on everything received: items can be worn but not sold, salvaged, discarded, forged, put in the Warehouse or put on the shelf; gold and materials show as "held" and can't be spent or shelved. This keeps every trade reversible and stops "trade, then cash out" laundering.
- **No re-trading:** a traded item is account-bound from then on. Received gold and materials, once the hold ends, are the hero's own and can be traded again within the caps (they have no identity).
- **Relation age** (7 days) is the cooldown on new pairs.

### Value caps

The weekly caps above are the value caps: items by rarity, gold and materials by amount. There is no "fair trade" check: gifts between friends are allowed, and the server can't judge how good a Legendary roll is. The caps keep one-sided flows small, and the pattern report shows them.

### Full audit

- Every step is an audit row: `trade.offer`, `trade.cancel`, `trade.decline`, `trade.expire`, `trade.accept`, `trade.void` (a block, sanction, deletion or switch), `trade.reverse`, `trade.release` (a hold ends), `shelf.deposit`, `shelf.withdraw`, `settings.update`.
- Each trade row carries a full snapshot of every item (id, base, rarity, level, affixes, effect, set, variant, upgrade, source, previous and new owner) and every gold and material amount with the hero's balance after.
- **Provenance:** an item may be offered only if its creation is in the audit log. Farming settlement already lists every Epic and better drop by id; ticket T.1 makes sure every tradeable source (crypt chambers and crafting included) records the item id, and backfills what it can. An item without a creation row is refused and flagged: that is where a duplicated item would show.
- An item keeps its id across the trade, so its whole life is one search.
- Telemetry (no personal data): `trade.complete` (gift or swap), `trade.items` by rarity and variant, `item.fate traded`, `gold.in trade` / `gold.out trade`, `material.in trade` / `material.out trade`, `shelf.move` by kind. `reconcileWithAudit` checks that trade gold and materials in equal out, and that every count matches the audit log.

### Moderator reversal and its limits

- A moderator or admin can reverse a trade within **14 days**, with a reason, from the trade's case (a report or a pattern flag).
- A reversal moves **everything** back (items, gold and materials, both sides), or nothing. It works only while all of it is still there: the items untouched, and the gold and materials still on the receiving hero. The 72-hour hold guarantees that for at least three days.
- A reversal never creates items, gold or materials. If something is gone (salvaged or spent after the hold), the trade can't be reversed: the moderator sanctions instead.
- Both players see the reversal and its reason. Every reversal is audited, and nobody reverses their own trades.

### What blocks and sanctions do

| Event | Effect |
|---|---|
| A block (either way) | Open offers between the two are voided; no new offers; the blocked player is invisible in the trade picker. |
| Mute | Can't send or accept offers; can still cancel and decline. The shelf still works (it reaches no one). |
| Suspension | All open offers voided at once. |
| **Trade restriction** (new sanction kind, 4.1 queue) | Only trading is off (offers voided); play, chat and the shelf continue. The usual reason, expiry and audit. |
| Leaving a guild | Offers that relied on the guild relation are voided. |

## 5. The attacks it must defeat

| Attack | How it works | Defence | Prevented or only detected? |
|---|---|---|---|
| Gold selling (real-money trading) | Sell in-game gold for real money; the buyer gets it as a "gift". | Gold switch (off at first); 10,000 a week per receiving account, 5,000 per offer; 72-hour hold (a stolen or bought gift can be reversed); a 7-day friend/guild relation, so a seller can't just send to a stranger; telemetry `gold.in trade` and the pattern report (accounts at the cap every week, one-way gold flows); the legal pages forbid it. | **Only detected**: payment happens outside the game. The cap makes one buyer worth at most ~6 % of a week's income, and the owner can switch gold off at once. |
| Selling items for real money | Same, with a Legendary, Mythic or Void as the gift. | Weekly item caps (1 Mythic/Void, 3 Legendary/set); tradeable once (no resale); Mythic and Void switches off at first; hold and reversal. | Only detected; kept small. |
| Multi-account funnelling | Alt accounts farm and gift gold, materials and items to a main. | Account age, level 15, 7-day relation, weekly caps on everything, boss loot always bound, Forge spend bound, hold. The shared shelf already lets a player pool their own two heroes, so a second account adds little. Pattern report: one-way flows, pairs that only trade with each other. | **Only detected**: one person with two accounts looks like two friends. Limits make it slow and small. |
| Funnelling with invite codes | One multi-use invite brings in a cluster of accounts that feed one. | Only admins create codes (D.2); the admin panel shows which invite each account used; the pattern report groups trades by invite. Open registration would call for stricter eligibility. | Only detected. |
| Bait-and-switch | Change the offer just before the other side accepts. | Offers can't change; accept checks the exact contents. | Prevented. |
| Look-alike items | Pass off a weaker item as a famous one. | Full item view with rarity colour, affixes, effect, variant and binding on both screens. | Prevented in the game; persuasion is the player's choice. |
| "Trust trade" / "you first" | Ask for a gift with a promise to give something back. | Swaps are atomic (items, gold and materials on both sides), so nobody needs to go first; gifts say "you get nothing back". | Prevented technically; persuasion only detected (reports). |
| Staff impersonation | "I'm a moderator, give me your item to check it." | Reserved names (4.1); staff never ask for items or gold (said in the UI); no free text in offers. | Mostly prevented; contact outside the game only detected. |
| Account theft | Log into someone's account and give everything away. | Weekly caps limit the damage; the hold plus reversal undo it. (Per-account login throttling and email verification: done in ticket 5.7; T.4 checks `isEmailVerified(accountId)` from `apps/server/src/auth`.) | Limited and reversible. |
| Laundering duplicated items | A duped item is traded on so it looks clean. | Provenance check, one hop only, hold plus reversal, items keep their id. | Detected and refused at the trade; a dupe itself is a bug the exploit review must find. |
| Laundering duplicated gold or materials | A bug mints gold; it is spread to friends to hide it. | Weekly caps, hold, reconciliation (trade gold in = out, every balance = its audit), switches to stop it at once. | Detected (reconciliation); spreading is capped. |
| Bots | Scripts farm and feed trades. | Farming is server-simulated and capped (an idle game gives a bot little); rate limits; eligibility; caps. | Only detected (patterns, rate-limit hits). |
| Race exploits | Accept twice, accept while selling the item or spending the gold, etc. | Locks in a fixed order, escrow, all-or-nothing transaction, `Idempotency-Key`, real-Postgres race tests. | Prevented (and tested). |

## 6. Economy impact

- **Gold sinks:** trading moves gold between players and creates none, so the total sunk is unchanged. But it lets a rich player speed up a friend's Forge track: by at most 10,000 a week per receiving account (~6 % of a week's Abbey income, less than half of one +5 → +10 step). Forge spend stays bound to the item, and the Warehouse, guild and community sinks still pay out of the hero's purse.
- **The shelf** pools an account's two heroes: an alt's gold and materials can fund the main's Forge. That changes B.2's unit ("one hero's purse") to "one account's purse" for players who use it. **B.3 must measure this**, with the shelf switches on in its realistic player.
- **B.2/B.3 balance:** new inflow from trades per account is at most the weekly caps; late-game farming finds more than that, so trading tops up rather than replaces farming. Telemetry should show traded items, gold and materials as a share of what drops. A reasonable alarm is "more than 10 % of Legendary/set items in use, or more than 5 % of gold income, came from trades".
- **Build diversity:** the risk is that everyone gets the best-rolled effect, or the Mythic, for the strongest build. Mitigations: caps (one Mythic/Void a week), one hop, bind on equip, Mythic and Void off at first, and effects already count once with caps (B.2). The trading phase adds a check on the worn-effect distribution.
- **Possibly better:** fewer good items salvaged for want of the right class, set completion becomes social, crafters get a role, and the tier-2 material gate eases.

## 7. What can't be prevented, only detected

- One person with two accounts (no IP or device tracking: the privacy rule stands).
- Real money paid outside the game for a gift of gold or an item.
- Persuasion and promises made outside the game.
- Account sharing or account sale.

That's why the caps are small, why everything starts switched off, and why the trading phase includes a **pattern report** for the owner (a command like `report:telemetry`, and a view in the admin panel). It shows one-way flows of gold, materials or items, pairs that only trade with each other, clusters by invite code, accounts at a cap every week, and reversals. A flag opens a moderator case; it never sanctions on its own.

## Accepted risks

- Items equipped before launch aren't known to have been worn, so they count as fresh unless forged. Low risk: owners mostly forged their best gear, and caps apply.
- A reversal can't recover what was salvaged or spent after the hold.
- Two accounts of one person can always gift within the caps.
- With the shelf's gold and materials on, a player's two heroes share one purse (by design, 8c).
- Settings are cached for up to a minute (like the world flags) except in the process that changed them, so a switch turned off can still let an accept through for a few seconds. Turning a switch off also voids open offers, and the hold makes any trade in that window reversible.

## Region boss hoards (tickets 6.2, 8.2)
Both region bosses' hoards are stored with a `hoard:` source (`hoard:tyrantsForge`, since 8.2 `hoard:hollowThrone`), so every hoard item is **always bound** whatever its rarity (the T.1 table's "boss hoard" row), and their boss materials (the Tyrant's Ember, the Shard of the Hollow Crown) are never tradeable (`UNTRADEABLE_MATERIALS`). Crafts made from them (Tyrantforged and Crownforged Work) follow the table by rarity like every craft. Asserted in `world/cinder-depths.test.ts` and `world/hollow-deep.test.ts`.

## Hero deletion (ticket D.4)

Hero deletion now exists, for admins only (the panel's Inspector, `apps/server/src/admin/heroes.ts`), as a **soft delete** with a 14-day restore window and a CLI purge after it. It goes through both seams: T.5's `voidForDeletion` (every open offer the hero sends or receives is voided, `void_reason = 'deletion'`, the escrow goes back to the sender) and T.7's `rehomeShelfItemsForDeletion` (the hero's shelf items go to the account's oldest other **live** hero, still on the shelf; without one the deletion is refused with `409 shelf_not_empty`). Lock order: the shelf lock, the account row `for no key update` (a trade write holds it `for share`, so an accept or a send serialises with the deletion; `for update` would deadlock with any write's idempotency-key insert, which holds `for key share` on the account row), the admin's row, then the seams (offers, heroes, items). Real-Postgres races: deletion vs an accept of the hero's offer, deletion vs a shelf deposit of its item (`admin/tools.pg.test.ts`).
- While deleted the hero is hidden from its player, every list, board and matchmaking, and frozen (its activity settled and ended, every hero route `404`); `deleted_at is null` on every hero read is guarded by `admin/tools.test.ts`. A deleted hero can't receive an offer, and can't be the heir of shelf items.
- **Restore** (within 14 days, a free hero slot needed) brings back the hero, its arena defence as saved and its active and showcase choice; its board rows are recomputed. Not brought back: voided offers (the escrow already went home), shelf items handed to another hero (they stay on the account's shelf), the ended activity (the player starts again; the seed stream continues).
- **Purge** (`deploy/admin.sh purge`): deletes the row through both seams again. The offers' `restrict` keys keep any hero that a past trade names: such a hero stays soft-deleted for good, reported as kept, so the trade history and audit stay whole.
- Guilds are per account: deleting a hero never changes a guild role.

## Ticket outline for the phase that builds it

Not part of `docs/ROADMAP.md`; the owner places it. Ground rules from Phases 1–4 apply (vertical slices, invariance tests, real-Postgres races from the ticket that adds a lock, `Idempotency-Key` on every value route, the migration rule, nothing secret from public ids, permission matrices, extend the journey).

Before it: per-account login throttling and email verification (done in ticket 5.7; trading eligibility reads `isEmailVerified`), because account theft is the worst case for trading.

| Order | Ticket | Content | Migration |
|---|---|---|---|
| T.1 (**built**, see "T.1 as built") | Item binding & provenance | game-core `itemBinding(item, settings)` as a data table (rarity, variant, source, state → account-bound / bind on equip / tradeable); item columns for the binding, the bound account, `traded_count`, `hold_until`, first-equipped; equip and Forge work set the binding; tooltips show it; provenance written by every tradeable source; backfill for existing rows. No trading yet. | Additive item columns + backfill (`data_backfills`, like 4.2). |
| T.2 (**built**, see "T.2 as built") | Trading settings (admin) | The "Trading settings" section of the D.3 admin panel: every switch and limit in "Admin switches", stored server-side, cached and invalidated on change (like world flags), hard maxima in game-core, `settings.update` audit and history, admin-only edit (moderators read-only, players `404`). Defaults: the "Admin switches" table (the master, every "Trade: …" and "Shelf: …" switch off, so nothing is tradeable; Epic, Legendary and set pieces on; Mythic and Void off). A switch turned off voids the affected open offers (wired up in T.5). | `game_settings` (key, value jsonb, updated_by, updated_at). |
| T.3 (**built**, see "T.3 as built") | Shared account shelf | A second Warehouse tab: items (marker on the item row, like 4.7), materials and gold on the account; deposit from one hero, withdraw to any; each kind behind its switch; withdrawals always allowed; held value can't be shelved; audit and telemetry. | Shelf marker and account id on items; `account_shelf_materials`; `accounts.shelf_gold` (`CHECK >= 0`). |
| T.4 (**built**, see "T.4 as built") | Trade rules, eligibility & sanctions | game-core permission matrix (switches × relation × standing × action), caps and limits read from settings, the `trade` rate-limit class, the trade-restriction sanction (4.1 queue). | Sanction kind; `trade_counters` per account and window if the caps need it. |
| T.5 (**built**, see "T.5 as built") | Trade offers (vertical) | Send, cancel, decline, accept, expire, void; escrow for items, gold and materials; all-or-nothing swap; the 72-hour hold (held gold and materials per hero, released by time); audit and telemetry; polling inbox; the full-view confirm screens with loading, empty, error and success states. | `trade_offers`, `trade_offer_lines` (item, material or gold); escrow column on items; `trade_holds` (hero, gold, materials, until). |
| T.6 (**built**, see "T.6 as built") | Moderation, reversal & pattern report | Trade history in the admin panel and moderator case view, reversal (all or nothing), report a trade, the pattern report (command and panel view). | An index or two. |
| T.7 (**built**, see "T.7 exploit review" and "T.7 as built") | Hardening, exploit review & balance | Exploit review of T.1–T.6, the journey extended with three players, a balance check (traded share of items, gold and materials; the shelf's effect on B.2's sink numbers; worn-effect diversity). | None. |

### T.1 as built

- **game-core** `trading/binding.ts`: `itemBindingState(item)` (the state, from rarity, variant, set, source and state only) and `itemBinding(item, switches)` (adds `tradeable`); data tables `SOURCE_BINDING`, `RARITY_BINDING`, categories `epic`, `legendary`, `set`, `mythic`, `void`; `DEFAULT_TRADING_SWITCHES` all off (T.2 changed it to the "Admin switches" defaults: Epic, Legendary and set pieces on). The state never reads a switch: a switch only opens or closes what is already bind on equip (the split the "Admin switches" table assumes). Rules and order in `docs/LOOT.md` "Item binding".
- **Columns** (migration `0030_item_binding`, additive): `binding`, `bound_account_id`, `traded_count`, `hold_until`, `first_equipped_at`, `unprovenanced` (`docs/DATA_MODEL.md`). Every source writes the binding at creation; the first equip and every Forge action (any upgrade attempt, reroll or improvement) bind in their own transactions. `traded_count` and `hold_until` wait for T.5.
- **Boss hoards** are told apart from chamber drops by replaying the run without the hoard (3.8's telemetry rule) and stored as `source = hoard:<dungeon>`.
- **Provenance:** farming already listed Epic+ drops by id; crypt claims now list theirs (`dungeon.claim` `notableItems`, with `hoard: true`); crafts always had `forge.craft` `itemId`. Merchant goods and quest rewards are always bound, so they need none.
- **Backfill** (in the server after start-up, `docs/DEPLOY.md` "Data backfills"): sets the binding from known state (equipped now → worn; forged; hoard drops recognised from stored runs; rarity and source), and for bind-on-equip rows looks for the creation row: a crypt item found only in its stored run gets an `item.provenance` audit row; anything else gets `unprovenanced = true`, for T.4/T.5 to refuse and flag. Items worn before T.1 but not worn at the backfill count as fresh, as accepted above.
- **Tooltip:** "Account-bound" with the reason (worn, forged, boss hoard, reward, merchant, too common), or "Binds when worn: wearing or forging it binds it to your account. It can't be traded." While trading is closed the wording promises no trade; once an item's switches are on it will read "Tradeable once".
- **Decisions taken in T.1:** the switches' defaults were all off until T.2 (the owner then chose the "Admin switches" table: Epic, Legendary and set pieces on, which only matters once the master switch is on). A failed upgrade attempt binds like a successful one (gold was spent on the item). Items from sources nobody classified (test fixtures, a future source) are bound until added to the table on purpose.

### T.2 as built

- **game-core** `trading/settings.ts`: the typed `TradingSettings` (`trading`; `trade`, `shelf` per kind `items`/`materials`/`gold`; `tradeable` per category; `limits`, the twelve numbers of "Per-account limits"), `DEFAULT_TRADING_SETTINGS` (exactly the "Admin switches" table: master, Trade and Shelf off; Tradeable Epic, Legendary and set on; Mythic, Void and, since ticket 6.4, Prismatic off; the limits' defaults), `TRADING_LIMITS` (default and **hard maximum** of each number, minimum 0), the panel's plain words (`TRADING_SWITCHES`: label, what it controls, what switching it off does; `TRADING_LAUNCH_ORDER`), `validateTradingSettings` (an admin's save: anything off-schema or out of `[0, max]` is **refused**, naming the field), `normaliseTradingSettings` (a stored value: missing or malformed fields take their default, numbers are **clamped** to `[0, max]`; never throws), `diffTradingSettings`, `switchedOff`, and `tradingSwitchesOf` (the switches T.1's `itemBinding` reads). `DEFAULT_TRADING_SWITCHES` now equals `tradingSwitchesOf(DEFAULT_TRADING_SETTINGS)`.
- **Storage:** `game_settings (key, value jsonb, version, updated_by, updated_at)`, migration `0031_game_settings` (additive, no rows: a missing row is the defaults, so no backfill). Key `trading` holds the whole object.
- **Cache:** `app.gameSettings` (`GameSettingsCache`, a copy of 4.6's world-state cache): served from memory for 60 s, invalidated by the instance that saved (so there the change is immediate), a load racing an invalidation doesn't store the old copy, the clock is injectable. Decisions inside a value transaction (T.4/T.5) read the table with `loadTradingSettings(tx)`.
- **API** (`docs/API_CONVENTIONS.md`): `GET /api/mod/settings/trading` for staff (moderators read-only, `canEdit: false`; players and anonymous the not-found `404`), with the change history; `PUT /api/admin/settings/trading` for admins only, with `Idempotency-Key` and `expectedVersion`. The edit locks the row, refuses a stale version with `409 settings_conflict` (a first save racing another first save loses on the primary key), writes nothing when nothing changed, and writes a `settings.update` audit row (`{ key, version, changes: [{ path, old, new }] }` on the admin's account: who, when, old, new). Roles stay CLI-only.
- **Item views:** every route that returns an item (`itemView`, `inventoryView`, the warehouse, the Forge, the merchant, quest rewards) passes the stored switches (`app.gameSettings.tradingSwitches()`), so `tradeable` is true only when the master, "Trade: items" and every category of the item are on. With the defaults nothing changes for players.
- **Seam for T.5:** `app.settingsEvents.onSettingsChanged(listener)`. A listener receives `{ before, after, changes, switchedOff, version, actorAccountId, at }` and the transaction, and runs **inside the edit's transaction** after the row and the audit row are written: what it writes (voided offers, returned escrow, `trade.void` rows) commits with the switch, and a throw refuses the edit. T.2 registers none.
- **Panel:** the admin panel's "Trading" tab (`#/admin/trading`): the state now in force in one line, every switch as a lever with what it controls and "When switched off", the limits with their maximum and default, unsaved changes listed before **Save changes** (a number over its maximum can't be saved), the conflict message with a reload, the suggested launch order, and the change history (50 a page). Moderators see the same board read-only at the bottom of the moderator queue. Screenshots `docs/screenshots/phase-5/admin-trading-*` (`tools/screenshots/admin-trading.mjs`).
- **Tests:** game-core `trading/settings.test.ts` (defaults, maxima, refusal, clamping, the switch combinations behind `tradeable`); server `settings/settings.test.ts` (permission matrix, audit and history, concurrent saves, idempotency, the cache with an injected clock, the seam, `tradeable` through the API, invariance: opening everything changes only `tradeable`), real PG `settings/settings.pg.test.ts` (four admins saving from one version, three rounds: exactly one wins, audit = versions); the exit run checks the defaults were never saved.

- **Ticket 6.4: "Tradeable: Prismatic".** A sixth category (`TRADE_CATEGORIES`), default **off**, with its own switch in `TRADING_SWITCHES` and the admin Trading tab (built from `TRADE_CATEGORIES`, so it shows there with its words). No migration: `normaliseTradingSettings` gives a stored row without the key its default, so a live game reads it as off. T.1's `itemTradeCategories` adds `prismatic` next to the rarity's category (a Prismatic set piece needs set + Prismatic); T.4's category refusal (`item_category_off`) and T.5's voiding (`switchesVoiding`, "trading of Prismatic items is paused") cover it; the weekly cap counts it with Mythic/Void. Tested in game-core (`binding.test.ts`, `settings.test.ts`) and on the server (`trading/offers.test.ts`: refused while off, offered when on, voided when switched off again, the Void offer untouched, the cap).
### T.3 as built

- **game-core** `trading/shelf.ts`: `planShelfDeposit` and `planShelfWithdraw` (pure, all or nothing, refusals in a fixed order: nothing to move, a paused kind, the items, room, gold and materials), `DEFAULT_SHELF_CONFIG` (20 item places; per-request sanity bounds), `HeldValue` / `NO_HELD_VALUE`, `isHeldItem` (T.1's `hold_until` after the transaction's clock). A withdrawal plan has no switch input at all.
- **Storage** (migration `0032_account_shelf`, additive): `item_instances.on_shelf` + `shelf_account_id` (check: set together, never worn or stored while shelved), `accounts.shelf_gold` (`>= 0`), `account_shelf_materials` (`quantity >= 0`). A shelved item keeps its `character_id` (the hero who placed it) until another hero takes it out; the withdrawal moves `character_id` to the taker. Nothing else on the row changes: binding, `traded_count`, lock, forge state and id stay.
- **API** (`docs/API_CONVENTIONS.md`): `GET /api/characters/:id/shelf`, `POST …/shelf/deposit` and `…/withdraw` with `{ itemIds?, gold?, materials? }` and an `Idempotency-Key`. Any mix of kinds in one request; one audit row and one telemetry count per kind.
- **Capacity choice:** 20 item places for the whole account, as §3 proposed, in data (`DEFAULT_SHELF_CONFIG.itemCapacity`); no upgrades yet (B.3 can add a gold-sink ladder like the warehouse's). Materials and gold unlimited. A withdrawal of items needs free pack slots below the pack's capacity (the warehouse rule), so a full pack takes out gold and materials but no items.
- **Switches:** decisions read `loadTradingSettings(tx)` (the table, not the cache), so a switch turned off is honoured by the next deposit everywhere. Deposits of a paused kind: `409 shelf_paused` with `details.kind` and "Anything already on the shelf can still be taken out". **Withdrawals never read a switch.**
- **Warehouse locked:** every shelf route answers the building's `409 warehouse_closed` first, like 4.7. Withdrawals stay possible because the world flag is never removed and no deposit is possible before it is set: anything on a shelf was put there while the building was open, and it stays open.
- **Held value:** an item with `hold_until` after the transaction's clock is refused (`409 item_held`, `details.holdUntil`). Held gold and materials go through one seam, `apps/server/src/shelf/held.ts` `heldValueOf(tx, characterId, now)`, which returns nothing held until T.5 adds `trade_holds`; the deposit plan already subtracts it (`insufficient_gold` / `insufficient_materials` carry `held`). T.5 changes only that function.
- **Sanctions:** none read. A mute or (T.4's) trade restriction leaves the shelf working, as decided ("it reaches no one"). A suspension stops every session, so it stops the shelf like every other route (4.1).
- **Locks:** the account's shelf lock (`pg_advisory_xact_lock` on `shelf:<accountId>`, taken first and only by shelf moves), then the hero (settling first), its items, and the shelf's rows in `(created_at, id)` order, the same order as `loadItems`, so a shelf move and another hero's inventory action never lock shared rows in opposite orders. The real-PG races see no retries.
- **Audit:** `shelf.deposit` / `shelf.withdraw` on the account and the acting hero, `{ kind, amount, fromCharacterId, toCharacterId, … }`: items carry a snapshot each (id, base, rarity, level, variant, set, Mythic, upgrade, lock, binding, and `fromCharacterId`, the hero who held it, so a withdrawal names both heroes), gold `{ gold, goldAfter, shelfGoldAfter }`, materials `{ materials, materialsAfter, shelfMaterialsAfter }`.
- **Telemetry:** `shelf.move` (`deposit`/`withdraw` × `items`/`materials`/`gold`; amount = items, units, gold). Shelf gold is not counted as `gold.in`/`gold.out` (it never leaves the account), so B.2's sink numbers are unchanged. `reconcileWithAudit` adds six count checks and three conservation checks (each shelf's holdings = deposits − withdrawals).
- **Invariance:** settlement, crypt placement and the loot filter count the pack only (`packItemsWhere` now also excludes shelved rows), so an account with a full shelf settles a pinned window exactly like one with an empty shelf; 5.1 scores read worn gear only, so shelving changes no score (both tested).
- **Not built here:** eligibility, offers, caps, holds (T.4/T.5). Hero deletion doesn't exist; if it comes, a deleted hero's shelf items must move to another hero first (the row's `character_id` cascades). *T.7 made it a rule with a seam and a guard (`rehomeShelfItemsForDeletion`, "T.7 as built").*

### T.4 as built

- **game-core** `trading/rules.ts`: `tradeDecision({ action, settings, now, actor, counterpart, relation, offer? })` is the permission matrix. Actions are T.5's lifecycle (`TRADE_ACTIONS`: `send`, `accept`, `decline`, `cancel`, `view`). The matrix is data: `TRADE_ACTION_CHECKS` lists the named checks each action runs, `TRADE_SANCTION_CHECK` which sanction blocks trading (mute, suspension and trade restriction; a forced rename and hidden content don't). **Send and accept** run every check; **cancel, decline and view** run none (stepping away is always possible, under any switch, relation or sanction; being a party to the offer is T.5's ownership check). The answer lists **every** failing check (`TradeRefusal`: `check`, `party` `game`/`pair`/`you`/`them`/`offer`, and the item, kind, material, side, closed categories, `metAt` or `flag` where they apply), in a fixed order, and `TRADE_CHECK_TEXT` / `tradeRefusalText` give plain words. Thresholds are constants, as this document sets them (`TRADE_ELIGIBILITY`: account 14 days, a hero at level 15, a relation 7 days; met exactly at the boundary); everything that is a setting (switches, items per side, gold per offer) comes from `TradingSettings`.
  - **Relation:** a block either way wins; then friend (accepted) or guildmate (the later of the two joins of the guild they share now); with both, the older tie counts. No relation (stranger, pending request) is `no_relation`; under 7 days `relation_too_new` with when it qualifies.
  - **Standing**, for both accounts: `account_too_new`, `hero_too_low` (the account's best hero), `email_unverified` (5.7's `isEmailVerified`), `suspended`, `muted`, `trade_restricted`. A refusal about the other account always reads as "They can't trade right now", and its `metAt` is never handed on.
  - **Contents** (send and accept): `empty_offer`, `kind_off` (each kind's "Trade: …" switch, on either side), `too_many_items` / `gold_per_offer` (settings), `invalid_amount` (negative, fractional or repeated), `material_not_tradeable` (Gravewarden's seals and, since 6.2, Tyrant's Embers, `UNTRADEABLE_MATERIALS`), and per item `item_unprovenanced` (**refused and flagged**: `flag: true`, T.5 writes the flag row), `item_bound` / `item_category_off` (T.1's `itemBinding` with the category switches; the master and "Trade: items" are named on their own), `item_locked`, `item_stored`, `item_on_shelf`, `item_held`. Escrow (an item already in another offer) is T.5's.
- **Caps** (`trading/caps.ts`): `TRADE_CAPS` maps each counter to its setting, window and directions; `capUsageOfSide` counts a side (Epic → Epic; Legendary, set, Mythic and Void → Legendary/set; Mythic and Void → Mythic/Void, a Void Mythic once; gold; materials by group via `MATERIAL_CAP`); `tradeCapIncrements(offer, 'sender' | 'receiver')` gives one account's counters (given and received apart, one completed trade each); `checkTradeCaps` the refusals with `used`, `adding`, `max` and `resetsAt`. **Windows:** a week starts Monday 00:00:00.000 UTC (4.9's `guildBossWeek`), a day at 00:00 UTC; the window holding the transaction's clock counts (the window rule), stored with the row. *Decision:* fixed windows instead of "rolling 7 days" / "any 24 hours": every other cap in the game works this way, a row per window is exact under a lock, and a player can be told when a cap resets (the panel's words changed with it). Lowering a limit refuses at accept and voids nothing; adding nothing never breaks a cap.
- **What counts when:**
  - *(Changed in T.7, exploit review F3: at send only the sender's own caps are checked; the receiver's are checked at accept, where they see their own numbers. The paragraph below is T.4's design.)*
  - **At send:** the open-offer limits (`openOfferRefusal`, counted from T.5's offers themselves: the offer row is the counter) and the per-offer limits (items per side, gold per offer). The weekly and daily caps are **checked** for both accounts (`readTradeCounters` + `checkTradeCaps`) so an offer that couldn't be accepted now is refused up front, but **not reserved**: an open offer must not use up the receiver's week (a sender could block a friend's cap with offers they never complete), and a declined or expired offer has nothing to give back.
  - **At accept:** everything again (switches, relation, both standings, contents, per-offer limits from the fresh settings), then `commitTradeCounters(tx, { actorId, parties, limits, now })` inside the accept transaction: both accounts' counter locks, the windows at the transaction's clock, every cap checked, then all increments, or `409 trade_cap_reached` and nothing (the other account's refusals name only the cap, never its numbers). Check-then-increment under a lock: two accepts racing for the last slot serialise and exactly one fits (real-PG test).
- **Storage** (migration `0033_trade_rules`, additive): `trade_counters (account_id, period, window_start, metric, direction, amount, updated_at)`, one row per account, window, metric and direction (`docs/DATA_MODEL.md`); old windows are kept for T.6's pattern report. The `sanctions_kind_check` constraint gains `trade` (widened, no row changes).
- **Locks for T.5:** a transaction-scoped advisory lock per account (`trade-counters:<id>`), in id order, taken **last**, after the accept's row locks (accounts, heroes, items); nothing but counter reads and writes runs under it and nothing else takes it.
- **The `trade` rate-limit class** (`apps/server/src/trading/trade-limit.ts`): 20 trade writes a minute per account, on top of 3.9's limits and apart from the social class; `429 rate_limited`, `details.limit: 'trade'`. `tradeWrite(app, request, reply, fn)` is T.5's entry point: it counts the class, opens the transaction, share-locks the actor's account row (a sanction being issued holds it for update, so a write either commits before a new restriction or sees it) and hands `fn` the actor's standing and the settings from the table.
- **The trade restriction** (sanction kind `trade`, moderator action `restrictTrade`, label "Trade restricted"): issued from the 4.1 queue on a report like a mute, with a reason, an expiry (1 hour to 365 days; presets 1, 7, 30, 365 days), `sanction.issue` / `sanction.lift` audit rows, one active at a time (`409 already_sanctioned`) and early lifting. It turns off only trading (`trade_restricted` for send and accept); it blocks no social write, no play and not the shelf. The player sees it in their standing (account screen, standing strip). **Seam for T.5:** `app.sanctionEvents.onSanctionIssued(listener)` runs every listener inside the issuing transaction, after the sanction and audit rows, under the subject's account lock, with `{ sanction, kind, subjectId, actorAccountId, at }`; what it writes commits with the sanction, a throw refuses it. T.5 voids open offers on `trade` and `suspend`. T.4 registers none.
- **Eligibility endpoint** `GET /api/trading/eligibility[?handle=]` (`docs/API_CONVENTIONS.md`): whether trading is open (and for which kinds), your own requirements one by one (`accountAge` with when it's met, `heroLevel` with your best level, `email`, `standing` with the blocking sanction kinds), your counters for this week and day against the limits, and with `handle`, whether you could send that player an offer and why not. **Leak design:**
  - An unknown handle and a player who blocks you get the same `404 not_found` body, exactly like `GET /api/players/:handle/relation` (so it confirms nothing that route doesn't already).
  - You block them: `blocked`. A stranger or a pending request: `no_relation`. Friends or guildmates for under 7 days: `relation_too_new` with the day it qualifies (both players know when they became friends or joined). In none of these is the other account's standing read at all, so the answer is the same whatever their age, level, email or sanctions.
  - Friends or guildmates for 7 days or more: their standing is collapsed to one bit, `them_not_eligible` ("They can't trade right now"), never which rule they miss. That bit is what any offer would reveal anyway; it is accepted.
  - The answer never carries their account id, creation date, level, email state or sanctions. It is a read (3.9's request limit), writes no audit row and reads the settings from the cache (decisions inside T.5's transactions read the table).
- **UI:** the account screen's **Trading** panel (`TradingPanel`): trading's state in one line (while closed: "not open… this is where you would stand", promising nothing), each requirement met or not, the limits table once trading is open, and "Could you trade with a friend?" (pick a friend, read the answer and the reasons); loading, empty (no friends), error and success states. Moderators see **Restrict trading** among the queue's decisions; the standing writ shows "Trade restricted". Screenshots `docs/screenshots/phase-5/trade-eligibility-*` and `moderation-restrict-trade-*` (`tools/screenshots/trade-eligibility.mjs`).
- **Tests:** game-core `trading/rules.test.ts` (the full matrix: switches × relation and its age × your standing × action, 1,200 cases against hand-written expectations; the other account's standing × action; contents), `trading/caps.test.ts` (windows at the Monday and midnight boundaries, counting, refusals); server `trading/eligibility.test.ts` (requirements, the matrix through the API with every relation × the other account's standing × both switch states, the leak and enumeration checks, the sanction's lifecycle and seam, the rate-limit class, invariance), `trading/counters.test.ts` (caps at the week and day boundaries on an injected clock, all or nothing), real PG `trading/counters.pg.test.ts` (two accepts for the last slot: exactly one; 24 accepts both ways among four accounts: every cap exact, no deadlock, no retry; both fail without the lock); `social/permission-matrix.test.ts` covers `restrictTrade` per role × subject; journey `e2e/trade-eligibility-journey.test.ts`.
- **Not built here:** offers, escrow, holds, voiding (T.5); flag rows for unprovenanced items (T.5 writes them when refusing); the pattern report (T.6).

### T.5 as built

- **game-core** `trading/offers.ts`: `TRADE_OFFER_TTL_MS` (48 h), `TRADE_HOLD_MS` (72 h), `offerContents` + `switchesVoiding` (which switches turned off withdraw an offer: the master all; a "Trade: …" switch those with that kind on either side; a "Tradeable: …" switch those with an item of that category on either side; "Shelf: …" and lowered limits never), `tradeEndText` (the plain line both players see: "This offer was withdrawn: trading of gold is paused. Everything in it went back to the sender."; a block, a relation ending or a sanction reads "the two of you can't trade right now", never whose or which).
- **Storage** (migration `0034_trade_offers`, additive): `trade_offers`, `trade_offer_lines`, `trade_holds`, `item_instances.escrow_offer_id` (`docs/DATA_MODEL.md`).
- **Lifecycle** (`apps/server/src/trading/offers.ts`, routes in `offer-routes.ts`, `docs/API_CONVENTIONS.md`). Every write goes through T.4's `tradeWrite` (the `trade` class, an `Idempotency-Key`, the actor's account row share-locked) and `tradeDecision`:
  - *(T.7: send now takes both accounts' `social:` locks and checks the pair before it reads anything about the receiver; the other account's standing reaches the decision as one bit; only the sender's caps are checked. See "T.7 as built".)*
  - **send**: `tradeDecision('send')` with both standings, the relation and the contents; the open-offer limits (counted from the offers under advisory locks `trade-offers:<id>` of both accounts, so they are exact); the caps checked for both accounts, not reserved (T.4); then the sender's side goes into escrow: items get `escrow_offer_id`, gold and materials leave the hero (hold-aware) and live in the offer's `give` lines. An unprovenanced item is refused and flagged (`trade.flag` audit row, written after the refusal). Each side comes from one hero; asking for items names the receiver's hero (`receiverCharacterId`), whose tradeable pack items `GET /api/trading/partners/:handle` lists once the pair may trade. A received offer's sender is told nothing new about the receiver beyond T.4's one bit.
  - **cancel / decline**: the sender / the receiver, always possible (T.4: no checks); anyone else gets `404`. Past 48 h it ends as `expired` instead.
  - **expire**: by time. Accepting after 48 h is `409 offer_expired`; the inbox (for that account) and the scheduler's sweep end it (`sweepTrades`, each offer in its own transaction, under its row lock).
  - **accept**: everything again from the locked facts (switches from the share-locked settings row, relation, both standings, every item's binding, lock, location, hold and provenance, the receiver's gold and materials less what is held), then T.4's `commitTradeCounters` last, then the swap in the same transaction: the receiver's side is taken at that point, items change hero, become account-bound to their new account (`traded_count + 1`) with `hold_until = now + 72 h`, gold and materials arrive with a `trade_holds` row per receiving hero. Pack capacity doesn't refuse an accept: items arrive over capacity like B.2's valuable drops.
  - **void**: a switch turned off (T.2's `onSettingsChanged`, in the saving transaction), a trade restriction or suspension (T.4's `onSanctionIssued`, in the issuing transaction; a mute doesn't void), a block, an unfriend, a guild left, a kick or a disband (`app.relationEvents.onRelationEnded`, in that transaction; an offer still covered by the other tie stays), and hero deletion (`voidForDeletion`, a seam: deletion doesn't exist, and the offers' `restrict` keys refuse to delete a hero an open offer names). Escrow goes back; nothing is held.
  - Every ending writes one audit row on the sender (`trade.cancel`, `trade.decline`, `trade.expire`, `trade.void` with `reason` and the switches or sanction kind) with what was returned and the hero's balances after; `trade.offer` carries the full item snapshots of both sides; `trade.accept` both sides with each item's snapshot, previous and new owner (account and hero), the hold's end and both heroes' balances after.
- **Lock order** (no deadlocks; the real-PG races see no retries): the actor's account row `for share` → the trading settings row `for share` (send, accept) → the other party's account row `for share` → the open-offer advisory locks (send) → offer rows `for update` (id order) → heroes (`for no key update`, settled first, id order) → their items (`(created_at, id)` order) → T.4's counter locks → telemetry at commit. Nothing that holds a hero waits for an offer row. **Changed in T.3's shelf:** a shelf move now takes its account row (`for no key update`) right after the shelf lock and before the hero, because a gold move updates `accounts` and trade writes hold that row before heroes; before, a shelf gold deposit and a send by the same hero could deadlock.
- **The hold.** Spending never waits for the release: a hold counts while `held_until` is after the transaction's clock, so a spend racing the release sees the same answer. `changeGold` and `changeMaterialsTx` refuse a spend that would dip into held value (every spend path goes through them; `docs/ECONOMY.md` "Held value after a trade" lists them and `trading/holds.test.ts` guards that no other file writes a hero's gold or materials). T.3's `heldValueOf` reads `trade_holds`. Held items can be worn, never sold, salvaged, discarded, forged, put in the per-hero Warehouse, shelved or traded (`409 item_held`), so a reversal always finds them on the hero (in the pack or worn); taking items out of the Warehouse is never refused. `trading/holds.test.ts` tries every one of those paths on a received item. The release (`released_at`, one `trade.release` row) is written once by the sweep.
- **Seams for T.6 (reversal):** nothing received can leave its hero for 72 hours; `trade_holds` lists each hero's received gold, materials and item ids per offer; items keep their ids; the audit rows hold both sides and both heroes. A reversal moves the same rows and amounts back under the same lock order.
- **Clock:** trade writes use the auth clock (`app.authNow()`, like T.4); settling heroes uses the game clock; in production and in the tests they are the same.
- **Telemetry:** `trade.complete` (gift/swap), `trade.items` (rarity, variant), `item.fate trade traded`, `gold.in/out trade`, `material.in/out trade` at accept (escrow isn't counted: nothing changed hands yet); `reconcileWithAudit` checks in = out, escrow conservation and holds; the journey's holdings check replays trade rows for both heroes.
- **UI** (`#/trading`, from the status bar and the account screen's Trading panel): "the weighing table": offers to you, sent, history and a new offer; every offer is two pans on a brass beam (you give, you get) with every item's full tooltip, and the 72-hour hold spelled out on the full view and the confirm step; plain reasons from `tradeDecision`; held gold and materials per hero; held items say "Held until …" in their tooltip. While trading is closed the screen says so and links to where you stand. Screenshots `docs/screenshots/phase-5/trade-*` (`tools/screenshots/trading.mjs`; the open states are stubbed, the e2e server keeps trading closed).
- **Tests:** server `trading/offers.test.ts` (lifecycle matrix with escrow conservation, idempotency, flags, limits, the swap all or nothing, held items and gold, release once on an injected clock, voids by switch, block, unfriend, trade restriction, suspension, not mute, deletion; invariance: 5.1 scores read worn gear only), `trading/holds.test.ts` (every spend path refused while held and allowed after; the static guard), real PG `trading/offers.pg.test.ts` (accept vs cancel, double accept, accept vs a switch turned off, accept vs a block and a suspension, two-way trades and swaps between one pair at once, a shelf deposit racing an escrow of the same item, spending held gold racing its release; three rounds each, looped 20× shuffled), journey `e2e/trade-journey.test.ts`.
- **Decisions:** received items can't go into the per-hero Warehouse while held (owner decision on review, like the shelf); a friend's tradeable pack items are visible to a qualifying friend or guildmate while trading is open (owner: fine); an accept after 48 hours is refused without a write and the sweep expires the offer (owner: fine); escrowed items leave the pack (they don't use a pack slot while away and come back over capacity if need be); `trade.flag` is written after the refusal in its own transaction; the receiver picks their hero at accept unless the offer asks for a hero's items.

### T.6 as built

- **game-core** `trading/reversal.ts`: `TRADE_REVERSAL_WINDOW_MS` (14 days), `reversalDeadline`, `reversalDecision` (every refusal, in a fixed order, with `TRADE_REVERSAL_TEXT` plain words), `reversedItemState`, `TRADE_REVERSED_TEXT` (what both players read); `trading/patterns.ts`: `TRADE_PATTERN_RULES` (thresholds as data), `tradePairFlags`, `tradeAccountFlags`, `TRADE_PATTERN_TEXT`. Moderation action `reverseTrade` (`MODERATION_ACTIONS`); report target `{ kind: 'trade', id }`; report reason `scam` ("A scam, a stolen account or selling for real money").
- **Storage** (migration `0035_trade_moderation`, additive): `trade_offers.reversed_at`, `reversed_by` (the moderator, `set null` on delete), `reverse_reason` (check: only on an accepted offer, reason with the time); indexes `trade_offers_accepted_closed_idx` (completed trades by time, for the history and the pattern report), `trade_offers_reversed_idx`, and `audit_log_trade_offer_idx` (`data->>'offerId'` on `trade.*` rows: one trade's audit trail). No backfill.
- **Who:** moderators and admins (`/api/mod/*`, `404` for everyone else, before validation). A viewer sees a trade only if at least one of its two players is below their role and they aren't one of them (the 5.6 rule); **a reversal needs both players below the actor's role**, so a moderator never reverses a trade with another moderator or an admin in it, and nobody reverses their own trade (`403`, in plain words). Players see only their own history (T.5's), which now shows a reversal with the moderator's reason.
- **Views** (`docs/API_CONVENTIONS.md` "Trade moderation"): the history (`GET /api/mod/trades`: everything, one player's by `handle`, one pair's with `with`, by status, newest first, paged), and one trade's case (`GET /api/mod/trades/:id`): both players (handle, display name, role) and heroes (name, class, level), every line in full (the item snapshots from the offer), the holds, the audit trail in plain words (who acted, by display name), the open reports about it, and a **dry run** of the reversal (possible or not, every reason, the deadline, whether the viewer may act, and exactly what would move back). No emails, account ids or other personal data. Reading writes `mod.trade.list` / `mod.trade.view` audit rows (counts only, never the search).

**What a reversal can undo** (`reversalDecision`; anything refused refuses everything):

| State of what was received | Within the 72-hour hold | After the hold |
|---|---|---|
| Item in the pack | Reversed | Reversed |
| Item worn | Reversed (taken off) | Reversed (taken off) |
| Item locked | Reversed (goes back unlocked) | Reversed (goes back unlocked) |
| Item sold, salvaged or discarded | Impossible (held) | **Refused**: `item_gone` |
| Item worked at the Forge (any upgrade attempt, reroll or improvement) | Impossible (held) | **Refused**: `item_forged` |
| Item on the account shelf | Impossible (held) | **Refused**: `item_on_shelf` (take it out first) |
| Item moved to another hero of the account (through the shelf) | Impossible (held) | **Refused**: `item_moved` |
| Item in the Warehouse | Impossible (held) | **Refused**: `item_in_warehouse` (take it out first) |
| Item in another offer, or traded again | Impossible (bound) | Impossible (bound); a guard: `item_in_offer`, `item_traded_again` |
| Gold and materials, all still on the hero | Reversed | Reversed |
| Gold or materials partly spent, shelved or traded on | Impossible (held) | **Refused**: `gold_spent`, `materials_spent` |
| Only another trade's *held* gold or materials left | — | **Refused**: held value never pays for a reversal |
| Trade older than 14 days, never completed, or already reversed | **Refused**: `too_old`, `not_completed`, `already_reversed` | same |

Gold and materials have no identity, so "still there" means the receiving hero holds at least what it received, not counting what other trades still hold there (gold farmed since counts). A refused reversal leaves everything as it was; the moderator sanctions instead.

- **The reversal** (`apps/server/src/trading/reversal.ts`, `POST /api/mod/trades/:id/reverse`, `Idempotency-Key`, a reason of 3–300 characters on one line that both players read, optionally a sanction). In one transaction:
  - the trade's holds end (`released_at` now, one `trade.release` row each with `via: 'reverse'`), so nothing stays held on either hero; `heldValueOf` and the inbox now skip released holds (the sweep only releases holds past their time, so nothing else changed);
  - every item goes back to the hero it came from **as it was traded** (`reversedItemState`): bind on equip again (`binding = 'equip'`, no bound account), `traded_count − 1`, no hold, taken off, unlocked, and a first wear by the receiver is undone (`first_equipped_at` cleared when it came with or after the accept). *Decision:* the trade is undone, so the item is tradeable again, as before; a pre-launch first wear couldn't exist (a worn item was never tradeable);
  - gold and materials go back both ways through `changeGold` / `changeMaterialsTx` (takes first, then gives; so it never dips into another trade's hold);
  - the offer gets `reversed_at`, `reversed_by` and the reason (status stays `accepted`, guarded by `reversed_at is null` under the row lock: a second reversal is refused);
  - one `trade.reverse` audit row on the receiver (the same sides as `trade.accept`, each item with where it went back from and to, both heroes' balances after, the holds ended, the reason, the moderator, the sanction if any);
  - telemetry `trade.reverse` (gift/swap, amount = items moved back), `gold.in` / `gold.out trade_reverse`, `material.in` / `material.out trade_reverse` (in = out: a reversal is a mirrored trade);
  - **not** changed: T.4's cap counters (a reversed trade still used that week's caps; *decision*, so a reversal can't be used to free a cap), settings, other offers.
  - The trade's two heroes are settled first (like an accept). A worn item taken off changes the hero's Power: leaderboards catch up on the hero's next request or the scheduler's sweep, as after any unequip; an arena defence keeps its stored snapshot until refreshed (T.7 to review).
- **A sanction in the same flow:** `sanction: { handle, action: 'mute' | 'suspend' | 'restrictTrade', durationHours }` on one of the two players (anyone else: `422 not_a_party`), with the reversal's reason, 4.1's durations and rank rule, and its `onSanctionIssued` listeners (a trade restriction or a suspension voids the player's open offers). All or nothing with the reversal: an active sanction of that kind (`409 already_sanctioned`) refuses both.
- **Lock order** (T.5's, extended): the moderator's account row `for share` → both players' account rows in id order (`for update` for the one sanctioned in this flow, `for share` otherwise) → offer rows `for update` in id order (the trade, and the open offers the sanction will void) → heroes in id order (the trade's two and those offers' senders; settled) → the trade's item rows, then its hold rows → the sanction (its listeners only re-lock what is held) → telemetry at commit. Real-PG races (three rounds each, looped 20× shuffled; no retries): a reversal vs the hold's release, vs a spend of the received gold (a warehouse upgrade), vs shelving the received item, vs a second reversal, vs the accept of a new offer that takes the same gold, and a reversal with a trade restriction vs the subject accepting another offer.
- **Reporting a trade:** either player reports an offer or a completed trade from the Trading screen ("Report this offer/trade", 4.1's dialog with the target fixed); anyone else gets `404` like an unknown id. The subject is the other player; the key `trade:<offer id>`; not hideable. The queue's case says "Trade · Completed trade · with …" and links to the trade's case (`#/moderation?trade=<id>`); the trade's case counts its open reports and links back. Acting on the report (dismiss or sanction) stays the queue's job.
- **The pattern report** (`GET /api/mod/trading/patterns?days=`, the panel under the trade ledger, `pnpm admin:trading patterns [--days N] [--json]`, `deploy/admin.sh trading patterns`): completed trades in the window (default 28 days, at most 90), by pair and by account, only from what the server has (offers and lines, T.4's counters, `trade.flag` rows, reversals, the registration audit row's invite id, the stored email's 5.6 `mailboxKey`). Signals:
  - pairs: **one way** (from 2 trades, everything went one direction), **only each other** (neither traded with anyone else), **same invite**, **same mailbox** (`a+x@` and `a@` are one mailbox; compared on the server only);
  - accounts: **new and receiving** (received ≥ 3 items, 5,000 gold or 150 material units while under 30 days old), **at a cap** (a weekly cap reached in 2 or more weeks), **unprovenanced item** (any `trade.flag`), **reversals** (2 or more of their trades reversed);
  - **invite clusters**: 3 or more accounts from one invite that traded with each other.
  Every row carries the flows (items, gold, material units each way) and the dates. Players appear by handle and display name; no emails, account ids, invite ids or codes, and no mailbox key, ever. Staff see only rows they may act on and never their own; the command (on the server) sees all. A flag opens nothing and sanctions nobody: it points at a case. Viewing writes `mod.trade.patterns` (counts only).
- **UI:** the moderator docket's **trade ledger** (and the admin panel's "Trades" tab): the history with a handle / pair / status filter, the case file (two pans with every item's tooltip, the heroes, holds, trail, reports), the verdict ("can't be reversed" with every reason in plain words, or who may act), and **Reverse this trade…**: a full view of exactly what goes back to whom (worn items taken off, locked ones unlocked), the reason field, an optional sanction with its duration, then "Reverse everything"; loading, empty, error and success states, desktop and mobile, scoped CSS (`trade-mod.css`). The **trade patterns** panel below it; names open the ledger on that player or pair. On the Trading screen: "Report this offer/trade" on every offer, and a reversed trade shows the moderator's reason. Screenshots `docs/screenshots/phase-5/trade-mod-*` (`tools/screenshots/trade-mod.mjs`).
- **Tests:** game-core `trading/reversal.test.ts` (the window to the millisecond, every item state, partly spent gold and materials, the restore rule), `trading/patterns.test.ts` (every flag at its threshold); server `trading/reversal.test.ts` (the matrix within and after the hold through the real routes: worn, locked, sold, salvaged, discarded, warehouse, shelf, Forge, another hero; gold and materials partly spent; another trade's hold; the window; idempotency; permissions; a sanction in the same flow; reporting; history and case views without personal data; reconciliation), `trading/patterns.test.ts` (fixtures for every signal, the window, visibility, no personal data in JSON or the command's text, the command line), `social/permission-matrix.test.ts` (`reverseTrade` per role × subject), real PG `trading/reversal.pg.test.ts`, the journey step `playTradeModerationStep` (report, queue, case, reversal and its replay, the pattern report, holdings = audit).
- **For T.7:** a worn item taken off by a reversal stays in the receiver's arena defence snapshot until refreshed (*fixed in T.7*); a reversal never touches the cap counters (by design, kept); the case view's dry run reads without locks (the reversal decides again under them; kept, it only informs).

### T.7 exploit review

A red-team pass over T.1–T.6 (every route that moves items, gold or materials, every lock order, every refusal a player can read), with an independent second reader. **No way to create, duplicate or lose items, gold or materials was found, and no hold or binding bypass.** Five holes were found and fixed, each with a test that failed first (F1–F5 below); one T.6 item (the arena defence) was fixed; one race test read commit order from audit ids and was made order-free. Tests named here are in `apps/server/src/` unless they say game-core.

| Attack | How it's prevented | Proved by | Residual risk |
|---|---|---|---|
| **Duplication via races**: double accept, accept vs cancel/decline/expiry/void, one item in two offers | Every ending and the accept lock the offer row and re-check `status = 'open'`; escrow is a column (`escrow_offer_id`) set and cleared only under that row lock; every `update` re-checks the state it planned from and a row-count mismatch rolls back; `Idempotency-Key` | `trading/offers.pg.test.ts` (accept vs cancel, double accept, two-way swaps), `trading/offers.test.ts` (lifecycle matrix, escrow conservation) | None known. |
| Duplication via the reversal | One transaction under T.5's lock order; `reversed_at is null` re-checked under the row lock; items move with `where character_id = from and not escrowed/stored/shelved`; gold and materials through the hold-aware helpers | `trading/reversal.pg.test.ts` (vs release, spend, shelving, second reversal, new accept, sanction), `trading/reversal.test.ts` | None known. |
| Duplication via the shelf or Warehouse | One shelf lock per account first, then the account row, hero, items; deposits re-check location, escrow and hold in the `where` | `shelf/shelf.pg.test.ts`, `warehouse/warehouse.pg.test.ts` (*made order-free in T.7*), `trading/offers.pg.test.ts` (shelf deposit vs escrow of the same item) | None known. |
| Duplication via hold release | `released_at` set once by the sweep under the hold row lock; a hold counts while `held_until` is after the transaction's clock, so a spend racing the release sees one answer | `trading/offers.pg.test.ts` (spend vs release), `trading/holds.test.ts` (release once) | None. |
| **Idempotency-key reuse** across users or actions | Keys are per account; the stored hash covers method, path (with its ids) and the canonical body; another request with the same key is `409 idempotency_conflict`; a failed request stores nothing | `economy/economy.test.ts` (replay/conflict/expiry), `trading/offers.test.ts` and `trading/reversal.test.ts` (replays) | A replay returns the stored answer even if the role or standing changed since: it moves nothing new. Accepted. |
| **Lock-order deadlocks** | One documented order (T.5, extended by T.6 and T.7). *F4 (fixed):* `voidOffers` locked senders' heroes one offer at a time in offer order; a sanction, switch or block voiding several offers against an accept or reversal between two of those senders could close a cycle (Postgres aborted one; the retry hid it). Now every sender hero is locked in hero-id order first. *Defence:* the reversal and accept lock the defence row after heroes and items, the duel's direction | `trading/hardening.pg.test.ts` F4 (failed with a retry before the fix), `trading/reversal.pg.test.ts` (reversal vs defence refresh vs duel), every pg race asserts no retry | A new lock-taking path must keep the order; the pg suites and the nightly Flake hunt catch a cycle as a retry. |
| **Laundering through the shelf or Warehouse** | Held items, gold and materials can't be shelved, stored or offered (`409 item_held`, `insufficient_*` with `held`); after the hold, value moved away makes the reversal refuse (`item_on_shelf`, `item_moved`, `item_in_warehouse`, `gold_spent`), never take the wrong thing; shelf gold isn't `gold.in/out` | `trading/holds.test.ts`, `trading/reversal.test.ts` (matrix), journey `e2e/trading-hardening-journey.test.ts` | After 72 hours received value is the player's own and may be shelved: a reversal then refuses and the moderator sanctions (by design). |
| **Hold bypass on any spend or move path** | Re-checked by hand on every write to item location (`update`/`delete` of `item_instances`: sell, salvage, discard, equip, lock, the Forge, warehouse, shelf, offers, accept, reversal, backfill), gold and materials (`changeGold`, `changeMaterialsTx`; other writers only add) | `trading/holds.test.ts` (every path, and the static guard on gold and material writers) | A new write to item location isn't caught by a static guard; review new routes against `assertItemNotHeld`. |
| **Binding bypass** (forge or equip timing) | Equip and the Forge lock the hero and refuse an escrowed, stored or shelved item (`assertItemInReach`); the first wear and any Forge attempt bind in their own transaction; the escrow and the swap re-check `equipped_slot is null` and the lock in the `where` | `inventory/binding.pg.test.ts`, `trading/offers.test.ts` | Items worn before T.1 count as fresh (accepted in "Accepted risks"); since T.7 such an item also leaves its old owner's arena defence when traded. |
| **Unprovenanced items** | `unprovenanced` refused at send and accept and flagged (`trade.flag`); the backfill set the flag; a creation row is required for every bind-on-equip source | game-core `trading/rules.test.ts`, `trading/offers.test.ts` (flags), `trading/patterns.test.ts` | A dupe bug that also writes a creation row would pass; the reconciliation (items = audit) is the backstop. |
| **Cap evasion at window boundaries** | Fixed UTC windows at the transaction's clock, counted under the counter locks at accept, check-then-increment; a reversal frees nothing | `trading/counters.test.ts` (Monday and midnight on an injected clock), `trading/counters.pg.test.ts` (last slot) | Two trades either side of Monday 00:00 can use two weeks' caps within minutes (by design of fixed windows). |
| **Multi-account funnelling** | Account age, level 15, verified email, 7-day relation, weekly caps, boss loot bound, hold; pattern report flags | `trading/patterns.test.ts` | Only detected (§7). |
| **Sanction or switch timing** | Trade writes share-lock the actor's row (a sanction holds it for update) and the settings row (an edit holds it); both read the table, not the cache; voids run in the issuing transaction | `trading/offers.pg.test.ts` (accept vs switch off, block, suspension), `trading/reversal.pg.test.ts` (reversal with a restriction vs an accept) | Reads (inbox, eligibility) use the 60-second cache, so a closed switch can show "open" for up to a minute; no write follows it. |
| **Send racing a block, unfriend or guild change** | *F5 (fixed):* send read the relation without the `social:` locks those actions take, so a block committing in between missed the new offer and left it open between a blocked pair (escrow stuck until expiry; accept refused, nothing lost). Send now takes both accounts' social locks before reading the relation | `trading/hardening.pg.test.ts` F5 (failed before the fix) | None. |
| **Eligibility leaks** | *F1 (fixed):* send, accept and the receiver's preview passed the other account's full standing to `tradeDecision`, so a **stranger** could read whether a player was muted, suspended, restricted or unverified, and a friend could count the rules they missed. Now the standing is read only once the pair qualifies and handed on as one bit (`hiddenCounterpart`, as the eligibility endpoint already did), and their reasons are deduplicated. *F3 (fixed):* send checked the receiver's weekly caps and named the metric, so a friend could binary-search what someone received this week; now only the sender's caps are checked at send | `trading/hardening.test.ts` F1, F3; `trading/eligibility.test.ts` (enumeration) | A qualifying friend still learns the one bit "they can't trade right now" (accepted in T.4), and a receiver at accept learns that the *sender* is at a cap (one bit per offer). |
| **Client-supplied ids outside what the server offered** | Own heroes through `lockOwnedCharacter`; the receiver's hero must belong to the receiver; items must belong to that hero; schemas bound amounts (integers, maxima, unique ids, fixed material keys). *F2 (fixed):* send looked up the receiver's hero and asked-for items before the relation check, so a stranger holding an id could confirm which account owns a hero or item and read its state (`item_held`, `item_unprovenanced`, …); now the pair is checked first and a stranger gets the same answer for real and made-up ids | `trading/hardening.test.ts` F2, `trading/offers.test.ts` (ownership 404s) | A qualifying friend sees the states of their friend's items (they can see the tradeable list anyway). |
| **Moderator abuse** | Staff routes `404` for others before validation; the role re-read under a share lock in the transaction (a CLI revoke stops the next action); both players must be below the actor's role; nobody reverses their own trade; every view and reversal audited; roles stay CLI-only | `social/permission-matrix.test.ts` (`reverseTrade`), `trading/reversal.test.ts` (permissions) | A rogue admin can reverse any player trade within 14 days; every reversal is audited and both players are told. |
| **Reversal edge cases** | `reversalDecision` refuses everything if anything moved on (the T.6 table); other trades' held value never pays; worn and locked items come back unlocked and taken off; *the returned item now also leaves the receiver's saved arena defence* | game-core `trading/reversal.test.ts`, `trading/reversal.test.ts` ("reversal and the arena defence"), `trading/reversal.pg.test.ts` | Gold farmed since the trade can pay a reversal (gold has no identity; by design). |
| **Rate limits** | Trade writes: the `trade` class (20 a minute) plus 3.9's account limits; shelf, warehouse and staff routes: 3.9's account limits | `trading/eligibility.test.ts` (the class) | A compromised staff account can act at 3.9's rate; reversals are audited per row. |
| **Telemetry and audit gaps** | Every value move writes one audit row with balances after; `reconcileWithAudit` (trade in = out, escrow, holds, shelf conservation, counts); the journey replays holdings for every hero and shelf | `telemetry` tests, journeys `trade-journey`, `shelf-journey`, `trading-hardening-journey` | `shelf.rehome` (the deletion seam) has no telemetry: deletion doesn't exist. |

Also checked and sound: expiry at the exact millisecond (both sides use `now >= expiresAt` under the row lock), a void returns escrow to the sender's hero whoever was sanctioned, the inbox ETag is built from the caller's own data only, an accept may name any of the receiver's heroes (eligibility is per account, as documented).

### T.7 as built

- **Fixes** (F1–F5 above): `trading/standing.ts` `hiddenCounterpart` (the one-bit standing, now used by send, accept and the receiver's preview); `trading/offers.ts` `reasonsView` (the other account's refusals as one line), send's order (account rows → open-offer locks → **social locks** → the pair → the sender's hero and items → the receiver's hero and items → contents → **the sender's caps only**), `voidOffers` (sender heroes in id order before any escrow returns). New tests: `trading/hardening.test.ts`, `trading/hardening.pg.test.ts` (in `test:pg`).
- **The arena defence (T.6's open item).** *Decision:* the item leaves the snapshot rather than invalidating the defence or validating ownership at duel time (snapshots carry no item ids; dropping the whole defence would punish the receiver for a moderator's action). `arena/model.ts` `withdrawFromDefence` runs in the reversal (items going back) and the accept (items changing account; only an item worn before T.1 could be in one), matched by seed, base, rarity and item level; the rest of the defence, its level and `setAt` stay, the bracket Power is recomputed, `PVP_RULES_VERSION` is unchanged. `trade.reverse` carries `defenceItemsRemoved`. Patch notes 0.5.15 ("Fixed").
- **Hero deletion (T.3's open item)** is now a rule with a seam: `shelf/deletion.ts` `rehomeShelfItemsForDeletion` (`docs/WAREHOUSE.md`), a test and a static guard.
- **Race tests swept** for T.3's ordering assumption (audit rows by `created_at` or uuidv7 id read as commit order): `warehouse/warehouse.pg.test.ts` decided an item's last move from the newest audit id; two serialised moves in one millisecond sort at random. Now order-free (deposits − withdrawals). No other pg test orders audit rows.
- **Screenshots:** the phase-5 trading screenshots (T.2–T.6, 94 files: `admin-trading-*`, `trade-eligibility-*`, `moderation-restrict-trade-*`, `shelf-*`, `trade-*`, `trade-mod-*`) recompressed losslessly with oxipng (level 3; every file checked pixel-identical): **173.3 MB → 126.7 MB** (−27 %). None dropped: each is a documented state.
- **Journey** `e2e/trading-hardening-journey.test.ts` (`playTradingHardeningStep`, three players, the switches turned on through the admin route): gifts and swaps (gold for materials, gold and materials as a gift, an item swap), held items and gold refused on sell, shelf and send, a report and a reversal within the hold, "Trade: gold" switched off voiding an open offer, a trade restriction from the queue voiding the restricted player's offer and refusing their next send while the shelf still works, the release after 72 hours and the same spends then succeeding, a second hero taking things off the shelf; every hero's holdings and every shelf = the audit log, `reconcileWithAudit` all ok, audit and telemetry counts equal. The browser e2e was not extended: the e2e server keeps trading closed and roles are CLI-only, so opening trading in the browser run would need a new e2e-only seam; the screens are covered by the stubbed screenshots and the server journeys (left for 5.8).
- **Balance check** (`docs/ECONOMY.md` "Balance check: trading and the shelf (ticket T.7)", `telemetry:simulate --trading on|all`, `tools/balance/trading.ts`; 7 game days, 28 accounts, 8 of them with a second hero; all four runs reconcile, 99/99 checks). A 20-member guild gifting every useful find from day one: Epics traded 1.2–1.4 % of Epic drops, Legendaries 3.9–4.0 % of Legendary drops; **Legendary and set pieces worn at the end that came from a trade: 12–15 %** (the alarm in §6 is 10 %); gold traded 0.3 % of gold income (alarm 5 %), materials 0.3–0.6 % of material income. The shelf changes the unit, not the income: an account farms one hero at a time, so §3's "at most doubles" can't happen; it moves an alt's idle gold (~14 % of the mains' income) into the main's Forge (one account's purse: 104–109 % sunk against 106 % without). Worn-effect diversity is unchanged (10–11 distinct effects, top effect 17–19 %, HHI 0.13–0.14, the same as the runs without trading). Set, Mythic and Void trades didn't occur in the simulation (it scores gear by level, rarity and upgrades), so live `trade.items` must watch them. **Decision: no limit or default changed.** The Legendary alarm trips only in that upper-bound guild and every gifted piece would otherwise have been salvaged; if it trips in live telemetry, lower "Legendary and set pieces per week" from 3 to 2 (within its maximum of 10).
- **Remaining risks from T.1–T.6, revisited:** pre-T.1 wear counts as fresh (kept, accepted; such an item now leaves the old owner's defence when traded); cached settings for up to a minute on reads (kept, writes read the table); the dry run reads without locks (kept, informative only); a reversal never frees caps (kept, by design); the 60-second cache and fixed windows (kept); the defence snapshot (fixed); hero deletion and the shelf (seam and guard); the pg ordering assumption (swept, one fixed).

### Test strategy

- **Real-Postgres races** (three rounds, varied orders, assert only what holds in every order, no retries):
  - two accepts of one offer;
  - accept vs cancel, decline, expiry, a block, a suspension and a switch being turned off;
  - one item in two offers;
  - accept racing a sell, salvage, discard, Forge action, deposit, equip and settle of an item on either side;
  - accept racing a spend of the same gold or materials (a Forge upgrade, a warehouse upgrade, a community contribution);
  - both players accepting offers to each other at once (lock order: both accounts in id order, then heroes, then items);
  - caps at the boundary (the 4th Legendary, the 2nd Mythic, the gold that crosses 10,000 in a week);
  - shelf deposits and withdrawals by both heroes of one account at once, against a trade;
  - reversal vs use when the hold ends.
- **Value reconciliation:** across all accounts, a trade creates and destroys nothing (items, gold and materials in = out); every item's owner and every balance equal a replay of the audit log; held amounts release exactly once; telemetry `trade.*`, `gold.* trade`, `material.* trade` and `shelf.move` match the audit log (`reconcileWithAudit`); the e2e holdings check runs across the trading players and the shelf.
- **Settings:** every switch on and off × an open offer of each kind (voided, escrow back, nothing lost); limits lowered under an open offer (refused at accept, not voided); hard maxima enforced; every change audited; players and moderators can't change them.
- **Invariance:** with trading off, or with no trades and an empty shelf, every existing test, hash and exit run is unchanged; a traded item's Forge stream behaves exactly as it would have for the first owner (the secret is never sent).
- **Permission matrices:** every switch state × relation (stranger, friend < 7 days, friend, guildmate, blocked either way) × standing (eligible, too new, too low, muted, suspended, trade-restricted) × action, through the API.
- **The exploit review (T.7):** client-trusted values (item ids, amounts, negative or huge gold, a forged "fresh" flag), ownership (`404` for foreign items, heroes and offers), provenance refusals, replays and expired keys, caps across day and week boundaries (window rule: the transaction's clock), deleted heroes and accounts with open offers or shelf contents, and a red-team pass over the attack table above.

## Item Awakening (ticket 6.5b)
- An **awakened item is account-bound for good and never tradeable**, whatever the switches: binding reason `awakened` (game-core `itemBindingState`, checked first), and its own trade check `item_awakened` ("Awakened items can never be traded.") next to `item_bound`, so no future switch can open it. (Awakening needs +10, which binds anyway.)
- **The shelf:** an awakened item moves between the account's own heroes like any bound item (owner decision); it stays awakened. It can't be awakened while on the shelf (`item_on_shelf`).
- **Holds:** awakening is Forge work: refused on a held item (`409 item_held`), and the price never dips into gold or materials on hold (`heldValueOf`), so a reversal always finds a received item untouched.
- **Reversals:** awakening advances the item's forge counter, so an item awakened after its hold is no longer "untouched" and can't be reversed; the moderator sanctions instead.
- **Races** (real Postgres, `forge/awaken.pg.test.ts`): awaken vs a shelf deposit of the same item (one place; paid once or not at all), awaken vs a trade offer of the same item (never escrowed), a double submit with one key.
