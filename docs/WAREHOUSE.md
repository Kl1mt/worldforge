# The Graumark Warehouse (ticket 4.7)

GDD §4.2. Per-character storage in the hub's Warehouse building, opened for everyone by the first community project (*Restore the Graumark Warehouse*, `docs/COMMUNITY.md`). It is the Phase 3 follow-up for drops kept beyond the pack (B.2).

Code: game-core `economy/warehouse.ts` (capacity, upgrades, the move plan, `WAREHOUSE_UNLOCK`); server `apps/server/src/warehouse/routes.ts` and `inventory/location.ts` (`isPackItem`, `packItemsWhere`, `itemInWarehouse`); web `screens/WarehouseScreen.tsx` (`#/warehouse`), the hub (`HubScreen.tsx`) and the pack banner (`InventoryScreen.tsx`). Endpoints in `API_CONVENTIONS.md`, columns in `DATA_MODEL.md`, telemetry in `TELEMETRY.md`.

## Decisions

- **Per character** (owner default for Phase 4): each hero has its own shelves. Moving things between your own heroes is the **account shelf** (ticket T.3, below), a second tab in the same building.
- **A marker on the item row, not a copy.** A stored item is the same `item_instances` row with `in_warehouse = true`. Its id, lock, forge state (`forge_secret`, counters, upgrades), seed and audit history stay with it; moving it back is flipping the marker. A check constraint forbids a stored item from being equipped. The alternative (a `warehouse_items` table with copied rows) would have needed every item column twice and broken "one item, one id" for the audit log and the forge stream.
- **Where an item is** is now: worn (`equipped_slot`), in the pack (`isPackItem`: not worn, not stored, not on the account shelf), stored, or (T.3) on the account shelf. Every pack-capacity count, every sell/salvage/discard pick, the pack listing and the merchant's and forge's pack lists go through `isPackItem` / `packItemsWhere`. Stored items take no pack slot.
- **Out of reach until moved back.** Sell, salvage, discard, equip, unequip, lock/unlock and every forge action (and the forge item quote) answer `409 item_in_warehouse` for a stored item; `deleteItems` also requires `in_warehouse = false` as a backstop. The loot filter, settlement placement and crypt placement only ever see new drops and count the pack only, so they never touch stored items.

## Rules

- **Closed state.** Every warehouse route first reads the world flag `warehouseRestored` (`app.worldState.flags()` with game-core `WAREHOUSE_UNLOCK`, an `UnlockRule` with `worldFlag`) and answers `409 warehouse_closed` (`details: { flag, projectId }`) until it is set, before any ownership check, so nothing can be probed while closed. A flag is never removed, so the cache can only be late to open (≤ 60 s, and it is invalidated by the completing commit in this process).
- **Moves** (`deposit`, `withdraw`; one id or up to 100): lock the character (settling its activity first, like every inventory change, so the window before the move is placed with the pack as it was), then its items, then plan with game-core `planWarehouseMove`. **All or nothing**: an unknown or foreign id (`404`), an equipped item (`409 item_equipped`: unequip it first), too little room in the warehouse (`422 warehouse_full`) or too few free pack slots (`422 inventory_full`, `details: { capacity, free, needed }`) refuse the whole request. Locked and valuable items move like any other. An item already on the receiving side is left as it is (a repeated move changes nothing), so moves need no `Idempotency-Key`; they move no value. The update re-checks the side and "not equipped" in its `where`, and a row count mismatch rolls the move back.
- **Over capacity (B.2).** A pack over its capacity can always deposit (storage needs room in the warehouse only), which brings it back under the limit so ordinary drops find room again. A withdrawal needs free slots below the pack's capacity: a full or over-capacity pack takes nothing back.
- **Capacity and upgrades** (`DEFAULT_WAREHOUSE_CONFIG`): 30 shelves, +15 per upgrade, six upgrades, 120 at the top (two packs).

| Upgrade | Shelves after | Gold |
| --- | --- | --- |
| 1 | 45 | 1,000 |
| 2 | 60 | 3,000 |
| 3 | 75 | 7,500 |
| 4 | 90 | 15,000 |
| 5 | 105 | 30,000 |
| 6 | 120 | 50,000 |

106,500 gold in all: the first step is about three hours of early farming gold, the last ones are late-game sinks next to the forge's +5 → +10 (`docs/ECONOMY.md`). Measured in B.3 and kept: a top hero stores ≤ 24 keepsakes a week, so the upgrades are bought over weeks (`docs/ECONOMY.md` "Balance pass: top end & social economy").

- **An upgrade** is a value operation: `Idempotency-Key` required, the body names the level the client saw (`{ level }`; another stored level is `409 level_changed`, so a double click with a fresh key never buys twice), the hero settles first (gold earned offline counts), `422 insufficient_gold`, `409 warehouse_max_level`. Gold leaves under the character lock (`gold >= 0` check as the backstop) and the level moves only from the level checked (`where warehouse_level = <read>`). Audited `warehouse.upgrade` (from, to, capacity, gold, gold after); telemetry `warehouse.upgrade` and `gold.out warehouse_upgrade`.
- **Audit and telemetry of moves.** Each move that changes something writes `warehouse.deposit` / `warehouse.withdraw` (the moved items: id, base, rarity, level, locked; the stored and packed counts after) and telemetry `warehouse.move` (`dim1` the direction, `amount` the items). `reconcileWithAudit` compares items deposited, withdrawn, upgrades and upgrade gold with the rollups. Moves don't change what a character owns, so `expectHoldingsMatchAudit` (e2e) counts every row, stored or not.

## Account shelf (ticket T.3)

The building's second tab, *Account shelf* (`docs/TRADING.md` §3 has the rules and "T.3 as built" the decisions). Code: game-core `trading/shelf.ts` (`planShelfDeposit`, `planShelfWithdraw`, `DEFAULT_SHELF_CONFIG`); server `apps/server/src/shelf/routes.ts` (and `held.ts`, the held-value seam); web `screens/AccountShelf.tsx` in `WarehouseScreen.tsx`.

- **Shared by every hero of the account.** Items, materials and gold. An item on the shelf is the same row (the marker design above): `on_shelf` plus `shelf_account_id`; `character_id` stays the hero who placed it until another hero takes it out. Gold is `accounts.shelf_gold`, materials `account_shelf_materials`.
- **Out of reach until taken out:** sell, salvage, discard, lock, equip, every Forge action and the warehouse moves answer `409 item_on_shelf` to the hero who placed it (`assertItemInReach` in `inventory/location.ts`, next to `item_in_warehouse`); to another hero it is a `404` until taken out. `deleteItems` also requires `on_shelf = false`. Shelf items take no pack slot.
- **Gate:** the same world flag as the building (`409 warehouse_closed` first on every shelf route). The flag is never removed and nothing can be placed on the shelf before it is set, so whenever the shelf holds anything the building is open and a withdrawal is possible.
- **Switches:** each kind behind its T.2 "Shelf: …" switch (all off at first), read from the table inside the transaction. Off: deposits of that kind answer `409 shelf_paused`; **withdrawals never read a switch**.
- **Capacity:** 20 item places for the whole account (TRADING.md §3; data in `DEFAULT_SHELF_CONFIG.itemCapacity`; no upgrades yet, B.3 may add them as a sink like the warehouse's). Materials and gold are unlimited, like a hero's own stacks and purse. A withdrawal needs free pack slots below the capacity (the warehouse rule); gold and materials need none.
- **Moves** are value operations: `Idempotency-Key`, all or nothing, settle first. Lock order: the account's shelf lock (`shelf:<accountId>`, a transaction-scoped advisory lock only shelf moves take), the hero (`lockOwnedCharacter`), the hero's items, then the shelf's rows in the same `(created_at, id)` order as `loadItems`. Every `update` re-checks what was planned (side, owner, not worn, not stored, not held) and a row count mismatch rolls back.
- **Audit and telemetry:** `shelf.deposit` / `shelf.withdraw`, one row per kind moved, and telemetry `shelf.move` (`dim1` the direction, `dim2` the kind). `reconcileWithAudit` checks both, and that each shelf's holdings equal the audit replay; `expectHoldingsMatchAudit` counts shelf moves per hero and `expectShelfMatchesAudit` replays the account.
- **UI:** tabs *Your shelves* / *Account shelf*. Two iron panels: *From <hero>* (pack picker, gold and material amounts, "Place on the shelf") and *On the account shelf* (fill meter, items labelled "Left by <hero>", gold and material amounts, "Take out to <hero>"). While every switch is off the left panel says the shelf isn't open yet and the right one still takes out; a single kind paused gets one plain line. Loading, error (retry), empty, full and success states. Screenshots `docs/screenshots/phase-5/shelf-*` (`node tools/screenshots/shelf.mjs`).
- **Races** (`shelf/shelf.pg.test.ts`, real PostgreSQL, part of `test:pg`): both heroes of one account depositing and withdrawing at once (gold and materials conserved across the two heroes and the shelf, every item in one place, holdings = audit replay); a double submit with one key (moves once, three replays); withdraw vs deposit of one item in both orders (a growing head start until both are seen); deposit and withdrawals racing a sell and a Forge upgrade; a shelved item racing a withdrawal, sells, salvage, discard, the Forge and a second deposit (never taken). No retries anywhere.

## Invariance

- game-core's settlement, crypt and loot rules are untouched (they receive a pack count), so the pinned no-effects hashes hold by construction. The server checks the part that changed, the count it passes:
  - an empty or closed warehouse changes nothing: every existing test, the e2e runs and the telemetry reconciliation pass unchanged;
  - two heroes with the same seed, a nearly full pack and a loot filter, one of them with a full warehouse, settle two hours to exactly the same summary, gold and XP (the capacity rule was at work), and the stored rows are unchanged byte for byte (`warehouse.test.ts`);
  - the same for a crypt claim at the pack's last free slot.

## UI

- **Hub:** before the flag the Warehouse plaque says "locked" (not "later"); activating it says it opens once the town restores it, with a link to the town works. After the flag it links to `#/warehouse`. The flag comes from the 120 s world poll (`useOnboarding().worldFlags`), with the finished project on the board as an early hint; the server decides.
- **`#/warehouse`:** the building's niche as the header; two iron panels: *Your pack* (multi-select with quick picks, locked items pickable, "Store") and *On the shelves* (a fill meter, "Take out", the next extension with its price, "Extend"). Loading, closed (locked panel, link to `#/works`), error (retry), full ("Every shelf is taken") and success states; refusals in plain words, nothing moved. A pack over capacity gets a line saying the warehouse takes its valuables.
- **Pack banner (B.2's):** when the pack is full or over capacity it offers "Store in the Warehouse" once open, and otherwise says storage opens with the town works.

## Races

`warehouse.pg.test.ts` (real PostgreSQL, part of `test:pg`, three rounds each in varied orders, no retries):
- deposit, withdraw, sell, salvage, discard, two forge upgrades and a settle on one item: it is taken at most once, ends in exactly one place (gone, or where the last audited move left it), each forge 200 drew once, the hour is credited once, gold reconciles;
- a stored item racing sells, salvages, a mixed sell, a discard, an upgrade, an equip, a settle and another deposit: the row is unchanged and nothing was paid;
- three bulk deposits (6 + 6 + 4 items) racing two settles with 10 free shelves and a full pack: never above capacity, never a partial move, moved = audited, and the farming outcome is identical in every order (every request settles first);
- eight withdrawals into a pack with three free slots: exactly three succeed.

## Screenshots

`docs/screenshots/phase-4/`: `hub-warehouse-locked-*`, `warehouse-closed-*`, `warehouse-open-*`, `warehouse-full-*`, `pack-warehouse-*` (desktop and mobile), from `node tools/screenshots/warehouse.mjs` against dev servers on a scratch database (the script's header).
