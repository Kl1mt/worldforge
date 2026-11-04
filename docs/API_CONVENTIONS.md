# API conventions

Applies to every endpoint served by `apps/server`. Implemented so far: health, content, the account/auth endpoints (ticket 1.2), the character endpoints (ticket 1.3), the inventory & equipment endpoints (ticket 1.7), the 404 handler and the error handler (`apps/server/src/errors.ts`; throw `ApiError(status, code, message, details?)` for deliberate failures).

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
| 403    | `forbidden`                      | Authenticated, but not allowed (e.g. someone else's char)   |
| 404    | `not_found`                      | Route or resource does not exist                            |
| 409    | `conflict` / `idempotency_conflict` | State conflict, or idempotency key reused with another body |
| 422    | domain codes, e.g. `slot_mismatch`, `insufficient_gold` | Valid request that the game rules reject |
| 429    | `rate_limited`                   | Too many requests                                           |
| 500    | `internal_error`                 | Unexpected server error                                     |

## Validation
- Every route declares JSON Schemas for `params`, `querystring` and `body` (Fastify's built-in Ajv). Unknown body properties are rejected (`additionalProperties: false`; `buildApp` sets Ajv's `removeAdditional: false` so they are not silently stripped). Response schemas are declared so serialisation strips unexpected fields.
- Schema validation only checks shape. Game rules (ownership, slot eligibility, affordability, cooldowns) are checked on the server against stored state and return `4xx` domain codes.
- The server never accepts client-computed outcomes: no currency amounts, item rolls, combat results, damage numbers or scores in request bodies (GDD §16.3). Clients send intents and IDs only.

## Idempotency
- Every state-changing `POST`/`PATCH`/`DELETE` that grants, spends or moves value (claiming offline rewards, equipping, selling, crafting) requires an `Idempotency-Key` header (a client-generated UUID).
- The server stores `(accountId, key) → request hash + response` for 24 hours inside the same transaction as the mutation. A retry with the same key and body returns the stored response; the same key with a different body returns `409 idempotency_conflict`.
- Reward grants are additionally guarded by state (e.g. an offline-progress window can be claimed once, enforced by a unique constraint), so a lost idempotency record cannot duplicate loot.

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
| POST   | `/api/characters/:characterId/select` | `200 { character }` and makes it the account's active character. `403 forbidden` for another account's character, `404 not_found`, `400` for a malformed id |
| GET    | `/api/characters/:characterId/inventory` | `200 { equipped, inventory, stats }` — equipped items in canonical slot order, unequipped items oldest first, and the character's effective stats with that equipment (derived server-side). Not paginated: bounded by inventory capacity (ticket 1.6). `403 forbidden` for another account's character, `404 not_found` |
| POST   | `/api/characters/:characterId/items/:itemId/equip` | Optional body `{ slot }` (an `EquipmentSlotId`) → `200` inventory body. Without `slot` the item's only slot is used; a ring goes to the first free of `ring1`/`ring2` (else `ring1`), an already equipped item stays put. The previous occupant of the slot goes back to the inventory, except that moving an equipped ring onto the other ring slot swaps the two rings. Equipping into the current slot is a no-op. `422 wrong_slot` / `wrong_class` / `item_unusable` (base no longer in content), `400` for an unknown slot or extra fields, `404 not_found` if the item isn't this character's |
| POST   | `/api/characters/:characterId/items/:itemId/unequip` | `200` inventory body; no-op for an item already in the inventory. Same `403`/`404` rules |
| DELETE | `/api/characters/:characterId/items/:itemId` | Discards (deletes) an inventory item → `200` inventory body. `409 item_equipped` if it is equipped (unequip first). Same `403`/`404` rules |

`account` is `{ id, email, displayName, characterSlots, createdAt }`. Registration rules (`apps/server/src/auth/validation.ts`): email trimmed, `x@y.tld` shape, ≤ 254 chars, unique case-insensitively; display name trimmed, 3–20 letters/digits with single spaces, `-`, `'` or `_` inside, unique case-insensitively; password 10–128 characters and not equal to the email. Passwords are hashed with argon2id (`@node-rs/argon2`, 19 MiB, t=2, p=1).

`character` is `{ id, name, classId, appearance: { banner }, level, experience, gold, createdAt }`. Clients never send level, experience or gold; unknown body fields are rejected. All character routes require a session.

`item` is `{ id, baseId, rarityId, itemLevel, affixes: [{ affixId, tier, value }], equippedSlot, source, createdAt }` (no seed). `stats` is a game-core `StatBlock`. Clients send item ids and slots only; items are created only by the server (loot, ticket 1.6). Every inventory change locks the character row in one transaction, so changes to one character are serialized; the partial unique index on `(character_id, equipped_slot)` is the database backstop (a clash would surface as `409 slot_conflict`). An item id under another character's path is `404`, so item ids can't be probed.

Audit events: `item.discard` (`data`: item id, base, rarity, item level, seed; equip/unequip are not audited because they move no value), `character.create` (character id, `data.classId`), `account.register`, `auth.login`, `auth.login_failed` (`data.reason`: `unknown_email` / `bad_password`; account id when known), `auth.logout`. No emails, IPs or passwords are written to the audit log.
