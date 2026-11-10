// Ticket 6.3: the Heroic crypt (tier IV) and the weekly boss modifiers, measured with game-core.
// Dev script; guards in balance/heroic-balance.test.ts.
//   pnpm --filter @worldforge/server exec tsx ../../tools/balance/heroic.ts heroic|modifiers|odds|guild
//   heroic:    Heroic win rates by gear and level (RUNS runs per class), no modifier and each one
//   modifiers: every boss's reference kits with no modifier and each modifier
//   odds:      Heroic loot against tier III (RUNS runs × classes, boss loot eligible)
//   guild:     guild boss damage per attempt, no modifier and each one
import * as G from '../../packages/game-core/src/index.ts';
import {
  kit,
  legendaryKit,
  rates,
  upgraded,
  winRate,
} from '../../packages/game-core/src/balance/kits.ts';

const mode = process.argv[2] ?? 'heroic';
const RUNS = Number(process.env.RUNS ?? 24);
const MODS: (G.BossModifierId | null)[] = [null, ...G.BOSS_MODIFIER_IDS];
const pct = (x: number) => `${Math.round(x * 100)}`;

function runs(
  dungeonId: G.DungeonId,
  tier: G.DungeonTier,
  c: G.ClassId,
  level: number,
  gear: G.GeneratedItem[],
  mod: G.BossModifierId | null,
  n = RUNS,
) {
  return Array.from({ length: n }, (_, i) =>
    G.simulateDungeonRun({
      dungeonId,
      tier,
      character: { classId: c, level, xp: 0 },
      equipment: gear,
      seed: `heroic-balance:${i}`,
      bossLootEligible: false,
      inventoryCount: 0,
      bossModifier: mod,
    }),
  );
}

function row(label: string, f: (c: G.ClassId) => number) {
  const r = rates(f);
  return `${label.padEnd(34)} ${G.CLASS_IDS.map((c) => pct(r.per[c])).join('/')} (${pct(r.mean)})`;
}

type Gear = [string, (c: G.ClassId) => G.GeneratedItem[]];
const VERGE_IL = 33;
const heroicGear: Gear[] = [
  ['epics +10 (il 33)', (c) => upgraded(kit(c, VERGE_IL, 'epic'), 10)],
  ['Legendaries (il 33)', (c) => legendaryKit(c, VERGE_IL)],
  ['Legendaries +5 (il 33)', (c) => upgraded(legendaryKit(c, VERGE_IL), 5)],
  ['Legendaries +10 (il 33)', (c) => upgraded(legendaryKit(c, VERGE_IL), 10)],
  ['plain Legendaries +10 (il 33)', (c) => upgraded(kit(c, VERGE_IL, 'legendary'), 10)],
  ['Legendaries +10 (il 39)', (c) => upgraded(legendaryKit(c, 39), 10)],
];

if (mode === 'heroic') {
  for (const level of [32, 34, 36]) {
    console.log(`\nHeroic at level ${level}`);
    for (const [label, gear] of heroicGear)
      console.log(row(label, (c) => winRate(runs('namelessCrypt', 4, c, level, gear(c), null))));
    // Tier III at the same kit, for comparison.
    console.log(
      row('tier III, Legendaries (il 33)', (c) =>
        winRate(runs('namelessCrypt', 3, c, level, legendaryKit(c, VERGE_IL), null)),
      ),
    );
  }
}

/** Each boss with its reference kits at its entry (the kits its own balance suite uses). */
const BOSSES: {
  id: string;
  dungeonId: G.DungeonId;
  tier: G.DungeonTier;
  level: number;
  gear: Gear[];
}[] = [
  {
    id: 'crypt I',
    dungeonId: 'namelessCrypt',
    tier: 1,
    level: 14,
    gear: [
      ['commons (il 13)', (c) => kit(c, 13)],
      ['uncommons (il 12)', (c) => kit(c, 12, 'uncommon')],
    ],
  },
  {
    id: 'crypt II',
    dungeonId: 'namelessCrypt',
    tier: 2,
    level: 18,
    gear: [
      ['rares (il 17)', (c) => kit(c, 17, 'rare')],
      ['rares +5 (il 17)', (c) => upgraded(kit(c, 17, 'rare'), 5)],
    ],
  },
  {
    id: 'crypt III',
    dungeonId: 'namelessCrypt',
    tier: 3,
    level: 21,
    gear: [
      ['epics +8 (il 20)', (c) => upgraded(kit(c, 20, 'epic'), 8)],
      ['Legendaries (il 20)', (c) => legendaryKit(c, 20)],
    ],
  },
  {
    id: 'Heroic',
    dungeonId: 'namelessCrypt',
    tier: 4,
    level: 34,
    gear: [
      ['Legendaries +5 (il 33)', (c) => upgraded(legendaryKit(c, 33), 5)],
      ['Legendaries +10 (il 33)', (c) => upgraded(legendaryKit(c, 33), 10)],
    ],
  },
  {
    id: 'Ashen Warden',
    dungeonId: 'ashenWatch',
    tier: 1,
    level: 26,
    gear: [
      ['Legendaries (il 25)', (c) => legendaryKit(c, 25)],
      ['Legendaries +5 (il 25)', (c) => upgraded(legendaryKit(c, 25), 5)],
    ],
  },
  {
    id: 'Forge Tyrant',
    dungeonId: 'tyrantsForge',
    tier: 1,
    level: 36,
    gear: [
      ['Legendaries +5 (il 33)', (c) => upgraded(legendaryKit(c, 33), 5)],
      ['Legendaries +10 (il 33)', (c) => upgraded(legendaryKit(c, 33), 10)],
    ],
  },
];

if (mode === 'modifiers') {
  for (const b of BOSSES) {
    console.log(`\n${b.id} at level ${b.level}`);
    for (const [label, gear] of b.gear)
      for (const mod of MODS)
        console.log(
          row(`${label} · ${mod ?? 'none'}`, (c) =>
            winRate(runs(b.dungeonId, b.tier, c, b.level, gear(c), mod)),
          ),
        );
  }
}

if (mode === 'guild') {
  const cases: Gear[] = [
    ['L14 commons', (c) => kit(c, 13)],
    ['L21 epics', (c) => kit(c, 20, 'epic')],
    ['L28 Legendaries +10', (c) => upgraded(legendaryKit(c, 27), 10)],
  ];
  const levels = [14, 21, 28];
  for (const [i, [label, gear]] of cases.entries())
    for (const mod of MODS) {
      const per = G.CLASS_IDS.map((c) => {
        let dmg = 0;
        for (let s = 0; s < RUNS; s++)
          dmg += G.simulateGuildBossAttempt({
            bossId: 'risenGravewarden',
            character: { classId: c, level: levels[i]! },
            equipment: gear(c),
            seed: `gb-balance:${s}`,
            bossModifier: mod,
          }).damage;
        return Math.round(dmg / RUNS);
      });
      console.log(`${(label + ' · ' + (mod ?? 'none')).padEnd(34)} ${per.join(' / ')}`);
    }
}

if (mode === 'odds') {
  const top = (tier: G.DungeonTier, level: number) => {
    let items = 0,
      leg = 0,
      myth = 0,
      set = 0,
      vd = 0,
      maxIl = 0;
    const n = RUNS;
    for (const c of G.CLASS_IDS)
      for (let i = 0; i < n; i++) {
        const r = G.simulateDungeonRun({
          dungeonId: 'namelessCrypt',
          tier,
          character: { classId: c, level, xp: 0 },
          equipment: upgraded(legendaryKit(c, 39), 10),
          seed: `odds:${c}:${i}`,
          bossLootEligible: true,
          inventoryCount: 0,
        });
        for (const it of [...r.items, ...r.salvaged]) {
          items++;
          if (it.rarityId === 'legendary' && !it.setId) leg++;
          if (it.rarityId === 'mythic') myth++;
          if (it.setId) set++;
          if (it.variant === 'void') vd++;
          maxIl = Math.max(maxIl, it.itemLevel);
        }
      }
    const runsN = n * G.CLASS_IDS.length;
    const f = (x: number) => (x / runsN).toFixed(3);
    console.log(
      `tier ${tier} at ${level}: items/run ${f(items)}, Legendaries ${f(leg)}, Mythics ${f(myth)}, set ${f(set)}, Void ${f(vd)}, top share ${(((leg + myth + set) / items) * 100).toFixed(1)} %, max item level ${maxIl}`,
    );
  };
  top(3, 24);
  top(4, 36);
}
