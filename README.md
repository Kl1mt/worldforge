# Worldforge

Browser-first dark-fantasy idle RPG: automatic combat, loot-driven builds, offline progress and a shared persistent world in 2D pixel art.

- Design: [`docs/GDD.md`](docs/GDD.md)
- Tickets and status: [`docs/ROADMAP.md`](docs/ROADMAP.md)
- UI and art: [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md), [`docs/ASSET_GUIDELINES.md`](docs/ASSET_GUIDELINES.md)
- Tech decisions: [`docs/TECH_STACK.md`](docs/TECH_STACK.md), [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md), [`docs/API_CONVENTIONS.md`](docs/API_CONVENTIONS.md)

## Requirements

- Node 22 (`.nvmrc`; `nvm use`)
- pnpm 10 (`corepack enable` picks up the version pinned in `package.json`)

## Getting started

```sh
pnpm install
pnpm dev
```

`pnpm dev` starts the API server on <http://127.0.0.1:3000> and the web client on <http://localhost:5173>. The web dev server proxies `/api/*` to the API server (override the target with `WORLDFORGE_SERVER_URL`).

The Phase 0 prototype screens are at `#/area`, `#/character` and `#/inventory`. With `pnpm dev` running, `node tools/screenshots/phase-0.mjs` captures them at 1440 and 390 px into `docs/screenshots/phase-0/` (it uses the preinstalled Playwright).

## Repository layout

| Path                 | Contents                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/game-core` | Pure TypeScript gameplay rules and content definitions (no DOM, no Node APIs). Shared by server and client. |
| `apps/server`        | Fastify 5 API. Authoritative for all game state. Entry: `buildApp()` in `src/app.ts`.                          |
| `apps/web`           | Vite + React 19 client. Renders server state; never decides outcomes.                                         |
| `docs/`              | Design document, roadmap, technical decision records.                                                          |
| `art/`               | Raw generated art sources (curated assets live in `apps/web/public/assets/`).                                  |

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

Run a single package with a filter, e.g. `pnpm --filter @worldforge/server test`.

Production server: `pnpm build && node apps/server/dist/index.js` (env: `PORT`, `HOST`, `LOG_LEVEL`).

CI (`.github/workflows/ci.yml`) runs install, format check, lint, typecheck, test and build on every PR and on `main`.
