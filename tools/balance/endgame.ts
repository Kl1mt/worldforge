// Ticket B.5: the endgame balance pass (docs/BALANCE.md "B.5"). Dev script; guards in
// packages/game-core/src/balance/endgame-balance.test.ts.
//   pnpm --filter @worldforge/server exec tsx ../../tools/balance/endgame.ts bosses
//   bosses: the Forge Tyrant and the Heroic Gravewarden per class: Legendary kits (with effects,
//           SAMPLES kit samples × RUNS seeds) at +0/+5/+10, and the best farming build (+5, +10
//           Void) with its mean and fastest kill. Try boss data without editing it:
//           TYRANT_SCALE=res,arm HEROIC_SCALE=res,arm (multipliers on resistance and armour),
//           TYRANT_SHELL=until,multiplier (the slag shell).
import * as G from '../../packages/game-core/src/index.ts';
import { kit, upgraded } from '../../packages/game-core/src/balance/kits.ts';
import {
  PASS_FARM_JOB,
  buildItems,
  farmRate,
  searchBuilds,
  setChassis,
} from '../../packages/game-core/src/balance/builds.ts';

const mode = process.argv[2] ?? 'bosses';
const RUNS = Number(process.env.RUNS ?? 12);
const SAMPLES = Number(process.env.SAMPLES ?? 8);
const pct = (x: number) => `${Math.round(x * 100)}`.padStart(3);

/** A Legendary kit with effects (balance.test's `legendaryKit` for sample 0, other rolls after). */
export function legendarySample(c: G.ClassId, itemLevel: number, sample: number) {
  return kit(c, itemLevel, 'legendary').map(
    (item, k) =>
      G.generateItem({
        seed: sample === 0 ? item.seed : (item.seed * 31 + sample * 7919 + k) % 2 ** 31,
        itemLevel,
        baseId: item.baseId,
        rarityId: 'legendary',
        classId: c,
      })!,
  );
}

function override(dungeonId: G.DungeonId, tier: number, env: string | undefined) {
  if (!env) return;
  const [res, arm] = env.split(',').map(Number);
  const t = G.DUNGEONS.find((d) => d.id === dungeonId)!.tiers.find((x) => x.tier === tier)!;
  const base = t.bossScale ?? { health: 1, damage: 1 };
  (t as { bossScale?: G.EnemyScale }).bossScale = { ...base, resistance: res!, armor: arm! };
  console.log(`${dungeonId} ${tier}: bossScale ${JSON.stringify(t.bossScale)}`);
}
override('tyrantsForge', 1, process.env.TYRANT_SCALE);
if (process.env.TYRANT_BURN) {
  const [everyMs, share] = process.env.TYRANT_BURN.split(',').map(Number);
  const t = G.DUNGEONS.find((d) => d.id === 'tyrantsForge')!.tiers[0]!;
  (t as { bossMechanics?: G.BossMechanics }).bossMechanics = {
    ...t.bossMechanics,
    burn: { everyMs: everyMs!, damageShare: share! },
  };
}
if (process.env.TYRANT_SHELL) {
  const [until, mult] = process.env.TYRANT_SHELL.split(',').map(Number);
  const t = G.DUNGEONS.find((d) => d.id === 'tyrantsForge')!.tiers[0]!;
  (t as { bossMechanics?: G.BossMechanics }).bossMechanics = {
    ...t.bossMechanics,
    shell: { untilHealthShare: until!, damageTakenMultiplier: mult! },
  };
  console.log(`tyrant mechanics ${JSON.stringify(t.bossMechanics)}`);
}
override('namelessCrypt', 4, process.env.HEROIC_SCALE);

function run(d: G.DungeonId, tier: G.DungeonTier, c: G.ClassId, level: number, eq: G.EquippedItem[], n = RUNS, mod: G.BossModifierId | null = null) {
  let wins = 0;
  let t = 0;
  let min = Infinity;
  for (let i = 0; i < n; i++) {
    const r = G.simulateDungeonRun({
      dungeonId: d,
      tier,
      character: { classId: c, level, xp: 0 },
      equipment: eq,
      seed: `b5-boss:${i}`,
      bossLootEligible: false,
      inventoryCount: 0,
      bossModifier: mod,
    });
    if (!r.bossDefeated) continue;
    wins++;
    const e = r.encounters.at(-1)!;
    t += e.endMs - e.startMs;
    min = Math.min(min, e.endMs - e.startMs);
  }
  return { rate: wins / n, mean: wins ? t / wins / 1000 : 0, min: min / 1000 };
}

const bestCache = new Map<G.ClassId, G.EquippedItem[][]>();
/** The best farming build at item level 33 (the Verge's drops), +5 and +10 Void, as 6.2. */
function best(c: G.ClassId) {
  let b = bestCache.get(c);
  if (!b) {
    const top = searchBuilds(c, PASS_FARM_JOB.itemLevel, (items) => farmRate(c, items, PASS_FARM_JOB), setChassis(c))[0]!.build;
    b = [buildItems({ ...top, upgradeLevel: 5 }, 33), buildItems({ ...top, upgradeLevel: 10, void: true }, 33)];
    bestCache.set(c, b);
  }
  return b;
}

if (mode === 'bosses') {
  const fights: [string, G.DungeonId, G.DungeonTier, number[], number][] = [
    ['Forge Tyrant', 'tyrantsForge', 1, [36, 38], 35],
    ['Heroic', 'namelessCrypt', 4, [32, 34, 36], 30],
  ];
  for (const [name, d, tier, levels, enrage] of fights) {
    for (const level of levels) {
      console.log(`\n${name} at ${level} (0.4 × earliest enrage = ${(0.4 * enrage).toFixed(0)} s)`);
      for (const up of [0, 5, 10]) {
        const per = G.CLASS_IDS.map((c) => {
          let s = 0;
          for (let k = 0; k < SAMPLES; k++) s += run(d, tier, c, level, upgraded(legendarySample(c, 33, k), up)).rate;
          return s / SAMPLES;
        });
        const mean = per.reduce((a, b) => a + b) / per.length;
        console.log(`  Legendaries +${String(up).padEnd(2)} ${per.map(pct).join(' /')}  (mean ${pct(mean)}, spread ${pct(Math.max(...per) - Math.min(...per))})`);
      }
      if (process.env.BEST !== '0') {
        for (const [i, label] of ['best +5', 'best +10 Void'].entries()) {
          const cells = G.CLASS_IDS.map((c) => {
            const r = run(d, tier, c, level, best(c)[i]!, RUNS * 2);
            return `${pct(r.rate)}% ${r.mean.toFixed(0)}s min ${Number.isFinite(r.min) ? r.min.toFixed(0) : '-'}`;
          });
          console.log(`  ${label.padEnd(15)} ${cells.join(' / ')}`);
        }
      }
    }
  }
}
