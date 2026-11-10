// Ticket 6.2: the Cinder Depths (levels 34–40) and the Forge Tyrant against good Verge gear.
// Dev script; guards in balance/balance.test.ts "the Cinder Depths" / "the Forge Tyrant".
//   pnpm --filter @worldforge/server exec tsx ../../tools/balance/cinder-depths.ts farm|boss|xp
//   farm: per class, the best build at item level 33 (Verge drops, tier 4) at +5 and +10 Void, and
//         plain Legendaries +10 at 33, farming the Verge at 34 and the Depths at 34 / 37 / 40
//   boss: Forge Tyrant win rates by gear tier and hero level (RUNS runs each)
//   xp:   hours per level from 34 to 50 for the best build farming the best open area
import * as G from '../../packages/game-core/src/index.ts';
import {
  PASS_FARM_JOB,
  buildItems,
  describeBuild,
  farmRate,
  searchBuilds,
  setChassis,
} from '../../packages/game-core/src/balance/builds.ts';

const mode = process.argv[2] ?? 'farm';
const HOUR = 3_600_000;
const SEEDS = Number(process.env.SEEDS ?? 3);
const RUNS = Number(process.env.RUNS ?? 24);
const VERGE_IL = 33;

function farm(c: G.ClassId, level: number, areaId: G.AreaId, items: G.EquippedItem[]) {
  let kills = 0,
    deaths = 0,
    xp = 0,
    gold = 0,
    share = 0,
    enc = 0;
  const mats: Record<string, number> = {};
  for (let s = 0; s < SEEDS; s++) {
    const r = G.settleFarming({
      character: { classId: c, level, xp: 0 },
      equipment: items,
      areaId,
      seed: `cd:${c}:${level}:${s}`,
      firstCycle: 0,
      durationMs: HOUR,
      inventoryCount: 0,
    });
    kills += r.kills;
    deaths += r.deaths;
    xp += r.xpGained;
    gold += r.goldLooted;
    share += r.damageTaken / r.maxHealth;
    enc += r.encounters;
    for (const [k, v] of Object.entries(r.materials))
      mats[k] = (mats[k] ?? 0) + (v as number) / SEEDS;
  }
  return {
    kpm: kills / SEEDS / 60,
    dph: deaths / SEEDS,
    xph: xp / SEEDS,
    gph: gold / SEEDS,
    share: share / enc,
    mats,
  };
}

function plainKit(
  c: G.ClassId,
  itemLevel: number,
  rarityId: G.RarityId,
  upgradeLevel: number,
): G.EquippedItem[] {
  const rng = G.createRng(`cd-kit:${c}:${itemLevel}:${rarityId}`);
  const bases = G.ITEM_BASES.filter(
    (b) => !b.unique && b.minItemLevel <= itemLevel && G.canClassUseItem(b, c),
  ).sort((a, b) => b.tier - a.tier || b.minItemLevel - a.minItemLevel);
  const taken = new Set<string>();
  const out: G.EquippedItem[] = [];
  for (const base of bases) {
    if (taken.has(base.slot)) continue;
    taken.add(base.slot);
    for (let i = 0; i < (base.slot === 'ring' ? 2 : 1); i++) {
      const item = G.generateItem({
        seed: rng.int(0, 2 ** 31),
        itemLevel,
        baseId: base.id,
        rarityId,
        classId: c,
      })!;
      out.push({ ...item, effectId: undefined, upgradeLevel } as G.EquippedItem);
    }
  }
  return out;
}

const bestCache = new Map<G.ClassId, ReturnType<typeof searchBuilds>[number]>();
function best(c: G.ClassId) {
  let b = bestCache.get(c);
  if (!b) {
    b = searchBuilds(
      c,
      PASS_FARM_JOB.itemLevel,
      (items) => farmRate(c, items, PASS_FARM_JOB),
      setChassis(c),
    )[0]!;
    bestCache.set(c, b);
  }
  return b;
}
const fmt = (s: ReturnType<typeof farm>) =>
  `${s.kpm.toFixed(1)}/min ${s.dph.toFixed(1)}d ${(100 * s.share).toFixed(0)}% xp ${Math.round(s.xph / 1000)}k gold ${Math.round(s.gph)} ore ${(s.mats.ironOre ?? 0).toFixed(0)} sh ${(s.mats.soulShard ?? 0).toFixed(0)}`;

function kits(c: G.ClassId): [string, G.EquippedItem[]][] {
  const b = best(c).build;
  return [
    ['rares +5', plainKit(c, VERGE_IL, 'rare', 5)],
    ['epics +5', plainKit(c, VERGE_IL, 'epic', 5)],
    ['epics +10', plainKit(c, VERGE_IL, 'epic', 10)],
    ['legendary', plainKit(c, VERGE_IL, 'legendary', 0)],
    ['legendary +5', plainKit(c, VERGE_IL, 'legendary', 5)],
    ['legendary +10', plainKit(c, VERGE_IL, 'legendary', 10)],
    ['best +5', buildItems({ ...b, upgradeLevel: 5 }, VERGE_IL)],
    ['best +10 Void', buildItems({ ...b, upgradeLevel: 10, void: true }, VERGE_IL)],
  ];
}

function boss(c: G.ClassId, level: number, items: G.EquippedItem[]) {
  let wins = 0,
    t = 0,
    minT = Infinity;
  for (let i = 0; i < RUNS; i++) {
    const r = G.simulateDungeonRun({
      dungeonId: 'tyrantsForge',
      tier: 1,
      character: { classId: c, level, xp: 0 },
      equipment: items,
      seed: `tyrant:${c}:${level}:${i}`,
      bossLootEligible: false,
      inventoryCount: 0,
    });
    if (r.bossDefeated) {
      wins++;
      const e = r.encounters.at(-1)!;
      t += e.endMs - e.startMs;
      minT = Math.min(minT, e.endMs - e.startMs);
    }
  }
  return { rate: wins / RUNS, mean: wins ? t / wins / 1000 : 0, min: minT / 1000 };
}

if (mode === 'farm') {
  for (const c of G.CLASS_IDS) {
    console.log(`${c}: ${describeBuild(best(c).build)}`);
    for (const [name, items] of kits(c)) {
      if (!['best +5', 'best +10 Void', 'legendary +10', 'epics +5'].includes(name)) continue;
      console.log(`  ${name.padEnd(14)} Verge 34: ${fmt(farm(c, 34, 'ashfallVerge', items))}`);
      for (const level of [34, 37, 40])
        console.log(
          `  ${name.padEnd(14)} Depths ${level}: ${fmt(farm(c, level, 'cinderDepths', items))}`,
        );
    }
  }
}
if (mode === 'boss') {
  const levels = (process.env.LEVELS ?? '36,38,40').split(',').map(Number);
  for (const c of G.CLASS_IDS) {
    for (const [name, items] of kits(c)) {
      if (process.env.KITS && !process.env.KITS.split(',').includes(name)) continue;
      const row = levels.map((l) => {
        const b = boss(c, l, items);
        return `${l}: ${(100 * b.rate).toFixed(0).padStart(3)}% (${b.mean.toFixed(0)}s, min ${Number.isFinite(b.min) ? b.min.toFixed(0) : '-'})`;
      });
      console.log(`${c.padEnd(8)} ${name.padEnd(14)} ${row.join('  ')}`);
    }
  }
}
if (mode === 'xp') {
  for (const c of G.CLASS_IDS) {
    const items = buildItems({ ...best(c).build, upgradeLevel: 10, void: true }, VERGE_IL);
    const row: string[] = [];
    for (let level = 34; level <= 50; level++) {
      const xph = Math.max(
        farm(c, level, 'ashfallVerge', items).xph,
        farm(c, level, 'cinderDepths', items).xph,
      );
      row.push(`${level}:${(G.xpToNextLevel(level) / xph).toFixed(1)}h`);
    }
    console.log(`${c} ${row.join(' ')}`);
  }
}
