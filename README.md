# Worldforge

A browser-first dark-fantasy idle RPG: automatic combat, loot-driven builds, offline progress and a shared persistent world in 2D pixel art.

**Play it at [play.worldforg.ing](https://play.worldforg.ing)** (registration is by invitation for now).

> **Not open source.** This repository is public for viewing only. All rights are reserved, including the code, game content and art: copying, hosting or running your own copy is not permitted without written permission (see [`LICENSE`](LICENSE)). There is no support for self-hosting.

## Security

Found a security problem? Please report it privately as described in [`SECURITY.md`](SECURITY.md), never in a public issue.

## Repository layout

| Path                 | Contents                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/game-core` | Pure TypeScript gameplay rules and content definitions (no DOM, no Node APIs). Shared by server and client. |
| `apps/server`        | Fastify 5 API. Authoritative for all game state. Entry: `buildApp()` in `src/app.ts`.                          |
| `apps/web`           | Vite + React 19 client. Renders server state; never decides outcomes.                                         |
| `docs/`              | Design document, roadmap, technical decision records.                                                          |
| `art/`               | Raw generated art sources (curated assets live in `apps/web/public/assets/`).                                  |

## For the project owner

Development setup, scripts and CI: [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md). Local playtest: [`docs/PLAYTEST.md`](docs/PLAYTEST.md). Production server: [`docs/DEPLOY.md`](docs/DEPLOY.md); before inviting players: [`docs/GOING_LIVE.md`](docs/GOING_LIVE.md). Design and plan: [`docs/GDD.md`](docs/GDD.md), [`docs/ROADMAP.md`](docs/ROADMAP.md).
