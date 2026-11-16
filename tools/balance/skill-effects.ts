// Ticket 9.3: the skill quests' rewards (the skill-aware Legendaries and the Masters' Lessons),
// measured on 9.1's jobs (docs/EFFECTS.md "Skill-aware effects"). Dev script; guards in
// packages/game-core/src/quests/skill-quests.test.ts.
//   pnpm --filter @worldforge/server exec tsx ../../tools/balance/skill-effects.ts
// Per class: the default loadout and the leading farming and boss loadouts (docs/SKILLS.md), in
// today's kit (before) and with a ring and the neck swapped for the two quest rewards at +10, at
// their best roll, the best of the nine effect pairs (after). CLASSES=warrior,mage
import * as G from '../../packages/game-core/src/index.ts';
import {
  BOSS_JOBS,
  FARM_JOBS,
  bossTime,
  farmRate,
  type LoadoutBossJob,
  type LoadoutFarmJob,
} from '../../packages/game-core/src/balance/loadouts.ts';

const CLASSES = (process.env.CLASSES?.split(',') ?? G.CLASS_IDS) as G.ClassId[];
const f1 = (x: number) => x.toFixed(1);
const f2 = (x: number) => x.toFixed(2);

const LEAD: Record<G.ClassId, { farm: G.Loadout; boss: G.Loadout }> = {
  warrior: {
    farm: { actives: ['heavyStrike', 'charge', 'execute'], passive: 'berserker' },
    boss: { actives: ['heavyStrike', 'execute', 'earthsplitter'], passive: 'juggernaut' },
  },
  mage: {
    farm: { actives: ['firebolt', 'pyroblast', 'shatter'], passive: 'arcanePower' },
    boss: { actives: ['firebolt', 'meteor', 'emberstorm'], passive: 'kindling' },
  },
  hunter: {
    farm: { actives: ['aimedShot', 'volley', 'killShot'], passive: 'skirmisher' },
    boss: { actives: ['aimedShot', 'volley', 'trueShot'], passive: 'eagleEye' },
  },
  warlock: {
    farm: { actives: ['shadowBolt', 'corruption', 'soulBurn'], passive: 'darkPact' },
    boss: { actives: ['shadowBolt', 'doom', 'drainSoul'], passive: 'malice' },
  },
};

const EFFECT_IDS = ['practiced-hand', 'festering-craft', 'deep-wellspring'];

function questItem(baseId: string, effectId: string, c: G.ClassId): G.GeneratedItem {
  // One roll of the item for every effect (affixes fixed), so only the effect differs.
  const q = G.SKILL_QUESTS.find((x) => x.item.baseId === baseId)!;
  const item = G.generateItem({ seed: 1, ...q.item, classId: c })!;
  return { ...item, effectId, effectRoll: 1, upgradeLevel: 10 };
}

function swap(kit: G.GeneratedItem[], items: G.GeneratedItem[]): G.GeneratedItem[] {
  const slots = items.map((i) => G.getItemBase(i.baseId).slot);
  const done = new Set<string>();
  const out = kit.filter((i) => {
    const s = G.getItemBase(i.baseId).slot;
    if (slots.includes(s) && !done.has(s)) return !done.add(s);
    return true;
  });
  return [...out, ...items];
}

/** The quest items without their effects and set: the stats alone (the control). */
const plain = (c: G.ClassId) =>
  [
    questItem('masters-ember-band', 'practiced-hand', c),
    questItem('masters-hollow-torc', 'practiced-hand', c),
  ].map((i) => {
    const out = { ...i };
    delete out.effectId;
    delete out.effectRoll;
    delete out.setId;
    return out;
  });

const pairs = (c: G.ClassId) =>
  EFFECT_IDS.flatMap((a) =>
    EFFECT_IDS.map((b) => ({
      label: `${a} + ${b}`,
      items: [questItem('masters-ember-band', a, c), questItem('masters-hollow-torc', b, c)],
    })),
  );

const farm = FARM_JOBS.find((j) => j.id === 'deep49')!;
const boss = BOSS_JOBS.find((j) => j.id === 'sovereign50')!;
const withGear = <J extends LoadoutFarmJob | LoadoutBossJob>(
  job: J,
  items: G.GeneratedItem[],
): J => ({
  ...job,
  gear: (c: G.ClassId) => swap(job.gear(c), items),
});

console.log(
  '| Class | Job · loadout | Today’s kit | Quest items, stats only | With their effects (best pair) | × effects | Pair |',
);
console.log('|---|---|---|---|---|---|---|');
for (const c of CLASSES) {
  const def = G.defaultLoadout(c);
  for (const [name, l] of [
    ['default', def],
    ['farm lead', LEAD[c].farm],
  ] as const) {
    const today = farmRate(c, farm, l);
    const before = farmRate(c, withGear(farm, plain(c)), l);
    let best = { v: -Infinity, label: '' };
    for (const p of pairs(c)) {
      const v = farmRate(c, withGear(farm, p.items), l);
      if (v > best.v) best = { v, label: p.label };
    }
    console.log(
      `| ${c} | Deep 49 k/min · ${name} | ${f1(today)} | ${f1(before)} | ${f1(best.v)} | ${f2(best.v / before)} | ${best.label} |`,
    );
  }
  for (const [name, l] of [
    ['default', def],
    ['boss lead', LEAD[c].boss],
  ] as const) {
    const today = bossTime(c, boss, l);
    const before = bossTime(c, withGear(boss, plain(c)), l);
    let best = { t: Infinity, w: 0, label: '' };
    for (const p of pairs(c)) {
      const m = bossTime(c, withGear(boss, p.items), l);
      if (m.time < best.t) best = { t: m.time, w: m.wins, label: p.label };
    }
    console.log(
      `| ${c} | Sovereign 50 s · ${name} | ${f1(today.time)} (${Math.round(today.wins * 100)} %) | ${f1(before.time)} (${Math.round(before.wins * 100)} %) | ${f1(best.t)} (${Math.round(best.w * 100)} %) | ${f2(before.time / best.t)} | ${best.label} |`,
    );
  }
}
