// Ticket 8.2: the Hollow Deep (the Hollow Reach, levels 46–52) and the Hollow Sovereign against
// the best Pale Marches gear. Dev script; guards in balance/hollow-deep-balance.test.ts and
// balance/curve-pins-8-2.test.ts.
//   pnpm --filter @worldforge/server exec tsx ../../tools/balance/hollow-deep.ts farm|boss|xp
//   farm: per class, Marches Legendaries (tier 5, item level 45 and 47, +5 / +10, plain and
//         awakened) and the Depths' (39 +10) farming the Marches at 46 and the Deep at 46 / 49 / 52
//   boss: Hollow Sovereign win rates by gear and hero level (RUNS runs × KITS kit samples each)
//   xp:   hours per level from 44 to 60 for Marches Legendaries +10 farming the best open area
//   pace: the lanterns of the deep at 1–500 players (`reachTown`, and cap-bound with endless means)
import * as G from '../../packages/game-core/src/index.ts';
import {
  legendaryKit,
  legendarySample,
  upgraded,
} from '../../packages/game-core/src/balance/kits.ts';
import {
  ENDLESS,
  playTown,
  reachTown,
} from '../../packages/game-core/src/balance/community-town.ts';

const mode = process.argv[2] ?? 'farm';
const HOUR = 3_600_000;
const SEEDS = Number(process.env.SEEDS ?? 3);
const RUNS = Number(process.env.RUNS ?? 24);
const KITS = Number(process.env.KITS ?? 4);
const WORLD = { ...G.NO_WORLD_FLAGS, deepLanternsLit: true };

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
      seed: `hd:${c}:${level}:${s}`,
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
const fmt = (s: ReturnType<typeof farm>) =>
  `${s.kpm.toFixed(1)}/min ${s.dph.toFixed(1)}d ${(100 * s.share).toFixed(0)}% xp ${Math.round(s.xph / 1000)}k gold ${Math.round(s.gph)} ore ${(s.mats.ironOre ?? 0).toFixed(0)} sh ${(s.mats.soulShard ?? 0).toFixed(0)}`;

const awaken = (items: G.GeneratedItem[]): G.EquippedItem[] =>
  items.map((item) => {
    const r = G.awakenItem(item);
    return r.ok ? r.item : item;
  });

const GEAR: Record<string, (c: G.ClassId, k: number) => G.EquippedItem[]> = {
  'Depths L39 +10': (c, k) => upgraded(legendarySample(c, 39, k), 10),
  'Marches L47 +0': (c, k) => legendarySample(c, 47, k),
  'Marches L45 +5': (c, k) => upgraded(legendarySample(c, 45, k), 5),
  'Marches L47 +5': (c, k) => upgraded(legendarySample(c, 47, k), 5),
  'Marches L47 +10': (c, k) => upgraded(legendarySample(c, 47, k), 10),
  'Marches L47 +10 awk': (c, k) => awaken(upgraded(legendarySample(c, 47, k), 10)),
  'Deep L53 +10': (c, k) => upgraded(legendarySample(c, 53, k), 10),
};

function boss(c: G.ClassId, level: number, items: G.EquippedItem[], mod: G.BossModifierId | null) {
  let wins = 0,
    t = 0;
  for (let i = 0; i < RUNS; i++) {
    const r = G.simulateDungeonRun({
      dungeonId: 'hollowThrone',
      tier: 1,
      character: { classId: c, level, xp: 0 },
      equipment: items,
      seed: `sov:${c}:${level}:${i}`,
      bossLootEligible: false,
      inventoryCount: 0,
      bossModifier: mod,
    });
    if (r.bossDefeated) {
      wins++;
      const e = r.encounters.at(-1)!;
      t += e.endMs - e.startMs;
    }
  }
  return { wins, t };
}

if (mode === 'farm') {
  const names = (process.env.GEAR ?? 'Depths L39 +10,Marches L45 +5,Marches L47 +10').split(',');
  for (const c of G.CLASS_IDS) {
    for (const name of names) {
      const items = GEAR[name]!(c, 0);
      console.log(
        `${c.padEnd(8)} ${name.padEnd(20)} Marches 46: ${fmt(farm(c, 46, 'paleMarches', items))}`,
      );
      for (const level of [46, 49, 52])
        console.log(`${''.padEnd(29)} Deep ${level}: ${fmt(farm(c, level, 'hollowDeep', items))}`);
    }
  }
}
if (mode === 'boss') {
  const levels = (process.env.LEVELS ?? '48,50,52').split(',').map(Number);
  const names = (process.env.GEAR ?? Object.keys(GEAR).join(',')).split(',');
  const mod = (process.env.MOD ?? null) as G.BossModifierId | null;
  for (const name of names) {
    const all = levels.map(() => ({ w: 0, n: 0 }));
    for (const c of G.CLASS_IDS) {
      const row = levels.map((l, li) => {
        let w = 0,
          t = 0;
        for (let k = 0; k < KITS; k++) {
          const b = boss(c, l, GEAR[name]!(c, k), mod);
          w += b.wins;
          t += b.t;
        }
        all[li]!.w += w;
        all[li]!.n += RUNS * KITS;
        return `${l}: ${((100 * w) / (RUNS * KITS)).toFixed(0).padStart(3)}% (${w ? (t / w / 1000).toFixed(0) : '-'}s)`;
      });
      console.log(`${name.padEnd(20)} ${c.padEnd(8)} ${row.join('  ')}`);
    }
    console.log(
      `${name.padEnd(20)} mean     ${levels.map((l, i) => `${l}: ${((100 * all[i]!.w) / all[i]!.n).toFixed(0)}%`).join('  ')}`,
    );
  }
}
if (mode === 'xp') {
  for (const c of G.CLASS_IDS) {
    const items = upgraded(legendaryKit(c, 47), 10);
    const row: string[] = [];
    for (let level = 44; level <= 60; level += 2) {
      const xph = Math.max(
        farm(c, level, 'paleMarches', items).xph,
        farm(c, level, 'hollowDeep', items).xph,
      );
      row.push(`${level}:${(G.xpToNextLevel(level) / xph).toFixed(1)}h`);
    }
    console.log(`${c} ${row.join(' ')}`);
  }
}
if (mode === 'pace') {
  const project = G.findCommunityProject('deepLanterns')!;
  for (const n of [1, 3, 5, 10, 20, 100, 500]) {
    for (const [k, t] of [
      ['gathering', reachTown(n)],
      ['cap-bound', Array.from({ length: n }, () => ENDLESS)],
    ] as const) {
      const r = playTown(t, G.COMMUNITY_PROJECT_CONFIG, [project], 200);
      const done = r.length === 3 ? r[2]!.doneOn + 1 : Infinity;
      const stages = r.map(
        (x) =>
          `${x.doneOn - x.firstDay + 1} d, ${x.givers} givers, top ${Math.round(x.topGiverShare * 100)} %`,
      );
      console.log(`${String(n).padStart(3)} ${k.padEnd(9)} ${done} d: ${stages.join(' | ')}`);
    }
  }
}
void WORLD;
