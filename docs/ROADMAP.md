# Roadmap & tickets

Status: `todo` → `in progress` → `done (PR #n)`. One ticket per session (see `CLAUDE.md`).
Phases follow GDD §15. A phase is closed only when its exit criteria hold and `main` builds.

## Phase 0 — Foundation & visual prototype

### 0.1 Project foundation — `todo`
GDD to read: §2, §15 (Phase 0), §16.
- pnpm workspace monorepo, Node 22, **TypeScript 5.9.x** (not 7.x; tooling compatibility). Write configs by hand, no scaffolders.
- `packages/game-core`: pure TS, no DOM/Node deps. Phase 0 content only: class definitions (Warrior/Rage, Mage/Mana, Hunter/Focus, Warlock/Soul Fragments), the 6 rarity ids in order, the equipment slot list (head, shoulders, chest, hands, legs, feet, neck, ring1, ring2, weapon, offhand, relic), core stat ids (§6.2), a seeded deterministic RNG with tests. No combat or loot logic.
- `apps/server`: Fastify 5, `buildApp()` factory, `GET /api/health`, `GET /api/content` (game-core definitions), Vitest tests via `app.inject()`.
- `apps/web`: Vite + React 19 + TS. Placeholder page only plus a health status line; dev proxy `/api` → server (port 3000; web on 5173). No visual design (ticket 0.3).
- Tooling: ESLint flat config + typescript-eslint, Prettier, Vitest, `.editorconfig`, `.nvmrc`. Root scripts: `dev`, `build`, `test`, `lint`, `format`, `format:check`, `typecheck`. GitHub Actions CI running all checks.
- Docs: `README.md`; `docs/TECH_STACK.md` (decision record: React/Vite, Fastify, shared game-core, PostgreSQL + Drizzle planned for Phase 1, server authority, dev identity vs real auth, hosting assumptions, Tauri for desktop and responsive web / Capacitor for mobile, each with a short rationale); `docs/DATA_MODEL.md` (draft Phase 1 entities); `docs/API_CONVENTIONS.md` (REST JSON under `/api`, error envelope, validation, idempotency). Fill in the Commands section of `CLAUDE.md`.

**Acceptance:** `pnpm install && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass; CI is green on the PR; the server answers `/api/health`.

### 0.2 Art assets — `done (PR #1)` (can run in parallel with 0.1)
GDD to read: §3.1, §3.3, §4.3, §7.2.
Raw item icons (32×32, 64 variants) are already in `art/source/pixellab/icons-batch-01/` (contact sheet: `_contact-sheet.png`, row-major 8×8, indices 00–63). Suggested picks: longsword 00 & 09, helm 04, horned helm 12, leather gloves 10, gauntlets 19, rings 07 & 21, round shield 25, heater shield 28, bone amulet 31, boots 35, chainmail 36, plate chest 37, leather chest 43, skull staff 58, bow 61.

Three PixelLab jobs were submitted and paid for but never collected. Fetch them with `GET /background-jobs/{id}` (see `CLAUDE.md`, Art pipeline):
- `30fa58d6-2ecf-4b46-b8fe-2945d381845a`: Abandoned Fields backdrop, 384×216 (1 image)
- `33fc9a40-977c-49ce-af0b-91712af1550e`: warrior full body, 128×128 (4 variants)
- `1114a77a-f169-406c-9e9a-1a1765287332`: undead farmer / wolf / skeletal scarecrow, 64×64 (16 variants)

If a job has expired or failed, regenerate it once. Budget: at most 2 new jobs. Store raw results under `art/source/pixellab/`.
- Curated, native-resolution files go in `apps/web/public/assets/{items,enemies,characters,areas}/` with kebab-case names, plus `apps/web/public/assets/manifest.json` (id, path, kind, size, prompt).
- `tools/art/pixellab_gen.py`: a reusable generate-and-poll helper that also writes a contact sheet.
- `docs/ASSET_GUIDELINES.md`: pixel scales (icons 32, enemies 64, characters 128, backdrops 384×216), integer scaling with pixelated rendering, palette, prompt conventions, how variants (e.g. Void) reuse base art via overlays.

If 0.1 hasn't merged yet, create only the paths listed above; don't scaffold the app.
**Acceptance:** assets and manifest are committed; one combined preview sheet is included in the PR description or the repo.

### 0.3 Design system & visual prototype — `todo` (needs 0.1 + 0.2 merged)
GDD to read: §3 (all), §4.2, §5.2, §6.2, §7.1–7.2.
- Design tokens (CSS custom properties): color (palette + rarity colors), typography (a display face used sparingly plus a highly readable body/numeric face), spacing, borders, panel treatments. Document them in `docs/DESIGN_SYSTEM.md`.
- Static prototype screens driven by mock data and `game-core` definitions: navigation shell; the Abandoned Fields area screen (backdrop, enemies, a mock combat log); a character panel (warrior art, stats, equipment slots); an inventory grid; an item tooltip (rarity, affixes, comparison).
- Responsive down to ~375px. Keyboard focus is visible. Pixel art uses integer scaling.
- Avoid the generic dashboard look: no uniform rounded cards or arbitrary gradients; each screen gets its own layout.
- Playwright screenshots at desktop (1440) and mobile (390) widths, saved to `docs/screenshots/phase-0/`.

**Acceptance:** checks pass; screenshots are attached to the PR for the review called for in GDD §3.4.

### 0.4 Visual review & polish — `todo`
Review the 0.3 screenshots against GDD §3.2 and §3.4, fix the issues found, and record the decisions in `docs/DESIGN_SYSTEM.md`. Phase 0 exit: the app runs locally, the visual prototype is approved by the owner, and checks pass.

## Phase 1 — Core playable vertical slice
Tickets are written by the planning session once Phase 0 is approved (GDD §15, Phase 1).
