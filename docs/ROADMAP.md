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

## Phase 2 — World structure & early progression
GDD §15 Phase 2. **Exit:** players can progress through several connected Graumark areas, complete quests, gather resources, and clear the first dungeon (The Nameless Crypt) and its boss (The Gravewarden).

**Ground rules for Phase 2**
- **Vertical slices.** From 2.3 on, each feature ticket ships rules (game-core), server and UI together, so every merged ticket is playable. 2.1 is content only.
- **Lessons from the Phase 1 retrospective apply.** Every time-based system (gathering, contracts, dungeon runs) must give the same result however often the client calls it (an invariance test, like 1.9's settlement-splitting test). Every new mutating endpoint gets a real-Postgres concurrency test (`test:pg`). Endpoints that aren't naturally repeat-safe (selling, buying, crafting, quest turn-in) use the `Idempotency-Key` header (`docs/API_CONVENTIONS.md`).
- **Migrations in parallel tickets.** If `main` gained a migration while you worked, merge `main`, delete your generated migration (its `.sql`, snapshot and journal entry), and re-run `pnpm db:generate`.
- **Content ids are shared contracts.** The enemy, material and area ids below are fixed so that art and code tickets can run in parallel.
- **Playtest feedback.** The owner is playtesting Phase 1. Feedback goes into B.1 (balance) and may adjust the UI tickets before they start.

**Content contract (ids)**
| Area (`AreaId`) | Levels | Unlock | Enemies (`EnemyId`) | Gatherable materials |
|---|---|---|---|---|
| `abandonedFields` | 1–6 | start | `risenFarmhand`, `carrionWolf`, `boneScarecrow` | `timber`, `ashwort` |
| `crowwood` | 5–10 | level 5 | `banditCutthroat`, `corruptedCrow` | `timber`, `rawHide` |
| `oldBurialGrounds` | 9–14 | level 9 | `risenSkeleton`, `graveCrawler` | `soulShard` |
| `blackwater` | 13–18 | level 13 | `drownedThrall`, `bogHorror` | `ashwort`, `ironOre` |
| `sunkenAbbey` | 17–22 | level 17 + Gravewarden defeated | `fallenKnight`, `abbeyWraith` | `ironOre`, `abbeySilver` (rare) |
| Dungeon `namelessCrypt` | 12–16 | level 12 | `cryptGhoul`, `boneAcolyte`; boss `gravewarden` | boss drop `gravewardenSeal` |

Professions (GDD §11.3): Woodcutting → `timber`, Herbalism → `ashwort`, Skinning → `rawHide`, Mining → `ironOre` and `abbeySilver`. `soulShard` drops from undead in combat. Ranges and numbers are first-pass; tune in tests and B.1.

**Waves:** 2.1, A.2 and A.3 run in parallel. Then 2.2 and A.4. Then 2.3. Then 2.4, 2.5 and 2.6 in parallel. Then 2.7 and 2.8. B.1 runs whenever the playtest feedback is in.

### 2.1 World content: areas, enemies, item tiers, loot tables (game-core) — `done (PR #23)`
GDD: §4.3, §6.2, §7.1–7.3, §11.3, §16.2. Read `docs/COMBAT.md`, `docs/LOOT.md`.
- All areas, enemies and the dungeon from the content contract as data in `packages/game-core/src/world/` (dungeon definitions can be data only here; 2.5 adds the rules). Enemy families: physical vs magic damage; undead flag (for `soulShard` drops).
- Item tiers: extend the item bases so higher areas drop better gear (e.g. a tier 2 and tier 3 per slot with higher `minItemLevel`). Bases name an icon asset id; new bases may temporarily point at an existing icon (A.4 delivers new icons and switches them).
- Area-specific loot tables (base weights per area, item-level ranges per area); the area's loot table is used in settlement instead of the global one.
- Material definitions (ids above, name, rarity, which area and profession) as data. Gathering rules are 2.3; no server changes here.
- Unlock rules as pure functions: `isAreaUnlocked(character, progress)`, with progress covering at least the level and `gravewardenDefeated`.
- Keep the Abandoned Fields numbers unchanged (balance is B.1).
**Acceptance:** content validation tests (every enemy in exactly one roster, every loot-table base exists, level ranges ordered and overlapping by one step, ids match the contract); farming simulations for a mid-level character in each area complete without timeouts; no server or UI changes.

### 2.2 Hub & world map (server + web) — `done (PR #25)`
GDD: §3, §4.2, §4.3, §14. Needs 2.1 and A.2 merged.
- **Server:** the activity start accepts any unlocked area (validated with `isAreaUnlocked`, server-side); character progress needed for unlocks is persisted (e.g. `characters.progress` jsonb or a table). `GET` world state for a character: areas with locked/unlocked and the reason.
- **Web:** an illustrated hub screen (A.2 art) with clickable building hotspots: World Map, Tavern, Forge, Merchant are present; Guild Hall, Warehouse and Summoning Shrine are visibly locked ("later"). Hotspots work with keyboard and touch and have accessible labels. A world-map screen (A.2 art) with the five areas and the crypt, showing locked/unlocked/current state; choosing an area starts or switches farming. The area screen works for every area (backdrop and enemies from the assets, fallback when art is missing).
- Navigation update: Hub becomes the home. Fields becomes "Area" (current area). Tavern, Forge and Merchant screens can be "coming soon" placeholders until their tickets land.
**Acceptance:** tests for unlock validation (locked area refused, level-gated and boss-gated); desktop and mobile screenshots of hub, map and two areas.

### 2.3 Materials & professions (vertical) — `done (PR #26)`
GDD: §11.3, §9. Needs 2.2.
- **Rules (game-core):** gathering during farming. Each area has material yields; the character's profession level raises yield. Gathering is part of the per-cycle settlement (same seed scheme as 1.9, so results don't depend on settle frequency; add the invariance test). Profession XP and levels (cap e.g. 50).
- **Server:** a material storage table (character, material id, quantity, `CHECK >= 0`); profession levels per character; settlement grants materials and profession XP in the same transaction; the return summary includes materials. Materials stack and have no capacity limit for now.
- **Web:** a materials tab in the Pack; a professions panel on the character screen; materials in the chronicle and return summary.
**Acceptance:** invariance and determinism tests; PG concurrency test for settle-vs-settle granting materials once; screenshots.

### 2.4 Tavern: quests & contracts (vertical) — `done (PR #28)`
GDD: §6.4, §11.1, §4.2. Needs 2.3.
- **Rules:** data-driven quest definitions (kill N of an enemy, gather N of a material, reach an area, defeat the Gravewarden); a short Graumark story chain leading to the crypt; repeatable contracts (3 per day per character, chosen by a server-side daily seed). Progress comes from settlement and dungeon events, never from the client.
- **Server:** quest state per character; accept, track and turn in (turn-in uses `Idempotency-Key`; rewards granted once, audited). Rewards: XP, gold, materials, sometimes an item.
- **Web:** a Tavern screen (notice board), quest tracker on the area screen, turn-in flow.
**Acceptance:** progress-from-events tests; double turn-in grants once (PGlite and PG); screenshots.

### 2.5 The Nameless Crypt & the Gravewarden (vertical) — `done (PR #29)`
GDD: §6.4, §11.2, §4.3. Needs 2.3 and A.3.
- **Rules:** a dungeon run is a sequence of encounters (e.g. 4 rooms) and the Gravewarden boss with its own mechanic (e.g. an enrage timer or a shield phase), resolved by the deterministic combat engine with a seed derived server-side. The run takes real time (minutes), so it is an active-play goal; it must not stack with farming (the character leaves the fields while in the crypt). Failure keeps nothing from the boss but never removes progress. The boss loot table has a guaranteed `gravewardenSeal`, better rarity odds and unique items.
- **Server:** start run, settle and claim result (claim with `Idempotency-Key`); one run at a time per character; a daily or cooldown limit on boss loot. Defeating the Gravewarden sets `gravewardenDefeated` (unlocks Sunken Abbey).
- **Web:** crypt entrance from the world map; a run screen with room progress, combat log and the boss encounter; a result screen.
**Acceptance:** determinism and invariance tests; run-vs-farming exclusivity; double claim grants once (PG); screenshots including the boss.

### 2.6 Forge & Merchant (vertical) — `done (PR #27)`
GDD: §4.2, §8, §11.3, §13.3. Needs 2.3.
- **Merchant:** sell items for gold (value from rarity and item level); buy a small daily stock of basic gear per unlocked area (server-seeded). Prices and stock are server data. Every buy and sell uses `Idempotency-Key` and is audited.
- **Forge (Phase 2 scope):** salvage items into materials (and a little gold); craft a few basic recipes from materials (e.g. tier-appropriate gear with a guaranteed slot, or an upgrade material for Phase 3). **Upgrades, rerolls and affix improvement are Phase 3; don't build them.**
- **Web:** Merchant and Forge screens in the established style (buy/sell lists, salvage preview, recipe list).
**Acceptance:** no gold or item duplication under concurrent buy/sell/salvage (PG tests); idempotency replay tests; screenshots.

### 2.7 Onboarding & progression feedback (web) — `done (PR #30)`
GDD: §1.3, §3, §18. Needs 2.2–2.6. Take the owner's playtest feedback into account.
- A first-session flow: a short guided path (create character → start farming → first drop → equip → visit the Tavern), dismissible and remembered per account.
- Progression feedback: level-up, area-unlocked and quest-complete notices; "new" markers on items and quests; a clear "what continues offline" explanation (GDD §9.2).
- Navigation polish for the bigger world (hub ↔ map ↔ area).
**Acceptance:** Playwright run of the first-session flow; screenshots.

### 2.8 Phase 2 hardening & exit — `done (PR #32)`
GDD: §15 Phase 2 exit criteria, §16.3.
- An exit-criteria e2e test (server with simulated clock, plus the browser run): progress through several areas, complete quests, gather resources, clear the crypt and the Gravewarden, unlock the Sunken Abbey.
- An exploit review of all Phase 2 endpoints (timing invariance, idempotency, concurrency on real Postgres, client-trusted values); fix what's found.
- Phase 2 retrospective in this file.

### Phase 2 retrospective (ticket 2.8)
**Exit criteria (GDD §15 Phase 2): met.** Checked end to end twice, with no database shortcuts: through the HTTP API with a simulated clock (`apps/server/src/e2e/phase2-exit-criteria.test.ts`) and in a real browser (`tools/e2e/phase2-exit.mjs`, CI job `e2e-phase2`). A fresh hero farms the Abandoned Fields, moves through Crowwood, the Old Burial Grounds and Blackwater as levels come, equips better drops, gathers materials (best profession 10–14), turns in all five story quests and several contracts, buys, sells, salvages and crafts, clears the Nameless Crypt and the Gravewarden, sees the Sunken Abbey open and farms it. Every gold piece, item and material held at the end matches the audit log. All four classes pass the API run (`E2E_CLASS`).

**Numbers from the runs (record only; no balance changes in this ticket).**
- Level 17 and the Abbey after 30–32 game hours for every class (B.1's farming-only estimate: 33.5–38 h; quest and contract XP make up the difference). 3–10 deaths in the whole run.
- The crypt fell at level 13 in 6 of 7 API runs and in the browser run (one mage failed at 13 and won at 14). B.1's target is "geared level 12 never wins, geared level 15 ≥ 90 %", measured with uncommon tier-3 kits; heroes who farmed their gear (rares, quest jewellery) are ahead of that kit. The crypt is easier than the target for a normal player; worth a look in the next balance pass.
- Gold piles up: 25–30k by level 17, with few sinks (merchant offers cost 20–240, recipes 30–400). Phase 3's upgrades will need to be the sink.
- The 60-slot pack fills within about two game hours at mid levels, so after any 3 h absence it is full and new drops are auto-salvaged. Working as designed, but players will see "pack full" constantly; consider it with Phase 3's warehouse.

**What the exploit review found.** Every Phase 2 endpoint (world/area switch, materials, quests and contracts, crypt runs, merchant, forge, idempotency, onboarding guide) was checked for timing invariance, `Idempotency-Key` semantics, real-Postgres concurrency (including cross-feature races), client-trusted values, ownership, and negative or overflowing values. The locking held up: every value endpoint locks the character row first (after claiming its idempotency key; then the activity, then items or quests), so even cross-feature races serialise. The new real-Postgres races (a crypt claim against sells, salvages, a buy and a turn-in; a crypt entry against settles, a sell, a buy, a craft and a turn-in) reconcile exactly with the audit log, with no deadlock or retry. The sweep test `apps/server/src/exploit-review.test.ts` keeps the rest covered: `404` on all 20 Phase 2 routes for another account's character, foreign item and quest ids, unknown body fields refused, ranges and forged offer ids, malformed keys. Two things were fixed:
- **Fixed: crypt kills counted for quests taken after the run.** A run's outcome is fixed at its start, but its quest events were applied at the claim to every active quest. Taking "The Nameless Crypt" step after a won run had ended (but before claiming) completed it without fighting for it. Now only quests accepted at or before the run's start count its events (`recordQuestEventsTx(…, { acceptedBy })`), the rule farming already had. Test in `dungeon.test.ts`.
- **Fixed: the playtest clock could restart behind a crypt run.** The playtest server floors its clock by the newest stored timestamp in case `clock.json` is lost or stale, but looked only at farming activities, and a hero in the crypt has none. The clock then restarted at real time, behind the run (with `--fast`, days behind), so the run stayed "in progress". It now uses every table that stamps the game clock (`playtest/stored-time.ts`, with a test); verified by restarting `pnpm playtest -- --fast=1200` mid-run with `clock.json` deleted.

**Accepted risks** (reviewed, left as they are):
- A run's `endsAt` is visible at the start, and a failed run ends sooner, so the outcome can be guessed early. There is no way to abandon a run, so nothing can be re-rolled.
- Auto-salvage of crypt drops depends on the pack at claim time, so a player can make room first. Same rule as farming settlement.
- An `Idempotency-Key` expires after 24 h; a retry after that runs fresh. Every value route is also guarded by state except crafting, where a late retry crafts (and pays) again. A key reused on a differently spelled path (e.g. an upper-case UUID) answers `409`, not a replay.
- Bodyless value routes (claim, turn-in, settle, stop) ignore a JSON body instead of refusing it; nothing in it is read.
- The guide's steps are the client's word (it grants nothing). Contract offers for untaken slots change on level-up (documented). Boss loot cooldown and contracts are per character, so a second character doubles them, at the cost of farming it up.
- Phase 1 carry-overs still open: per-account rate limits on game routes; login throttling per account; an equipment change re-simulates the unfinished cycle with the new gear.
- Fast time only: the merchant's "Restocks in …" countdown uses the browser's clock, so it is wrong under `pnpm playtest:fast` and in the e2e servers (cosmetic; noted in `docs/PLAYTEST.md`).

**What went well.** The ground rules from the Phase 1 retrospective worked. Every time-based system shipped with an invariance test, every mutating endpoint with a real-Postgres race test, and the `Idempotency-Key` helper was built once (2.6) and reused by 2.4 and 2.5. Server-authoritative, seeded rules made a 32-hour playthrough an ordinary 5-second test. Vertical slices kept each ticket playable, and parallel tickets merged with little friction thanks to the fixed content ids.

**What to do differently in Phase 3.**
- When an event can happen before the thing that should count it (a quest, an achievement, a leaderboard window), store the window explicitly and test the "taken in between" case. The crypt bug was in the seam between two correct features.
- Every table that stamps the game clock must be part of the playtest clock floor; add new ones to `latestStoredTimeMs`.
- Add per-account rate limits before trading or leaderboards: requests are reward-neutral today, but they still cost database time.
- Run a balance pass with the numbers above (crypt difficulty for farmed gear, gold sinks, pack pressure) before content that builds on them.
- Keep the two exit-criteria runs current: the API run is cheap and catches regressions in the whole loop; extend it rather than writing new one-off flows.

### B.1 Balance pass (from playtest feedback) — `done (PR #31)`
GDD: §2, §6, §9, §18. Starts when the owner's playtest feedback is in (`docs/PLAYTEST_FEEDBACK.md`).
- Phase 1 baseline (1.9): deaths per 30 min at level 1 with no gear were warrior 6.5, hunter 19, warlock 25, mage 29. Casters die far too often.
- Tune the class profiles, enemy stats and XP curve in game-core so that every class can farm the Abandoned Fields with a similar, low death rate, and later areas feel like a step up. Address the owner's feedback.
- Add a simulation-based balance test (per class and area: deaths, kills/min, XP/hour within target bands), so future content can't silently break balance.
- Record the targets and the results in `docs/COMBAT.md`.

## Phase 3 — Loot depth & build progression
GDD §15 Phase 3, §7, §8. **Exit:** different item combinations create meaningful build choices; crafting costs and drop rates are measurable; no single item or affix dominates all builds.

**Ground rules for Phase 3** (the Phase 1 and 2 rules still apply: vertical slices, invariance tests, real-PG concurrency tests, `Idempotency-Key` on value endpoints, the migration rule)
- **One item model.** 3.1 adds every Phase 3 item column in one migration (upgrade level, variant, unique effect, set, lock flag), so the later tickets don't collide on `item_instances`.
- **One effect system.** Legendary effects, Mythic signatures and set bonuses are all data-driven entries in one game-core effect registry (3.2), resolved by **both** combat simulations. The detailed/aggregate equivalence tests (1.4) must keep passing, now with effects.
- **No save-scumming.** Every random forge outcome (upgrade success, reroll result, improvement roll) comes from a per-item, server-side seed stream with a counter that advances on use. Retrying, replaying or racing a request can never re-roll a result. Test each one.
- **Window rule** (Phase 2 retrospective): when an event can happen before the thing that counts it (telemetry windows, quests), store the window explicitly and test the "taken in between" case.
- **Playtest clock:** every new table that stamps game time joins `latestStoredTimeMs`.
- **Balance guardrails:** extend `src/balance/balance.test.ts` with each power source (effects, sets, upgrades, Void). B.2 adds the build-diversity check that makes "no single item or affix dominates" testable.

**Defaults the owner can override** (GDD §17 open items; recorded in the GDD when the ticket lands):
- **Upgrades:** +0 to +10. The success chance falls with the level; a failure consumes the materials and gold but never destroys or downgrades the item; a pity counter guarantees success after N failures.
- **Variants:** only **Void** in Phase 3, on Legendary, Mythic and Set items, with a small stat bonus. **Prismatic is deferred** (the GDD allows it only once the variant pipeline and balance are stable). No variant stacking yet.
- Item Awakening, trading and the warehouse stay out of Phase 3.

**Order** (one session at a time to respect the usage limit, unless noted): 3.1 → 3.2 → 3.3 and 3.4 (may run in parallel) → 3.5 → 3.6 → 3.7 → 3.8 → B.2 → 3.9. Art: A.5 any time; A.6 after 3.3.

### 3.1 Item model v2 & affix depth (vertical) — `done (PR #35)`
GDD: §7.1–7.3, §6.2. Read `docs/LOOT.md`, `docs/DATA_MODEL.md`.
- **Affix pool expansion:** boss damage, XP gain, item find, resource yield, plus a few class-flavoured affixes (e.g. resource generation per class). Affixes are gated by slot, class compatibility, item level and content tier. Find and yield modifiers get caps or diminishing returns in config (like the gold-find cap).
- **Generation rules:** tiers per affix scale with item level, and higher rarities can roll higher tiers. Higher-tier areas and the crypt roll better affixes.
- **Migration** (one for all of Phase 3): `item_instances` gains `upgrade_level` (0–10), `variant` (null | `void`), `effect_id`, `set_id`, `locked` (bool). These are unused until their tickets, apart from the defaults and the view.
- **New affixes do something:** wire them into the existing systems (XP gain into settlement XP, item find into drop chance, resource yield into gathering, boss damage into the crypt boss fight), keeping the invariance tests green.
- **UI:** the tooltip shows the new affixes clearly, grouped (offence, defence, utility). Comparison handles the new stats.
**Acceptance:** generation tests (valid affixes per slot and class, caps); the balance test still passes; screenshots of tooltips.

### 3.2 Legendary effects & Mythic items (vertical) — `done (PR #36)`
GDD: §7.2, §7.4. Needs 3.1.
- **Effect registry** (game-core): data-driven effect types with parameters, e.g.
  - on-crit bonus damage;
  - execute (more damage vs low-health enemies);
  - boss slayer;
  - life on kill;
  - attack speed after a kill (stacks, decays);
  - thorns;
  - damage while above X % health;
  - a class-specific effect per class (e.g. Rage-fuelled strikes, Mana surge).
  Effects must **change play patterns**, not only add numbers (GDD §7.4).
- **Both simulations:** the detailed simulation applies effects; the aggregate simulation must stay distributionally equivalent (extend the equivalence tests), or document precisely where it falls back.
- **Legendary:** a Legendary roll gets one effect from a pool filtered by slot and class.
- **Mythic:** about 6 named Mythic items with fixed signature effects and stronger stats, extremely rare, from late-game sources only.
- **UI:** effect text in tooltips, a distinct Legendary/Mythic frame treatment (restrained; the GDD reserves effects for meaningful events), and a drop moment for Legendary/Mythic in the chronicle and the return summary.
**Acceptance:** an equivalence test with effects; a balance test per effect (no effect alone breaks the death or kill bands); screenshots.

### 3.3 Set items & set bonuses (vertical) — `done (PR #37)`
GDD: §7.4. Needs 3.2.
- 2–3 sets (e.g. one martial and one arcane-leaning, and an optional third for hybrids), 4–6 pieces each, as named items with fixed bases. Bonuses at 2, 4 and 6 pieces through the 3.2 effect registry.
- Late-game sources: Sunken Abbey and the crypt (and 3.6's activity once it exists).
- A Void version of a piece counts as the same piece (GDD §7.4; implement the counting rule now, Void arrives in 3.5).
- **UI:** a set tracker in the character screen and the tooltip (pieces owned and equipped, active bonuses).
**Acceptance:** set counting tests (including Void equivalence with a synthetic Void item); a balance test; screenshots.

### 3.4 Forge: upgrades, reroll, affix improvement (vertical) — `done (PR #40)`
GDD: §8.1, §8.3. Needs 3.1. Can run in parallel with 3.3 (different files; migration rule).
- **Upgrade +0…+10:** raises base values. The success chance falls with the level, with a pity guarantee. Failure never destroys or downgrades. The cost (gold + materials) rises steeply; this is the main **gold sink** (Phase 2 retrospective: 25–30k gold by level 17).
- **Affix reroll:** the player picks one affix; it is replaced from the slot's pool while the others are kept. The cost rises with each reroll of the same item.
- **Affix improvement:** raises one affix toward its tier's maximum in steps, within a cap.
- **No save-scumming:** a per-item seed stream with a counter. Results are revealed only after paying; replay and race tests.
- **UI:** a Forge tab with an upgrade track (success chance, pity progress, cost), reroll (pick an affix, see the possible range) and improvement (current vs cap).
**Acceptance:** PG race tests (double upgrade, upgrade vs sell or salvage); no-re-roll tests; a gold-sink measurement recorded in `docs/ECONOMY.md`; screenshots.

### 3.5 Void variants (vertical) — `done (PR #42)`
GDD: §7.5. Needs 3.2 and 3.3.
- Void can roll only on Legendary, Mythic and Set items, with a small stat bonus. The chance is strictly capped in config. A long-term progression hook that improves discovery (capped) is optional; if implemented, keep it account-bound and measurable.
- Void set pieces count for their set (3.3's rule).
- **Visual:** a reusable overlay or palette treatment on the base item art (CSS filter or blend plus an optional PixelLab-generated texture), with no new per-item art (GDD §7.5). Restrained, not a glow on everything.
**Acceptance:** rarity and variant distribution tests; screenshots of Void items in the grid, tooltip and drop moment.

### 3.6 Late-game activity & targeted loot (vertical) — `done (PR #43)`
GDD: §6.4, §11.2, §15 Phase 3 ("late-game activities and more targeted loot tables"). Needs 3.2 and 3.3.
- **Deeper Nameless Crypt tiers:** Tier II and III scale enemies, the Gravewarden and rewards to levels 18–22+, unlocked by clearing the previous tier. They reuse the existing art and rules; each tier is data.
- **Targeted loot:** each tier or boss has a declared loot focus (e.g. specific set pieces, a slot group or an effect family). Abbey contracts can offer a targeted reward (a choice of slot). The player can plan toward a build instead of farming blind.
- Also address the Phase 2 note that the crypt is easier than its target for heroes with farmed gear (tune tier I here or in B.2; record which).
**Acceptance:** determinism and invariance tests; a claim race test; a balance test per tier; screenshots.

### 3.7 Loot filter & pack management (vertical) — `done (PR #44)`
GDD: §1.3, §14 (steps 4–5); Phase 2 retrospective (the pack fills in about two game hours). Needs 3.1.
- **Loot filter rules per character:** auto-salvage or auto-sell drops below a chosen rarity, or without chosen affixes or effects. Applied server-side at settlement and claim, and audited.
- **Item lock:** locked items can't be sold, salvaged or discarded (the `locked` column from 3.1).
- Bulk actions in the Pack; a clearer "pack full" state with what happened to overflow.
- The warehouse stays out (GDD: later); note it as a follow-up.
**Acceptance:** filter determinism and invariance; PG races (settle vs filter change, sell vs lock); screenshots.
**Follow-up (warehouse, GDD: later):** a full pack still overflow-salvages *every* drop that finds no room, Legendary, Mythic, set and Void included (unchanged capacity rule; the filter can only free room). A warehouse or an overflow stash for protected drops would close this.

### 3.8 Loot & economy telemetry — `done (PR #46)`
GDD: §16.4, §15 Phase 3 ("telemetry for drop rates, item usage and build distribution").
- Privacy-conscious, server-side aggregates only. No client tracking and no personal data:
  - drop counts by rarity, variant, effect and area;
  - equipped-item usage by base, effect and set;
  - build distribution per class (top affix and effect combinations);
  - forge spending (gold and materials by action);
  - gold sources and sinks.
- Aggregation into daily rollup tables inside the existing transactions, or from the audit log, with no extra writes on hot paths beyond counters.
- A report command (`pnpm report:telemetry`) printing a readable summary, for balance work. No admin UI yet (no roles exist); document how it would be exposed later.
**Acceptance:** rollup correctness tests (PG); report output in the PR.

### B.2 Balance pass: loot depth & economy — `done (PR #48)`
GDD: §7, §8.3, §15 Phase 3 exit. Needs 3.1–3.8.
- **Build diversity check** (makes the exit criterion testable): simulate the best builds per class from the item pool (affixes, effects, sets, upgrades, Void). Assert several distinct builds within a few percent of the best, and that no single item, effect or affix appears in all top builds.
- **Economy:** forge costs vs gold income (the sink works without making upgrades a grind wall); material demand vs gathering; drop rates for Legendary, Mythic, Set and Void measured with 3.8's telemetry, and documented.
- Crypt tier difficulty for farmed gear (the Phase 2 note) if 3.6 didn't settle it.
- Address the owner's playtest feedback if it has arrived.
**Acceptance:** the extended balance test is green and fast; before/after tables in `docs/COMBAT.md` and `docs/ECONOMY.md`.

### 3.9 Phase 3 hardening & exit — `done (PR #49)`
GDD: §15 Phase 3 exit, §16.3.
- **Exit-criteria e2e:** extend the API and browser runs: find a Legendary and a set piece, upgrade, reroll and improve, use the loot filter, run a deeper crypt tier, and reconcile everything with the audit log.
- **Exploit review of all Phase 3 endpoints:** no re-roll by retry, race or replay; upgrade and pity integrity; filter and lock races; cross-feature races; client-trusted values; ownership.
- **Per-account rate limits** on game routes (Phase 1–2 carry-over), before trading and leaderboards arrive.
- Phase 3 retrospective in this file.

### Phase 3 retrospective (ticket 3.9)
**Exit criteria (GDD §15 Phase 3): met.** *Meaningful build choices* and *no single item or affix dominates* are B.2's build-diversity test (`balance/builds.test.ts`: several distinct builds within a few percent of the best per class, nothing in every top build), which stays green. *Crafting costs and drop rates are measurable* is checked end to end twice, with no database shortcuts. Through the HTTP API with a simulated clock (`apps/server/src/e2e/phase3-exit-criteria.test.ts`, ~15 s): the Phase 2 hero (`e2e/journey.ts`, now shared by both API runs) plays on past the Abbey — a loot filter sells commons and uncommons and is seen acting; the hero finds a Legendary and a set piece and locks them (sell, salvage and discard answer `409 item_locked`); upgrades worn gear (every one of 110–200 attempts matches the item's server-side stream, failures and pity-guaranteed successes included), rerolls and improves an affix; turns in a targeted Abbey contract for a ring; clears crypt tiers II and III; lets the pack fill until a valuable drop is kept beyond its capacity (B.2). Everything held matches the audit log, and the real `pnpm report:telemetry -- --reconcile` on that run's database reports every check matching and measures the drops and forge spending seen. In a real browser (`tools/e2e/phase3-exit.mjs`, CI job `e2e-phase3`): a fresh hunter does the same with every Phase 3 feature's first use through the UI (filter, lock, Forge upgrade/improve/rework, targeted contract, every crypt tier), no request rate limited, and CI reconciles the telemetry of the server's database afterwards (`E2E_DATA_DIR`). All four classes pass the API run (`E2E_CLASS`, eight runs).

**Numbers from the runs (record only; no balance changes in this ticket).** Eight API runs (each class twice):
- The Phase 2 part ends after 26–32 game hours; the whole Phase 3 checklist after 48–74 h, at levels 22–28. 3–9 deaths in the whole run.
- Crypt tier II fell at its entry level 18 in 6 of 8 runs (19 and 20 in the others); **tier III fell on the first attempt at its entry level 21 in all 8 runs** (the browser hunter, which upgrades less, won it at 24 in both browser runs, once after a loss at 23). The e2e hero spends its gold on upgrades like B.2's realistic player, so by 21 it wears upgraded Abbey gear; B.2's farmed-gear table expected 17–42 % at 21 with +0 and 67–83 % with +5. Tier III is easier than intended for a player who upgrades; worth a look in the next balance pass.
- Levels keep rising past the content: 22–28 at the end (tier III's boss is level 24, the Abbey's top level 22). With B.2's farming breakpoint (past ~22 every late-game build one-shots the Abbey) there is nothing left to farm toward at the top.
- Forge: 112–196 upgrade attempts per run, 23–41 % of them failures, 2–5 pity-guaranteed successes, 19k–133k gold spent on upgrades (more the longer the run: the sink keeps absorbing gold).
- The loot filter (sell below rare) sold 600–2,400 drops per run.

**What the exploit review found.** Every Phase 3 endpoint (forge upgrade/reroll/improve, loot filter, lock/unlock, bulk sell and salvage, crypt tiers and claims, targeted contracts, over-capacity placement, the telemetry write path) was checked for re-roll by retry, race or replay, upgrade and pity integrity, filter and lock races, cross-feature races, client-trusted values, ownership, and negative or overflowing values. Two things were fixed:
- **Fixed: a targeted contract's reward could be computed in advance.** The item's seed was derived from the quest row id (`targetedRewardSeed`), which the client sees, with a public algorithm, so a player knew the exact item (base and affixes) the moment the contract was taken. It could not be re-rolled (no way to drop or re-take a contract), but it broke "results are revealed only after paying". The server now draws a random seed at acceptance, stores it in the reward and strips it from every view; older rows keep the row-id seed. Tests in `quests.test.ts` (no seed in any response, the item comes from the stored seed, the legacy fallback) and a real-Postgres race of turn-ins with the same and different keys.
- **Fixed: no per-account rate limit on game routes** (Phase 1–2 carry-over). Every route behind the session check now counts per account: 900 requests and 300 actions a minute (three tabs of busy play), `429 rate_limited` with `Retry-After`, checked before any game work or `Idempotency-Key` claim (`auth/account-rate-limit.ts`, `docs/API_CONVENTIONS.md`). The API e2e runs and `test:pg` run with the defaults; the browser run fails on any `429`. Only the settle-frequency invariance test raises it (it settles hundreds of times a second on purpose).

Checked and holding: the forge stream (`forge_secret` never leaves the server; the counter advances in the transaction that applies the draw; replays return the stored outcome; races serialise on the item lock) — the API run checks every upgrade against the stream; the pity resets on success and is per step; a new real-Postgres race puts a tier II claim, an upgrade, a reroll, an improve, a sell, a salvage, a lock, an unlock, a filter change and two targeted turn-ins on one item and one hero at once (three rounds, varied orders) and reconciles gold, items, materials, forge counters and telemetry with the audit log, order-independently, with no deadlock or retry. The sweep (`exploit-review.test.ts`) now also covers the forge item view and discard (`404` for foreign items), crypt tiers (0, 4, 1.5, `'II'`, 1e20 → `400`; a tier above the one cleared → `409`), forged reward slots and loot-filter ids, and Phase 3 bodies with client-chosen outcomes (`tier` + `bossLoot`, `rewardSlot` + `seed`/`rarityId`). The telemetry write path takes no client input: its dimensions are content ids or server enums, written only inside the value transactions.

**Accepted risks** (reviewed, left as they are):
- The crypt claim applies the loot filter and the pack count in force at the claim, and `dungeon/settle` shows the run's drops before it, so a player can pick the filter for known drops. A filtered drop pays exactly what selling or salvaging it by hand would, so nothing is gained.
- Valuable drops kept over capacity are unbounded storage (bounded by the drop rate, ≈ 0.3 an hour in the Abbey). The warehouse is the real answer.
- Fastify's Ajv coerces numeric strings in bodies (`tier: "2"` is 2); the value is still validated as the integer.
- Upgrade, reroll and improve share one stream per item, so the player chooses which action spends the next draw; draws are unknown until spent, so the choice carries no information.
- The per-account limits live in process memory (one API instance, like the login limits); a scaled deployment needs a shared store. Login throttling is still per IP only.
- Forge work on a locked item is allowed (the lock only blocks disposal), by design.
- Phase 2's accepted risks still stand (run `endsAt` visible, idempotency keys expire after 24 h, crafting is guarded only by its key).

**What went well.** The Phase 3 ground rules paid off: one item model and one effect system meant the e2e hero could exercise every feature on the same items; the per-item forge stream made "no save-scumming" checkable at every single upgrade of a 200-upgrade run; telemetry built inside the value transactions reconciled exactly in every run and every race. Extending the Phase 2 player instead of writing a new flow kept the run honest (no shortcuts) and cheap (~15 s).

**What to do differently in Phase 4.**
- Derive nothing secret from ids the client sees. A seed must come from a server-only secret, like the farm, crypt and forge streams; review every new "deterministic from X" for whether X is public.
- Race tests: assert what holds in every order (reconciliation, at-most-once), never the order itself; run each race a few rounds (PRs #38, #45, #47 and this ticket's).
- Rate limits exist now: size new polling or bulk endpoints against them, and give trading and leaderboards their own, tighter limits.
- Keep the exit-criteria journey current: extend `e2e/journey.ts` for each phase.

**Open follow-ups.**
- **Warehouse** (GDD: later): storage for kept drops; today valuables pile up beyond the pack and ordinary overflow is salvaged.
- **Prismatic variants**: deferred (GDD §7.5: only once the variant pipeline and balance are stable; Void has been stable since 3.5/B.2).
- **Item Awakening** (GDD §8.2, optional) and **trading** (needs moderation, abuse controls and its own rate limits): not started.
- **The farming breakpoint at the top** (B.2): past ~22 every late-game build one-shots the Abbey and levels run on to 28 with no content above 24; together with tier III falling at 21 to upgraded gear, the top end needs content or a cap.
- **Playtest feedback**: `docs/PLAYTEST_FEEDBACK.md` is still the empty template; B.1 and B.2 were tuned from simulations only.

## Phase 4 — Online social layer & community world
GDD §15 Phase 4, §10.1, §12, §16.3. **Exit:** players can take part in social systems safely; shared progress is consistent; permissions, moderation and abuse reporting are in place.

**Ground rules for Phase 4** (the Phase 1–3 rules still apply: vertical slices, invariance tests, real-PG concurrency tests, `Idempotency-Key` on value endpoints, the migration rule, the window rule, the playtest clock)
- **Safety before reach.** No player-written text or player-to-player interaction ships without length limits, a text filter, a report action, moderator actions and per-account rate limits in the same ticket. 4.1 builds these once; later tickets use them.
- **Privacy.** Public views show only the display name, character names and what the player chose to show. Never an email, account id, IP or exact last-seen time. A blocked player is invisible to the blocker everywhere (profiles, friends, guild invites, chat).
- **Nothing secret from public ids** (Phase 3 retrospective). Public handles are opaque; no seed or reward may derive from anything the client can see.
- **Permissions as data.** Roles (account: player / moderator / admin; guild: leader / officer / member) and what each may do are a table in code, with one permission-matrix test per feature (every role × every action, including "not a member" and "blocked").
- **Shared counters are exact.** Community and guild totals are written in the same transaction as the contribution and audited, like 3.8's telemetry; races reconcile with the audit log. Race tests assert what holds in every order, never the order.
- **No monopoly** (GDD §12.2): contributions to shared goals have per-player caps or diminishing returns, so a few high-power players can't finish everything alone. Individual rewards can coexist with global milestones.
- **Polling, not sockets.** Social screens poll with cursors and `ETag`/`since` (one API instance, like the rate limits). Size every polling endpoint against 3.9's per-account limits, and give social writes their own, tighter limits.
- **Extend the journey.** Each ticket adds its steps to `apps/server/src/e2e/journey.ts`; 4.11 turns it into the Phase 4 exit run with two or more players.

**Defaults the owner can override** (recorded in the GDD when the ticket lands):
- **Communication:** guild chat only. No global chat and no direct messages in Phase 4.
- **Presence:** coarse buckets only (online now / today / this week / longer), visible to friends and guildmates, and the player can hide it.
- **Group activity:** an asynchronous weekly guild boss (members fight it at their own time, damage adds up), not real-time co-op.
- **Trading stays off.** 4.10 only decides item binding and the trade rules, for a later phase.
- **Warehouse:** per character (no item transfer between characters, so no binding question yet), opened for everyone by the first community project.
- **Moderation:** the owner is the first admin (granted by a CLI command); moderators work in a minimal in-app queue.
- **Guilds:** creating one costs gold (a sink); up to 30 members.

**Order** (one session at a time to respect the usage limit, unless noted): 4.1 → 4.2 and 4.3 (may run in parallel) → 4.4 → 4.5 → 4.6 → 4.7 → 4.8 (after A.7) → 4.9 → 4.10 → B.3 → 4.11. Art: A.7 after 4.6 (before 4.8); A.8 after 4.2 and 4.4.

### 4.1 Roles, safety & moderation foundation (vertical) — `done (PR #51)`
GDD: §10.1, §16.3. Read `docs/API_CONVENTIONS.md`, `docs/DATA_MODEL.md`, `apps/server/src/auth/`.
- **Account roles:** player, moderator, admin, stored on the account and checked server-side. A CLI command grants and revokes roles (`pnpm admin:role …`); the first admin is the owner. No role can be gained through the API.
- **Player text module** (game-core/server, used by every later social ticket): normalisation (Unicode NFKC, trimmed, no control or invisible characters), length limits per kind, a data-driven block list with simple evasion handling, and a link policy (no links in Phase 4).
- **Reports:** any player can report a player, a profile field, a guild or a message (reason + optional note). One open report per reporter and target. Reports are rate limited and audited.
- **Sanctions:** moderators can mute (no social writes), suspend (no login) for a time, force a rename, and hide content. Every sanction has a reason, an expiry, an audit row, and is visible to the player ("why can't I post?").
- **Moderator queue:** a minimal in-app screen for moderators and admins (open reports with context, act, dismiss), styled per the design system. Everyone else gets `404`.
- **Social rate limits:** a tighter per-account limit class for social writes, on top of 3.9's limits.
- **Migration:** account roles, reports, sanctions. Public handles for accounts (opaque, not the account id) for later profile links.
**Acceptance:** permission matrix test (player / moderator / admin × every moderation action); text filter tests (evasion cases, limits); report and sanction races (real PG); screenshots of the report dialog and the moderator queue.

### 4.2 Public profiles & achievements (vertical) — `done (PR #55)`
GDD: §10.1, §5.3. Needs 4.1.
- **Profile page** per account, reached by display name or handle: display name, characters (portrait, class, level), selected achievements, and an optional showcase of one character's equipped gear. A privacy setting: public / friends and guild / hidden. Report action on every profile.
- **Achievements:** data-driven definitions in game-core (e.g. first Legendary, clear crypt tier III, +10 item, complete a set, finish N contracts). Awarded server-side from the events that already exist (audit and quest events), with a backfill from existing progress. The player picks up to N to show.
- Players with a block relation (4.3) or a hidden profile get `404`.
**Acceptance:** achievement award and backfill tests (no double award under races); privacy tests (each setting × viewer relation); screenshots desktop and mobile.

### 4.3 Friends & presence (vertical) — `done (PR #54)`
GDD: §10.1. Needs 4.1. May run in parallel with 4.2.
- **Friends:** request, accept, decline, cancel, remove, and **block** (block removes the friendship and pending requests and hides each player from the other). Caps on friends and pending requests.
- **Presence:** coarse buckets from the last authenticated request (online now / today / this week / longer), shown to friends only (guildmates in 4.4). A setting hides it. No exact timestamps leave the server.
- Friends list in the UI with presence, the requests inbox, and a link to each profile.
**Acceptance:** permission/relation matrix (stranger, requested, friend, blocked either way); request races (both send at once → one friendship); presence never reveals exact times; screenshots.

### 4.4 Guilds (vertical) — `done (PR #59)`
GDD: §10.1, §4.2 (Guild Hall). Needs 4.1 (and 4.3 for presence).
- **Create** (gold cost; name and tag through the text module; unique case-insensitively), **invite / apply / accept**, **leave**, **kick**, **promote / demote** (leader, officer, member), **transfer leadership**, **disband**. Up to 30 members; one guild per account.
- **The Guild Hall** in the hub opens (it is shown locked today): the guild page with members, roles and presence, plus a guild profile reachable by others (report action).
- Moderators can force-rename or disband a guild (4.1 sanctions).
- Leaving or a kick takes effect at once in every guild feature; a leader leaving must hand over or disband.
**Acceptance:** permission matrix (each guild role and non-member × each action); races (two leaders promote/kick each other, joins at the cap, accept vs disband) on real PG; gold cost audited and reconciled; screenshots.

### 4.5 Guild communication (vertical) — `done (PR #67)`
GDD: §10.1. Needs 4.4.
- **Guild chat:** messages through the text module, cursor-paginated polling, a sensible history limit. A guild "notice" the leader and officers can set.
- **Moderation:** report a message; officers can delete members' messages in their guild; moderators can hide any message and mute (4.1). Muted players see why.
- Blocked players' messages are hidden for the blocker. Leaving the guild ends access to its chat at once.
- Polling stays within the rate limits for a busy guild (document the numbers).
**Acceptance:** permission matrix (roles × post/delete/notice/report); ordering and pagination under concurrent posts (real PG); filter and mute enforced server-side; screenshots.

### 4.6 Community projects & world state (vertical) — `done (PR #68)`
GDD: §12.1, §12.2. Needs 4.1.
- **Global projects:** data-driven, with stages that need materials and gold. Any player contributes from their own holdings. Totals and stage completion are exact under concurrency (same transaction, audited).
- **No monopoly:** per-player daily caps or diminishing returns per stage; individual rewards for contributors (e.g. a title or achievement from 4.2, never power) alongside the shared unlock.
- **World state:** completed projects set global flags that game-core content reads (areas, buildings, recipes). One source of truth, cached, invalidated on completion.
- **First project: Restore the Graumark Warehouse.** Completing it opens the Warehouse for everyone (built in 4.7). **Second project: Clear the Ashen Pass**, which opens the new region in 4.8.
- UI: a project board in the hub showing progress, your contribution and the remaining cap; a world notice when a project completes.
**Acceptance:** contribution races at the stage boundary (real PG: no over-fill, no lost contribution, exactly one completion); caps enforced per window; reconcile with the audit log and telemetry; screenshots.

### 4.7 Warehouse (vertical) — `done (PR #70)`
GDD: §4.2 (Warehouse). Needs 4.6 (unlocked by its first project). Phase 3 follow-up.
- **Per-character storage** in the Warehouse building: move items between the pack and the warehouse; locked and valuable items allowed. Capacity with upgrades (gold sink).
- **Over-capacity follow-up:** valuables kept beyond the pack (B.2) can be moved to the warehouse; the pack banner points there.
- Items in the warehouse are never touched by the loot filter, settlement or crypt placement.
**Acceptance:** move races (move vs sell vs settle on one item, real PG); capacity at the boundary; invariance (an empty warehouse changes nothing); screenshots.

### 4.8 The Ashen Pass: top-end region (vertical) — `done (PR #71)`
GDD: §4.3, §12.2. Needs 4.6 (unlocked by its second project) and A.7 (art). Phase 3 follow-up: content ends at 24 while heroes reach 28, and B.2's farming breakpoint leaves nothing to farm toward at the top.
- **A new area for levels 24–28** (enemies, loot table, materials) and a **boss**, as data. It is a world-state unlock: closed until the community finishes the project.
- **Address the top end:** an area level and rewards that keep late-game builds meaningful past the Abbey breakpoint; tune crypt tier III against upgraded gear (3.9 saw it fall at 21 to every upgraded hero).
- **Fixed ids (art from A.7):** area `ashenPass` (levels 24–28); enemies `ashWraith`, `cinderHound`, `pyreCultist`, `emberGolem`; boss `ashenWarden`. Asset ids are `area.ashen-pass` and `enemy.<kebab-id>` (already registered); add a `MAP_MARKERS` entry for `ashenPass` (`docs/ASSET_GUIDELINES.md`, "The Ashen Pass").
**Acceptance:** balance tests for the new area and boss; determinism and invariance; the world-state gate tested; screenshots.

### 4.9 Guild boss event (vertical) — `done (PR #69)`
GDD: §10.1 (group activities), §11.2. Needs 4.4.
- **A weekly guild boss:** each member may fight it a few times a week with their own hero (a server simulation from a snapshot, like crypt runs); damage adds up to the guild's total. Stages unlock guild-wide rewards; each participant gets a capped personal reward.
- **Fair and exact:** attempts come from server-side seed streams (no re-roll by retry), totals are exact under concurrent attempts, a member who leaves keeps their personal reward but their damage stays with the guild they fought for, and joining late can't claim rewards already earned.
- A guild-only damage board (global leaderboards are Phase 5).
**Acceptance:** attempt races and week-boundary window tests (real PG); invariance; balance test (a small guild can finish the first stage, a large one can't trivialise every stage); screenshots.

### 4.10 Trading & item binding: decision (docs) — `done (PR #72)`
GDD: §10.1, §17 (trading and item binding), §16.3. No trading code.
- Decide and document item binding (bind on pickup / bind on equip / tradeable, by rarity, variant and source), what a trade may include (items, gold, materials), anti-abuse rules (account age, level, limits, audit, rate limits, reversal by moderators) and the real-money-trading risk.
- Record the decision in GDD §17 and a ticket outline for the phase that builds it. The owner signs off.
**Acceptance:** the owner approves the decision document in the PR.

### B.3 Balance pass: top end & social economy — `done (PR #73)`
GDD: §8.3, §12.2, §16.4. Needs 4.6–4.9.
- The top end with the Ashen Pass (levels 24–28, the breakpoint, crypt tier III).
- New gold and material sinks and sources (guild creation, project contributions, warehouse upgrades, guild boss rewards) measured with 3.8's telemetry and the realistic player.
- Community projects: how long each stage takes at different player counts, and that the caps prevent monopoly.
- Address the owner's playtest feedback if it has arrived.
**Acceptance:** extended balance tests green and fast; before/after tables in the docs.

### 4.11 Phase 4 hardening & exit — `done (PR #74)`
GDD: §15 Phase 4 exit, §16.3.
- **Exit-criteria e2e** with several players: profiles and achievements, friends and block, a guild with chat and moderation, a report handled by a moderator, contributions finishing a community project (warehouse opens), the Ashen Pass unlock, and a guild boss week, all reconciled with the audit log and telemetry. Browser run included.
- **Exploit and abuse review** of every Phase 4 endpoint: permissions, privacy leaks (block, hidden profiles, presence), spam and flooding, text-filter evasion, contribution and guild-boss races, ownership, client-trusted values.
- Rate limits reviewed for social polling and writes; the in-memory limiters' single-instance limit recorded.
- Phase 4 retrospective in this file.

### Phase 4 retrospective (ticket 4.11)
**Exit criteria (GDD §15 Phase 4): met.** *Players can take part in social systems safely; shared progress is consistent; permissions, moderation and abuse reporting are in place.* Checked end to end through the HTTP API with a simulated clock and several players (`apps/server/src/e2e/phase4-exit-criteria.test.ts`, ~25 s; `e2e/journey.ts` extended, no database shortcuts but the owner's documented CLI steps). The owner opens the town invite-only (first code by `admin:invite`, admin by `admin:role`; registration without a code, with a spent code or a revoked code is refused) and invites the players from the admin panel. The hero plays Phase 2 to the Sunken Abbey; reports a mocking name (a moderator forces the rename, the offender sees why); befriends a companion, blocks a pest (who then finds nothing of the hero); shows achievements on a profile (hidden, it is a 404); founds a guild, runs its chat and notice; a member's taunt in the chronicle is reported, the moderator mutes them from the queue (the muted player is refused with the reason and sees it in their standing; reading, contributing and fighting go on), a second report hides the line (a tombstone for everyone, the words never sent). Five players farm on one clock and give daily shares until the Warehouse is restored (every stage had three or more givers; no gift above the cap; every contributor wears the mark); the hero uses the Warehouse. A guild boss week: a member and the officer fight, the leader breaks the first stage; a member who never fought has it only pending; the member who fought leaves and still claims (their damage stays on the board as a former member's); a player who joins after the stage earns nothing for it. The players give to the Ashen Pass, the owner finishes it with `admin:project complete`, the hero farms the pass and climbs the Warden's Watch (won or lost). The admin panel's read paths work, and answer every other role the not-found 404. Every hero's holdings match the audit log; `reconcileWithAudit` and the real `pnpm report:telemetry -- --reconcile` on the run's database match in every check; and a guard on **every response of the run** found no other player's email, account id or hero id. In a real browser (`tools/e2e/phase4-social.mjs`, CI job `e2e-phase4`, ~25 s): three players register; a friend request is accepted at the door (presence a bucket, no time on the page); a pest's request is answered with a block and the pest can no longer find the hero; a player reports the hero from the profile; the seeded moderator mutes them from the queue and the hero sees the reason on the standing strip and the account screen; the hero gives farmed gold to the town works while the Warehouse still shows closed; the seeded admin reads status, invites, telemetry (reconcile: all checks match), a search and a player file without any email on the page; and a player at `#/moderation` and `#/admin` is sent home like at an unknown address. Guild, chat, boss and project completion stay in the API run (a guild costs 5,000 gold: too long to farm in real time). Noticed there (not changed): a player muted while a page is open sees the standing strip only after a reload or a visit to the account screen (the refusal itself carries the reason at once).

**Numbers from the runs (record only; no balance changes in this ticket).** Four API runs (the hero a warrior; the helpers a mage, a hunter, a warlock and a warrior):
- The hero's Phase 2 part ends after 30 game hours; with the town it reaches 24 within 12–14 two-hour town visits (24–28 h) and climbs the Watch at 26–27 after 68–74 game hours in all.
- **The Warehouse opened on the second game day in every run** with five players (35–37 gifts; each stage had three to five givers), in line with B.3's table for a town that gives daily (with gathering: 4 days for 3 players, 2 for 10). The helpers were levels 14–16 by then.
- **Guild boss:** four members (a level 24–27 leader and three level 14–16 helpers) counted 36,000–55,000 damage in 7 attempts: stage 1 (18,000) every time, stage 2 (100,000) never; one late attempt more. Matches 4.9/B.3's tables (a small guild breaks the first stage).
- **The Warden's Watch** at 26–27, in Abbey and early Pass gear: won 2 of 4 (its entry level is 26; DUNGEONS.md expects it uncertain there).
- 70 telemetry reconcile checks per run, all matching.

**What the exploit and abuse review found.** Every Phase 4 endpoint (profiles, achievements, friends, blocks, presence, reports, sanctions, the moderator queue, guilds, guild chat and notice, community projects, the warehouse, the Ashen Pass and the Watch, the guild boss, the admin panel, invites, legal pages) was checked for permissions, privacy leaks, spam and flooding, text-filter evasion, races, ownership, client-trusted and non-finite values, unknown fields and seeds derivable from public ids. Fixed, each with a test (`hardening.test.ts`, `hardening.pg.test.ts`, game-core `text.test.ts`):
- **High — a moderator saw and could dismiss reports about themselves.** A guild report names the guild's leader at the time; after a handover one guild held reports about two players in one case. A moderator who had taken over a reported guild saw the reports about them (reporter and note) and closed them with the case. Now a case is one target *and* one subject, and a viewer sees only reports whose subject they may act on.
- **Medium — guild actions checked the leader the report named, not the leader now:** a moderator could disband or rename a guild whose leadership had passed to an admin (or to a peer moderator). Now the rank rule runs against the current leader.
- **Medium — Greek and Cyrillic capitals got past the reserved staff names** (`ΑDΜΙΝ`, `ΜΟDΕRΑΤΟR`) and some blocked terms (`ΝIGGER`, Armenian `fսck`, small-capital `ꜰuck`), and `ADMlN` / `WorIdforge` passed. Capital look-alikes are folded before lower-casing, and terms are also matched with `I` and `l` read alike; the server's placeholder names are reserved.
- **Medium — blocks left the guild offers they hide in place,** invisible to whoever could clear them: a leader who blocked 30 spam petitioners closed the guild to petitions, a player who blocked 20 inviting leaders could receive no invite, and an officer could still invite a player blocked with the leader. A block now drops the hidden invites and petitions in its transaction; officers cannot invite players blocked with the leader, nor withdraw (probe) an invite to a player blocked with them; the guild profile no longer shows such an invite. Exact under races (real PG).
- **Low — a deadlock:** two moderators answering different reports of one case each held their report and waited for the other's (Postgres broke it; the retry answered `409`). The case's reports are now locked in id order. Found by the new race test.
- **Low — non-finite numbers answered 500:** `?since=1e309`, `?limit=Infinity` (every integer query) passed Ajv's coercion and reached PostgreSQL. A root `preHandler` refuses them with `400`.
- **Low — staff routes could be told from missing ones** by the `Cache-Control: no-store` header on the admin 404 and by a malformed JSON body (`400` from the not-found handler, `404` from a real route). Catch-alls behind the same hook, header on admin answers only.
- **Low — link filter evasions:** `t.me/…`, ideographic and half-width full stops, `(.)` / `[.]`, `hxxp://`, `discord gg`, bare IPs and missing country domains passed; and the filter refused ordinary sentences ("Done. Me next", "Ok. Co-op tonight?") as links. Both fixed; the notice is held to 8 lines (a 150-line column passed).
- **Low — report spam and probing:** reports were bounded only by the social class (240 an hour, each field, hero name and line its own target); now 20 waiting per reporter. A `characterName` report confirmed a guessed hero name of a hidden profile; now only a player who can see the profile can report a hero name.
- **Low — the presence setting** was not a social write and wrote an audit row per call (≈ 300 a minute possible): now a mute-exempt social write, audited on change.
- **Low — an admin's player file showed who reported an admin** (their own included); reports about admins are handled outside the app, so the file lists none.

Checked and holding: the permission matrices (re-run; the moderation matrix needed only a fresh reporter past the new report cap); 404 bodies identical for unknown, hidden, friends-only and blocked profiles, lookups, guilds, applies and invites; presence only as buckets (no time, ETag or order leaks); no emails anywhere outside the player's own account (the run-wide guard); every social write through `socialWrite` with the documented mute exemptions; community contributions exact (caps per account across heroes, the window, no over-fill, `stage_changed`, replays and key conflicts; duplicate or non-positive resources refused); the warehouse closed before any ownership check, moves all-or-nothing, foreign and other-hero items `404`, stored items out of every other path; the Ashen Pass and the Watch gated by the flag on every server path; the guild boss stream from a server-only secret (no seed in any response; attempt ids unrelated), three attempts per account and week across guilds and heroes, rewards earned once, claims paid once; handles (60 bits) and invite codes (80 bits) random, codes stored hashed and shown once; unknown fields refused everywhere.

**Accepted risks** (reviewed, left as they are):
- **Look-alike display names:** `Аlice` (Cyrillic а) can sit next to `Alice`, and a forced rename can be dodged with one look-alike letter of the old name: uniqueness and the rename check compare `lower()`. Closing it needs a confusable skeleton column with a unique index (a migration with a backfill that could collide on live names); left for a later ticket. Moderators can rename again.
- **A forced guild rename is easy to get around:** the old tag may be taken back, a near-identical name is accepted, and another account may found a guild with the removed name at once. Moderators can act again; a reserved-names store is a later ticket.
- **Hidden profiles are not secret:** a hidden player's existence and handle can be learned by name from the friend-request and block paths (and the relation endpoint answers `stranger`), as registration already tells whether a display name is taken. Hiding a profile hides what it shows, not that the name exists (documented in SOCIAL.md).
- **Blocking back tells you that you were blocked** (`POST /api/blocks` on a player who blocks you answers `200`, an unknown handle `404`); 4.3 chose that you may always block and report someone, so the block-back stays.
- **Guild chat:** the blocked side's polls skip the blocker's sequence numbers and repeat them in `gone`, so a blocked member can tell the blocker is posting; a guild report is accepted from a player the leader blocks (block-and-report); a boss stage's `reachedAt` is exact. All three are by design or harmless.
- **Ashen Pass contracts are never offered** (fixed in F.1 below): the daily contract board does not pass the world flags, so the Pass's contract templates stay closed even after the flag (fails safe). Turning them on changes the late-game contract offers and the gold and item income: a balance decision for the owner, not a hardening fix.
- **Warehouse moves during a crypt run** change the pack count the claim sees (as selling already did; drops never change). **Merchant stock** is seeded from the hero id and the day, so future stock can be computed by its owner (planning value only; purchases are checked).
- **JSON bodies still coerce** (`amount: "5"`, `true` → 1; 3.9's accepted risk), now without non-finite values.
- **The narrow race of an officer's invite and a block of the leader** is closed only because both take the invitee's social lock; a future path that creates invites must take it too (noted in the guild model).
- Phase 2 and 3 accepted risks still stand.

**Rate limits** (docs/SOCIAL.md "Rate limits and a second API instance"). Worst case one tab on the Guild Hall polls ≈ 22 times a minute (chat every 5 s, the rest ≤ 1 a minute with `ETag`s), three tabs ≈ 66 of 3.9's 900; chat at one line every 5 s is exactly 4.1's social class (12 a minute). Every Phase 4 write is a social write except the value operations that carry no text (contributions, warehouse, boss claims). **The limiters, the world-state cache and the scheduler live in one process**: a second API instance would multiply every limit and see a flag up to 60 s late; it needs a shared store for the limiters (Redis or a PostgreSQL counter table), cache invalidation across instances (`LISTEN/NOTIFY`) and one scheduler (an advisory-lock leader). Until then: one instance.

**Housekeeping.** Guild chat is not pruned (decision, docs/SOCIAL.md "Guild chat": ≈ 0.6 MB a day for a busy guild; a pruning job outside the readable window, sparing notices and reported lines, is the follow-up when the table grows). `pnpm admin:role` and `pnpm admin:project` now work on the playtest database, so a playtester can make themselves admin or moderator and finish the town's projects (docs/PLAYTEST.md "What to try", 12–16). The two community-project achievements still use the placeholder seal (art follow-up below). TELEMETRY.md lost four duplicated table rows.

**What went well.** Safety before reach worked: 4.1's text module, reports, sanctions and the social write class were used by every later ticket, so the review found gaps *between* features (a guild report after a handover, a block next to a guild invite) rather than a missing safeguard. Permissions as data made the review cheap: every matrix test re-ran unchanged. The shared journey made a five-player, two-week exit run an ordinary 25-second test, and a guard on every response turned "emails and ids never leak" from a review item into a check of the whole run. Exact shared counters held: contributions, guild boss totals and rewards reconciled with the audit log and the telemetry in every run and race.

**What to do differently in Phase 5.**
- Review the seams between features: who is "the subject" when ownership moves (guild leadership, later trades and leaderboard entries), and what a block does to everything already waiting between two players (offers, invites, later trade offers).
- Put a run-wide guard in every exit run (no other player's email or id in any response) and keep it; Phase 5's leaderboards are public views of everyone.
- Treat any `integer` from a query string as untrusted until it is finite; the root guard does it now, keep new parameters behind it.
- Leaderboards and trading need their own, tighter limits and must not trust the in-process limiters across instances: decide the shared store before a second API instance.
- Text filters need a confusable skeleton for names before anything ranks players by name in public.

**Open follow-ups.**
- **Trading T.1–T.7** per `docs/TRADING.md` (owner places it; login throttling per account and email verification first).
- **B.3's owner questions** (level cap and crypt tier III decided, trading placed at the end of Phase 5: see the Phase 4 follow-ups' owner decisions; trade limits stay for the trading tickets): a level cap versus content above 28 (heroes level past the top content; the XP penalty is a soft cap around 35, `docs/COMBAT.md`); crypt tier III as the Legendary tier (decided in B.3 to keep; revisit with playtest data); trade limits versus the income spread (`docs/TRADING.md`, `docs/ECONOMY.md`).
- **Ashen Pass contracts** (above): turn them on or remove the templates (owner, balance). Turned on in F.1.
- ~~**Art:** icons for `warehouseRestorer` "Mender of Graumark" and `ashenPassBreaker` "Through the Ash"~~ (done in A.9).
- **Look-alike names** (a confusable skeleton) and a **reserved-names store** for forced renames (accepted risks above).
- **Guild chat pruning** when the table grows; **shared limiters** before a second API instance.
- **Playtest feedback:** `docs/PLAYTEST_FEEDBACK.md` is still the empty template; B.1–B.3 were tuned from simulations and telemetry only.

## Phase 4 follow-ups
Small tickets from the Phase 4 retrospective, before Phase 5.

**Owner decisions (2026-11-07, recorded in F.1; also GDD §17):**
- **(a) Levels above 28:** more content later, not a hard level cap (the XP penalty stays the soft cap around 35, `docs/COMBAT.md`).
- **(b) Trading** (`docs/TRADING.md`, T.1–T.7) is built at the end of the next phase (Phase 5).
- **(c) Crypt tier III** stays "the Legendary tier" (Legendary/set kits win at 21; epic kits find it a wall) and is not made harder. A harder crypt mode (a tier IV or heroic crypt, tuned for upgraded Legendary kits) comes later as part of the content above level 28 (`docs/DUNGEONS.md`). No number changes.

### F.1 Ashen Pass contracts — `done (PR #78)`
GDD: §6.4, §11.1. Owner decision: switch the Pass's contracts on, but only when the hero can enter the Pass.
- The contract board, the accept path and the turn-in get the world flags (`app.worldState.flags()`); a contract's area must pass the map's unlock rule (`UnlockRule.worldFlag` plus level and Gravewarden): before both hold, Pass contracts are neither offered nor acceptable, and one held while the flag closes again cannot be turned in (`422 contract_area_locked`).
- Offers stay deterministic; heroes who cannot reach the Pass keep exactly the offers they had (docs/QUESTS.md "Ashen Pass contracts"). No migration.
- Tests: closed flag, under-level, open (offered, taken, finished, turned in), invariance; the API journey's Ashen Pass step takes and finishes one Pass contract.

### F.2 Flake hunt — `done (PR #79)`
Tests that passed on their PR kept failing later on `main` and blocked the auto-deploy. Every suite was run many times with fresh random seeds and shuffled file order (game-core, web, server ×20; `test:pg` ×40; API e2e/journeys ×40; each browser run ×3), and each flaky test was fixed so it holds for every seed and order (no skips, no weakened checks).
- **Ashen Pass journey** (`e2e/journey.ts`): a quest turn-in's XP could level the hero, but the journey kept its old level, so the Pass step expected the Warden's Watch still locked at 26. The helper now takes the level from the turn-in, and the step re-reads it before the Watch.
- **Phase 3 browser run** (`tools/e2e/phase3-exit.mjs`): the UI lock clicked the pack grid at an index from the API's oldest-first list, taken before the tidy-up sold junk, while the grid shows the newest first; a late valuable drop in a full pack pointed past the grid (timeout), otherwise it locked some other item. It now finds the item by id in the grid's order and checks that exactly that item was locked.
- **Guild boss attempt test** (`guild-boss/guild-boss.test.ts`): asserted that attempt 2's fight log differs from attempt 1's; for this hero about 1 secret in 30 gives the same log (failed on this PR's CI). Both logs are now checked against game-core with the stored stream and per-attempt seeds.
- **Phase 1 exit criteria** (`e2e/exit-criteria.test.ts`): about 1 run in 17,000 drops nothing a warrior can wear in the first half hour; the activity seed is now searched with game-core's rules.
- **Guild boss journey step**: three attempts normally stay below stage 1; when a strong farm breaks it, the step now expects the stage's reward to be claimed instead of `nothing_to_claim`.
- **Real-Postgres timing** (`concurrency.pg.test.ts`): sell/salvage vs lock keeps going (with a growing head start) until both orders were seen; the parallel-transactions check got a wider margin.
- Prevention: "Writing tests that don't flake" in `CLAUDE.md`; a nightly/manual **Flake hunt** workflow (`.github/workflows/flake-hunt.yml`) repeats the server suite and `test:pg` with shuffled order, off the per-PR path. No production code or gameplay numbers changed.

### F.3 Patch notes & version numbers — `done (PR #85)`
Owner request: patch notes and version numbers in-game for every new thing.
- One game version, `0.<phase>.<patch>`, in game-core's typed patch notes (`releases/notes.ts`, `GAME_VERSION`); the server returns it in `GET /api/health` (`version`), the web shows it quietly in the status bar ("v0.5.2") linking to the notes.
- Backfilled history from this file: 0.1.0 (Phases 0–1), 0.2.0, 0.3.0, 0.4.0 (Phase 4 with the launch: invites and legal pages), 0.5.0 (F.1), 0.5.1 (5.1), 0.5.2 (5.2, plus the scoped-ledger-styles fix). Dates are the merge dates.
- "What's new" (`#/notes`): the town crier's proclamations, newest first, grouped New / Changed / Fixed; releases new to the reader are marked and open, older ones fold. Unread marker: a "New" tag on the version and a "New in v…" herald slip (the least important notice; never while the first-steps guide runs; a brand-new player starts at the current version). Last seen version per account in localStorage, so no migration.
- Process: the patch notes rule and its collision rule in `CLAUDE.md`, `docs/DEVELOPMENT.md` "Versions and patch notes"; game-core tests enforce valid, unique, increasing versions, ordered dates, the current version, non-empty releases and player language.
- Tests: game-core ordering, `/api/health` version, route, unread logic, the screen's markup; screenshots `docs/screenshots/phase-5/notes-*`. No gameplay changes.

### F.4 New-version reload hint — `done (PR #86)`
Owner request: a tab kept open through a deploy notices that a newer version is live and offers a reload.
- One shared, light poll of `GET /api/health` (`shell/healthPoll.ts`): every 5 minutes while the tab is visible and once when it comes back after at least a minute; the status line ("Server online") and the version check read it, so there is no extra request. Before, the health line checked only once per page.
- game-core `isNewerVersion`: strictly newer only; equal, older, missing or malformed versions never prompt.
- A quiet herald slip ("Graumark has changed: v… is out. Reload to join it.") with Reload and Later; Later is kept per version in localStorage (no migration), the next version asks again. It never fades, takes no focus and never reloads by itself, ranks below every other notice in `orderNotices` and waits for the first-steps guide like "New in v…". After the reload, F.3's "New in v…" takes over.
- Failed loads after a deploy: Vite's `vite:preloadError` or an unhandled chunk-load rejection brings the slip back (whatever Later said); a screen that throws while rendering shows an in-world reload panel (`ReloadBoundary`, keyed by route inside the shell, plus one around the whole app) instead of a blank page. The web still ships as one bundle, so today this guards future lazy screens and late assets.
- Tests: the comparison, the offer (newer only, Later per version, guide), the poll with an injected clock, timers and fetch, the chunk-error watcher and the boundary's panel; screenshots `docs/screenshots/phase-5/reload-hint-*` (`node tools/screenshots/reload.mjs`, local server only). No server or gameplay changes.

### F.5 Phase 3 browser run: pack-capacity flake — `done (PR #114)`
`tools/e2e/phase3-exit.mjs` (CI job `e2e-phase3`) failed on PR #112 with `pack not over capacity: 8` (CLAUDE.md "Capacity"). The iteration that turned the loot filter off also judged the pack against the visit made *before* the switch: that visit still tidied, so it reported the pack after selling junk, while its settle could still report items that arrived over capacity. Whether it did depended on the drops (an unpinned seed).
- The switch iteration now ends with `continue`, so the over-capacity check only runs on visits made with tidy and the filter off, and `pack not over capacity` throws again. This replaces the interim fix in #113, which dropped that throw and skipped every over-capacity report with a pack at or below capacity, so a wrong report on a later visit would only have run the budget out. Test tooling only; no game, server or web changes.

### F.6 Flake fixes & date time-bomb sweep — `done (PR #117)`
Follow-up to F.2. `main` CI broke when the wall clock passed a hard-coded sanction expiry in the duel tests (`2026-11-10`, fixed in PR #116), and the nightly Flake hunt failed once on a crypt-entry race. Scope: sweep the tests and e2e scripts for hard-coded dates the wall clock will overtake, add a guard so it can't recur, fix the Flake hunt failure, and chase a reported one-off in the binding backfill. No production code or gameplay changes.
- **Guard:** `tools/vitest/clock-shift.mjs`, a Vitest setup file in all three packages: with `WF_CLOCK_SHIFT_DAYS=<n>`, `Date.now()`, `new Date()` and PGlite's `now()` (which reads the JS clock) run `n` days ahead; without it, nothing changes. CI's "clock +400 days" job runs game-core, web and the date-sensitive server folders shifted; the nightly Flake hunt runs the whole server suite shifted. It catches PR #116's bomb (verified by reverting the fix). Real PostgreSQL keeps its own clock; `test:pg` was checked once with a `libfaketime`-shifted server (+400 days, all pass).
- **Sweep:** whole server suite at +400 and +3650 days, web and game-core at +400. Only time bomb left: `playtest/stored-time.test.ts` (fixed dates 2030–2034 had to beat item `created_at`, which the DB stamps with `now()`; it would have broken on 2030-01-01). Its dates are now offsets from a midnight four years past today. The other fixed dates either feed an injected clock with every compared column set, or are far-future clocks whose DB-stamped columns stay below them (they hold at +10 years).
- **Flake hunt failure** (`concurrency.pg.test.ts`, crypt entry racing settles, a sell, a buy, a craft and a turn-in): the buy and the craft were refused with `422 inventory_full`. An hour of Blackwater farming leaves 21–60 of 60 slots filled (measured over 2,000 heroes), so about 1 run in 1,000 ends with a full pack, and then both item-adding requests are correctly refused. Not a server bug. The test now asserts what holds in every outcome: the sell and the turn-in always succeed; a refused buy or craft must be `inventory_full` with the pack at capacity (at most one below, after the sell); everything still reconciles with the audit log. Reproduced with a pre-filled pack.
- **Ashen Pass journey** (found by this PR's own Flake hunt run): the API journey's town visit (`e2e/journey.ts`) buys and crafts before it sells junk, so a pack the last settlement filled refused the craft (`422 inventory_full`, after `GET /forge` showed no blockers). A buy or craft refused that way now checks that the pack really is at the capacity it names and tries again on a later visit; Phase 2's exit check still requires all four town actions.
- **Binding backfill** (`inventory/binding-backfill.test.ts`): the out-of-memory one-off did not reproduce (30× alone before and after the fix, 2 shuffled full-suite runs). It had one ordering assumption: the resume test compared two heroes' rows by position after sorting by UUIDv7 id, and ids minted in the same millisecond sort randomly. Rows are now paired by the ids the test created.

### F.7 Cinderwastes merchant flake — `done (PR #138)`
Report: `world/cinderwastes.test.ts` failed once locally on `merchantAreas(p).has('ashfallVerge')`, then passed on reruns. Scope: reproduce, find the cause, fix it per `CLAUDE.md` "Writing tests that don't flake", sweep the other 6.x tests that read the merchant stock.
- **Cause: a real bug, not only a test assumption.** The merchant rolls an offer's item level within the area's enemy levels (Verge 28–34), but the Verge's loot table holds only tier-4 bases from item level 29. A roll of 28 found no base, and the offer was dropped silently (`areaStock`). Measured with game-core over 20,000 heroes per class: about 26 % of hero-days showed one Verge offer, and about 2 % none at all (both rolls 28, 1 in 49), which made the test fail. Every other area always stocked its 2 offers. game-core's own "full stock" test passed only because its character and day are fixed. The day boundary was ruled out: the merchant reads the injected activity clock, which the test holds on 2026-11-09, and `WF_CLOCK_SHIFT_DAYS` doesn't move it.
- **Fix (game-core):** an offer whose rolled level has no usable base is stocked at the lowest level one allows, if that is within the area (the Verge: 29). Its base comes from a stream of its own, so every offer that existed before keeps exactly its item, and a stock loaded before the deploy buys the same items after it. Checked against `main` over 2,000 heroes × 4 classes × 8 areas: all 125,752 existing offers are bit-identical, and the 2,248 new ones are all Verge offers at item level 29. Patch note 0.6.18.
- **Tests:** game-core asserts a full stock for every area, class and 300 fixed heroes and days (failed before the fix). `cinderwastes.test.ts` checks the Verge's full count instead of "has a Verge offer", and adds a hero pinned to an id that game-core's old rules gave no Verge offer on the test's day. It gets two offers at 29, and buying one gives exactly that item. This test failed before the fix. `insertCharacter` takes an optional `id`.
- **Sweep:** no other 6.x test reads the stock by area. The Cinder Depths, Heroic crypt and Forge Tyrant tests only sell to the merchant, and the Depths (level 34 vs bases from 34) never comes up short. The Ashen Pass test checks the Pass's offers, which are never short either. The API journey buys the cheapest offer of any area and only if there is one. No migration.

## Phase 5 — Leaderboards, competitive systems & trading
**Status: complete** (ticket 5.8; see the Phase 5 retrospective below).

GDD §15 Phase 5, §10.2, §10.3, §16.3, §16.4; trading per `docs/TRADING.md` (owner decision: built at the end of this phase). **Exit:** leaderboard values are reproducible and server-authoritative; PvP matches are understandable, reasonably fair, and do not damage core PvE progression; trading (if switched on) creates and destroys no value, and every trade is auditable and reversible within its window.

Not in this phase (owner decisions, Phase 4 follow-ups): content above level 28 and a harder crypt mode (tier IV/heroic) belong to Phase 6 (endgame expansion).

**Ground rules for Phase 5** (all Phase 1–4 rules still apply, including `CLAUDE.md` "Writing tests that don't flake")
- **Scores are recomputed, never submitted.** Every leaderboard value comes from a versioned game-core formula over server state; a stored snapshot carries its formula version and inputs, so any value can be recomputed and must match. Items are validated (`validateItem`) before they count; sanctioned accounts don't appear.
- **Published formulas.** Each metric is explained to players in plain words (a "how is this measured" view and `docs/LEADERBOARDS.md`). Character Power and Gear Score stay distinct (GDD §10.2).
- **Rewards are prestige only.** Titles, profile frames and cosmetics; never stats, drop rates or gold that would leave non-competitive players behind (GDD §13.3).
- **PvP is optional and harmless.** A loss never removes items, gold or progress. PvP balance lives in its own normalisation layer, so PvP tuning never changes a PvE number (the no-effects hashes and balance suites stay untouched).
- **Snapshots, not live heroes.** Leaderboards and duels use server-side snapshots taken at defined moments; a defender's gear changing mid-fight changes nothing, and replays use the stored snapshot (like crypt runs).
- **Privacy (owner decision):** everyone on a leaderboard is shown by name, with no opt-out and no anonymous entries. A hidden profile still can't be opened from a board, and blocked players can't interact. Blocks keep players apart in matchmaking and friendly challenges (`docs/SOCIAL.md`).
- **Abuse first.** Win-trading, multi-accounts and score farming are designed against in the ticket that adds the feature, with tests, not left to hardening.

**Defaults the owner can override** (recorded in the GDD when the ticket lands):
- **Seasons:** 8 weeks, plus all-time boards; season boards are archived, never reset away.
- **Boards:** Character Level, Character Power, Gear Score and PvE Progress; filters for season/all-time, class and level bracket. **Owner decision (2026-11-07): every player is listed by display name, with no opt-out.** Profile privacy only governs whether the name links to the profile. The privacy policy must mention the public leaderboards; the owner updates it on the VPS.
- **PvP:** asynchronous 1v1 duels against a saved defence snapshot; matches only within a level bracket, with stats normalised toward the bracket (so gear matters, but not overwhelmingly); 10 rated duels a day; friendly challenges with friends and guildmates (no rating, no rewards).
- **Rating:** a Glicko-2-style rating per season, separate from Power and Gear Score.
- **Account security before trading:** per-account login throttling, email verification and password reset (open since Phase 1). Email needs a sending provider: the owner chooses one (e.g. an SMTP service) and provides its credentials on the VPS.

**Order** (one or two sessions at a time): 5.1 → 5.2 → 5.3 and A.10 (parallel) → 5.4 → 5.5 → 5.6 → B.4 → 5.7 → T.1 → T.2 → T.3 → T.4 → T.5 → T.6 → T.7 → 5.8.

### 5.1 Scoring model & published formulas (game-core + docs) — `done (PR #82)`
GDD: §10.2, §16.3. Read `docs/COMBAT.md`, `docs/LOOT.md`, `docs/EFFECTS.md`, the balance and build suites.
- Versioned, data-driven formulas in game-core: **Character Level** (level, then XP within the level as tie-breaker), **Gear Score** (equipped items only: item level, rarity, upgrade level, Void; documented weights), **Character Power** (a broader snapshot: a deterministic combat evaluation against fixed reference opponents, so builds count, not just numbers) and **PvE Progress** (an ordered list of milestones: areas, crypt tiers, the Warden's Watch, guild boss stages).
- A score breakdown ("what counts and why") that the UI can show; `docs/LEADERBOARDS.md` publishes each formula in plain words.
- Tests: determinism, monotonicity where it should hold (a better item never lowers Gear Score), stat-inflation resistance (forged or invalid items rejected), Power ranks the B.2 best builds sensibly, and fast.
**Acceptance:** formulas documented; breakdown screenshots on the character screen.

### 5.2 Leaderboards (vertical) — `done (PR #84)`
GDD: §10.2. Needs 5.1.
- Snapshot table (score, formula version, inputs hash, achieved-at) updated on the events that can change a score (debounced, inside the value transactions or right after them; window rule), plus a recompute check (CLI and a test) that every stored value matches its formula.
- Board pages: the four metrics, filters (all-time now; seasons in 5.3; class; level bracket), your own rank, tie-breakers by achieved-at, pagination, ETag polling sized to the rate limits. Everyone is listed by name (owner decision); the name links to the profile only where profile privacy allows; sanctioned accounts excluded; report action from a board entry.
- Tests: recompute equality, the profile-link privacy matrix (each profile setting × viewer relation), races (a score change racing a read), invariance (boards change no gameplay number), journey step, screenshots.

### 5.3 Seasons & prestige rewards (vertical) — `done (PR #88)`
GDD: §10.2, §13. Needs 5.2.
- Season model (start/end in UTC, archive, admin panel controls and an owner CLI), season boards next to all-time ones.
- Prestige rewards: titles and profile frames shown on profiles, boards and in guilds; awarded exactly once at season end (real-PG races, a restart mid-award), cosmetic only.
- Tests: the season boundary (window rule), award idempotency, archive integrity; screenshots.
- Done: 8-week UTC seasons; a season board lists heroes whose score rose in the season, ranked by their score at its end (season rows written in the refresh transaction by the request clock); the archive is sealed under a season lock 5 minutes after the end; awards are exactly-once on `(season, account, metric)` and resumable. Tiers: Champion (1st), Exalted (top 10), Renowned (top 100), Veteran (on the board, hero level ≥ 10); one title per board. Admin panel Seasons tab, `pnpm admin:seasons` / `deploy/admin.sh seasons`. The first season is scheduled by the owner; later ones follow back to back. Migration `0026_seasons`; version 0.5.4. `docs/LEADERBOARDS.md` "Seasons and prestige".

### A.10 Profile frames, title badges & arena art — `done (PR #87)`
GDD: §3.1, §13.1. Needs 5.3's reward ids (and 5.5's arena screen for the arena art).
- A set of profile frames by tier, small title badges, and an arena backdrop for the duel screen, matching the existing style.
- Budget: one or two 32px jobs plus one backdrop job; at most one regeneration. Manifest and `assets.ts` updated.
**Acceptance:** a contact sheet in the PR.

### 5.4 PvP combat model & normalisation (game-core) — `done (PR #89)`
GDD: §10.3 (guardrails). Needs 5.1.
- A deterministic hero-vs-hero duel simulation on the existing combat engine (both sides' effects, sets and skills), seeded from server-only secrets, with a readable combat log.
- A **PvP normalisation layer** (level brackets; stats pulled toward the bracket by a documented factor) that never changes PvE numbers.
- Balance tests: class matchups within bands per bracket (no class far above even in a mirror bracket), gear still matters but a fresh hero isn't hopeless inside its bracket; fast.
- Done: `simulateDuel` on the PvE engine (both sides' affixes, effects, sets, Void, upgrades and class skills; boss damage, boss slayer, kill effects and find bonuses do nothing), seeded by the caller's server secret, 60 s limit with sudden death from 30 s and a health-share tie-break (exact tie = draw), crypt-style log. Brackets = 5.2's `LEVEL_BRACKETS` with reference levels 5/15/25/30; level does not count inside a bracket, gear keeps 25 % of its difference to a rare reference kit (effects too); armour and resistance blended; a ±25 % luck roll per blow (owner decision); per-bracket class damage factors. `PVP_RULES_VERSION` 1. Friendly challenges may cross brackets and use the lower hero's bracket (`friendlyBracket`). Bands: class pairs 40–60 % (measured 41–60 %), each gear step > 52 % and ≤ 98 %, fresh hero ≥ 8 % per class and ≥ 15 % on average from 10 up (measured 16–59 %); 1–9 is an open exception (best 4–13 %, 8 % average). No PvE number changed; no patch notes (nothing visible yet). `docs/PVP.md`.

### 5.5 Async duels & friendly challenges (vertical) — `done (PR #91)`
GDD: §10.3. Needs 5.4.
- Set a defence loadout (a snapshot of a hero); challenge a defender in your bracket (opponent list from the server, never client-chosen ids outside it); instant resolution; result and combat log screens; daily rated-duel limit; friendly challenges with friends and guildmates (no rating, no rewards); a loss changes nothing you own.
- **Owner decisions (2026-11-08, ticket 5.4):** rated duels open at level 10 (the 1–9 bracket has no rated duels); friendly challenges may cross brackets and are fought in the lower hero's bracket (`friendlyBracket`); luck roll ±25 % per blow, gear keeps 25 %.
- Abuse: Idempotency-Key, no re-roll by retry or replay, blocked players never matched, rate limits, audit and telemetry.
- Tests: permission matrix, races (two challengers vs one defender, a defender changing gear mid-challenge), invariance, journey step with two players, screenshots.
- Done: a defence is a checked snapshot per hero (5.1's item rules; invalid items count 0), set and refreshed at any level. Rated duels from level 10, 10 per account per UTC game day, only against a server-offered list (≤ 5 defences in the bracket, one per account, never own, blocked or sanctioned; fresh list after 5 min or when used up). Friendly challenges with friends and guildmates resolve at once against the friend's saved defence (decision: no send/accept), any level, lower hero's bracket. Every duel stores its `crypto` seed, rules version and both snapshots (replay tested); `Idempotency-Key` (no re-roll); social write `duel` (mute-exempt); audit `duel.fight`/`duel.defence`, telemetry `duel.fight`. Nothing a player owns changes (invariance test). Arena screen `#/arena` with the A.10 backdrop; Duel links from friends and the guild roster. Migration `0027_duels`; version 0.5.5. `docs/PVP.md` "The arena".

### 5.6 Arena rating & matchmaking (vertical) — `done (PR #92)`
GDD: §10.3. Needs 5.5.
- A seasonal rating (Glicko-2-style), rated ladder board, matchmaking by rating within the level bracket and a power range; modest prestige rewards via 5.3.
- Anti win-trading: diminishing returns against the same opponent, friends/guildmates and accounts sharing signals excluded from rated matches, a pattern report for moderators.
- Tests: rating maths, matchmaking fairness bands, win-trading rules, season reset into the archive.
- Done: Glicko-2 per hero and season (1500 / 350 / 0.06, τ 0.5; each rated duel its own period, idle days widen the deviation; both sides move, defence losses in full; provisional until 10 rated duels; outside a season a rated duel moves no rating), updated in the duel transaction under season → pair → hero rating locks. Soft season reset (halfway to 1500, deviation ≥ 250); the archive copies established ratings as metric `arena`, honoured by 5.3 (title Duellist, existing badge). Matchmaking by bracket Power (5.1 Power at the reference level) within 5 %, widening to 10/20 % only when needed, then rating; measured: 95 %+ favourites 1–2 % of offered pairs (random: 51–59 %), pairs ≥ 3 gear tiers apart 0–2 % (19–28 %). Repeat pairs 1, ½, ¼, 0 within 7 days; friends, guildmates and a shared mailbox never rated (`409 friendly_only`); moderator pattern report. Arena Ladder `#/boards/arena`. Migration `0028_arena_rating`; version 0.5.6. `docs/PVP.md` "Rating, matchmaking and the ladder".

### B.4 Balance pass: competitive systems — `done (PR #93)`
GDD: §10.2, §10.3, §16.4. Needs 5.1–5.6.
- Leaderboard distributions with the realistic player (telemetry), PvP class matchups and bracket fairness, prestige reward pacing; no PvE number changes unless separately justified.
- Address the owner's playtest feedback if it has arrived.
- Done: a realistic season population (`telemetry:simulate --days 56 --snapshots`, three runs, 84 heroes; towns of 20/100/500 with veterans, new players and three activity levels; `tools/balance/competitive.ts`). **Boards:** Level tops out at 60 (first there wins), Power at 3,669 of 4,000 with a distinct top, PvE Progress at 10/10 for 96 % within two weeks (Phase 6 should add milestones); Gear Score hit its ceiling by week 4 and the top was decided by who got there first: **Gear Score version 2** orders equal scores by the items' magic quality (values unchanged; ties between different kits 29 % → 0 %), recomputed by the 5.2 sweep, with a fix so a longer key is never read as a rise on a season board. **Prestige:** Exalted and Renowned now scale with the board (2 % ≥ 3 ≤ 10, 10 % ≥ 5 ≤ 100; on a board of 20 every hero used to be Exalted or Renowned, now 4 of 20). **Arena:** on realistic heroes, Power-matched pairs left the warrior at 38–41 % and the warlock at 60–62 % (mage over warrior 79 %); **matchmaking 2** compares Power relative to the class (fitted, warrior ÷ 1.035, warlock ÷ 0.967) and offers players not met this week first: every class 45–55 %, worst 30+ pair 64 %, rated duels counting in full 30 % → 89 % in a busy arena; no duel rule changed (`PVP_RULES_VERSION` 1). The 30+ hunter–warlock pair is 44–57 % on realistic heroes; the provisional period and the soft reset hold; empty lists in thin brackets come from near-empty brackets and the repeat-pair rule, not the 20 % cap (kept). No PvE number and no migration. Guards: `balance/competitive-balance.test.ts` with a realistic defence fixture. Version 0.5.7. `docs/LEADERBOARDS.md` and `docs/PVP.md` "Balance pass: competitive systems". Playtest feedback had not arrived.
- **B.4b Repeat pairs never block (owner decision on B.4's question 1)** — `done (PR #94)`: the repeat-pair factor stays at ¼ from the fourth duel within 7 days (never 0), repeat pairs stay on the opponent lists (fresh pairs first; matchmaking 3 counts only fresh accounts toward widening the range), the pattern report still flags heavy pairs. Empty lists over a season: 20 players 62 % → 3 %, 100 players 4 % → 1 %, 500 players 1 % → 0 %; full-value duels 88 % at 500, 19 % at 100 (was 22 %), and in a 20-player town nearly every duel is a ¼ repeat. Owner kept B.4's other defaults (Exalted ≈ 2 %, Renowned ≈ 10 %, PvE Progress until Phase 6, Gear Score 2). Version 0.5.8. `docs/PVP.md` "Follow-up: repeat pairs never block".

### 5.7 Account security: login throttling, email verification & password reset (vertical) — `done (PR #95)`
GDD: §16.3. Carry-overs since 1.2; required before trading (`docs/TRADING.md`).
- Per-account login throttling (on top of per-IP), email sending through a provider the owner chooses (configuration on the VPS, never in git), email verification (unverified accounts can play but not trade), password reset with single-use, short-lived tokens, "log out other devices", pruning of expired sessions.
- Tests: token single-use and expiry races, enumeration resistance (same answers for known and unknown emails), throttling; screenshots.
- Done: **mail** is provider-agnostic SMTP (nodemailer; `SMTP_HOST`/`PORT`/`SECURE`/`USER`/`PASS`, `MAIL_FROM`, `PUBLIC_BASE_URL`, only in `deploy/.env`); without `SMTP_HOST` production starts with mail off (`503 email_unavailable` on reset and resend, login unaffected), development logs letters, tests and the e2e server capture them (`E2E_MAIL_DIR`). Letters go out after the request, never awaited; outcomes in telemetry `mail.send`. **Throttling** per normalised email (known or not): 5 free failures, then 30 s doubling to 15 min, reset after an hour or on success/reset; `429 rate_limited`, `details.limit: 'account'`; audit `auth.login_locked`, telemetry `auth.login`. **Tokens** (`account_tokens`, migration `0029_account_security`): SHA-256 at rest, single use by conditional update under the account row lock, verify 24 h / reset 30 min, newest wins, tied to the address. **Verification** on registration and email change; unverified accounts play normally (a dismissible strip and the account screen's security panel with a rate-limited resend, 3 letters an hour); existing accounts start unverified with no backfill; `isEmailVerified(accountId)` for T.4. **Reset**: the same `202` for every address, padded to 400 ms, 3 letters an hour per address; a new password revokes every session, withdraws every token, marks the address verified and mails a notice; a login racing it re-reads the hash under a share lock, so no old-password session survives. **Email change** with the current password (old address told), **"log out other devices"**, hourly pruning of expired/revoked sessions and expired tokens. Version 0.5.9. Tests: `auth/account-security.test.ts`, `login-throttle.test.ts`, real-PG races `account-security.pg.test.ts`, journey `e2e/account-security-journey.test.ts`; screenshots `docs/screenshots/phase-5/{verify-strip,account-security-*,forgot-*,reset-*,verify-*,login-locked}-*` (`tools/screenshots/account-security.mjs`). Docs: SECURITY.md "Accounts", DEPLOY.md "Email", API_CONVENTIONS.md, DATA_MODEL.md, TELEMETRY.md.

- **Owner decision (2026-11-08):** registration keeps instant login and reveals a taken address (`409 email_taken`); hiding it would force a confirm-first sign-up. Invite-only registration makes this an accepted risk; the planned follow-up 5.7b was dropped.
### T.1–T.7 Trading — `done` (T.1–T.7 done)
Per `docs/TRADING.md` ("Ticket outline" and "Test strategy"), in order: T.1 item binding & provenance → T.2 trading settings (admin) → T.3 shared account shelf → T.4 trade rules, eligibility & sanctions → T.5 trade offers → T.6 moderation, reversal & pattern report → T.7 trading hardening, exploit review & balance. The master switch starts off (T.2); the owner turns trading on from the admin panel when ready. Each ticket gets its own heading here when it starts.

### T.1 Item binding & provenance (vertical) — `done (PR #97)`
GDD: §10.1, §16.3. `docs/TRADING.md` "1. Item binding", "Full audit" (provenance), the T.1 row. Needs 5.7.
- game-core `itemBinding(item, settings)` as a data table; item columns for the binding, the bound account, `traded_count`, `hold_until`, first-equipped; equip and Forge work bind; tooltips show it; provenance by id from every tradeable source; backfill of existing rows. No trading, no shelf, no switches UI.
- Tests: the full rarity × variant × source × state table, equip/Forge transitions and their race, provenance per source, backfill idempotency and resumption (real PG), invariance, a journey step, tooltip screenshots.
- Done: game-core `trading/binding.ts` (state independent of the switches, all off); migration `0030_item_binding`; every source writes the binding, first equip and every Forge action bind in their transactions; boss-hoard drops stored as `hoard:<dungeon>`; `dungeon.claim` lists Epic+ by id; the item-binding backfill runs in the server after start-up (skip locked, unbound rows only, `data_backfills` `item-binding:t1`), recovers crypt provenance from stored runs (`item.provenance`) and marks the rest `unprovenanced`; tooltip binding line; version 0.5.10. Tests `inventory/binding*.test.ts`, real PG `inventory/binding.pg.test.ts`, journey `e2e/binding-journey.test.ts`; screenshots `docs/screenshots/phase-5/tooltip-binding-*`. Docs: TRADING.md "T.1 as built", LOOT.md, DATA_MODEL.md, DEPLOY.md.

### T.2 Trading settings (admin) — `done (PR #98)`
GDD: §10.1, §16.3. `docs/TRADING.md` "Admin switches", "Per-account limits", the T.2 row. Needs T.1.
- Owner decision (2026-11-08): the defaults are the "Admin switches" table (master, Trade and Shelf off; Tradeable Epic, Legendary and set on; Mythic and Void off), so nothing is tradeable at launch.
- Done: game-core `trading/settings.ts` (typed settings, defaults, hard maxima, validator refuses / reader clamps, panel words, launch order, `switchedOff`); migration `0031_game_settings`; `app.gameSettings` cache (60 s, invalidated on save); `GET /api/mod/settings/trading` (staff, moderators read-only) and `PUT /api/admin/settings/trading` (admins, `Idempotency-Key`, `expectedVersion` → `409 settings_conflict`), `settings.update` audit and history; item views read the stored switches; `onSettingsChanged` seam (in the edit's transaction) for T.5; the admin panel's Trading tab and the moderators' read-only board. No player-visible change, no patch note. Tests `game-core trading/settings.test.ts`, `settings/settings.test.ts`, real PG `settings/settings.pg.test.ts`; screenshots `docs/screenshots/phase-5/admin-trading-*`. Docs: TRADING.md "T.2 as built", DEPLOY.md, DATA_MODEL.md, API_CONVENTIONS.md, LOOT.md.

### T.3 Shared account shelf (vertical) — `done (PR #99)`
GDD: §10.1, §16.3. `docs/TRADING.md` "3. The shared account shelf", "Admin switches" (Shelf: items, materials, gold), the T.3 row. Needs T.1, T.2.
- A second Warehouse tab: items (shelf marker and account id on the row, like 4.7), materials and gold on the account; deposit from one hero, withdraw to any hero of the account; each kind behind its "Shelf: …" switch; withdrawals always allowed; held value can't be shelved; audit, telemetry and reconciliation. No eligibility, offers or caps (T.4/T.5).
- Done: game-core `trading/shelf.ts` (`planShelfDeposit` / `planShelfWithdraw`, 20 item places in `DEFAULT_SHELF_CONFIG`, materials and gold unlimited); migration `0032_account_shelf` (`item_instances.on_shelf` + `shelf_account_id`, `accounts.shelf_gold`, `account_shelf_materials`); `GET /api/characters/:id/shelf`, `POST …/shelf/deposit|withdraw` (`Idempotency-Key`, shelf advisory lock → hero → items → shelf rows, switches read in the transaction, `409 shelf_paused` / `item_on_shelf` / `item_held`, `422 shelf_full`); shelf items out of reach of sell, salvage, discard, lock, equip, the Forge and the warehouse; held gold and materials through the `heldValueOf` seam for T.5; audit `shelf.deposit` / `shelf.withdraw` per kind, telemetry `shelf.move`, `reconcileWithAudit` count and conservation checks, `expectShelfMatchesAudit`; the Warehouse's *Account shelf* tab; version 0.5.11. Tests game-core `trading/shelf.test.ts`, `shelf/shelf.test.ts`, real PG `shelf/shelf.pg.test.ts`, journey `e2e/shelf-journey.test.ts`; screenshots `docs/screenshots/phase-5/shelf-*` (`tools/screenshots/shelf.mjs`). Docs: TRADING.md "T.3 as built", WAREHOUSE.md "Account shelf", DATA_MODEL.md, TELEMETRY.md, API_CONVENTIONS.md.

### T.4 Trade rules, eligibility & sanctions — `done (PR #100)`
GDD: §10.1, §16.3. `docs/TRADING.md` "4. Anti-abuse rules" (eligibility, per-account limits, what blocks and sanctions do), the T.4 row, "Test strategy". Needs 5.7 (`isEmailVerified`), T.1, T.2, T.3.
- The game-core permission matrix (switches × relation and its age × both accounts' standing × action, with the offer's contents), caps and limits from the settings with the existing week and day boundaries, the `trade` rate-limit class, the trade-restriction sanction in the 4.1 queue, an eligibility endpoint that leaks nothing beyond the relation, and the account screen's Trading panel. No offers, escrow or holds (T.5).
- Done: game-core `trading/rules.ts` (`tradeDecision`, `TRADE_ACTION_CHECKS`, `TRADE_SANCTION_CHECK`, `TRADE_ELIGIBILITY`, plain words) and `trading/caps.ts` (`TRADE_CAPS`, `tradeWindows`, `tradeCapIncrements`, `checkTradeCaps`, `openOfferRefusal`); sanction kind `trade` / action `restrictTrade`; migration `0033_trade_rules` (`trade_counters`, widened `sanctions_kind_check`); `commitTradeCounters` (check-then-increment under per-account advisory locks, at accept; send checks without reserving); `tradeWrite` and the `trade` class (20 a minute); `app.sanctionEvents.onSanctionIssued` seam for T.5; `GET /api/trading/eligibility[?handle=]`; the Trading panel and the moderators' "Restrict trading"; version 0.5.12. Tests game-core `trading/rules.test.ts`, `trading/caps.test.ts`, server `trading/eligibility.test.ts`, `trading/counters.test.ts`, real PG `trading/counters.pg.test.ts`, journey `e2e/trade-eligibility-journey.test.ts`; screenshots `docs/screenshots/phase-5/trade-eligibility-*`, `moderation-restrict-trade-*` (`tools/screenshots/trade-eligibility.mjs`). Docs: TRADING.md "T.4 as built", SOCIAL.md, DATA_MODEL.md, API_CONVENTIONS.md.

### T.5 Trade offers (vertical) — `done (PR #101)`
GDD: §10.1, §16.3. `docs/TRADING.md` "2. … Format", "Admin switches" (the last column), "Cooldowns", "Full audit", "What blocks and sanctions do", the T.5 row, "Test strategy". Needs T.1–T.4.
- Send, cancel, decline, accept, expire and void, each through `tradeDecision`, `Idempotency-Key` and the `trade` class; escrow for items, gold and materials; the all-or-nothing swap under one lock order; the 72-hour hold on everything received, respected by every spend path; voids from switches, sanctions, blocks and relations that end; audit, telemetry and reconciliation; the Trading screen. No reversal or pattern report (T.6).
- Done: game-core `trading/offers.ts`; migration `0034_trade_offers` (`trade_offers`, `trade_offer_lines`, `trade_holds`, `item_instances.escrow_offer_id`); `apps/server/src/trading/offers.ts` + `offer-routes.ts` (`GET /api/trading/offers` inbox with ETag, `…/history`, `…/:id`, `/api/trading/heroes`, `/api/trading/partners[/:handle]`, `POST /api/trading/offers`, `…/:id/cancel|decline|accept`); lock order accounts → settings → offer counters → offers → heroes → items → caps (the shelf now locks its account row before the hero); `heldValueOf` reads `trade_holds`; `changeGold` / `changeMaterialsTx` refuse spends into held value (merchant, Forge craft and work, guild founding, community contributions, warehouse upgrades, shelf deposits, trade offers); held items refuse sell, salvage, discard, Forge, shelf; voids via `onSettingsChanged`, `onSanctionIssued` and the new `app.relationEvents.onRelationEnded` (unfriend, block, guild leave, kick, disband); release by the inbox and the scheduler's sweep, `trade.release` once; audit `trade.offer|cancel|decline|expire|accept|void|release|flag`; telemetry `trade.complete`, `trade.items`, `item.fate trade traded`, `gold.in/out trade`, `material.in/out trade`, reconciled; the Trading screen `#/trading` and "Held until" on item tooltips; version 0.5.13. Tests `trading/offers.test.ts`, `trading/holds.test.ts`, real PG `trading/offers.pg.test.ts`, journey `e2e/trade-journey.test.ts`; screenshots `docs/screenshots/phase-5/trade-*` (`tools/screenshots/trading.mjs`). Docs: TRADING.md "T.5 as built", DATA_MODEL.md, ECONOMY.md, TELEMETRY.md, API_CONVENTIONS.md, SOCIAL.md.

### T.6 Moderation, reversal & pattern report — `done (PR #102)`
GDD: §10.1, §16.3. `docs/TRADING.md` "Moderator reversal and its limits", "Full audit", "5. The attacks it must defeat", "7. What can't be prevented, only detected", the T.6 row, "Test strategy", "T.1–T.5 as built"; `docs/SOCIAL.md` (queue, reports, sanctions, roles). Needs T.1–T.5.
- Trade history and a moderator case view (per account, per pair, per trade with full lines and the audit trail); reversal all or nothing within 14 days under T.5's lock order with an `Idempotency-Key`, a reason and an optional sanction; report a trade from the Trading screen; the pattern report (panel and command). No exploit review or balance pass (T.7).
- Done: game-core `trading/reversal.ts` (`reversalDecision`, `reversedItemState`, the 14-day window, plain words) and `trading/patterns.ts` (`TRADE_PATTERN_RULES`, flags); moderation action `reverseTrade`; report target `trade` and reason `scam`; migration `0035_trade_moderation` (`trade_offers.reversed_at` / `reversed_by` / `reverse_reason`, three indexes); `apps/server/src/trading/reversal.ts` + `mod-routes.ts` (`GET /api/mod/trades`, `GET /api/mod/trades/:id`, `POST /api/mod/trades/:id/reverse`, `GET /api/mod/trading/patterns`), `patterns.ts`, `trading-cli.ts` (`pnpm admin:trading patterns`, `deploy/admin.sh trading patterns`); a reversal ends the trade's holds (`trade.release` `via: 'reverse'`), puts items back as traded, moves gold and materials back hold-aware, writes `trade.reverse`; telemetry `trade.reverse`, `gold/material.in/out trade_reverse`, reconciled; the players' history shows the reversal and its reason; the docket's trade ledger and trade patterns (also the admin panel's "Trades" tab); "Report this offer/trade" on the Trading screen; version 0.5.14. Tests game-core `trading/reversal.test.ts`, `trading/patterns.test.ts`, server `trading/reversal.test.ts`, `trading/patterns.test.ts`, `social/permission-matrix.test.ts`, real PG `trading/reversal.pg.test.ts`, journey `playTradeModerationStep` (`e2e/trade-journey.test.ts`); screenshots `docs/screenshots/phase-5/trade-mod-*` (`tools/screenshots/trade-mod.mjs`). Docs: TRADING.md "T.6 as built", SOCIAL.md, DEPLOY.md, TELEMETRY.md, API_CONVENTIONS.md, DATA_MODEL.md, WAREHOUSE.md.

### T.7 Trading hardening, exploit review & balance — `done (PR #103)`
GDD: §10.1, §16.3. `docs/TRADING.md` in full (abuse cases, "Test strategy", the T.7 row, "T.1–T.6 as built" with their remaining risks), `docs/SOCIAL.md`, `docs/ECONOMY.md`, `docs/WAREHOUSE.md`, `docs/TELEMETRY.md`, `docs/PVP.md` (defence snapshots), `tools/balance/`. Needs T.1–T.6.
- Exploit review of T.1–T.6 (attack, prevention, proving test, residual risk), every hole fixed with a failing test first; the known items from T.3 and T.6; the journey with three players; a balance check with the realistic player and the switches on. No new trading features.
- Done: see `docs/TRADING.md` "T.7 exploit review" and "T.7 as built", `docs/ECONOMY.md` "Balance check: trading and the shelf (ticket T.7)".

### 5.8 Phase 5 hardening & exit — `done (PR #105)`
GDD: §15 Phase 5 exit, §16.3.
- Exit-criteria e2e with several players: boards and recompute, a season ending with prestige awarded, rated and friendly duels, account security flows, and (with the switches on in the test) a full trade cycle with a reversal; everything reconciled with the audit log and telemetry. Browser run for the key flows.
- Exploit review of every Phase 5 endpoint; rate limits reviewed; Phase 5 retrospective in this file.
- Done: `apps/server/src/e2e/phase5-exit-criteria.test.ts` (API, ~22 s) and `tools/e2e/phase5-exit.mjs` (browser, CI job `e2e-phase5`); exploit review in `docs/PHASE5_EXPLOIT_REVIEW.md` (three holes fixed, F1–F3); rate-limit review in `docs/SOCIAL.md` "Rate limits: the Phase 5 review" and `SECURITY.md`; version 0.5.16. No migration, no gameplay number changed.

### Phase 5 retrospective (ticket 5.8)
**Exit criteria (GDD §15 Phase 5): met.** *Leaderboard values are reproducible and server-authoritative; PvP matches are understandable, reasonably fair, and do not damage core PvE progression; trading (if switched on) creates and destroys no value, and every trade is auditable and reversible within its window.* Checked end to end through the HTTP API with an injected clock and seven accounts in an invite-only town (`apps/server/src/e2e/phase5-exit-criteria.test.ts`, ~22 s; no database writes but the owner's documented CLI steps and the scheduler's season jobs; every random outcome from the server's own `crypto` seeds, asserting only what holds for every seed). The owner opens the town (CLI invite and role) and appoints a moderator. **Account security:** four players verify their address through the captured letter; a guesser at a fifth player's address gets five free failures, a sixth that starts the lock and a `429 limit: account`, and an address nobody owns answers exactly the same; the right password waits out the lock; the player logs out another device and resets the password through the mailed link (`playAccountSecurityStep`). **Season 1** is scheduled in the admin panel (a player gets the admin `404`). Three heroes (warrior, mage, hunter) farm on one clock to level 15 and rest; a warlock friend stays at 4. **Boards:** a hero ranked by his own scores, seen and reported by another player; every hero on every board with its recomputed value at the current formula version (Gear Score 2); the recompute check finds nothing wrong (again after the duels and trades). **Duels:** no rated duels below 10 (`level_too_low`); friendly challenges both ways between the level-15 warrior and his level-4 friend are fought in 1–9 (the lower hero's bracket) with no rating; a friend is never a rated opponent and a stranger never a friendly one; a defence not on the list is `not_offered`. Each duellist fights ten rated duels from server lists (each list: exactly the two other duellists, one defence per account, never the friend below 10), every one replayed by its key; the eleventh is `409 no_duels_left`; the next UTC day opens ten more. Repeat pairs move ratings at 1, ½, ¼, ¼ (B.4b, never 0); each hero's rating moves exactly once per duel it was in (the chain of before/after across all its duels has no gap and ends at the ladder's rating); all three are established (≥ 10 games); nothing anyone owns changed. **The season ends:** past the end and the grace, three runs of the season jobs archive once and award once; the awards equal game-core's `seasonAwards` over the stored standings (all five boards, the arena ladder's Champion and Exalted included); the arena champion shows the Duellist title and frame, another player sees them on the profile, and a player who earned nothing is refused (`award_not_earned`). **Trading** with the switches on in the test (T.7's step with `played`: the players earned eligibility by playing, and the traded items are farmed Epics in the pack, tradeable under the switches, instead of items made Epic in place): a swap with escrow, a gift, an item swap that binds both items to their new accounts, the 72-hour hold refusing sale, shelving and sending, a report and a moderator's reversal within the hold (a second refused), "Trade: gold" switched off voiding an open offer, a trade restriction from the queue, the release after 72 hours and the refused spends then going through, the shelf moving received value to a second hero; the switches back to the defaults (trading closed). **Valid:** every hero's holdings and every shelf equal the audit log; `reconcileWithAudit` and the real `pnpm report:telemetry -- --reconcile` on the run's database match in all 99 checks; telemetry counts the rated and friendly duels, trades and the reversal exactly; and a guard on **every response of the run** found no other player's email, account id or hero id. Looped 20 times with shuffled files and fresh seeds (with the T.7 and duel journeys, the arena and account security suites): green. Browser half, in a real browser (`tools/e2e/phase5-exit.mjs`, CI job `e2e-phase5`, ~30 s): the e2e server opens trading, schedules Season 1 and seeds three ready players for the test only (`E2E_SEED_PHASE5=1`, `apps/server/src/e2e/seed-phase5.ts`: aged and verified accounts, levels, a friendship, an Epic in a pack, two saved defences; through the server's own model functions and fixtures, never an API path, roles untouched); the flows themselves go through the real UI and API. **Boards:** your place and rank, others by name, Character Power filtered to warriors, "how is it measured", the season board. **Arena:** the server's rated list holds the stranger and never the friend; a rated duel's result (verdict, rating change, "Nothing you own changed.", the log) and a friendly one without a rating; the ladder. **Trading:** a gift of an Epic and gold composed, reviewed and sent; the friend sees it, accepts, reads the 72-hour hold; the history; gold placed on the account shelf. **Account security:** a new player sees the verify strip, verifies through the mailed link, logs out a second device, is locked after wrong passwords (`429`, "Too many wrong passwords for this account"), resets through the mailed link and logs in at once. The run fails on any page error and any `429` but the expected lock; three local runs 28–35 s. Not in the browser: swaps both ways, shelving an item, reversals and voids (all in the API run).

**Numbers from the runs (record only; no balance changes).** 20 API runs:
- Level 15 after 11–13 two-hour town visits (22–26 game hours) for all three duellists (levels 15–18 at rest; the friend stays at 4).
- 33 rated duels per run (10 + 1 per duellist); final ratings between 1,320 and 1,739; 18 awards per run (four score boards × Champion, two Exalted and, on three of them, a Renowned; the arena ladder's Champion and two Exalted: B.4's scaling on a board of three to four).
- A farmed tradeable item (Epic or better, never worn) was already in both packs in 17 of 20 runs, one or two visits away in the rest (the bound is 60 visits; Epics are 3.5 % of item drops).
- 99 telemetry reconcile checks per run, all matching.

**What the exploit review found** (`docs/PHASE5_EXPLOIT_REVIEW.md`, an independent second reader; each fixed with a test that failed first):
- **Medium — the arena announced blocks:** the blocked player read "A blocked player" in the duel book; a rated duel against an old defence id answered `not_found` after a block and `not_offered` otherwise; a friendly challenge `404` after a block, `403` after an unfriend. Now only the blocker is told, the list is checked first, and a friendly challenge past a block answers as to a stranger.
- **Medium — the per-address login lock could be outrun in parallel:** every guess in flight when the lock started was still checked (15 of 15 against 6). A check is now reserved before the password is read (login and the email change).
- **Low (config) — the email change tested addresses with mail off** at 300 a minute (`409 email_taken`); the mail class (3 an hour) now applies always.

Checked and holding: staff and admin routes `404` before validation and re-read the role in the transaction; roles stay CLI-only; prestige picks only from own awards; rated duels only from the server's list, with a required `Idempotency-Key` (no re-roll by retry), the daily count under the duel lock, ratings under season → pair → hero locks; boards and the ladder carry no account, hero or item id and follow `canViewProfile`; the account security flows answer the same for known and unknown addresses; trading as in T.7's table.

**Accepted risks** (reviewed, left as they are; details in the review): the trade partner page lists a qualifying friend's heroes even with a hidden profile (an offer must name them); a friendly challenge to a stranger's defence id tells whether they are sanctioned (boards already do); any sanction, a trade restriction included, takes a player off the boards while it runs (owner decision in 5.2; narrower would be an owner decision); duel replays count against the social class; empty opponent lists may be redrawn at once; a `304` board read still runs its query; the limiter maps sweep only past 10,000 keys; a guesser can keep a player locked out (a reset always works). Phase 2–4 and T.1–T.7 accepted risks still stand.

**Rate limits** (`docs/SOCIAL.md` "Rate limits: the Phase 5 review", every class with its value against realistic use and abuse): no value changed. The base 900 requests / 300 actions a minute per account carries three tabs of the busiest screen at 7 %; Phase 5 adds one board poll a minute (`ETag`, its own 60-a-minute class), the trading inbox every 30 s and the arena on open; duels are social writes (12 a minute, 240 an hour) plus 10 rated a day; trade writes 20 a minute; login 10 a minute per IP plus the per-address lock; registration 5 an hour per IP; forgot password 5 per 15 minutes; tokens 20 per 15 minutes; letters 3 an hour per key. Two behaviours changed with the fixes: parallel guesses count as sequential ones, and the email change always takes the mail class. Still one API instance: every limiter is in process memory (4.11's plan for a shared store stands).

**What went well.** Building Phase 5 on the 4.11 journey paid off: every ticket left a journey step, so the exit run is mostly composition, and the T.7 trading step needed only a `played` mode to run without shortcuts. Server-side scoring made the season check exact: awards are predicted from the stored standings with game-core's own `seasonAwards`, and the rating chain proves each duel moved a rating once. Abuse-first design held up: the review found no value bug in the arena, the boards or trading; the three holes were leaks and a limiter race at the seams (blocks seen from the other side; a check-then-count across an `await`). The trading switches and the T.2 seam made "on in the test, off in production" a single admin call. Phase 5 had no flake on `main`; T.7 removed the one ordering assumption it found in a race test.

**What to do differently in Phase 6.**
- Review every check-then-act that spans an `await` (argon2, a query, a mail send) for parallel requests; in-memory counters are the easy place to miss it.
- When a refusal depends on a relation, check the server-offered list (or the ownership) first, and answer blocks and unknowns alike.
- Every feature that shows "the other side" (duel book, trade history, guild views) should be read from both sides in its tests, the blocked side included.
- New content above level 28 will move the boards (PvE Progress saturates at 10/10, B.4); version the formulas and let the 5.2 sweep recompute, rather than resetting anything.
- Keep the exit runs' privacy guard; teach it every route that answers with the caller's own account without a session (registration, login).

**Risks carried into Phase 6.**
- One API instance: limiters, the world-state and settings caches, and the schedulers are in process memory (shared store and leader election needed before a second instance).
- Trading is built but closed; its live telemetry (`trade.items`, the 10 % Legendary alarm, T.7) hasn't been seen with real players yet.
- PvE Progress tops out within two weeks (B.4); Phase 6 content must add milestones.
- Look-alike names and a reserved-names store (4.11) are still open, now with public boards that rank players by name.
- Playtest feedback (`docs/PLAYTEST_FEEDBACK.md`) has still not arrived; B.4 and T.7 were tuned from simulations.

**Owner's open items** (before or at the start of Phase 6):
- **Choose an SMTP provider** and put its settings in `deploy/.env` on the VPS (`docs/DEPLOY.md` "Email"); until then verification, reset and trading's verified-email rule can't work on the live town. **Update the privacy policy** on the VPS for email (the provider as a processor, what is mailed).
- **Schedule Season 1** (admin panel → Seasons, or `deploy/admin.sh seasons`); later seasons follow back to back.
- **Open trading in the documented launch order** (`docs/TRADING.md` "Admin switches", T.2's launch order): only after mail works (eligibility needs a verified address), and watch `trade.items` and the pattern report after each step.
- **Add the public leaderboards to the privacy policy** (every player listed by display name, no opt-out; owner decision 2026-11-07).
- Answer B.4's open question 3 (the thin 10–19 bracket) and decide the trade partner page and the sanction rule for boards if they should differ (accepted risks above).

## Phase 6 — Endgame expansion & long-term systems
**Status: complete** (ticket 6.10; see the Phase 6 retrospective below). 6.11 (the Gravewarden Seal sink) waits for the owner to schedule it.

GDD §15 Phase 6, §7.5 (variants), §8.2 (Item Awakening), §12 (community), §13 (cosmetics), §16.4. **Exit:** endgame systems add meaningful choices without making older content or most item drops irrelevant (GDD §15). Concretely: a level-28 hero in good Ashen Pass gear can still farm and progress in the new region; Phase 1–5 drops keep a use (salvage value, set pieces, crafting inputs, Forge targets); no new system is required to stay competitive in PvE.

**Ground rules for Phase 6** (all Phase 1–5 rules still apply, including `CLAUDE.md` "Writing tests that don't flake", the patch-notes and the screenshots rules)
- **Phase 6 releases are 0.6.x.** The first Phase 6 PR players can see bumps to `0.6.0`.
- **Content stays data-driven** (areas, enemies, loot tables, bosses, events, cosmetics). Balance numbers move only in their own ticket or a B-ticket, with before/after tables.
- **Older content stays relevant.** New tiers extend the curves, they don't replace them. A ticket that adds power states how a hero in today's best gear fares, and the balance suites assert it.
- **Boards move by versions, never resets** (5.2 sweep, 5.3 "formula changes between seasons"). New content adds Power trials and PvE Progress milestones as new formula versions, scheduled between seasons.
- **Cosmetics and events never sell or grant power** (GDD §13.3). Event rewards are cosmetic or ordinary loot at ordinary odds.
- **PvP stays separate.** New content may need new reference kits or class factors in the PvP normalisation layer (`PVP_RULES_VERSION` bump with measurements); PvE numbers never change for PvP's sake.
- **Abuse first**, as in Phase 5. Phase 5's lessons apply: check-then-act across an `await`; check offered lists and ownership before relation-based refusals; test "the other side" of every view.

**Defaults the owner can override** (recorded in the GDD when the ticket lands):
- **New region:** the Cinderwastes (working name), beyond the Ashen Pass, for levels **28–40** in two areas plus a region boss. Unlocked by the Ashen Warden and a community project (6.7), like the Pass. There is no hard level cap (owner decision, F.1); the XP soft cap moves from about 35 to about 42.
- **Harder mode:** **crypt tier IV "Heroic"** for the Legendary tier (owner decision, 4.11 follow-up). Same crypt, harder chambers and boss variants, better odds at the top rarities and no new power curve. Tier III stays "the Legendary tier".
- **Boss variants:** a **weekly rotating modifier** on the crypt bosses, the Ashen Warden and the guild boss (e.g. "Burning", "Warded", "Frenzied"). It changes tactics and adds a small loot focus, and is announced in the Tavern.
- **Prismatic:** a second variant **after Void, never stacked with it** in this phase (GDD §7.5, the 3.5 decision). Rarer than Void, Legendary/Mythic/set only, a different stat shape rather than more power. Stacking (a Void-Prismatic item) stays out until a later decision.
- **Item Awakening:** **evaluate first** (a design doc and a game-core prototype behind a switch, off). Ship only on the owner's yes.
- **Events:** **admin-scheduled rotating events** (e.g. a "Harvest of Bones" week): a world modifier, an event quest line in the Tavern and a cosmetic reward track. Up to one event at a time, scheduled in the admin panel like seasons.
- **Cosmetics:** a **collection book** with hero appearance variants (palette swaps of the class sprites), banner and crest styles, and title colours. Earned from events, deeds, seasons and milestones; never bought; no stats.

**Order** (one or two sessions at a time):
1. 6.1 and A.11 (parallel)
2. 6.2
3. 6.3
4. 6.4 and A.12 (parallel)
5. 6.5
6. 6.6
7. 6.7
8. 6.8 and A.13 (parallel)
9. B.5
10. 6.9
11. 6.10
12. 6.11 (small; when the owner schedules it)

### 6.1 Endgame region I: the Cinderwastes, levels 28–34 (vertical) — `done (PR #109)`
GDD §7, §9, §11, §15 Phase 6. Read `docs/WORLD.md`, `docs/COMBAT.md` (heroes past the content's top), `docs/LOOT.md`, `docs/FARMING.md`, `docs/DUNGEONS.md` (the Ashen Watch).
- First area of the new region: enemies 28–34, a tier-4 loot table (item levels 29–35, tier-5 affixes from 31 per the affix curve), gathering and an unlock (Ashen Warden defeated, level 28).
- Extend the XP curve and penalty so the soft cap sits around 42; extend the level, affix and rarity curves without changing values at or below 28. The no-effects hashes and the existing balance suites stay unchanged up to level 28.
- 5.1 formulas get new versions, switched between seasons: Power gets trials for the new levels, PvE Progress gets milestones for the new area. Leaderboard docs updated.
- PvP: reference kits for 30+ (`PVP_RULES_VERSION` bump only if needed, measured).
- Tests:
  - a level-28 hero in today's best gear can farm the area profitably;
  - older drops keep salvage value;
  - curve monotonicity;
  - board recompute under the new versions;
  - a journey step;
  - screenshots on the `screenshots` branch.
- Patch notes `0.6.0`.
- Done: the Ashfall Verge (`ashfallVerge`, region the Cinderwastes, 28–34; unlock level 28 + the Ashen Warden, seam for 6.7's flag), foes `cinderRevenant`/`slagHound`/`emberWisp`/`ashColossus` on A.11's asset names (its art, merged), ten tier-4 bases (icons stand in as tinted tier-3 ones) from item level 29, table 29–35 with gold × 2.3, tier-5 affixes from 31 (never below 30). Curves: no value ≤ 28 moved; XP formula and penalty unchanged, soft cap now ~41–42. Best Pass builds farm it at 16–20 kills/min with no deaths and more XP/gold than the Pass. Power 2 (+ trials 30, 34) and PvE Progress 2 (13 milestones) switch between seasons (`game_settings.leaderboards.formulas`, sweep recomputes). PvP 30+ refit, `PVP_RULES_VERSION` 2; 30+ matchmaking band widened to the measured 13 % / 6.5 % (open point). Version 0.6.1. Details: `docs/WORLD.md`, `COMBAT.md` "The Cinderwastes", `LOOT.md`, `LEADERBOARDS.md`, `PVP.md`.

### A.11 Cinderwastes art: backdrop, enemies & region boss — `done (PR #107)`
GDD §3.1. The 6.1 and 6.2 area backdrops, 4–6 enemies and the region boss, matching A.7's treatment. Budget: two backdrop jobs, two or three 32/64 px enemy jobs, one boss job, and at most one regeneration. Manifest and `assets.ts`. **Acceptance:** a contact sheet in the PR.
- Done: `area.cinderwastes`, `area.cinder-depths` (384×216); `enemy.cinder-revenant`, `enemy.ash-colossus`, `enemy.ember-wisp`, `enemy.slag-hound` (64×64); `enemy.forge-tyrant` (128×128). Registered only, not drawn yet. 85 generations (seven jobs, one regeneration). See `docs/ASSET_GUIDELINES.md` "The Cinderwastes"; contact sheet `art/preview-cinderwastes.png`.

### A.14 Combat scene animations — `done (PR #108)`
GDD §3.1, §3.2. Owner request: heroes and foes move in the fight scene so it doesn't look static. Owner decision: animate in code for every sprite now, plus a PixelLab frame-animation pilot for the four hero classes; enemy frames later only if the owner likes the pilot.
- Code animation for every sprite in the area scene (and the crypt, the guild boss's niche): an idle breath in whole scaled pixels, desynchronised foes; while farming a cosmetic loop (hero swings, the target flashes and is knocked back, foes now and then answer, defeats crumble out and fresh foes fade in) with its rhythm from the hero's attack speed, flavoured by the chronicle (kills, level-ups, deaths). Resting: the breath only. No gameplay effect, no requests.
- `prefers-reduced-motion`: static. Paused when the tab is hidden. Transforms and opacity only, one timer, no per-frame React renders. e2e and screenshots stay still.
- Pilot: an attack loop per class from the class sprites (at most 4 jobs + 1 regeneration), cleaned to palette and outline, as sprite sheets with manifest and `assets.ts` entries; `PixelSprite` plays frame sheets (`steps()`, integer scale); heroes use their frames when present, the code animation otherwise.
- Tests for the scheduling (injected clock), reduced motion and no network; evidence (GIF or frame strips, desktop and mobile; a contact sheet) on the `screenshots` branch and under `art/`.
- Done: `apps/web/src/scene/` (pure scheduler, one-timer driver, scoped `scene-anim.css`); static with reduced motion and under automation (`navigator.webdriver`; override `worldforge.sceneMotion`). Pilot: an 8-frame attack loop per class (`character.<class>-attack`, 5 jobs, no generated idle: the frames shimmered), played by `PixelSprite`. `docs/DESIGN_SYSTEM.md` "Motion", `docs/ASSET_GUIDELINES.md` "Hero attack frames"; version 0.6.0. No server change, no migration.

### A.14b Animation sync fix & enemy attack frames — `done (PR #111)`
Owner feedback on A.14: "the breathing, knockback, fade animations do seem to be out of sync after like 2 enemies"; owner yes to enemy frames.
- Fix the desync (reproduce through several kills and respawns, find the cause, layer the animations, test over many respawns with an injected clock, a longer GIF).
- Attack frames for the common enemies (most-seen first: early areas, the Pass, the Verge), bosses keep the code animation; redo the hunter's shot. Budget: 4 jobs + 1 regeneration.
- Done. **Cause:** finished beat classes were never removed, so one element collected `rise`, `lunge`, `hit` (and the hero `hurt`, `glow`, `strike`) at once, and the stylesheet's order, not the newest beat, chose the running `animation`: after a foe's first respawn its hits and lunges, and after the first flinch the hero's strikes, silently stopped (a browser probe: 66 of 149 beats ran no animation). A late timer also fired several beats in one tick. **Fix:** one element per layer (breath > fade > own attack > being struck), one beat class per layer, a respawn clears the foe's layers, one-shot beats over 250 ms late are dropped. Tests model the stylesheet's cascade over 40 seeds × 2 minutes of respawns; the browser probe reads 0 wrong in 12 respawns per width. **Frames:** six 64 px enemies per job in a 3 × 2 grid; 15 enemies ship 8-frame sheets (`enemy.<name>-attack`, 82 × 64 with 18 px of strike room, `lead`); the cinder hound, slag hound and ember wisp missed the bar after the regeneration (fire bursts flattened into blobs) and keep the code animation, as do the abbey wraith (no slot) and the bosses. The hunter's new shot replaces the old one. 5 jobs (4 + the regeneration), 26 generations. Version 0.6.3.

### A.14c Fade fix & admin animation gallery — `done (PR #112)`
Owner feedback on A.14b: "sometimes an enemy just fades out, but there was no attack or took-damage animation before"; owner request: view every animation in-game without progressing there.
- The rule: a foe never fades out unless it took at least one visible hit in its current life. Reproduce, find the cause, test the invariant over many seeds and lives, re-run the browser probe.
- An admin-only "Animations" tab: every class, every enemy (by area, dungeon, event, and art not yet placed) and every backdrop, with beat controls, play/pause/step, speed, scale, a "has frames / code only" label, and a scene preview running the real loop. Assets only; frozen under automation until Play.
- Done. **Cause:** A.14b's lateness rule. A blow is due 200 ms before its foe's fall, so a timer that fired 250–450 ms late (a main-thread hitch, e.g. a settle re-render) dropped the blow as stale while the fall was still on time; a browser probe with injected 280 ms hitches saw 5 fades without a blow in a minute. **Fix:** the driver tracks each foe's life as shown: a fall plays only after a visible blow in that life, else it is dropped with its rise (the foe stays standing), and a rise only plays on a foe that is down. Tests: the invariant over 60 seeds × 90 s with random hitches and hidden tabs, a single foe under heavy hitches, smooth runs losing no fall; the A.14b driver fails them. Probe after the fix: 0 bare fades with and without hitches. **Gallery:** `#/admin/animations` (`apps/web/src/admin/`), gated like every admin section (`routeHiddenFor`, tested); reduced motion and automation keep it still until the admin presses Play, which forces motion on inside the gallery only (`.scene-anim--forced`). Version 0.6.4.

### A.15 Tier-4 item icons — `done (PR #110)`
GDD §3.1. Follow-up from 6.1: its ten tier-4 bases show their tier-3 counterparts' icons with an ember tint. Owner request: real icons.
- Ten 32×32 icons, one per tier-4 base, in the item style (outline, palette discipline, angle, readable at ×1), with a Cinderwastes flavour (slag, obsidian, ember inlays, forge-blackened metal); a clear step up from tier 3 that doesn't clash with the rarity frames or Void.
- Budget: at most 2 PixelLab 32 px jobs plus one regeneration. Clean the picks (palette, alpha 0/255, consistent lighting).
- Switch the bases via the manifest and `assets.ts`; keep the ember tint only as a fallback for missing art. A test that every tier-4 base resolves to its own icon file.
- **Acceptance:** a contact sheet under `art/` (×1 and ×2 next to tier 3, inside every rarity frame and Void); a pack and tooltip screenshot on the `screenshots` branch.
- Patch notes: the next 0.6.x version.
- Done: `item.<base id>` for all ten (`cinderforged-blade` … `wispfire-band`). One job (`icons-tier4-01`, style image `knights-plate.png`, 10 generations) covered every base; no second job or regeneration. Picks cleaned with `tools/art/tier4_icons.py` (edits next to the raw files). `ART_STAND_INS` is empty and stays as the fallback. Contact sheet `art/preview-tier4-icons.png` (`node tools/art/preview_tier4_icons.mjs`, the game's own frame CSS); screenshots `tools/screenshots/tier4-icons.mjs`. Version 0.6.2. `docs/ASSET_GUIDELINES.md` "Tier-4 item icons".

### 6.2 Endgame region II & region boss, levels 34–40 (vertical) — `done (PR #116)`
Needs 6.1.
- The second area (34–40) and a region boss dungeon in the Watch's style: a hoard that is always bound (T.1) and a boss material that has a sink, e.g. tier-5 upgrades or Awakening if 6.5 ships.
- A new PvE Progress milestone version.
- Tests like 6.1.
- Done: the Cinder Depths (`cinderDepths`, 34–40; unlock level 34 + the Ashen Warden = the Verge's top milestone; seam for 6.7's flag), four forge-tempered foes drawn as the Verge's sprites with an ember tint (`ART_VARIANTS`, no new art), tier-4 loot 35–41, gold × 3. The Tyrant's Forge (`tyrantsForge`, `#/tyrant`, level 36): the Forge Tyrant (level 40) with a slag shell (× 0.6 until 70 %) and a hammer (every third blow × 4) as optional `BossMechanics` data (no draws; earlier bosses unchanged), the Watch's replay/seed rules, an always-bound hoard (`hoard:tyrantsForge`) and one Tyrant's Ember (untradeable) whose sink is the Tyrantforged Work recipe (slot-targeted tier 4, Rare/Epic, item level ≤ 41). `progress.forgeTyrantDefeated` (each dungeon names its `bossProgress`; D.4's progress tool sets it). Good Verge gear farms the Depths with no deaths; Verge Legendaries beat the Tyrant at 36–38 34–42 % (+0), ~70 % (+5), 91–95 % (+10). PvE Progress 3 (17 milestones), no new Power version. No value ≤ 34 moved (`curve-pins-6-2.test.ts`); soft cap ~47–48. PvP unchanged (rules 2); 30+ start-of-season fairness re-measured with levels to 40 (95 %+ favourites 7 → 9 %), left for B.5. Version 0.6.5. Details: `docs/WORLD.md`, `DUNGEONS.md`, `ECONOMY.md`, `LOOT.md`, `LEADERBOARDS.md`, `COMBAT.md`, `PVP.md`.

### 6.3 Crypt tier IV "Heroic" & boss variants (vertical) — `done (PR #118)`
GDD §9, §11. Read `docs/DUNGEONS.md`, `docs/GUILD_BOSS.md`.
- Crypt tier IV: harder chambers and boss mechanics at levels 32+, better top-rarity odds with no new power curve, and the run-replay and seed rules as tier III.
- **Weekly rotating boss modifiers** (data-driven, seeded by the week) on the crypt bosses, the Ashen Warden, the region boss and the guild boss. Each modifier gives a small loot focus. Announced in the Tavern.
- Telemetry per modifier.
- Tests:
  - modifier determinism per week;
  - the week boundary (window rule);
  - replay equality;
  - the guild boss's async attempts across a modifier change.
- Done: **Heroic** = crypt tier IV (`heroic: true`; gate level 32 + tier III cleared; owner decisions kept: tier III stays the Legendary tier, no new power curve). Chambers 32–36 with foes × 1.6 (`roomScale`, new optional data), the Heroic Gravewarden at 36 (health × 3.4, damage × 2.6, resistance × 0.5, enrage 30–60 s × 2, a heavy blow every fourth × 3), the crypt's run model unchanged. Loot at item levels 31–37 / 34–36 (inside today's bands, top 41), Legendary weight × 2.5, Void 15 % (the cap), hoard weights 0/2500/3500/1100/110: top-rarity share 18.3 % vs tier III's 5.3 %. Upgraded Verge Legendaries win it like the Forge Tyrant (at 32: +0 31 %, +5 69 %, +10 92 %; epics +10 0 %). Art: the crypt's own sprites with a Heroic tint and stage rim (`heroicSprite`), shown in the admin gallery. **Weekly boss modifiers** (game-core `dungeon/modifiers.ts`): Burning (a burn every 4 s), Warded (−30 % damage from 60 % to 45 % health), Frenzied (attacks × 1.25 below 40 %), Unyielding (health × 1.15, attacks × 0.85), Relentless (enrage 5 s sooner), each with a × 1.5–2 hoard focus; on crypt tiers II–IV (owner decision on the PR: tier I never takes one, its runs store null), the Ashen Warden, the Forge Tyrant and the guild boss (health shares by the clock there). Seeded by the ISO week in cycles of five (no repeats), stored with each run and attempt at its start (migration `0037_boss_modifiers`, additive; tier check widened to 4), replayed with the stored one; `null` = before 6.3, bit-identical. They cost a kit at the edge up to ~20 points of win rate and the best kits 0–8; guild boss damage −8 % to +9 %. Tavern notice (`GET /api/world/boss-modifier`), dungeon doors, run panel, siege plate, admin world folio (this and next week). Telemetry `boss_modifier.run`/`.hoard`/`.guild_boss` with a report section and reconciliation. PvE Progress 4 (18: the Heroic crypt cleared), between seasons; the D.4 progress tool sets it. No-effects hashes, curve pins and every earlier balance suite unchanged. Version 0.6.6. `docs/DUNGEONS.md` "The Heroic crypt", "Weekly boss modifiers", `GUILD_BOSS.md`, `LOOT.md`, `QUESTS.md`, `LEADERBOARDS.md`, `TELEMETRY.md`.

### 6.4 Prismatic variant (game-core + vertical) — `done (PR #120)`
GDD §7.5. Read `docs/EFFECTS.md` (variants), `docs/LOOT.md`, `docs/TRADING.md` (the categories).
- Prismatic: Legendary, Mythic and set items only, rarer than Void, and **never stacked with Void** (one variant per item).
- A distinct stat shape, e.g. converting part of its main stat into a rotating element or secondary. Documented and balanced so the best Prismatic is a sidegrade to the best Void.
- Drop odds only in Ashen-tier and newer content.
- Trading: a new "Tradeable: Prismatic" switch, default off (T.2 settings, migration-free default).
- `validateItem`, binding (T.1), Gear Score (5.1 version bump if counted), and PvP normalisation all cover it.
- Tests:
  - drop odds over many seeds;
  - forged-item refusal;
  - invariance of non-Prismatic numbers;
  - trading-switch behaviour.
- Done: `variant = 'prismatic'` (Legendary, Mythic, set pieces; never with Void: one value per item, rolled only after a failed Void roll; requested bases never, like Void). **Shape:** base values and the effect as on the plain item, the item's combat affixes × 1.1 when read (`affixBonus`, `AFFIX_BONUS_STATS`: every core stat but critical chance, plus boss and skill damage; find affixes never), stored values untouched. Void = base and effect, Prismatic = affixes, so the item's affixes and the Forge decide which is better. **Sidegrade** (B.2 search per variant, Pass farming and the Ashen Warden, +0 and +10): best Prismatic ÷ best Void 0.997–1.009 farming, 0.974–1.041 at the Warden, Verge 0.999–1.019 (asserted within 5 %, `prismatic-balance.test.ts`); × 1.2, or × 1.1 with crit chance, made it 3–10 % stronger. **Drops:** 5 % of non-Void top rolls in the Pass, the Warden's hoard, the Verge, the Depths and the Tyrant's hoard, 7.5 % in the Heroic crypt (cap 7.5 %): ≈ 0.45 × Void (Heroic ≈ 1 per 23 runs vs 1 per 10). Trading: "Tradeable: Prismatic" (off, no settings migration), T.1/T.4/T.5 and the Mythic/Void weekly cap cover it; loot filter: a protected Prismatic category. Gear Score × 1.1 like Void in version 2 (no stored row could hold Prismatic before; no Power version either). PvP: no rule change (`PVP_RULES_VERSION` 2); kits vs Void 37–47 %, B.2 builds vs Void 58–64 %, step over +5 inside the 5.4 band. Migration `0038_prismatic_variant` (widens the variant check). Admin grant offers Prismatic (test accounts). Tooltip line (✧, A.12's mark) and affix values as read; the frame treatment is A.12's (`item-frame--prismatic`). Version 0.6.7. `docs/EFFECTS.md` "Prismatic variants", `LOOT.md`, `DATA_MODEL.md`, `TRADING.md`, `LEADERBOARDS.md`, `PVP.md`, `ECONOMY.md`, `DUNGEONS.md`, GDD §7.5.

### A.12 Prismatic & Void-plus visual treatment — `done (PR #119)`
The Prismatic shimmer treatment for item icons (the 3.5 Void pipeline: palette and overlay, not new sprites), plus tooltip and rarity-frame accents. Budget: one 32 px job at most; prefer a code/palette treatment. **Acceptance:** a contact sheet.
- Done: a code and palette treatment, no generations. `ItemFrame` picks it from `variant.id === 'prismatic'` (`components/itemVariant.ts`), like Void: the art keeps its colour under a stepped opal tint, a slow glint sweeps across it in whole art pixels, an opal hairline runs inside the rarity ring, ✧ in the corner; both overlays are 32-pixel art (`/assets/overlays/`, `tools/art/prismatic_overlays.py`) clipped to the icon's alpha in its own grid cell (no layout change, tested; equal boxes measured in the browser). Still under reduced motion and automation (`navigator.webdriver`, A.14's override). Tooltip and return-summary accents keyed on `data-variant`. Void unchanged: it still reads drained and outlined next to Prismatic and the tier-4 icons. Admin gallery "Variants" table (one icon per rarity and a set piece, plain/Void/Prismatic; frozen until Play). Contact sheet `art/preview-prismatic.png`; screenshots `tools/screenshots/prismatic.mjs`. No patch notes (6.4's Prismatic entry covers it). `docs/DESIGN_SYSTEM.md` "Prismatic", `docs/ASSET_GUIDELINES.md` "Variants".

### A.12b Void animation — `done (PR #124)`
Owner request after A.12: Void gets its own motion, like Prismatic's shimmer, clearly different from it.
- Done: code only, no generations. While motion is on (A.12's gate: reduced motion and automation keep it still), Void's voidlight edge moves to a layer behind the icon that breathes in four opacity steps over 7.2 s and glitches one art pixel sideways once a cycle, and voidlight motes (`void-motes.png`, `tools/art/void_overlays.py`) are pulled through the rift toward the centre in whole art pixels. Still, the frame is the 3.5 look, pixel for pixel (contact sheet unchanged). Same grid cell as the icon (no layout change, tests and a browser measurement); everywhere `ItemFrame` draws Void; the gallery's Variants table plays it. GIF `void-prismatic-motion.gif` on the `screenshots` branch. Version 0.6.10 (after 6.5b's 0.6.9). `docs/DESIGN_SYSTEM.md` "Void in motion".

### 6.5 Item Awakening: evaluation & prototype (design + game-core) — `done (PR #121)`, decision pending
GDD §8.2. Read `docs/EFFECTS.md`, `docs/ECONOMY.md`, `docs/LOOT.md`.
- A design doc `docs/AWAKENING.md`:
  - options (an extra affix slot vs a special effect);
  - costs and sinks (the 6.2 boss material and gold);
  - eligibility (Legendary/Mythic/set at +10);
  - binding (awakened = bound);
  - PvP and board effects;
  - risks (power creep, making older drops irrelevant).
- A game-core prototype behind a switch (off) and a balance simulation with the realistic player.
- **Owner decision gate:** the doc ends with a recommendation and questions. Server, UI and patch notes come only after the owner's yes, as a follow-up ticket 6.5b.
- Done (evaluation; nothing players can see, no route, migration or patch note, no existing number changed): `docs/AWAKENING.md` compares (a) an extra affix slot, (b) an awakened effect and (c) a cosmetic mark. Game-core prototype `items/awakening.ts` behind `DEFAULT_AWAKENING_SETTINGS.enabled = false` (frozen, not exported from the package index; `awakenItem` refuses everything while off), readers in `itemEffectInstances` and `setBonusInstances` that return the pre-6.5 instance for every item without an awakening (no-effects hashes and every balance suite unchanged; a late-game kit is unchanged when offered to the switched-off prototype). Measured with the B.2 build search and the realistic player's cadence (`tools/balance/awakening.ts`, guards `balance/awakening-balance.test.ts`): **recommended (b) at × 1.1**: a whole awakened kit +3–10 % at the late bosses and 0–2 % farming over the best +10 Void/Prismatic kit, one piece +0.1–0.8 %; an awakened Verge kit is level with plain Depths gear (−3.8 to +0.6 %) and one awakened older piece always loses its slot (exit criterion met); × 1.25 (and a full extra affix) fail it (+4–10 %). Cost 3 Tyrant's Embers, 2 Gravewarden's Seals, 25,200 gold at item level 37 and 30 soul shards: 3 days per item and 24–27 days per kit for a dedicated player (casual 96–108). Gear Score and Power need no version (Power +0.1 %); duels should ignore awakening (else an awakened kit wins 58 % against an equal one that matchmaking can't tell apart). Runner-up (a) at half an affix. Six owner questions at the end of the doc.

### 6.5b Item Awakening build (only after the owner's yes) — `done (PR #123)`
GDD §8.2. Read `docs/AWAKENING.md` (the owner's answers to its questions decide the numbers). Recommended scope, if the owner says yes to option (b):
- Server: an item column for the awakening (migration), `validateItem` accepting it only on eligible items, `POST …/forge/awaken` (Idempotency-Key, character → item locks, refusals and the purse checked before paying, refused on held items, `forge.awaken` audit with costs), a trade-rule refusal for awakened items, telemetry (`forge.awaken`, Embers and Seals spent).
- game-core: the stored awakening drives `effectStrength` (the prototype's readers); PvP normalisation ignores awakening (a pinned duel unchanged, `PVP_RULES_VERSION` unchanged); no Gear Score or Power version (re-check).
- Web: the Forge's awaken panel with a before/after quote (effect caps, "2 of 4 set pieces awakened"), the tooltip line and an awakened mark (a code treatment like A.12), and the loot filter protecting awakened items.
- Tests: refusals, idempotency and races (awaken vs sell, vs trade), the no-effects hashes, `awakening-balance.test.ts` on the built rule, a journey step, screenshots. Patch notes for the next 0.6.x.
- Done (owner's yes 2026-11-10: option (b) × 1.1, the proposed price, **counts in duels and matchmaking**, account-bound and never tradeable, shelf allowed). game-core: the switch removed (rule live, numbers in `DEFAULT_AWAKENING_SETTINGS`), `validateItem`/`checkEquipment` accept only the shipped awakening on an eligible +10 item, binding reason `awakened` and trade check `item_awakened`, `awakeningPreview` (before/after, set progress, capped numbers that move). Server: migration `0040_item_awakening` (`awakening`, `awakened_at`), `POST …/forge/awaken` (Idempotency-Key, Forge lock order, refusals and the price before paying, value on hold excluded, `forge.awaken` audit, telemetry source `forge_awaken`, reconciled), every combat read carries it, admin grant `awakened`. Web: the Forge's "The Banked Fire" panel (eligible items, price, before/after, warnings, full confirm, all states), the ember mark ☼ on frames and tooltips (still under reduced motion/automation), admin gallery rows. PvP: no duel rule changed (`PVP_RULES_VERSION` 2; awakened vs equal kit 51.9 % in 20–29, 53.3 % in 30+); bracket Power 2 (× 1 + 0.002 per duel-read awakened effect, fitted; equal to 1 without awakening), `MATCHMAKING_VERSION` 3. Bands with every +10 Void hero awakened: 20–29 within its band; 30+ 90 %+ favourites 14.5 % (13.2 % unawakened), over 14 %: reported, not loosened (B.5). Gear Score and Power unchanged (no version). Version 0.6.9. Details: `docs/AWAKENING.md` "As built", `PVP.md` "6.5b", `EFFECTS.md`, `ECONOMY.md`, `TRADING.md`, `LEADERBOARDS.md`, `DATA_MODEL.md`, `TELEMETRY.md`.

### 6.5c Awakening auto-lock (owner decision on 6.5b's question 2) — `done (PR #128)`
- Awakening sets the item lock (3.7) in its transaction, audited `item.lock` with `via: 'awaken'` (none when the item was already locked). Locked items are refused for sell, salvage and discard (`409 item_locked`) and the loot filter only ever sees new drops; the player can unlock it in the Pack. A one-time `data_backfills` step (`awaken-lock:6.5c`, in the server after start-up, idempotent) locks items awakened under 0.6.9. The Banked Fire's confirm says so. Tests: awaken → locked with one audit row (double submit, same key), sell/salvage/discard refused, unlock then sell, an already locked item, the backfill once and idempotent. Version 0.6.13.

### 6.6 Rotating events framework (vertical) — `done (PR #122)`
GDD §12, §13. Read `docs/QUESTS.md`, the 5.3 season model (scheduling, the window rule, archive).
- An event model scheduled in the admin panel and by CLI (start/end UTC, one at a time), with data-driven event definitions:
  - a world modifier (e.g. bonus material yield or a themed enemy variant);
  - an event quest line in the Tavern;
  - a cosmetic reward track.
- Rewards are cosmetic (6.8) or ordinary loot at ordinary odds; never power.
- One complete first event, "Harvest of Bones" (working name).
- Tests:
  - the event boundary (window rule);
  - the reward track granted exactly once (real PG);
  - an event ending mid-quest;
  - invariance outside events;
  - a journey step.
- Done: game-core `events/` (definitions, cosmetics catalogue, calendar and progress rules) and server `events/`. **Calendar:** `world_events`, one at a time (never overlapping, at most one waiting), 1 h – 4 weeks, schedule / extend / end early / cancel a future one from the admin panel's Events tab or `pnpm admin:events` / `deploy/admin.sh events`, audited; the window rule as seasons (a request at or after the end counts nothing), closed 5 min after the end under an advisory lock. **Harvest of Bones:** heroes join in the Tavern; modifier: every 40 risen dead in the Fields or the Burial Grounds yield 1 Soul Shard (split-invariant running count; ≈ 6/h in the Fields); four tasks (10/10/15/15 bone tallies; tallies only); account track 10/25/50 → `banner.harvest-sheaf`, `title-colour.bone-white`, `title.reaper-of-the-harvest`, granted exactly once in the completing transaction plus a resumable close sweep. `cosmetic_unlocks` (for 6.8); the title shows through the honours picker (`prestige_displays.cosmetic_title`). Unfinished tasks expire, nothing earned is lost. Banner in the town and on the map. Invariance: same XP, gold and items with no event, outside it, or joined (materials + bounty only). Telemetry `event.join|quest|reward`, `material.in event`, reconciled. Migration `0039_world_events` (additive). Version 0.6.8. `docs/EVENTS.md`.

### 6.7 Community & world progression expansion (vertical) — `done (PR #125)`
GDD §12. Read `docs/COMMUNITY.md`, the world flags.
- A project chain that opens the new region's later parts: 6.2's area and the region boss gate, and a town upgrade.
- World "eras": a visible long-term progression of Graumark, with stages that change town art and Tavern text, and world flags.
- A larger-town scaling check (B.3's caps against monopoly).
- Tests:
  - stage pacing at 20/100/500 players;
  - caps;
  - the flag-unlock journey.
- Done: **Rebuild the Forgeward Outpost** (`forgewardOutpost`, after the Ashen Pass; 3 stages, 300,000 gold, 2,500 ore, 1,200 shards, 80 silver, 10 Tyrant's Embers in the last stage; B.3's caps) sets `forgewardRaised`. It **gates nothing live** (the Verge, Depths and Tyrant keep their rules; the seams stay unused, tested). Town upgrade **the Forgeward bellows**: Tyrantforged Work 20 % cheaper in gold (3,000 → 2,400; `economy/town.ts`). **Eras** derived from the flags (Long Dusk → Ashen Siege → **Rekindling**, live today → Forgeward Age): town title, CSS tint, banners, crier and Tavern line; words only. Test accounts refused (`403 test_account`). Era changes audited (`world.era_change`) and counted (`world.era`) under a world lock, with a real-PG race test; per-project reconcile. Admin world folio shows era and stages; `admin:project stage` for test setups only. Pacing: 8 / 2 / 2 days at 20 / 100 / 500 players with the realistic player, ≥ 5 givers on a stage's first day (`balance/forgeward-balance.test.ts`). No migration. Version 0.6.11. `docs/COMMUNITY.md`, `WORLD.md`, `ECONOMY.md`, `QUESTS.md`, `TELEMETRY.md`.

### 6.8 Cosmetic collection book (vertical) — `done (PR #127)`
GDD §13. Read `docs/LEADERBOARDS.md` (5.3 prestige display), `docs/SOCIAL.md` (profiles).
- A collection book: hero appearance variants (class palette swaps), banner and crest styles, and title colours. Each entry has a source (event, deed, season, milestone).
- Equip and preview; shown on profiles, boards, rosters and the duel screen.
- Never purchasable, no stats. Cosmetics are account-bound and not tradeable.
- Tests:
  - granted exactly once;
  - display privacy (5.2 rules);
  - invariance (no-effects hashes; 5.1 scores);
  - screenshots.
- Done: game-core `cosmetics/catalogue.ts` (20 cosmetics: 5 appearances incl. the default, 6 banners, 4 crests, 4 title colours, 1 title; 6.6's ids kept), each with one source (`event`, `achievement`, `milestone`, `season`, `default`); no price, no numbers; nothing in the rules imports it (scan). **Grants** exactly once per account and id (`cosmetic_unlocks` PK, `on conflict do nothing`, audited `cosmetic.grant`) in the source event's transaction: with each new achievement (`awardAchievements`, so live awards, Forgeward contributors and the achievement backfill), milestones in `refreshAchievements` (level 40, Ashen Warden, Forge Tyrant, Heroic crypt), season honours in `awardSeason`'s last transaction, events as 6.6. **Backfill** `cosmetics:<hash>` in `migrate-cli` (resumable, idempotent; real-PG races). **Equip** per hero (`POST /api/characters/:id/appearance`) and per account (`POST /api/account/cosmetics/equip`: banner, crest, title colour), Idempotency-Key, only owned ids of the slot's kind (composite FKs back it), audited `cosmetic.equip`; titles still via Season honours. **Book** `#/collection` (filters by kind and earned/locked, preview on the hero, how to earn, equip; loading/empty/error). **Display:** `prestigeFor` carries banner, crest and title colour to boards, profiles, rosters and the ladder; hero palettes on profiles, the area and crypt scenes and the duel screen (shown where the name is). A.13's art (palettes in code, banner and crest sprites) with plain fallbacks. Admin gallery "Palettes". Migration `0041_cosmetic_collection` (additive). Version 0.6.12. `docs/COSMETICS.md`.

### A.13 Cosmetic art: appearance variants, banner and crest styles — `done (PR #126)`
Palette-swap sets for the four class sprites (code-driven where possible) and 6–10 banner and crest styles. Budget: one or two 32 px jobs; prefer palette work over new generations. **Acceptance:** a contact sheet.
- Done: four appearance palettes (`appearance.ashen|ember|grave-moss|midnight`) for all classes as code data in `apps/web/src/content/palettes.ts`, applied at runtime on a canvas (no baked sheets, no generations). Six 32×32 banner styles (`bannerStyleAsset`), four 48×56 crest-style frames drawn in code on the crest outline (`crestStyleAsset`), and the `achievement.forgeward-builder` icon. Two 32 px jobs, 20 generations. Contact sheet `art/preview-cosmetics.png`. `docs/ASSET_GUIDELINES.md`.

### B.5 Balance pass: endgame — `done (PR #130)`
GDD §16.4. Needs 6.1–6.8.
- The realistic player through levels 28–40:
  - XP and gold pacing;
  - Heroic odds;
  - Prismatic share;
  - modifier fairness;
  - event reward pacing;
  - whether older drops still matter (salvage, Forge, set completion).
- Boards and PvP re-measured with the new versions.
- Address the owner's playtest feedback (`docs/PLAYTEST_FEEDBACK.md`) if it has arrived.
- **Acceptance:** before/after tables; balance suites green and fast.
- Done (playtest feedback had not arrived; the API simulator plays no Phase 6 content, so the endgame player is modelled in game-core at the realistic cadence; `tools/balance/endgame.ts`). **PvP 30+:** almost every lopsided pair sat within 1 % on bracket Power (a PvE measure that saturates at the top), so **bracket Power 3** ranks 30+ by **duel Power** (an expected-value duel against the bracket's four reference heroes, 1000 × e^(0.6 × the log time ratio); deterministic, ~0.2 ms; reads awakening and variants as the duel does) and **matchmaking 4** gives 30+ its own class scale (warrior ÷ 1.02, fitted on realistic heroes); 10–29 unchanged (their lists draw exactly as before). 90 %+ / 95 %+ favourites in 30+ 13.2 / 6.5 % → 3.2 / 1.0 % (to level 40: 13.8 / 8.8 → 4.0 / 0.7; all top kits awakened: 14.5 / 6.7 → 2.5 / 0.5; realistic heroes 8.2 / 3.3 → 2.3 / 0.3), rated duels in full 45 → 51 %; bands back to ≤ 9 / ≤ 5 % for 30+, not loosened. No duel rule changed (`PVP_RULES_VERSION` 2); stored 30+ defences recompute at the draw, no migration. **Bosses:** the Forge Tyrant resistance × 0.7, armour × 1.2 and the Heroic Gravewarden resistance 0.5 → 0.4, armour × 1.15 (new optional `EnemyScale.armor`): with Legendaries +5 over 8 kits the class spread 34 → 17–23 points at the Tyrant and 18–24 → 17–21 at Heroic, the mage 54–74 % → 66–79 %; the hunter's best build still kills in 13–17 s (owner question). **Warded** −30 % → −25 % (it was the hardest modifier; touches tiers II–III and the Warden). **Measured, unchanged:** Heroic loot (best build 26–58 dedicated days with Heroic, 33–90 without: not too fast for an 8-week season), Prismatic vs Void (no duel changed), Forgeward first-day cap (10 % changes no pace; not needed), the Harvest (track in about an hour; shard bonus harmless), awakening (Ember-bound, 24–27 days a kit, about a season), XP 28 → 40 in 38–52 h of farming with the soft cap at 47–48, older drops (Pass set pieces in a Depths kit −1 to −3 %). Guards `balance/endgame-balance.test.ts`, `arena-fairness.test.ts` (30+ to level 40, plain and awakened), `competitive-balance.test.ts`, server `arena/power-version.test.ts`. Version 0.6.14. `docs/BALANCE.md` "B.5", `PVP.md` "B.5", `DUNGEONS.md`, `COMMUNITY.md`, `ECONOMY.md`, `EVENTS.md`, `AWAKENING.md`, `LEADERBOARDS.md`, `DATA_MODEL.md`.
- **B.5b Owner decisions on B.5; the Forgeward first-day cap (2026-11-11)** — `done (PR #131)`: (1) the hunter's burst build stays until real player data shows a problem (accepted risk); (2) spare Gravewarden Seals get a sink later (placeholder 6.11, not built); (3) the Harvest of Bones stays, the next event should be a longer chase (`docs/EVENTS.md` guidance); (4) `capShare: 0.1` on the Forgeward Outpost's three stages: ten givers to finish a stage on its first day (was five), growing by the default rule (10 → 30 → 50 → 60 %); every other stage keeps 20 %. B.5's measurement verified: 8 / 2 / 2 days at 20 / 100 / 500 players either way, the first stage's givers 6 → 10 and its largest share 19 → 10 %. `stageCapShare`/`stageCap` no longer round a cap up on float noise (0.1 + 0.2). No migration. Version 0.6.15. `docs/COMMUNITY.md`, `BALANCE.md` "B.5b", `EVENTS.md`.

### 6.9 Scale readiness: shared limiters, caches & schedulers — `done (PR #132)`
Carried risk from Phases 4–5: one API instance.
- Move the in-memory rate limiters, the world-state and settings caches and the schedulers onto a shared store (PostgreSQL first, e.g. advisory-lock leader election and table-backed counters), so a second instance is safe.
- Document how to run two instances in `docs/DEPLOY.md`; don't switch production to two.
- Also the carried name risks: a reserved-names store and look-alike name checks (4.11).
- Tests:
  - two app instances against one real PG;
  - limits holding across both;
  - one scheduler leader at a time;
  - cache invalidation across instances.
- Done (production keeps one instance; `docs/DEPLOY.md` §17 "Running two API instances"). **Limits:** every limiter (account requests/actions, social, trade, board and ladder reads, admin reconcile, mail, the per-IP auth limits through a `@fastify/rate-limit` store, the per-address login lock with 5.8's parallel-guess rule) counts in PostgreSQL (`shared/limit-store.ts`: `rate_limit_counters` with one atomic `insert … on conflict … do update … returning` per counted request, `login_throttle` under its row lock with a 60 s check lease), both `UNLOGGED` (switched by `db:migrate`), pruned hourly; client addresses only as hashes. `SHARED_STATE=postgres` (default) or `memory`; `buildApp`'s own default is `memory` so tests keep separate counts per app. No value changed. Found by the two-instance test: requests reach the store slightly out of clock order, so a window now restarts only on a backwards jump of more than a window. **Caches:** world state, game settings and the season/formula plan bump `cache_versions` and `NOTIFY wf_cache` in the writing transaction; each instance listens on its own connection (reconnects) and compares versions every 15 s; the 60 s TTL stays. Event state is not cached. **Scheduler:** one session advisory lock per job (`pg_try_advisory_lock(ns, job)`) on a dedicated connection, checked before each run, failover when the connection drops; the start-up backfills run on one instance. **Names (4.11's carried risks):** game-core `social/names.ts` (`nameSkeleton`: confusables of other scripts, accents, case, digits for letters, `I`/`l`, `rn`/`m`, `vv`/`w`; `RESERVED_NAME_DEFAULTS`: staff, every boss, the town's people), server `names/checks.ts` at registration, the forced rename, hero creation, the admin hero rename, guild founding and the guild forced rename (`409 name_too_similar`, reserved `400`), skeleton columns with a start-up backfill (`name-skeletons:v1`), grandfathered names kept; the reserved-names store (`reserved_names`) in the admin panel's Names tab and `deploy/admin.sh reserved-name list|add|remove`, audited. Migration `0042_scale_readiness` (additive). Tests: `shared/scale.pg.test.ts` (two instances on real PG: account, social, per-IP, login lock incl. parallel guesses and known/unknown alike, mail; leader election with failover; cache by NOTIFY, missed NOTIFY and a dropped listener; unlogged; the limiter cost budget), `shared/shared-state.test.ts` (memory/PostgreSQL store parity, pruning, out-of-order requests, cache sync on PGlite), `names/names.test.ts`, game-core `social/names.test.ts`, `auth/login-throttle.test.ts` on both stores; looped 20× shuffled. Version 0.6.16 (the name rule; after B.5b's 0.6.15). `SECURITY.md`, `SOCIAL.md`, `API_CONVENTIONS.md`, `DATA_MODEL.md`, `TECH_STACK.md`.

### 6.10 Phase 6 hardening & exit — `done (PR #133)`
GDD §15 Phase 6 exit, §16.3.
- An exit-criteria e2e with several players: the new region and boss, Heroic with a modifier, Prismatic drops, an event start to end with its reward track, a world era advancing, collection rewards, boards recomputed under the new versions, and duels in the 30+ bracket. Everything reconciled with the audit log and telemetry.
- A browser run for the key flows (CI job `e2e-phase6`).
- An exploit review of every Phase 6 endpoint and a rate-limit review.
- A Phase 6 retrospective in this file.
- Done: `apps/server/src/e2e/phase6-exit-criteria.test.ts` (API, ~20–35 s) and `tools/e2e/phase6-exit.mjs` (browser, CI job `e2e-phase6`, ~25 s; seed `E2E_SEED_PHASE6=1`, `apps/server/src/e2e/seed-phase6.ts`); the exit criterion in numbers (`packages/game-core/src/balance/phase6-exit-criterion.test.ts`, `tools/balance/phase6-exit.ts`, `docs/BALANCE.md` "Phase 6 exit criterion"); exploit review in `docs/PHASE6_EXPLOIT_REVIEW.md` (three holes fixed, F1–F3); rate-limit review in `docs/SOCIAL.md` "Rate limits: the Phase 6 review" and `SECURITY.md`; version 0.6.17. No migration, no gameplay number changed.

### Phase 6 retrospective (ticket 6.10)
**Exit criterion (GDD §15 Phase 6): met.** *Endgame systems add meaningful choices without making older content or most item drops irrelevant.*

**The API run** (`phase6-exit-criteria.test.ts`, one clock derived from the wall clock, twelve accounts in an invite-only town). Levels 28–38 take days of farming, so heroes are seeded like the Phase 6 journeys (a level, the bosses behind them, a Legendary +10 kit, a Forge stock); every seeding is measured (`holdingsBaseline`) and the holdings replay holds from it on. Rare outcomes the run is about (a Prismatic and a Void drop, a Tyrant win for an Ember) come from the run's stored seed pinned to one game-core's replay shows producing them; everything else from the server's `crypto` seeds, asserting only what holds for every seed. Covered:
- **Admin tools (D.4/D.4b)** on a test account (cheats refused before the CLI marks it, then granted, previewed, fast-forwarded, removed, soft-deleted and restored; refused on a player; no email in any admin answer).
- **The Forgeward and the eras:** the town's first two projects (owner CLI) bring the Rekindling; ten givers each give exactly their 10 % first-day cap (6,000 gold, 100 ore, 40 shards: a larger offer is trimmed, a second gift `409 contribution_capped`), and the stage finishes with the tenth gift, not before; the test account is refused (`403 test_account`); the last two stages by the test-setup command (refused as production); the Forgeward Age, the era chain on record without a gap (Ashen Siege → Rekindling → Forgeward Age), the Forgeward banner for all ten.
- **Season 1 and the Harvest of Bones** scheduled in the admin panel (a player gets the 404).
- **The Ashfall Verge** opened and farmed by a level-28 hero in good Ashen Pass gear (the Warden in 1 Watch run on every loop); that hero finishes **the Harvest's whole track** (all four tasks, 50 tallies, the three keepsakes granted once each); **the collection book** (equip with a replayed key, locked and wrong-kind entries refused); at 36 in Verge gear **the Cinder Depths and the Forge Tyrant**: the hoard bound, the Ember spent on Tyrantforged Work at the bellows' price (2,400 gold), the crafted piece without a variant, the Tyrant's appearance earned and worn.
- **Prismatic and Void** from two Heroic runs: worn, upgraded and rerolled, each keeps its variant and binds; not tradeable under the default switches; both named in the Gear Score. **Crypt tier I** stores no modifier.
- **Item Awakening:** an Ember from a real Tyrant run, the awakening paid once (a replayed key changes nothing; 3 Embers, 2 Seals, gold and shards), the item locked (the merchant `409 item_locked`), the duel snapshot carrying it and bracket Power 3 above the same kit unawakened; with every switch on in the test, with eligible accounts and an old friendship, the offer refused only for the item (`item_awakened`); the shelf moves it to a second hero, still awakened; the test account refused trading (`test_account`); the switches back to the defaults.
- **40 rated duels in 30+:** four duellists in even kits, every list equal to the set matchmaking 4 predicts from the stored defences (bracket Power 3, the 30+ class scale, friends never), never the test account's defence (the test hero's own list is empty); the eleventh duel `409 no_duels_left`; each rating moves once per duel; nothing anyone owns changes.
- **The Harvest ends on its own** (a read after the end shows no event; the close once; three `event.reward`). **The season ends:** archived and awarded once, equal to game-core's `seasonAwards` (23 awards), the test account in neither; the arena champion's royal title colour granted once; the formula versions switch to Power 2 and PvE Progress 4 and the scheduler's sweep recomputes every hero.
- **Heroic** under the week's boss modifier, the last run across Monday (2 runs); the next week's modifier is another.
- **Valid:** every player hero's holdings (eleven heroes, the shelf's second hero included) and the shelf equal the audit log; `reconcileWithAudit` and the real `pnpm report:telemetry -- --reconcile` match in all 127 checks; telemetry counts the 40 rated duels, the 3 event rewards and the era changes exactly; every board row is at the current version and equals the hero's breakdown, the test hero on no board, the recompute check clean; the privacy guard found no other player's email, account id or hero id in any player response (staff routes are checked by their own suites).
- Looped 20× shuffled twice (the second time with the Cinder Depths and Heroic journeys), and once with `WF_CLOCK_SHIFT_DAYS=400`: green; 20–36 s a run.

**The browser run** (`tools/e2e/phase6-exit.mjs`, CI job `e2e-phase6`, three local runs 25–27 s, ~35 s with the server's start): the town in the Forgeward Age with the Harvest's banner; the map's Verge, Depths and Tyrant's Forge open; the Tavern's modifier equal to the Heroic door's; the Banked Fire (quote, before/after, confirm with "will be locked", the ☼ mark and the padlock, the glow still); a Tyrant's Forge run claimed; Prismatic and Void frames rendered and frozen under automation (two captures byte-identical, motion back only with `worldforge.sceneMotion=on`); the collection book's filters, an owned banner worn, locked entries with their source; a level-34 hunter barred at the Tyrant's door ("Reach level 36") and kept out of the animation gallery (and `404` from the event admin); the admin's Events tab and the gallery frozen until Play. Not in the browser: entering Heroic, mobile widths (the API run covers Heroic).

**The criterion in numbers** (game-core, the realistic player; `docs/BALANCE.md` "Phase 6 exit criterion"; class order warrior / mage / hunter / warlock):
- **Older content stays relevant:** the best Pass build (+5, item level 27, no Void) at 28 farms the Verge at 16.1 / 16.1 / 18.9 / 16.2 kills a minute (× 0.77–0.87 of the Pass) with no deaths at 28 or 34, for × 1.18–1.33 the XP and × 1.09–1.25 the gold of the Pass.
- **Older drops keep a use:** a Pass Legendary salvages to 44 gold, 8 ore and 3 shards, which Tyrantforged Work, tier-4 forging and the +10 path spend; Pass set pieces in a Depths kit cost × 0.971–0.987 (an all-Pass kit × 0.818–0.852); every Phase 1–5 material but Abbey silver has a repeatable sink; tiers I–III still drop the Seals, and every set in the best endgame builds drops from older tables.
- **Void vs Prismatic is a sidegrade:** Prismatic ÷ Void 0.970–1.010 at the Tyrant, 0.998–1.011 farming the Depths; each leads in 4 of 8 cases.
- **Awakening is worth having and never needed:** a whole awakened kit is 3.1–11.0 % faster at the Tyrant and 4.5–10.0 % at Heroic, a single piece under 4.9 %; unawakened built kits win 100 % at both.
- **The modifiers differ:** mean win-rate change for burning / warded / frenzied / unyielding / relentless: Heroic −2.4 / −7.1 / −7.8 / −7.7 / −10.5 points, Tyrant −7.1 / −6.7 / −6.6 / −6.1 / −9.1; the cost differs by class (Burning costs the warlock 2 points at the Tyrant and the hunter 14.5); Relentless is hardest on average, only 2.0–2.7 points ahead.
- **No new system needed:** plain Verge Legendaries +5 (no Prismatic, no awakening) win 86 / 76 / 75 / 92 % at the Tyrant and 85 / 72 / 70 / 91 % at Heroic; built kits (+5, or +10 Void) 100 %.

**What the exploit review found** (`docs/PHASE6_EXPLOIT_REVIEW.md`; each fixed with a test that failed first):
- **Medium: test-account power paid real players through the guild boss.** The only shared system test accounts could still reach: a minted hero's blows broke stages that paid every guild member. A test account's attempt is now `403 test_account` unless the whole guild is test accounts (under the guild lock; a real-PG race against a join).
- **Low (admin): deleting a hero mid-dungeon froze its account** (its unclaimed run was the account's one open run, and nobody could claim it). The soft delete now answers `409 hero_in_dungeon`.
- **Low: the profile showed the look of a hero whose name a moderator hid.** The palette now goes with the name (patch note 0.6.17).
- A sweep test over every Phase 6 route that names a hero (another account's hero or item `404`, nothing changed; every value write needs an `Idempotency-Key`; client-sent strengths, costs, modifiers, tiers and foreign ids `400`).

Checked and holding: awakening (refusals and held value before paying; races against sell, trade and the shelf), Tyrantforged Work, Heroic and the Tyrant (modifier stored at the start, no re-roll by retry), events (the window rule, each tier once), Forgeward caps and eras (test accounts refused), cosmetics (own unlocks only, display privacy), the admin tools' gates and the role re-read, reserved names and look-alike checks, the shared limiters; the animation gallery has nothing server-side.

**Accepted risks** (in the review): gold and materials minted with cheat tools on an admin's own normal account are real (only granted items are bound); switching a test account off releases what it was given; the test flag is read without a lock (CLI-only); the item preview has no test gate (the grant does); admin event writes take no key (the plan rules refuse a double); Tyrantforged Work turns an untradeable Ember into a tradeable-until-worn item (by design); a lost boss run can be retried at once (by design); cosmetic equips are not social writes; `name_too_similar` says a look-alike exists. Phase 2–5 and T.7 accepted risks still stand.

**Rate limits** (`docs/SOCIAL.md` "Rate limits: the Phase 6 review"): no value changed, no class added. Phase 6 added no limiter; its busiest screen (a Heroic run under way) sends about 38 requests and 37 actions a minute, 12 % of the action limit (37 % with three tabs); a Heroic replay is ~1.2 ms of CPU; each counted request is one upsert on 6.9's shared store (~1.1 ms, ≤ 0.27 ms more under load).

**What went well.** The Phase 5 habit held: every Phase 6 ticket left a journey step or a journey test, so the exit run is composition plus seeding, and the seeding is now measured instead of breaking the holdings replay. Pinning a run's stored seed to one game-core's replay predicts made the rare outcomes (Prismatic, Void, a Tyrant win) exact without loops. Data-driven content kept the endgame additive: no value at or below 28 moved (6.1, 6.2 curve pins), and boards moved by versions between seasons, which the exit run saw switch for real. The review found no value bug in awakening, the Forge, events, the Forgeward or cosmetics; the holes were at the edge between admin tooling and shared systems.

**Flakes and time bombs** (F.5, F.6): `main` broke once when the wall clock passed a hard-coded sanction expiry in the duel tests (fixed in #116; F.6 added the `WF_CLOCK_SHIFT_DAYS` guard, and the sweep found one more bomb, `playtest/stored-time.test.ts`); the Phase 3 browser run judged pack capacity on a tidied visit (#113, #114); the nightly Flake hunt caught a full-pack refusal in a crypt-entry race (an outcome 1 in 1,000, not a bug) and the API journey's craft before selling junk. This ticket's own: the Cinder Depths step assumed PvE Progress 2+ and would have failed inside a season under way (version 1; fixed), and the first exit loop drew 3 duellists instead of 4 once (the awakened weapon left on the shelf, drop-dependent kits; the duels now use even seeded kits). No flake on `main` since F.6.

**Decisions** (owner, Phase 6): Heroic as crypt tier IV with tier III the Legendary tier; tier I never takes a modifier; Prismatic after Void, never stacked; Awakening option (b) at × 1.1, account-bound, counting in duels, auto-locked (6.5b, 6.5c); test accounts cut off from boards, awards, matchmaking, trading and the town works (D.4; now the guild boss too, F1); the hunter's burst build kept, the Harvest kept with a longer next event, the Forgeward first-day cap a tenth, a Seal sink later (B.5b); production stays one instance (6.9).

**Risks carried into Phase 7 (desktop and mobile).**
- The browser runs and screenshots cover desktop widths; Phase 6 screens (the Banked Fire, the collection book, the Events tab, the Heroic door) have no mobile run yet, and the animations' cost on low-end phones is unmeasured.
- Awakening and the boards: the hunter's burst build is still ~11 % faster fully awakened (accepted); Relentless is the hardest modifier by a small margin (watch).
- Abbey silver has no sink once the Forgeward stands (the numbers' one gap; owner decision; 6.11 added the engraver and the exchange).
- Spare Gravewarden Seals pile up until 6.11 (done: the engraver and the exchange).
- Trading is still closed; its live telemetry, and awakened/Prismatic items' place in it, are unseen with real players.
- Playtest feedback has still not arrived; Phase 6 was tuned from simulations (B.5).
- One API instance in production (6.9 made two safe; the switch is the owner's).

**Owner's open items:**
- **Choose an SMTP provider** and set it in `deploy/.env` (`docs/DEPLOY.md` "Email"), and **update the privacy policy** (the mail provider as a processor, the public leaderboards). Still open from Phase 5.
- **Schedule Season 1** (admin panel → Seasons, or `deploy/admin.sh seasons`); the Phase 6 board formulas (Power 2, PvE Progress 4) switch in at its end.
- **Open trading in the documented launch order** (`docs/TRADING.md`), only after mail works; Prismatic and awakened items stay as decided.
- **Add staff names in the admin panel's Names tab** (the reserved-names store, 6.9), so look-alikes of the real staff are refused.
- **Schedule the first event** (the Harvest of Bones, admin panel → Events).
- **Send playtest feedback** (`docs/PLAYTEST_FEEDBACK.md`).
- **Schedule 6.11, the Seal sink**, and decide whether Abbey silver gets a sink too.
- Decide the accepted risks above if they should differ (cheat-minted value on an admin's own account, the test flag released on switch-off).

### 6.11 Gravewarden Seal & Abbey silver sink (small) — `done (PR #137)`
Owner decision on B.5 (2026-11-11, `docs/BALANCE.md` "B.5", item 8): a dedicated player ends a full awakened kit with 15–17 spare Gravewarden Seals and nothing to spend them on. Placeholder; not built.
- Suggested scope: a cosmetic (a collection-book entry, banner or crest style) or a modest Forge recipe priced in Seals. **No new power** (no stats, no better odds, nothing that counts in duels or boards).
- Data-driven like the other sinks; audited and reconciled; test accounts as elsewhere.
- Re-measure the Seal flow with `tools/balance/endgame.ts` so the sink doesn't starve awakening.
- **Owner decision (2026-11-11, 6.10 question 1):** fold in **Abbey silver**, which has no repeatable sink once the Forgeward stands (`docs/BALANCE.md` "Phase 6 exit criterion"). Same rules: no new power.
- Done: two sinks, no new power. **The Engraver** at the Forge (repeatable): words from a fixed list of twelve (no free text) cut into a worn or packed item, **seal-wax for 2 Gravewarden's Seals** or **silver inlay for 15 Abbey silver**, shown in the tooltip, read by no rule, doesn't bind; every engraving pays, the same one twice is refused (`POST …/forge/engrave`, a Forge action; migration `0043_item_engraving`, additive). **The Seal and Silver Counter** (once per account): five new collection-book entries that reuse A.13's art with a CSS tint (Seal-wax and Abbey-silver title colours, 3 Seals / 25 silver; Silvered seal banner, 2 Seals + 20 silver; Abbey-silver crest, 30 silver; Wax-sealed crest, 4 Seals), granted by `grantCosmeticsTx` before paying in one transaction (exactly once per account even when two heroes race; `409 already_owned`). Both: Idempotency-Key, value on hold after a trade not spendable, audited (`forge.engrave`, `cosmetic.exchange`), telemetry (`forge` engrave, `cosmetic.exchange`, `material.out forge_engrave | cosmetic_exchange`), reconciled; test accounts allowed (cosmetics rank nothing), their telemetry in the test rollups (D.4). Data in game-core `cosmetics/exchange.ts`. **The flow** (`tools/balance/endgame.ts sinks`, game-core `balance/seal-flow.ts`, the realistic dedicated player, 56 days): the full awakened kit on the same day with and without the sinks (24–27 days; the sinks take only Seals above a two-per-piece reserve, which the Forge warns about), spare Seals at the kit 15–17 → 1–4, 15–17 Seals and 150 silver to the sinks over the season; Abbey silver 195–219 gathered from 17 to 23. Every older material now has a repeatable sink (the Phase 6 exit guard updated). Gear Score, Power, PvE Progress and the duel rules unchanged (no version). Web: the Forge's Engraver and Counter panels (all states, desktop and mobile), the engraving line in tooltips, "Exchange" in the collection book. Tests: game-core `cosmetics.test.ts`, `seal-flow.test.ts`, `phase6-exit-criterion.test.ts`; server `forge/seal-sinks.test.ts`, `seal-sinks.pg.test.ts`, the journey's `playSealSinkStep`; web `seal-sinks.test.tsx`. Version 0.6.19 (after F.7's 0.6.18). `docs/ECONOMY.md` "Seal and silver sinks", `BALANCE.md` "6.11", `COSMETICS.md`, `AWAKENING.md`, `TELEMETRY.md`, `DATA_MODEL.md`.

## Phase 7 — Desktop release & mobile port
**Status: deferred** (tickets written 2026-11-11; owner decision the same day: Phase 8 comes first, Phase 7 is revisited later).

GDD §2, §15 Phase 7; `docs/TECH_STACK.md` (desktop: Tauri; mobile: responsive web first, then Capacitor). **Exit (GDD):** desktop and mobile clients use the same authoritative backend and provide a consistent progression experience.

**Ground rules for Phase 7** (all earlier rules still apply, including `CLAUDE.md` "Writing tests that don't flake", the patch-notes and the screenshots rules)
- **One client, one backend.** Every platform runs the same web build against the same API. No platform-only gameplay, no platform-only prices, no client-side authority. Releases are 0.7.x.
- **Mobile is a first-class layout, not a shrunk desktop.** Every screen works at 360–430 px wide, by touch alone, with readable text and targets of at least 44 px. Hover-only information (tooltips, item compare) gets a tap or long-press equivalent.
- **Phones are slow.** Every screen meets a documented performance budget on a mid-range phone profile (CPU throttling in CI); animations stay cheap and honour reduced motion.
- **Wrappers stay thin.** The desktop app loads the live site in a native window (always the current version, no API or CORS changes) and adds only window, update and link handling. Store apps, if ever, wrap the same build.
- **No new tracking.** Wrappers add no analytics, ads or third-party SDKs; the privacy policy stays accurate.
- **Signing and stores cost money and accounts.** Nothing that needs the owner's paid developer accounts or certificates is assumed; those steps are documented and gated on the owner.

**Defaults the owner can override** (recorded in the GDD when the ticket lands):
- **Desktop:** a Tauri **thin wrapper** that loads `https://play.worldforg.ing`, built for **Windows and Linux** by GitHub Actions and published as GitHub Releases. **macOS** only once the owner has an Apple Developer account, since unsigned apps are blocked there. Windows builds start **unsigned**: testers see a SmartScreen warning. A code-signing certificate is the owner's decision.
- **Desktop updates:** the game itself updates by itself, because it is the live site. The wrapper updates through Tauri's signed updater from GitHub Releases. The updater key is generated by the owner and never committed.
- **Mobile:** **responsive web plus an installable PWA** first: home-screen icon, an app-shell cache, an offline screen. **Store apps (Capacitor) only on the owner's decision** (Google Play $25 once, Apple $99 a year).
- **Push notifications:** not in Phase 7 (they would need a push service and consent flows). Revisit later.

**Order:** 7.1 → 7.2 → 7.3 and A.16 (parallel) → 7.4 → 7.5 → (7.6 only on the owner's decision) → 7.7.

### 7.1 Mobile UX audit & touch layouts (vertical) — `todo`
GDD §2, §3.2. Read `docs/DESIGN_SYSTEM.md`, every screen under `apps/web/src/screens/`.
- An audit of every screen at 360, 390 and 430 px, and at tablet width (768 px), in portrait and landscape. The findings go into `docs/MOBILE.md` as a table: screen, problem, fix.
- Fix them all:
  - touch targets of at least 44 px;
  - no horizontal scroll;
  - readable type;
  - a bottom or compact navigation for the shell;
  - modals and full-view confirms that fit the screen;
  - tooltips and item compare on tap or long-press;
  - drag-free inventory, Forge, Warehouse, shelf and trading flows;
  - the admin panel usable on a phone (secondary priority).
- Make sure the safe-area insets (notches) and the on-screen keyboard don't cover inputs.
- Tests:
  - Playwright device emulation for iPhone SE, iPhone 15, Pixel 7 and a 10" tablet, over the key flows;
  - no horizontal overflow on any route (a test that fails if a new screen overflows);
  - screenshots on the `screenshots` branch.

### 7.2 Mobile performance & device matrix — `todo`
Read the A.14/A.12b animation code, `apps/web` build output, F.4's reload seam.
- Performance budgets per route on a throttled mid-range phone profile, asserted in CI with Lighthouse or Playwright tracing. They cover:
  - first load (JS size, time to interactive);
  - the area scene's frame cost with animations on;
  - memory over a 10-minute session.
- **Code-split** the routes (lazy screens; the F.4 failed-chunk reload offer already exists) and trim the first-load bundle.
- Measure the animation cost on the phone profile (Phase 6 risk). If it's over budget, lower the work on mobile, e.g. fewer animated foes or a slower beat, without losing the look.
- A device matrix job in CI (emulated), plus a documented manual checklist for real devices (the owner's phone or phones).

### 7.3 Installable PWA & offline shell (vertical) — `todo`
- A web app manifest (name, icons from A.16, theme colours, display standalone, orientation) and the iOS meta tags.
- A **service worker** that caches the app shell and static assets per build, versioned with `GAME_VERSION`. The API is never cached. It integrates with F.4: a new version gives the reload offer, and an old cache can never serve a mismatched API.
- An **offline screen** in the game's voice when the server can't be reached; offline progress keeps working on the server as always.
- An "Install Worldforge" hint where the browser supports it (not nagging, dismissible).
- Tests: the service worker update path (old to new version), no API caching, the offline screen, and an installability check (Lighthouse PWA audit).

### A.16 App icons & splash art — `todo`
- An app icon in the game's style (a forge-anvil sigil or the Worldforge mark).
- Every size needed for the PWA (192/512, maskable), the iOS apple-touch-icon, the desktop app icons (Windows `.ico`, Linux PNG set, the macOS `.icns` for later), plus a splash or loading image.
- Budget: one or two PixelLab jobs plus code cleanup.
- **Acceptance:** a contact sheet of every size on light and dark backgrounds.

### 7.4 Desktop app (Tauri thin wrapper) — `todo`
Read `docs/TECH_STACK.md` "Desktop: Tauri", `docs/DEPLOY.md`, `SECURITY.md`.
- A Tauri app in `apps/desktop` that opens `https://play.worldforg.ing` in a native window. It handles:
  - remembered window size and position, and a minimum size;
  - a single instance;
  - external links (legal pages, mail) opening in the system browser;
  - an in-world offline/error page when the site is unreachable;
  - an app menu with reload, zoom and "Open in browser".
- **No Node or Tauri APIs are exposed to the remote page:** a strict CSP and capability allowlist with an empty command list, and navigation locked to the game's origin.
- **Cookies and session:** the remote origin uses its normal secure cookies inside the webview. Verify login, "log out other devices", and the 5.7 flows.
- **Builds** for Windows (`.msi`/NSIS) and Linux (AppImage/`.deb`) in a GitHub Actions workflow on tags, published to GitHub Releases.
  - macOS is wired but disabled until the owner provides an Apple account.
  - Signing secrets come only from GitHub environment secrets (never in the repo), and the steps for the owner are documented.
- **Wrapper auto-update** through Tauri's signed updater from GitHub Releases.
- **Tests:**
  - the wrapper's navigation lock and external-link handling;
  - a CI build smoke test, plus launching the built app headless where feasible;
  - a documented manual install, update and uninstall checklist.
- `docs/DESKTOP.md` with how the owner releases a new wrapper version.

### 7.5 Cross-platform sessions & progression consistency (vertical) — `todo`
Read `docs/API_CONVENTIONS.md` (auth and sessions), 5.7 as built, `docs/FARMING.md` (offline settlement).
- **A device list on the account screen:** active sessions with a coarse device or browser label (derived from the user agent, nothing else stored), last seen, and "sign out this device"; "log out other devices" stays.
- **The same account on several clients at once** (browser + desktop + phone): settlements, Forge actions, trades, duels and the shelf behave correctly from any mix of clients. Everything is already server-authoritative, so prove it:
  - a multi-client e2e (two or three browser contexts on one account) acting in parallel;
  - reconciled with the audit log;
  - no lost or duplicated value;
  - each client shows the same state after a refresh.
- The F.4 reload hint and the PWA update work identically in the desktop wrapper and the installed PWA.

### 7.6 Store apps (Capacitor), only on the owner's decision — `todo` (gated)
- Android first (Google Play), iOS later (Apple Developer Program). Each needs a paid owner account and store listings (privacy labels, screenshots, age rating).
- Capacitor wraps the same build. Native glue is limited to the status bar, splash, back button and safe areas. No in-app purchases.
- Kept as a placeholder until the owner decides; the PWA covers mobile until then.

### 7.7 Phase 7 hardening & exit — `todo`
GDD §15 Phase 7 exit, §16.3.
- An exit run proving a consistent progression across the web, the installed PWA (emulated) and the desktop wrapper (where CI can run it): the same account, the same results, reconciled.
- The mobile and desktop browser runs in CI.
- A security review of the wrapper (navigation lock, capabilities, updater signing), the service worker and the PWA cache.
- A Phase 7 retrospective in this file.

## Phase 8 — Live game: new content, events & quality of life
**Status: planned** (tickets written 2026-11-11 by the owner's request; Phase 7 is deferred until later). The GDD plans only to Phase 7, so this phase is the owner's extension. It grows the live game on the browser client.

**Exit:** the live town has a new endgame region beyond level 40 that keeps Phase 6 content relevant, a self-running calendar of events, better everyday comfort, and a clear "going live" checklist the owner has worked through. Everything is reconciled, fair and free of pay-to-win, as in every earlier phase.

**Ground rules for Phase 8** (all earlier rules still apply, including `CLAUDE.md` "Writing tests that don't flake", the patch-notes and the screenshots rules)
- **Phase 8 releases are 0.8.x.** The first Phase 8 PR players can see bumps to `0.8.0`.
- **Phase 6's rules carry over:**
  - older content stays relevant;
  - boards move by versions between seasons;
  - events and cosmetics never grant power;
  - PvP tuning never changes a PvE number;
  - every number change has before/after tables.
- **Live data first.** Once the town is live (8.6), balance work reads real telemetry and the owner's playtest notes before simulations.

**Defaults the owner can override:**
- **Region III,** working name **"The Hollow Reach"**: levels **40–52** in two areas plus a region boss, unlocked after the Forge Tyrant and through a community project. There is still no hard level cap; the XP soft cap moves from about 48 to about 55.
- **Events:** a second, **longer** event (several weeks, a deeper reward track, per the B.5 decision), and an **automatic event calendar** the owner can pause or override.
- **Guilds:** a guild **season ranking** (cosmetic honours only) and guild halls with cosmetic upgrades; no guild-vs-guild combat.
- **Quality of life:** the owner's playtest notes first; otherwise inventory search and sorting, loot-filter presets, a notification inbox, and claiming several Tavern rewards at once.

**Order** (one or two sessions at a time):
1. 8.6 (the going-live checklist, so the town can open while content is built)
2. 8.1 and A.17 (parallel)
3. 8.2
4. 8.3
5. 8.4
6. 8.5
7. B.6
8. 8.7

### 8.1 Region III, part 1: the Hollow Reach, levels 40–46 (vertical) — `done (PR #141)`
Like 6.1. Read `docs/WORLD.md`, `docs/COMBAT.md`, `docs/LOOT.md`, `docs/LEADERBOARDS.md`, `docs/PVP.md`, 6.1/6.2 as built.
- The first area at levels 40–46:
  - new enemies (art from A.17);
  - a tier-5 loot table, with item levels extending the curve and no change at or below 40 (pins);
  - an unlock after the Forge Tyrant, with a world-flag seam for 8.2's community gate. Never take access away from live content.
- New Power, PvE Progress and Gear Score versions as needed, switched between seasons.
- PvP reference kits for the new top end, with the 30+ bands kept (B.5's duel-Power matchmaking).
- A level-40 hero in today's best gear farms it profitably, and Phase 6 drops keep their uses.
- Patch notes `0.8.0`.
- Done: the Pale Marches (`paleMarches`, region the Hollow Reach, 40–46; unlock level 40 + the Forge Tyrant, `forgeTyrantDefeated`; no world flag: 8.2's gate is for later places). Foes `hollowKnight`/`reachStalker`/`paleChoir`/`huskTitan` on A.17's names (pale stand-ins until its art lands, `HOLLOW_STAND_INS`), each with one fight trait (`EnemyTraits`: armour pierce, crit evasion, skill guard, crit guard; build-time numbers, no draws). Ten tier-5 bases from item level 41, table 41–47 with gold × 3.9, affix tier 6 from 43 (never below 42). No value ≤ 40 moved (`curve-pins-8-1.test.ts`); soft cap ~53–54. Today's best gear (Depths/Heroic Legendaries +10, awakened or not, best Depths builds) farms it with no deaths at 40, XP × 1.07–1.14, gold × 1.12–1.22 the Depths'. Power 3 (+ trials 42, 46) and PvE Progress 5 (21 milestones), between seasons; no Gear Score version. PvP unchanged (rules 2, bracket Power 3, matchmaking 4); 30+ to 46 measures 3.7 / 1.2 %. No migration. Version 0.8.0. Details: `docs/WORLD.md`, `COMBAT.md` "The Hollow Reach", `LOOT.md`, `LEADERBOARDS.md`, `PVP.md`, `BALANCE.md`.

### A.17 Hollow Reach art — `todo`
Like A.11. Two area backdrops, 4–6 enemies, a region boss, and 8-frame attack sheets for the common enemies (A.14b's pipeline). Tier-5 item icons like A.15. Budget: about 5–7 PixelLab jobs plus one regeneration, reporting the credit drop. **Acceptance:** contact sheets.

### 8.2 Region III, part 2: levels 46–52, the region boss & a community gate (vertical) — `todo`
Like 6.2 and 6.7.
- The second area and the region boss dungeon:
  - a bound hoard;
  - a boss material with a real sink (e.g. a next awakening step or a Forge recipe; no runaway power);
  - weekly modifiers apply (6.3).
- A community project that opens the region's later parts from day one of its release. Unlike 6.7, it may gate this *new* content, because nothing live is taken away.
- A new era.
- PvE Progress milestones.
- Heroic and other Phase 6 content stay relevant (the exit-criterion test extended).

### 8.3 A longer event & the event calendar (vertical) — `todo`
Read `docs/EVENTS.md` (incl. B.5b's "longer chase" guidance).
- A second event definition: **several weeks**, a deeper reward track (5–7 tiers, new cosmetics reusing existing art plus small code treatments), and a world modifier different from Harvest of Bones.
- An **automatic event calendar:** events rotate on a schedule the owner sets in the admin panel (gaps between events, order, pause, skip, override). It respects seasons and never overlaps.
- Tests:
  - calendar boundaries with an injected clock;
  - no overlaps;
  - pause and resume;
  - rewards exactly once;
  - invariance.

### 8.4 Guild seasons & guild halls (vertical) — `todo`
Read `docs/SOCIAL.md` (guilds), `docs/GUILD_BOSS.md`, `docs/LEADERBOARDS.md` (seasons, honours), `docs/COSMETICS.md`.
- **A guild season ranking:** guild boss progress, community contributions and member PvE Progress, combined in a published, versioned formula. Archived with the 5.3 seasons, with cosmetic guild honours (crest frames and banners via 6.8).
- **Guild halls:** a guild page with cosmetic upgrades bought from a shared guild treasury the members fund. Cosmetic only: no stats, no drop odds. Audited and reconciled, with B.3-style anti-monopoly caps.
- Test accounts are excluded from rankings (D.4).

### 8.5 Quality-of-life pass (vertical) — `todo`
**The owner's playtest notes come first** (`docs/PLAYTEST_FEEDBACK.md`). Otherwise:
- inventory search, sorting and filters;
- loot-filter presets (save, load, share as a code);
- a notification inbox for drops, trades, duels, events and seasons, with read and unread states;
- claiming several Tavern rewards at once;
- any friction found in the 6.10 browser runs.

Mobile-friendly where it's cheap, but the full mobile pass stays in Phase 7.

### 8.6 Going-live checklist & admin readiness dashboard — `done (PR #136)`
A **readiness panel** in the admin panel showing what the live town still needs, each item with a status and a link to the doc:
- **email (SMTP):** configured, with a test letter sent to an address the owner types (never stored);
- **privacy policy:** a reminder listing the features that must be mentioned (leaderboards, emails, the provider);
- **Season 1:** scheduled or not;
- **trading:** the launch-order step the town is at;
- **the first event:** scheduled or not;
- **reserved staff names:** added or not;
- **backups:** the last backup time from `backup.sh`;
- **CI and deploy:** status.

Plus `docs/GOING_LIVE.md`, a step-by-step checklist for the owner. **No secrets are shown or stored,** and the panel only reads state. This ticket goes first, so the town can open while content is built.

### B.6 Balance pass: live data — `todo`
- The first pass driven by **real telemetry** from the live town, plus the owner's playtest notes.
- The trading telemetry once trading is open (T.7's 10 % Legendary alarm, etc.).
- Re-check every Phase 6 and 8 band with real players.
- Before/after tables; data-only changes where possible.

### 8.7 Phase 8 hardening & exit — `todo`
Like 6.10:
- an exit run over the new region, boss, events calendar, guild seasons and the QoL features, reconciled;
- a browser run in CI;
- an exploit review (`docs/PHASE8_EXPLOIT_REVIEW.md`) and a rate-limit review;
- the Phase 8 retrospective.

## Deployment

### D.1 Production deployment — `done (PR #52)`
Goal: the owner runs Worldforge publicly on their own VPS (Debian 13, 2 vCPU, 4 GB RAM, ~40 GB disk) under their own domain, without exposing the VPS's IP (owner decision: Cloudflare Tunnel, domain at Cloudflare). Same-origin (static web + `/api` on one domain), single API instance. Read `docs/TECH_STACK.md` (hosting, config, migrations, cookies) and `CLAUDE.md`.
- `deploy/`: multi-stage `Dockerfile` (server: production build, prod deps only, non-root, `node dist/index.js`; web: the built client baked into a Caddy image); `docker-compose.yml` with `cloudflared` (Cloudflare Tunnel: Cloudflare terminates HTTPS, no public web port), Caddy (security headers, compression, cache rules, `/api` reverse proxy, player IP from `CF-Connecting-IP`), the server (health check, restart policy, `TRUST_PROXY`, secure cookies) and PostgreSQL 16 (named volume, no host port, tuned for 4 GB). Migrations run as a one-shot service before the server starts; the server never migrates on startup. The e2e/playtest servers stay out of the production build.
- `deploy/.env.example` documenting every variable; secrets only in the untracked `deploy/.env`.
- Idempotent scripts: `deploy.sh` (pull → build → backup → migrate → restart → health check → roll back the images on failure), `backup.sh` (compressed `pg_dump`, 14 daily + 8 weekly, systemd timer), `restore.sh` (confirm prompt), `admin.sh` (account roles inside the server container).
- Optional GitHub Actions deploy over SSH after CI passes on `main`, off unless a repo variable enables it; secrets documented, none added. A cheap CI check that builds the images on PRs touching `deploy/`.
- `docs/DEPLOY.md`: step-by-step for the owner on Debian 13 (domain and tunnel at Cloudflare, deploy user, SSH, ufw with only SSH open, Docker from Docker's repo, first start, admin, backups and restore, updates, logs, monitoring, troubleshooting, keeping the IP private) and a "before going public" checklist.

### D.2 Invite-only registration & legal pages — `done (PR #53)`
Goal: the live site can be limited to invited players and has the legally required pages. Read `CLAUDE.md`, `docs/DEPLOY.md`, `docs/SOCIAL.md`, `apps/server/src/auth/`.
- `REGISTRATION_MODE=open|invite|closed` (server config; `open` by default for dev, tests, playtest and e2e; `invite` in `deploy/.env.example`). Login, accounts and sessions are unaffected.
- Invite codes: random, stored hashed, single- or multi-use with expiry, created/listed/revoked only by admins (`pnpm admin:invite`, `deploy/admin.sh invite …`), redeemed atomically at registration (real-Postgres race test), audited without exposing codes. Register UI: invite field, `?invite=CODE` links, closed message, public `GET /api/config`.
- Impressum and Datenschutzerklärung pages from owner-editable Markdown (`content/legal/` templates, overridden by the mounted `deploy/legal/` on the VPS), linked in every footer, consent line at registration. Templates are placeholders, not legal advice.

### D.3 Admin panel — `done (PR #58)`
Goal: the owner administers the live site from the browser instead of the VPS shell, without widening what a stolen admin session could do. Read `CLAUDE.md`, `docs/SOCIAL.md`, `docs/TELEMETRY.md`, `docs/DEPLOY.md`, `docs/API_CONVENTIONS.md`.
- `#/admin` (footer link for admins only) on `/api/admin/*`, which answers the not-found `404` to everyone but admins, before body validation, inside the per-account rate limits. No migration.
- **Invites:** create (uses, expiry, note) with the code and the `#/register?invite=CODE` link shown once with copy buttons; list with status, uses, expiry, note, creator and the accounts each code created (from the audit `inviteId`); revoke. Reuses D.2's invite module (the CLI is unchanged).
- **Telemetry:** 3.8's report as a page (the same builder and sections as `pnpm report:telemetry`), date window, reconcile behind a stricter limit.
- **Players:** search by name or handle → account age, role, registration invite, heroes, sanctions, reports, links into the moderator queue's cases. No emails.
- **Server status:** git sha and build time (baked into the image by `deploy.sh`), uptime, DB, registration mode, counts (active 24 h / 7 d from presence, counts only), pending migrations.
- **Roles:** read-only list; granting stays CLI-only, said in the UI.
- Every admin request audited (no codes, emails, IPs or search text); permission-matrix and invite API tests; screenshots in `docs/screenshots/deploy/admin-*`.

### D.4 Admin testing & support tools — `done (PR #115)`
Goal (owner request): admin features for testing and support, like giving and removing items and deleting heroes, without widening what a stolen admin session could do. Read `CLAUDE.md`, `docs/DEPLOY.md`, `docs/SOCIAL.md`, `SECURITY.md`, `docs/PHASE5_EXPLOIT_REVIEW.md`, `docs/TRADING.md`, `docs/LEADERBOARDS.md`, `docs/PVP.md`, `docs/TELEMETRY.md`, `docs/WAREHOUSE.md`, `docs/ECONOMY.md`, `apps/server/src/admin/`.
- **Admin-only** like D.3 (`404` for everyone else, the role re-read in every write's transaction, roles only by the CLI; no tool changes a role). **Everything audited**: an `admin.*` row on the target account with who, what, before/after and a required reason; every write needs an `Idempotency-Key` and takes the gameplay lock order (T.5/T.6). Admin grants and removals are their own telemetry sources, so `reconcileWithAudit` still balances.
- **Test accounts:** `accounts.is_test`, set only by `deploy/admin.sh test-account <handle> on|off`. Hidden from boards and season awards, never offered in matchmaking, can't trade, out of the telemetry balance report. **Cheat tools** (grant items, gold, materials, XP, set level, progress, professions, daily resets, quests, fast-forward) work only on test accounts or the admin's own account (warning: public boards); **support tools** (remove items, refunds, delete and restore heroes, rename, forced logout, login lock) on any account.
- **Admin-granted items** come from game-core's generator, pass `validateItem`, are source `admin`, account-bound, never tradeable, with an `item.provenance` row; a preview shows the exact item first.
- **Hero deletion** is a soft delete with a 14-day restore window (hidden and frozen; T.7's shelf rehome; T.5's offer voids with escrow back; arena defence withdrawn; board rows removed; guild roles untouched because guilds are per account), a restore that brings back what can come back, and a CLI-only `purge` that keeps heroes trade history names.
- **Tools:** player inspector (no email; "verified yes/no"), items (grant with preview, remove from pack/gear/Warehouse/shelf; held and escrowed refused), currencies (grant/refund/remove, never below 0 or into held value; XP, level), hero management, progress tools, session tools, world tools (flags with an every-player warning, scheduler state), and a read-only "view as player".
- Migration `0036_admin_tools` (additive). Tests: `admin/tools.test.ts` (permission matrix, cheat gate, audit rows, idempotency, reconcile, test accounts off boards/archive/matchmaking/trading, soft delete → restore → purge, the no-email guard, the soft-delete read guard), real PG `admin/tools.pg.test.ts` (deletion vs accept, deletion vs shelf deposit, grant vs accept, removal vs sell), journey `e2e/admin-tools-journey.test.ts`. Admin-only, so no patch note.

### D.4b Admin progress tools grant milestone cosmetics instantly — `done (PR #129)`
Owner request: a cosmetic or deed that an admin progress tool's write earns arrives at once, not at the hero's next level-up or claim (e.g. the Gravewarden, Ashen Warden or Forge Tyrant marked defeated, crypt tier IV cleared, level 40). Read `docs/COSMETICS.md`, `docs/DEPLOY.md` (admin tools), `apps/server/src/admin/`.
- After each progress write (set progress, set level, grant XP, grant an item) the tool runs the gameplay paths' `refreshAchievements` (achievements, their deed cosmetics, the milestone cosmetics) in its own transaction: exactly once, audited with the normal source; the `admin.*` row names what it triggered (`earned`). D.4's cheat gate unchanged. Removals (a boss flag cleared, a lower level) take nothing back (6.8).
- Tests: each tool grants at once and exactly once (repeat, double submit with one key), the test-account gate, reconciliation. No migration, no patch note (admin-only).

## Art tickets (run alongside the phases)

### A.1 Class portraits — `done (PR #14)`
GDD: §3.1, §5.1–5.2. Read `docs/ASSET_GUIDELINES.md` and `CLAUDE.md` (Art pipeline).
- Generate full-body portraits for **Mage, Hunter, Warlock** at 128×128 with transparent background, matching the existing warrior (`apps/web/public/assets/characters/warrior.png`): same pixel scale, three-quarter front view, muted desaturated dark-fantasy palette, weathered gear, readable silhouette. Pass the warrior as `style_image` to `/generate-image-v2` so the style matches. Class identity: Mage = elemental/arcane robes and staff; Hunter = leather and hood, bow; Warlock = dark robes, shadow/soul motifs, skull or grimoire.
- Budget: one job per class (4 variants each), at most one regeneration in total. Keep raw results under `art/source/pixellab/`.
- Curate into `apps/web/public/assets/characters/{mage,hunter,warlock}.png`, update `manifest.json`, and make the web app pick the portrait by class wherever the warrior is shown for every class now (character select, creation preview, character screen). Remove the "every class wears the warrior's portrait" note.
- Re-take the character select/creation screenshots.
**Acceptance:** checks pass; a contact sheet of all four classes side by side in the PR description.

### A.2 Hub, world map & area backdrops — `done (PR #22)`
GDD: §3.1, §3.3, §4.2, §4.3. Read `docs/ASSET_GUIDELINES.md`. Match `apps/web/public/assets/areas/abandoned-fields.png` (pass it as `style_image`).
- **Hub:** an illustrated frontier town of Graumark, side view or slight top-down, 384×216, with clearly separated building silhouettes: forge, merchant stall, tavern, guild hall, warehouse, a shrine, and a map table or signpost. Record the building hotspot rectangles (in image pixels) in the manifest for 2.2.
- **World map:** a Graumark map, 384×216, aged parchment or a dark painted map in the same palette, with the five areas and the crypt as recognisable places. Record the area marker positions in the manifest.
- **Area backdrops**, 384×216, one per area, from the content contract in Phase 2: Crowwood (dark crow-infested forest, bandit camp), Old Burial Grounds (graves, crooked headstones, mist), Blackwater (black marsh, dead trees, cursed water), Sunken Abbey (half-sunken ruined abbey, flooded nave), Nameless Crypt (crypt interior, torchlight, bone niches).
- Budget: one job per image (backdrop-size jobs return a single image); at most 2 regenerations in total. Raw results in `art/source/pixellab/`, curated into `apps/web/public/assets/{hub,map,areas}/`, manifest updated.
**Acceptance:** one contact sheet of all images in the PR; they look like one world with the Abandoned Fields.

### A.3 Enemies & the Gravewarden — `done (PR #21)`
GDD: §3.1, §4.3. Match the existing enemies (64×64, side view, transparent; `apps/web/public/assets/enemies/`), passing one as `style_image`.
- Enemies (ids from the content contract): `banditCutthroat`, `corruptedCrow`, `risenSkeleton`, `graveCrawler`, `drownedThrall`, `bogHorror`, `fallenKnight`, `abbeyWraith`, `cryptGhoul`, `boneAcolyte`.
- Boss `gravewarden`: 128×128, an imposing armoured undead warden of the crypt (keys, lantern or great shield), clearly bigger and more ornate than normal enemies.
- Budget: up to 2–3 enemies per 64px job (16 variants each), so about 4–5 jobs plus one boss job; at most 2 regenerations. Raw results in `art/source/pixellab/`, curated into `apps/web/public/assets/enemies/` with kebab-case names of the ids, manifest updated.
**Acceptance:** a contact sheet with all new enemies next to the three existing ones and the boss in the PR.

### A.4 Material & tier-2/3 item icons — `done (PR #24)`
GDD: §3.1, §7. Needs 2.1 merged (it defines the new item bases). Match the existing 32×32 item icons (`apps/web/public/assets/items/`).
- Material icons: `timber`, `ashwort`, `rawHide`, `ironOre`, `soulShard`, `abbeySilver`, `gravewardenSeal`.
- Icons for the new item bases from 2.1 (use one 32px job for gear: 64 variants for 10 generations; one more for materials).
- Switch the new bases from their placeholder icons to the new ones; update the manifest.
**Acceptance:** a contact sheet of all new icons next to the existing ones in the PR.

### A.5 Boss-unique item icons — `done (PR #34)`
GDD: §3.1, §7. Follow-up from ticket 2.8. The three Gravewarden uniques borrow existing icons (`packages/game-core/src/items/bases.ts`): Gravewarden’s Cowl uses `item.horned-helm`, Seal of the Nameless uses `item.grave-gold-ring`, Warden’s Bone Chain uses `item.bone-amulet`. They should look unique.
- One 32px job (matching `apps/web/public/assets/items/`, an existing icon as `style_image`) for the three icons; switch the bases and the manifest.
**Acceptance:** a contact sheet of the three next to the icons they replace.

### A.6 Legendary, Mythic & Set item icons — `done (PR #39)`
GDD: §3.1, §7. Needs 3.2 and 3.3 merged (they define the named items). Match the 32×32 item icons (`docs/ASSET_GUIDELINES.md`).
- Icons for the named Mythic items and every set piece (about 20–25), visibly more ornate than tier-3 gear but in the same palette. Legendary items (non-named) keep their base icons; their frame treatment comes from 3.2.
- Budget: one or two 32px jobs (64 variants each); at most one regeneration. Switch the items from placeholder icons and update the manifest and `assets.ts` (they must match, in order).
**Acceptance:** a contact sheet next to tier-3 gear in the PR.

### A.7 The Ashen Pass: backdrop, enemies & boss — `done (PR #57)`
GDD: §3.1, §4.3. Needs 4.6 (the region's content ids are fixed with its project). Match the existing backdrops (384×216, pass `apps/web/public/assets/areas/sunken-abbey.png` as `style_image`) and enemies (64×64, side view; the Gravewarden for the boss at 128×128).
- One area backdrop (a burnt mountain pass, ash drifts, ruined watchtowers), 3–4 enemies, one boss.
- Budget: one backdrop job, two enemy jobs, one boss job; at most 2 regenerations. Raw results in `art/source/pixellab/`, curated into `apps/web/public/assets/`, manifest and `assets.ts` updated (in order).
- **Fixed ids:** area `ashenPass` (levels 24–28); enemies `ashWraith`, `cinderHound`, `pyreCultist`, `emberGolem`; boss `ashenWarden` (128×128). Art ids `area.ashen-pass`, `enemy.ash-wraith`, `enemy.cinder-hound`, `enemy.pyre-cultist`, `enemy.ember-golem`, `enemy.ashen-warden`.
**Acceptance:** a contact sheet next to the Abbey art in the PR.

### A.8 Achievement & guild heraldry icons — `done (PR #65)`
GDD: §3.1, §10.1. Needs 4.2 (achievement ids) and 4.4 (guild emblem choices). Match the 32×32 item icons.
- Icons for the achievements and a small set of guild emblems (about 12) players can choose from (no uploads: no user images in Phase 4).
- Budget: one or two 32px jobs; at most one regeneration. Manifest and `assets.ts` updated.
**Acceptance:** a contact sheet in the PR.

### A.9 Community project achievement icons — `done (PR #77)`
GDD: §3.1, §10.1. Follow-up from 4.6/4.11: `warehouseRestorer` and `ashenPassBreaker` still showed the wax-seal placeholder. Match A.8's achievement icons (32×32, one as `style_image`).
- Two icons: the Graumark Warehouse restored (`achievement.warehouse-restorer`) and the Ashen Pass cleared (`achievement.ashen-pass-breaker`).
- Budget: one 32px job; at most one regeneration. Manifest and `assets.ts` updated (in order); the ids leave the web test's awaiting-art list. No game-core or server changes.
**Acceptance:** a contact sheet next to A.8's set in the PR.
