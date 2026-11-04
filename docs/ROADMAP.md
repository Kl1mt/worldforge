# Roadmap & tickets

Status: `todo` → `in progress` → `done (PR #n)`. One ticket per session (see `CLAUDE.md`).
Phases follow GDD §15. A phase is closed only when its exit criteria hold and `main` builds.

## Phase 0 — Foundation & visual prototype

### 0.1 Project foundation — `done (PR #2)`
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

### 0.3 Design system & visual prototype — `done (PR #3)`
GDD to read: §3 (all), §4.2, §5.2, §6.2, §7.1–7.2.
- Design tokens (CSS custom properties): color (palette + rarity colors), typography (a display face used sparingly plus a highly readable body/numeric face), spacing, borders, panel treatments. Document them in `docs/DESIGN_SYSTEM.md`.
- Static prototype screens driven by mock data and `game-core` definitions: navigation shell; the Abandoned Fields area screen (backdrop, enemies, a mock combat log); a character panel (warrior art, stats, equipment slots); an inventory grid; an item tooltip (rarity, affixes, comparison).
- Responsive down to ~375px. Keyboard focus is visible. Pixel art uses integer scaling.
- Avoid the generic dashboard look: no uniform rounded cards or arbitrary gradients; each screen gets its own layout.
- Playwright screenshots at desktop (1440) and mobile (390) widths, saved to `docs/screenshots/phase-0/`.

**Acceptance:** checks pass; screenshots are attached to the PR for the review called for in GDD §3.4.

### 0.4 Visual polish — `done (PR #5)`
GDD to read: §3.2, §3.4. The owner approved the visual direction of 0.3 (PR #3). Keep the direction; fix only these:
- **Bigger pixel art on desktop.** Character, enemy and item sprites read too small at desktop widths. Scale them up by an integer step (e.g. ×3 → ×4 or more) at desktop breakpoints, on the area scene, the character portrait, the "Foes" row, and the item slots/grid. **Mobile sizes are approved; leave them unchanged.**
- Label the health and resource bars (character card on the character screen, combatant HUD on the area screen), e.g. "Health 842 / 1,046" and "Rage 62 / 100".
- Inventory on desktop: remove the large empty area below the grid (rebalance the layout, e.g. grid height vs. tooltip column).
- Mobile inventory: rarity filters on one horizontally scrollable row instead of wrapping onto three rows.
- Area screen: the Chronicle (combat log) panel should not show empty filler rows; size it to its content or fill the height with entries.
- Area scene: show names for every enemy's health bar (not only the current target), without cluttering the scene.
- Record the changes in `docs/DESIGN_SYSTEM.md` and re-take all screenshots (`docs/screenshots/phase-0/`, desktop 1440 and mobile 390); embed them in the PR description.

**Acceptance:** checks pass; the issues above are visibly fixed in the new screenshots; mobile layout is unchanged except for the filter row. Phase 0 exit: the app runs locally, the owner has approved the visuals, and checks pass.

## Phase 1 — Core playable vertical slice
GDD §15 Phase 1. Exit: a new player can register, create a character, farm Abandoned Fields, earn XP and loot, equip an item, leave, return later and see valid offline progress, with no duplication or reward exploits.

**Owner decisions (GDD v0.3):** real account registration and login (no dev identity); offline accumulation cap is **3 hours**, server-configurable (upgradeable through progression later; not in Phase 1); **12 equipment slots** as already defined in `game-core`.

Dependencies: 1.1 → 1.2 → 1.3. 1.4 and 1.5 are pure `game-core` and can run in parallel with 1.1–1.3. 1.6 needs 1.3–1.5. 1.7 needs 1.3 + 1.5. 1.8 needs 1.6 + 1.7. 1.9 is last.

### 1.1 Database & persistence foundation — `done (PR #8)`
GDD: §9.3, §16. Docs: `docs/TECH_STACK.md`, `docs/DATA_MODEL.md`.
- PostgreSQL + Drizzle ORM in `apps/server`: schema, migrations, migration script, config via env (`DATABASE_URL`), `.env.example`.
- Local dev: `docker-compose.yml` with Postgres. Tests: real Postgres semantics without requiring Docker in the sandbox (e.g. PGlite or a CI service container); document the choice.
- Initial tables: `accounts`, `sessions`, `audit_log` only (later tickets add their own tables and migrations).
- Transaction helper, health check reports DB status.
**Acceptance:** migrations apply from scratch; tests run in CI against the test DB; `docs/DATA_MODEL.md` updated.

### 1.2 Accounts: registration & login — `done (PR #10)`
GDD: §2.1, §5.3, §16.3.
- API: register (email + display name + password), login, logout, current account. Passwords hashed with argon2id (or scrypt if argon2 is unavailable); httpOnly, secure, SameSite session cookie; session expiry and revocation on logout.
- Validation and clear error envelope (see `docs/API_CONVENTIONS.md`); rate limiting on login/register; generic error messages for failed login (no account enumeration). Audit log entries for register/login.
- Web: register and login screens in the established visual style (GDD §3), auth-guarded routes, logout. Loading/error states.
- Out of scope: email verification, password reset, OAuth (note them as follow-ups).
**Acceptance:** tests for happy paths, duplicate email, bad password, rate limit, session expiry; screenshots of both screens (desktop + mobile) in the PR.

### 1.3 Characters — `done (PR #11)`
GDD: §5.1–5.3.
- `characters` table (account FK, name, class, level, xp, gold, cosmetic choice, created_at); 2 character slots per account (configurable).
- API: list, create (name rules + uniqueness, class from `game-core`), select active character. All four classes selectable.
- Web: character select + creation screen (class choice with identity text; a minimal cosmetic choice — use the warrior art for all classes for now, note it).
**Acceptance:** slot limit enforced server-side; tests; screenshots.

### 1.4 Combat simulation (game-core) — `done (PR #7)`
GDD: §6.1–6.3, §9.3.
- Data-driven enemies for Abandoned Fields (Risen Farmhand, Carrion Wolf, Bone Scarecrow) and an area definition (level range, enemy weights).
- Derived character stats from class base + level + equipment (pure function).
- Deterministic, seeded combat resolution (tick/time-based): attack speed, physical/magic damage, crit, armor/resistance mitigation, death and respawn delay. Returns kills, XP, damage taken and a compact event log.
- XP curve and level-ups. One basic auto-skill per class is acceptable; full skill loadouts are later.
- A function that simulates N seconds of farming efficiently (aggregate, not per-frame) for offline settlement, producing the same distribution as the detailed sim.
**Acceptance:** thorough unit tests (determinism with same seed, monotonic progression, no NaN/negative values); no server or UI changes.

### 1.5 Loot generation (game-core) — `done (PR #6)`
GDD: §7.1–7.3.
- Data-driven item bases matching the 17 item icons in `apps/web/public/assets/items/`, mapped to the 12 slots; class weapon restrictions.
- Rarity roll (all six tiers defined; Legendary/Mythic effects come in Phase 3 — in Phase 1 they may only roll as stronger stat items or be disabled by config), a small affix pool (physical/magic damage, attack speed, crit chance, crit damage, health, armor, resistance, gold find), item level scaling, gold drops.
- Deterministic with seeded RNG; drop rates in config.
**Acceptance:** unit tests incl. statistical tests over many seeds (rarity distribution within tolerance, affixes valid for slot).

### 1.6 Farming activity & offline progress (server) — `done (PR #15)`
GDD: §9.1–9.3, §14.
- `activities` table (your migration). The `item_instances` table already exists (`apps/server/src/db/schema.ts`, migration `0002`); grant loot by inserting rows there with `equipped_slot = null`. Ticket 1.7 runs in parallel and owns equip/unequip/discard; don't build those. Start/stop farming Abandoned Fields for the active character.
- Server-authoritative settlement: progress is computed from elapsed server time using 1.4/1.5 with a seed derived server-side; never from client input. Settle on request and on a schedule; idempotent and transaction-safe (no double-claim under concurrent requests).
- Offline: time without client activity accrues up to the **3 h cap** (`OFFLINE_CAP_SECONDS`, config); active play may settle more efficiently (keep the rule simple and documented).
- Return summary endpoint: XP, levels, gold, items gained while away, time capped.
- Inventory capacity: overflow handling documented (e.g. excess items auto-salvaged to gold).
- Cap total gold find (and any other find/yield modifiers) when summing equipment before passing it to `rollLoot` (GDD §6.2: modifiers need caps). Put the cap in game-core config.
- Use `unusedMs` from `simulateFarmingAggregate` as carry-over between settlements (see `docs/COMBAT.md`).
**Acceptance:** tests for cap, idempotency, concurrent settle, determinism; audit log entries for rewards.

### 1.7 Inventory & equipment (server) — `done (PR #13)`
GDD: §7.1, §14 steps 4–5.
- Uses the existing `item_instances` table (`equipped_slot` null = in inventory; a partial unique index allows one item per slot). Avoid new migrations; ticket 1.6 adds one in parallel. If one is unavoidable, say so in the PR. Ticket 1.6 owns granting loot and the inventory capacity rule; don't build those.
- API: inventory list, equip (slot + class validation), unequip, discard. Ring slots handled (ring1/ring2). Derived stats recomputed server-side. Bridge loot → combat in game-core: a pure function turning equipped `GeneratedItem`s into `EquipmentStatContribution` for `deriveCharacterStats` (if 1.6 hasn't already added it).
- Transaction-safe; an item can only be in one place; ownership checked.
**Acceptance:** tests for invalid slot, wrong class, other account's item, double equip, concurrency.

### 1.8 Connect the UI to the real game — `done (PR #16)`
GDD: §3, §9.2, §14, §18.
- Replace mock data on the area, character and inventory screens with the API. Live combat log from settled events (polling is fine).
- Offline return summary shown on login/return.
- Equip/unequip from inventory with comparison tooltip. Loading, empty, error, success states.
**Acceptance:** Playwright run of: register → create character → farm → get loot → equip; screenshots.

### 1.9 Phase 1 hardening — `done (PR #18)`
GDD: §15 Phase 1 exit criteria, §16.3.
- End-to-end test of the full exit-criteria flow including offline return (with simulated time).
- Exploit review: duplicate requests, replay, concurrency, negative/overflow values, cap bypass. Fix what's found.
- Return 404 (not 403) for other accounts' resources (e.g. selecting another account's character), so resource ids can't be probed.
- Re-run the concurrency tests against a **real PostgreSQL** (PGlite runs transactions one at a time, so today's race tests check the logic, not true parallelism): settlement double-credit, equip races, slot-limit races, settle-vs-equip/discard. In CI, use the existing Postgres service from the `migrations` job.
- Test stability: server test files create a PGlite database in `beforeAll`, which hit the 10 s hook timeout on a cold container. Raise `hookTimeout` (or share one migrated template), so CI can't flake.
- Turn `tools/e2e/farm-loop.mjs` (ticket 1.8) into the exit-criteria e2e run and add it to CI if it runs in a reasonable time.
- Balance sanity check (not tuning): in the 1.8 e2e runs, characters died often (e.g. 12 deaths in ~30 simulated minutes). Record the numbers in `docs/COMBAT.md` as a starting point for later balancing.
- Update docs; Phase 1 retrospective notes in this file.

### Phase 1 retrospective (ticket 1.9)
**Exit criteria (GDD §15 Phase 1): met.** Checked end to end twice: through the HTTP API with a simulated clock (`apps/server/src/e2e/exit-criteria.test.ts`: register → create → farm → XP and loot → equip → log out → 5 h later log in → capped, audit-reconciled offline summary; replays and the revoked session grant nothing), and in a real browser at 1440/390 px (`tools/e2e/farm-loop.mjs`, now CI job `e2e`). "No critical duplication or reward exploits remain" holds after the fixes below; the accepted risks are listed in PR #18.

**What the exploit review found.** The serious problems were not in locking or validation (the row locks held under real parallel transactions, and no client numbers reach the rules) but in *timing*: two ways to farm better by choosing when to send ordinary requests.
- Settle spam re-rolled the unfinished encounter every window: settling every second removed nearly all deaths and gave ~+20 % kills. Fixed with per-cycle RNG keyed by a global cycle index, so a span of farming gives the same result however it is split (game-core tests pin exact equality).
- Stop → start healed to full and re-rolled the next encounter (level-1 mage: 0 deaths, +25 % kills). Fixed by saving the farm state (secret, cycle index, health) on the character.
- Equipment and discards applied retroactively to the unsettled window. Fixed by settling before inventory changes.
- Another account's character answered `403` (ids could be probed); now `404` everywhere.

**What went well.** game-core as pure, seeded functions made both timing exploits measurable in a few lines and their fixes provable by exact-equality tests. Server-side clock injection made the offline cap and the exit-criteria flow testable without waiting. Ticket order (rules → persistence → UI) kept each PR reviewable.

**What to do differently in Phase 2.**
- Test invariances, not just outcomes: "the result must not depend on how often the client calls X" should be a standard property test for every time-based system (activities, crafting timers, world events).
- Run concurrency tests on real PostgreSQL from the ticket that adds the lock, not afterwards; PGlite serialises transactions and hid a removed lock in a mutation check.
- Docs promised an `Idempotency-Key` mechanism that was never built; Phase 1 is idempotent by state instead (documented). Build the header with the first non-idempotent value operation (selling, crafting, trading).
- Balance is untouched: casters die about once a minute at levels 1–3, and every class reaches the Fields' top level within one 3 h cap (`docs/COMBAT.md`, baseline). Phase 2's world structure needs a balancing pass with these numbers.
- Carry-overs: per-account rate limits on game routes (requests are reward-neutral now, but cost DB time); per-account login throttling; area/equipment changes re-simulating the unfinished cycle (harmless with one area); email verification, password reset, session pruning (ticket 1.2 follow-ups).

## Playtest

### P.1 Local playtest setup — `done (PR #19)`
Goal: the owner playtests Phase 1 on their own machine (OS unknown; not necessarily a developer), from a fresh clone to playing as easily as possible.
- `docs/PLAYTEST.md`: step-by-step guide. Prerequisites per OS (Windows, macOS, Linux) with exact commands or links: Git; Node 22 (fnm or nvm; nvm-windows on Windows); pnpm via corepack; Docker Desktop or the no-Docker path. Clone, install, run, open. What to try (register, create a character, farm, inventory and equip, log out, come back, offline summary). Troubleshooting: ports 3000/5173 in use, Docker not running, wrong Node version, migration errors, cookies over http://localhost. Reset all game data; stop everything.
- No-Docker local playtest server: PGlite persisted to a git-ignored local data directory (`.playtest-data/`), so progress survives restarts; reuses the e2e/test server patterns. A separate, clearly named entry point excluded from the production build; refuses `NODE_ENV=production`; normal auth.
- Optional "fast time" flag: speeds up the server-side farming clock so offline progress and the 3 h cap show in minutes. Server-side only, off by default, documented in PLAYTEST.md.
- One-command root scripts: `pnpm playtest` (server + web, no Docker), `pnpm playtest:reset`, and a doctor script (Node version, pnpm, free ports, optionally Docker; clear next steps). pnpm has a built-in `pnpm doctor`, so the script runs as `pnpm run doctor`.
- `docs/PLAYTEST_FEEDBACK.md`: feedback template (first impressions, confusing moments, bugs, balance feel per class, UI notes) for Phase 2 planning. Link PLAYTEST.md from the README.
- Verified in the sandbox: `pnpm playtest` starts; registration and farming work in a browser (Playwright); data survives a restart; `playtest:reset` clears it. Game rules unchanged.

## Art tickets (run alongside the phases)

### A.1 Class portraits — `done (PR #14)`
GDD: §3.1, §5.1–5.2. Read `docs/ASSET_GUIDELINES.md` and `CLAUDE.md` (Art pipeline).
- Generate full-body portraits for **Mage, Hunter, Warlock** at 128×128 with transparent background, matching the existing warrior (`apps/web/public/assets/characters/warrior.png`): same pixel scale, three-quarter front view, muted desaturated dark-fantasy palette, weathered gear, readable silhouette. Pass the warrior as `style_image` to `/generate-image-v2` so the style matches. Class identity: Mage = elemental/arcane robes and staff; Hunter = leather and hood, bow; Warlock = dark robes, shadow/soul motifs, skull or grimoire.
- Budget: one job per class (4 variants each), at most one regeneration in total. Keep raw results under `art/source/pixellab/`.
- Curate into `apps/web/public/assets/characters/{mage,hunter,warlock}.png`, update `manifest.json`, and make the web app pick the portrait by class wherever the warrior is shown for every class now (character select, creation preview, character screen). Remove the "every class wears the warrior's portrait" note.
- Re-take the character select/creation screenshots.
**Acceptance:** checks pass; a contact sheet of all four classes side by side in the PR description.
