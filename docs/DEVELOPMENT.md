# Development (project owner and Claude Code sessions)

Worldforge is **not open source and not licensed for self-hosting** (see [`LICENSE`](../LICENSE)). This page is for the project owner and the development sessions. Local playtesting: [`PLAYTEST.md`](PLAYTEST.md). The production server: [`DEPLOY.md`](DEPLOY.md).

## Requirements

- Node 22 (`.nvmrc`; `nvm use`)
- pnpm 10 (`corepack enable` picks up the version pinned in `package.json`)

## Getting started

```sh
pnpm install
cp apps/server/.env.example apps/server/.env
pnpm db:up        # PostgreSQL 16 in Docker (docker-compose.yml); or point DATABASE_URL at any Postgres ≥ 16
pnpm db:migrate   # apply migrations
pnpm dev
```

The server refuses to start without a reachable `DATABASE_URL`. Tests don't need Docker: they use an in-memory PGlite database (see [`TECH_STACK.md`](TECH_STACK.md)).

`pnpm dev` starts the API server on <http://127.0.0.1:3000> and the web client on <http://localhost:5173>. The web dev server proxies `/api/*` to the API server (override the target with `WORLDFORGE_SERVER_URL`).

Open the app and create an account at `#/register` (or log in at `#/login`); the game screens `#/area`, `#/character` and `#/inventory` need a session. With `pnpm dev` running, `node tools/screenshots/phase-0.mjs` captures the game screens at 1440 and 390 px into `docs/screenshots/phase-0/` (it registers a throwaway account) and `node tools/screenshots/auth.mjs` captures the login and register screens into `docs/screenshots/phase-1/` (both use the preinstalled Playwright).

## Scripts

| Command             | What it does                                                   |
| ------------------- | -------------------------------------------------------------- |
| `pnpm dev`          | Server (tsx watch) and web (Vite) in parallel                  |
| `pnpm build`        | Builds every package in dependency order (`dist/` per package) |
| `pnpm test`         | Vitest in every package                                        |
| `pnpm lint`         | ESLint (flat config, typescript-eslint)                        |
| `pnpm typecheck`    | `tsc --noEmit` in every package                                |
| `pnpm format`       | Prettier write                                                 |
| `pnpm format:check` | Prettier check (CI)                                            |
| `pnpm db:up` / `db:down` | Start / stop the local Postgres container                 |
| `pnpm db:migrate`   | Apply pending migrations to `DATABASE_URL`                     |
| `pnpm db:generate`  | Generate a new SQL migration from `apps/server/src/db/schema.ts` |
| `pnpm playtest`     | Local playtest without Docker: server on persistent PGlite (`.playtest-data/`) + web ([`docs/PLAYTEST.md`](PLAYTEST.md)) |
| `pnpm playtest:fast` | Same, with the server's farming clock ×60 (see offline progress in minutes) |
| `pnpm playtest:reset` | Delete the local playtest data                                |
| `pnpm run doctor`   | Check Node, pnpm, ports and Docker; prints next steps (plain `pnpm doctor` is pnpm's built-in) |

Run a single package with a filter, e.g. `pnpm --filter @worldforge/server test`.

Production server: `pnpm build`, then `pnpm --filter @worldforge/server db:migrate:prod` and `node apps/server/dist/index.js` (env: `DATABASE_URL`, `DATABASE_POOL_MAX`, `PORT`, `HOST`, `LOG_LEVEL`, `SESSION_TTL_HOURS`, `SESSION_COOKIE_SECURE`, `TRUST_PROXY`; see `apps/server/.env.example`).

## Versions and patch notes

The game has one version, `0.<phase>.<patch>` (the minor number is the roadmap phase, the patch number counts player-visible releases within it). It lives in `packages/game-core/src/releases/notes.ts` (`GAME_VERSION` and `PATCH_NOTES`, newest first); the server returns it in `GET /api/health` (`version`) and the web shows it in the status bar, linking to the "What's new" screen (`#/notes`). A player who has not opened the notes since the bundled version gets a quiet "New" tag on the version and, once the first-steps guide is done, a "New in v…" slip (last seen version per account in localStorage). A tab left open through a deploy notices the newer version on the shared health poll (every 5 minutes and when the tab comes back) and offers a reload with a quiet slip (Reload / Later, Later kept per version); it never reloads by itself (ticket F.4).

- Every PR that changes something a player can see adds an entry at the top and bumps `GAME_VERSION` (a new phase starts at `0.<phase>.0`). Write for players: New / Changed / Fixed, plain in-world words, no file names, jargon or security details. Ticket ids go in `tickets`.
- Tooling-, test- and docs-only PRs don't add an entry.
- If `main` gained a newer version while you worked, merge `main` and move your entry to the next number (like the migration rule).
- `packages/game-core/src/releases/releases.test.ts` (part of `pnpm test`) checks that versions are valid, unique and strictly increasing, dates never go backwards, the newest entry is `GAME_VERSION`, every release has an entry, and the text stays free of file names and jargon.

CI (`.github/workflows/ci.yml`) runs install, format check, lint, typecheck, test and build on every PR and on `main`, then applies the migrations to a fresh PostgreSQL 16 service container.
