// Ticket 6.1: the Ashfall Verge (the Cinderwastes, levels 28–34) against today's best Ashen Pass
// gear. Dev script; guards in balance/balance.test.ts "the Ashfall Verge".
//   pnpm --filter @worldforge/server exec tsx ../../tools/balance/cinderwastes.ts farm|xp
//   farm: per class, the best Pass build (4.8's search) at +10 Void and +5, and the Pass kit (rares
//         +5), item level 27, farming the Verge at 28 / 31 / 34 (kills/min, deaths/h, share, XP, gold)
//   xp:   hours per level from 28 to 46 for the best build farming the best open area
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

function farm(c: G.ClassId, level: number, areaId: G.AreaId, items: G.EquippedItem[]) {
  let kills = 0, deaths = 0, xp = 0, gold = 0, share = 0, enc = 0;
  const mats: Record<string, number> = {};
  for (let s = 0; s < SEEDS; s++) {
    const r = G.settleFarming({
      character: { classId: c, level, xp: 0 },
      equipment: items,
      areaId,
      seed: `cw:${c}:${level}:${s}`,
      firstCycle: 0,
      durationMs: HOUR,
      inventoryCount: 0,
    });
    kills += r.kills; deaths += r.deaths; xp += r.xpGained; gold += r.goldLooted;
    share += r.damageTaken / r.maxHealth; enc += r.encounters;
    for (const [k, v] of Object.entries(r.materials)) mats[k] = (mats[k] ?? 0) + (v as number) / SEEDS;
  }
  return { kpm: kills / SEEDS / 60, dph: deaths / SEEDS, xph: xp / SEEDS, gph: gold / SEEDS, share: share / enc, mats };
}

/** balance.test.ts's kit: one item per droppable slot of the best regular base, implicit + rolled affixes. */
function plainKit(c: G.ClassId, itemLevel: number, rarityId: G.RarityId, upgradeLevel: number): G.EquippedItem[] {
  const rng = G.createRng(`cw-kit:${c}:${itemLevel}:${rarityId}`);
  const bases = G.ITEM_BASES.filter((b) => !b.unique && b.minItemLevel <= itemLevel && G.canClassUseItem(b, c))
    .sort((a, b) => b.tier - a.tier || b.minItemLevel - a.minItemLevel);
  const taken = new Set<string>();
  const out: G.EquippedItem[] = [];
  for (const base of bases) {
    if (taken.has(base.slot)) continue;
    taken.add(base.slot);
    for (let i = 0; i < (base.slot === 'ring' ? 2 : 1); i++) {
      const item = G.generateItem({ seed: rng.int(0, 2 ** 31), itemLevel, baseId: base.id, rarityId, classId: c })!;
      out.push({ ...item, effectId: undefined, upgradeLevel } as G.EquippedItem);
    }
  }
  return out;
}

const bestPass = new Map<G.ClassId, ReturnType<typeof searchBuilds>[number]>();
function best(c: G.ClassId) {
  let b = bestPass.get(c);
  if (!b) {
    b = searchBuilds(c, PASS_FARM_JOB.itemLevel, (items) => farmRate(c, items, PASS_FARM_JOB), setChassis(c))[0]!;
    bestPass.set(c, b);
  }
  return b;
}
const fmt = (s: ReturnType<typeof farm>) =>
  `${s.kpm.toFixed(1)}/min ${s.dph.toFixed(1)} deaths ${(100 * s.share).toFixed(0)}% xp ${Math.round(s.xph / 1000)}k gold ${Math.round(s.gph)} ore ${(s.mats.ironOre ?? 0).toFixed(0)} shards ${(s.mats.soulShard ?? 0).toFixed(0)}`;

if (mode === 'farm') {
  for (const c of G.CLASS_IDS) {
    const b = best(c);
    console.log(`${c}: ${describeBuild(b.build)}`);
    const kits: [string, G.EquippedItem[]][] = [
      ['best +10 Void', buildItems({ ...b.build, upgradeLevel: 10, void: true }, 27)],
      ['best +5', buildItems({ ...b.build, upgradeLevel: 5 }, 27)],
      ['legendary +10', plainKit(c, 27, 'legendary', 10)],
      ['rares +5', plainKit(c, 27, 'rare', 5)],
      ['T4 rares +5 @30', plainKit(c, 30, 'rare', 5)],
    ];
    for (const [name, items] of kits) {
      const pass = farm(c, 28, 'ashenPass', items);
      console.log(`  ${name} Pass 28: ${fmt(pass)}`);
      for (const level of [28, 31, 34]) console.log(`  ${name} Verge ${level}: ${fmt(farm(c, level, 'ashfallVerge', items))}`);
    }
  }
}
if (mode === 'xp') {
  for (const c of G.CLASS_IDS) {
    const items = process.env.KIT === 'legendary' ? plainKit(c, 27, 'legendary', 10) : buildItems({ ...best(c).build, upgradeLevel: 10, void: true }, 27);
    const row: string[] = [];
    for (let level = 28; level <= 46; level++) {
      const pass = farm(c, level, 'ashenPass', items).xph;
      const verge = farm(c, level, 'ashfallVerge', items).xph;
      const xph = Math.max(pass, verge);
      row.push(`${level}:${(G.xpToNextLevel(level) / xph).toFixed(1)}h`);
    }
    console.log(`${c} ${row.join(' ')}`);
  }
}
