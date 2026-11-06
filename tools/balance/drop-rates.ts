// Legendary, set, Mythic and Void drop rates (ticket B.2): a geared hero (rare kit) farming the
// Sunken Abbey at 20 and Blackwater at 15 (1,200 h each), and crypt runs per tier (4,000 each).
import * as G from '../../packages/game-core/src/index.ts';

const HOUR = 3_600_000;
const kitOf = (c: G.ClassId, il: number) => {
  const rng = G.createRng(`kit:${c}:${il}`);
  const bases = G.ITEM_BASES.filter(
    (b) => !b.unique && b.minItemLevel <= il && G.canClassUseItem(b, c),
  ).sort((a, b) => b.tier - a.tier || b.minItemLevel - a.minItemLevel);
  const taken = new Set<string>();
  const out: G.GeneratedItem[] = [];
  for (const b of bases) {
    if (taken.has(b.slot)) continue;
    taken.add(b.slot);
    for (let i = 0; i < (b.slot === 'ring' ? 2 : 1); i++) {
      out.push(
        G.generateItem({
          seed: rng.int(0, 2 ** 31),
          itemLevel: il,
          baseId: b.id,
          rarityId: 'rare',
        })!,
      );
    }
  }
  return out;
};
const kind = (i: G.GeneratedItem) =>
  i.mythicId ? 'mythic' : i.setId ? 'set' : i.rarityId === 'legendary' ? 'legendary' : 'other';
const count = (items: G.GeneratedItem[], acc: Record<string, number>) => {
  for (const i of items) {
    acc[kind(i)] = (acc[kind(i)] ?? 0) + 1;
    if (i.variant === 'void') acc.void = (acc.void ?? 0) + 1;
    acc.items = (acc.items ?? 0) + 1;
  }
};
const show = (acc: Record<string, number>, n: number, unit: string) =>
  ['items', 'legendary', 'set', 'mythic', 'void']
    .map((k) => `${k} ${((acc[k] ?? 0) / n).toFixed(4)}/${unit}`)
    .join(' · ');

for (const [area, level] of [
  ['sunkenAbbey', 20],
  ['blackwater', 15],
] as const) {
  const acc: Record<string, number> = {};
  for (const c of G.CLASS_IDS) {
    for (let k = 0; k < 30; k++) {
      const r = G.settleFarming({
        character: { classId: c, level, xp: 0 },
        areaId: area,
        equipment: kitOf(c, level - 1),
        seed: `drops:${area}:${c}:${k}`,
        firstCycle: 0,
        durationMs: 10 * HOUR,
        inventoryCount: 0,
      });
      count([...r.items, ...r.salvaged], acc);
    }
  }
  console.log(`${area} at ${level}: ${show(acc, 1200, 'h')}`);
}
for (const [tier, level] of [
  [1, 15],
  [2, 21],
  [3, 23],
] as const) {
  const acc: Record<string, number> = {};
  let wins = 0;
  const N = 4000;
  for (let k = 0; k < N; k++) {
    const c = G.CLASS_IDS[k % 4]!;
    const r = G.simulateDungeonRun({
      dungeonId: 'namelessCrypt',
      tier,
      character: { classId: c, level, xp: 0 },
      equipment: kitOf(c, level - 1).map((i) => ({ ...i, rarityId: 'legendary' as const })),
      seed: `dr:${tier}:${k}`,
      bossLootEligible: true,
      inventoryCount: 0,
    });
    count([...r.items, ...r.salvaged], acc);
    if (r.bossDefeated) wins++;
  }
  console.log(
    `crypt tier ${tier} at ${level}: ${show(acc, N, 'run')} · wins ${(wins / N).toFixed(3)}`,
  );
}
