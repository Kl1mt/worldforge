// The top end (ticket 4.8): farming the Ashen Pass and the Abbey with generated kits and with the
// best B.2 builds, and the Ashen Warden's win rates. Dev script; the guards are in balance/*.test.ts.
//   pnpm --filter @worldforge/server exec tsx ../../tools/balance/ashen-pass.ts [farm|builds|warden]
import * as G from '../../packages/game-core/src/index.ts';
import {
  searchBuilds,
  setChassis,
  describeBuild,
} from '../../packages/game-core/src/balance/builds.ts';

const HOUR = 3_600_000;
const SEEDS = ['ap-a', 'ap-b'];
function kit(c: G.ClassId, itemLevel: number, rarityId: G.RarityId = 'common'): G.GeneratedItem[] {
  const level = Math.max(1, itemLevel);
  const rng = G.createRng(`kit:${c}:${level}:${rarityId}`);
  const bases = G.ITEM_BASES.filter(
    (b) => !b.unique && b.minItemLevel <= level && G.canClassUseItem(b, c),
  ).sort((a, b) => b.tier - a.tier || b.minItemLevel - a.minItemLevel);
  const taken = new Set<string>();
  const out: G.GeneratedItem[] = [];
  for (const base of bases) {
    if (taken.has(base.slot)) continue;
    taken.add(base.slot);
    for (let i = 0; i < (base.slot === 'ring' ? 2 : 1); i++)
      out.push(
        G.generateItem({
          seed: rng.int(0, 2 ** 31),
          itemLevel: level,
          baseId: base.id,
          rarityId,
          classId: c,
        })!,
      );
  }
  return out;
}
/** Every kit slot as a Legendary with an effect rolled for the class (as in balance.test.ts). */
const legKit = (c: G.ClassId, il: number) =>
  kit(c, il, 'legendary').map((i) =>
    G.generateItem({
      seed: i.seed,
      itemLevel: il,
      baseId: i.baseId,
      rarityId: 'legendary',
      classId: c,
    })!,
  );
const up = (items: G.GeneratedItem[], u: number) => items.map((i) => ({ ...i, upgradeLevel: u }));
function farm(
  c: G.ClassId,
  level: number,
  areaId: G.AreaId,
  equipment: G.EquippedItem[],
  ms = HOUR,
) {
  let deaths = 0,
    kills = 0,
    share = 0,
    enc = 0,
    xp = 0,
    gold = 0;
  for (const seed of SEEDS) {
    const r = G.settleFarming({
      character: { classId: c, level, xp: 0 },
      equipment,
      areaId,
      seed,
      firstCycle: 0,
      durationMs: ms,
      inventoryCount: 0,
    });
    deaths += r.deaths;
    kills += r.kills;
    share += r.damageTaken / r.maxHealth;
    enc += r.encounters;
    xp += r.xpGained;
    gold += r.goldLooted;
  }
  const h = (ms / HOUR) * SEEDS.length;
  return { d: deaths / h, k: kills / (h * 60), s: share / enc, xp: xp / h, gold: gold / h };
}
const fmt = (x: ReturnType<typeof farm>) =>
  `${x.k.toFixed(1)}k ${x.d.toFixed(1)}d ${(x.s * 100).toFixed(0)}%`;
const mode = process.argv[2] ?? 'farm';
if (mode === 'farm') {
  const kits: [string, (c: G.ClassId, il: number) => G.GeneratedItem[]][] = [
    ['common', (c, il) => kit(c, il)],
    ['rare', (c, il) => kit(c, il, 'rare')],
    ['rare+5', (c, il) => up(kit(c, il, 'rare'), 5)],
    ['epic+5', (c, il) => up(kit(c, il, 'epic'), 5)],
    ['leg+10', (c, il) => up(kit(c, il, 'legendary'), 10)],
  ];
  const where: [G.AreaId, number][] = [
    ['sunkenAbbey', 22],
    ['ashenPass', 24],
    ['ashenPass', 26],
    ['ashenPass', 28],
  ];
  for (const [a, l] of where) {
    console.log(`${a} L${l}`);
    for (const [name, k] of kits) {
      const row = G.CLASS_IDS.map((c) => fmt(farm(c, l, a, k(c, l - 1))));
      console.log(`  ${name.padEnd(8)} ${row.join(' | ')}`);
    }
  }
}
if (mode === 'builds') {
  const job = (a: G.AreaId, level: number, il: number) => (c: G.ClassId) =>
    searchBuilds(c, il, (items) => farm(c, level, a, items, 40 * 60_000).k, setChassis(c));
  for (const c of G.CLASS_IDS) {
    for (const [a, l] of [
      ['sunkenAbbey', 19],
      ['ashenPass', 26],
    ] as [G.AreaId, number][]) {
      const s = job(a, l, l - 1)(c);
      const best = s[0]!;
      const worst = s.at(-1)!;
      const rare5 = farm(c, l, a, up(kit(c, l - 1, 'rare'), 5), 40 * 60_000).k;
      const within = s.filter((x) => x.score >= best.score * 0.93).length;
      console.log(
        `${c} ${a} L${l}: best ${best.score.toFixed(1)} (${describeBuild(best.build)}) worst ${worst.score.toFixed(1)} rare+5 ${rare5.toFixed(1)} within7% ${within}/${s.length}`,
      );
    }
  }
}
if (mode === 'warden') {
  const N = Number(process.env.N ?? 24);
  const kits: [string, (c: G.ClassId, il: number) => G.EquippedItem[]][] = [
    ['rare+5', (c, il) => up(kit(c, il, 'rare'), 5)],
    ['epic+5', (c, il) => up(kit(c, il, 'epic'), 5)],
    ['epic+10', (c, il) => up(kit(c, il, 'epic'), 10)],
    ['leg', (c, il) => legKit(c, il)],
    ['leg+5', (c, il) => up(legKit(c, il), 5)],
    ['leg+10', (c, il) => up(legKit(c, il), 10)],
  ];
  for (const l of [26, 27, 28]) {
    for (const [name, k] of kits) {
      const row = G.CLASS_IDS.map((c) => {
        let w = 0,
          t = 0;
        for (let i = 0; i < N; i++) {
          const r = G.simulateDungeonRun({
            dungeonId: 'ashenWatch',
            character: { classId: c, level: l, xp: 0 },
            equipment: k(c, l - 1),
            seed: `w:${i}`,
            bossLootEligible: false,
            inventoryCount: 0,
          });
          const b = r.encounters.at(-1)!;
          if (r.bossDefeated) {
            w++;
            t += b.endMs - b.startMs;
          }
        }
        return `${Math.round((100 * w) / N)}%${w ? ` ${(t / w / 1000).toFixed(0)}s` : ''}`;
      });
      console.log(`L${l} ${name.padEnd(8)} ${row.join(' | ')}`);
    }
  }
}
if (mode === 'tier3') {
  // Crypt tier III with the balance test's generated kits (32 runs per class).
  const N = Number(process.env.N ?? 32);
  const kits: [string, (c: G.ClassId, il: number) => G.EquippedItem[]][] = [
    ['rare', (c, il) => kit(c, il, 'rare')],
    ['rare+5', (c, il) => up(kit(c, il, 'rare'), 5)],
    ['rare+8', (c, il) => up(kit(c, il, 'rare'), 8)],
    ['epic', (c, il) => kit(c, il, 'epic')],
    ['epic+5', (c, il) => up(kit(c, il, 'epic'), 5)],
    ['epic+8', (c, il) => up(kit(c, il, 'epic'), 8)],
    ['leg', (c, il) => legKit(c, il)],
    ['leg+5', (c, il) => up(legKit(c, il), 5)],
    ['leg+10', (c, il) => up(legKit(c, il), 10)],
  ];
  const only = process.env.KITS?.split(',');
  for (const l of (process.env.LEVELS ?? '21,22,23').split(',').map(Number)) {
    for (const [name, k] of kits.filter(([n]) => !only || only.includes(n))) {
      const row = G.CLASS_IDS.map((c) => {
        let w = 0;
        for (let i = 0; i < N; i++) {
          const r = G.simulateDungeonRun({
            dungeonId: 'namelessCrypt',
            tier: 3,
            character: { classId: c, level: l, xp: 0 },
            equipment: k(c, l - 1),
            seed: `crypt-balance:${i}`,
            bossLootEligible: true,
            inventoryCount: 0,
          });
          if (r.bossDefeated) w++;
        }
        return Math.round((100 * w) / N);
      });
      console.log(
        `L${l} ${name.padEnd(7)} ${row.join('/')} (mean ${Math.round(row.reduce((a, b) => a + b) / 4)})`,
      );
    }
  }
}
