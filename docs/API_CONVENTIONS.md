# API conventions

Applies to every endpoint served by `apps/server`. Implemented so far: `GET /api/health`, `GET /api/content`, the 404 handler and the error handler (`apps/server/src/errors.ts`).

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
- Every route declares JSON Schemas for `params`, `querystring` and `body` (Fastify's built-in Ajv). Unknown body properties are rejected (`additionalProperties: false`). Response schemas are declared so serialisation strips unexpected fields.
- Schema validation only checks shape. Game rules (ownership, slot eligibility, affordability, cooldowns) are checked on the server against stored state and return `4xx` domain codes.
- The server never accepts client-computed outcomes: no currency amounts, item rolls, combat results, damage numbers or scores in request bodies (GDD §16.3). Clients send intents and IDs only.

## Idempotency
- Every state-changing `POST`/`PATCH`/`DELETE` that grants, spends or moves value (claiming offline rewards, equipping, selling, crafting) requires an `Idempotency-Key` header (a client-generated UUID).
- The server stores `(accountId, key) → request hash + response` for 24 hours inside the same transaction as the mutation. A retry with the same key and body returns the stored response; the same key with a different body returns `409 idempotency_conflict`.
- Reward grants are additionally guarded by state (e.g. an offline-progress window can be claimed once, enforced by a unique constraint), so a lost idempotency record cannot duplicate loot.

## Auth & sessions
- Session via an HTTP-only, `Secure`, `SameSite=Lax` cookie. The handler resolves it to an `accountId`; no route trusts an account or character id from the body without an ownership check.
- The Phase 1 development identity follows the same cookie flow (see `docs/TECH_STACK.md`).

## Observability
- Each request gets a request id (Fastify `reqId`), included in logs; later echoed as `X-Request-Id`.
- Structured JSON logs (pino). No personal data beyond the account id in logs.

## Implemented endpoints

| Method | Path           | Response                                                          |
| ------ | -------------- | ----------------------------------------------------------------- |
| GET    | `/api/health`  | `{ "status": "ok", "uptimeSeconds": number }`                     |
| GET    | `/api/content` | `GameContent` from `@worldforge/game-core` (classes, resources, rarities, equipment slots, stats, `version`) |
