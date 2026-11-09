// Ticket T.7: the balance check with trading switched on (docs/ECONOMY.md "Balance check: trading
// and the shelf"). Reads `telemetry:simulate` runs (`--alts`, `--trading on`, `--trading all`) and
// prints, side by side: the audit reconciliation; traded items, gold and materials as a share of
// what dropped, of what is worn and of income (TRADING.md §6's alarm); the shelf's effect on B.2's
// sink numbers per account; and the diversity of the effects and sets worn at the end.
//   pnpm --filter @worldforge/server exec tsx --conditions=source ../../tools/balance/trading.ts \
//     base=../../.telemetry-sample/t7-base alts=../../.telemetry-sample/t7-alts on=../../.telemetry-sample/t7-on all=../../.telemetry-sample/t7-all
import { join, resolve } from 'node:path';
import { createPgliteDatabase } from '../../apps/server/src/test/db.ts';
import { accounts, auditLog, characters, itemInstances } from '../../apps/server/src/db/schema.ts';
import {
  loadRollups,
  reconcileWithAudit,
  sumRollups,
} from '../../apps/server/src/telemetry/report.ts';

type Cat = 'epic' | 'legendary' | 'set' | 'mythic' | 'void';
const CATS: Cat[] = ['epic', 'legendary', 'set', 'mythic', 'void'];
interface ItemLike {
  rarityId: string;
  setId?: string | null;
  variant?: string | null;
}
/** An item's rows in the tables (a Void piece counts as Void and as its rarity). */
const catsOf = (i: ItemLike): Cat[] => {
  const out: Cat[] = [];
  if (i.rarityId === 'epic') out.push('epic');
  if (i.rarityId === 'legendary') out.push(i.setId ? 'set' : 'legendary');
  if (i.rarityId === 'mythic') out.push('mythic');
  if (i.variant === 'void') out.push('void');
  return out;
};
const pct = (a: number, b: number) => (b === 0 ? '—' : `${((100 * a) / b).toFixed(1)} %`);
const k = (n: number) =>
  Math.abs(n) >= 1e6
    ? `${(n / 1e6).toFixed(2)}M`
    : Math.abs(n) >= 1e4
      ? `${(n / 1e3).toFixed(1)}k`
      : String(Math.round(n));
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)]!;
};
/** Distinct, top share, HHI (0–1) and Shannon entropy (bits) of a count distribution. */
const diversity = (counts: Map<string, number>) => {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const shares = [...counts.values()].map((c) => c / total);
  const hhi = shares.reduce((a, s) => a + s * s, 0);
  const h = -shares.reduce((a, s) => a + (s > 0 ? s * Math.log2(s) : 0), 0);
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  return {
    total,
    distinct: counts.size,
    top: top ? `${top[0]} ${pct(top[1], total)}` : '—',
    hhi: total ? hhi.toFixed(3) : '—',
    entropy: total ? h.toFixed(2) : '—',
  };
};

const GOLD_IN: [string, string][] = [
  ['activity.reward', 'gold'],
  ['dungeon.claim', 'gold'],
  ['quest.turn_in', 'gold'],
  ['merchant.sell', 'gold'],
  ['forge.salvage', 'gold'],
  ['guild_boss.claim', 'gold'],
];
const GOLD_OUT: [string, string][] = [
  ['merchant.buy', 'price'],
  ['forge.craft', 'gold'],
  ['forge.upgrade', 'gold'],
  ['forge.reroll', 'gold'],
  ['forge.improve', 'gold'],
  ['guild.create', 'gold'],
  ['community.contribute', 'gold'],
  ['warehouse.upgrade', 'gold'],
];

async function measure(dir: string) {
  const database = await createPgliteDatabase(join(resolve(dir), 'db'));
  const db = database.db;
  const checks = await reconcileWithAudit(db);
  const { rows } = await loadRollups(db, { from: null, to: null });
  const notTrade = (d: string[]) => d[0] !== 'trade';
  const isTrade = (d: string[]) => d[0] === 'trade';
  const goldIn = sumRollups(rows, 'gold.in', notTrade, 'amount');
  const goldOut = sumRollups(rows, 'gold.out', notTrade, 'amount');
  const goldTraded = sumRollups(rows, 'gold.in', isTrade, 'amount');
  const matIn = sumRollups(rows, 'material.in', notTrade, 'amount');
  const matTraded = sumRollups(rows, 'material.in', isTrade, 'amount');
  const drops: Record<Cat, number> = {
    epic: sumRollups(rows, 'item.drop', (d) => d[2] === 'epic'),
    legendary:
      sumRollups(rows, 'item.drop', (d) => d[2] === 'legendary') - sumRollups(rows, 'item.set'),
    set: sumRollups(rows, 'item.set'),
    mythic: sumRollups(rows, 'item.drop', (d) => d[2] === 'mythic'),
    void: sumRollups(rows, 'item.variant', (d) => d[1] === 'void'),
  };

  const wanted = new Set([
    'trade.accept',
    'shelf.deposit',
    'shelf.withdraw',
    ...[...GOLD_IN, ...GOLD_OUT].map(([e]) => e),
  ]);
  // Every audit row (a week of 30–40 heroes is ~10^5 rows), filtered here.
  const events = (await db.select().from(auditLog))
    .filter((e) => wanted.has(e.event))
    .map((e) => ({
      event: e.event,
      character_id: e.characterId ?? '',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: e.data as Record<string, any>,
    }));
  // Traded items (both sides of every accepted trade) and gold per hero.
  const traded: Record<Cat, number> = { epic: 0, legendary: 0, set: 0, mythic: 0, void: 0 };
  let trades = 0;
  const heroIn = new Map<string, number>();
  const heroOut = new Map<string, number>();
  const heroUpgrades = new Map<string, number>();
  /** Heroes that received materials in a trade (the tier-2 gate B.2 found). */
  const matReceivers = new Set<string>();
  const shelfGold = { dep: 0, wd: 0 };
  const shelfMats = { dep: 0, wd: 0 };
  const shelfItems = { dep: 0, wd: 0 };
  const viaShelf = new Set<string>();
  const add = (m: Map<string, number>, id: string, n: number) => m.set(id, (m.get(id) ?? 0) + n);
  for (const e of events) {
    if (e.event === 'trade.accept') {
      trades++;
      const give = Object.keys(e.data.give?.materials ?? {}).length > 0;
      const ask = Object.keys(e.data.ask?.materials ?? {}).length > 0;
      if (give) matReceivers.add(e.data.receiverCharacterId);
      if (ask) matReceivers.add(e.data.senderCharacterId);
      for (const i of [...(e.data.give?.items ?? []), ...(e.data.ask?.items ?? [])]) {
        for (const c of catsOf(i)) traded[c]++;
      }
      continue;
    }
    if (e.event === 'shelf.deposit' || e.event === 'shelf.withdraw') {
      const dep = e.event === 'shelf.deposit';
      const amount = Number(e.data.amount ?? 0);
      const into =
        e.data.kind === 'gold' ? shelfGold : e.data.kind === 'items' ? shelfItems : shelfMats;
      if (dep) into.dep += amount;
      else into.wd += amount;
      if (!dep && e.data.kind === 'items') {
        for (const i of e.data.items ?? []) {
          if (i.fromCharacterId !== e.character_id) viaShelf.add(i.id);
        }
      }
      continue;
    }
    const inField = GOLD_IN.find(([ev]) => ev === e.event)?.[1];
    if (inField) add(heroIn, e.character_id, Number(e.data[inField] ?? 0));
    const outField = GOLD_OUT.find(([ev]) => ev === e.event)?.[1];
    if (outField) add(heroOut, e.character_id, Number(e.data[outField] ?? 0));
    if (e.event === 'forge.upgrade') add(heroUpgrades, e.character_id, 1);
  }
  const perHeroIn = [...heroIn.values()].reduce((a, b) => a + b, 0);
  const perHeroOut = [...heroOut.values()].reduce((a, b) => a + b, 0);

  const heroes = await db.select().from(characters);
  const accs = await db.select().from(accounts);
  const items = await db.select().from(itemInstances);
  const worn = items.filter((i) => i.equippedSlot);
  const wornCats: Record<Cat, number> = { epic: 0, legendary: 0, set: 0, mythic: 0, void: 0 };
  const wornTraded: Record<Cat, number> = { epic: 0, legendary: 0, set: 0, mythic: 0, void: 0 };
  const wornShelf: Record<Cat, number> = { epic: 0, legendary: 0, set: 0, mythic: 0, void: 0 };
  for (const i of worn) {
    for (const c of catsOf(i)) {
      wornCats[c]++;
      if (i.tradedCount > 0) wornTraded[c]++;
      if (viaShelf.has(i.id)) wornShelf[c]++;
    }
  }
  // Per hero: +10 pieces and whole kits.
  const kit = (id: string) => {
    const w = worn.filter((i) => i.characterId === id);
    return { at10: w.filter((i) => i.upgradeLevel >= 10).length, slots: w.length };
  };
  const byAccount = new Map<string, typeof heroes>();
  for (const h of heroes) byAccount.set(h.accountId, [...(byAccount.get(h.accountId) ?? []), h]);
  // Accounts with two heroes: the main is the older one (created first).
  const pairs = [...byAccount.values()]
    .filter((hs) => hs.length === 2)
    .map((hs) => [...hs].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()));
  const shelfOf = (accountId: string) => accs.find((a) => a.id === accountId)?.shelfGold ?? 0;
  const pairStats = pairs.map(([main, alt]) => {
    const mk = kit(main!.id);
    return {
      mainIn: heroIn.get(main!.id) ?? 0,
      altIn: heroIn.get(alt!.id) ?? 0,
      mainOut: heroOut.get(main!.id) ?? 0,
      altOut: heroOut.get(alt!.id) ?? 0,
      mainGold: main!.gold,
      altGold: alt!.gold,
      shelf: shelfOf(main!.accountId),
      mainUps: heroUpgrades.get(main!.id) ?? 0,
      altUps: heroUpgrades.get(alt!.id) ?? 0,
      mainAt10: mk.at10,
      mainKit: mk.slots > 0 && mk.at10 === mk.slots,
    };
  });
  const sum = (f: (p: (typeof pairStats)[number]) => number) =>
    pairStats.reduce((a, p) => a + f(p), 0);
  const singles = [...byAccount.values()].filter((hs) => hs.length === 1).map((hs) => hs[0]!);
  const mains = pairs.map(([m]) => m!);

  // Worn effects and sets at the end (all heroes; per class: distinct effects).
  const effects = new Map<string, number>();
  const sets = new Map<string, number>();
  const classEffects = new Map<string, Set<string>>();
  for (const i of worn) {
    if (i.effectId) {
      effects.set(i.effectId, (effects.get(i.effectId) ?? 0) + 1);
      const cls = heroes.find((h) => h.id === i.characterId)!.classId;
      classEffects.set(cls, new Set([...(classEffects.get(cls) ?? []), i.effectId]));
    }
    if (i.setId) sets.set(i.setId, (sets.get(i.setId) ?? 0) + 1);
  }
  await database.close();
  return {
    reconcile: `${checks.filter((c) => c.ok).length} / ${checks.length}`,
    failed: checks.filter((c) => !c.ok).map((c) => c.check),
    heroes: heroes.length,
    accounts: byAccount.size,
    goldIn,
    goldOut,
    goldTraded,
    matIn,
    matTraded,
    perHeroIn,
    perHeroOut,
    drops,
    traded,
    trades,
    wornCats,
    wornTraded,
    wornShelf,
    shelfGold,
    shelfMats,
    shelfItems,
    pairs: pairStats.length,
    pair: {
      mainIn: sum((p) => p.mainIn),
      altIn: sum((p) => p.altIn),
      mainOut: sum((p) => p.mainOut),
      altOut: sum((p) => p.altOut),
      mainGold: sum((p) => p.mainGold),
      altGold: sum((p) => p.altGold),
      shelf: sum((p) => p.shelf),
      mainUps: sum((p) => p.mainUps),
      altUps: sum((p) => p.altUps),
      mainAt10: sum((p) => p.mainAt10),
      mainKits: pairStats.filter((p) => p.mainKit).length,
      medianMainGold: median(pairStats.map((p) => p.mainGold)),
    },
    matReceivers: {
      n: matReceivers.size,
      medianGold: median(heroes.filter((h) => matReceivers.has(h.id)).map((h) => h.gold)),
    },
    single: {
      n: singles.length,
      goldIn: singles.reduce((a, h) => a + (heroIn.get(h.id) ?? 0), 0),
      goldOut: singles.reduce((a, h) => a + (heroOut.get(h.id) ?? 0), 0),
      medianGold: median(singles.map((h) => h.gold)),
      kits: singles.filter((h) => {
        const x = kit(h.id);
        return x.slots > 0 && x.at10 === x.slots;
      }).length,
    },
    kitsAll: [...singles, ...mains].filter((h) => {
      const x = kit(h.id);
      return x.slots > 0 && x.at10 === x.slots;
    }).length,
    effects: diversity(effects),
    sets: diversity(sets),
    classEffects: [...classEffects]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([c, s]) => `${c} ${s.size}`)
      .join(' · '),
  };
}

const runs = process.argv.slice(2).map((a) => {
  const [label, dir] = a.includes('=') ? (a.split('=', 2) as [string, string]) : [a, a];
  return { label, dir };
});
if (runs.length === 0) {
  console.error('usage: trading.ts label=dir [label=dir …]');
  process.exit(1);
}
const results = [];
for (const r of runs) results.push({ ...r, m: await measure(r.dir) });
const table = (title: string, lines: [string, (m: (typeof results)[number]['m']) => string][]) => {
  console.log(`\n| ${title} | ${results.map((r) => r.label).join(' | ')} |`);
  console.log(`|---|${results.map(() => '---').join('|')}|`);
  for (const [name, f] of lines)
    console.log(`| ${name} | ${results.map((r) => f(r.m)).join(' | ')} |`);
};
table('Run', [
  ['Heroes · accounts', (m) => `${m.heroes} · ${m.accounts}`],
  [
    'Audit reconciliation (checks ok)',
    (m) => m.reconcile + (m.failed.length ? ` (${m.failed.join(', ')})` : ''),
  ],
  [
    'Gold in · out · sunk (no trades)',
    (m) => `${k(m.goldIn)} · ${k(m.goldOut)} · ${pct(m.goldOut, m.goldIn)}`,
  ],
  ['Per-hero audit sums (in · out)', (m) => `${k(m.perHeroIn)} · ${k(m.perHeroOut)}`],
  ['Trades completed', (m) => String(m.trades)],
]);
table('1. Traded share', [
  ...CATS.map((c): [string, (m: (typeof results)[number]['m']) => string] => [
    `${c}: traded / dropped`,
    (m) => `${m.traded[c]} / ${m.drops[c]} (${pct(m.traded[c], m.drops[c])})`,
  ]),
  ...CATS.map((c): [string, (m: (typeof results)[number]['m']) => string] => [
    `${c}: worn at the end, from a trade · from the shelf`,
    (m) =>
      `${m.wornCats[c]}: ${m.wornTraded[c]} (${pct(m.wornTraded[c], m.wornCats[c])}) · ${m.wornShelf[c]}`,
  ]),
  [
    'Legendary + set worn from trades (alarm > 10 %)',
    (m) => pct(m.wornTraded.legendary + m.wornTraded.set, m.wornCats.legendary + m.wornCats.set),
  ],
  [
    'Gold traded / gold income (alarm > 5 %)',
    (m) => `${k(m.goldTraded)} (${pct(m.goldTraded, m.goldIn)})`,
  ],
  ['Materials traded / material income', (m) => `${k(m.matTraded)} (${pct(m.matTraded, m.matIn)})`],
]);
table('2. The shelf (accounts with two heroes)', [
  ['Accounts with an alt', (m) => String(m.pairs)],
  [
    'Shelf gold · materials · items moved (in → out)',
    (m) =>
      `${k(m.shelfGold.dep)} → ${k(m.shelfGold.wd)} · ${k(m.shelfMats.dep)} → ${k(m.shelfMats.wd)} · ${m.shelfItems.dep} → ${m.shelfItems.wd}`,
  ],
  ['Gold earned: main · alt', (m) => `${k(m.pair.mainIn)} · ${k(m.pair.altIn)}`],
  ['Gold sunk: main · alt', (m) => `${k(m.pair.mainOut)} · ${k(m.pair.altOut)}`],
  ["One hero's purse (main): sunk / earned", (m) => pct(m.pair.mainOut, m.pair.mainIn)],
  [
    "Main's purse with the shelf: sunk / (earned + taken from the shelf)",
    (m) => pct(m.pair.mainOut, m.pair.mainIn + m.shelfGold.wd),
  ],
  ['Shelf gold / the mains’ own income', (m) => pct(m.shelfGold.wd, m.pair.mainIn)],
  [
    "One account's purse: sunk / earned",
    (m) => pct(m.pair.mainOut + m.pair.altOut, m.pair.mainIn + m.pair.altIn),
  ],
  [
    'Gold left: main · alt · shelf',
    (m) => `${k(m.pair.mainGold)} · ${k(m.pair.altGold)} · ${k(m.pair.shelf)}`,
  ],
  ['Median main gold left', (m) => k(m.pair.medianMainGold)],
  ['Upgrades bought: main · alt', (m) => `${m.pair.mainUps} · ${m.pair.altUps}`],
  [
    'Main pieces at +10 · whole +10 kits',
    (m) => `${m.pair.mainAt10} · ${m.pair.mainKits} of ${m.pairs}`,
  ],
  [
    'One-hero accounts: gold earned · sunk',
    (m) => `${k(m.single.goldIn)} · ${pct(m.single.goldOut, m.single.goldIn)}`,
  ],
  [
    'Heroes that received materials in trades · their median gold left',
    (m) => `${m.matReceivers.n} · ${k(m.matReceivers.medianGold)}`,
  ],
  [
    'One-hero accounts: whole +10 kits · median gold',
    (m) => `${m.single.kits} of ${m.single.n} · ${k(m.single.medianGold)}`,
  ],
  ['All mains: whole +10 kits', (m) => `${m.kitsAll} of ${m.accounts}`],
]);
table('3. Worn effects and sets at the end', [
  ['Effects worn: pieces · distinct', (m) => `${m.effects.total} · ${m.effects.distinct}`],
  ['Top effect (share)', (m) => m.effects.top],
  ['Effects HHI · entropy (bits)', (m) => `${m.effects.hhi} · ${m.effects.entropy}`],
  ['Distinct effects per class', (m) => m.classEffects],
  ['Set pieces worn · distinct sets', (m) => `${m.sets.total} · ${m.sets.distinct}`],
  ['Top set (share)', (m) => m.sets.top],
  ['Sets HHI · entropy (bits)', (m) => `${m.sets.hhi} · ${m.sets.entropy}`],
]);
