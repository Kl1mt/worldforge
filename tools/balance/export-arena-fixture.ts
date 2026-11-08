// Ticket B.4: writes the realistic arena fixture for `balance/competitive-balance.test.ts` from
// `telemetry:simulate --days 56 --snapshots` runs (see competitive.ts):
//   pnpm --filter @worldforge/server exec tsx ../../tools/balance/export-arena-fixture.ts ../../.season-a ../../.season-b ../../.season-c
// Per rated bracket, distinct heroes of a 500-player season population on days 14, 28 and 56
// (the defences an arena of that size holds), at most PER_BRACKET each, with only what a duel
// and Power read (class, level, equipped items). Simulated heroes only: no player data.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  RATED_DUEL_MIN_LEVEL,
  createRng,
  pvpBracketOf,
  type ScoringInput,
} from '../../packages/game-core/src/index.ts';
import {
  SEASON_MIX,
  drawPopulation,
  loadTrajectories,
  stateKey,
  stateOf,
} from './season-population.ts';

const PER_BRACKET = 120;
const dirs = process.argv.slice(2).filter((a) => a !== '--');
const pop = drawPopulation(loadTrajectories(dirs), 500, 'arena:500', SEASON_MIX);
const byBracket = new Map<string, Map<string, ScoringInput>>();
for (const t of [14, 28, 56]) {
  for (const p of pop) {
    const s = stateOf(p, t);
    if (!s || s.level < RATED_DUEL_MIN_LEVEL) continue;
    const b = pvpBracketOf(s.level).id;
    const m = byBracket.get(b) ?? new Map<string, ScoringInput>();
    m.set(stateKey(p, t), s);
    byBracket.set(b, m);
  }
}
type Row = [string, number, unknown[]];
const out: Record<string, Row[]> = {};
for (const [b, m] of [...byBracket.entries()].sort()) {
  // Distinct kits only, then a seeded sample.
  const seen = new Set<string>();
  const heroes = [...m.values()].filter((s) => {
    const k = JSON.stringify([s.classId, s.level, s.equipment]);
    return !seen.has(k) && seen.add(k);
  });
  const rng = createRng(`arena-fixture:${b}`);
  for (let i = heroes.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [heroes[i], heroes[j]] = [heroes[j]!, heroes[i]!];
  }
  out[b] = heroes
    .slice(0, PER_BRACKET)
    .map((s) => [
      s.classId,
      s.level,
      s.equipment.map((e) => [
        e.slot,
        e.seed,
        e.baseId,
        e.rarityId,
        e.itemLevel,
        e.affixes.map((a) => [a.affixId, a.tier, a.value]),
        e.upgradeLevel,
        e.variant,
        e.effectId,
        e.effectRoll,
        e.mythicId,
        e.setId,
      ]),
    ]);
  console.log(`${b}: ${heroes.length} distinct heroes, ${out[b]!.length} kept`);
}
const file = fileURLToPath(
  new URL('../../packages/game-core/src/balance/realistic-arena.json', import.meta.url),
);
writeFileSync(file, JSON.stringify(out) + '\n');
console.log(`wrote ${file}`);
