// Ticket B.3: weekly guild-boss totals for small and full guilds (counted damage, stage reached).
//   pnpm --filter @worldforge/server exec tsx ../../tools/balance/guild-boss.ts
import * as G from '../../packages/game-core/src/index.ts';

const boss = G.getGuildBoss('risenGravewarden');
function kit(c: G.ClassId, il: number, rarityId: G.RarityId, upgradeLevel = 0) {
  const rng = G.createRng(`gb-kit:${c}:${il}:${rarityId}`);
  const bases = G.ITEM_BASES.filter(
    (b) => !b.unique && b.minItemLevel <= il && G.canClassUseItem(b, c),
  ).sort((a, b) => b.tier - a.tier || b.minItemLevel - a.minItemLevel);
  const taken = new Set<string>();
  const out: G.EquippedItem[] = [];
  for (const base of bases) {
    if (taken.has(base.slot)) continue;
    taken.add(base.slot);
    for (let i = 0; i < (base.slot === 'ring' ? 2 : 1); i++) {
      const item = G.generateItem({
        seed: rng.int(0, 2 ** 31),
        itemLevel: il,
        baseId: base.id,
        rarityId,
      })!;
      out.push({ ...item, upgradeLevel });
    }
  }
  return out;
}
const kits: [string, number, G.RarityId, number][] = [
  ['L12 commons', 12, 'common', 0],
  ['L14 commons', 14, 'common', 0],
  ['L16 uncommons', 16, 'uncommon', 0],
  ['L18 rares', 18, 'rare', 0],
  ['L18 rares+5', 18, 'rare', 5],
  ['L21 epics', 21, 'epic', 0],
  ['L21 epics+5', 21, 'epic', 5],
  ['L24 legendary', 24, 'legendary', 0],
  ['L26 legendary+5', 26, 'legendary', 5],
];
const perAttempt = new Map<string, number>();
for (const [name, level, r, u] of kits) {
  let sum = 0;
  let n = 0;
  for (const c of G.CLASS_IDS) {
    for (let i = 0; i < 12; i++) {
      sum += G.simulateGuildBossAttempt({
        bossId: boss.id,
        character: { classId: c, level },
        equipment: kit(c, level - 1, r, u),
        seed: `b3:${c}:${i}`,
      }).counted;
      n++;
    }
  }
  perAttempt.set(name, sum / n);
}
console.log(
  'stages',
  boss.stages.map((s) => s.threshold).join(' / '),
  'cap',
  boss.attemptDamageCap,
);
for (const [name, d] of perAttempt) {
  const week = (size: number) => d * size * G.GUILD_BOSS_ATTEMPTS_PER_WEEK;
  const row = [1, 3, 4, 5, 10, 30].map(
    (s) => `${s}: ${Math.round(week(s) / 1000)}k (st ${G.guildBossStageOf(boss, week(s))})`,
  );
  console.log(`${name.padEnd(16)} ${Math.round(d)}/attempt  ${row.join('  ')}`);
}
