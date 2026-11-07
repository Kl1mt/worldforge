# Leaderboards: what is measured (ticket 5.1)

GDD §10.2, §16.3; Phase 5 ground rules in `ROADMAP.md`. This ticket defines the four scores, their published formulas and a read-only breakdown on the character screen ("Standing"). Boards, storage and filters are ticket 5.2; seasons 5.3.

Code: game-core `packages/game-core/src/scoring/` (formulas, data, tests), server `apps/server/src/scores/routes.ts` (`GET /api/characters/:characterId/scores`, `API_CONVENTIONS.md`), web `apps/web/src/screens/StandingPanel.tsx`. Screenshots: `docs/screenshots/phase-5/standing-*.png` (`node tools/screenshots/standing.mjs`).

## For players: how each score is measured

Every score is worked out by the server from what your hero has done and wears. Nothing your browser sends is ever taken as a score. On the character screen, **Standing** shows your four scores; open a line to see what counted and why.

**Everyone on a board is listed by name** (owner decision): there is no opt-out and no anonymous entry. Your profile settings still decide whether your name links to your profile.

### Character Level
Your level. Between heroes of the same level, whoever has earned more experience toward the next level is ahead.

### Gear Score
How good your equipped items are, item by item, and nothing else. It does not ask whether they work well together; that is what Character Power is for.

For each item you wear:

> **item level × 10 × rarity × upgrades × Void**

| Part | Value |
|---|---|
| Rarity | Common × 1 · Uncommon × 1.15 · Rare × 1.3 · Epic × 1.5 · Legendary × 1.75 (set pieces are Legendary) · Mythic × 2 |
| Upgrades | + 4 % per upgrade level (+10 is × 1.4) |
| Void | × 1.1 |
| Two-handed weapons | A mage's staff, a hunter's bow and a warlock's staff take both hands (these classes have no off-hand), so they count twice. A warrior's sword and shield count once each. Every class can reach the same total. |

Each item is rounded to a whole number and the items are added up. Example: a +5 Legendary at item level 20 is 20 × 10 × 1.75 × 1.2 = 420.

A better item (higher item level, rarer, more upgrades, or Void) never lowers your Gear Score. An item that fails the server's item check (it could not have dropped as it is) counts 0 and says so in the breakdown.

### Character Power
How strong your hero is as equipped, from an actual fight, so your build counts and not only your numbers: crits, speed, set bonuses, Legendary effects and Mythic signatures all fight.

Your hero runs the **Proving Grounds**: 20 trials at levels 4, 8, 12 … 80. Each trial is three foes back to back (a brute, a hexer, a brute: physical and magic damage) and then a champion two levels higher, a boss that enrages after 40 seconds. Between fights the hero searches for 2 seconds and heals as in the field; kill effects and bloodrush streaks carry from fight to fight.

- **Getting through:** up to 100 points per trial: 15 for each foe and 55 for the champion. A fight you lose still counts for the share of its health you took.
- **Clearing fast:** a cleared trial adds up to 100 more: 100 × (1 − time ÷ 120 seconds).

Power is the sum over the trials (at most 4,000). The trials, the foes and every dice roll are fixed, so the same hero always gets the same Power. Gold find, item find, XP gain and resource yield do not fight and do not count. Items that fail the server's item check are left out, as if the slot were empty.

Power reflects class balance too: with the same kind of kit the classes are within about 20 % of each other (the hunter highest at level 28, the warlock lowest). Boards can be filtered by class.

### PvE Progress
How far your hero has come. There are ten milestones, in the order heroes usually meet them:

1. Abandoned Fields reached
2. Crowwood reached (level 5)
3. Old Burial Grounds reached (level 9)
4. Blackwater reached (level 13)
5. The Nameless Crypt, tier I cleared
6. Sunken Abbey reached (level 17 and the Gravewarden slain)
7. The Nameless Crypt, tier II cleared
8. The Nameless Crypt, tier III cleared
9. The Ashen Pass reached (level 24, the Gravewarden slain, and the Pass opened by the community)
10. The Ashen Warden defeated

Your score is how many of them you have reached ("7 of 10"). If two heroes have the same number, the one whose furthest milestone is further down the list is ahead; then the one who helped break the higher **guild boss stage** (a stage your account earned the reward for, in a week this hero fought the boss for that guild). On the boards (5.2), a remaining tie goes to whoever got there first.

## Technical spec (for 5.2)

### Versioning
`FORMULA_VERSIONS` (game-core `scoring/types.ts`) holds one version per metric (`level`, `gearScore`, `power`, `pveProgress`; all 1 now). Bump a metric's version whenever its value can change for the same inputs: a weight, a reference foe, a trial, a milestone, or a combat rule that Power runs through (`buildEncounter`, `resolveDungeonFight`, effects, stat derivation, `validateItem`). The pinned values in `scoring/scoring.test.ts` fail when a number moves; the fix is a version bump, a new pin and an update here in the same change. The pinned no-effects hashes and balance suites are untouched by scoring (scoring only reads the rules).

### Inputs
`ScoringInput` (game-core `scoring/scores.ts`), built by the server only (`scoringInput` in `apps/server/src/scores/routes.ts`):
- `classId`, `level`, `experience` (the `characters` row);
- `equipment`: the equipped `item_instances` rows with their slot, as stored (seed, base, rarity, item level, affixes, upgrade level, variant, effect, effect roll, Mythic, set);
- `progress` (`characters.progress`) and `world` (the world flags);
- `guildBossStage`: the highest stage of `guild_boss_rewards` with `status = 'earned'` for the hero's account, in a (guild, week) for which this hero has a `guild_boss_attempts` row.

`computeScores(input)` returns all four `Score`s: `{ metric, formulaVersion, value, sortKey, summary, lines }`. `sortKey` is compared lexicographically, higher first: Level `[level, xp]`, Gear Score `[total]`, Power `[power]`, PvE Progress `[count, furthest, guildStage]`. 5.2 appends "reached first" (earlier wins).

### Validation (stat-inflation resistance)
Before an item counts (`checkEquipment`): `validateItem` must find no problem, the upgrade level must be a whole number 0–10, the slot must be a real equipment slot that the base fits and the class can use, and only one item may sit in a slot (two in one slot: neither counts). A rejected item counts 0 for Gear Score and is left out of Power. Level and XP outside what the server stores are refused (`RangeError`), not clamped; a guild boss stage that is not a whole number counts 0 and is capped at the boss's last stage.

### Determinism
Pure functions over the input: no clock, no `Math.random`, no ambient state. Power's fights draw from fixed seeds (`power:v<version>:<trial>:<run>:<fight>`, two runs per trial, averaged) and a fixed enrage moment; its foes are scoring data (`PROVING_BRUTE`, `PROVING_CASTER`, `PROVING_CHAMPION`, `DEFAULT_POWER_CONFIG`), not world enemies, so a content retune of an area does not move Power (a change to the combat rules does: bump the version). Tested: equal results across calls, pinned values across processes, and the server route equals `computeScores` on the stored input.

### Cost
Power is the only non-trivial score: 20 trials × 2 runs × at most 4 fights (≤ 160 short fights, detailed resolution, no distributions). About 2 ms per hero on a laptop, independent of the hero's level; the test budget is 25 ms (`scoring.test.ts`). Gear Score, Level and PvE Progress are microseconds. Computing all four on every relevant change is cheap; 5.2 should still compute after the change's transaction, not inside the character lock.

### Recompute rule
5.2 stores per hero and metric: `(metric, formulaVersion, input, value, sortKey, reachedAt)`. Any stored value must equal `computeScores(input)` for its version (an audit query can check every row). Recompute from server state when:
- the level or XP changes (Level, Power) — settlement, crypt and Watch claims, quests;
- an equipped item changes: equip, unequip, upgrade, reroll or improve of a worn item, warehouse moves of a worn item (Gear Score, Power);
- `characters.progress` changes: crypt and Watch claims (PvE Progress);
- a guild boss reward becomes `earned` (PvE Progress of the heroes of that account that fought that week);
- a world flag changes (PvE Progress of every hero; a background job);
- a metric's formula version is bumped (recompute every stored row from its stored input, then from current state on the hero's next change).
`reachedAt` changes only when the `sortKey` changes. Sanctioned accounts are excluded at read time (5.2), not by changing their scores.

### Known limits and owner decisions
- **Guild boss stages are a tie-breaker, not milestones** (the ticket listed them among the milestones). A stage is broken by a whole guild; counting it as a personal milestone would let a weak hero in a strong guild outrank a stronger solo hero. Owner can override (e.g. stage 5 as an 11th milestone).
- **Areas count when they are open to the hero** (the unlock rule: level, Gravewarden, world flag), not when first visited: no "visited" record exists. When the community opens the Ashen Pass, every hero of level 24 with the Gravewarden slain gains milestone 9 at once.
- **Power's scale** saturates at 4,000 (20 trials); today's best builds at level 23 score about 3,500–3,700 and level-35 heroes in epics +5 about 2,700–3,050. Content above level 28 (Phase 6) can add trials in a new version.
- **Power and class balance:** the spread between classes (up to × 1.21 with the same kit) is the combat balance, not the formula; a per-class board (5.2 filter) compares like with like.
- **Farming-only value** (kill speed in an area, gold, item find) is not in Power. The three foes per trial let kill effects (Carrion Feast, Bloodrush, Ambush, the Bloodmoon opener) count, but Power leans toward the boss: against the B.2 build search it follows the tier III Gravewarden's boss times (Spearman 0.65–0.78 per class) more than farming rates.

## Tests
- `packages/game-core/src/scoring/scoring.test.ts`: determinism and pinned values; Level order and refusals; Gear Score weights, the two-handed rule, monotonicity (over 10,000 item pairs: each better item level, rarity, upgrade and Void; and every slot swap to a better item); stat-inflation resistance (14 forged items count 0 and leave Power unchanged, duplicate slots, a class item on another class, no false rejections over generated kits); Power grows with level and gear tiers, class spread, breakdown, performance budget; PvE milestones cover every area and crypt tier, order, ties, guild stage bounds.
- `packages/game-core/src/scoring/power-ranking.test.ts`: Power against the B.2 build search (48 builds per class at level 23): Spearman with boss time > 0.5, every top build (within 7 %) above the median, the slowest quarter below the best top build, +5 and +10 Void add Power.
- `apps/server/src/scores/scores.test.ts`: the route equals `computeScores` on the stored input, a forged item row counts 0, the guild boss stage rule, 404 for another account's hero, 401 without a session.
