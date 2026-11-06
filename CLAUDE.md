# Worldforge — Claude Code brief

Browser-first dark-fantasy idle RPG: automatic combat, loot-driven builds, offline progress, shared persistent world, 2D pixel art.

## Start of every session
1. Read this file and `docs/ROADMAP.md`. Find your ticket there.
2. Read **only** the GDD sections your ticket lists (`docs/GDD.md`, ~500 lines). Do not read the whole GDD unless the ticket says so.
3. Before coding, briefly state the intended change, the affected files and your assumptions.

## Rules (from GDD §15.1 / §15.2)
- One ticket per session. Do not build later-phase features in advance.
- Work on a branch named `ticket/<id>-<slug>` from `main`, and open a PR into `main` when done. Never push to `main` directly.
- Gameplay rules live in a shared, UI-free package and are server-authoritative. Never trust client-submitted currency, loot, combat results or scores.
- Content (classes, enemies, items, affixes, loot tables) is data-driven.
- Add tests for gameplay rules and persistence. Run format, lint, typecheck, test and build before opening the PR.
- Handle loading, empty, error and success states. UI follows the design system and must not look like a generic AI dashboard (GDD §3.2).
- Update docs when architecture or behavior changes.
- Migrations: if `main` gained a migration while you worked, merge `main`, delete your generated migration (`.sql`, snapshot, journal entry) and re-run `pnpm db:generate`.
- In `docs/ROADMAP.md`, set your ticket to `done (PR #n)`. In the PR description, report the changed files, decisions, test results and remaining risks.

## Token economy
- Prefer targeted reads (grep, line ranges) over whole files. Don't paste large outputs.
- For images, look at contact sheets instead of individual files.

## Commands
Node 22 (`.nvmrc`), pnpm 10. Run from the repo root:
- `pnpm install` — install the workspace.
- `pnpm dev` — server on :3000 (tsx watch) + web on :5173 (Vite, proxies `/api` → :3000).
- `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` — the full check suite (same as CI). `pnpm format` fixes formatting.
- Single package: `pnpm --filter @worldforge/<game-core|server|web> <script>`.
- Database: `pnpm db:up` (Docker Postgres), `pnpm db:migrate`, `pnpm db:generate` (new migration after editing `apps/server/src/db/schema.ts`). Server tests use in-memory PGlite (`createTestDatabase()`), no Docker needed. Real-Postgres concurrency tests: `DATABASE_URL=… pnpm --filter @worldforge/server test:pg` (skipped without `DATABASE_URL`; CI runs them).

- Production: `deploy/` (Dockerfile, Compose with Caddy + PostgreSQL, `deploy.sh`/`backup.sh`/`restore.sh`/`admin.sh`), guide in `docs/DEPLOY.md`.
- Telemetry: `pnpm report:telemetry` (balance report from the server-side rollups; `-- --help` for options, `docs/TELEMETRY.md`).

Layout: `packages/game-core` (pure TS rules + content, no DOM/Node), `apps/server` (Fastify, `buildApp()`), `apps/web` (Vite + React).
Workspace packages are resolved from TS source via the `source` export condition in dev/test/typecheck, and from `dist/` in production builds (`pnpm build` builds in dependency order).
Markdown is excluded from Prettier (hand-written).

## Art pipeline
PixelLab API (`https://api.pixellab.ai/v2`). Auth is injected by the cloud environment's proxy, so send `Authorization: Bearer dummy`. Synchronous endpoints time out at the proxy (30s), so use only the async flow: `POST /generate-image-v2` returns `background_job_id`, then poll `GET /background-jobs/{id}` every ~8s; images are in `last_response.images[].base64` (PNG). One 32px job yields 64 variants for 10 generations. Be frugal with generations.
