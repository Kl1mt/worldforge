# The cosmetic shop: design for the owner's decisions (ticket 8.8, design step)

GDD §5.3 (character slots are account-bound), §13.1–13.3 (cosmetics, the Shrine, the monetization principles); ROADMAP 8.8. This is the **design step only**: nothing here is built. No code, no migration, no payment integration. The build waits on the owner's answers to the questions at the end.

Read with: `docs/COSMETICS.md` (the collection book, `grantCosmeticsTx`, sources), `docs/SHRINE.md` (draws, marks, the reserved `shop` source), `docs/ACCOUNTS.md` (slot grants, "Later: the shop"), `docs/ECONOMY.md`, `SECURITY.md`, `docs/DEPLOY.md` ("Legal pages", §16) and `docs/GOING_LIVE.md`.

**This document is not legal or tax advice.** Section 5 is a checklist for a lawyer (and, for VAT, a tax advisor) to confirm before anything is sold. Where this document states what a rule says, it is the starting point for that review, not its result.

## What is already decided (fixed, not up for discussion here)

| Decision | Date | Where it holds today |
|---|---|---|
| Cosmetics may be sold for real money; never power, stats, drop odds or competitive advantage. | 2026-11-11 | GDD §13.3 |
| Extra character slots beyond the earned ones may be sold; Shrine draws may be sold. | 2026-11-12 | GDD §5.3, §13.3 |
| The offline cap is never sold. | 2026-11-12 | Enforced since 9.6 (F3): only an offline deed's rule id raises the cap (`isOfflineDeed`). |
| Everything sold stays earnable in play. | 2026-11-12 | GDD §13.3 |
| Paid random draws need a legal review first; if it says no, the shop sells marks or chosen cosmetics directly. | 2026-11-12 | `docs/SHRINE.md` "The shop source"; `GET /api/account/shrine` says `paidDraws: false` |

What exists to build on:
- **Cosmetics:** `cosmetic_unlocks (account_id, cosmetic_id)` primary key, `source` text column, one writer (`grantCosmeticsTx`, exactly once, audited `cosmetic.grant`). Six kinds: appearance, banner, crest, title colour, title, companion.
- **Shrine:** `shrine_draw_grants.source` and `shrine_draws.spent_source` already accept `shop` (check constraints from migration `0050`); draws are spent free → play → shop, so bought draws are kept longest; marks buy a chosen keepsake (common 10, rare 25, hallowed 75).
- **Slots:** `account_growth_grants (account_id, grant_id)` with `kind = 'slot'`, `source` text; a bought slot is `source = 'shop'`, `grant_id = 'shop:<order id>'`, no migration needed (`docs/ACCOUNTS.md`).
- **Guards:** `apps/server/src/phase9-no-pay-to-win.test.ts` already writes `shop` slot and draw rows and checks that no power number moves; game-core `balance/phase9-exit-criterion.test.ts` checks no growth rule is bought.
- **Legal pages:** only the Impressum and the privacy policy, operator-filled on the VPS (`deploy/legal/`, git-ignored). There are **no terms of service** yet.

---

## 1. What is sold

### 1.1 Cosmetic kinds

| Kind | Sell? | Reason |
|---|---|---|
| Hero appearances (palette variants) | **Yes** | The most visible look; no number. A sold look must be one that is also earnable (below). |
| Banner styles | **Yes** | Account-wide look. |
| Crest styles | **Yes** | Account-wide look. |
| Title colours | **Yes** | CSS only, cheap to make; good low-price items. |
| Companions | **Yes** | Purely visual beside the hero; the 8.7 / 9.6 no-pay-to-win tests already wear one. |
| **Titles** (the words) | **No (recommended)** | A title states a deed ("Reaper of the Harvest", "Keeper of the Long Road"). Sold, it would say something untrue about the player and devalue the earned ones. |
| Engravings, guild hall looks | **No** | Engravings are a Seal/silver sink with a repeat price; hall looks belong to a guild and are bought from its treasury (8.4). Selling either mixes real money into the game economy. |

### 1.2 Earned-only items stay earn-only (recommended: yes)

Options:
- **A. Earn-only honours stay earn-only (recommended).** Never sell anything whose source is an **event** tier (Harvest, Lantern Procession keepsakes), a **deed** (achievement), a **milestone** (level 40, the Forge Tyrant, the Heroic crypt, the Hollow Sovereign…), a **season** honour or a **guild season** honour.
- B. Sell everything, honours included, at high prices.
- C. Sell honour "lookalikes" (re-dyed variants of honour art).

Recommendation **A**, plus a rule for C: a sold look may reuse an honour's *art* only in a clearly different palette, and never under the honour's name. Reasons: an honour is proof of having been there; selling it makes every earned copy worth less to the players who did the work, and it breaks the promise the book makes today ("every page says how it is earned"). The fixed rule "everything sold stays earnable" is met because what is sold has a currency path in play (see 1.3).

### 1.3 Which entries are sellable

Options:
- **A. Sell the existing currency-earned entries (recommended).** The Shrine pool (15 keepsakes, earned by draws or with marks) and the Seal and Silver Counter (5 entries, earned with Seals and Abbey silver). Both are earnable in play by a currency, so "stays earnable" holds by construction.
- B. A new "shop line" of cosmetics, each also given an earn path (a marks price or a Counter price). More to sell, more art, but every new entry needs a play path designed first.
- C. Sell only new shop-line cosmetics, never existing ones.

Recommendation **A first, B later**: start with what exists (no new art, nothing new to balance), and add new entries only as Shrine pool or Counter entries, so each new look gets its play path in the same change. Mechanism: a game-core data table `SHOP_OFFERS` (offer id, what it gives, price tier) next to the catalogue; the catalogue itself keeps no price (the existing test keeps checking that), and a test checks every cosmetic offer's source is `shrine` or `exchange`, never `event`, `achievement`, `milestone`, `season` or `guildSeason`.

Recommendation on the Counter entries: **sell only the Shrine pool at first**. The Counter exists to give spare Seals and silver a use (6.11); selling its entries for money removes that sink's point for paying players. Keep the option open for later.

### 1.4 Character slots

Today: 2 base, earned 3rd (level 28), 4th (Heroic crypt), 5th (a seam, never granted yet). One activity per account (`docs/FARMING.md`), so more heroes do not farm more at once.

Fairness check before selling slots (a build-ticket task, measured in game-core): some allowances are **per hero per day**: three contracts (the Abbey's with a chosen-slot Epic) and the merchant's stock. A bought hero could turn spare time into more of those, and the shelf moves items between heroes of one account. The account's single activity bounds this (a hero must farm to complete contracts), but the build must measure it and the owner must accept it, or the allowances must move to per account for heroes in bought slots.

Options for the limit:
- A. Unlimited bought slots.
- **B. A hard cap of 3 bought slots, account total at most 8 with every earned one (recommended).** Enough for every class twice over with room to spare; keeps the per-hero allowances bounded.
- C. Bought slots only after the earned ones (you must earn the 3rd and 4th before buying).

Recommendation **B**, and a bought slot never replaces an earned one: the 3rd and 4th still come from play, and their rule ids never change. Price: a slot is the highest-priced single item (it is the most useful thing sold), but with a clear message that the 3rd and 4th slots are free through play. Not C: it would sell nothing to the players who most want a second class early, and it is a rule players find odd. If the owner wants a softer line, B with "the first bought slot only once the account has a hero at level 10" is a reasonable middle.

### 1.5 Shrine draws versus marks versus chosen cosmetics

| | Paid draws | Paid marks | Chosen cosmetics, directly |
|---|---|---|---|
| Randomness | Random (a loot box) | None, but a currency | None |
| Legal risk | Highest (section 5.8) | Premium-currency rules (section 2) | Lowest |
| Duplicates | Turned into marks (softens it) | — | Never: you buy what you lack |
| Fits "everything stays earnable" | Yes (free daily and play draws) | Yes | Yes |

Recommendation: **launch with chosen cosmetics directly** (no randomness, no currency). Add **paid draws only if the lawyer clears them**, and then only with all of these: the odds published as today, no shop-only pool or odds, the duplicate-to-marks rule kept, a per-day limit on bought draws, no sale to players marked under 18 (section 5.7), and not offered where the review says no (at least Belgium, section 5.8). **Do not sell marks** even if draws are refused: marks are a currency, and selling them adds the premium-currency problems of section 2 for nothing a direct sale doesn't do better.

---

## 2. Prices and currency

### 2.1 Direct prices or a premium currency

Options:
- **A. Direct prices in euros (recommended).** Every offer has one euro price, shown with VAT included.
- B. A premium currency ("embers"), bought in bundles, spent on offers.
- C. Hybrid: direct prices, plus a small optional balance (gift cards).

Concerns with B, all of which the EU consumer authorities have raised (the CPC Network's 2024 key principles on in-game virtual currencies, a starting point for the lawyer):
- **Leftover balances:** bundle sizes that never match prices leave money stranded; this is criticised as an unfair practice.
- **Transparency:** the euro price of an item must be clear; a currency hides it.
- **Refunds and withdrawal:** a partly spent balance is hard to refund fairly, and the 14-day withdrawal right and its waiver (section 5.2) apply per purchase.
- **Accounting:** a currency balance is a liability on the books until spent (a tax advisor's question), and a game shutdown with unspent balances needs a refund rule.
- **Minors:** currencies are the classic way spending gets away from children.

Recommendation **A**: a small operator gains nothing from a currency that is worth its legal and accounting cost, and direct prices match the game's plain-language style. Each purchase is one order, one receipt, one grant, one possible refund.

### 2.2 Price structure (placeholders, the owner sets real numbers)

Recommended: **price tiers by rarity**, set by the owner, defined once in `SHOP_OFFERS`, shown with VAT included in the player's currency (euros at first).

| Tier | Offers | Guidance |
|---|---|---|
| Small | Shrine common keepsakes, title colours | the lowest tier |
| Medium | Shrine rare keepsakes, banners | |
| Large | Shrine hallowed keepsakes (Candlelight, the hallowed companions) | |
| Slot | a character slot | the highest single price |
| (Draws) | only if cleared: single draws, no bundle discounts that push volume | |

No real prices are in this document or the repository until the owner sets them; prices live in game-core data (public, as every price in this game is) once decided. Rules: no countdown pressure, no "sale ends in…" timers, no bundles that only pay off when bought in bulk, no prices that change with the account. A price is the same for everyone.

---

## 3. The payment provider

Constraints from the operator: keys live **only** in `deploy/.env` on the VPS (never in the repository, which is public); **no card data ever touches the server**: hosted checkout (the player pays on the provider's page) and signed webhooks (the provider tells the server the order is paid).

### 3.1 The merchant-of-record question

- **Payment processor** (e.g. Stripe Checkout): the operator is the seller. The operator charges and files VAT for every EU country it sells into (via the OSS, section 5.1), issues receipts and handles consumer-law duties as the seller.
- **Merchant of record (MoR)** (e.g. Paddle, Xsolla, FastSpring, Lemon Squeezy): the provider buys from the operator and resells to the player. The MoR charges, files and pays VAT worldwide, issues the receipts, and handles much of the consumer-facing sale (its own checkout terms). The operator sells to one business customer and gets a payout. Higher fees, far less paperwork.

For a small operator in Germany, the MoR mostly removes the VAT filing and cross-border tax risk. It does **not** remove the operator's own duties as the provider of the game (the terms, the privacy policy, youth protection, what is sold).

### 3.2 Comparison (check each provider's current terms; fees change)

| | Stripe Checkout | Paddle | Xsolla | FastSpring / Lemon Squeezy |
|---|---|---|---|---|
| Role | Processor (Stripe has also announced a merchant-of-record offer; check whether it is available for this use) | MoR | MoR, games-focused | MoR |
| VAT | Operator files (Stripe Tax can calculate, for a fee) | Paddle files | Xsolla files | Provider files |
| Fees (order of magnitude) | lowest (a percentage plus a fixed fee per EU card payment) | higher (a percentage plus a fixed fee, all-inclusive) | negotiated; games-specific | similar to Paddle |
| Accepts in-game cosmetics? | Generally yes | **Check:** Paddle's acceptable-use rules have restricted some game items; confirm before applying | Yes, its core business | **Check** each |
| Hosted checkout + signed webhooks | Yes | Yes | Yes | Yes |
| Test mode for CI | Yes (test keys, test cards, CLI webhook signing) | Sandbox | Sandbox | Sandbox / test mode |
| Chargeback handling | Operator responds (Stripe tools) | Paddle handles | Xsolla handles | Provider handles |
| Onboarding | Fast | Review of the business and the product | Contract, review | Review |

### 3.3 Recommendation

**A merchant of record**, with Paddle as the first application if it accepts in-game cosmetics, else Xsolla. Reasons: small volumes make the higher fee cheaper than an advisor's time for OSS filings; the MoR carries the cross-border VAT risk and much of chargeback handling; one payout a month is simpler books. **Stripe Checkout** is the right choice if the owner already has a Stripe account and a tax advisor handling OSS, or if sales stay under the EU threshold (section 5.1) for a long time. The build (section 6) keeps the provider behind one small adapter (create a checkout, verify a webhook, ask about an order, start a refund), so switching later is a contained change.

Whatever the provider, the server stores only: the provider's order/transaction id, the offer, the price and currency charged, the country (for the record, if the provider reports it), the status and the times. **Never** a card number, an IBAN or a billing address.

---

## 4. Refunds and reversals

### 4.1 Policy

Recommended policy (for the terms, written in plain words):
- **Withdrawal:** the 14-day withdrawal right ends when the item is delivered, because the checkout asks for express consent to immediate delivery and the acknowledgement that the right is lost (section 5.2). If that consent is missing for any reason, the purchase is refunded on request within 14 days.
- **Goodwill refunds:** a purchase made by mistake can be refunded once per account within 14 days if the item has not been worn (or, for a slot, no hero has been created in it, or, for draws, none has been spent). Further cases at the admin's discretion.
- **Faults:** if something bought does not arrive or does not work, it is fixed or refunded (this is a legal duty, §§ 327 ff. BGB, not goodwill).
- **Chargebacks:** a payment disputed with the bank: the order is marked disputed, the item stays until the dispute is decided; if the dispute is lost, the order is reversed (below) and the account cannot buy again until an admin clears it. Never a game ban for a chargeback alone.
- **Shutdown or account deletion:** the terms say what happens to bought items if the game ends (notice period; the lawyer to confirm whether partial refunds are owed for recent purchases) and that deleting an account deletes its bought items.
- **A ban:** bought items stay bound to the banned account; the terms must say a ban for cheating does not refund (lawyer to confirm).

### 4.2 What happens to granted items on a refund or a lost chargeback

| Bought | Reversal |
|---|---|
| A cosmetic | The unlock is removed **only if its source is still `shop:<order id>`** and it is unequipped (falls back to plain / own colours). If the player has since earned it in play, the earn upgraded the row's source (below) and nothing is removed. |
| A slot | The `shop:<order id>` slot grant is removed. Heroes are **never deleted** by a reversal. If the account now has more live heroes than slots, it cannot create or restore heroes until it is under its total again (the existing check). Recommended over sealing a hero, which punishes play time. |
| Draws (if sold) | Unspent bought draws of that order are removed. For draws already spent: keepsakes still held under that draw's `shrine:draw:<id>` source are removed and unequipped, and their duplicate marks are taken back up to the marks the account holds. What can't be taken back is logged on the order as `unrecovered` for the admin. |

**Source upgrade (needed in the build):** `grantCosmeticsTx` today inserts with `on conflict do nothing`. With the shop it must, when an earned grant meets a row whose source starts with `shop:`, update the row's source to the earned one (and audit `cosmetic.source_upgrade`), so a later refund cannot take away something the player has also earned. Draws and slots need no such rule: they are counted rows, not one row per thing.

### 4.3 Admin tools

In the admin panel (a new **Shop** tab) and `deploy/admin.sh`:
- **Orders:** search by handle or order id; each order's status history (created, paid, granted, refund requested, refunded, disputed, reversed), what it granted and from which webhook event. Never card data (there is none) and never the email address, as everywhere in the admin panel.
- **Refund:** asks the provider to refund (through the adapter); the reversal happens when the provider confirms by webhook, not on the click. Needs a reason, an `Idempotency-Key` and typed confirmation; audited `admin.shop.refund` with before and after.
- **Reverse without refund** (for a provider-side refund the server missed, or a lost chargeback the webhook did not deliver): same safeguards, audited `admin.shop.reverse`.
- **Regrant** (an order paid but not granted, e.g. a bug): audited, exactly once like any grant.
- **Shop lock** for an account (after a lost chargeback), and lifting it.
- **Pause the shop** (a world switch, like the trading switches): no new checkouts; webhooks for orders already paid are still processed.

---

## 5. EU and German law: a checklist for a lawyer (and a tax advisor)

Each item is a question to confirm, with the starting point as this design understands it. The build does not start a sale until every item is answered.

### 5.1 VAT (tax advisor)
- [ ] With a **merchant of record**: confirm the operator's sale is a B2B sale to the MoR (reverse charge if the MoR is outside Germany), and what the operator must still record.
- [ ] Without an MoR: B2C electronic services are taxed where the customer lives. Below **€10,000 a year** of cross-border EU B2C sales, German VAT may apply instead (§ 3a (5) UStG); above it, register for the **OSS** (via the BZSt) and charge each country's rate. Confirm the threshold and how it is counted.
- [ ] The **small-business rule** (§ 19 UStG, thresholds raised in 2025): does it apply, and how does it interact with cross-border sales?
- [ ] Evidence of the customer's country (two non-contradicting pieces of evidence for B2C electronic services): what the provider collects is enough?
- [ ] Record keeping: how long order and receipt records must be kept (§ 147 AO; the periods for booking vouchers changed in 2025), and how this fits a player's right to erasure (keep the order record without the account's personal data).

### 5.2 Withdrawal right for digital content (§§ 312g, 356 (5) BGB)
- [ ] The withdrawal right for digital content not on a physical medium ends when delivery begins **only if** the consumer expressly consented to delivery before the end of the withdrawal period, acknowledged losing the right, and received a confirmation of the contract (on a durable medium: the receipt email) that records the consent. Confirm the exact checkbox wording and the receipt's content.
- [ ] The **withdrawal instructions** (Widerrufsbelehrung) and the model withdrawal form: where they are shown (checkout and terms) and in the receipt.
- [ ] The **withdrawal function** ("withdraw from contract here" button) required for online contracts from **19 June 2026** (Directive (EU) 2023/2673, implemented in the BGB): does it apply when the right has already ended by the waiver, and what must the button do in the game?
- [ ] With an MoR, who gives the instructions and the confirmation: the MoR, the operator, or both?

### 5.3 The order button and price display
- [ ] The **button solution** (§ 312j (3) BGB): the final button reads "zahlungspflichtig bestellen" or an equally clear wording (or the MoR's checkout handles it).
- [ ] The information before the order (§ 312j (2) BGB, Art. 246a EGBGB): what the item is, the total price with VAT, that it is account-bound and not tradeable, how long the game promises it.
- [ ] **Price display** (PAngV): total prices including VAT, in the shop, not only at the checkout.
- [ ] No dark patterns: no countdown timers, no hidden prices, no pressure (UWG, the DSA's ban on dark patterns where it applies, the CPC principles on virtual currencies even though no currency is planned).

### 5.4 Digital content contracts (§§ 327 ff. BGB)
- [ ] The duty to deliver what was promised and keep it working ("updates"); what may change later (a look's art redrawn?) and what the terms may reserve (§ 327r BGB, changes to digital products).
- [ ] What is owed when the game shuts down, an account is banned, or an account is deleted on request.

### 5.5 The Impressum, the privacy policy, and new terms
- [ ] **Impressum** (§ 5 DDG): selling makes the site clearly commercial; confirm every required item, including a VAT ID if one is issued, and a dispute-resolution statement if § 36 VSBG applies (and confirm the EU ODR-platform link is no longer needed after its 2025 shutdown).
- [ ] **Privacy policy:** a new section for purchases: the provider as processor or as independent controller (Stripe and the MoRs act as controllers for part of the data; confirm each), what the server stores (order id, offer, price, status, times, the country if reported), the legal bases (contract; legal retention duties), retention, third-country transfers (the provider's), and the receipt emails. The GOING_LIVE "What the policy mentions" ticks need a new entry.
- [ ] **Terms of service / sale (AGB)**: the game has none today. Needed: the contracting party (operator or MoR), what a purchase gives (a licence to an account-bound look, no ownership, no cash value, not transferable), prices and payment, withdrawal (5.2), refunds and chargebacks (4.1), minors (5.7), service changes and shutdown (5.4), bans, liability, governing law and the consumer's own-country protections. Shown at the checkout and accepted with the first purchase (not needed for free play unless the lawyer says otherwise).
- [ ] Where these live: like the Impressum, operator-filled files in `deploy/legal/` (e.g. `agb.md`, `widerruf.md`), templates in `content/legal/`, so no personal data ever lands in the public repository.

### 5.6 Payment and consumer data
- [ ] Hosted checkout keeps card data off the server (PCI scope minimal: confirm the provider's self-assessment level for the operator).
- [ ] The receipt email: sent by the provider (MoR) or by the game's mail; contents (5.2).

### 5.7 Minors and youth protection
- [ ] **Contracts with minors** (§§ 106 ff. BGB): a purchase by a 7–17-year-old without the parents' consent is pending until they approve; the "pocket money" rule (§ 110 BGB) covers only money given for that purpose. Confirm how the shop should handle this: an age question at the first purchase ("I am 18 or older, or have my parent's or guardian's consent"), refunds on a parent's request, and whether that is enough.
- [ ] The game has no age check today. Does selling (and especially any paid random draw) require one, or an age rating?
- [ ] **JuSchG** (2021 reform, § 10b): risks of in-game purchases and gambling-like mechanics count in age ratings; the **USK** considers in-game purchases and paid random items (since 2023) and may raise the rating. A browser game distributed on its own site: does it need a rating or a youth-protection officer (JMStV), and does a shop change that?
- [ ] Spending limits for younger players, if any are advised.

### 5.8 Paid random draws (loot boxes)
Only needed if paid draws are wanted (section 1.5). The design's facts for the lawyer: the draw is cosmetic only, the odds are published and replayable, a duplicate becomes marks that buy a chosen keepsake, nothing is tradeable or convertible to money (account-bound, no market), and free draws come daily.
- [ ] **Germany:** is a paid draw "gambling" under the GlüStV 2021 (stake, chance, a prize of monetary value)? A non-tradeable, cosmetic-only prize is the usual argument against; confirm. Youth-protection side: 5.7 (USK descriptors, a higher rating).
- [ ] **Belgium:** the Gaming Commission has treated paid loot boxes as illegal gambling since 2018. Expect: do not offer paid draws to players in Belgium (how to tell where a player is, without storing addresses: the provider's billing country?).
- [ ] **Netherlands:** the 2022 Council of State ruling narrowed the gambling authority's view, but legislation has been debated; confirm the current position.
- [ ] Other EU states with pending rules (e.g. Spain's draft), and the EU's consumer-protection work on loot boxes and virtual currencies (the planned Digital Fairness Act).
- [ ] **Platform rules:** none apply while the game is a website. If it is ever published on an app store or a games platform (Apple, Google, Steam), their rules on paid random items (published odds, payment through their store) apply then; note for later.
- [ ] Is anything else required for paid draws beyond the published odds: a per-day limit, an age gate, a spending history the player can see?

---

## 6. The build plan (later tickets, after the owner's answers)

Recommended as **three tickets**, so the risky parts land separately:

### 8.8a Orders, grants and the fake provider (no real payment)
- **Data (game-core):** `SHOP_OFFERS` (offer id, `kind: 'cosmetic' | 'slot' | 'draws'`, the cosmetic id or the count, price tier, `active`), the price tiers in minor units per currency, and the rules: `shopOfferProblem(offer, owned, slots)` (already owned, slot cap reached, inactive, draws not allowed). Tests: every cosmetic offer's source is `shrine` (or `exchange` if chosen), never an earn-only source; no offer touches the offline cap or any power value; prices are integers in minor units.
- **Data (server, one additive migration):** `shop_orders` (id, account, offer id, offer snapshot, price and currency, provider, provider order id unique, status, `granted_at`, `reversed_at`, `unrecovered` json, times) and `shop_order_events` (each provider webhook event id, unique, with its type and the order's status before and after: the webhook log and the dedup key). `cosmetic_unlocks.source` needs no change (`shop:<order id>`); `account_growth_grants` source `shop`, grant id `shop:<order id>`; `shrine_draw_grants` source `shop`, source key `shop:<order id>`.
- **The grant:** one transaction, triggered **only** by a verified "paid" webhook, never by the browser's return from the checkout: lock the order, check its status is `paid` and not yet granted, check the offer again (if the cosmetic was earned in the meantime, the order goes to `refund_due` and the admin queue instead of granting nothing silently), grant through the existing writers (`grantCosmeticsTx`, the slot grant, the Shrine grant) with the order's id as the grant key, set `granted_at`, audit `shop.grant`. Exactly once by the order's unique status change and each writer's own primary key; a replayed or duplicated webhook grants nothing.
- **The source upgrade** of 4.2 in `grantCosmeticsTx` (an earned grant over a `shop:` row upgrades its source; audited).
- **Reversal** (`reverseOrderTx`): 4.2's rules, exactly once (`reversed_at`), audited `shop.reverse` with what was taken back and what was unrecovered.
- **A fake provider** (the adapter's test implementation): creates "checkouts", emits signed webhooks with a test secret. Used by every server test and the journey. **Test-mode payments only in CI:** CI never holds a real key; a startup check refuses a live key outside `NODE_ENV=production` and a test key in production.
- **Reconciliation** (`reconcileShop`, and in `reconcileWithAudit`): every granted order has exactly its grant rows (by key) and one `shop.grant` audit row; every reversed order has none left (except those upgraded by an earn) and one `shop.reverse`; counts and sums by status match the audit; no `shop:` grant row exists without its order.
- **Rate limits:** checkout creation per account (e.g. 10 an hour) and per IP; the webhook route is exempt from the session limits but has its own per-IP limit and rejects bad signatures before any database work. Listed in the rate-limit review.
- **API:** `GET /api/shop` (offers with price, owned / blocked, `paidDraws`, `open`), `POST /api/shop/checkout { offerId }` (Idempotency-Key; returns the provider's hosted checkout URL), `GET /api/shop/orders` (the player's own receipts), `POST /api/shop/webhook/<provider>` (no session; signature-verified raw body).
- **Web:** a shop screen in the town's style (DESIGN_SYSTEM, not a storefront grid): each offer with its book page, its euro price with VAT, how to earn it in play ("Also in the Shrine: 25 marks"), the consent checkbox (5.2), then the provider's page; back in the game, "Your order is on its way" until the webhook's grant arrives (poll the order). Loading, empty (shop closed or nothing to buy), error and success states. A purchase history on the account page.
- **Shop closed by default:** `SHOP_MODE=off` until 8.8c; the shop screen says it is not open.

### 8.8b Admin tools and the readiness item
- The Shop tab (4.3): orders, refund (through the adapter), reverse, regrant, shop lock, pause. Typed confirmations, reasons, audit, admin-only (`404`).
- **Readiness panel:** a "Shop" entry: provider configured yes/no (never the key), webhook secret set yes/no, the last verified webhook's time, terms / withdrawal files present yes/no (like the legal-file check), `SHOP_MODE`. Ember until all are done; the shop cannot be opened (`SHOP_MODE=live`) while any is missing.
- `deploy/.env.example` gains the provider's variables as empty placeholders with comments; `docs/DEPLOY.md` and `docs/GOING_LIVE.md` gain a "Shop" step.

### 8.8c The real provider (gated on the owner's account)
- **Gate:** the owner's provider account approved (and, for an MoR, the product accepted), the lawyer's checklist answered, the terms and withdrawal texts in `deploy/legal/`, prices set.
- The provider adapter (create checkout, verify webhook signature with the provider's library or documented scheme, fetch an order, refund), tested against the provider's **sandbox only** in CI (or recorded fixtures; no network in the default suite).
- A dry run on the live site in the provider's test mode with a test account, then `SHOP_MODE=live`.
- **Paid draws** stay off (`paidDraws: false`) unless the legal review cleared them; switching them on is its own small change with the per-day limit, the age question and the country exclusions.

---

## 7. Fairness guards (extended to shop items)

- **The invariance test:** extend `phase9-no-pay-to-win.test.ts` (or a new `shop-no-pay-to-win.test.ts`) to grant **every** `SHOP_OFFERS` entry through the real webhook path (fake provider) and check that a hero's 5.1 scores, its duel defence snapshot, its bracket Power and its character row are identical before and after; a hero in a bought slot starts like any new hero.
- **The import scan:** extend it so no power rule (scores, boards, arena, combat settlement, dungeons, the guild boss, skills, the economy, loot) imports the shop module, and the shop module imports only the cosmetics, Shrine and account-growth writers.
- **The offline cap:** a test that every slot offer writes `kind = 'slot'` only, and that the F3 guard still ignores any `offline` row from the shop.
- **Content guards (game-core):** no offer sells an earn-only source, a title, a power value, an hour of offline time or a drop chance; every offer is also earnable (a play path exists for its cosmetic, for slots the earned rules, for draws the free and play sources).
- **The per-hero allowances check** (1.4): a game-core measure of what a bought hero's daily contracts and merchant stock add for an account limited to one activity, with a bound the owner accepts.
- **Boards and the arena:** a bought item shows on profiles and boards like an earned one of the same look; no board ranks spending, and no "supporter" badge (recommended: it signals payment in a game that promises no pay-to-win; if the owner wants to thank supporters, a separate opt-in, non-ranked mark is the owner's call).

---

## Owner questions

Recommendations first; each refers to its section.

1. **Earn-only honours:** keep event, deed, milestone, season and guild-season cosmetics earn-only, and never sell titles. *Recommended: yes.* (1.1, 1.2)
2. **What to sell first:** the Shrine pool's 15 keepsakes as chosen cosmetics; Counter entries not at first; new looks only as new Shrine or Counter entries. *Recommended: yes.* (1.3)
3. **Randomness:** launch without paid draws; add them only if the lawyer clears them, with a per-day limit, an age question and country exclusions; never sell marks. *Recommended: yes.* (1.5, 5.8)
4. **Slots:** sell up to 3 extra slots (account total at most 8), the 3rd and 4th still earned in play; accept the per-hero allowance bound once measured, or ask for allowances per account for bought heroes. *Recommended: cap 3, measure first.* (1.4)
5. **Currency:** direct euro prices, no premium currency. *Recommended: yes.* (2.1)
6. **Prices:** price tiers by rarity, a slot the highest, no timers or bulk bundles; please set the euro amounts for each tier. (2.2)
7. **Provider:** a merchant of record (Paddle first if it accepts in-game cosmetics, else Xsolla); or Stripe Checkout if you already have Stripe and a tax advisor for the OSS. *Recommended: a merchant of record.* Which one will you apply to? (3)
8. **Refund policy:** the waiver at checkout, one goodwill refund per account within 14 days if unused, faults always fixed or refunded, chargebacks reverse the order and lock the shop for that account (no game ban). *Recommended: yes.* (4.1)
9. **Reversals:** remove only what is still sourced to the order; never delete a hero (an over-full account just can't create heroes); log what can't be recovered. *Recommended: yes.* (4.2)
10. **Supporter badge:** none. *Recommended: no badge.* (7)
11. **Legal review:** will you commission a lawyer (and a tax advisor) for the checklist in section 5? The build's first ticket (8.8a, no real payment) can start before the answers; 8.8c cannot.
12. **Terms of service:** you will need terms (AGB) and withdrawal instructions; they live as your files in `deploy/legal/` like the Impressum. Will the lawyer draft them, or a generator plus a lawyer's check? (5.5)
13. **Ages:** an "18 or older, or a guardian's consent" question at the first purchase, and refunds on a parent's request: enough, or does the lawyer advise more? (5.7)
14. **Build order:** three tickets (8.8a orders and grants with a fake provider; 8.8b admin and readiness; 8.8c the real provider, gated on your provider account and the legal answers). *Recommended: yes.* (6)
