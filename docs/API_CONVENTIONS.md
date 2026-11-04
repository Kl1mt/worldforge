# API conventions

Applies to every endpoint served by `apps/server`. Implemented so far: health, content, the account/auth endpoints (ticket 1.2), the character endpoints (ticket 1.3), the farming endpoints (ticket 1.6), the inventory & equipment endpoints (ticket 1.7), the merchant and forge endpoints with the `Idempotency-Key` mechanism (ticket 2.6), the 404 handler and the error handler (`apps/server/src/errors.ts`; throw `ApiError(status, code, message, details?)` for deliberate failures).

## Basics
- REST over HTTPS, JSON request and response bodies (`application/json; charset=utf-8`).
- Everything lives under `/api`. Breaking changes get a new prefix (`/api/v2`) rather than silently changing shapes; additive changes (new fields) are allowed.
- Resource paths are plural nouns in kebab-case: `/api/characters/:characterId/inventory`. Actions that are not plain CRUD use a verb sub-resource: `POST /api/characters/:id/activity`.
- JSON fields are `camelCase`. IDs are opaque strings (UUIDv7). Timestamps are ISO 8601 UTC strings (`2026-11-04T12:00:00.000Z`). Money-like values (gold) are integers, never floats.
- Methods: `GET` (safe, cacheable), `POST` (create or action), `PATCH` (partial update), `DELETE`. `PUT` is avoided.

## Success responses
- `200` with the resource or result object; `201` for creation (with the created resource); `204` with no body for deletions.
- Bodies are objects, never bare arrays, so fields can be added later: `{ "items": [...], "nextCursor": "..." }`.
- Lists use cursor pagination (`?cursor=&limit=`), default limit 50, max 200.

## Error envelope
Every non-2xx response has this shape:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Human-readable summary, safe to show in a log or dev tool",
    "details": {}
  }
}
```

- `code` is a stable, machine-readable snake_case identifier; clients branch on it, never on `message`.
- `details` is optional (e.g. per-field validation errors).
- 5xx responses never leak internals: they return `internal_error` and the real error is logged with the request id.

| Status | Typical `code`                   | Meaning                                                     |
| ------ | -------------------------------- | ----------------------------------------------------------- |
| 400    | `validation_failed`              | Body/query/params failed schema validation                  |
| 401    | `unauthenticated`                | No or invalid session                                       |
| 403    | `forbidden`                      | Authenticated, but not allowed (not used for other accounts' resources, see 404) |
| 404    | `not_found`                      | Route or resource does not exist — **also for another account's resource** (ticket 1.9), so ids can't be probed |
| 409    | `conflict` / `idempotency_conflict` | State conflict, or idempotency key reused with another body |
| 422    | domain codes, e.g. `slot_mismatch`, `insufficient_gold` | Valid request that the game rules reject |
| 429    | `rate_limited`                   | Too many requests                                           |
| 500    | `internal_error`                 | Unexpected server error                                     |

## Validation
- Every route declares JSON Schemas for `params`, `querystring` and `body` (Fastify's built-in Ajv). Unknown body properties are rejected (`additionalProperties: false`; `buildApp` sets Ajv's `removeAdditional: false` so they are not silently stripped). Response schemas are declared so serialisation strips unexpected fields.
- Schema validation only checks shape. Game rules (ownership, slot eligibility, affordability, cooldowns) are checked on the server against stored state and return `4xx` domain codes.
- The server never accepts client-computed outcomes: no currency amounts, item rolls, combat results, damage numbers or scores in request bodies (GDD §16.3). Clients send intents and IDs only.

## Idempotency
Implemented in ticket 2.6 (`apps/server/src/idempotency/`). Endpoints that are idempotent by state keep working without the header (Phase 1, ticket 1.9 review): settle credits elapsed server time once (row locks; a repeat credits ~0 and returns an empty summary); start is a no-op for the same area; stop/settle without an activity answer `409 not_farming`; equip into the current slot and unequip of an inventory item are no-ops; a second discard of the same item is `404`; register and character creation are guarded by unique indexes (`409`).

Endpoints that grant, spend or move value and are **not** repeat-safe by state require an `Idempotency-Key` header: merchant buy and sell, forge salvage and craft (2.6); quest turn-in and dungeon claim (2.4, 2.5) use the same helper.

- The client sends a fresh UUID per intended action and reuses it only to retry that same action after a network error or a 5xx (the web client's `ActionKeys`). Keys are 8–128 visible ASCII characters; a missing key is `400 idempotency_key_required`, a malformed one `400 validation_failed`.
- Handlers call `idempotentTransaction(app, request, reply, { now }, fn)` instead of `withTransaction`. It inserts `(accountId, key, request hash)` into `idempotency_keys` at the start of the mutation's transaction, runs `fn`, and stores the response before commit. The request hash covers method, path and the canonical JSON body.
- A retry with the same key and request returns the stored status and body with `Idempotency-Replayed: true`, without running the handler. A concurrent duplicate waits on the key's unique index until the first commits, then replays. The same key with another method, path or body is `409 idempotency_conflict`.
- Only successes are stored: a failed request rolls back the claim with everything else, so it changed nothing and may be retried with the same key.
- Keys are per account and live 24 hours; an expired key is taken over by a new request, and the settlement scheduler prunes expired rows hourly.
- Value grants are additionally guarded by state (row locks, `merchant_purchases` primary key, `CHECK` constraints on gold and material quantities), so a lost idempotency record cannot duplicate value.

## Auth & sessions
- Session via the `wf_session` cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/api`, expiring with the session. The value is a random 256-bit token; the database stores only its SHA-256 (`sessions.id`).
- Routes that need a player use `preHandler: app.requireAccount`, then read `request.auth.account` (and `request.auth.sessionId`). It answers `401 unauthenticated` and clears a stale cookie when the session is missing, unknown, revoked or expired. No route trusts an account or character id from the body without an ownership check.
- Sessions have a fixed lifetime from login (`SESSION_TTL_HOURS`, default 30 days; no sliding renewal yet). Logout revokes the row (`revoked_at`) and clears the cookie.
- Failed logins always return the same `401 invalid_credentials` body, whether the email is unknown or the password is wrong, and unknown emails still run an argon2 verification so timing matches. Registration does reveal `409 email_taken` (there is no email verification yet to send a "you already have an account" mail instead); it is rate-limited.
- Rate limits (`@fastify/rate-limit`, per client IP, in-process memory): login 10/minute, register 5/hour. Over the limit: `429 rate_limited` with `Retry-After` and `details.retryAfterSeconds`. Behind a reverse proxy set `TRUST_PROXY=1` so the IP comes from `X-Forwarded-For`.

## Observability
- Each request gets a request id (Fastify `reqId`), included in logs; later echoed as `X-Request-Id`.
- Structured JSON logs (pino). No personal data beyond the account id in logs.

## Implemented endpoints

| Method | Path           | Response                                                          |
| ------ | -------------- | ----------------------------------------------------------------- |
| GET    | `/api/health`  | `{ "status": "ok", "uptimeSeconds": number }`                     |
| GET    | `/api/content` | `GameContent` from `@worldforge/game-core` (classes, resources, rarities, equipment slots, stats, `version`) |
| POST   | `/api/auth/register` | Body `{ email, displayName, password }` → `201 { account }` + session cookie. `400 validation_failed` with `details.fields` (per-field messages), `409 email_taken` / `display_name_taken`, `429 rate_limited` |
| POST   | `/api/auth/login` | Body `{ email, password }` → `200 { account }` + session cookie. `401 invalid_credentials`, `429 rate_limited` |
| POST   | `/api/auth/logout` | `204`, revokes the session and clears the cookie; idempotent (also `204` without a session) |
| GET    | `/api/account` | `200 { account }` for the session's account, else `401 unauthenticated` |
| GET    | `/api/characters` | `200 { characters, slots: { used, total }, activeCharacterId }` — the account's characters, oldest first. Not paginated: bounded by the slot count |
| POST   | `/api/characters` | Body `{ name, classId, appearance: { banner } }` → `201 { character }`; the new character becomes active. `400 validation_failed` (`details.fields`: `name`, `classId`, `appearance.banner`), `409 character_name_taken`, `422 no_free_slot` (`details.slots`) |
| GET    | `/api/characters/:characterId/activity` | `200 { activity, character }`; `activity` is `{ characterId, areaId, pendingAreaId, startedAt, settledAt, health }` or null (`health`: hit points carried between settlements, null = full; added in ticket 1.8. `pendingAreaId`: where the hero travels once the fight in progress ends, null = none; ticket 2.2). Read-only: does not settle |
| POST   | `/api/characters/:characterId/activity` | Body `{ areaId }` → `201 { activity, character }` (or `200` if already farming; another area switches after settling, at once between cycles or as `pendingAreaId` mid-cycle, see `docs/FARMING.md`). Stops the account's other activity. `400 validation_failed` (`details.fields.areaId`), `409 character_not_active`, `409 area_locked` (`details: { areaId, blockers }`, blockers as in the world state) |
| GET    | `/api/characters/:characterId/world` | `200 { characterId, level, progress: { gravewardenDefeated }, current: { areaId, pendingAreaId } \| null, areas: [{ id, unlocked, blockers }], dungeons: [{ id, unlocked, blockers, available }] }` (ticket 2.2). `blockers` are game-core `UnlockBlocker`s in a stable order (`{ kind: 'level', required }`, then `{ kind: 'gravewardenDefeated' }`); `available`: runs can be started (true since ticket 2.5). Read-only: does not settle |
| GET    | `/api/characters/:characterId/materials` | `200 { characterId, materials: [{ materialId, quantity }], professions: [{ professionId, level, xp, xpToNext, maxLevel }] }` (ticket 2.3). `materials` lists held stacks (quantity > 0) in content order; `professions` lists every profession (missing rows are level 1). Read-only: does not settle; materials are granted only by settlement |
| GET    | `/api/characters/:characterId/merchant` | `200 { characterId, day, restocksAt, gold, offers: [{ offerId, areaId, item: { baseId, rarityId, itemLevel, affixes }, price, soldOut }], sellPrices: [{ itemId, price }] }` (ticket 2.6). Today's stock (UTC day) for the unlocked areas and what the merchant pays for each unequipped item. Read-only |
| POST   | `/api/characters/:characterId/merchant/buy` | **Idempotency-Key.** Body `{ offerId }` → `200 { character, item, inventory }`. `404 not_found` (unknown, malformed or locked-area offer), `409 offer_sold_out`, `409 offer_expired` (an earlier day), `422 inventory_full` (`details.capacity`), `422 insufficient_gold` (`details: { required, held }`) |
| POST   | `/api/characters/:characterId/merchant/sell` | **Idempotency-Key.** Body `{ itemIds }` (1–100 distinct ids) → `200 { character, goldGained, inventory }`. All or nothing: `404 not_found` for an id that isn't this character's (`details.itemId`), `409 item_equipped` |
| GET    | `/api/characters/:characterId/forge` | `200 { characterId, gold, materials, recipes: [{ recipeId, name, description, tier, level, gold, materials, slots, blockers }], salvage: [{ itemId, gold, materials }] }` (ticket 2.6). `materials` lists are `[{ materialId, quantity }]`; `blockers` are game-core `CraftBlocker`s (`level`, `gold`, `material`). Read-only |
| POST   | `/api/characters/:characterId/forge/salvage` | **Idempotency-Key.** Body `{ itemIds }` → `200 { character, salvaged: { gold, materials }, inventory, materials }`. Same `404`/`409` rules as sell |
| POST   | `/api/characters/:characterId/forge/craft` | **Idempotency-Key.** Body `{ recipeId, slot }` (`slot` an `ItemSlotKind`, e.g. `ring`) → `200 { character, item, inventory, materials }`. `400` unknown recipe or slot, `422 wrong_slot` (the recipe makes nothing there for the class), `422 recipe_locked` / `insufficient_materials` / `insufficient_gold` (`details.blockers`), `422 inventory_full` |
| POST   | `/api/characters/:characterId/activity/settle` | `200 { activity, character, summary }`: settles from server time and returns the return summary since the previous call (see `docs/FARMING.md`). `409 not_farming` |
| POST   | `/api/characters/:characterId/activity/stop` | `200 { activity: null, character, summary }`: settles, then stops. `409 not_farming` |
| POST   | `/api/characters/:characterId/select` | `200 { character }` and makes it the account's active character. `404 not_found` for a missing or another account's character (ticket 1.9: no `403`, so ids can't be probed), `400` for a malformed id |
| GET    | `/api/characters/:characterId/inventory` | `200 { equipped, inventory, stats }` — equipped items in canonical slot order, unequipped items oldest first, and the character's effective stats with that equipment (derived server-side). Not paginated: bounded by inventory capacity (ticket 1.6). `404 not_found` for a missing or another account's character |
| POST   | `/api/characters/:characterId/items/:itemId/equip` | Optional body `{ slot }` (an `EquipmentSlotId`) → `200` inventory body. Without `slot` the item's only slot is used; a ring goes to the first free of `ring1`/`ring2` (else `ring1`), an already equipped item stays put. The previous occupant of the slot goes back to the inventory, except that moving an equipped ring onto the other ring slot swaps the two rings. Equipping into the current slot is a no-op. `422 wrong_slot` / `wrong_class` / `item_unusable` (base no longer in content), `400` for an unknown slot or extra fields, `404 not_found` if the item isn't this character's |
| POST   | `/api/characters/:characterId/items/:itemId/unequip` | `200` inventory body; no-op for an item already in the inventory. Same `404` rules |
| GET    | `/api/characters/:characterId/dungeon` | `200 { dungeons: [{ id, unlocked, blockers, bossLootReadyAt }], run, busyCharacterId, character }` (ticket 2.5, `docs/DUNGEONS.md`). `run` is this character's unclaimed run `{ id, characterId, dungeonId, startedAt, endsAt, now, bossLootEligible, progress }` or null; `progress` is game-core `DungeonRunProgress` up to server time (last 40 events, `outcome` null until finished). `busyCharacterId`: another hero of the account with an unclaimed run. Read-only |
| POST   | `/api/characters/:characterId/dungeon` | Body `{ dungeonId }` → `201 { run, character }`. Settles and stops the account's farming first. `400 validation_failed`, `409 character_not_active`, `409 dungeon_locked` (`details: { dungeonId, blockers }`), `409 dungeon_run_open` (`details: { characterId, runId }`) |
| POST   | `/api/characters/:characterId/dungeon/settle` | `200 { run }`: reveals the run up to now; writes nothing. `409 no_dungeon_run` |
| POST   | `/api/characters/:characterId/dungeon/claim` | Header `Idempotency-Key` → `200 { result, character }`; `result` is `{ runId, dungeonId, outcome, durationMs, roomsCleared, totalRooms, kills, xpGained, levelsGained, goldGained, goldSalvaged, items: [{ id, baseId, rarityId, itemLevel }], itemsSalvaged, materials, bossDefeated, bossLoot, firstBossKill, questEvents }`. `400 idempotency_key_required`, `409 run_in_progress` (`details.endsAt`), `409 no_dungeon_run`, `409 idempotency_conflict`. Farming start answers `409 in_dungeon` (`details: { characterId, runId }`) while the account has an unclaimed run |
| DELETE | `/api/characters/:characterId/items/:itemId` | Discards (deletes) an inventory item → `200` inventory body. `409 item_equipped` if it is equipped (unequip first). Same `404` rules |

`account` is `{ id, email, displayName, characterSlots, createdAt }`. Registration rules (`apps/server/src/auth/validation.ts`): email trimmed, `x@y.tld` shape, ≤ 254 chars, unique case-insensitively; display name trimmed, 3–20 letters/digits with single spaces, `-`, `'` or `_` inside, unique case-insensitively; password 10–128 characters and not equal to the email. Passwords are hashed with argon2id (`@node-rs/argon2`, 19 MiB, t=2, p=1).

`character` is `{ id, name, classId, appearance: { banner }, level, experience, gold, createdAt }`. Clients never send level, experience or gold; unknown body fields are rejected. All character routes require a session.

Activity and world routes return `404 not_found` for another account's character (no distinction from a missing one).

`item` is `{ id, baseId, rarityId, itemLevel, affixes: [{ affixId, tier, value }], equippedSlot, source, createdAt }` (no seed). `stats` is a game-core `StatBlock`. Clients send item ids and slots only; items are created only by the server (loot, ticket 1.6). Every inventory change locks the character row in one transaction, so changes to one character are serialized; the partial unique index on `(character_id, equipped_slot)` is the database backstop (a clash would surface as `409 slot_conflict`). An item id under another character's path is `404`, so item ids can't be probed.

Equip, unequip, discard, merchant buy/sell and forge salvage/craft first settle the character's running activity (as client contact), so the time before the change is credited with the gear that was worn (ticket 1.9, `docs/FARMING.md`).

Audit events: `activity.start` (`data.areaId`; on a switch also `from`, plus `pending: true` when it was deferred behind the cycle in progress and `deferred: true` when a settlement applied it), `activity.stop`, `activity.reward` (per settlement with a reward: credited/capped ms, kills, xp, gold, items, salvaged, epic+ items with seeds), `item.discard` (`data`: item id, base, rarity, item level, seed; equip/unequip are not audited because they move no value), `merchant.buy` (offer id, price, the new item with its seed, gold after), `merchant.sell` (gold, gold after, each item with seed and price), `forge.salvage` (gold, materials, each item with seed), `forge.craft` (recipe, slot, gold and materials spent, the new item with its seed), `character.create` (character id, `data.classId`), `account.register`, `auth.login`, `auth.login_failed` (`data.reason`: `unknown_email` / `bad_password`; account id when known), `auth.logout`. No emails, IPs or passwords are written to the audit log.
