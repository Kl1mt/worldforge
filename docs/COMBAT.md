# Combat simulation (game-core)

Ticket 1.4. Pure, deterministic rules in `packages/game-core/src/combat/`; content in `packages/game-core/src/world/`.
The server (ticket 1.6) is the only caller that may award results; it derives the seed itself.

## Content
- `world/enemies.ts`: all enemies of Graumark (ticket 2.1 added the Phase 2 areas, the crypt and the Gravewarden; see `docs/WORLD.md`). Each stat is `base + perLevel · (level − 1)`; `damageType` picks the defense that mitigates it.
- `world/areas.ts`: the five areas with level ranges, spawn weights, unlock rules and loot tables (`docs/WORLD.md`). Abandoned Fields: enemy levels 1–6, spawn weights 50 / 35 / 15.
- `combat/characterStats.ts`: per-class base stats and per-level growth (`CLASS_STAT_PROFILES`).
- `combat/skills.ts`: one auto-skill per class that replaces every n-th basic attack (Heavy Strike, Firebolt, Aimed Shot, Shadow Bolt). No resource costs yet.
- `combat/encounter.ts`: `DEFAULT_COMBAT_CONFIG` holds every tunable (search time, regeneration, respawn delay, fight timeout, mitigation and XP-penalty constants).

## Stats
`deriveCharacterStats(classId, level, equipment)` adds class base, level growth and each item's `EquipmentStatContribution` (additive, in stat units), then clamps to `STAT_LIMITS` (crit chance ≤ 75 %, attack speed 0.25–4/s, nothing negative). Units: `attackSpeed` attacks/s, `critChance` 0–1, `critDamage` multiplier (1.5 = 150 %). Non-finite inputs throw.

Loot → combat bridge (`packages/game-core/src/equipment.ts`, ticket 1.7): `itemStatContribution(item)` turns a `GeneratedItem` into its `EquipmentStatContribution`: implicit stats (`getImplicitStats`: base scaled by item level and rarity) plus every affix on a core stat, summed. Gold find is not a combat stat and is left out; `itemSecondaryModifiers(item)` returns it uncapped (the cap before `rollLoot` is ticket 1.6's). `deriveEquippedStats(classId, level, items)` is `deriveCharacterStats` over those contributions. `checkEquip(baseId, classId, slot)` holds the equip rules (slot fits the base's kind, class allowed; GDD §7.1) and `defaultEquipSlot` picks a slot when the player names none (first free ring slot for rings).

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

**Per-cycle RNG (ticket 1.9).** With `firstCycle` set, cycle `i` of a window draws from its own stream `${seed}:${firstCycle + i}` instead of one stream per window, and `onCycle` reports each committed cycle (index, outcome, enemy, level at its start). A cycle's outcome then depends only on the seed, its global index and the state at its start, so a window cut short just ends earlier on the same sequence: settling every second gives exactly the result of one settlement at the end. Offline settlement (`settleFarming`) always uses it. Before, each settlement re-rolled the unfinished cycle; long cycles (deaths with respawn, slow fights) were discarded more often, and settling every second cut a level-1 warrior's deaths from ≈6.4 to 0.1 per hour and raised kills by ~20 %.

Both are deterministic for a given seed. They consume the RNG differently, so the same seed gives different (but equally distributed) results. Tests compare them per fight (20,000 trials) and per farming window (300 seeds, means within 4 standard errors). A 3-hour window settles in about 10 ms with either function at Phase 1 numbers.

## Results
`FarmingResult`: kills (total and per enemy of the area's roster), deaths, timeouts, encounters, XP gained, start/end level and XP, levels gained, damage taken, final and max health, `simulatedMs` / `unusedMs`, and the event log.

## Balance baseline (ticket 1.9, not tuned)
Starting numbers for later balancing: a fresh level-1 character farming Abandoned Fields, no equipment, one `settleFarming` window, mean of 20 seeds (game-core defaults at ticket 1.9). Items = drops before the capacity rule.

| Class   | Window | Kills | Deaths | Timeouts | Level reached | Gold  | Items |
| ------- | ------ | ----- | ------ | -------- | ------------- | ----- | ----- |
| warrior | 30 min | 205   | 6.5    | 0        | 7             | 476   | 24    |
| warrior | 3 h    | 1629  | 6.8    | 0        | 13            | 4334  | 195   |
| mage    | 30 min | 165   | 28.8   | 0        | 6             | 368   | 19    |
| mage    | 3 h    | 1551  | 49.9   | 0        | 13            | 4129  | 187   |
| hunter  | 30 min | 196   | 19.1   | 0        | 7             | 451   | 23    |
| hunter  | 3 h    | 1734  | 23.8   | 0        | 13            | 4627  | 207   |
| warlock | 30 min | 159   | 24.6   | 0        | 6             | 352   | 19    |
| warlock | 3 h    | 1471  | 44.5   | 0        | 13            | 3907  | 177   |

Observations: almost all deaths happen in the first levels (a mage dies about once a minute at level 1–3, then rarely); the warrior barely dies. Casters lose ~15–20 % of their early kills to deaths and respawns. Every class reaches level 13 (the area's top) within 3 h, so the Fields stop giving XP-relevant challenge well inside one offline cap. The browser e2e runs (×120 clock, 30 min cap) match: warrior 1 death and mage 26 deaths in ~32 simulated minutes (ticket 1.8 saw 12 deaths in ~30 min).

## Open points
- Balance numbers are first-pass (see the baseline above). Casters die more often than melee classes in the Fields.
- Item stats are only an input; the loot module (ticket 1.5) produces them.
- Damage over time, resources and skill loadouts come in later phases.
- Windows shorter than a cycle return no progress; carry `unusedMs` forward (with per-cycle RNG this never changes the result).
