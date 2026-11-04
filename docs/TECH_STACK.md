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
Limits: PGlite is a single connection, so true multi-connection concurrency (row locks, serialization conflicts between two sessions) cannot be exercised there; the retry path is unit-tested with a fake. Real-server coverage comes from CI, which also starts a `postgres:16` service container and applies the migrations from scratch (twice, for idempotency) with the production build. Tickets that need multi-connection concurrency tests (1.6, 1.7) should run them against that service container.

### Local database: Docker Compose
`docker-compose.yml` at the repo root runs `postgres:16-alpine` on `127.0.0.1:5432` with local-only credentials matching `apps/server/.env.example`. `pnpm db:up` / `pnpm db:down` start and stop it. Any other PostgreSQL ≥ 16 works by pointing `DATABASE_URL` at it.

### Dev identity vs. real auth
Phase 1 starts with a **development identity**: a dev-only endpoint issues a session for a named test account. It is enabled only when `NODE_ENV !== 'production'` *and* an explicit `DEV_AUTH=1` flag is set, lives in its own module, and is covered by a test that asserts it is unreachable in production config. Real authentication (email/password with Argon2id or an OAuth provider, HTTP-only secure session cookies) replaces it before any public deployment. Gameplay code depends only on an `accountId` from the session, so swapping auth does not touch game logic.

### Vite + React 19 web client
React has the broadest ecosystem and hiring familiarity; the UI is panel- and list-heavy rather than a real-time canvas game, so a DOM UI with CSS pixel-art rendering (`image-rendering: pixelated`, integer scaling) fits. Vite gives fast HMR and a simple static production build. Visual design is defined by the design system (ticket 0.3), not a component library, to avoid a generic look (GDD §3.2).

### Hosting assumptions
- Web client: static files on a CDN (any static host).
- API: a single Node 22 process behind HTTPS (a container on a managed platform). Stateless apart from the database, so it can scale horizontally later.
- Database: managed PostgreSQL with daily backups and point-in-time recovery.
- Same-origin deployment (`/api` reverse-proxied next to the static client) is preferred to avoid CORS and keep cookies simple; development mirrors this with the Vite proxy.
- Config via environment variables only (`PORT`, `HOST`, `LOG_LEVEL`, `DATABASE_URL`, `DATABASE_POOL_MAX`); secrets never committed. `pnpm dev` / `start` / `db:migrate` also read `apps/server/.env` if present (Node `--env-file-if-exists`).

### Desktop: Tauri
Wraps the same web build in a native window with a small footprint (system webview instead of bundled Chromium). Electron stays the fallback if a webview incompatibility appears (GDD §2). Gameplay remains server-side, so the shell adds no game logic.

### Mobile: responsive web, then Capacitor
Layouts are responsive from Phase 0 (down to ~375px) with touch-sized targets. When store apps are needed, Capacitor wraps the same client with minimal native glue, keeping one codebase and the shared backend.

## Changes
- 2026-11-04 — initial record (ticket 0.1).
- 2026-11-04 — PostgreSQL + Drizzle wired, PGlite chosen for tests, Docker Compose for local dev (ticket 1.1).
