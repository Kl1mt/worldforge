import { describe, expect, it } from 'vitest';
import { settleFarming, type AreaId, type ClassId, type EquippedItem } from '../index.js';
import {
  BOSS_JOB,
  CLASS_IDS,
  FARM_JOB,
  PASS_FARM_JOB,
  WARDEN_JOB,
  bossTime,
  buildItems,
  buildParts,
  buildSlots,
  classMythic,
  describeBuild,
  farmRate,
  searchBuilds,
  setChassis,
  topBuilds,
  type Scored,
} from './builds.js';

/**
 * The build-diversity check (ticket B.2; GDD §15 Phase 3 exit: "no single item or affix dominates
 * all builds"). For every class it searches the late-game builds (`builds.ts`: set layouts ×
 * Legendary effects × affix packages) for two jobs, and asserts:
 * - per job, several distinct builds (chassis or affix package) within 7 % of the best, from at
 *   least two set layouts; at the boss no set in all of them (farming has its farming set, see
 *   below);
 * - over both jobs' top builds, no single set, Mythic, Legendary effect or leading affix in all;
 * - upgrades (+10) and Void keep the top boss builds together (no power source picks a winner);
 * - the class Mythic weapon is an upgrade over the best build, but not a new tier (≤ × 1.4).
 * Mythics are kept out of the search: one drops about every 50 h of Abbey farming, a given one
 * far more rarely, so a check that every top build may not need one would be about a drop no
 * player can plan for. They get their own band instead. Numbers: docs/COMBAT.md "Build diversity".
 */

/** "Within a few percent": 7 % (the boss times move by ~2 % between seed sets). */
const SHARE = 0.07;
const boss = new Map<ClassId, Scored[]>();
const farm = new Map<ClassId, Scored[]>();
const pass = new Map<ClassId, Scored[]>();
const table = (scored: Scored[], unit: (s: number) => string) =>
  scored
    .slice(0, 60)
    .map((s) => `${unit(s.score)} ${describeBuild(s.build)}`)
    .join('\n');

function expectDiverse(c: ClassId, job: string, scored: Scored[], oneSetAllowed = false) {
  const top = topBuilds(scored, SHARE);
  const label = `${c} ${job}\n${table(scored, (s) => (s < 0 ? `${(-s / 1000).toFixed(2)}s` : s.toFixed(2)))}`;
  expect(
    new Set(top.map((t) => `${t.build.chassis}|${t.build.pkg}`)).size,
    label,
  ).toBeGreaterThanOrEqual(3);
  expect(new Set(top.map((t) => t.build.chassis)).size, label).toBeGreaterThanOrEqual(2);
  if (oneSetAllowed) return;
  const parts = top.map((t) => buildParts(t.build));
  for (const u of new Set(parts.flatMap((p) => p.unique))) {
    expect(
      parts.every((p) => p.unique.includes(u)),
      `${label}\n${u} in every top build`,
    ).toBe(false);
  }
}

describe('build diversity (ticket B.2)', () => {
  describe('the tier III Gravewarden (level 23, item level 22)', () => {
    it.each(CLASS_IDS)(
      '%s: several distinct builds within 7 % of the fastest, none needing one set',
      (c) => {
        const scored = searchBuilds(
          c,
          BOSS_JOB.itemLevel,
          (items) => -bossTime(c, items),
          setChassis(c),
          true,
        );
        boss.set(c, scored);
        expectDiverse(c, 'boss', scored);
      },
      60_000,
    );
  });

  describe('farming the Sunken Abbey (level 19, item level 18)', () => {
    // Farming at the top is a one-shot breakpoint: kills/min is capped near 23–24 by the 2 s search,
    // and the Bloodmoon Hunt's 4-piece opener (the class skill as the first hit) one-shots the
    // Abbey a few levels before other builds do. It is the farming set by design (3.3: the best
    // set for farming, safety and the boss differ), so here it may be in every top build; it is in
    // none of the boss's, and the next check spans both jobs.
    it.each(CLASS_IDS)(
      '%s: several distinct builds within 7 % of the fastest; without the farming set within 20 %',
      (c) => {
        const scored = searchBuilds(
          c,
          FARM_JOB.itemLevel,
          (items) => farmRate(c, items),
          setChassis(c),
        );
        farm.set(c, scored);
        expectDiverse(c, 'farming', scored, true);
        const other = scored.find((s) => !s.build.chassis.includes('bloodmoon-hunt'))!;
        expect(other.score / scored[0]!.score, describeBuild(other.build)).toBeGreaterThan(0.8);
      },
      60_000,
    );
  });

  // Ticket 4.8: the top end. The Ashen Pass's enemies take several blows from these builds again,
  // so the build decides the rate instead of the one-shot cap (docs/COMBAT.md "The top end").
  describe('farming the Ashen Pass (level 26, item level 25)', () => {
    it.each(CLASS_IDS)(
      '%s: past the Abbey breakpoint: below the cap, fewer ties, several builds near the best',
      (c) => {
        const scored = searchBuilds(
          c,
          PASS_FARM_JOB.itemLevel,
          (items) => farmRate(c, items, PASS_FARM_JOB),
          setChassis(c),
        );
        pass.set(c, scored);
        expectDiverse(c, 'Ashen Pass farming', scored, true);
        const abbey = farm.get(c)!;
        const near = (x: Scored[]) => topBuilds(x, SHARE).length;
        const label = `${c}: Pass ${scored[0]!.score.toFixed(1)} (${describeBuild(scored[0]!.build)}), ${near(scored)}/${scored.length} within 7 %; Abbey ${abbey[0]!.score.toFixed(1)}, ${near(abbey)}/${abbey.length}`;
        // The best build no longer sits at the Abbey's cap (2 s search + one blow).
        expect(scored[0]!.score / abbey[0]!.score, label).toBeLessThan(0.95);
        // Fewer builds tie with the best than at the Abbey's cap: the choice shows in the rate.
        expect(near(scored), label).toBeLessThan(near(abbey) * 0.8);
        // Still idle-paced for the best builds (the cap is ~24 kills a minute).
        expect(scored[0]!.score, label).toBeGreaterThan(15);
      },
      60_000,
    );
  });

  // Ticket B.3: the breakpoint fix holds with the strongest power sources and past the content's
  // top level (realistic heroes reach ~35 in a week; the XP penalty makes that a soft cap).
  it.each(CLASS_IDS)(
    '%s: the Pass stays off the cap with +10 Void and for heroes past level 28',
    (c) => {
      const abbeyBest = farm.get(c)![0]!.score;
      const top = topBuilds(pass.get(c)!, SHARE).slice(0, 3);
      const rates = top.map((t) =>
        farmRate(
          c,
          buildItems({ ...t.build, upgradeLevel: 10, void: true }, PASS_FARM_JOB.itemLevel),
          PASS_FARM_JOB,
        ),
      );
      const label = `${c}: Abbey ${abbeyBest.toFixed(1)}; Pass +10 Void ${rates.map((r) => r.toFixed(1)).join(' / ')}`;
      for (const r of rates) expect(r, label).toBeLessThan(abbeyBest * 0.97);
      // Thirty-five in item-level-27 gear (the Pass's best drops) is no faster than 26 by much:
      // levels add little next to gear, so over-levelling does not bring the one-shot back.
      const best = buildItems({ ...top[0]!.build, upgradeLevel: 10, void: true }, 27);
      const at = (level: number) => farmRate(c, best, { ...PASS_FARM_JOB, level, itemLevel: 27 });
      const [r26, r35] = [at(26), at(35)];
      expect(r35 / r26, `${label}; L26 ${r26.toFixed(1)} L35 ${r35.toFixed(1)}`).toBeLessThan(1.05);
      expect(r35, label).toBeLessThan(abbeyBest * 0.97);
    },
    60_000,
  );

  // Ticket 6.1: the Ashfall Verge (the Cinderwastes, 28–34) against today's best Ashen Pass gear:
  // the class's best Pass build at +10 Void and at +5, in item-level-27 gear (the Pass's best
  // drops). Older gear keeps farming the new area profitably: it kills a little slower than at
  // the Pass (the step up), never dies, and earns more XP and gold an hour than at the Pass.
  it.each(CLASS_IDS)(
    '%s: the best Pass gear farms the Ashfall Verge profitably at 28 and up to its top',
    (c) => {
      const best = topBuilds(pass.get(c)!, SHARE)[0]!.build;
      const hour = (level: number, areaId: AreaId, items: EquippedItem[]) => {
        const r = { kills: 0, deaths: 0, xp: 0, gold: 0 };
        for (const seed of ['cw:1', 'cw:2', 'cw:3']) {
          const f = settleFarming({
            character: { classId: c, level, xp: 0 },
            equipment: items,
            areaId,
            seed,
            firstCycle: 0,
            durationMs: 3_600_000,
            inventoryCount: 0,
          });
          r.kills += f.kills / 180;
          r.deaths += f.deaths / 3;
          r.xp += f.xpGained / 3;
          r.gold += f.goldLooted / 3;
        }
        return r;
      };
      for (const [name, items] of [
        ['+10 Void', buildItems({ ...best, upgradeLevel: 10, void: true }, 27)],
        ['+5', buildItems({ ...best, upgradeLevel: 5 }, 27)],
      ] as const) {
        const atPass = hour(28, 'ashenPass', items);
        const at28 = hour(28, 'ashfallVerge', items);
        const at34 = hour(34, 'ashfallVerge', items);
        const label = `${c} ${name} ${describeBuild(best)}: Pass 28 ${JSON.stringify(atPass)}; Verge 28 ${JSON.stringify(at28)}; 34 ${JSON.stringify(at34)}`;
        // Survival: no deaths to speak of, at the entry and at the top.
        expect(at28.deaths, label).toBeLessThanOrEqual(1);
        expect(at34.deaths, label).toBeLessThanOrEqual(2);
        // Kill speed: idle-paced, a step up from the Pass (slower), never a wall.
        expect(at28.kills, label).toBeGreaterThan(14);
        expect(at34.kills, label).toBeGreaterThan(13);
        expect(at28.kills / atPass.kills, label).toBeGreaterThan(0.7);
        expect(at28.kills / atPass.kills, label).toBeLessThan(0.95);
        // Profit: more XP and gold an hour than at the Pass's top, with the same gear.
        expect(at28.xp, label).toBeGreaterThan(atPass.xp);
        expect(at28.gold, label).toBeGreaterThan(atPass.gold);
      }
      // The same build in the Verge's own drops (tier 4, item level 33) kills faster at its top:
      // the new gear is worth chasing, but it is no new power tier (below 1.35 ×).
      const job = (itemLevel: number) => ({
        ...PASS_FARM_JOB,
        areaId: 'ashfallVerge' as const,
        level: 34,
        itemLevel,
      });
      const old = farmRate(c, buildItems({ ...best, upgradeLevel: 5 }, 27), job(27));
      const fresh = farmRate(c, buildItems({ ...best, upgradeLevel: 5 }, 33), job(33));
      expect(fresh / old, `${c}: ${old.toFixed(1)} → ${fresh.toFixed(1)}`).toBeGreaterThan(1.03);
      expect(fresh / old, `${c}: ${old.toFixed(1)} → ${fresh.toFixed(1)}`).toBeLessThan(1.35);
    },
    60_000,
  );

  describe('the Ashen Warden (level 28, item level 27)', () => {
    it.each(CLASS_IDS)(
      '%s: several distinct builds within 7 % of the fastest, none needing one set',
      (c) => {
        const scored = searchBuilds(
          c,
          WARDEN_JOB.itemLevel,
          (items) => -bossTime(c, items, WARDEN_JOB.runs, WARDEN_JOB),
          setChassis(c),
          true,
        );
        expectDiverse(c, 'Ashen Warden', scored);
        // It is the top boss: even the best builds need longer than for tier III's Gravewarden.
        expect(-scored[0]!.score, describeBuild(scored[0]!.build)).toBeGreaterThan(
          -boss.get(c)![0]!.score,
        );
      },
      60_000,
    );
  });

  it.each(CLASS_IDS)('%s: no set, effect or affix is in every top build of both jobs', (c) => {
    const top = [...topBuilds(boss.get(c)!, SHARE), ...topBuilds(farm.get(c)!, SHARE)];
    const parts = top.map((t) => buildParts(t.build));
    const label = top.map((t) => describeBuild(t.build)).join('\n');
    const all = new Set(parts.flatMap((p) => [...p.unique, ...p.effects, ...p.affixes]));
    for (const x of all) {
      const everywhere = parts.every((p) => [...p.unique, ...p.effects, ...p.affixes].includes(x));
      expect(everywhere, `${c}: ${x} is in every top build\n${label}`).toBe(false);
    }
  });

  it.each(CLASS_IDS)('%s: +10 and Void keep the top boss builds together', (c) => {
    const top = topBuilds(boss.get(c)!, SHARE).slice(0, 5);
    const times = top.map((t) =>
      bossTime(c, buildItems({ ...t.build, upgradeLevel: 10, void: true }, BOSS_JOB.itemLevel)),
    );
    const label = `${c}: ${top.map((t, i) => `${describeBuild(t.build)} ${(-t.score / 1000).toFixed(2)}s → ${(times[i]! / 1000).toFixed(2)}s`).join('\n')}`;
    for (const [i, t] of times.entries()) expect(t, label).toBeLessThanOrEqual(-top[i]!.score);
    // Still peers: the slowest of them stays within 12 % of the fastest.
    expect(Math.max(...times) / Math.min(...times), label).toBeLessThan(1.12);
  });

  it.each(CLASS_IDS)('%s: the class Mythic weapon is an upgrade, not a new tier', (c) => {
    const best = boss.get(c)!.find((s) => s.build.picks[0]!.kind === 'legendary')!;
    const picks = best.build.picks.slice();
    picks[buildSlots(c).indexOf('weapon')] = { kind: 'mythic', mythicId: classMythic(c) };
    const withMythic = bossTime(c, buildItems({ ...best.build, picks }, BOSS_JOB.itemLevel));
    const ratio = -best.score / withMythic;
    expect(
      ratio,
      `${c}: ${describeBuild(best.build)} ${(-best.score / 1000).toFixed(2)}s, Mythic ${(withMythic / 1000).toFixed(2)}s`,
    ).toBeGreaterThan(1);
    expect(ratio).toBeLessThan(1.4);
  });
});
