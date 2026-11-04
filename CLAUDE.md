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
- In `docs/ROADMAP.md`, set your ticket to `done (PR #n)`. In the PR description, report the changed files, decisions, test results and remaining risks.

## Token economy
- Prefer targeted reads (grep, line ranges) over whole files. Don't paste large outputs.
- For images, look at contact sheets instead of individual files.

## Commands
_To be filled in by ticket 0.1 (pnpm workspace scripts)._

## Art pipeline
PixelLab API (`https://api.pixellab.ai/v2`). Auth is injected by the cloud environment's proxy, so send `Authorization: Bearer dummy`. Synchronous endpoints time out at the proxy (30s), so use only the async flow: `POST /generate-image-v2` returns `background_job_id`, then poll `GET /background-jobs/{id}` every ~8s; images are in `last_response.images[].base64` (PNG). One 32px job yields 64 variants for 10 generations. Be frugal with generations.
