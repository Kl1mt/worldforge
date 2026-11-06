// Crypt win rates with farmed gear (ticket B.2): farm the matching area for HOURS (real
// settlement), wear the best drop per slot, upgrade it to UPS, then run the tier (12 seeds).
import * as G from '../../packages/game-core/src/index.ts';

const HOUR = 3_600_000;
const IMPL: Record<string, number> = {
  common: 1,
  uncommon: 1.1,
  rare: 1.2,
  epic: 1.35,
  legendary: 1.5,
  mythic: 1.7,
};
const power = (i: G.GeneratedItem) =>
  (i.itemLevel + 5) * IMPL[i.rarityId]! * (1 + i.affixes.length * 0.08);
function farmedKit(
  c: G.ClassId,
  level: number,
  area: G.AreaId,
  hours: number,
  seed: string,
  up: number,
) {
  const r = G.settleFarming({
    character: { classId: c, level, xp: 0 },
    areaId: area,
    equipment: [],
    seed,
    firstCycle: 0,
    durationMs: hours * HOUR,
    inventoryCount: 0,
  });
  const drops = [...r.items, ...r.salvaged].filter((i) =>
    G.canClassUseItem(G.getItemBase(i.baseId), c),
  );
  const kit: G.GeneratedItem[] = [];
  for (const slot of [
    'weapon',
    'offhand',
    'head',
    'chest',
    'hands',
    'feet',
    'neck',
    'ring',
    'ring',
  ]) {
    const cands = drops
      .filter((d) => G.getItemBase(d.baseId).slot === slot && !kit.includes(d))
      .sort((a, b) => power(b) - power(a));
    if (cands[0]) kit.push(cands[0]);
  }
  return kit.map((i) => ({ ...i, upgradeLevel: up }));
}
const tiers: [1 | 2 | 3, number, G.AreaId][] = [
  [1, 12, 'oldBurialGrounds'],
  [1, 13, 'oldBurialGrounds'],
  [1, 14, 'blackwater'],
  [2, 18, 'sunkenAbbey'],
  [2, 19, 'sunkenAbbey'],
  [2, 20, 'sunkenAbbey'],
  [3, 21, 'sunkenAbbey'],
  [3, 22, 'sunkenAbbey'],
  [3, 23, 'sunkenAbbey'],
];
const hoursList = (process.env.HOURS ?? '10,30').split(',').map(Number);
const ups = (process.env.UPS ?? '0,5,8').split(',').map(Number);
const N = 12;
for (const [tier, level, area] of tiers) {
  const row: string[] = [];
  for (const h of hoursList)
    for (const up of ups) {
      const wins = G.CLASS_IDS.map((c) => {
        let w = 0;
        for (let k = 0; k < N; k++) {
          const kit = farmedKit(c, level - 1, area, h, `fk:${c}:${level}:${h}:${k}`, up);
          const run = G.simulateDungeonRun({
            dungeonId: 'namelessCrypt',
            tier,
            character: { classId: c, level, xp: 0 },
            equipment: kit,
            seed: `fkrun:${k}`,
            bossLootEligible: false,
            inventoryCount: 0,
          });
          if (run.bossDefeated) w++;
        }
        return Math.round((100 * w) / N);
      });
      row.push(`${h}h+${up}: ${wins.join('/')}`);
    }
  console.log(`tier ${tier} L${level} (${area})  ${row.join('  |  ')}`);
}
