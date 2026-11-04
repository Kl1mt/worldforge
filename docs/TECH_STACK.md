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
| Database           | PostgreSQL + Drizzle ORM (introduced in Phase 1, not yet wired)  |
| Web client         | Vite + React 19                                                  |
| Tests              | Vitest in every package; server routes via `app.inject()`        |
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
Relational data (accounts, characters, item instances, inventory, ledgers) with strong transactional guarantees for economy operations. Drizzle is a thin, typed, SQL-first ORM with plain-SQL migrations — no heavy runtime and easy to reason about. Not installed in Phase 0; see `docs/DATA_MODEL.md` for the draft schema.

### Dev identity vs. real auth
Phase 1 starts with a **development identity**: a dev-only endpoint issues a session for a named test account. It is enabled only when `NODE_ENV !== 'production'` *and* an explicit `DEV_AUTH=1` flag is set, lives in its own module, and is covered by a test that asserts it is unreachable in production config. Real authentication (email/password with Argon2id or an OAuth provider, HTTP-only secure session cookies) replaces it before any public deployment. Gameplay code depends only on an `accountId` from the session, so swapping auth does not touch game logic.

### Vite + React 19 web client
React has the broadest ecosystem and hiring familiarity; the UI is panel- and list-heavy rather than a real-time canvas game, so a DOM UI with CSS pixel-art rendering (`image-rendering: pixelated`, integer scaling) fits. Vite gives fast HMR and a simple static production build. Visual design is defined by the design system (ticket 0.3), not a component library, to avoid a generic look (GDD §3.2).

### Hosting assumptions
- Web client: static files on a CDN (any static host).
- API: a single Node 22 process behind HTTPS (a container on a managed platform). Stateless apart from the database, so it can scale horizontally later.
- Database: managed PostgreSQL with daily backups and point-in-time recovery.
- Same-origin deployment (`/api` reverse-proxied next to the static client) is preferred to avoid CORS and keep cookies simple; development mirrors this with the Vite proxy.
- Config via environment variables only (`PORT`, `HOST`, `LOG_LEVEL`, later `DATABASE_URL`); secrets never committed.

### Desktop: Tauri
Wraps the same web build in a native window with a small footprint (system webview instead of bundled Chromium). Electron stays the fallback if a webview incompatibility appears (GDD §2). Gameplay remains server-side, so the shell adds no game logic.

### Mobile: responsive web, then Capacitor
Layouts are responsive from Phase 0 (down to ~375px) with touch-sized targets. When store apps are needed, Capacitor wraps the same client with minimal native glue, keeping one codebase and the shared backend.

## Changes
- 2026-11-04 — initial record (ticket 0.1).
