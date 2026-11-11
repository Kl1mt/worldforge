// Ticket 8.1: the Pale Marches (the Hollow Reach, levels 40–46) against today's best gear.
// Dev script; guards in balance/balance.test.ts "the Pale Marches" and
// balance/curve-pins-8-1.test.ts.
//   pnpm --filter @worldforge/server exec tsx ../../tools/balance/pale-marches.ts farm|xp|traits
//   farm:   per class, today's best kits (the Depths' plain Legendaries at item level 39, the
//           Tyrant's hoard at 41 and Heroic at 37, all tier 4, +10; awakened; the best Pass build in
//           Depths drops at +10 Void) farming the Depths at 40 and the Marches at 40 / 43 / 46
//   xp:     hours per level from 38 to 58 for the best build farming the best open area
//   traits: what each foe's trait costs (the Marches at 43 with and without the traits)
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
      seed: `pm:${c}:${level}:${s}`,
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

/** One item per slot of the best base up to `maxTier` (balance.test.ts's kit, tier-capped). */
function plainKit(
  c: G.ClassId,
  itemLevel: number,
  rarityId: G.RarityId,
  upgradeLevel: number,
  maxTier = 5,
): G.EquippedItem[] {
  const rng = G.createRng(`pm-kit:${c}:${itemLevel}:${rarityId}:${maxTier}`);
  const bases = G.ITEM_BASES.filter(
    (b) =>
      !b.unique && b.tier <= maxTier && b.minItemLevel <= itemLevel && G.canClassUseItem(b, c),
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
      out.push({ ...item, upgradeLevel } as G.EquippedItem);
    }
  }
  return out;
}

const awaken = (items: G.EquippedItem[]) =>
  items.map((item) => {
    const r = G.awakenItem(item as never);
    return (r.ok ? r.item : item) as G.EquippedItem;
  });

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
  const depths = plainKit(c, 39, 'legendary', 10, 4);
  return [
    ['depths rares +5', plainKit(c, 39, 'rare', 5, 4)],
    ['depths epics +10', plainKit(c, 39, 'epic', 10, 4)],
    ['depths leg +5', plainKit(c, 39, 'legendary', 5, 4)],
    ['depths leg +10', depths],
    ['depths leg +10 awake', awaken(depths)],
    ['tyrant leg +10', plainKit(c, 41, 'legendary', 10, 4)],
    ['heroic leg +10', plainKit(c, 37, 'legendary', 10, 4)],
    ['best +10 Void', buildItems({ ...best(c).build, upgradeLevel: 10, void: true }, 39)],
    ['own leg +5 (45)', plainKit(c, 45, 'legendary', 5, 5)],
    ['own leg +10 (45)', plainKit(c, 45, 'legendary', 10, 5)],
  ];
}

if (mode === 'farm') {
  const only = process.env.KITS?.split(',');
  const classes = process.env.CLASSES?.split(',') ?? G.CLASS_IDS;
  for (const c of classes as G.ClassId[]) {
    console.log(`${c}: ${describeBuild(best(c).build)}`);
    for (const [name, items] of kits(c)) {
      if (only && !only.includes(name)) continue;
      console.log(`  ${name.padEnd(20)} Depths 40: ${fmt(farm(c, 40, 'cinderDepths', items))}`);
      for (const level of [40, 43, 46])
        console.log(
          `  ${name.padEnd(20)} Marches ${level}: ${fmt(farm(c, level, 'paleMarches', items))}`,
        );
    }
  }
}
if (mode === 'xp') {
  for (const c of G.CLASS_IDS) {
    const items = buildItems({ ...best(c).build, upgradeLevel: 10, void: true }, 39);
    const row: string[] = [];
    for (let level = 38; level <= 58; level++) {
      const areas: G.AreaId[] = level >= 40 ? ['cinderDepths', 'paleMarches'] : ['cinderDepths'];
      const xph = Math.max(...areas.map((a) => farm(c, level, a, items).xph));
      row.push(`${level}:${(G.xpToNextLevel(level) / xph).toFixed(1)}h`);
    }
    console.log(`${c} ${row.join(' ')}`);
  }
}
