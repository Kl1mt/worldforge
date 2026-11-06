import { describe, expect, it } from 'vitest';
import type { ClassId } from '../index.js';
import {
  BOSS_JOB,
  CLASS_IDS,
  FARM_JOB,
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
