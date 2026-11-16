// Ticket B.7: the balance pass over skills and loadouts (docs/BALANCE.md "B.7"). Simulations
// only (the town is not live, so there is no telemetry by loadout yet), like B.5.
//   pnpm --filter @worldforge/server exec tsx ../../tools/balance/skills-balance.ts search
//   search: 9.1's loadout search on three kit samples (and with 9.3's quest rewards): viable
//           loadouts per class and job, the sidegrade size, and whether one loadout leads both
//   bands:  the Phase 6 and 8 boss bands (B.5's Tyrant/Heroic spread, 8.2's Sovereign) and the
//           farming and XP bands with each class's leading loadouts
//   pvp:    the PvP bands (pvp-balance.test.ts) under rules 3 with loadouts
//   arena:  matchmaking fairness (arena-fairness.test.ts) with loadouts on the defences
// CLASSES=warrior,mage  JOBS=deep49,sovereign50  VARIANT=quest  SAMPLES=0,1,2  TOP=5
import * as G from '../../packages/game-core/src/index.ts';
import {
  allLoadouts,
  bossTime,
  farmRate,
  viable,
  type ScoredLoadout,
} from '../../packages/game-core/src/balance/loadouts.ts';
import {
  B7_JOBS,
  KIT_SAMPLES,
  asBossJob,
  asFarmJob,
  distinctKey,
  type KitVariant,
  type SampledJob,
} from '../../packages/game-core/src/balance/skills-balance.ts';
import { bossRuns } from '../../packages/game-core/src/balance/skills-balance.ts';
import {
  kit,
  legendaryKit,
  legendarySample,
  upgraded,
} from '../../packages/game-core/src/balance/kits.ts';
import * as fx from '../../packages/game-core/src/balance/pvp-fixtures.ts';
import * as af from '../../packages/game-core/src/balance/arena-fixtures.ts';

const mode = process.argv[2] ?? 'search';
// Candidate changes, measured before they are written into the data (B.7's before/after tables):
// PASSIVE_PATCH='{"deepReserves":{"resource":{"max":30}}}' replaces a passive's modifiers here.
if (process.env.PASSIVE_PATCH) {
  for (const [id, modifiers] of Object.entries(JSON.parse(process.env.PASSIVE_PATCH))) {
    const p = G.PASSIVE_SKILLS.find((x) => x.id === id)!;
    (p as { modifiers: unknown }).modifiers = modifiers;
  }
}
const CLASSES = (process.env.CLASSES?.split(',') ?? G.CLASS_IDS) as G.ClassId[];
const JOBS = process.env.JOBS?.split(',');
const VARIANT = (process.env.VARIANT ?? 'plain') as KitVariant;
const SAMPLES = process.env.SAMPLES?.split(',').map(Number) ?? [...KIT_SAMPLES];
const TOP = Number(process.env.TOP ?? 5);
const f1 = (x: number) => x.toFixed(1);
const f2 = (x: number) => x.toFixed(2);
const pct = (x: number) => `${Math.round(x * 100)} %`;
const pct1 = (x: number) => `${(x * 100).toFixed(1)} %`;
const short = (k: string) => k.replace(/,-/g, '').replace(/\/-$/, '');

/** Mean score over the kit samples: kills/min, or −mean boss time (a loss = 150 s). */
function score(c: G.ClassId, job: SampledJob, l: G.Loadout, variant: KitVariant) {
  let s = 0;
  let wins = 0;
  for (const k of SAMPLES) {
    if (job.kind === 'farm') s += farmRate(c, asFarmJob(job, k, variant), l);
    else {
      const m = bossTime(c, asBossJob(job, k, variant), l);
      s -= m.time;
      wins += m.wins;
    }
  }
  return { score: s / SAMPLES.length, wins: wins / SAMPLES.length };
}

const PAIRS: [string, string][] = [
  ['pass26', 'crypt3'],
  ['depths37', 'heroic34'],
  ['depths37', 'tyrant38'],
  ['deep49', 'sovereign50'],
];

if (mode === 'search') {
  const jobs = B7_JOBS.filter((j) => !JOBS || JOBS.includes(j.id));
  const scores: Record<string, Record<string, (ScoredLoadout & { wins: number })[]>> = {};
  console.log(`kit samples ${SAMPLES.join(',')}, variant ${VARIANT}`);
  for (const c of CLASSES) {
    for (const j of jobs) {
      const t0 = Date.now();
      const list = allLoadouts(c, j.hero)
        .map((l) => {
          const m = score(c, j, l, VARIANT);
          return { loadout: l, key: G.loadoutKey(l), score: m.score, wins: m.wins };
        })
        .sort((a, b) => b.score - a.score);
      const def = list.find((s) => s.key === G.loadoutKey(G.defaultLoadout(c)))!;
      const v = viable(list);
      const distinct = new Set(v.map((x) => distinctKey(x.loadout))).size;
      const best = list[0]!;
      const unit = j.kind === 'farm' ? 'k/min' : 's';
      const r = j.kind === 'farm' ? best.score / def.score : def.score / best.score;
      const w = (s: { wins: number }) => (j.kind === 'boss' ? ` (wins ${pct(s.wins)})` : '');
      console.log(
        `\n${c} · ${j.label}: ${list.length} loadouts (${((Date.now() - t0) / 1000).toFixed(0)} s); default ${f2(Math.abs(def.score))} ${unit}${w(def)}; best ${f2(Math.abs(best.score))}${w(best)} (× ${f2(r)}); viable (7 %) ${v.length} (${distinct} distinct)`,
      );
      for (const s of list.slice(0, TOP))
        console.log(`  ${f2(Math.abs(s.score))}  ${short(s.key)}${w(s)}`);
      (scores[c] ??= {})[j.id] = list;
    }
  }
  console.log('\nLeaders of both kinds (within 2 % of both bests; should be none):');
  for (const c of CLASSES) {
    for (const [farm, boss] of PAIRS) {
      const f = scores[c]?.[farm];
      const b = scores[c]?.[boss];
      if (!f || !b) continue;
      const keys = new Set(b.map((x) => x.key));
      const fb = f.filter((x) => keys.has(x.key));
      const bb = b.filter((x) => fb.some((y) => y.key === x.key));
      const lf = new Set(viable(fb, 0.02).map((x) => x.key));
      const both = viable(bb, 0.02).filter((x) => lf.has(x.key));
      const at = (list: ScoredLoadout[], key: string) => list.find((x) => x.key === key)!.score;
      const behind = (list: ScoredLoadout[], key: string) =>
        Math.abs(list[0]!.score / at(list, key) - 1) * 100;
      console.log(
        `  ${c} ${farm}×${boss}: ${both.length ? both.map((x) => short(x.key)).join(' | ') : 'none'}; farm leader ${f1(behind(bb, fb[0]!.key))} % behind at the boss, boss leader ${f1(behind(fb, bb[0]!.key))} % behind farming (farm ${short(fb[0]!.key)}; boss ${short(bb[0]!.key)})`,
      );
    }
  }
}

/* --- Leaders: the best loadout a hero can field on a job, over the kit samples ---------------- */

const leaderMemo = new Map<string, G.Loadout>();
/** The boss leader (least mean time over the kit samples, `l9-boss` seeds) for a hero. */
export function bossLeader(c: G.ClassId, jobId: string, hero: G.LoadoutHero): G.Loadout {
  const key = `boss:${c}:${jobId}:${JSON.stringify(hero)}`;
  if (!leaderMemo.has(key)) {
    const job = { ...B7_JOBS.find((j) => j.id === jobId)!, level: hero.level, hero };
    const best = allLoadouts(c, hero)
      .map((l) => ({ l, s: score(c, job, l, 'plain').score }))
      .sort((a, b) => b.s - a.s)[0]!.l;
    leaderMemo.set(key, best);
  }
  return leaderMemo.get(key)!;
}
/** The farming leader (most kills a minute over the kit samples) for a hero. */
export function farmLeader(c: G.ClassId, jobId: string, hero: G.LoadoutHero): G.Loadout {
  const key = `farm:${c}:${jobId}:${JSON.stringify(hero)}`;
  if (!leaderMemo.has(key)) {
    const job = { ...B7_JOBS.find((j) => j.id === jobId)!, level: hero.level, hero };
    const best = allLoadouts(c, hero)
      .map((l) => ({ l, s: score(c, job, l, 'plain').score }))
      .sort((a, b) => b.s - a.s)[0]!.l;
    leaderMemo.set(key, best);
  }
  return leaderMemo.get(key)!;
}

if (mode === 'bands') {
  const PARTS = process.env.PARTS?.split(',') ?? ['b5', 'sovereign', 'farm', 'xp', 'warded'];
  const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
  const row = (xs: number[]) => xs.map(pct).join(' / ');

  if (PARTS.includes('b5')) {
    // B.5's class spread (endgame-balance.test.ts): 8 Legendary kits (item level 33) × 12 runs.
    console.log('\nB.5: Tyrant and Heroic, win rate warrior / mage / hunter / warlock (spread)');
    const fights: [string, G.DungeonId, G.DungeonTier, string, number[]][] = [
      ['Forge Tyrant', 'tyrantsForge', 1, 'tyrant38', [36, 38]],
      ['Heroic', 'namelessCrypt', 4, 'heroic34', [32, 34, 36]],
    ];
    for (const [name, d, tier, jobId, levels] of fights) {
      for (const level of levels) {
        const leaders = CLASSES.map((c) => bossLeader(c, jobId, { level }));
        for (const up of [0, 5, 10]) {
          const per = (which: 'default' | 'leader') =>
            CLASSES.map((c, i) => {
              let s = 0;
              for (let k = 0; k < 8; k++)
                s += bossRuns(
                  c,
                  d,
                  tier,
                  level,
                  upgraded(legendarySample(c, 33, k), up),
                  which === 'leader' ? leaders[i]! : null,
                  12,
                  'b5-boss',
                ).wins;
              return s / 8;
            });
          const a = per('default');
          const b = per('leader');
          console.log(
            `  ${name} ${level} +${up}: default ${row(a)} (${pct(spread(a))}) → leaders ${row(b)} (${pct(spread(b))}); mixed worst spread ${pct(Math.max(...b) - Math.min(...a))}`,
          );
        }
        console.log(`    leaders: ${leaders.map((l) => short(G.loadoutKey(l))).join(' · ')}`);
      }
    }
  }

  if (PARTS.includes('sovereign')) {
    // 8.2's Sovereign bands (hollow-deep-balance.test.ts): 4 kits × 12 runs per class.
    const GEAR: Record<string, (c: G.ClassId, k: number) => G.EquippedItem[]> = {
      'Depths +10': (c, k) => upgraded(legendarySample(c, 39, k), 10),
      'Marches +0': (c, k) => legendarySample(c, 47, k),
      'Marches +5': (c, k) => upgraded(legendarySample(c, 47, k), 5),
      'Marches 45 +5': (c, k) => upgraded(legendarySample(c, 45, k), 5),
      'Marches +10': (c, k) => upgraded(legendarySample(c, 47, k), 10),
      'Deep +10': (c, k) => upgraded(legendarySample(c, 53, k), 10),
    };
    const MODS: (G.BossModifierId | null)[] = [null];
    if (process.env.MODS) MODS.push('burning', 'warded', 'frenzied', 'unyielding', 'relentless');
    for (const progress of [
      { forgeTyrantSkillLearned: true },
      { forgeTyrantSkillLearned: true, hollowSovereignSkillLearned: true },
    ]) {
      console.log(`\n8.2: the Hollow Sovereign, hero progress ${JSON.stringify(progress)}`);
      for (const level of [48, 50]) {
        const leaders = CLASSES.map((c) => bossLeader(c, 'sovereign50', { level, progress }));
        console.log(
          `  ${level} leaders: ${leaders.map((l) => short(G.loadoutKey(l))).join(' · ')}`,
        );
        for (const mod of MODS) {
          for (const [g, gear] of Object.entries(GEAR)) {
            if (mod && g !== 'Marches +10') continue;
            const per = (which: 'default' | 'leader') =>
              CLASSES.map((c, i) => {
                let s = 0;
                for (let k = 0; k < 4; k++)
                  s += bossRuns(
                    c,
                    'hollowThrone',
                    1,
                    level,
                    gear(c, k),
                    which === 'leader' ? leaders[i]! : null,
                    12,
                    `sov:${c}:${level}`,
                    mod,
                  ).wins;
                return s / 4;
              });
            const a = per('default');
            const b = per('leader');
            const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
            console.log(
              `    ${g}${mod ? ` (${mod})` : ''}: default ${f2(mean(a))} (${row(a)}) → leaders ${f2(mean(b))} (${row(b)})`,
            );
          }
        }
      }
    }
  }

  if (PARTS.includes('farm')) {
    console.log(
      '\nFarming bands with the farming leaders (3 seeds × 1 h): deaths/h, damage share, k/min',
    );
    const cases: [string, G.AreaId, number[], string, (c: G.ClassId) => G.EquippedItem[]][] = [
      [
        'Hollow Deep, Marches Legendaries +10',
        'hollowDeep',
        [46, 49, 52],
        'deep49',
        (c) => upgraded(legendaryKit(c, 47), 10),
      ],
      [
        'Pale Marches, Depths Legendaries +10',
        'paleMarches',
        [40, 46],
        'depths37',
        (c) => upgraded(legendaryKit(c, 39), 10),
      ],
      [
        'Pale Marches, Heroic Legendaries +10 (il 37)',
        'paleMarches',
        [40],
        'depths37',
        (c) => upgraded(legendaryKit(c, 37), 10),
      ],
    ];
    for (const [name, areaId, levels, jobId, gear] of cases) {
      for (const level of levels) {
        const cells = CLASSES.map((c) => {
          const hero = {
            level,
            progress: { forgeTyrantSkillLearned: true, hollowSovereignSkillLearned: level >= 46 },
          };
          const l = farmLeader(c, jobId, hero);
          const m = (lo: G.Loadout | null) => {
            let deaths = 0,
              kills = 0,
              share = 0,
              enc = 0;
            for (const seed of ['hd-a', 'hd-b', 'hd-c']) {
              const r = G.settleFarming({
                character: { classId: c, level, xp: 0 },
                equipment: gear(c),
                areaId,
                seed,
                firstCycle: 0,
                durationMs: 3_600_000,
                inventoryCount: 0,
                ...(lo ? { loadout: lo } : {}),
              });
              deaths += r.deaths;
              kills += r.kills;
              share += r.damageTaken / r.maxHealth;
              enc += r.encounters;
            }
            return { d: deaths / 3, k: kills / 180, s: share / enc };
          };
          const a = m(null);
          const b = m(l);
          return `${c} ${f1(a.d)}/${f2(a.s)}/${f1(a.k)} → ${f1(b.d)}/${f2(b.s)}/${f1(b.k)} (${short(G.loadoutKey(l))})`;
        });
        console.log(`  ${name} at ${level}:\n    ${cells.join('\n    ')}`);
      }
    }
  }

  if (PARTS.includes('xp')) {
    console.log(
      '\nB.5 XP pacing with the farming leaders: hours a level 28–39 (min–max), 28 → 40, 47 → 48',
    );
    for (const c of CLASSES) {
      const hours = (level: number, lo: G.Loadout | null) => {
        const areas: G.AreaId[] =
          level >= 34 ? ['ashfallVerge', 'cinderDepths'] : ['ashenPass', 'ashfallVerge'];
        const items = upgraded(legendarySample(c, Math.max(25, Math.min(39, level - 2)), 0), 5);
        const xph = Math.max(
          ...areas.map(
            (areaId) =>
              G.settleFarming({
                character: { classId: c, level, xp: 0 },
                equipment: items,
                areaId,
                seed: `b5-pace:${c}:${level}:0`,
                firstCycle: 0,
                durationMs: 3_600_000,
                inventoryCount: 0,
                ...(lo ? { loadout: lo } : {}),
              }).xpGained,
          ),
        );
        return G.xpToNextLevel(level) / xph;
      };
      const leader = (level: number) =>
        farmLeader(c, 'depths37', { level, progress: { forgeTyrantSkillLearned: true } });
      for (const which of ['default', 'leader'] as const) {
        const hs: number[] = [];
        for (let level = 28; level < 40; level++)
          hs.push(hours(level, which === 'leader' ? leader(level) : null));
        const h47 = hours(47, which === 'leader' ? leader(47) : null);
        console.log(
          `  ${c} ${which}: ${f1(Math.min(...hs))}–${f1(Math.max(...hs))} h, 28 → 40 ${f1(hs.reduce((s, x) => s + x, 0))} h, 47 → 48 ${f1(h47)} h`,
        );
      }
    }
  }

  if (PARTS.includes('warded')) {
    console.log(
      '\nB.5 weekly modifiers with the boss leaders (mean win rate over the classes, 16 runs)',
    );
    const MODS: (G.BossModifierId | null)[] = [
      null,
      'warded',
      'burning',
      'frenzied',
      'unyielding',
      'relentless',
    ];
    const cases: [
      string,
      G.DungeonId,
      G.DungeonTier,
      number,
      string,
      (c: G.ClassId) => G.EquippedItem[],
    ][] = [
      [
        'crypt III, epics +8',
        'namelessCrypt',
        3,
        21,
        'crypt3',
        (c) => upgraded(kit(c, 20, 'epic'), 8),
      ],
      [
        'the Ashen Warden, Legendaries',
        'ashenWatch',
        1,
        26,
        'crypt3',
        (c) => legendarySample(c, 25, 0),
      ],
    ];
    for (const [name, d, tier, level, jobId, gear] of cases) {
      const out = MODS.map((mod) => {
        const m = (which: 'default' | 'leader') =>
          CLASSES.reduce(
            (s, c) =>
              s +
              bossRuns(
                c,
                d,
                tier,
                level,
                gear(c),
                which === 'leader' ? bossLeader(c, jobId, { level }) : null,
                16,
                'heroic-balance',
                mod,
              ).wins,
            0,
          ) / CLASSES.length;
        return `${mod ?? 'none'} ${f2(m('default'))} → ${f2(m('leader'))}`;
      });
      console.log(`  ${name}: ${out.join(' · ')}`);
    }
  }
}

/* --- PvP under rules 3 with loadouts ------------------------------------------------------------ */

const progressAt = (level: number) =>
  level >= 46
    ? { forgeTyrantSkillLearned: true, hollowSovereignSkillLearned: true }
    : level >= 36
      ? { forgeTyrantSkillLearned: true }
      : {};

const duelMemo = new Map<string, G.Loadout>();
/**
 * A class's best duel loadout at a level: the one with the highest mean win share against every
 * class's default loadout, both in Legendary kits at item level − 1 (2 samples × 16 duels each).
 */
export function duelLeader(
  c: G.ClassId,
  level: number,
  config: G.PvpConfig = G.DEFAULT_PVP_CONFIG,
): G.Loadout {
  const key = `${c}:${level}:${JSON.stringify(config.skillKeepByClass ?? null)}`;
  if (!duelMemo.has(key)) {
    const hero = { level, progress: progressAt(level) };
    let best = { l: G.defaultLoadout(c), s: -1 };
    for (const l of allLoadouts(c, hero)) {
      let s = 0;
      for (const d of G.CLASS_IDS)
        for (let k = 0; k < 2; k++)
          s += fx.winShare(
            { ...fx.fighter(c, level, fx.gear(c, level, 'legendary', k)), loadout: l },
            fx.fighter(d, level, fx.gear(d, level, 'legendary', k + 50)),
            16,
            `b7-duel-pick:${c}:${d}:${level}:${k}`,
            undefined,
            config,
          ).share;
      if (s > best.s) best = { l, s };
    }
    duelMemo.set(key, best.l);
  }
  return duelMemo.get(key)!;
}

type Who = 'default' | 'leader';
const withL = (f: G.PvpFighterInput, who: Who): G.PvpFighterInput =>
  who === 'leader' ? { ...f, loadout: duelLeader(f.classId, f.level) } : f;

if (mode === 'pvp') {
  const PARTS = process.env.PARTS?.split(',') ?? ['matchups', 'steps', 'fresh', 'length', 'edge'];
  const ONLY = process.env.BRACKETS?.split(',');
  for (const b of G.PVP_BRACKETS.filter((x) => !ONLY || ONLY.includes(x.id))) {
    const L = b.referenceLevel;
    console.log(
      `\nBracket ${b.id} (reference level ${L}); duel leaders: ${G.CLASS_IDS.map((c) => short(G.loadoutKey(duelLeader(c, L)))).join(' · ')}`,
    );
    const tiers = fx.matchupTiers(b);
    const mgear = (c: G.ClassId, t: string, s: number) =>
      t === 'build' ? fx.sampleBuild(c, L - 1, s) : fx.gear(c, L, t as never, s);
    // pvp-balance.test.ts's matchups (6 samples × 12 duels per tier) with chosen loadouts.
    const matchup = (a: G.ClassId, d: G.ClassId, wa: Who, wd: Who) => {
      let share = 0;
      for (const t of tiers)
        for (let s = 0; s < 6; s++)
          share += fx.winShare(
            withL(fx.fighter(a, L, mgear(a, t, s)), wa),
            withL(fx.fighter(d, L, mgear(d, t, s + 100)), wd),
            12,
            `pvp-matchup:${b.id}:${a}:${d}:${t}:${s}`,
          ).share;
      return share / (tiers.length * 6);
    };
    if (PARTS.includes('matchups')) {
      for (const [wa, wd, label] of [
        ['default', 'default', 'both default (today)'],
        ['leader', 'leader', 'both on their duel leader'],
      ] as [Who, Who, string][]) {
        const pairs: string[] = [];
        const mean: Record<string, number[]> = {};
        let lo = 1,
          hi = 0;
        for (const a of G.CLASS_IDS)
          for (const d of G.CLASS_IDS) {
            if (a >= d) continue;
            const x = matchup(a, d, wa, wd);
            lo = Math.min(lo, x);
            hi = Math.max(hi, x);
            pairs.push(`${a}–${d} ${pct(x)}`);
            (mean[a] ??= []).push(x);
            (mean[d] ??= []).push(1 - x);
          }
        const means = G.CLASS_IDS.map((c) => mean[c]!.reduce((s, x) => s + x, 0) / 3);
        console.log(
          `  matchups, ${label}: pairs ${pct(lo)}–${pct(hi)}; classes ${means.map(pct).join(' / ')}\n    ${pairs.join(' · ')}`,
        );
      }
      // Mixed: one class on its leader against every other class on the default.
      const edge = G.CLASS_IDS.map((a) => {
        const xs = G.CLASS_IDS.filter((d) => d !== a).map((d) =>
          a < d ? matchup(a, d, 'leader', 'default') : 1 - matchup(d, a, 'default', 'leader'),
        );
        return `${a} ${pct(xs.reduce((s, x) => s + x, 0) / 3)} (${pct(Math.min(...xs))}–${pct(Math.max(...xs))})`;
      });
      console.log(
        `  one class on its leader, the others default (class mean, pair range): ${edge.join(' · ')}`,
      );
    }
    if (PARTS.includes('steps')) {
      const steps: string[] = [];
      for (let i = 1; i < fx.GEAR_TIERS.length; i++) {
        const [better, worse] = [fx.GEAR_TIERS[i]!, fx.GEAR_TIERS[i - 1]!];
        const m = (who: Who) => {
          let share = 0;
          for (const c of G.CLASS_IDS)
            for (let s = 0; s < 3; s++)
              share += fx.winShare(
                withL(fx.fighter(c, L, fx.gear(c, L, better, s)), who),
                withL(fx.fighter(c, L, fx.gear(c, L, worse, s + 7)), who),
                24,
                `pvp-step:${b.id}:${c}:${i}:${s}`,
              ).share;
          return share / 12;
        };
        steps.push(`${better} ${pct(m('default'))} → ${pct(m('leader'))}`);
      }
      console.log(`  gear steps (both on the default → both on the leader): ${steps.join(' · ')}`);
    }
    if (PARTS.includes('fresh')) {
      // A fresh hero (default loadout, or its own best at its level) against typical opponents on
      // their duel leaders: the worst case for the fresh hero.
      const typ = (c: G.ClassId, s: number, who: Who) => withL(fx.typical(c, b, s), who);
      const rowFor = (heroWho: Who, oppWho: Who) => {
        const per = G.CLASS_IDS.map((c) => {
          let share = 0;
          for (let s = 0; s < 3; s++) {
            const hero = withL(fx.fresh(c, b, s), heroWho);
            for (const d of G.CLASS_IDS)
              for (let k = 0; k < 3; k++)
                share += fx.winShare(
                  hero,
                  typ(d, k, oppWho),
                  16,
                  `pvp-typical:fresh:${b.id}:${c}:${s}:${d}:${k}`,
                ).share;
          }
          return share / 36;
        });
        return `${per.map(pct).join(' / ')} (mean ${pct(per.reduce((s, x) => s + x, 0) / 4)})`;
      };
      console.log(
        `  fresh hero vs typical: today ${rowFor('default', 'default')}; opponents on leaders ${rowFor('default', 'leader')}; both on leaders ${rowFor('leader', 'leader')}`,
      );
    }
    if (PARTS.includes('length')) {
      for (const who of ['default', 'leader'] as Who[]) {
        const durations: number[] = [];
        let limits = 0,
          tickDmg = 0,
          allDmg = 0;
        for (const a of G.CLASS_IDS)
          for (const d of G.CLASS_IDS)
            for (let s = 0; s < 25; s++)
              for (const r of [
                G.simulateDuel({
                  challenger: withL(fx.fighter(a, L, fx.sampleBuild(a, L - 1, s)), who),
                  defender: withL(fx.typical(d, b, s), who),
                  seed: `dur:${b.id}:${a}:${d}:${s}`,
                }),
                G.simulateDuel({
                  challenger: withL(fx.typical(a, b, s), who),
                  defender: withL(fx.typical(d, b, s + 1), who),
                  seed: `dur2:${b.id}:${a}:${d}:${s}`,
                }),
              ]) {
                durations.push(r.durationMs);
                if (r.reason === 'timeLimit') limits++;
                for (const e of r.events) {
                  if (e.type === 'tick') tickDmg += e.damage;
                  if (e.type === 'tick' || e.type === 'attack') allDmg += e.damage;
                }
              }
        durations.sort((x, y) => x - y);
        console.log(
          `  duel length (${who}): median ${f1(durations[durations.length >> 1]! / 1000)} s, p95 ${f1(durations[Math.floor(durations.length * 0.95)]! / 1000)} s, time limit ${pct(limits / durations.length)}; damage over time ${f1((100 * tickDmg) / Math.max(1, allDmg))} % of blow + tick damage (no luck roll)`,
        );
      }
    }
    if (PARTS.includes('edge')) {
      // The 5.4 rules: a loadout's edge against a gear step. Same class, same kit (Legendary +5):
      // the leader against the default; and the luck spread's hold on duels with ticks.
      const per = G.CLASS_IDS.map((c) => {
        let share = 0;
        for (let s = 0; s < 3; s++)
          share += fx.winShare(
            withL(fx.fighter(c, L, fx.gear(c, L, 'legendary+5', s)), 'leader'),
            fx.fighter(c, L, fx.gear(c, L, 'legendary+5', s)),
            40,
            `b7-edge:${b.id}:${c}:${s}`,
          ).share;
        return share / 3;
      });
      console.log(
        `  leader vs default, same class and kit (Legendary +5): ${per.map(pct).join(' / ')}`,
      );
    }
  }
}

if (mode === 'arena') {
  const SIZE = 120;
  const SEEDS = 32;
  const SCEN = process.env.SCEN?.split(',') ?? ['default', 'leader', 'half', 'random'];
  const assign = (h: af.ArenaHero, scen: string) => {
    if (scen === 'default') return h;
    if (scen === 'half' && h.index % 2 === 1) return h;
    let l: G.Loadout;
    if (scen === 'random') {
      const all = allLoadouts(h.classId, { level: h.level, progress: progressAt(h.level) });
      l = all[G.createRng(`b7-arena-loadout:${h.index}`).int(0, all.length - 1)]!;
    } else
      l = duelLeader(
        h.classId,
        h.level >= 46
          ? 46
          : h.level >= 36
            ? 36
            : h.level >= 30
              ? 30
              : h.level >= 25
                ? 25
                : h.level >= 20
                  ? 20
                  : h.level >= 15
                    ? 15
                    : 10,
      );
    return { ...h, fighter: { ...h.fighter, loadout: l } };
  };
  const cases: [string, string, af.ArenaPopulationOptions | undefined][] = [
    ['10-19', '10–19', undefined],
    ['20-29', '20–29', undefined],
    ['30-plus', '30+ (30–35)', undefined],
    ['30-plus', '30+ to 52', { maxLevel: 52 }],
    ['30-plus', '30+ to 52, awakened', { maxLevel: 52, awakened: true }],
  ];
  console.log('scenario: 90 %+ / 95 %+ favourites, mean favourite, extreme pairs, widened, empty');
  for (const [id, label, opts] of cases) {
    const bracket = af.RATED_BRACKETS.find((b) => b.id === id)!;
    const pop = af.arenaPopulation(bracket, SIZE, opts ?? {});
    const out = SCEN.map((scen) => {
      const m = af.measureFairness(
        bracket,
        pop.map((h) => assign(h, scen)),
        'matchmaking',
        SEEDS,
      );
      return `${scen} ${pct1(m.over90)} / ${pct1(m.over95)} · ${pct1(m.meanFavourite)} · ${pct1(m.extremePairs)} · ${pct1(m.widened)} · ${m.emptyLists}`;
    });
    console.log(`${label}:\n  ${out.join('\n  ')}`);
  }
}

if (mode === 'tune') {
  // The owner question on duel class balance with loadouts: a per-class skill keep (in place of
  // the uniform half) in 1–9, 10–19 and 20–29, fitted so that both metas sit in the 5.4 bands:
  // everyone on the default (unchanged by construction) and everyone on their duel leader
  // (re-picked under the candidate keep). KEEPS='{"10-19":{"mage":0.4}}' to evaluate one.
  const BRACKETS = process.env.BRACKETS?.split(',') ?? ['1-9', '10-19', '20-29', '30-plus'];
  const ROUNDS = Number(process.env.ROUNDS ?? 4);
  for (const id of BRACKETS) {
    const b = G.PVP_BRACKETS.find((x) => x.id === id)!;
    const L = b.referenceLevel;
    const tiers = fx.matchupTiers(b);
    const mgear = (c: G.ClassId, t: string, s: number) =>
      t === 'build' ? fx.sampleBuild(c, L - 1, s) : fx.gear(c, L, t as never, s);
    let keeps: Partial<Record<G.ClassId, number>> = process.env.KEEPS
      ? (JSON.parse(process.env.KEEPS)[id] ?? {})
      : {};
    const measure = (k: Partial<Record<G.ClassId, number>>) => {
      const config: G.PvpConfig = { ...G.DEFAULT_PVP_CONFIG, skillKeepByClass: { [id]: k } };
      const leaders = Object.fromEntries(G.CLASS_IDS.map((c) => [c, duelLeader(c, L, config)]));
      const m = (a: G.ClassId, d: G.ClassId) => {
        let share = 0;
        for (const t of tiers)
          for (let s = 0; s < 6; s++)
            share += fx.winShare(
              { ...fx.fighter(a, L, mgear(a, t, s)), loadout: leaders[a] },
              { ...fx.fighter(d, L, mgear(d, t, s + 100)), loadout: leaders[d] },
              12,
              `pvp-matchup:${b.id}:${a}:${d}:${t}:${s}`,
              undefined,
              config,
            ).share;
        return share / (tiers.length * 6);
      };
      const mean: Record<string, number> = {};
      let lo = 1,
        hi = 0;
      for (const a of G.CLASS_IDS)
        for (const d of G.CLASS_IDS) {
          if (a >= d) continue;
          const x = m(a, d);
          lo = Math.min(lo, x);
          hi = Math.max(hi, x);
          mean[a] = (mean[a] ?? 0) + x / 3;
          mean[d] = (mean[d] ?? 0) + (1 - x) / 3;
        }
      return { lo, hi, mean, leaders };
    };
    for (let round = 0; round <= ROUNDS; round++) {
      const r = measure(keeps);
      console.log(
        `${id} keeps ${JSON.stringify(keeps)}: pairs ${pct(r.lo)}–${pct(r.hi)}; classes ${G.CLASS_IDS.map((c) => `${c} ${pct(r.mean[c]!)}`).join(' / ')}; leaders ${G.CLASS_IDS.map((c) => short(G.loadoutKey(r.leaders[c]!))).join(' · ')}`,
      );
      if (process.env.KEEPS || round === ROUNDS) break;
      // Step the strongest class's keep down and the weakest's up by 0.1 (within 0–1).
      const sorted = [...G.CLASS_IDS].sort((x, y) => r.mean[y]! - r.mean[x]!);
      const top = sorted[0]!,
        bottom = sorted.at(-1)!;
      if (r.mean[top]! <= 0.53 && r.mean[bottom]! >= 0.47 && r.lo >= 0.42 && r.hi <= 0.58) break;
      const k = (c: G.ClassId) => keeps[c] ?? G.PVP_V3_SKILL_KEEP;
      keeps = {
        ...keeps,
        [top]: Math.max(0, +(k(top) - 0.1).toFixed(2)),
        [bottom]: Math.min(1, +(k(bottom) + 0.1).toFixed(2)),
      };
    }
  }
}

if (mode === 'leaders') {
  // The leaders the guard (skills-balance.test.ts, B7_LEADERS) pins, found by the searches above.
  const out: Record<string, Record<string, string>> = {};
  const put = (name: string, c: G.ClassId, l: G.Loadout) =>
    ((out[name] ??= {})[c] = G.loadoutKey(l));
  for (const c of CLASSES) {
    for (const level of [36, 38]) put(`tyrant${level}`, c, bossLeader(c, 'tyrant38', { level }));
    for (const level of [32, 34, 36])
      put(`heroic${level}`, c, bossLeader(c, 'heroic34', { level }));
    for (const level of [48, 50])
      put(
        `sovereign${level}`,
        c,
        bossLeader(c, 'sovereign50', { level, progress: { forgeTyrantSkillLearned: true } }),
      );
    for (const level of [21, 26]) put(`crypt${level}`, c, bossLeader(c, 'crypt3', { level }));
    put(
      'deep',
      c,
      farmLeader(c, 'deep49', {
        level: 49,
        progress: { forgeTyrantSkillLearned: true, hollowSovereignSkillLearned: true },
      }),
    );
    put('depths', c, farmLeader(c, 'depths37', { level: 37 }));
    put('farm28', c, farmLeader(c, 'depths37', { level: 28 }));
    for (const level of [10, 15, 20, 25, 30, 36, 46]) put(`duel${level}`, c, duelLeader(c, level));
  }
  console.log(JSON.stringify(out, null, 2));
}

if (mode === 'more') {
  // 6.3's Heroic and modifier bands (heroic-balance.test.ts) and 4.9's guild boss bands
  // (guild-boss-balance.test.ts), default → each class's boss leader.
  const mean = (f: (c: G.ClassId) => number) =>
    CLASSES.reduce((s, c) => s + f(c), 0) / CLASSES.length;
  const PARTS = process.env.PARTS?.split(',') ?? ['heroic', 'mods', 'guild'];
  if (PARTS.includes('heroic')) {
    console.log(
      '\n6.3: the Heroic crypt, mean win rate (16 runs, legendaryKit 33): default → leaders',
    );
    for (const level of [32, 35]) {
      const at = (gear: (c: G.ClassId) => G.EquippedItem[], who: 'default' | 'leader') =>
        mean(
          (c) =>
            bossRuns(
              c,
              'namelessCrypt',
              4,
              level,
              gear(c),
              who === 'leader' ? bossLeader(c, 'heroic34', { level }) : null,
              16,
              'heroic-balance',
            ).wins,
        );
      const rows: [string, (c: G.ClassId) => G.EquippedItem[]][] = [
        ['epic +10', (c) => upgraded(kit(c, 33, 'epic'), 10)],
        ['Legendary', (c) => legendaryKit(c, 33)],
        ['Legendary +5', (c) => upgraded(legendaryKit(c, 33), 5)],
        ['Legendary +10', (c) => upgraded(legendaryKit(c, 33), 10)],
      ];
      console.log(
        `  ${level}: ${rows.map(([n, g]) => `${n} ${f2(at(g, 'default'))} → ${f2(at(g, 'leader'))}`).join(' · ')}`,
      );
    }
  }
  if (PARTS.includes('mods')) {
    console.log(
      '\n6.3: every modifier on every boss (12 runs): none, then the modifiers (default → leaders)',
    );
    const BOSSES: [
      string,
      G.DungeonId,
      G.DungeonTier,
      number,
      string,
      (c: G.ClassId) => G.EquippedItem[],
    ][] = [
      ['crypt II', 'namelessCrypt', 2, 18, 'crypt3', (c) => upgraded(kit(c, 17, 'rare'), 5)],
      ['crypt III', 'namelessCrypt', 3, 21, 'crypt3', (c) => legendaryKit(c, 20)],
      ['Heroic', 'namelessCrypt', 4, 34, 'heroic34', (c) => upgraded(legendaryKit(c, 33), 10)],
      ['Ashen Warden', 'ashenWatch', 1, 26, 'crypt3', (c) => upgraded(legendaryKit(c, 25), 5)],
      ['Forge Tyrant', 'tyrantsForge', 1, 36, 'tyrant38', (c) => upgraded(legendaryKit(c, 33), 10)],
    ];
    for (const [name, d, t, level, jobId, gear] of BOSSES) {
      const at = (m: G.BossModifierId | null, who: 'default' | 'leader') =>
        mean(
          (c) =>
            bossRuns(
              c,
              d,
              t,
              level,
              gear(c),
              who === 'leader' ? bossLeader(c, jobId, { level }) : null,
              12,
              'heroic-balance',
              m,
            ).wins,
        );
      const cells = [null, ...G.BOSS_MODIFIER_IDS].map(
        (m) => `${m ?? 'none'} ${f2(at(m, 'default'))} → ${f2(at(m, 'leader'))}`,
      );
      console.log(`  ${name}: ${cells.join(' · ')}`);
    }
  }
  if (PARTS.includes('guild')) {
    const boss = G.getGuildBoss('risenGravewarden');
    const gbKit = (classId: G.ClassId, itemLevel: number, rarityId: G.RarityId) => {
      const rng = G.createRng(`gb-kit:${classId}:${itemLevel}:${rarityId}`);
      const bases = G.ITEM_BASES.filter(
        (b) => !b.unique && b.minItemLevel <= itemLevel && G.canClassUseItem(b, classId),
      ).sort((a, b) => b.tier - a.tier || b.minItemLevel - a.minItemLevel);
      const taken = new Set<string>();
      const out: G.GeneratedItem[] = [];
      for (const base of bases) {
        if (taken.has(base.slot)) continue;
        taken.add(base.slot);
        for (let i = 0; i < (base.slot === 'ring' ? 2 : 1); i++)
          out.push({
            ...G.generateItem({ seed: rng.int(0, 2 ** 31), itemLevel, baseId: base.id, rarityId })!,
            upgradeLevel: 0,
          });
      }
      return out;
    };
    const week = (
      guild: string,
      size: number,
      level: number,
      gear: (c: G.ClassId) => G.EquippedItem[],
      who: 'default' | 'leader',
      attempts = G.GUILD_BOSS_ATTEMPTS_PER_WEEK,
    ) => {
      let total = 0;
      for (let i = 0; i < size; i++) {
        const c = G.CLASS_IDS[i % 4]!;
        for (let n = 1; n <= attempts; n++)
          total += G.simulateGuildBossAttempt({
            bossId: boss.id,
            character: { classId: c, level },
            equipment: gear(c),
            seed: `${guild}:${i}:${n}`,
            ...(who === 'leader' ? { loadout: bossLeader(c, 'crypt3', { level }) } : {}),
          }).counted;
      }
      return G.guildBossStageOf(boss, total);
    };
    console.log(
      `\n4.9: the guild boss (${boss.stages.length} stages), stage reached in a week: default → leaders`,
    );
    for (const [label, guild, size, level, gear] of [
      ['3 heroes, level 14 commons', 'three', 3, 14, (c: G.ClassId) => gbKit(c, 13, 'common')],
      ['5 heroes, level 12 commons', 'five', 5, 12, (c: G.ClassId) => gbKit(c, 11, 'common')],
      ['3 heroes, level 24 Legendaries', 'b3', 3, 24, (c: G.ClassId) => gbKit(c, 23, 'legendary')],
      [
        '30 heroes, level 24 Legendaries',
        'legend',
        30,
        24,
        (c: G.ClassId) => gbKit(c, 23, 'legendary'),
      ],
      ['30 heroes, level 18 rares', 'rares', 30, 18, (c: G.ClassId) => gbKit(c, 17, 'rare')],
    ] as [string, string, number, number, (c: G.ClassId) => G.EquippedItem[]][])
      console.log(
        `  ${label}: ${week(guild, size, level, gear, 'default')} → ${week(guild, size, level, gear, 'leader')}`,
      );
  }
}
