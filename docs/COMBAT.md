# Combat simulation (game-core)

Ticket 1.4. Pure, deterministic rules in `packages/game-core/src/combat/`; content in `packages/game-core/src/world/`.
The server (ticket 1.6) is the only caller that may award results; it derives the seed itself.

## Content
- `world/enemies.ts`: Risen Farmhand, Carrion Wolf, Bone Scarecrow. Each stat is `base + perLevel · (level − 1)`. The scarecrow deals magic damage, the others physical.
- `world/areas.ts`: Abandoned Fields, enemy levels 1–6, spawn weights 50 / 35 / 15.
- `combat/characterStats.ts`: per-class base stats and per-level growth (`CLASS_STAT_PROFILES`).
- `combat/skills.ts`: one auto-skill per class that replaces every n-th basic attack (Heavy Strike, Firebolt, Aimed Shot, Shadow Bolt). No resource costs yet.
- `combat/encounter.ts`: `DEFAULT_COMBAT_CONFIG` holds every tunable (search time, regeneration, respawn delay, fight timeout, mitigation and XP-penalty constants).

## Stats
`deriveCharacterStats(classId, level, equipment)` adds class base, level growth and each item's `EquipmentStatContribution` (additive, in stat units), then clamps to `STAT_LIMITS` (crit chance ≤ 75 %, attack speed 0.25–4/s, nothing negative). Units: `attackSpeed` attacks/s, `critChance` 0–1, `critDamage` multiplier (1.5 = 150 %). Non-finite inputs throw.

## Rules
- **Damage:** the class's primary damage stat (physical or magic) × skill multiplier × crit multiplier × (1 − mitigation), rounded, at least 1. Enemies never crit.
- **Mitigation:** `defense / (defense + 50 + 10 · attackerLevel)`, capped at 75 %. Armor applies to physical damage, resistance to magic.
- **Enemy roll:** weighted enemy pick, then level = character level ± 1, clamped to the area range.
- **XP:** enemy XP × level factor (−15 % per level the character is more than 2 above the enemy, minimum 10 %). `xpToNextLevel(L) = round(80 · L^1.6)`, cap level 60. Level-ups recompute stats and restore full health.
- **Cycle:** search 2 s (regenerate 10 % max health per second) → fight → if the character died, respawn after 10 s at full health. A fight that lasts more than 30 s is abandoned without reward (timeout).
- **Timeline:** times are whole milliseconds. The character attacks at `j · interval`, the enemy at `k · interval` (j, k ≥ 1, interval = round(1000 / attack speed)). On equal timestamps the character acts first.
- **Window end:** a cycle that would finish after the window is not applied. Its time is returned as `unusedMs`; the caller carries it into the next settlement, so no time is lost and nothing is half-awarded.

## Two simulations, one model
Both run the same cycle loop (`runFarming`); only the fight resolution differs.
- `simulateFarming` (detailed): rolls the crit of every attack and records a compact event log (`spawn`, `attack`, `enemyAttack`, `kill`, `timeout`, `death`, `respawn`, `levelUp`), keeping the most recent `maxEvents` (default 200).
- `simulateFarmingAggregate` (offline settlement): for each fight it computes the exact distribution of the killing attack (dynamic programming over damage totals, cached per encounter setup), samples it with a single RNG draw, and derives enemy hits, death and timing in closed form. No events.

Both are deterministic for a given seed. They consume the RNG differently, so the same seed gives different (but equally distributed) results. Tests compare them per fight (20,000 trials) and per farming window (300 seeds, means within 4 standard errors). A 3-hour window settles in about 10 ms with either function at Phase 1 numbers.

## Results
`FarmingResult`: kills (total and per enemy), deaths, timeouts, encounters, XP gained, start/end level and XP, levels gained, damage taken, final and max health, `simulatedMs` / `unusedMs`, and the event log.

## Open points
- Balance numbers are first-pass. Casters die more often than melee classes in the Fields.
- Item stats are only an input; the loot module (ticket 1.5) produces them.
- Damage over time, resources and skill loadouts come in later phases.
- Windows shorter than the longest cycle (42 s: search + timeout + respawn) may return no progress; settle in chunks of minutes and carry `unusedMs` forward.
