# Tech stack — decision record

Status: accepted for Phase 0 (ticket 0.1). Revisit a decision by adding a dated entry under "Changes" rather than rewriting history.

## Summary

| Concern            | Decision                                                         |
| ------------------ | ---------------------------------------------------------------- |
| Language           | TypeScript 5.9.x everywhere, strict mode, ES modules             |
| Runtime            | Node 22 LTS                                                      |
| Repo               | pnpm workspace monorepo (`apps/*`, `packages/*`)                 |
| Gameplay rules     | `packages/game-core`, pure TS, no DOM/Node APIs                  |
| Backend            | Fastify 5, JSON REST under `/api`                                |
| Database           | PostgreSQL 16 + Drizzle ORM (`pg` driver), SQL migrations        |
| Web client         | Vite + React 19                                                  |
| Tests              | Vitest in every package; server routes via `app.inject()`; DB tests on PGlite |
| Lint / format      | ESLint flat config + typescript-eslint, Prettier                 |
| CI                 | GitHub Actions: format, lint, typecheck, test, build             |
| Desktop (Phase 7)  | Tauri wrapping the web build                                     |
| Mobile (long-term) | Responsive web first, Capacitor wrapper when a store app is due  |

## Decisions

### TypeScript 5.9.x, not 7.x
TS 7 (the native port) is available, but typescript-eslint and parts of the Vite/Vitest toolchain still target the 5.x API. 5.9 gives full tooling compatibility. Upgrade when typescript-eslint supports 7 officially.

### pnpm workspace monorepo
Server and client must share exactly the same rule and content code (GDD §16.1). A workspace makes `@worldforge/game-core` a normal dependency with no publishing step. pnpm's strict `node_modules` catches undeclared dependencies.

**Source vs. build resolution.** `game-core`'s `package.json` exports a custom `source` condition pointing at `src/index.ts`. Typecheck (`customConditions`), Vitest, Vite and `tsx` dev all resolve that condition, so no pre-build is needed during development. Production builds (`tsc -p tsconfig.build.json` for the server) ignore it and resolve `dist/`, which `pnpm -r build` produces first (topological order).

### Shared, UI-free `game-core`
All gameplay rules (combat, loot, offline progress, formulas) and content definitions (classes, rarities, slots, stats, later enemies/items/affixes/loot tables) live here as plain data plus pure functions. ESLint forbids DOM/Node globals and imports in this package. Randomness only goes through the seeded `createRng()`, never `Math.random()`, so the server can reproduce and audit any outcome from a stored seed.

### Fastify 5 backend
Fast, mature, schema-first (JSON Schema validation and serialisation built in), excellent TypeScript types, and `inject()` lets tests exercise routes without opening a port. The `buildApp()` factory keeps the app constructible in tests with no global state.

### Server authority
The server is the only source of truth for currency, items, combat outcomes, experience, offline progress and scores (GDD §9.3, §16.3). The client sends *intents* ("start activity in area X", "equip item Y") and renders the resulting state. The client may run `game-core` for previews (tooltips, comparisons), but such results are never submitted back. Valuable mutations run in database transactions and are written to an audit log.

### PostgreSQL + Drizzle (Phase 1)
Relational data (accounts, characters, item instances, inventory, ledgers) with strong transactional guarantees for economy operations. Drizzle is a thin, typed, SQL-first ORM with plain-SQL migrations — no heavy runtime and easy to reason about. Wired in ticket 1.1; see `docs/DATA_MODEL.md` for the schema.

- **Layout.** `apps/server/src/db/`: `schema.ts` (Drizzle tables, `snake_case` columns), `client.ts` (node-postgres pool), `migrate.ts` + `migrate-cli.ts`, `transaction.ts`, `audit.ts`, `uuid.ts`. Generated migrations live in `apps/server/drizzle/` (committed, excluded from Prettier).
- **Migrations.** Change `schema.ts`, run `pnpm db:generate` (drizzle-kit diffs the schema offline and writes a new numbered `.sql`), review the SQL, commit it. `pnpm db:migrate` (dev, tsx) / `pnpm --filter @worldforge/server db:migrate:prod` (built JS) apply pending migrations in one transaction; applied ones are tracked in `drizzle.__drizzle_migrations`, so running it on every deploy is safe. Migrations are forward-only; never edit an applied migration. The server does **not** migrate on startup (one explicit deploy step, no race between instances).
- **Driver-agnostic `Database` type.** Code takes `Database` / `Transaction` / `Executor` (`src/db/types.ts`), so the same repository code runs on node-postgres in production and on PGlite in tests. `app.db` is the decorated instance; the caller of `buildApp({ database })` owns the connection lifecycle.
- **Transactions.** Every value-changing operation goes through `withTransaction(db, fn, { isolationLevel })`. It commits on success, rolls back on any throw, and re-runs the whole callback on serialization failure / deadlock (SQLSTATE `40001`, `40P01`; 3 attempts by default), so callbacks must have no side effects outside the transaction. Economy operations should use `serializable` or explicit row locks (decided per ticket). `writeAudit(tx, …)` appends an `audit_log` row inside the same transaction.
- **IDs.** UUIDv7 generated in the app (`uuidv7()`), because PostgreSQL 16/17 has no built-in `uuidv7()`.
- **Health.** `GET /api/health` pings the database (`select 1`, 2 s timeout) and returns `200 {status:'ok', db:'up'}` or `503 {status:'degraded', db:'down'}`. The server fails fast at startup if `DATABASE_URL` is missing or the database is unreachable, and survives later outages (idle pool errors are logged, not fatal).

### Test database: PGlite
Database tests run against **PGlite** (`@electric-sql/pglite`): the real PostgreSQL engine compiled to WASM, in-process and in-memory. Each test file gets a fresh database with all migrations applied (`createTestDatabase()` in `apps/server/src/test/db.ts`), so the tests exercise real Postgres semantics — constraints, `lower()` unique indexes, FK actions, `jsonb`, isolation levels — with no Docker, network or shared state, in the sandbox and in CI alike.
Limits: PGlite is a single connection, so true multi-connection concurrency (row locks, serialization conflicts between two sessions) cannot be exercised there; the retry path is unit-tested with a fake. Real-server coverage comes from CI, which also starts a `postgres:16` service container and applies the migrations from scratch (twice, for idempotency) with the production build. Each test file migrates its PGlite database in `beforeAll`; `hookTimeout` is 60 s because a cold container exceeded the 10 s default (ticket 1.9).

### Concurrency tests on real PostgreSQL (ticket 1.9)
`apps/server/src/concurrency.pg.test.ts` reruns the races with a connection pool, so transactions really overlap: concurrent settles (one credit per window), settle/stop/start, start races (one activity per account), slot-limit and name races on character creation, duplicate registration, equip and ring races, and settle racing equip/unequip/discard. A first test asserts that four `pg_sleep(0.3)` transactions finish in under a second, so a serialising setup cannot pass silently; a last one asserts that the races needed no transaction retry (`transactionStats.retries`), because a retry is a deadlock or serialization failure that the retry loop would otherwise hide. Removing the account `FOR UPDATE` in character creation makes the slot-limit test fail here while the PGlite suite stays green.
- Runs when `DATABASE_URL` is set: `DATABASE_URL=postgres://… pnpm --filter @worldforge/server test:pg` (also part of `pnpm test`). It creates a throwaway database `wf_test_<random>` next to the URL's database (the role needs `CREATEDB`; the docker-compose and CI users are superusers), migrates it and drops it afterwards; the URL's own database is never touched.
- Skipped when `DATABASE_URL` is unset (the `checks` job, most sandboxes). CI runs it in the `migrations` job against the Postgres service with `REQUIRE_PG_TESTS=1`, which turns a missing URL into a failure instead of a skip.

### End-to-end run (tickets 1.8, 1.9)
The Phase 1 exit criteria are covered twice: `apps/server/src/e2e/exit-criteria.test.ts` runs the whole flow through the HTTP API with a simulated clock in the normal test suite (including a 5 h absence against the 3 h cap and audit-log reconciliation), and the browser run below is CI job `e2e` (~1.5 min; screenshots and server logs are uploaded as an artifact).
`tools/e2e/farm-loop.mjs` drives the real UI and server with Playwright: register → create character → farm → loot → equip → log out → log in later → return summary, at 1440 and 390 px, and saves screenshots to `docs/screenshots/phase-1/`. Sandboxes without Docker run the server through **`pnpm --filter @worldforge/server e2e:serve`** (`apps/server/src/e2e/serve.ts`): the real `buildApp()` on an in-process PGlite database (fresh on every start). The only differences are server-side: the **farming clock runs `E2E_TIME_SCALE` times faster** (default 120; sessions, cookies and rate limits keep the real clock) and scheduled settlement runs every `E2E_SETTLE_INTERVAL_SECONDS` (default 5). Auth and validation are unchanged, and the client still only sends intents. The file is excluded from the production build (`tsconfig.build.json`) and refuses to start with `NODE_ENV=production`; `src/index.ts` is untouched.

```
OFFLINE_CAP_SECONDS=1800 pnpm --filter @worldforge/server e2e:serve   # small cap, so the return shows capped time
pnpm --filter @worldforge/web dev
node tools/e2e/farm-loop.mjs
```

The first-session flow (ticket 2.7) has its own browser run, CI job `e2e-first-session`: `tools/e2e/first-session.mjs` registers, forges a hero and follows the guide's own links (fields → first drop → Pack → equip → Tavern), checks the "what continues offline" note shows the server's cap, waits for the level-up, quest-complete and area-unlocked notices, closes the guide and checks it stays closed after a reload and a fresh login, and checks the world map list's state labels sit on the name row. On phones it also hides and reopens the guide from the status bar. It needs a faster clock so the notices arrive within minutes; screenshots go to `docs/screenshots/phase-2/`.

```
E2E_TIME_SCALE=600 OFFLINE_CAP_SECONDS=36000 pnpm --filter @worldforge/server e2e:serve
pnpm --filter @worldforge/web dev
node tools/e2e/first-session.mjs
```

The Phase 2 exit criteria (ticket 2.8) are covered the same two ways. `apps/server/src/e2e/phase2-exit-criteria.test.ts` plays a warrior through the HTTP API with a simulated clock and no database shortcuts (≈32 game hours, ~5 s): Fields → every area as levels come, equipping better drops → materials and a profession → all five story quests and contracts → buy, sell, salvage, craft → crypt runs until the Gravewarden falls → the Sunken Abbey opens and is farmed; then every gold piece, item and material held is reconciled with the audit log. `E2E_CLASS=mage` (etc.) plays another class. The browser run, CI job `e2e-phase2` (~3 min), is `tools/e2e/phase2-exit.mjs`: one desktop session uses the UI for the first use of each feature (map, Pack, Tavern, Merchant, Forge, crypt) and drives the grind in between from the page with its own session through the same public API; a mobile context of the same account captures the map and the Abbey. It imports the item bases from the built game-core.

```
E2E_TIME_SCALE=1200 OFFLINE_CAP_SECONDS=360000 pnpm --filter @worldforge/server e2e:serve
pnpm --filter @worldforge/web dev
pnpm --filter @worldforge/game-core build
node tools/e2e/phase2-exit.mjs
```

### Local playtest without Docker (ticket P.1)
`pnpm playtest` runs `apps/server/src/playtest/serve.ts`: the real `buildApp()` on a PGlite database persisted to `.playtest-data/` (git-ignored), plus the web dev server, for playtesting on a machine without Docker or PostgreSQL. Like the e2e server it is excluded from the production build and refuses `NODE_ENV=production`; auth and rules are unchanged. Optional fast time (`pnpm playtest:fast`, `PLAYTEST_TIME_SCALE`) speeds up only the server's farming clock and never runs it backwards across restarts. User guide and details: `docs/PLAYTEST.md`.

### Local database: Docker Compose
`docker-compose.yml` at the repo root runs `postgres:16-alpine` on `127.0.0.1:5432` with local-only credentials matching `apps/server/.env.example`. `pnpm db:up` / `pnpm db:down` start and stop it. Any other PostgreSQL ≥ 16 works by pointing `DATABASE_URL` at it.

### Authentication (ticket 1.2)
Owner decision (GDD v0.3): real registration and login from Phase 1, no development identity. Email + password, hashed with **argon2id** via `@node-rs/argon2` (prebuilt native binaries, no build step; Node 22 has no built-in argon2). Sessions are opaque random tokens in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie scoped to `/api`, stored server-side as a SHA-256 hash so they can be revoked; no JWTs. Browsers accept `Secure` cookies on `http://localhost`, so local development uses the same flags (`SESSION_COOKIE_SECURE=0` exists only for plain-http hosts other than localhost). Code lives in `apps/server/src/auth/`; gameplay code depends only on `request.auth.account.id` from `app.requireAccount`, so adding OAuth later does not touch game logic.
Rate limits use `@fastify/rate-limit` with its in-memory store, which is correct for the single API instance assumed below; a horizontally scaled deployment needs a shared store (Redis or Postgres).
Not in scope yet (follow-ups): email verification, password reset, OAuth, "log out everywhere", sliding session renewal, pruning expired session rows, and argon2 parameter upgrades on login.

### Vite + React 19 web client
React has the broadest ecosystem and hiring familiarity; the UI is panel- and list-heavy rather than a real-time canvas game, so a DOM UI with CSS pixel-art rendering (`image-rendering: pixelated`, integer scaling) fits. Vite gives fast HMR and a simple static production build. Visual design is defined by the design system (ticket 0.3), not a component library, to avoid a generic look (GDD §3.2).

### Hosting assumptions
- Web client: static files on a CDN (any static host).
- API: a single Node 22 process behind HTTPS (a container on a managed platform). Stateless apart from the database, so it can scale horizontally later.
- Database: managed PostgreSQL with daily backups and point-in-time recovery.
- Same-origin deployment (`/api` reverse-proxied next to the static client) is preferred to avoid CORS and keep cookies simple; development mirrors this with the Vite proxy.
- Config via environment variables only (`PORT`, `HOST`, `LOG_LEVEL`, `DATABASE_URL`, `DATABASE_POOL_MAX`, `SESSION_TTL_HOURS`, `SESSION_COOKIE_SECURE`, `TRUST_PROXY`); secrets never committed. `pnpm dev` / `start` / `db:migrate` also read `apps/server/.env` if present (Node `--env-file-if-exists`).

### Desktop: Tauri
Wraps the same web build in a native window with a small footprint (system webview instead of bundled Chromium). Electron stays the fallback if a webview incompatibility appears (GDD §2). Gameplay remains server-side, so the shell adds no game logic.

### Mobile: responsive web, then Capacitor
Layouts are responsive from Phase 0 (down to ~375px) with touch-sized targets. When store apps are needed, Capacitor wraps the same client with minimal native glue, keeping one codebase and the shared backend.

## Changes
- 2026-11-04 — real-PostgreSQL concurrency tests (`test:pg`, CI `migrations` job) and the browser exit-criteria run as CI job `e2e` (ticket 1.9).
- 2026-11-04 — initial record (ticket 0.1).
- 2026-11-04 — e2e test server on PGlite with a scaled farming clock (ticket 1.8).
- 2026-11-04 — PostgreSQL + Drizzle wired, PGlite chosen for tests, Docker Compose for local dev (ticket 1.1).
